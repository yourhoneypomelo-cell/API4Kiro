/**
 * API Key 迁入系统钥匙串：迁移、写入漏斗、孤儿回收与落盘组装规则的**唯一**实现。
 *
 * 为什么不放在 `providers.ts`：`providers.ts` 已经是 1200 多行且要同时 import `config` 与 `apiKeys`；
 * 把 D7 / D8 的全部顺序、失败语义收在这一个文件里，`providers.ts` 只负责注入端口（KeySettingsPort），
 * 失败语义就只有一份实现。
 *
 * 运行时依赖严格单向：`config` / `providers` →（`keyPlaceholder`、本文件）→ `oauth/tokenStore` → `log` → `config`。
 * 所以对 `providers.ts` / `config.ts` **只允许 `import type`**（外加不需要循环的类型接口），
 * 归一序（槽位 → 原文位置）由 `providers.ts` 通过端口提供，本文件不再写第二套。
 *
 * 不变量（I1，措辞见设计 §10）：本扩展在迁移之后**永不把新增的明文 key 写进 `settings.json`**
 * （含 `fallback.*` 兜底副本）；钥匙串不可用或写入失败时**保留原有明文**，**不得**用占位覆盖它。
 */

import { API_KEY_PLACEHOLDER, isPlaceholder, keySlot, legacyKeySlot, registerKeyLookup, resolveKeyValue } from "./keyPlaceholder";
import { TokenStoreLoadError, deleteToken, flushTokensOrThrow, getToken, listStoredKeys, setToken, tokenStoreBackend, tokenStoreLoadError } from "./oauth/tokenStore";
import { warn as logWarn } from "./log";
import type { Credential, ProviderConfig } from "./providers";

/** 首条凭证的 id（与 `providers.PRIMARY_CREDENTIAL_ID` 同值；这里不能运行时 import providers，会成环）。 */
const PRIMARY_CREDENTIAL_ID = "c1";
/** providerId 的保留前缀：`key:` 开头的 id 会与钥匙串槽位命名空间冲突，不迁移。 */
const RESERVED_ID_PREFIX = "key:";

// 导入期注册查找器：占位 ⇒ 去钥匙串取真值。这样 `config.ts` / `providers.ts` 的注水在
// 本模块被 import 之后就能工作，且不存在「占位在注册前被解析」的窗口。
registerKeyLookup((slot) => getToken(slot)?.accessToken);

/** 旧三项全局配置（各占一个独立槽位）。 */
export const LEGACY_KEYS = ["apiKey", "officialApiKey", "openaiApiKey"] as const;
export type LegacyKey = (typeof LEGACY_KEYS)[number];

/** 会带着明文 key 副本的 globalState 兜底项。 */
export const FALLBACK_KEYS = ["providers", "apiKey", "officialApiKey", "openaiApiKey"] as const;

/** 槽位在 settings 原文里的位置（由 `providers.ts` 的**同一套归一序**产出）。 */
export interface RawSlotLocation {
  /** 在原文数组里的下标。 */
  providerIndex: number;
  providerId: string;
  credentialId: string;
  /** 诊断用：`apiKey` 或 `credentials[i].apiKey`。 */
  field: string;
  /** 该槽位在原文里的字符串（未解析占位）。 */
  raw: string;
}

/**
 * 宿主侧（`providers.ts`）注入的端口。全部方法都只读写设置，不做钥匙串操作——
 * 钥匙串的唯一入口在本文件的 `ApiKeyVault` 里。
 */
export interface KeySettingsPort {
  /** settings 里 `providers` 的**原文**（未归一，含未知字段）。 */
  readProviders(): unknown[];
  /** 归一后的列表（= `providers.getProviders()`，同一套归一）。 */
  readProviderList(): ProviderConfig[];
  /** 槽位 → 原文位置；与 `coerce` 共用同一套归一序。 */
  slotIndexFor(rawProviders: unknown[]): Map<string, RawSlotLocation>;
  /** `providers.credentialsOf`（同一份实现，避免第二套「只有 apiKey」的合成规则）。 */
  credentialsOf(p: ProviderConfig): Credential[];
  /** 只写 settings（内部是 `config.updateSetting`）。 */
  writeProviders(list: ProviderConfig[]): Promise<{ settingsOk: boolean; error?: string }>;
  /** 旧三项的「兜底优先」原始读值（不做占位解析）。 */
  readLegacyRaw(key: string): string;
  writeLegacy(key: string, value: string): Promise<{ settingsOk: boolean; error?: string }>;
  readFallback(key: string): unknown;
  writeFallback(key: string, value: unknown): Promise<{ settingsOk: boolean; error?: string }>;
}

