/**
 * 模型聚合与路由 —— 把所有启用 provider 的模型合并成一张列表，并建立
 * 「模型 ID → 属于哪个 provider」的路由表。这是 merge 运行时的心脏。
 *
 * 从「双固定通道」升级为「N provider」：每条模型都记着它的 providerId，请求进来时
 * providerForModel(id) 直接查到该发往哪个上游、用什么协议。
 */

import { debug, error } from "./log";
import { requestUpstream, readBody } from "./upstream";
import {
  ProviderConfig,
  authHeaders,
  catalogProviderFor,
  getActiveProviders,
  getProvider,
  isModelEnabled,
  isOAuthProvider,
  overrideFor,
  resolveApiUrl,
  splitQualifiedModelId,
} from "./providers";
import { ModelCapability, lookupCapability, normalizeModelId } from "./modelCatalog";
import { VendorModel, getVendor } from "./oauth/vendors";
import { ensureAccessToken, vendorModelsFor } from "./oauth";

/** OAuth 厂商内置目录里对该模型的能力声明（介于用户覆盖与 models.dev 之间）。 */
function vendorModelFor(p: ProviderConfig | undefined, modelId: string): VendorModel | undefined {
  if (!p || !isOAuthProvider(p)) {
    return undefined;
  }
  const spec = getVendor(p.oauthVendor);
  if (!spec) {
    return undefined;
  }
  // 厂商自己有权威在线清单（Kiro 官方 ListAvailableModels）时，内置目录只是拉不到清单的兜底，
  // 在线条目已到手就以它为准，否则兜底里写的 image:true 会盖掉官方说的「仅 TEXT」。
  if (spec.listModels && upstreamModelFor(p, modelId)) {
    return undefined;
  }
  const id = String(modelId || "").toLowerCase();
  const base = id.replace(EFFORT_SUFFIX_RE, "");
  return spec.models.find((m) => m.id.toLowerCase() === id) || spec.models.find((m) => m.id.toLowerCase() === base);
}

export type Protocol = "anthropic" | "openai" | "gemini" | "kiro";

/**
 * 一个模型「支不支持图片 / 是不是推理模型」的最终判定，优先级：
 *   1) provider 上的手动覆盖（用户在面板里勾的「图片/推理」，最权威）；
 *   2) models.dev 目录；
 *   3) undefined —— 交给调用方走名字推断 / 保守默认。
 * providerId 省略时只查目录（用于还不知道归属的场景）。
 */
/** 该 provider 上游 /models 里这个模型的条目（缓存里找，找不到 undefined）。 */
function upstreamModelFor(p: ProviderConfig | undefined, modelId: string): RelayModel | undefined {
  if (!p) {
    return undefined;
  }
  const list = caches.get(p.id)?.models;
  if (!list || list.length === 0) {
    return undefined;
  }
  const id = String(modelId || "").toLowerCase();
  const base = id.replace(EFFORT_SUFFIX_RE, "");
  return list.find((m) => m.id.toLowerCase() === id) || list.find((m) => m.id.toLowerCase() === base);
}

/**
 * 一个模型「支不支持图片」的最终判定，优先级：
 *   1) provider 上的手动覆盖（用户说了算；ignoreOverride=true 时跳过，给 UI 显示"自动"的结论用）；
 *   2) OAuth 厂商内置目录（Codex / Kimi 等我们手写的表）；
 *   3) 上游 /models 自己声明的（Anthropic 官方 capabilities、Codex 后端 input_modalities）；
 *   4) models.dev 目录；
 *   5) undefined —— 谁都不知道。
 */
export function resolveModelImage(modelId: string, providerId?: string, ignoreOverride = false): boolean | undefined {
  const p = providerId ? getProvider(providerId) : providerForModel(modelId);
  if (!ignoreOverride) {
    const ov = overrideFor(p, modelId);
    if (ov && typeof ov.image === "boolean") {
      return ov.image;
    }
  }
  const vm = vendorModelFor(p, modelId);
  if (vm && typeof vm.image === "boolean") {
    return vm.image;
  }
  const um = upstreamModelFor(p, modelId);
  if (um && typeof um.upstreamImage === "boolean") {
    return um.upstreamImage;
  }
  const cap = lookupCapability(modelId);
  return cap ? cap.input.image : undefined;
}

