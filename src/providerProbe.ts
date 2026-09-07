/**
 * Provider 探测：连接表单 / 设置弹窗里的「测延迟」「拉取模型」「测活」。
 *
 * 全部针对一份**草稿**（ProviderDraft：还没保存的表单内容，或已保存 provider 的当前值）
 * 工作，不读注册表也不写缓存，用户填一半就能试，试完不满意直接改。
 *
 * - measureLatency：GET /models，从发出到收到响应头的毫秒数。/models 不存在（404/405）时
 *   仍算"通了"（HTTP 层可达，只是没这个接口），给出状态让 UI 提示；连接失败 / 超时才算不通。
 * - probeModels：拉模型清单（与 modelStore 同一套解析：data[] / models[] / 裸数组）。
 * - testModel：给模型发一条最小请求（"hi"，限长 16），非流式，看能否 2xx 且解出正文。
 *   三种格式的请求体与端点各不相同：
 *     anthropic  POST /messages          {model, max_tokens, messages}
 *     chat       POST /chat/completions  {model, messages, max_tokens}；上游拒 max_tokens 时换 max_completion_tokens 重试一次
 *     responses  POST /responses         {model, input, max_output_tokens, store:false}
 *   推理模型限长 16 可能只够思考不够正文（Responses 会给 status=incomplete、正文为空），
 *   这种情况仍判为「活」：目的是验证 key / 地址 / 模型名可用，不是评估输出。
 * - testModels：批量测活，限并发（默认 3），逐个回调进度，可取消。
 */

import { ApiFormat, PRIMARY_CREDENTIAL_ID, ProviderConfig, authHeaders, catalogProviderFor, fieldsForFormat, getPreset, isOAuthProvider, resolveApiUrl, tokenKeyOf } from "./providers";
import { lookupCapability } from "./modelCatalog";
import * as crypto from "crypto";
import { requestUpstream, readBody } from "./upstream";
import { EventStreamDecoder } from "./eventstream";
import { debug } from "./log";
import { getVendor } from "./oauth/vendors";
import { ensureAccessToken, vendorModelsFor } from "./oauth";
import { getToken } from "./oauth/tokenStore";
import { GeminiRequest, antigravityEnvelope, geminiFamilyOf } from "./geminiTranslate";
import { modelEntryId } from "./modelStore";

export interface ProviderDraft {
  name?: string;
  baseUrl: string;
  apiKey: string;
  format: ApiFormat;
  /** anthropic 格式下的子模式（kiro=中转深度兼容 / official=官方直通）；探测请求不区分。 */
  anthropicMode?: "kiro" | "official";
  /**
   * 登录类 provider：厂商 id + 已保存的 provider id（token 按它取）。此时 apiKey 忽略，
   * 请求头由厂商规则给，模型清单以内置目录为底。
   */
  oauthVendor?: string;
  providerId?: string;
  /**
   * 探测 key 池里的哪一把（c1 / c2 …）。key 类：由调用方把那把的 key 填进 apiKey，这里只用来回报；
   * OAuth 类：token 按 tokenKeyOf(providerId, credentialId) 取。缺省首条。
   */
  credentialId?: string;
  /** 来自哪个预设（md:xxx / 内置 id）：/models 拉不到时用 models.dev 登记的清单。 */
  presetId?: string;
}

export interface LatencyResult {
  ok: boolean;
  /** 到响应头的毫秒；连接失败为 -1。 */
  ms: number;
  status: number;
  /** /models 不存在但 HTTP 可达等提示。 */
  note?: string;
  error?: string;
}

export interface ModelProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  status: number;
  ms: number;
  error?: string;
}

export interface ModelTestResult {
  modelId: string;
  ok: boolean;
  status: number;
  ms: number;
  /** 正文前几十个字，UI 上做「活」的直观证据。 */
  sample?: string;
  error?: string;
}

const PROBE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 45_000;