export interface KeyLog {
  warn(...parts: unknown[]): void;
}

export interface MigrateReport {
  /** 确认写进钥匙串的槽位数。 */
  migrated: number;
  /** 未能确认写入的槽位（明文保留）。 */
  failed: string[];
  /** 明文的残余副本（位置名，不含值）。 */
  residual: string[];
}

function isKeyType(p: ProviderConfig): boolean {
  return p.auth !== "oauth";
}

function reservedId(id: string): boolean {
  return id.startsWith(RESERVED_ID_PREFIX);
}

/** 该 provider 是否出现明文 key 字段。 */
function hasPlaintextKey(port: KeySettingsPort, p: ProviderConfig): boolean {
  if (!isKeyType(p) || reservedId(p.id)) {
    return false;
  }
  return port.credentialsOf(p).some((c) => {
    const v = (c.apiKey ?? "").trim();
    return !!v && !isPlaceholder(v);
  });
}

/** 该 provider 是否出现占位标记（说明这份列表已经被脱敏处理过，不是用户意图）。 */
function hasPlaceholderKey(port: KeySettingsPort, p: ProviderConfig): boolean {
  if (!isKeyType(p) || reservedId(p.id)) {
    return false;
  }
  return isPlaceholder(p.apiKey) || port.credentialsOf(p).some((c) => isPlaceholder(c.apiKey));
}

/**
 * 期望占用的槽位 = 值仍是**明文**的槽位（占位 / 空不算）。「清除 Key」⇒ 空集合，
 * 回收时就能把那把 key 从钥匙串里删掉。
 */
export function expectedSlots(port: KeySettingsPort, list: ProviderConfig[]): Set<string> {
  const out = new Set<string>();
  for (const p of list) {
    if (!isKeyType(p) || reservedId(p.id)) {
      continue;
    }
    for (const c of port.credentialsOf(p)) {
      const v = (c.apiKey ?? "").trim();
      if (!v || isPlaceholder(v)) {
        continue;
      }
      out.add(keySlot(p.id, c.id));
    }
  }
  return out;
}

/** 非空 key 字段 ⇒ 占位；空 ⇒ 空串。 */
function maskedField(value: string | undefined): string {
  return (value ?? "").trim() ? API_KEY_PLACEHOLDER : "";
}

/**
 * 落盘形态：非空 key 字段写占位、空 key 字段写空串（等于原样）。
 * OAuth 类 provider 的 key 字段原样不动。
 * 空字段写空串而不是占位：`coerceCredentials` 会丢掉「key 类没 key 的条目」，
 * 写占位会让空凭证存活、并可能被凭证池选中发出空 Bearer。
 * 深拷贝输出：绝不把 `list` 的对象引用交给 `updateSetting`。
 */
export function withPlaceholders(port: KeySettingsPort, list: ProviderConfig[]): ProviderConfig[] {
  return list.map((p) => {
    const out: ProviderConfig = { ...p };
    if (!isKeyType(p) || reservedId(p.id)) {
      return out;
    }
    if (out.credentials && out.credentials.length > 0) {
      out.credentials = out.credentials.map((c) => ({ ...c, apiKey: maskedField(c.apiKey) }));
    }
    out.apiKey = maskedField(p.apiKey);
    return out;
  });
}

/** 逐字段的落盘值：原本为空 ⇒ 空串；该槽位失败 ⇒ 空串；否则 ⇒ 占位。 */
function slotField(p: ProviderConfig, credentialId: string, value: string | undefined, failed: ReadonlySet<string>): string {
  const v = (value ?? "").trim();
  if (!v) {
    return "";
  }
  return failed.has(keySlot(p.id, credentialId)) ? "" : API_KEY_PLACEHOLDER;
}