export function resolveModelReasoning(modelId: string, providerId?: string, ignoreOverride = false): boolean | undefined {
  const p = providerId ? getProvider(providerId) : providerForModel(modelId);
  if (!ignoreOverride) {
    const ov = overrideFor(p, modelId);
    if (ov && typeof ov.reasoning === "boolean") {
      return ov.reasoning;
    }
  }
  const vm = vendorModelFor(p, modelId);
  if (vm && typeof vm.reasoning === "boolean") {
    return vm.reasoning;
  }
  const um = upstreamModelFor(p, modelId);
  if (um && typeof um.upstreamReasoning === "boolean") {
    return um.upstreamReasoning;
  }
  const cap = lookupCapability(modelId);
  return cap ? cap.reasoning : undefined;
}

/** UI 用：这个判定是谁给的（手动 / 厂商表 / 上游声明 / 目录 / 无）。 */
export type CapabilitySource = "override" | "vendor" | "upstream" | "catalog" | "none";
export function capabilitySource(field: "image" | "reasoning", modelId: string, providerId?: string, ignoreOverride = false): CapabilitySource {
  const p = providerId ? getProvider(providerId) : providerForModel(modelId);
  if (!ignoreOverride) {
    const ov = overrideFor(p, modelId);
    if (ov && typeof ov[field] === "boolean") {
      return "override";
    }
  }
  const vm = vendorModelFor(p, modelId);
  if (vm && typeof vm[field] === "boolean") {
    return "vendor";
  }
  const um = upstreamModelFor(p, modelId);
  if (um && typeof (field === "image" ? um.upstreamImage : um.upstreamReasoning) === "boolean") {
    return "upstream";
  }
  const cap = lookupCapability(modelId);
  if (cap) {
    return "catalog";
  }
  return "none";
}

/**
 * Kiro 选择器里的「渠道分组标题行」：一条假模型，modelId = 前缀 + providerId（见 cpsServer）。
 * Kiro 的选择器没有分组/禁用单项的能力，标题行真被点到时由 krsServer 用 isGroupHeaderId 拦下提示。
 */
export const GROUP_HEADER_PREFIX = "a2k-group:";
export function isGroupHeaderId(modelId: string): boolean {
  return typeof modelId === "string" && modelId.startsWith(GROUP_HEADER_PREFIX);
}
export function groupHeaderProviderName(modelId: string): string {
  const pid = modelId.slice(GROUP_HEADER_PREFIX.length);
  return getProvider(pid)?.name || pid;
}

export interface RelayModel {
  id: string;
  name: string;
  /** 该模型属于哪个 provider。 */
  providerId: string;
  /** provider 的协议，路由据此决定 /messages 还是 /chat/completions。 */
  protocol: Protocol;
  contextWindow?: number;
  description?: string;
  effortLevels?: string[];
  effortSchemaPath?: string;
  defaultEffortLevel?: string;
  reasoningModes?: string[];
  defaultReasoningMode?: string;
  maxOutputTokens?: number;
  /**
   * 上游 /models 自己声明的能力（有就比 models.dev 目录更权威）。目前只有两家会给：
   *  - Anthropic 官方 `capabilities.image_input.supported` / `capabilities.thinking.supported`
   *    （中转站转发时多半丢掉，直连才有）；
   *  - Codex 后端 `input_modalities` / `supported_reasoning_levels`。
   * OpenAI 公开 API 的 /models 只有 id/created/owned_by，什么都不说。
   */
  upstreamImage?: boolean;
  upstreamReasoning?: boolean;
  /** Kiro 官方 ListAvailableModels 给的 additionalModelRequestFieldsSchema 原文（CPS 原样透传）。 */
  requestFieldsSchema?: unknown;
}

