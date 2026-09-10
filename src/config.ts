import * as vscode from "vscode";

export const CONFIG_NS = "api2kiroDual";

/** 上游通道：Anthropic /v1/messages 或 OpenAI /v1/chat/completions。 */
export type Channel = "anthropic" | "openai";

/** 双协议路由策略。 */
export type RoutingMode = "merge" | "anthropicOnly" | "openaiOnly";

let extCtx: vscode.ExtensionContext | undefined;

/** 由 activate 调用,注入扩展上下文,启用「settings.json 写入失败时」的本地兜底存储。 */
export function initConfig(context: vscode.ExtensionContext): void {
  extCtx = context;
}

/** 本扩展版本号。代理身份握手用它判断谁该让出端口，见 proxyIdentity.ts。 */
export function getExtensionVersion(): string {
  const v = extCtx?.extension?.packageJSON?.version;
  return typeof v === "string" ? v : "0.0.0";
}

export function cfg() {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}

const FB_PREFIX = "fallback.";

/**
 * 读字符串配置:本地兜底若存在(说明之前写 settings.json 失败,兜底为用户最新意图)优先,
 * 否则读 VS Code 设置。空字符串也算有效兜底值(用于「清除 Key」)。
 */
function readStr(key: string): string {
  const fb = extCtx?.globalState.get<string>(FB_PREFIX + key);
  if (fb !== undefined) {
    return String(fb).trim();
  }
  return (cfg().get<string>(key, "") || "").trim();
}

function readBool(key: string, def: boolean): boolean {
  const fb = extCtx?.globalState.get<boolean>(FB_PREFIX + key);
  if (typeof fb === "boolean") {
    return fb;
  }
  return cfg().get<boolean>(key, def);
}

/** `inspect()` 的分层视图里本函数用到的几层（真实 API 还有 profile / remote / language 层，这里不需要）。 */
interface LayeredValue {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * 读「只在用户设置生效」的数组配置（含凭据 / 端点的 providers）：工作区 / 工作区文件夹层若有值一律忽略，
 * 只取用户级（Global）值，没有则取默认值。
 *
 * package.json 已把这些项声明为 `scope: machine`，工作台解析工作区文件时本就跳过它们（Kiro 1.0.437
 * `dq=[4,5,6,7]` 不含 MACHINE）；这里是纵深防御——旧版工作台或任何把工作区值送达扩展的路径都不会让
 * 仓库里的 `.vscode/settings.json` 决定凭据发往哪里。`inspect` 不可用（桩 / 异常）时退回合并读取，
 * 与改动前逐字相同。返回 `shadowed` 让调用方决定是否记一条日志（本模块不引入 log，避免 config ↔ log 环）。
 */
export function readUserLevelArray(key: string): { value: unknown[]; shadowed: boolean } {
  const c = cfg();
  const merged = c.get<unknown[]>(key, []);
  const mergedArr = Array.isArray(merged) ? merged : [];
  let insp: LayeredValue | undefined;
  try {
    insp = typeof c.inspect === "function" ? (c.inspect<unknown>(key) as LayeredValue | undefined) : undefined;
  } catch {
    insp = undefined;
  }
  if (!insp) {
    return { value: mergedArr, shadowed: false };
  }
  const shadowed = insp.workspaceValue !== undefined || insp.workspaceFolderValue !== undefined;
  if (!shadowed) {
    return { value: mergedArr, shadowed: false };
  }
  const own = insp.globalValue !== undefined ? insp.globalValue : insp.defaultValue;
  return { value: Array.isArray(own) ? own : [], shadowed: true };
}

/**
 * 写入配置:优先写 VS Code 全局设置(端点重定向等依赖它);写入抛错
 * (settings.json 不可写/损坏/受限模式)时退回插件本地存储(globalState)兜底,
 * 保证面板配置至少能持久化。返回 { settingsOk, error } 让调用方据此提示真实原因。
 */
export async function updateSetting(
  key: string,
  value: unknown
): Promise<{ settingsOk: boolean; error?: string }> {
  const setFallback = async () => {
    if (extCtx) {
      await extCtx.globalState.update(FB_PREFIX + key, value);
    }
  };
  const clearFallback = async () => {
    if (extCtx && extCtx.globalState.get(FB_PREFIX + key) !== undefined) {
      await extCtx.globalState.update(FB_PREFIX + key, undefined);
    }
  };

  try {
    await cfg().update(key, value, vscode.ConfigurationTarget.Global);
    // 关键:update() 不抛异常 ≠ 真的写进去了。实测某些环境(工作区作用域遮蔽、
    // profile / Settings Sync、或 Kiro 未持久化)会 resolve 成功却不落地,导致「假成功」。
    // 因此写完立刻回读校验:一致才算成功;不一致则退回本地兜底(readStr 优先读兜底,
    // 保证用户填的值仍能持久化),并如实报告原因。
    const readback = cfg().get(key);
    if (JSON.stringify(readback) === JSON.stringify(value)) {
      await clearFallback();
      return { settingsOk: true };
    }
    await setFallback();
    return {
      settingsOk: false,
      error: "写入后回读不一致(可能被工作区 .vscode/settings.json 遮蔽,或 Kiro 未持久化该设置)",
    };
  } catch (e) {
    await setFallback();
    return { settingsOk: false, error: (e as Error)?.message || String(e) };
  }
}

const CTX_OVERRIDES_KEY = "contextWindowOverrides";

/**
 * 上下文窗口用户覆盖（4.13.55，R24）：Kiro 选择器里的模型 id → tokens。只取用户级值（`scope: machine`），
 * 写入失败退回 globalState 兜底（与其它设置同一套 updateSetting）。非法值（非正整数 / 越界）在读取时丢弃。
 */
export function getContextWindowOverrides(): Record<string, number> {
  const fb = extCtx?.globalState.get<Record<string, unknown>>(FB_PREFIX + CTX_OVERRIDES_KEY);
  const raw = fb && typeof fb === "object" ? fb : cfg().get<Record<string, unknown>>(CTX_OVERRIDES_KEY, {});
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      if (k && Number.isFinite(n) && n >= 4096 && n <= 10_000_000) {
        out[k] = Math.floor(n);
      }
    }
  }
  return out;
}