/**
 * 草稿 → 一份临时 ProviderConfig，给 resolveApiUrl / authHeaders 复用。
 * 只带一把凭证（草稿指定的那把），所以下面 authHeaders(p) 取首条就是它。
 */
export function draftToProvider(d: ProviderDraft): ProviderConfig {
  const f = fieldsForFormat(d.format);
  const oauth = !!d.oauthVendor;
  const spec = oauth ? getVendor(d.oauthVendor) : undefined;
  const credId = d.credentialId || PRIMARY_CREDENTIAL_ID;
  const apiKey = oauth ? "" : String(d.apiKey || "").trim();
  return {
    // 登录类必须用真实 provider id，token 是按它存的。
    id: oauth && d.providerId ? d.providerId : "__probe__",
    name: d.name || "probe",
    protocol: f.protocol,
    openaiApi: f.openaiApi,
    anthropicMode: f.protocol === "anthropic" ? d.anthropicMode || "kiro" : undefined,
    // 登录类地址由厂商定；草稿没带就用厂商的。
    baseUrl: String(d.baseUrl || (spec ? spec.baseUrl : "") || "").trim().replace(/\/+$/, ""),
    apiKey,
    // 显式带上凭证 id：OAuth 类据此从 tokenStore 取 providerId/cN 的 token
    credentials: [{ id: credId, apiKey: apiKey || undefined, priority: 0, enabled: true }],
    enabled: true,
    auth: oauth ? "oauth" : undefined,
    oauthVendor: oauth ? d.oauthVendor : undefined,
    presetId: d.presetId || undefined,
    // 预设地址是精确前缀（models.dev 的 api）；手填地址走启发式
    exactBase: d.presetId ? getPreset(d.presetId)?.exactBase : undefined,
  };
}

/** 探测用请求头：登录类先把 token 刷新鲜（刷不了就抛，UI 显示"请重新登录"）。 */
async function probeHeaders(p: ProviderConfig): Promise<Record<string, string>> {
  if (isOAuthProvider(p)) {
    await ensureAccessToken(p);
  }
  return { ...authHeaders(p), Accept: "application/json" };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  // 定时器随结果一起清掉：否则每次测活都留一个 45s 的活定时器
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

function shortErr(e: unknown): string {
  const m = (e as Error)?.message || String(e);
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
}

/** 从上游错误体里抠出人能看的一句话。 */
function extractErrorMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const err = (j.error ?? j) as Record<string, unknown>;
    const msg = err && typeof err === "object" ? err.message ?? err.msg ?? err.detail : undefined;
    if (typeof msg === "string" && msg) {
      return `HTTP ${status}: ${msg.slice(0, 200)}`;
    }
  } catch {
    /* 非 JSON */
  }
  const t = text.replace(/\s+/g, " ").trim();
  return `HTTP ${status}${t ? ": " + t.slice(0, 160) : ""}`;
}

/** 厂商自带在线清单（Kiro 官方 ListAvailableModels）时，测延迟 / 拉模型都走它，不再猜 /models 路径。 */
async function vendorLiveModels(p: ProviderConfig): Promise<{ models: Array<{ id: string; name: string }>; ms: number } | undefined> {
  const spec = isOAuthProvider(p) ? getVendor(p.oauthVendor) : undefined;
  if (!spec?.listModels) {
    return undefined;
  }
  const started = Date.now();
  const tok = await ensureAccessToken(p);
  const live = await withTimeout(spec.listModels(tok), PROBE_TIMEOUT_MS, "拉取模型");
  return { models: live.map((m) => ({ id: m.id, name: m.name || m.id })), ms: Date.now() - started };
}

function statusFromError(e: unknown): number {
  const m = /HTTP (\d{3})/.exec((e as Error)?.message || "");
  return m ? Number(m[1]) : 0;
}