/** 深拷贝原文里的 credentials 数组（不把原文对象引用交给 `updateSetting`）。 */
function copyRawCredentials(raw: unknown): Credential[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((c) => ({ ...(c as unknown as Credential) }));
}

/**
 * 组装「要写进 settings 的 providers 列表」。按 **provider 级整体回退**（不是按槽位名回填）：
 *
 *  - 该 provider 没有失败槽位 ⇒ 与 `withPlaceholders` 逐字相同；
 *  - 有失败槽位、且在原文里能定位到同 id、`auth` 也没变 ⇒ metadata 取本次值、
 *    `apiKey` / `credentials` **取原文**（于是不存在「半应用」状态）；
 *  - 定位不到 / `auth` 变了 ⇒ 失败槽位写**空串**、成功槽位写占位、metadata 照常。
 *
 * 两种写法的差别就是防「删 c1 → c2 改名成 c1」在保存失败时把已删的 A 写回。
 * `previousRaw` 必须是 `slotIndexFor` 用的同一个原文数组。
 */
export function mergeForWrite(
  port: KeySettingsPort,
  list: ProviderConfig[],
  previousRaw: unknown[],
  failed: ReadonlySet<string>
): ProviderConfig[] {
  const prevById = new Map<string, Record<string, unknown>>();
  for (const raw of previousRaw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    // id 非字符串 / 重复 ⇒ 定位不到（重复的 id 归一无意义，宁可不回退）
    if (!id || prevById.has(id)) {
      continue;
    }
    prevById.set(id, r);
  }
  return list.map((p) => {
    const out: ProviderConfig = { ...p };
    if (!isKeyType(p) || reservedId(p.id)) {
      return out;
    }
    const failedHere = [...failed].some((slot) => slot.startsWith(`key:${p.id}/`));
    if (!failedHere) {
      return withPlaceholders(port, [p])[0];
    }
    const prev = prevById.get(p.id);
    if (prev && (prev.auth === "oauth") === (p.auth === "oauth")) {
      out.apiKey = typeof prev.apiKey === "string" ? prev.apiKey : "";
      out.credentials = copyRawCredentials(prev.credentials);
      return out;
    }
    if (out.credentials && out.credentials.length > 0) {
      out.credentials = out.credentials.map((c) => ({ ...c, apiKey: slotField(p, c.id, c.apiKey, failed) }));
    }
    out.apiKey = slotField(p, PRIMARY_CREDENTIAL_ID, p.apiKey, failed);
    return out;
  });
}

/**
 * 文本级把原文里的 key 字段换成占位（保留未知字段与形状；OAuth provider 不动）。
 * 给 `fallback.providers` 兜底副本用：那份副本在 `globalState` 里，`updateSetting` 成功才会被清掉。
 */
export function placeholderizeRaw(raw: unknown[]): unknown[] {
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    const r = item as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    if (r.auth === "oauth") {
      return out;
    }
    if (typeof r.apiKey === "string" && r.apiKey.trim()) {
      out.apiKey = API_KEY_PLACEHOLDER;
    }
    if (Array.isArray(r.credentials)) {
      out.credentials = r.credentials.map((c) => {
        if (!c || typeof c !== "object" || Array.isArray(c)) {
          return c;
        }
        const cc = c as Record<string, unknown>;
        const o = { ...cc };
        if (typeof cc.apiKey === "string" && cc.apiKey.trim()) {
          o.apiKey = API_KEY_PLACEHOLDER;
        }
        return o;
      });
    }
    return out;
  });
}

function describe(e: unknown): string {
  return e instanceof TokenStoreLoadError ? `${e.code}: ${e.detail}` : (e as Error)?.message || String(e);
}

export class ApiKeyVault {
  private readonly port: KeySettingsPort;
  private readonly log: KeyLog;

  constructor(opts: { port: KeySettingsPort; log?: KeyLog }) {
    this.port = opts.port;
    this.log = opts.log || { warn: logWarn };
  }