export interface EffortGroup {
  baseId: string;
  name: string;
  providerId: string;
  protocol: Protocol;
  efforts: Set<string>;
  maxInputTokens?: number;
  description?: string;
  nativeEffortLevels?: string[];
  effortSchemaPath?: string;
  defaultEffortLevel?: string;
  reasoningModes?: string[];
  defaultReasoningMode?: string;
  maxOutputTokens?: number;
  requestFieldsSchema?: unknown;
}

export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";
export const EFFORT_SUFFIX_RE = /-(none|low|medium|high|xhigh|max)$/i;
export const BUDGET_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

interface ProviderCache {
  models: RelayModel[];
  time: number;
}

const caches = new Map<string, ProviderCache>();
const MODEL_TTL_MS = 60000;

/** 合并后的全量缓存（含 providerId），供无 fetch 的同步查询。 */
let mergedCache: RelayModel[] = [];

function parseContextWindow(m: Record<string, unknown>): number {
  const raw =
    (m.context_window as number) ??
    (m.context_length as number) ??
    (m.max_input_tokens as number) ??
    (m.max_context_tokens as number) ??
    (m.maxInputTokens as number) ??
    (m.inputTokenLimit as number) ??
    (m.contextWindow as number);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strField(x: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = x[k];
    if (typeof v === "string" && v) {
      return v;
    }
  }
  return undefined;
}

function strArrayField(x: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = x[k];
    if (Array.isArray(v)) {
      const arr = v.filter((e): e is string => typeof e === "string");
      if (arr.length > 0) {
        return arr;
      }
    }
  }
  return undefined;
}

/** 模型条目的 id：OpenAI/Anthropic 用 id；Gemini 的 /models 给的是 name:"models/gemini-2.5-pro"。 */
export function modelEntryId(x: Record<string, unknown>): string {
  if (typeof x.id === "string" && x.id) {
    return x.id;
  }
  if (typeof x.modelId === "string" && x.modelId) {
    return x.modelId;
  }
  if (typeof x.name === "string" && x.name.startsWith("models/")) {
    return x.name.slice("models/".length);
  }
  return "";
}

/**
 * 从上游 /models 条目里抠能力声明。只认明确的布尔 / 枚举，认不出返回 undefined（交给目录）。
 *  - Anthropic 官方：`capabilities.image_input.supported`、`capabilities.thinking.supported`；
 *  - Codex 后端：`input_modalities` 含 "image"、`supported_reasoning_levels` 非空；
 *  - 少数 OpenAI 兼容网关（LiteLLM / OpenRouter 的 `architecture.input_modalities`）也顺手认一下。
 */
function upstreamCapabilities(x: Record<string, unknown>): { image?: boolean; reasoning?: boolean } {
  const out: { image?: boolean; reasoning?: boolean } = {};
  const caps = x.capabilities as Record<string, unknown> | undefined;
  if (caps && typeof caps === "object") {
    const sup = (k: string) => {
      const v = caps[k] as Record<string, unknown> | undefined;
      return v && typeof v === "object" && typeof v.supported === "boolean" ? (v.supported as boolean) : undefined;
    };
    const img = sup("image_input");
    if (img !== undefined) {
      out.image = img;
    }
    const think = sup("thinking");
    const effort = sup("effort");
    if (think !== undefined || effort !== undefined) {
      out.reasoning = !!(think || effort);
    }
  }
  const mods =
    (Array.isArray(x.input_modalities) ? x.input_modalities : undefined) ??
    (Array.isArray((x.architecture as Record<string, unknown> | undefined)?.input_modalities)
      ? ((x.architecture as Record<string, unknown>).input_modalities as unknown[])
      : undefined);
  if (mods && out.image === undefined) {
    const list = mods.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase());
    if (list.length > 0) {
      out.image = list.includes("image");
    }
  }
  if (out.reasoning === undefined && Array.isArray(x.supported_reasoning_levels)) {
    out.reasoning = (x.supported_reasoning_levels as unknown[]).length > 0;
  }
  return out;
}