export async function measureLatency(d: ProviderDraft): Promise<LatencyResult> {
  const p = draftToProvider(d);
  const spec = isOAuthProvider(p) ? getVendor(p.oauthVendor) : undefined;
  if (spec?.listModels) {
    const started = Date.now();
    try {
      const r = await vendorLiveModels(p);
      return { ok: true, ms: r ? r.ms : Date.now() - started, status: 200 };
    } catch (e) {
      const status = statusFromError(e);
      return {
        ok: false,
        ms: Date.now() - started,
        status,
        error: shortErr(e),
        note: status === 401 || status === 403 ? "鉴权失败：登录可能已失效，请在 Kiro 里重新登录后再导入" : undefined,
      };
    }
  }
  const url = resolveApiUrl(p, spec?.latencyPath || "/models");
  if (!url) {
    return { ok: false, ms: -1, status: 0, error: "地址为空" };
  }
  const started = Date.now();
  try {
    const headers = await probeHeaders(p);
    const res = await withTimeout(requestUpstream("GET", url, headers, undefined, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS, "连接");
    const ms = Date.now() - started;
    // 只关心可达性与鉴权，正文读掉即丢。
    const text = await readBody(res.body).catch(() => "");
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, ms, status: res.statusCode };
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      return {
        ok: false,
        ms,
        status: res.statusCode,
        error: extractErrorMessage(text, res.statusCode),
        note: isOAuthProvider(p) ? "鉴权失败：登录可能已失效，请重新登录" : "鉴权失败：Key 不对或无权限",
      };
    }
    if (res.statusCode === 404 || res.statusCode === 405 || res.statusCode === 400 || res.statusCode === 422) {
      // 测延迟只关心"通不通"：没有 /models 或它要别的参数，都算通，只是拉不到清单
      return { ok: true, ms, status: res.statusCode, note: `可达，但 /models 不可用（HTTP ${res.statusCode}）；模型清单走内置/目录` };
    }
    return { ok: false, ms, status: res.statusCode, error: extractErrorMessage(text, res.statusCode) };
  } catch (e) {
    return { ok: false, ms: -1, status: 0, error: shortErr(e) };
  }
}

export async function probeModels(d: ProviderDraft): Promise<ModelProbeResult> {
  const p = draftToProvider(d);
  const url = resolveApiUrl(p, "/models");
  if (!url) {
    return { ok: false, models: [], status: 0, ms: -1, error: "地址为空" };
  }
  const started = Date.now();
  // 登录类：内置目录为底，厂商声明可试 /models 的再拉一次合并，拉不到也算成功（目录在）。
  const spec = isOAuthProvider(p) ? getVendor(p.oauthVendor) : undefined;
  if (spec) {
    const models = vendorModelsFor(p).map((m) => ({ id: m.id, name: m.name || m.id }));
    if (spec.listModels) {
      try {
        const r = await vendorLiveModels(p);
        if (r && r.models.length) {
          return { ok: true, models: r.models, status: 200, ms: r.ms };
        }
      } catch (e) {
        const status = statusFromError(e);
        if (status === 401 || status === 403) {
          return { ok: false, models: [], status, ms: Date.now() - started, error: shortErr(e) };
        }
        debug("probe: vendor listModels failed, builtin catalog", shortErr(e));
      }
      return { ok: true, models, status: 200, ms: Date.now() - started, error: "官方清单拉取失败，已用内置目录" };
    }
    if (!spec.tryModelsEndpoint) {
      return { ok: true, models, status: 200, ms: 0 };
    }
    try {
      const headers = await probeHeaders(p);
      const res = await withTimeout(requestUpstream("GET", url, headers, undefined, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS, "拉取模型");
      const text = await readBody(res.body);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const seen = new Set(models.map((m) => m.id.toLowerCase()));
        for (const m of parseModelList(text)) {
          if (!seen.has(m.id.toLowerCase())) {
            seen.add(m.id.toLowerCase());
            models.push(m);
          }
        }
      }
      return { ok: true, models, status: res.statusCode, ms: Date.now() - started };
    } catch (e) {
      debug("probe: oauth /models skipped", shortErr(e));
      return { ok: true, models, status: 0, ms: Date.now() - started };
    }
  }
  // 预设 provider：models.dev 登记的清单做兜底（上游没有 /models、拉失败、或拉到空）
  const fallback = () => {
    const cp = catalogProviderFor(p);
    return cp ? cp.models.map((id) => ({ id, name: lookupCapability(id)?.name || id })).sort((a, b) => a.id.localeCompare(b.id)) : [];
  };
  try {
    const headers = await probeHeaders(p);
    const res = await withTimeout(requestUpstream("GET", url, headers, undefined, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS, "拉取模型");
    const text = await readBody(res.body);
    const ms = Date.now() - started;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // 鉴权类错误如实报（Key 不对不该被目录掩盖）；404/405 一类"没这个接口"才用目录顶上
      const fb = res.statusCode === 401 || res.statusCode === 403 ? [] : fallback();
      if (fb.length) {
        return { ok: true, models: fb, status: res.statusCode, ms, error: `上游 /models 不可用（HTTP ${res.statusCode}），已用 models.dev 登记的清单` };
      }
      return { ok: false, models: [], status: res.statusCode, ms, error: extractErrorMessage(text, res.statusCode) };
    }
    try {
      JSON.parse(text);
    } catch {
      const fb = fallback();
      return fb.length
        ? { ok: true, models: fb, status: res.statusCode, ms, error: "上游 /models 响应不是 JSON，已用 models.dev 登记的清单" }
        : { ok: false, models: [], status: res.statusCode, ms, error: "响应不是 JSON" };
    }
    let models = parseModelList(text);
    if (!models.length) {
      models = fallback();
    }
    return { ok: true, models, status: res.statusCode, ms };
  } catch (e) {
    const fb = fallback();
    if (fb.length) {
      return { ok: true, models: fb, status: 0, ms: Date.now() - started, error: `上游 /models 连不上（${shortErr(e)}），已用 models.dev 登记的清单` };
    }
    return { ok: false, models: [], status: 0, ms: Date.now() - started, error: shortErr(e) };
  }
}