  /**
   * 把配置里的明文 key 搬进钥匙串，成功后才把 settings 里的值换成占位。
   * 顺序（不可调换）：后端闸 → 收集明文 → 写钥匙串 → 穿透存储层确认 → 才写占位。
   * 任一步失败：不动该槽位的明文、不阻断激活、下次激活重试（占位不再被收集 ⇒ 幂等）。
   */
  async migrate(): Promise<MigrateReport> {
    const failed: string[] = [];
    const residual: string[] = [];

    // ① 前置闸：钥匙串当前读不出来，或写入根本不会落到钥匙串（拿不到 SecretStorage）。
    const loadErr = tokenStoreLoadError();
    if (loadErr) {
      this.log.warn(`api key 迁移：钥匙串当前不可用（${loadErr.code}），保留明文，下次激活重试`);
      return { migrated: 0, failed, residual };
    }
    if (tokenStoreBackend() !== "secrets") {
      this.log.warn("api key 迁移：拿不到系统钥匙串（写入会落到插件本地存储），保留明文，下次激活重试");
      return { migrated: 0, failed, residual };
    }

    // ② 收集明文（值为空或已是占位的跳过 ⇒ 幂等）。
    const previousRaw = this.port.readProviders();
    const rawSlotIndex = this.port.slotIndexFor(previousRaw);
    const plaintext = new Map<string, { value: string; source: "providers" | "fallbackProviders" | "legacy" }>();
    const add = (slot: string, value: string, source: "providers" | "fallbackProviders" | "legacy") => {
      const v = (value ?? "").trim();
      if (!v || isPlaceholder(v) || plaintext.has(slot)) {
        return;
      }
      plaintext.set(slot, { value: v, source });
    };
    for (const [slot, loc] of rawSlotIndex) {
      if (reservedId(loc.providerId)) {
        // 保留前缀：不迁移，明文保留，报告成残余项
        if ((loc.raw ?? "").trim() && !isPlaceholder(loc.raw)) {
          residual.push(`保留前缀 providerId(${loc.providerId})`);
        }
        continue;
      }
      add(slot, loc.raw, "providers");
    }
    const fallbackRaw = this.port.readFallback("providers");
    if (Array.isArray(fallbackRaw)) {
      for (const [slot, loc] of this.port.slotIndexFor(fallbackRaw)) {
        if (!reservedId(loc.providerId)) {
          add(slot, loc.raw, "fallbackProviders");
        }
      }
    }
    for (const key of LEGACY_KEYS) {
      add(legacyKeySlot(key), this.port.readLegacyRaw(key), "legacy");
    }
    if (plaintext.size === 0) {
      return { migrated: 0, failed, residual };
    }

    // ③ 写钥匙串（单槽失败只影响该槽，其余继续）。
    for (const [slot, rec] of plaintext) {
      try {
        setToken(slot, { accessToken: rec.value, updatedAt: Date.now() });
      } catch (e) {
        failed.push(slot);
        this.log.warn(`api key 迁移：槽位 ${slot} 写入钥匙串失败（值长度 ${rec.value.length}），保留明文`, describe(e));
      }
    }

    // ④ 唯一「写成功」依据：穿透存储层确认。
    const toVerify: Record<string, string> = {};
    for (const [slot, rec] of plaintext) {
      if (!failed.includes(slot)) {
        toVerify[slot] = rec.value;
      }
    }
    let verified = new Set<string>();
    try {
      if (Object.keys(toVerify).length > 0) {
        await flushTokensOrThrow(toVerify);
      }
      verified = new Set(Object.keys(toVerify));
    } catch (e) {
      for (const slot of Object.keys(toVerify)) {
        failed.push(slot);
      }
      this.log.warn(`api key 迁移：落盘确认失败（${failed.length} 个槽位），本次不写占位、保留明文，下次激活重试`, describe(e));
      return { migrated: 0, failed, residual };
    }

    // ⑤ 只对确认成功的槽位写占位。
    const failedSet = new Set(failed);
    const perSource = (source: "providers" | "fallbackProviders" | "legacy") =>
      [...plaintext].filter(([slot, rec]) => rec.source === source && verified.has(slot)).map(([slot]) => slot);
    if (perSource("providers").length > 0) {
      try {
        const merged = mergeForWrite(this.port, this.port.readProviderList(), previousRaw, failedSet);
        const w = await this.port.writeProviders(merged);
        if (!w.settingsOk) {
          residual.push("providers");
          this.log.warn("api key 迁移：providers 的占位写入未能确认（明文副本可能仍在 settings / 兜底存储里）", w.error);
        }
      } catch (e) {
        residual.push("providers");
        this.log.warn("api key 迁移：providers 的占位写入抛错", describe(e));
      }
    }
    for (const key of LEGACY_KEYS) {
      const slot = legacyKeySlot(key);
      if (!verified.has(slot)) {
        continue;
      }
      try {
        const w = await this.port.writeLegacy(key, API_KEY_PLACEHOLDER);
        if (!w.settingsOk) {
          residual.push(`legacy:${key}`);
          this.log.warn(`api key 迁移：${key} 的占位写入未能确认`, w.error);
        }
      } catch (e) {
        residual.push(`legacy:${key}`);
        this.log.warn(`api key 迁移：${key} 的占位写入抛错`, describe(e));
      }
    }
    // 兜底副本（globalState 里的 fallback.providers）：主写入成功时 updateSetting 会顺手清掉它，
    // 这里只在它确实还带着明文、且它的槽位全部确认成功时，把副本换成占位版。
    const fallbackSlots = perSource("fallbackProviders");
    if (fallbackSlots.length > 0 && Array.isArray(fallbackRaw)) {
      if (fallbackSlots.length === fallbackSlots.filter((s) => verified.has(s)).length) {
        try {
          const w = await this.port.writeFallback("providers", placeholderizeRaw(fallbackRaw));
          if (!w.settingsOk) {
            residual.push("fallback:providers");
            this.log.warn("api key 迁移：fallback.providers 兜底副本的占位替换未能确认", w.error);
          }
        } catch (e) {
          residual.push("fallback:providers");
          this.log.warn("api key 迁移：fallback.providers 兜底副本的占位替换抛错", describe(e));
        }
      } else {
        residual.push("fallback:providers");
        this.log.warn("api key 迁移：fallback.providers 兜底副本有未确认写入的槽位，保留原文");
      }
    }

    return { migrated: verified.size, failed, residual };
  }

