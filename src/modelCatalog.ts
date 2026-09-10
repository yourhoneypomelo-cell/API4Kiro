/**
 * 模型能力目录 —— 权威的「这个模型支不支持图片 / 思考档位是哪种形态 / 上下文多大」来源。
 *
 * 数据来自 models.dev（Kilo/OpenCode 用的同一个公共目录，https://models.dev/api.json）。
 * 中转站的 /v1/models 通常只给 id，什么能力都不带（实测本站即如此），于是：
 *  - 图片：只能被上游 400 之后才学到「不支持」；
 *  - 思考档位：只能靠模型名后缀猜；
 *  - 上下文窗口：只能靠一堆写死的正则。
 * 有了目录就能事前知道，把这三件事从「猜/学」升级成「查」。
 *
 * 设计要点（对齐 Kilo 的稳健性）：
 *  - 纯增强、可完全缺席：拉取失败/超时/断网 → 返回 undefined，调用方一律回退到既有逻辑，
 *    绝不因为目录拿不到而降低可用性；
 *  - 磁盘缓存 + TTL：落 globalState，24h 内不重复拉；启动后台异步拉一次，不阻塞激活；
 *  - 按 id 宽松匹配：中转站的 id（deepseek-v4-pro）未必与目录 id 逐字相等，做规范化 + family 兜底。
 */

import * as vscode from "vscode";
import { requestUpstream, readBody } from "./upstream";
import { debug, error, info } from "./log";

/** 思考档位的三种形态（取自 models.dev reasoning_options）。 */
export type ReasoningKind =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget"; min?: number; max?: number };