/** /models 回包 → 去重排序的 {id,name}[]（data[] / models[] / 裸数组）。 */
function parseModelList(text: string): Array<{ id: string; name: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const r = raw as { data?: unknown[]; models?: unknown[] };
  const arr: unknown[] = Array.isArray(r?.data) ? r.data : Array.isArray(r?.models) ? r.models : Array.isArray(raw) ? (raw as unknown[]) : [];
  const seen = new Set<string>();
  const models: Array<{ id: string; name: string }> = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") {
      continue;
    }
    const o = x as Record<string, unknown>;
    const id = modelEntryId(o).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const rawName = typeof o.name === "string" && !o.name.startsWith("models/") ? o.name : undefined;
    models.push({ id, name: String(o.display_name || o.displayName || rawName || o.modelName || id) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** 三种格式的最小请求体。 */
function testBody(format: ApiFormat, model: string, variant: "primary" | "alt"): { path: string; body: Record<string, unknown> } {
  if (format === "anthropic") {
    return {
      path: "/messages",
      body: { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: false },
    };
  }
  if (format === "responses") {
    // input 用 item 列表而不是裸字符串：官方两种都收，Codex 后端只收列表（"Input must be a list"）
    return {
      path: "/responses",
      body: {
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 16,
        stream: false,
        store: false,
      },
    };
  }
  if (format === "gemini") {
    return {
      path: `/models/${encodeURIComponent(model)}:generateContent`,
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 16 } },
    };
  }
  // chat：reasoning 系列（o1/gpt-5…）拒绝 max_tokens，要 max_completion_tokens；先发常见的，被拒再换。
  return {
    path: "/chat/completions",
    body:
      variant === "primary"
        ? { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false }
        : { model, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 16, stream: false },
  };
}