  /**
   * 把 `list` 里仍是明文的 key 写进钥匙串并确认落盘，返回**失败**的槽位名（绝不外抛）。
   * 后端不是 `secrets` 时**一次 `setToken` 都不调**：`TokenStore` 在缺 SecretStorage 时不会抛错，
   * 而是静默改道 `globalState`，于是 settings 会被换成占位、key 却以明文落进插件的本地存储。
   */
  async persistKeys(list: ProviderConfig[]): Promise<string[]> {
    const failed = new Set<string>();
    const expected = expectedSlots(this.port, list);
    if (expected.size === 0) {
      return [];
    }
    if (tokenStoreBackend() !== "secrets") {
      this.log.warn(`api key 保存：拿不到系统钥匙串（写入会落到插件本地存储），本次 ${expected.size} 项 Key 未生效`);
      return [...expected];
    }
    const wanted: Record<string, string> = {};
    for (const p of list) {
      if (!isKeyType(p) || reservedId(p.id)) {
        continue;
      }
      for (const c of this.port.credentialsOf(p)) {
        const slot = keySlot(p.id, c.id);
        if (expected.has(slot)) {
          wanted[slot] = (c.apiKey ?? "").trim();
        }
      }
    }
    for (const [slot, value] of Object.entries(wanted)) {
      try {
        setToken(slot, { accessToken: value, updatedAt: Date.now() });
      } catch (e) {
        failed.add(slot);
        this.log.warn(`api key 保存：槽位 ${slot} 写入钥匙串失败（值长度 ${value.length}）`, describe(e));
      }
    }
    const toVerify: Record<string, string> = {};
    for (const [slot, value] of Object.entries(wanted)) {
      if (!failed.has(slot)) {
        toVerify[slot] = value;
      }
    }
    try {
      if (Object.keys(toVerify).length > 0) {
        await flushTokensOrThrow(toVerify);
      }
    } catch (e) {
      for (const slot of Object.keys(toVerify)) {
        failed.add(slot);
      }
      this.log.warn(`api key 保存：落盘确认失败（${failed.size} 个槽位），本次不改写这些 Key 的落盘值`, describe(e));
    }
    return [...failed];
  }