function normalizeModel(x: Record<string, unknown>, p: ProviderConfig): RelayModel {
  const id = modelEntryId(x);
  const maxOutRaw =
    (x.max_tokens as number) ?? (x.max_output_tokens as number) ?? (x.maxOutputTokens as number);
  const maxOutputTokens =
    Number.isFinite(Number(maxOutRaw)) && Number(maxOutRaw) > 0 ? Number(maxOutRaw) : undefined;
  const cw = parseContextWindow(x);
  // 目录能力兜底填充上下文窗口/最大输出（中转站没给时）。
  const cap = lookupCapability(id);
  // Gemini 的 name 是 "models/<id>"，展示名在 displayName
  const rawName = typeof x.name === "string" && !x.name.startsWith("models/") ? x.name : undefined;
  const up = upstreamCapabilities(x);
  return {
    id,
    name: String(x.display_name || x.displayName || rawName || x.modelName || id),
    providerId: p.id,
    protocol: p.protocol,
    contextWindow: cw || cap?.contextWindow,
    description: typeof x.description === "string" ? x.description : undefined,
    effortLevels: strArrayField(x, "effort_levels", "effortLevels"),
    effortSchemaPath: strField(x, "effort_schema_path", "effortSchemaPath"),
    defaultEffortLevel: strField(x, "default_effort_level", "defaultEffortLevel"),
    reasoningModes: strArrayField(x, "reasoning_modes", "reasoningModes"),
    defaultReasoningMode: strField(x, "default_reasoning_mode", "defaultReasoningMode"),
    maxOutputTokens: maxOutputTokens || cap?.maxOutputTokens,
    upstreamImage: up.image,
    upstreamReasoning: up.reasoning,
  };
}

/** OAuth 厂商内置目录（按该账号套餐裁剪）→ RelayModel。 */
function vendorCatalog(p: ProviderConfig): RelayModel[] {
  return vendorModelsFor(p).map((m) => {
    const cap = lookupCapability(m.id);
    return {
      id: m.id,
      name: m.name || m.id,
      providerId: p.id,
      protocol: p.protocol,
      contextWindow: m.contextWindow || cap?.contextWindow,
      maxOutputTokens: cap?.maxOutputTokens,
    };
  });
}

/** 单个渠道在合并列表里的等待预算；超时就先用替身清单，拉取本身不取消（结果照常进缓存）。 */
const FETCH_BUDGET_MS = 3000;

function withBudget<T>(task: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback());
      }
    }, ms);
    task.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallback());
        }
      }
    );
  });
}

/**
 * 拉不到 / 来不及拉时的替身清单：缓存里有旧的用旧的；否则把用户勾选的模型 id 直接当条目
 * （名字就是 id，上下文窗口查能力目录）；再否则 models.dev 登记的清单。
 */
function stubModels(p: ProviderConfig): RelayModel[] {
  const cached = caches.get(p.id)?.models;
  if (cached && cached.length) {
    return cached;
  }
  const picked = (p.enabledModels || []).filter((id) => typeof id === "string" && id.trim());
  if (picked.length) {
    return picked.map((id) => {
      const cap = lookupCapability(id);
      return { id, name: id, providerId: p.id, protocol: p.protocol, contextWindow: cap?.contextWindow, maxOutputTokens: cap?.maxOutputTokens };
    });
  }
  return catalogFallbackModels(p);
}