export interface ModelCapability {
  /** 目录里的规范 id。 */
  id: string;
  name?: string;
  family?: string;
  /** 输入模态。text 恒真；重点是 image/pdf/audio/video。 */
  input: { text: boolean; image: boolean; pdf: boolean; audio: boolean; video: boolean };
  /** 是否 reasoning 模型。 */
  reasoning: boolean;
  /** 思考档位形态（reasoning=false 时为空）。 */
  reasoningOptions: ReasoningKind[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * models.dev 的 provider 层：OpenCode / Kilo「连接提供商」那一长串就是它。
 * api 是 SDK 的**精确** baseURL（后面直接拼 /chat/completions 或 /messages，不再插 /v1）；
 * npm 是 AI SDK 包名，据此知道说哪种协议；env 是 API Key 的环境变量名（做输入提示）。
 */
export interface CatalogProvider {
  id: string;
  name: string;
  api: string;
  npm: string;
  env: string[];
  doc?: string;
  /** 该 provider 在 models.dev 上登记的模型 id（用作 /models 拉不到时的清单）。 */
  models: string[];
}

interface CatalogState {
  /** 规范化 id → 能力。 */
  byId: Map<string, ModelCapability>;
  /** provider id → 元数据。 */
  providers: Map<string, CatalogProvider>;
  fetchedAt: number;
}

let catalogUrl = "https://models.dev/api.json";
/** 测试用：把目录地址指到本地假服务器（或一个关着的端口，模拟不可达）。 */
export function _setCatalogUrlForTest(url?: string): void {
  catalogUrl = url || "https://models.dev/api.json";
}
const CACHE_KEY = "modelCatalog.snapshot";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 保底：目录不可用时也认得这些常见家族支不支持图片，避免完全裸奔。 */
const TIMEOUT_MS = 12000;

let ctx: vscode.ExtensionContext | undefined;
let state: CatalogState = { byId: new Map(), providers: new Map(), fetchedAt: 0 };

/**
 * 去掉 id 尾部的「变体标签」与版本尾巴（不动 provider 前缀）：
 *  - `:free` / `:batch` / `:thinking` / `:8192` / `:0731` 这类 OpenRouter / nano-gpt 风格的冒号标签（4.13.55；
 *    此前 `qwen3-coder:free` 查不到精确条目、落到 family 兜底命中无关模型）；
 *  - `-none|-low|…|-thinking` 思考 / 努力档位后缀；
 *  - `-20250514` / `-2025-05-14` / `:20250514` 日期版本。
 */
function stripVariantSuffixes(s: string): string {
  // 冒号标签：目录里 207 条带它（:thinking 74 / :free 54 / :0 41 / :8192 …），标签前后是同一模型的变体；
  // 可叠加（`claude-opus-4.6:thinking:low`）。ollama 风格的 `:30b` / `:120b` 是参数量、指向另一个模型，保留。
  for (let i = 0; i < 3; i++) {
    const m = /:([a-z0-9._-]+)$/i.exec(s);
    if (!m || /^\d+b$/i.test(m[1])) {
      break;
    }
    s = s.slice(0, m.index);
  }
  // 去掉常见思考/努力档位后缀
  s = s.replace(/-(none|minimal|low|medium|high|xhigh|max|thinking)$/i, "");
  // 去掉结尾的日期版本（-20250514 / -2025-05-14）
  s = s.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/i, "");
  return s;
}

/** id 规范化：小写、去 provider 前缀（openai/…）、去 `:tag` 变体标签、去 effort/思考后缀、去日期版本尾巴。 */
export function normalizeModelId(raw: string): string {
  let s = String(raw || "").toLowerCase().trim();
  if (!s) {
    return "";
  }
  // 去掉 "provider/" 前缀（openrouter 风格）
  const slash = s.lastIndexOf("/");
  if (slash >= 0) {
    s = s.slice(slash + 1);
  }
  return stripVariantSuffixes(s);
}

/**
 * 带 provider 前缀的全名键（4.13.55）：`openrouter/free` 与 `orcarouter/free` 去前缀后都是 `free`，只按规范化键查
 * 会让前者命中目录里先到的后者（65536 vs 200000）。目录条目 id 本身带 `/` 时另登记一把 `full:` 键，
 * 查询方 id 也带 `/` 时先按全名精确查，再退到去前缀的规范化键。无 `/` 的 id 返回 ""（与规范化键重合，不必登记）。
 */
export function fullModelKey(raw: string): string {
  const s = String(raw || "").toLowerCase().trim();
  if (!s || s.indexOf("/") < 0) {
    return "";
  }
  return stripVariantSuffixes(s);
}

function toBoolInput(mods: unknown): ModelCapability["input"] {
  const arr = Array.isArray(mods) ? (mods as string[]) : [];
  const has = (k: string) => arr.includes(k);
  return {
    text: arr.length === 0 || has("text"),
    image: has("image"),
    pdf: has("pdf"),
    audio: has("audio"),
    video: has("video"),
  };
}

function parseReasoningOptions(raw: unknown): ReasoningKind[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ReasoningKind[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") {
      continue;
    }
    const r = o as Record<string, unknown>;
    if (r.type === "effort" && Array.isArray(r.values)) {
      const values = (r.values as unknown[]).map((v) => (v === null ? "none" : String(v)));
      out.push({ type: "effort", values });
    } else if (r.type === "toggle") {
      out.push({ type: "toggle" });
    } else if (r.type === "budget_tokens") {
      out.push({
        type: "budget",
        min: typeof r.min === "number" ? r.min : undefined,
        max: typeof r.max === "number" ? r.max : undefined,
      });
    }
  }
  return out;
}

