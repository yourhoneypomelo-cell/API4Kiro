/**
 * 从 CC Switch 导入 provider。
 *
 * CC Switch（Tauri 桌面版）把各 CLI 的供应商存在 `~/.cc-switch/cc-switch.db`（SQLite，providers 表，
 * 一行一个 app_type：claude / claude-desktop / codex / gemini / opencode / hermes / grokbuild），
 * 更老的 v2 存 `~/.cc-switch/config.json`。每类的 settings_config 形状不同：
 *  - claude(-desktop)：{ env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN | ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL… } }
 *  - codex：{ auth: { OPENAI_API_KEY }, config: "<config.toml>", modelCatalog? }，地址与 wire_api 在 TOML 的 [model_providers.X] 里
 *  - gemini：{ env: { GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL, GEMINI_MODEL } }
 *  - opencode：opencode.json 的 provider 片段 { npm, options: { baseURL, apiKey }, models: { id: {…} } }
 *  - hermes：{ base_url, api_key, api_mode, models: [{ id }] }
 *  - grokbuild：{ config: "<grok cli toml>" }（一般是官方登录，没有 key；有 base_url + api_key 才导）
 * 这里只读，不动 CC Switch 的任何文件。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readTable } from "./sqliteReader";
import { AnthropicMode, OpenaiApi, Protocol, ProviderConfig, SDK_TABLE, baseModelId, getProviders } from "./providers";

export type CcSwitchApp = "claude" | "claude-desktop" | "codex" | "gemini" | "opencode" | "hermes" | "grokbuild" | string;

/** 数据库里的一行（已把 settings_config 解成对象）。 */
export interface CcSwitchRow {
  id: string;
  appType: CcSwitchApp;
  name: string;
  settings: Record<string, unknown>;
  isCurrent: boolean;
  sortIndex: number;
}

/** 能导进来的一条 provider 候选（含明文 key，只留在扩展侧；发给 webview 前要打码）。 */
export interface ImportCandidate {
  idx: number;
  name: string;
  /** 来源 app（合并了同地址同 key 的多条时，列出全部） */
  sources: CcSwitchApp[];
  protocol: Protocol;
  openaiApi?: OpenaiApi;
  anthropicMode?: AnthropicMode;
  baseUrl: string;
  exactBase: boolean;
  apiKey: string;
  models: string[];
  /** 与已连接的某个 provider 地址 + key 都一样 → 缺省不勾 */
  existsAs?: string;
}

export interface ImportSkipped {
  name: string;
  source: CcSwitchApp;
  reason: string;
}

export interface ScanResult {
  path: string;
  candidates: ImportCandidate[];
  skipped: ImportSkipped[];
}

export const APP_LABEL: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  hermes: "Hermes",
  grokbuild: "Grok CLI",
};

// ---------------------------------------------------------------- 定位

/** 默认位置 + v3.10.3 的 HOME 兼容位置 + Tauri store 里的自定义目录；都没有返回 undefined。 */
export function findCcSwitchStore(): string | undefined {
  const dirs: string[] = [];
  const override = readConfigDirOverride();
  if (override) {
    dirs.push(override);
  }
  dirs.push(path.join(os.homedir(), ".cc-switch"));
  const homeEnv = (process.env.HOME || "").trim();
  if (homeEnv) {
    dirs.push(path.join(homeEnv, ".cc-switch"));
  }
  for (const d of dirs) {
    const db = path.join(d, "cc-switch.db");
    if (fs.existsSync(db)) {
      return db;
    }
  }
  for (const d of dirs) {
    const json = path.join(d, "config.json");
    if (fs.existsSync(json)) {
      return json;
    }
  }
  return undefined;
}