/** 拉一个 provider 的模型列表（60s 缓存）。 */
export async function fetchProviderModels(p: ProviderConfig, force = false): Promise<RelayModel[]> {
  const cache = caches.get(p.id);
  const now = Date.now();
  if (!force && cache && cache.models.length > 0 && now - cache.time < MODEL_TTL_MS) {
    return cache.models;
  }
  const url = resolveApiUrl(p, "/models");
  if (isOAuthProvider(p)) {
    // 登录类厂商多半没有 /models：以内置目录为底；厂商声明可试的再拉一次合并（拉不到就算）。
    const spec = getVendor(p.oauthVendor);
    // 厂商自带在线清单（Kiro 官方 ListAvailableModels）：拉到了就整个用它（含官方 schema / 限长），拉不到退回内置目录
    if (spec?.listModels) {
      try {
        const tok = await ensureAccessToken(p);
        const live = await spec.listModels(tok);
        if (live.length) {
          const models: RelayModel[] = live.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            providerId: p.id,
            protocol: p.protocol,
            description: m.description,
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
            effortLevels: m.effortLevels,
            effortSchemaPath: m.effortSchemaPath,
            defaultEffortLevel: m.defaultEffortLevel,
            upstreamImage: m.image,
            upstreamReasoning: m.reasoning,
            requestFieldsSchema: m.requestFieldsSchema,
          }));
          caches.set(p.id, { models, time: Date.now() });
          debug(`provider ${p.id} live vendor models`, { count: models.length });
          return models;
        }
      } catch (e) {
        debug(`provider ${p.id} vendor listModels failed, using builtin catalog:`, (e as Error).message);
      }
    }
    const base = vendorCatalog(p);
    if (spec?.tryModelsEndpoint && url) {
      try {
        await ensureAccessToken(p);
        const fetched = await fetchModelsHttp(p, url);
        const seen = new Set(base.map((m) => m.id.toLowerCase()));
        for (const m of fetched) {
          if (!seen.has(m.id.toLowerCase())) {
            base.push(m);
          }
        }
      } catch (e) {
        debug(`provider ${p.id} /models (oauth) skipped:`, (e as Error).message);
      }
    }
    caches.set(p.id, { models: base, time: Date.now() });
    return base;
  }
  if (!p.apiKey || !url) {
    return cache?.models || [];
  }
  try {
    let models = await fetchModelsHttp(p, url);
    if (!models.length) {
      // 上游 /models 为空（不少中转站/网关不实现）→ 用 models.dev 登记的清单
      const fb = catalogFallbackModels(p);
      if (fb.length) {
        debug(`provider ${p.id} /models empty, using models.dev catalog`, { count: fb.length });
        models = fb;
      }
    }
    caches.set(p.id, { models, time: Date.now() });
    debug(`provider ${p.id} models fetched`, { count: models.length });
    return models;
  } catch (e) {
    error(`provider ${p.id} /models fetch failed:`, (e as Error).message);
    if (cache?.models.length) {
      return cache.models;
    }
    const fb = catalogFallbackModels(p);
    if (fb.length) {
      debug(`provider ${p.id} /models failed, using models.dev catalog`, { count: fb.length });
      caches.set(p.id, { models: fb, time: Date.now() });
      return fb;
    }
    return [];
  }
}

/**
 * 用一份刚拉到的模型清单（设置弹窗里「刷新模型」探测的结果）直接更新该 provider 的缓存，
 * 不必等 60s 缓存过期再重拉——「添加模型」的候选池马上就能看到新模型。
 */
export function seedProviderModels(p: ProviderConfig, models: Array<{ id: string; name?: string }>): void {
  const seen = new Set<string>();
  const list: RelayModel[] = [];
  // 探测面板只回传 id/name；正式拉取解析出的上游能力声明 / effort 字段别被这份精简清单冲掉
  const prev = new Map((caches.get(p.id)?.models || []).map((m) => [m.id.toLowerCase(), m] as const));
  for (const m of models) {
    const id = String(m.id || "").trim();
    if (!id || seen.has(id.toLowerCase())) {
      continue;
    }
    seen.add(id.toLowerCase());
    const cap = lookupCapability(id);
    const old = prev.get(id.toLowerCase());
    list.push({
      ...(old || {}),
      id,
      name: m.name && m.name !== id ? m.name : old?.name || id,
      providerId: p.id,
      protocol: p.protocol,
      contextWindow: old?.contextWindow || cap?.contextWindow,
      maxOutputTokens: old?.maxOutputTokens || cap?.maxOutputTokens,
    });
  }
  if (list.length) {
    caches.set(p.id, { models: list, time: Date.now() });
  }
}