/** 从三种格式的非流式回包里抠出正文样本；解不出也不算失败（推理模型限长内可能没正文）。 */
function extractSample(format: ApiFormat, text: string): string | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (format === "anthropic") {
      const content = j.content as Array<{ type?: string; text?: string }> | undefined;
      const t = (content || []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
      return t || undefined;
    }
    if (format === "gemini") {
      const root = (j.response && typeof j.response === "object" ? j.response : j) as Record<string, unknown>;
      const cands = root.candidates as Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> | undefined;
      const t = (cands?.[0]?.content?.parts || [])
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      return t || undefined;
    }
    if (format === "responses") {
      if (typeof j.output_text === "string" && j.output_text) {
        return j.output_text;
      }
      const output = j.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined;
      const t = (output || [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content || [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      return t || undefined;
    }
    const choices = j.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const c = choices?.[0]?.message?.content;
    if (typeof c === "string") {
      return c || undefined;
    }
    if (Array.isArray(c)) {
      const t = c.map((p) => (p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
      return t || undefined;
    }
  } catch {
    /* 非 JSON：可能是网关无视 stream:false 回了 SSE，下面按 SSE 粗略抠 */
    const m = text.match(/"(?:text|content|delta)"\s*:\s*"([^"\\]{1,80})/);
    return m ? m[1] : undefined;
  }
  return undefined;
}

function readBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Kiro 官方的测活：发一条最小的 CodeWhisperer 请求（"hi"）到 Kiro 自己的流式端点，回包是
 * event-stream 二进制帧——解出 assistantResponseEvent 的正文当样本；exception 帧 / 非 2xx 算失败。
 */
async function testKiroModel(p: ProviderConfig, d: ProviderDraft, model: string, started: number): Promise<ModelTestResult> {
  const spec = getVendor(p.oauthVendor);
  const tok = await ensureAccessToken(p);
  const base = spec?.apiBaseFor ? spec.apiBaseFor(tok) : p.baseUrl;
  const body: Record<string, unknown> = {
    conversationState: {
      conversationId: crypto.randomUUID(),
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "hi", modelId: model, origin: "AI_EDITOR" } },
    },
  };
  if (tok.extra?.profileArn) {
    body.profileArn = tok.extra.profileArn;
  }
  const headers = { ...authHeaders(p), "Content-Type": "application/json" };
  const res = await withTimeout(
    requestUpstream("POST", base.replace(/\/+$/, "") + "/generateAssistantResponse", headers, JSON.stringify(body), TEST_TIMEOUT_MS),
    TEST_TIMEOUT_MS,
    "测活"
  );
  const buf = await readBuffer(res.body).catch(() => Buffer.alloc(0));
  const ms = Date.now() - started;
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { modelId: model, ok: false, status: res.statusCode, ms, error: extractErrorMessage(buf.toString("utf8"), res.statusCode) };
  }
  let sample = "";
  let exception = "";
  for (const ev of new EventStreamDecoder().feed(buf)) {
    if (ev.messageType === "exception" || ev.messageType === "error") {
      const pl = (ev.payload || {}) as Record<string, unknown>;
      exception = `${ev.type || "exception"}: ${typeof pl.message === "string" ? pl.message : JSON.stringify(pl).slice(0, 160)}`;
    } else if (ev.type === "assistantResponseEvent") {
      const c = (ev.payload as { content?: unknown })?.content;
      if (typeof c === "string") {
        sample += c;
      }
    }
  }
  if (exception && !sample) {
    return { modelId: model, ok: false, status: res.statusCode, ms, error: exception.slice(0, 200) };
  }
  return { modelId: model, ok: true, status: res.statusCode, ms, sample: sample ? sample.replace(/\s+/g, " ").slice(0, 60) : undefined };
}