function parseCatalog(json: unknown): { byId: Map<string, ModelCapability>; providers: Map<string, CatalogProvider> } {
  const map = new Map<string, ModelCapability>();
  const providers = new Map<string, CatalogProvider>();
  if (!json || typeof json !== "object") {
    return { byId: map, providers };
  }
  // 结构：{ [providerId]: { id, name, api, npm, env[], doc, models: { [modelId]: Model } } }
  for (const [pid, provider] of Object.entries(json as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") {
      continue;
    }
    const pr = provider as Record<string, unknown>;
    const models = pr.models;
    if (!models || typeof models !== "object") {
      continue;
    }
    providers.set(pid, {
      id: pid,
      name: typeof pr.name === "string" && pr.name ? pr.name : pid,
      api: typeof pr.api === "string" ? pr.api.trim() : "",
      npm: typeof pr.npm === "string" ? pr.npm : "",
      env: Array.isArray(pr.env) ? (pr.env as unknown[]).filter((e): e is string => typeof e === "string") : [],
      doc: typeof pr.doc === "string" && pr.doc ? pr.doc : undefined,
      models: Object.keys(models as Record<string, unknown>),
    });
    for (const [mid, mRaw] of Object.entries(models as Record<string, unknown>)) {
      if (!mRaw || typeof mRaw !== "object") {
        continue;
      }
      const m = mRaw as Record<string, unknown>;
      const modalities = (m.modalities as Record<string, unknown>) || {};
      const limit = (m.limit as Record<string, unknown>) || {};
      const cap: ModelCapability = {
        id: mid,
        name: typeof m.name === "string" ? m.name : undefined,
        family: typeof m.family === "string" ? m.family : undefined,
        input: toBoolInput(modalities.input ?? (m.attachment ? ["text", "image"] : ["text"])),
        reasoning: m.reasoning === true,
        reasoningOptions: parseReasoningOptions(m.reasoning_options),
        contextWindow: typeof limit.context === "number" ? limit.context : undefined,
        maxOutputTokens: typeof limit.output === "number" ? limit.output : undefined,
      };
      registerCapability(map, cap);
    }
  }
  return { byId: map, providers };
}

/**
 * 把一条能力登记进索引：规范化键 / 带前缀全名键 / family 别名键，三种键都**先到先得**。
 * parseCatalog（拉取）、initModelCatalog（快照重建）、resetCatalogForTest 共用同一份规则——4.13.55 之前
 * 快照重建用的是无条件 `map.set`，重启后「先到先得」变成「后到覆盖」（MiniMax-M2.5 报 65536 而非 204800）。
 */
function registerCapability(map: Map<string, ModelCapability>, cap: ModelCapability): void {
  // 同一模型可能被多个 provider 收录；规范化后先到先得，够用。
  const key = normalizeModelId(cap.id);
  if (key && !map.has(key)) {
    map.set(key, cap);
  }
  // 带 provider 前缀的全名（openrouter/free）另登记一把，让带前缀的查询先精确命中自己那条。
  const full = fullModelKey(cap.id);
  if (full && !map.has("full:" + full)) {
    map.set("full:" + full, cap);
  }
  // 也用 family 兜底一层键，让 deepseek-v4-pro 能命中 family=deepseek 的条目（只借能力，不借窗口，见 lookupCapability）。
  if (cap.family) {
    const fkey = normalizeModelId(cap.family);
    if (fkey && !map.has("family:" + fkey)) {
      map.set("family:" + fkey, cap);
    }
  }
}

interface Snapshot {
  at: number;
  models: ModelCapability[];
  providers?: CatalogProvider[];
}

const listeners = new Set<() => void>();

/** 目录（含 provider 层）刷新后通知——面板据此重算预设列表。 */
export function onCatalogChanged(l: () => void): vscode.Disposable {
  listeners.add(l);
  return { dispose: () => listeners.delete(l) };
}

export function initModelCatalog(context: vscode.ExtensionContext): void {
  ctx = context;
  const snap = context.globalState.get<Snapshot>(CACHE_KEY);
  if (snap && Array.isArray(snap.models)) {
    // 快照按首次登记顺序保存（Set 保序），逐条重新登记即可复原「先到先得」。
    const map = new Map<string, ModelCapability>();
    for (const cap of snap.models) {
      if (cap && typeof cap.id === "string") {
        registerCapability(map, cap);
      }
    }
    const providers = new Map<string, CatalogProvider>();
    for (const p of snap.providers || []) {
      if (p && typeof p.id === "string") {
        providers.set(p.id, { ...p, env: Array.isArray(p.env) ? p.env : [], models: Array.isArray(p.models) ? p.models : [] });
      }
    }
    state = { byId: map, providers, fetchedAt: snap.at || 0 };
    debug("model catalog loaded from cache", { count: snap.models.length, providers: providers.size, at: snap.at });
  }
  // 后台刷新（不阻塞激活）。老快照没有 provider 层的话强制拉一次补上。
  void refreshCatalog(state.providers.size === 0 && state.byId.size > 0);
}