/** models.dev 登记的该 provider 模型清单 → RelayModel（预设 provider 才有；自定义地址没有）。 */
export function catalogFallbackModels(p: ProviderConfig): RelayModel[] {
  const cp = catalogProviderFor(p);
  if (!cp) {
    return [];
  }
  return cp.models.map((id) => {
    const cap = lookupCapability(id);
    return {
      id,
      name: cap?.name || id,
      providerId: p.id,
      protocol: p.protocol,
      contextWindow: cap?.contextWindow,
      maxOutputTokens: cap?.maxOutputTokens,
    };
  });
}

/** GET /models 并解析（data[] / models[] / 裸数组三种形态）。 */
async function fetchModelsHttp(p: ProviderConfig, url: string): Promise<RelayModel[]> {
  const headers: Record<string, string> = { ...authHeaders(p), Accept: "application/json" };
  const res = await requestUpstream("GET", url, headers, undefined, 15000);
  // 有的坏中转发完响应头就再不吐字节；正文也要有截止时间，否则这一路 await 永远醒不过来
  let bodyTimer: NodeJS.Timeout | undefined;
  const text = await Promise.race([
    readBody(res.body),
    new Promise<string>((_, reject) => {
      bodyTimer = setTimeout(() => {
        res.body.destroy();
        reject(new Error("/models 响应正文超时"));
      }, 15000);
    }),
  ]).finally(() => clearTimeout(bodyTimer));
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const raw = JSON.parse(text) as { data?: unknown[]; models?: unknown[] } | unknown[];
  const arr: unknown[] = Array.isArray((raw as { data?: unknown[] }).data)
    ? (raw as { data: unknown[] }).data
    : Array.isArray((raw as { models?: unknown[] }).models)
    ? (raw as { models: unknown[] }).models
    : Array.isArray(raw)
    ? (raw as unknown[])
    : [];
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => modelEntryId(x))
    .map((x) => normalizeModel(x, p));
}

/**
 * 拉全部启用 provider 的模型，**只保留用户在模型页勾选的**，合并成进 Kiro 选择器的列表。
 *
 * 连上 provider ≠ 它的模型都进 Kiro：OpenRouter 一连三百多个模型全灌进去，选择器就废了。
 * 所以这里按 provider.enabledModels 过滤（见 isModelEnabled 三态），CPS 广播的、
 * 路由表里有的，都只是这份过滤后的结果。要看上游全部模型用 fetchProviderModels。
 *
 * 同一个 model id 在多个 provider 都勾了时**都保留**（用户在两个渠道各自勾的，就是想两边都能用）；
 * 到 Kiro 那边靠 kiroModelIds 区分：第一个渠道用原 id，之后的带 `@providerId` 限定。
 * 按裸 id 查归属时先出现者赢，与 provider 注册顺序一致。
 */
export async function fetchAllModels(force = false): Promise<RelayModel[]> {
  const providers = getActiveProviders();
  if (providers.length === 0) {
    mergedCache = [];
    return [];
  }
  // 一次拉全部渠道，但整体有时间预算：Kiro 请求模型列表（CPS）是有超时的，二三十个渠道里只要有一两个
  // 半死不活的中转（连接挂 15s 才失败），Promise.all 就会把整张列表拖到超时 → Kiro 那边空列表、选择器直接消失。
  // 超出预算的渠道先用「已勾选的模型 id」顶上（Kiro 列表只关心这些），真正的清单在后台继续拉、进缓存，下次就齐了。
  // 一个模型都没勾的渠道不必拉——它对 Kiro 列表没有贡献。
  const lists = await Promise.all(
    providers.map((p) => {
      if (p.enabledModels && p.enabledModels.length === 0) {
        return Promise.resolve<RelayModel[]>([]);
      }
      return withBudget(fetchProviderModels(p, force), FETCH_BUDGET_MS, () => stubModels(p));
    })
  );
  const merged: RelayModel[] = [];
  const seen = new Set<string>();
  providers.forEach((p, i) => {
    for (const m of lists[i]) {
      if (!isModelEnabled(p, m.id)) {
        continue;
      }
      // 同一渠道内去重（上游列表偶有重复条目）；跨渠道的同名模型各自保留
      const key = p.id + "\u0000" + m.id.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(m);
    }
  });
  mergedCache = merged;
  return merged;
}