export async function testModel(d: ProviderDraft, modelId: string): Promise<ModelTestResult> {
  const p = draftToProvider(d);
  const model = String(modelId || "").trim();
  if (!model) {
    return { modelId, ok: false, status: 0, ms: -1, error: "模型名为空" };
  }
  const started = Date.now();
  if (d.format === "kiro") {
    try {
      return await testKiroModel(p, d, model, started);
    } catch (e) {
      return { modelId, ok: false, status: 0, ms: Date.now() - started, error: shortErr(e) };
    }
  }
  const spec = isOAuthProvider(p) ? getVendor(p.oauthVendor) : undefined;
  const attempt = async (variant: "primary" | "alt") => {
    let { path, body } = testBody(d.format, model, variant);
    // 厂商硬性修正（Codex 拒 max_output_tokens、只接受流式等）；流式回包由下面按 SSE 抠样本。
    spec?.adjustBody?.(body, d.format);
    if (spec?.id === "antigravity") {
      // Antigravity：非流式 generateContent + 信封；Gemini 系不收 maxOutputTokens
      const project = getToken(tokenKeyOf(p.id, d.credentialId || PRIMARY_CREDENTIAL_ID))?.extra?.project || "";
      if (!project) {
        throw new Error("缺少 Antigravity 项目信息，请重新登录");
      }
      const inner = body as { generationConfig?: Record<string, unknown> };
      if (geminiFamilyOf(model) !== "claude" && inner.generationConfig) {
        delete inner.generationConfig.maxOutputTokens;
        if (!Object.keys(inner.generationConfig).length) {
          delete inner.generationConfig;
        }
      }
      path = "/v1internal:generateContent";
      body = antigravityEnvelope(model, body as unknown as GeminiRequest, project);
    }
    const url = resolveApiUrl(p, path);
    const headers: Record<string, string> = { ...(await probeHeaders(p)), "Content-Type": "application/json" };
    headers.Accept = body.stream === true ? "text/event-stream" : "application/json";
    const res = await withTimeout(
      requestUpstream("POST", url, headers, JSON.stringify(body), TEST_TIMEOUT_MS),
      TEST_TIMEOUT_MS,
      "测活"
    );
    const text = await readBody(res.body).catch(() => "");
    return { status: res.statusCode, text };
  };
  try {
    let r = await attempt("primary");
    if (d.format === "chat" && r.status === 400 && /max_tokens/i.test(r.text) && /max_completion_tokens|not supported|unsupported/i.test(r.text)) {
      debug("probe: retry with max_completion_tokens", { model });
      r = await attempt("alt");
    }
    const ms = Date.now() - started;
    if (r.status >= 200 && r.status < 300) {
      // 部分网关 200 里塞 error
      try {
        const j = JSON.parse(r.text) as { error?: { message?: string } };
        if (j?.error?.message) {
          return { modelId, ok: false, status: r.status, ms, error: String(j.error.message).slice(0, 200) };
        }
      } catch {
        /* ignore */
      }
      const sample = extractSample(d.format, r.text);
      return { modelId, ok: true, status: r.status, ms, sample: sample ? sample.replace(/\s+/g, " ").slice(0, 60) : undefined };
    }
    return { modelId, ok: false, status: r.status, ms, error: extractErrorMessage(r.text, r.status) };
  } catch (e) {
    return { modelId, ok: false, status: 0, ms: Date.now() - started, error: shortErr(e) };
  }
}

export interface BatchHandle {
  cancel(): void;
  done: Promise<void>;
}

/** 批量测活：限并发，每个结果到就回调；cancel 后不再发新请求（在途的跑完即丢）。 */
export function testModels(
  d: ProviderDraft,
  modelIds: string[],
  onResult: (r: ModelTestResult, index: number, total: number) => void,
  concurrency = 3
): BatchHandle {
  const ids = modelIds.map((s) => String(s || "").trim()).filter(Boolean);
  let cancelled = false;
  let next = 0;
  const total = ids.length;
  const done = new Promise<void>((resolve) => {
    if (!total) {
      resolve();
      return;
    }
    const worker = async () => {
      while (!cancelled) {
        const i = next++;
        if (i >= total) {
          return;
        }
        const r = await testModel(d, ids[i]);
        if (cancelled) {
          return;
        }
        try {
          onResult(r, i, total);
        } catch {
          /* ignore */
        }
      }
    };
    const n = Math.max(1, Math.min(concurrency, total));
    Promise.all(Array.from({ length: n }, () => worker())).then(() => resolve(), () => resolve());
  });
  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}