/** Tauri store（app_paths.json）里可能写了自定义配置目录。 */
function readConfigDirOverride(): string | undefined {
  const bases = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "com.ccswitch.desktop") : "",
    path.join(os.homedir(), "Library", "Application Support", "com.ccswitch.desktop"),
    path.join(os.homedir(), ".config", "com.ccswitch.desktop"),
    path.join(os.homedir(), ".local", "share", "com.ccswitch.desktop"),
  ].filter(Boolean);
  for (const b of bases) {
    const f = path.join(b, "app_paths.json");
    try {
      if (!fs.existsSync(f)) {
        continue;
      }
      const j = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
      const v = j["app_config_dir_override"];
      if (typeof v === "string" && v.trim() && fs.existsSync(v.trim())) {
        return v.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 读取

function parseSettings(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 读数据库（.db）或老版 config.json，统一成行。 */
export function readCcSwitchRows(file: string): CcSwitchRow[] {
  if (/\.json$/i.test(file)) {
    return readLegacyJson(file);
  }
  const rows = readTable(file, "providers");
  if (!rows) {
    throw new Error("数据库里没有 providers 表（不是 CC Switch 的库？）");
  }
  return rows
    .map((r) => ({
      id: String(r.id ?? ""),
      appType: String(r.app_type ?? "claude"),
      name: String(r.name ?? "").trim(),
      settings: parseSettings(r.settings_config),
      isCurrent: Number(r.is_current ?? 0) === 1,
      sortIndex: typeof r.sort_index === "number" ? r.sort_index : 1e9,
    }))
    .sort((a, b) => a.sortIndex - b.sortIndex);
}

/** v2 的 config.json：{ claude: { providers: { id: {...} } }, codex: {...}, ... }。 */
function readLegacyJson(file: string): CcSwitchRow[] {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: CcSwitchRow[] = [];
  for (const appType of Object.keys(j)) {
    const sect = j[appType];
    if (!sect || typeof sect !== "object") {
      continue;
    }
    const provs = (sect as Record<string, unknown>).providers;
    const list: unknown[] = Array.isArray(provs) ? provs : provs && typeof provs === "object" ? Object.values(provs as object) : [];
    const current = String((sect as Record<string, unknown>).current || "");
    list.forEach((p, i) => {
      if (!p || typeof p !== "object") {
        return;
      }
      const o = p as Record<string, unknown>;
      out.push({
        id: String(o.id ?? i),
        appType,
        name: String(o.name ?? "").trim(),
        settings: parseSettings(o.settingsConfig ?? o.settings_config),
        isCurrent: current !== "" && String(o.id) === current,
        sortIndex: typeof o.sortIndex === "number" ? o.sortIndex : i,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------- 各 app 的解析

interface Parsed {
  protocol: Protocol;
  openaiApi?: OpenaiApi;
  anthropicMode?: AnthropicMode;
  baseUrl: string;
  exactBase: boolean;
  apiKey: string;
  models: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const env = (s: Record<string, unknown>): Record<string, unknown> => (s.env && typeof s.env === "object" ? (s.env as Record<string, unknown>) : {});

function uniqModels(list: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    // Claude Code 允许在模型名后面挂 [1M] 之类的上下文标记，那不是模型 id 的一部分
    const s = baseModelId(str(m).replace(/\[\d+[kKmM]?\]$/, "").trim());
    if (!s || s.includes("${")) {
      continue;
    }
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Claude Code / Claude Desktop：env 里的 Anthropic 变量。 */
function parseClaude(s: Record<string, unknown>): Parsed | string {
  const e = env(s);
  const key = str(e.ANTHROPIC_AUTH_TOKEN) || str(e.ANTHROPIC_API_KEY) || str(s.apiKey);
  // 有人把完整的 /v1/messages 端点填进 BASE_URL，Claude Code 自己会再拼一次路径；这里剥掉，交给我们的地址规则
  let base = trimSlash(str(e.ANTHROPIC_BASE_URL)).replace(/\/(v\d+\/)?messages$/i, "");
  if (!key) {
    return "没有 API Key（可能是官方账号登录）";
  }
  if (key.includes("${")) {
    return "Key 还是模板占位符";
  }
  const official = !base || /api\.anthropic\.com/i.test(base);
  if (!base) {
    base = "https://api.anthropic.com";
  }
  const models = uniqModels([
    e.ANTHROPIC_MODEL,
    e.ANTHROPIC_DEFAULT_SONNET_MODEL,
    e.ANTHROPIC_DEFAULT_OPUS_MODEL,
    e.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    e.ANTHROPIC_DEFAULT_FABLE_MODEL,
    e.CLAUDE_CODE_SUBAGENT_MODEL,
    s.model,
  ]);
  return { protocol: "anthropic", anthropicMode: official ? "official" : "kiro", baseUrl: base, exactBase: false, apiKey: key, models };
}

/** 极简 TOML 取值：顶层与指定段里的 `key = "value"`。够读 Codex / Grok CLI 的配置。 */
export function tomlSections(text: string): { top: Record<string, string>; sections: Record<string, Record<string, string>> } {
  const top: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> = top;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sec = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (sec) {
      // [model_providers."my.name"] → model_providers.my.name；["quoted"] → quoted
      let name = sec[1].trim().replace(/\.\s*"([^"]+)"$/, ".$1").replace(/\.\s*'([^']+)'$/, ".$1");
      if (/^".*"$/.test(name) || /^'.*'$/.test(name)) {
        name = name.slice(1, -1);
      }
      cur = sections[name] || (sections[name] = {});
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) {
      continue;
    }
    let v = kv[2].trim();
    const q = /^"((?:[^"\\]|\\.)*)"/.exec(v) || /^'([^']*)'/.exec(v);
    if (q) {
      v = q[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    cur[kv[1]] = v;
  }
  return { top, sections };
}

/** Codex：auth.OPENAI_API_KEY + config.toml 里 model_provider 指向的 [model_providers.X]。 */
function parseCodex(s: Record<string, unknown>): Parsed | string {
  const auth = s.auth && typeof s.auth === "object" ? (s.auth as Record<string, unknown>) : {};
  const toml = tomlSections(str(s.config));
  const pname = toml.top.model_provider || "";
  const sect = (pname && (toml.sections["model_providers." + pname] || toml.sections[`model_providers.${pname}`])) || undefined;
  // 没写 model_provider 就取第一个 model_providers.* 段
  const firstSect = Object.keys(toml.sections).find((k) => k.startsWith("model_providers."));
  const mp = sect || (firstSect ? toml.sections[firstSect] : undefined);
  const base = trimSlash(mp?.base_url || "");
  const key = str(auth.OPENAI_API_KEY) || str(mp?.experimental_bearer_token) || str(env(s).CODEX_API_KEY);
  if (!base) {
    return "config.toml 里没有第三方 base_url（官方 ChatGPT 登录，请用「第三方登录直连 → Codex」）";
  }
  if (!key) {
    return "没有 API Key";
  }
  const wire = (mp?.wire_api || "responses").toLowerCase();
  const catalog = s.modelCatalog && typeof s.modelCatalog === "object" ? (s.modelCatalog as Record<string, unknown>).models : undefined;
  const catalogModels = Array.isArray(catalog) ? catalog.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).model : m)) : [];
  const models = uniqModels([toml.top.model, ...catalogModels]);
  return { protocol: "openai", openaiApi: wire === "chat" ? "chat" : "responses", baseUrl: base, exactBase: true, apiKey: key, models };
}

/** Gemini CLI：GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL（Gemini CLI 自己会拼 /v1beta，我们要补上）。 */
function parseGemini(s: Record<string, unknown>): Parsed | string {
  const e = env(s);
  const key = str(e.GEMINI_API_KEY) || str(e.GOOGLE_API_KEY) || str(s.apiKey);
  if (!key) {
    return "没有 API Key（可能是 Google 账号登录）";
  }
  let base = trimSlash(str(e.GOOGLE_GEMINI_BASE_URL));
  if (!base) {
    base = "https://generativelanguage.googleapis.com/v1beta";
  } else if (!/\/v\d+(alpha|beta)?$/i.test(base)) {
    base += "/v1beta";
  }
  return { protocol: "gemini", baseUrl: base, exactBase: true, apiKey: key, models: uniqModels([e.GEMINI_MODEL]) };
}

/** OpenCode：npm 决定协议，options.baseURL 是 SDK 精确地址，models 的键就是模型 id。 */
function parseOpencode(s: Record<string, unknown>): Parsed | string {
  const npm = str(s.npm);
  const sdk = SDK_TABLE[npm];
  if (!sdk) {
    return npm ? `SDK ${npm} 不是填 key 即用的类型` : "缺少 npm 字段";
  }
  const opts = s.options && typeof s.options === "object" ? (s.options as Record<string, unknown>) : {};
  const key = str(opts.apiKey);
  const base = trimSlash(str(opts.baseURL) || sdk.defaultBase || "");
  if (!key || key.includes("${")) {
    return "没有 API Key";
  }
  if (!base) {
    return "没有地址";
  }
  const models = s.models && typeof s.models === "object" ? Object.keys(s.models as object) : [];
  return {
    protocol: sdk.protocol,
    openaiApi: sdk.protocol === "openai" ? sdk.openaiApi ?? "chat" : undefined,
    anthropicMode: sdk.protocol === "anthropic" ? sdk.anthropicMode ?? "official" : undefined,
    baseUrl: base,
    exactBase: true,
    apiKey: key,
    models: uniqModels(models),
  };
}

/** Hermes：base_url / api_key / api_mode / models[]。 */
function parseHermes(s: Record<string, unknown>): Parsed | string {
  const key = str(s.api_key);
  const base = trimSlash(str(s.base_url));
  if (!base) {
    return "没有地址";
  }
  if (!key) {
    return "没有 API Key";
  }
  const mode = str(s.api_mode).toLowerCase();
  const models = Array.isArray(s.models) ? s.models.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : m)) : [];
  if (mode.includes("anthropic")) {
    return { protocol: "anthropic", anthropicMode: "kiro", baseUrl: base, exactBase: false, apiKey: key, models: uniqModels(models) };
  }
  return { protocol: "openai", openaiApi: mode.includes("respons") ? "responses" : "chat", baseUrl: base, exactBase: false, apiKey: key, models: uniqModels(models) };
}

/** Grok CLI：配置 TOML 里有第三方 base_url + api_key 才导（官方是 xAI 账号登录，走「第三方登录直连 → xAI」）。 */
function parseGrokBuild(s: Record<string, unknown>): Parsed | string {
  const toml = tomlSections(str(s.config));
  const all: Record<string, string> = { ...toml.top };
  for (const sec of Object.values(toml.sections)) {
    Object.assign(all, sec);
  }
  const base = trimSlash(all.base_url || all.api_base_url || "");
  const key = all.api_key || all.xai_api_key || "";
  if (!base || !key) {
    return "Grok CLI 走的是 xAI 账号登录，请用「第三方登录直连 → xAI」";
  }
  const models = uniqModels([toml.sections.models?.default]);
  return { protocol: "openai", openaiApi: "responses", baseUrl: base, exactBase: true, apiKey: key, models };
}

function parseRow(row: CcSwitchRow): Parsed | string {
  switch (row.appType) {
    case "claude":
    case "claude-desktop":
      return parseClaude(row.settings);
    case "codex":
      return parseCodex(row.settings);
    case "gemini":
      return parseGemini(row.settings);
    case "opencode":
      return parseOpencode(row.settings);
    case "hermes":
      return parseHermes(row.settings);
    case "grokbuild":
      return parseGrokBuild(row.settings);
    default:
      return `不认识的类型 ${row.appType}`;
  }
}

// ---------------------------------------------------------------- 汇总

const normUrl = (u: string) => trimSlash(u).toLowerCase().replace(/^https?:\/\//, "").replace(/\/v\d+(alpha|beta)?$/, "");

/** 扫一个库文件：解析全部行，同地址同 key 的合并成一条，标出与已连接 provider 重复的。 */
export function scanCcSwitch(file: string, existing: ProviderConfig[] = getProviders()): ScanResult {
  const rows = readCcSwitchRows(file);
  const candidates: ImportCandidate[] = [];
  const skipped: ImportSkipped[] = [];
  const byKey = new Map<string, ImportCandidate>();
  for (const row of rows) {
    if (!row.name && Object.keys(row.settings).length === 0) {
      continue; // 空壳行
    }
    const parsed = parseRow(row);
    if (typeof parsed === "string") {
      skipped.push({ name: row.name || "(未命名)", source: row.appType, reason: parsed });
      continue;
    }
    // 同一家同一把 key、同一种接口在几个 CLI 里各配了一份 → 合成一条（模型清单取并集，来源都记上）；
    // 接口不同的（比如同一站点在 Claude Code 里走 Anthropic、在 Codex 里走 Responses）各留一条
    const k = [normUrl(parsed.baseUrl), parsed.protocol, parsed.openaiApi || "", parsed.anthropicMode || "", parsed.apiKey].join("\u0000");
    const dup = byKey.get(k);
    if (dup) {
      if (!dup.sources.includes(row.appType)) {
        dup.sources.push(row.appType);
      }
      dup.models = uniqModels([...dup.models, ...parsed.models]);
      continue;
    }
    let name = row.name || "导入的 Provider";
    if (candidates.some((c) => c.name === name)) {
      // 同名不同接口：把来源 CLI 挂在名字后面，导进面板才分得清
      name = `${name} (${APP_LABEL[row.appType] || row.appType})`;
    }
    const cand: ImportCandidate = {
      idx: candidates.length,
      name,
      sources: [row.appType],
      protocol: parsed.protocol,
      openaiApi: parsed.openaiApi,
      anthropicMode: parsed.anthropicMode,
      baseUrl: parsed.baseUrl,
      exactBase: parsed.exactBase,
      apiKey: parsed.apiKey,
      models: parsed.models,
    };
    const same = existing.find(
      (p) => (!p.auth || p.auth === "key") && normUrl(p.baseUrl) === normUrl(parsed.baseUrl) && p.apiKey === parsed.apiKey
    );
    if (same) {
      cand.existsAs = same.name;
    }
    byKey.set(k, cand);
    candidates.push(cand);
  }
  return { path: file, candidates, skipped };
}

/** 候选 → 我们的 ProviderConfig（有 key 有地址就直接启用；模型清单直接进 Kiro 列表）。 */
export function candidateToProvider(c: ImportCandidate, id: string, existingNames: Set<string>): ProviderConfig {
  let name = c.name;
  for (let n = 2; existingNames.has(name); n++) {
    name = `${c.name} ${n}`;
  }
  existingNames.add(name);
  return {
    id,
    name,
    protocol: c.protocol,
    anthropicMode: c.protocol === "anthropic" ? c.anthropicMode ?? "kiro" : undefined,
    openaiApi: c.protocol === "openai" ? c.openaiApi ?? "chat" : undefined,
    baseUrl: c.baseUrl,
    exactBase: c.exactBase ? true : undefined,
    apiKey: c.apiKey,
    enabled: !!c.apiKey && !!c.baseUrl,
    enabledModels: [...c.models],
  };
}