/** 兼容旧调用名。 */
export async function fetchRelayModels(force = false): Promise<RelayModel[]> {
  return fetchAllModels(force);
}

export function getCachedModels(): RelayModel[] {
  return mergedCache;
}

/**
 * 一个模型 id 属于哪个 provider。
 *
 * 先查合并缓存里的精确 id / 去 effort 后缀的 base id；命中返回该 provider。
 * 缓存为空（冷启动）时返回 undefined，调用方负责先 fetch 再查或兜底。
 */
export function providerForModel(modelId: string): ProviderConfig | undefined {
  // 带渠道限定的 id（<id>@<providerId>，见 kiroModelIds）：归属就写在 id 里
  const q = splitQualifiedModelId(String(modelId || ""));
  if (q.providerId) {
    const owner = getProvider(q.providerId);
    if (owner && owner.enabled) {
      return owner;
    }
  }
  const id = q.modelId.toLowerCase();
  const base = id.replace(EFFORT_SUFFIX_RE, "");
  const match = (m: RelayModel) => {
    const mid = m.id.toLowerCase();
    return mid === id || mid === base;
  };
  // 先查勾选后的合并列表（正常路径）。
  const hit = mergedCache.find(match);
  if (hit) {
    return getProvider(hit.providerId);
  }
  // 再查各 provider 的原始列表：用户在模型页取消了某模型的勾选，但 Kiro 里已开的
  // 会话仍会带这个 id 发请求——它该继续发到原来的上游，而不是掉到兜底 provider。
  for (const p of getActiveProviders()) {
    const raw = caches.get(p.id)?.models || [];
    if (raw.some(match)) {
      return p;
    }
  }
  return undefined;
}

/** 一个模型 id 走哪种协议（路由用）。查不到时兜底到唯一启用 provider 的协议。 */
export function protocolForModel(modelId: string): Protocol {
  const p = providerForModel(modelId);
  if (p) {
    return p.protocol;
  }
  const active = getActiveProviders();
  if (active.length === 1) {
    return active[0].protocol;
  }
  return "anthropic";
}

/** 上游是否存在 `<base>-<effort>` 变体（限该 provider 的缓存）。 */
export function hasEffortVariant(providerId: string, base: string, effort: string): boolean {
  const b = String(base || "").toLowerCase();
  const e = String(effort || "").toLowerCase();
  if (!b || !e) {
    return false;
  }
  const target = `${b}-${e}`;
  const list = caches.get(providerId)?.models || [];
  return list.some((m) => m.id.toLowerCase() === target);
}

/** 上游是否存在 `<base>-thinking` 变体。 */
export function thinkingVariantOf(providerId: string, base: string): string | undefined {
  const b = String(base || "").toLowerCase();
  if (!b || b.endsWith("-thinking")) {
    return undefined;
  }
  const list = caches.get(providerId)?.models || [];
  const hit = list.find((m) => m.id.toLowerCase() === b + "-thinking");
  return hit?.id;
}

export function contextWindowForModel(id: string): number | undefined {
  const hit = mergedCache.find((m) => m.id === id);
  if (hit?.contextWindow) {
    return hit.contextWindow;
  }
  return lookupCapability(id)?.contextWindow;
}

export function looksReasoningModel(modelId: string, providerId?: string): boolean {
  // 覆盖 > 目录 > 名字推断。
  const decided = resolveModelReasoning(modelId, providerId);
  if (typeof decided === "boolean") {
    return decided;
  }
  const m = String(modelId || "").toLowerCase();
  if (!m) {
    return false;
  }
  if (/(^|[^a-z])o[1345]([^a-z0-9]|$)/.test(m)) {
    return true;
  }
  return (
    m.includes("gpt-5") ||
    m.includes("gpt5") ||
    m.includes("reasoner") ||
    m.includes("reasoning") ||
    m.includes("thinking") ||
    m.includes("qwq") ||
    m.includes("-r1")
  );
}