/** 拉取目录。force 忽略 TTL。失败静默（返回 false），既有缓存继续用。 */
export async function refreshCatalog(force: boolean): Promise<boolean> {
  const fresh = Date.now() - state.fetchedAt < CACHE_TTL_MS && state.byId.size > 0;
  if (!force && fresh) {
    return true;
  }
  try {
    const res = await requestUpstream("GET", catalogUrl, { Accept: "application/json" }, undefined, TIMEOUT_MS);
    const text = await readBody(res.body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    const json = JSON.parse(text);
    const { byId: map, providers } = parseCatalog(json);
    if (map.size === 0) {
      throw new Error("catalog empty after parse");
    }
    state = { byId: map, providers, fetchedAt: Date.now() };
    // 持久化去重后的能力（不含 family: 别名键）+ provider 层。
    const models = [...new Set([...map.values()])];
    const snap: Snapshot = { at: state.fetchedAt, models, providers: [...providers.values()] };
    await ctx?.globalState.update(CACHE_KEY, snap);
    info(`model catalog refreshed: ${models.length} models / ${providers.size} providers from models.dev`);
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch (e) {
    debug("model catalog refresh failed (using existing/none):", (e as Error).message);
    return false;
  }
}

/** models.dev 登记的全部 provider（按 id 排序）。目录未就绪时为空数组。 */
export function catalogProviders(): CatalogProvider[] {
  return [...state.providers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function catalogProvider(id: string): CatalogProvider | undefined {
  return state.providers.get(id);
}

/**
 * 查一个模型的能力。带 `/` 的 id 先按全名精确查，再按去前缀的规范化键精确查，最后退到 family 别名。
 * 查不到返回 undefined —— 调用方据此回退既有的猜/学逻辑。
 *
 * family 兜底只借「能力」（图片 / 推理 / 档位形态），**不借窗口**：同族另一个模型的 `contextWindow` /
 * `maxOutputTokens` 与本模型无关（`longcat-flash` 按 family 命中 `longcat-2.0-free` 会报 1,000,000，
 * 真实只有 128K–256K → 撑爆上游），4.13.55 起返回的副本里这两项为 undefined，上层走下一来源或标「未知」。
 * 因此：`lookupCapability(id)?.contextWindow` 有值 ⟺ 目录里有该模型自己的条目。
 */
export function lookupCapability(modelId: string): ModelCapability | undefined {
  const full = fullModelKey(modelId);
  if (full) {
    const byFull = state.byId.get("full:" + full);
    if (byFull) {
      return byFull;
    }
  }
  const key = normalizeModelId(modelId);
  if (!key) {
    return undefined;
  }
  const exact = state.byId.get(key);
  if (exact) {
    return exact;
  }
  // family 兜底：取规范化 id 的第一段（deepseek-v4-pro → deepseek）
  const head = key.split("-")[0];
  const fam = state.byId.get("family:" + head);
  if (!fam) {
    return undefined;
  }
  return { ...fam, contextWindow: undefined, maxOutputTokens: undefined };
}

/** 目录是否已就绪（有数据）。 */
export function catalogReady(): boolean {
  return state.byId.size > 0;
}

/** 测试/诊断用。 */
export function catalogSize(): number {
  return [...new Set(state.byId.values())].length;
}

export function resetCatalogForTest(caps: ModelCapability[], providers: CatalogProvider[] = []): void {
  const map = new Map<string, ModelCapability>();
  for (const cap of caps) {
    map.set(normalizeModelId(cap.id), cap);
    if (cap.family) {
      map.set("family:" + normalizeModelId(cap.family), cap);
    }
  }
  state = { byId: map, providers: new Map(providers.map((p) => [p.id, p])), fetchedAt: Date.now() };
}

/** 测试用：直接喂一份 models.dev 形态的 JSON。 */
export function loadCatalogJsonForTest(json: unknown): void {
  const { byId, providers } = parseCatalog(json);
  state = { byId, providers, fetchedAt: Date.now() };
}