export function getContextWindowOverride(modelId: string): number | undefined {
  return getContextWindowOverrides()[modelId];
}

/** tokens 为 undefined / null / 0 = 清除该模型的覆盖（回到自动）。返回值同 updateSetting。 */
export async function setContextWindowOverride(modelId: string, tokens: number | null | undefined): Promise<{ settingsOk: boolean; error?: string }> {
  const id = String(modelId || "").trim();
  if (!id) {
    return { settingsOk: false, error: "empty model id" };
  }
  const next: Record<string, number> = { ...getContextWindowOverrides() };
  if (tokens && Number.isFinite(tokens) && tokens > 0) {
    next[id] = Math.floor(tokens);
  } else {
    delete next[id];
  }
  return updateSetting(CTX_OVERRIDES_KEY, next);
}

/** 清除全部上下文覆盖（设置页「全部重置为自动」）。返回值同 updateSetting。 */
export async function clearContextWindowOverrides(): Promise<{ settingsOk: boolean; error?: string }> {
  return updateSetting(CTX_OVERRIDES_KEY, {});
}

/**
 * 是否启用代理。
 *
 * 注意默认值是 false（原版是 true）：本扩展与原版 API2Kiro 共用
 * codewhisperer.config.*Endpoints 这一组全局设置，同一时间只能有一个把 Kiro 的
 * 端点指向自己。默认关闭可避免装上就抢走原版的端点配置。
 */
export function isEnabled(): boolean {
  return readBool("enabled", false);
}

// ============================ 路由 ============================

/** 双协议路由策略。 */
export function getRouting(): RoutingMode {
  const fb = extCtx?.globalState.get<string>(FB_PREFIX + "routing");
  const raw = (fb !== undefined ? fb : cfg().get<string>("routing", "merge")) || "merge";
  return raw === "anthropicOnly" || raw === "openaiOnly" ? raw : "merge";
}