/**
 * 把扁平模型列表按 effort 后缀折叠成基础模型 + 可用档位。
 *
 * 只有基础模型真的在列表里时才折叠（否则会造出上游不存在的模型 → 404）。
 * 折叠限定在「同一 provider 内」：不同 provider 的同后缀不应互相归并。
 */
export function groupModelsByEffort(models: RelayModel[]): EffortGroup[] {
  const map = new Map<string, EffortGroup>();
  const order: string[] = [];

  // key = providerId + "\u0000" + baseId，保证跨 provider 不串。
  const gkey = (providerId: string, baseId: string) => providerId + "\u0000" + baseId;

  const ensure = (baseId: string, src: RelayModel): EffortGroup => {
    const k = gkey(src.providerId, baseId);
    let g = map.get(k);
    if (!g) {
      g = {
        baseId,
        name: baseId,
        providerId: src.providerId,
        protocol: src.protocol,
        efforts: new Set<string>(),
      };
      map.set(k, g);
      order.push(k);
    }
    if (src.contextWindow && !g.maxInputTokens) {
      g.maxInputTokens = src.contextWindow;
    }
    return g;
  };

  const presentByProvider = new Map<string, Set<string>>();
  for (const m of models) {
    if (m && m.id) {
      let set = presentByProvider.get(m.providerId);
      if (!set) {
        set = new Set<string>();
        presentByProvider.set(m.providerId, set);
      }
      set.add(m.id.toLowerCase());
    }
  }

  const foldsIntoBase = (m: RelayModel): { baseId: string; effort: string } | undefined => {
    const match = m.id.match(EFFORT_SUFFIX_RE);
    if (!match) {
      return undefined;
    }
    const baseId = m.id.slice(0, m.id.length - match[0].length);
    const present = presentByProvider.get(m.providerId);
    if (!baseId || !present?.has(baseId.toLowerCase())) {
      return undefined;
    }
    return { baseId, effort: match[1].toLowerCase() };
  };

  for (const m of models) {
    if (!m || !m.id) {
      continue;
    }
    const folded = foldsIntoBase(m);
    if (folded) {
      ensure(folded.baseId, m).efforts.add(folded.effort);
    } else {
      const g = ensure(m.id, m);
      if (m.name) {
        g.name = m.name;
      }
      if (m.description) {
        g.description = m.description;
      }
      if (m.effortLevels && m.effortLevels.length > 0) {
        g.nativeEffortLevels = m.effortLevels;
      }
      if (m.effortSchemaPath) {
        g.effortSchemaPath = m.effortSchemaPath;
      }
      if (m.defaultEffortLevel) {
        g.defaultEffortLevel = m.defaultEffortLevel;
      }
      if (m.reasoningModes && m.reasoningModes.length > 0) {
        g.reasoningModes = m.reasoningModes;
      }
      if (m.defaultReasoningMode) {
        g.defaultReasoningMode = m.defaultReasoningMode;
      }
      if (m.maxOutputTokens && !g.maxOutputTokens) {
        g.maxOutputTokens = m.maxOutputTokens;
      }
      if (m.requestFieldsSchema) {
        g.requestFieldsSchema = m.requestFieldsSchema;
      }
    }
  }

  return order.map((k) => map.get(k)!);
}

/** 仅测试用：把一份上游 /models 形态的原始条目直接灌进某 provider 的缓存（不走 HTTP）。 */
export function __seedRaw(p: ProviderConfig, entries: Array<Record<string, unknown>>): void {
  const list = entries.filter((x) => modelEntryId(x)).map((x) => normalizeModel(x, p));
  caches.set(p.id, { models: list, time: Date.now() });
}

/** 供图片策略/能力落地复用的目录查询封装（避免各处直接依赖 modelCatalog）。 */
export { lookupCapability, normalizeModelId };
export type { ModelCapability };