  /**
   * 回收孤儿槽位：对出现在 `list` 里的 key 类 provider，删除 `key:<id>/*` 里不在
   * `expectedSlots` 的条目。逐个 provider 独立 try/catch，绝不上抛。
   */
  async reconcile(list: ProviderConfig[]): Promise<string[]> {
    const failed = new Set<string>();
    const keyProviders = list.filter((p) => isKeyType(p) && !reservedId(p.id));
    const expected = expectedSlots(this.port, list);
    // I13 自我保护：列表里所有 key 字段都是占位（例如刚被 withPlaceholders 处理过），
    // 说明它不是「用户意图」，此时 expectedSlots 必然是空集，照算会把槽位全删空。
    if (expected.size === 0 && keyProviders.some((p) => hasPlaceholderKey(this.port, p))) {
      this.log.warn("api key 回收：列表里所有 Key 字段都是占位标记，跳过槽位回收（避免把刚确认写好的钥匙串条目删空）");
      return [];
    }
    if (tokenStoreBackend() !== "secrets") {
      return [];
    }
    let deleted = false;
    for (const p of keyProviders) {
      const prefix = `key:${p.id}/`;
      let existing: string[];
      try {
        existing = listStoredKeys(prefix);
      } catch (e) {
        failed.add(`${prefix}*`);
        this.log.warn(`api key 回收：列举 ${p.id} 的槽位失败`, describe(e));
        continue;
      }
      const stale = existing.filter((k) => !expected.has(k));
      if (stale.length === 0) {
        continue;
      }
      try {
        for (const k of stale) {
          deleteToken(k);
        }
        deleted = true;
      } catch (e) {
        for (const k of stale) {
          failed.add(k);
        }
        this.log.warn(`api key 回收：删除 ${p.id} 的 ${stale.length} 个孤儿槽位失败`, describe(e));
      }
    }
    if (deleted) {
      try {
        await flushTokensOrThrow({});
      } catch (e) {
        this.log.warn("api key 回收：删除后的落盘确认失败（改动留在内存，稍后由定时重试落盘）", describe(e));
      }
    }
    return [...failed];
  }

  /** 写入漏斗的完整一段：先写钥匙串，再回收孤儿；只产出失败槽位，任何一个都不外抛。 */
  async persistProviderKeys(list: ProviderConfig[]): Promise<string[]> {
    const failed = await this.persistKeys(list);
    const reconcileFailed = await this.reconcile(list);
    return [...new Set([...failed, ...reconcileFailed])];
  }
}

// ---------------------------------------------------------------------------------------
// 模块级薄包装（activate 与测试用）。生产写入路径由 providers.ts 自己的实例负责。
// ---------------------------------------------------------------------------------------

let activePort: KeySettingsPort | undefined;
let activeVault: ApiKeyVault | undefined;

/** activate 里在 `initTokenStore` 之后调用：注入端口，供迁移与旧键读取使用。 */
export function initApiKeys(port: KeySettingsPort): void {
  activePort = port;
  activeVault = new ApiKeyVault({ port });
}

/** 激活时后台跑一次迁移（**不 await**，不阻断激活）。未初始化 ⇒ no-op。 */
export function migrateApiKeysOnce(): Promise<MigrateReport> {
  return activeVault ? activeVault.migrate() : Promise.resolve({ migrated: 0, failed: [], residual: [] });
}

/** 见 `ApiKeyVault.persistProviderKeys`；未初始化时返回空失败集（`providers.ts` 不走这个包装）。 */
export function persistProviderKeys(list: ProviderConfig[]): Promise<string[]> {
  return activeVault ? activeVault.persistProviderKeys(list) : Promise.resolve([]);
}

/** 读旧三项配置的最终值：占位 ⇒ 查钥匙串（查不到 ⇒ 空串），明文原样。 */
export function readLegacyKey(key: string): string {
  const raw = activePort ? activePort.readLegacyRaw(key) : "";
  return resolveKeyValue(raw, legacyKeySlot(key));
}

/** 纯函数形态（`providers.migrateFromLegacy` 用，不依赖端口初始化顺序）。 */
export function resolveLegacyKey(raw: string, key: string): string {
  return resolveKeyValue(raw, legacyKeySlot(key));
}