/** OpenAI 通道是否启用（开关 + 地址 + Key 三者齐备才算可用）。 */
export function isOpenaiEnabled(): boolean {
  if (getRouting() === "anthropicOnly") {
    return false;
  }
  if (getRouting() === "openaiOnly") {
    return true;
  }
  return readBool("openaiEnabled", false);
}

/** OpenAI 通道是否已配置完整（可发请求）。 */
export function isOpenaiUsable(): boolean {
  return isOpenaiEnabled() && !!getOpenaiBaseUrl() && !!getOpenaiApiKey();
}

/** Anthropic 通道是否启用。 */
export function isAnthropicEnabled(): boolean {
  return getRouting() !== "openaiOnly";
}

/** Anthropic 通道是否已配置完整（可发请求）。 */
export function isAnthropicUsable(): boolean {
  return isAnthropicEnabled() && !!getBaseUrl() && !!getApiKey();
}

/** 当前是否处于「两个通道同时生效」的状态。 */
export function isDualActive(): boolean {
  return getRouting() === "merge" && isAnthropicUsable() && isOpenaiUsable();
}

// ==================== Anthropic 通道 ====================

/** Anthropic 通道的子模式：kiro=深度兼容(kiro2cc-proxy)；anthropic=官方直通。 */
export function getRelayMode(): "kiro" | "anthropic" {
  const fb = extCtx?.globalState.get<string>(FB_PREFIX + "mode");
  const raw = (fb !== undefined ? fb : cfg().get<string>("mode", "kiro")) || "kiro";
  return raw === "anthropic" ? "anthropic" : "kiro";
}

/** 深度兼容模式的中转站 Key。 */
export function getKiroApiKey(): string {
  return readStr("apiKey");
}

/** 官方 Anthropic 模式的 Key。 */
export function getOfficialApiKey(): string {
  return readStr("officialApiKey");
}

/** Anthropic 通道当前生效的 Key（按子模式）。 */
export function getApiKey(): string {
  return getRelayMode() === "anthropic" ? getOfficialApiKey() : getKiroApiKey();
}

/** 深度兼容模式的中转站地址（Anthropic 格式）。 */
export function getKiroBaseUrl(): string {
  return normalizeUrl(readStr("baseUrl"));
}

/**
 * 官方 Anthropic 模式地址。留空即返回 ""（fail-closed）。
 *
 * 本地改动（沿用原版的安全修复）：上游原本在此处回落到作者的公网地址
 * https://ai.sunnorthgod.top:2053。那意味着 mode=anthropic 且 officialBaseUrl
 * 留空时，prompt、代码上下文与 API Key 会静默发往第三方主机。这里去掉该回落：
 * 没配地址就返回空串，krsServer 会显示“尚未配置”提示而不是发出请求。
 */
export function getOfficialBaseUrl(): string {
  return normalizeUrl(readStr("officialBaseUrl"));
}

/** Anthropic 通道当前生效的地址（按子模式）。 */
export function getBaseUrl(): string {
  return getRelayMode() === "anthropic" ? getOfficialBaseUrl() : getKiroBaseUrl();
}

// ====================== OpenAI 通道 ======================

/** OpenAI 通道地址。留空返回 ""（fail-closed，与 Anthropic 侧同一原则）。 */
export function getOpenaiBaseUrl(): string {
  return normalizeUrl(readStr("openaiBaseUrl"));
}

export function getOpenaiApiKey(): string {
  return readStr("openaiApiKey");
}

export function getOpenaiModelMapping(): Record<string, string> {
  return cfg().get<Record<string, string>>("openaiModelMapping", {}) || {};
}

export function getOpenaiDefaultModel(): string {
  return (cfg().get<string>("openaiDefaultModel", "") || "").trim();
}

/** OpenAI 通道用哪个字段限制输出长度。 */
export function getOpenaiMaxTokensField(): "max_tokens" | "max_completion_tokens" | "both" | "none" {
  const v = (cfg().get<string>("openaiMaxTokensField", "max_tokens") || "max_tokens").trim();
  if (v === "max_completion_tokens" || v === "both" || v === "none") {
    return v;
  }
  return "max_tokens";
}

/** OpenAI 通道的 reasoning_effort 策略。 */
export function getOpenaiReasoningEffort(): "auto" | "off" | "low" | "medium" | "high" {
  const v = (cfg().get<string>("openaiReasoningEffort", "auto") || "auto").trim().toLowerCase();
  if (v === "off" || v === "low" || v === "medium" || v === "high") {
    return v;
  }
  return "auto";
}

/** OpenAI 通道是否把上一轮思考（reasoning_content）随历史回传（见 thinkingPolicy.ts）。 */
export function getOpenaiReasoningEcho(): "auto" | "off" | "always" {
  const v = (cfg().get<string>("openaiReasoningEcho", "auto") || "auto").trim().toLowerCase();
  if (v === "off" || v === "always") {
    return v;
  }
  return "auto";
}

export type ThoughtDedupeMode = "off" | "exact" | "aggressive";

/** OpenAI 通道：思考通道里其实是一份回答时怎么去重（见 openaiStream.ts 的 thoughtGate）。 */
export function getOpenaiThoughtDedupe(): ThoughtDedupeMode {
  const v = (cfg().get<string>("openaiThoughtDedupe", "exact") || "exact").trim().toLowerCase();
  if (v === "off" || v === "aggressive") {
    return v;
  }
  return "exact";
}

// ==================== 通道无关的通用配置 ====================

export function getPort(): number {
  return cfg().get<number>("port", 19810) || 19810;
}

export function getCpsPort(): number {
  return cfg().get<number>("cpsPort", 19811) || 19811;
}

export function getMaxTokens(): number {
  return cfg().get<number>("maxTokens", 32000) || 32000;
}

export function isDebug(): boolean {
  return cfg().get<boolean>("debug", false);
}

export function getInterceptIntentClassifier(): boolean {
  return cfg().get<boolean>("interceptIntentClassifier", true);
}

/**
 * Kiro 模型选择器里多渠道模型怎么摆：
 *  - grouped：按渠道分组，每组前插一条小号淡色的渠道名标题行，模型名保持原样（默认）；
 *  - suffix：不分组，模型名后缀「(渠道名)」；
 *  - plain：不分组也不后缀，只有模型名。
 * 只有一个渠道时三种都退化成纯模型名。
 */
export type ModelListStyle = "grouped" | "suffix" | "plain";
export function getModelListStyle(): ModelListStyle {
  const v = cfg().get<string>("modelListStyle", "grouped");
  return v === "suffix" || v === "plain" ? v : "grouped";
}

/** 是否给选择器里的渠道分组标题行注入填充 + 光晕样式（写 Kiro 的 style.css，见 selectorStyle.ts）。 */
export function getGroupHeaderStyle(): boolean {
  return cfg().get<boolean>("groupHeaderStyle", true);
}

/**
 * 是否在每轮回答的页脚（Elapsed time 那一行）标注本轮消耗的 token。
 *
 * 原理：Kiro 的 PromptTurnFooter 渲染 `_meta.kiro.promptTurnSummaries`，每项形如
 * `{unit, unitPlural, usage}`，标签由 unitPlural 现拼成「Est. <UnitPlural> Used: n」。
 * 喂它的是二进制事件流里的 `meteringEvent` 帧（kiro-agent 侧 `case "metering"`，
 * 那道 isUsageEnabled 门在 converse 路径上硬编码为 true，不依赖真实订阅配额）。
 * 官方直连时这里放的是 credit；我们没有 credit 口径，就放 token。两个协议通道
 * 都会在流末补发（OpenAI 侧从 usage.{prompt,completion}_tokens 取数）。
 */
export function getShowTokenUsage(): boolean {
  return cfg().get<boolean>("showTokenUsage", true);
}

/** 是否启用「上游流中断自动重试」（流断且尚未向客户端吐出任何内容时透明重发）。 */
export function getAutoRetry(): boolean {
  return readBool("autoRetry", true);
}

/** 自动重试的最大重试次数（不含首次尝试），钳制在 0..5。 */
export function getMaxRetries(): number {
  const fb = extCtx?.globalState.get<number>(FB_PREFIX + "maxRetries");
  const raw = typeof fb === "number" ? fb : cfg().get<number>("maxRetries", 2);
  return Math.max(0, Math.min(5, Math.floor(raw || 0)));
}

/** Anthropic 通道的模型映射（按子模式取不同键）。 */
export function getModelMapping(): Record<string, string> {
  const key = getRelayMode() === "anthropic" ? "officialModelMapping" : "modelMapping";
  return cfg().get<Record<string, string>>(key, {}) || {};
}

/** Anthropic 通道的兜底模型（按子模式取不同键）。 */
export function getDefaultModel(): string {
  const key = getRelayMode() === "anthropic" ? "officialDefaultModel" : "defaultModel";
  return (cfg().get<string>(key, "") || "").trim();
}

export function getUsagePath(): string {
  return (cfg().get<string>("usagePath", "") || "").trim();
}

export interface ThinkingConfig {
  // "enabled"：固定预算思考（budget_tokens，仅 thinkingBudget 模式用）；"disabled"：关闭。
  // 注：默认 auto 模式不发 thinking，只透传 Kiro 原生 output_config.effort。
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export function getThinkingConfig(): ThinkingConfig | undefined {
  const c = cfg();
  const mode = c.get<string>("thinking", "auto");
  if (mode === "disabled") {
    return { type: "disabled" };
  }
  if (mode === "enabled") {
    return { type: "enabled", budget_tokens: c.get<number>("thinkingBudget", 8192) };
  }
  return undefined; // auto
}

export function getThinkingBudget(): number {
  return cfg().get<number>("thinkingBudget", 8192) || 8192;
}

/**
 * 用户覆盖的 reasoning 思考模式（GPT 5.6：standard / pro）。
 * - "auto"（默认）：不强制，透传 Kiro 请求里的 mode（若有），否则用上游默认。
 * - "standard" / "pro"：强制该模式。仅对 reasoning 模型生效。
 * 返回 undefined 表示 auto（不覆盖）。
 */
export function getReasoningModeOverride(): string | undefined {
  const v = (cfg().get<string>("reasoningMode", "auto") || "auto").trim().toLowerCase();
  return v === "standard" || v === "pro" ? v : undefined;
}

/**
 * Normalize a configured base URL.
 * Accepts forms like:
 *   https://host            -> https://host
 *   https://host/v1         -> https://host/v1
 *   https://host:8443/v1/   -> https://host:8443/v1
 * Returns "" when not configured.
 */
export function normalizeUrl(raw: string): string {
  if (!raw) {
    return "";
  }
  let r = raw;
  if (!/^https?:\/\//i.test(r)) {
    r = "https://" + r;
  }
  return r.replace(/\/+$/, "");
}

/** Base URL of a specific channel. */
export function baseUrlFor(channel: Channel): string {
  return channel === "openai" ? getOpenaiBaseUrl() : getBaseUrl();
}

/** API key of a specific channel. */
export function apiKeyFor(channel: Channel): string {
  return channel === "openai" ? getOpenaiApiKey() : getApiKey();
}

/**
 * Resolve a full URL for a relative API path against a channel's base URL.
 * Both protocols are versioned the same way (`/v1/...`), so the /v1 insertion
 * rule is shared: append the path directly when the base already ends in /vN,
 * otherwise insert /v1.
 */
export function resolveApiUrlFor(channel: Channel, apiPath: string): string {
  const base = baseUrlFor(channel);
  if (!base) {
    return "";
  }
  const p = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  if (/\/v\d+$/i.test(base)) {
    return base + p;
  }
  return base + "/v1" + p;
}

/** Anthropic-channel convenience wrapper (kept for existing call sites). */
export function resolveApiUrl(apiPath: string): string {
  return resolveApiUrlFor("anthropic", apiPath);
}

/**
 * Resolve a URL relative to a channel's ROOT (strips any trailing /vN). Used for
 * usage/dashboard endpoints that may or may not sit under /v1.
 */
export function resolveRootUrlFor(channel: Channel, path: string): string {
  const base = baseUrlFor(channel);
  if (!base) {
    return "";
  }
  const root = base.replace(/\/v\d+$/i, "");
  const p = path.startsWith("/") ? path : "/" + path;
  return root + p;
}

export function resolveRootUrl(path: string): string {
  return resolveRootUrlFor("anthropic", path);
}
