/**
 * Kiro CodeWhisperer 请求 → Google Gemini `generateContent` 请求体。
 *
 * 两个去处共用同一份内层请求（GenerateContentRequest）：
 *  - Gemini 官方 API（AI Studio key）：POST {base}/models/{model}:streamGenerateContent?alt=sse，直接发内层；
 *  - Antigravity（Google 账号登录，走 cloudcode-pa 私有接口）：POST /v1internal:streamGenerateContent?alt=sse，
 *    外面再包一层信封 {model, project, userAgent, requestType, requestId, request}（见 antigravityEnvelope），
 *    形态对齐 CLIProxyAPI 的 geminiToAntigravity。
 *
 * 形态映射（对照 Anthropic 版 translate.ts）：
 *  - user / assistant 消息 → contents[] 的 role user / model，正文是 parts[]：
 *      文本        {text}
 *      图片        {inlineData:{mimeType,data}}
 *      工具调用    {functionCall:{id,name,args}}            ← 在 model 轮
 *      工具结果    {functionResponse:{id,name,response:{result}}}  ← 在紧随的 user 轮
 *      思考        {text, thought:true, thoughtSignature}     ← 只在 Claude 系（经 Antigravity）回放
 *  - 系统提示词 → systemInstruction{role:"user", parts:[{text}]}
 *  - 工具声明 → tools:[{functionDeclarations:[{name,description,parameters}]}]，参数 schema 要按 Gemini 的
 *    OpenAPI 子集清洗（去 $schema/additionalProperties/$ref…，联合类型摊平，枚举转字符串）
 *  - 思考档位 → generationConfig.thinkingConfig：Gemini 3 系用 thinkingLevel，Gemini 2.5 / Claude 用 thinkingBudget
 *    （2.5 按子型号限幅，见 geminiLimits）；一律 includeThoughts:true，否则思考过程不回传，Kiro 里看不到
 *
 * 思考签名（thoughtSignature）：Gemini 3 会在 functionCall 部件上带签名，下一轮回放时**必须**原样放回同一个
 * functionCall 上，否则 400。我们把流里拿到的签名以 "a2k-gm:" 前缀存进 Kiro 历史的 reasoning signature
 * （同 Responses 的 encrypted_content 存法），回放时贴到该轮第一个 functionCall 上；没有签名的合成历史
 * 用 Google 文档给的绕过哨兵 "skip_thought_signature_validator"。Claude 系的签名贴在思考部件上；
 * 没签名的思考块整块丢弃，并关掉本次请求的 thinkingConfig（对齐 CPA：unsigned → 不转文本、不再要求思考）。
 */

import * as crypto from "crypto";
import { AnthropicJsonSchema, CwAssistantResponseMessage, CwRequest, CwToolResult } from "./cwTypes";
import { getMaxTokens } from "./config";
import { clampGeminiThinkingBudget } from "./geminiLimits";
import { debug } from "./log";
import { ProviderConfig } from "./providers";
import { EffortLevel, hasEffortVariant } from "./modelStore";
import { activePromptText } from "./promptStore";
import { isSyntheticSignature } from "./thinkingPolicy";
import { buildUserText, latestModelId, parseToolSpec, resolveModelForProvider, toolResultToText } from "./translate";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiThinkingConfig {
  includeThoughts?: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number;
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  thinkingConfig?: GeminiThinkingConfig;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: "user"; parts: GeminiPart[] };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  toolConfig?: { functionCallingConfig: { mode: string } };
  generationConfig?: GeminiGenerationConfig;
  /** Antigravity 会话稳定 id（同一会话复用，缓存/追踪用） */
  sessionId?: string;
}

/** Google 文档给的哨兵：合成历史里的 functionCall 没有真签名时用它绕过校验。 */
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

const SIG_PREFIX = "a2k-gm:";

export function encodeGeminiSignature(sig: string): string {
  return SIG_PREFIX + sig;
}

export function decodeGeminiSignature(sig: string | undefined): string | undefined {
  if (typeof sig !== "string" || !sig.startsWith(SIG_PREFIX)) {
    return undefined;
  }
  const inner = sig.slice(SIG_PREFIX.length);
  return inner ? inner : undefined;
}

/** 模型家族：决定签名回放方式、schema 占位、maxOutputTokens 取舍、思考档位形态。 */
export type GeminiFamily = "claude" | "gemini3" | "gemini25" | "other";

export function geminiFamilyOf(model: string): GeminiFamily {
  const m = String(model || "").toLowerCase();
  if (m.includes("claude")) {
    return "claude";
  }
  if (/gemini-3|gemini-pro-agent|gemini-flash-latest|gemini-pro-latest/.test(m)) {
    return "gemini3";
  }
  if (/gemini-2\.5|gemini-2-5/.test(m)) {
    return "gemini25";
  }
  // gemini-2.0 / 1.5 / gemma / embedding 一类不支持 thinkingConfig，给了会 400 → 归 other（不带思考配置）
  if (/gemini-(1\.|2\.0)|gemma|embedding|imagen|veo|tts|aqa/.test(m)) {
    return "other";
  }
  if (m.startsWith("gemini")) {
    return "gemini3";
  }
  return "other";
}

// ---------------------------------------------------------------------------------------
// JSON Schema → Gemini OpenAPI 子集
// ---------------------------------------------------------------------------------------

/** 原样透传的数值约束（Gemini 子集支持）；其余键要么转写要么丢弃。 */
const NUMERIC_KEEP = ["minItems", "maxItems", "minimum", "maximum"] as const;

interface CleanOpts {
  /** Claude VALIDATED 模式：空对象 schema 要有一个必填占位属性（对齐 CPA addEmptySchemaPlaceholder） */
  placeholder: boolean;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 解析本地 $ref（#/$defs/x、#/definitions/x、#/properties/...），失败返回 undefined。 */
function resolveRef(root: Json, ref: string): Json | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    return undefined;
  }
  let cur: unknown = root;
  for (const seg of ref.slice(2).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return isObj(cur) ? cur : undefined;
}

function appendDesc(out: Json, hint: string): void {
  const d = typeof out.description === "string" ? out.description : "";
  out.description = d ? `${d} (${hint})` : hint;
}

/**
 * 递归清洗一个 schema 节点。
 * - type 数组 → 取第一个非 null 的；含 null → nullable:true
 * - anyOf/oneOf → 取第一个非 null 分支（都是 string 枚举则合并枚举），null 分支变 nullable
 * - allOf → 合并 properties/required
 * - $ref → 内联（带深度上限防环）
 * - const → enum；非 string 类型的 enum 挪进 description（Antigravity 只收字符串枚举）
 * - 不支持的关键字删掉，个别有语义的（format/pattern/min/maxLength）写进 description
 * - array 缺 items 补 {type:"string"}
 */
function cleanNode(node: unknown, root: Json, depth: number, opts: CleanOpts): Json {
  if (!isObj(node) || depth > 24) {
    return { type: "string" };
  }
  let src: Json = node;
  if (typeof src.$ref === "string") {
    const target = resolveRef(root, src.$ref);
    if (target) {
      const { $ref: _omit, ...rest } = src;
      void _omit;
      src = { ...target, ...rest };
    } else {
      return { type: "string", description: `ref ${src.$ref}` };
    }
  }
  // allOf：合并
  if (Array.isArray(src.allOf)) {
    const merged: Json = { ...src };
    delete merged.allOf;
    const props: Json = isObj(merged.properties) ? { ...merged.properties } : {};
    const req = new Set<string>(Array.isArray(merged.required) ? (merged.required as string[]) : []);
    for (const sub of src.allOf as unknown[]) {
      const s = isObj(sub) && typeof sub.$ref === "string" ? resolveRef(root, sub.$ref) || sub : sub;
      if (!isObj(s)) {
        continue;
      }
      if (isObj(s.properties)) {
        Object.assign(props, s.properties);
      }
      for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) {
        req.add(r);
      }
      if (!merged.type && s.type) {
        merged.type = s.type;
      }
      if (!merged.description && s.description) {
        merged.description = s.description;
      }
    }
    if (Object.keys(props).length) {
      merged.properties = props;
      merged.type = merged.type || "object";
    }
    if (req.size) {
      merged.required = [...req];
    }
    src = merged;
  }
  // anyOf / oneOf：摊平
  const union = (Array.isArray(src.anyOf) ? src.anyOf : Array.isArray(src.oneOf) ? src.oneOf : undefined) as unknown[] | undefined;
  let nullable = src.nullable === true;
  if (union && union.length) {
    const branches = union.map((b) => (isObj(b) && typeof b.$ref === "string" ? resolveRef(root, b.$ref) || b : b)).filter(isObj);
    const nonNull = branches.filter((b) => b.type !== "null");
    if (nonNull.length < branches.length) {
      nullable = true;
    }
    const allStrEnum = nonNull.length > 1 && nonNull.every((b) => b.type === "string" && Array.isArray(b.enum));
    const pick: Json = { ...src };
    delete pick.anyOf;
    delete pick.oneOf;
    if (allStrEnum) {
      pick.type = "string";
      pick.enum = nonNull.flatMap((b) => b.enum as unknown[]);
    } else if (nonNull.length) {
      // 取第一个分支，外层的 description 优先
      const first = nonNull[0];
      for (const [k, v] of Object.entries(first)) {
        if (pick[k] === undefined) {
          pick[k] = v;
        }
      }
      if (nonNull.length > 1) {
        appendDesc(pick, "one of " + nonNull.map((b) => (typeof b.type === "string" ? b.type : "object")).join("|"));
      }
    }
    src = pick;
  }
  // type
  let type: string | undefined;
  if (Array.isArray(src.type)) {
    const ts = (src.type as unknown[]).filter((t): t is string => typeof t === "string");
    if (ts.includes("null")) {
      nullable = true;
    }
    type = ts.find((t) => t !== "null");
  } else if (typeof src.type === "string") {
    type = src.type;
  }
  if (type === "null") {
    type = "string";
    nullable = true;
  }
  if (!type) {
    type = isObj(src.properties) ? "object" : src.items !== undefined ? "array" : "string";
  }

  const out: Json = { type };
  if (nullable) {
    out.nullable = true;
  }
  if (typeof src.description === "string" && src.description) {
    out.description = src.description;
  }
  // 有语义但 Gemini 不收的约束 → 写进描述
  const hints: string[] = [];
  if (typeof src.format === "string" && src.format && type === "string") {
    hints.push(`format: ${src.format}`);
  }
  if (typeof src.pattern === "string" && src.pattern) {
    hints.push(`pattern: ${src.pattern}`);
  }
  if (src.minLength !== undefined) {
    hints.push(`minLength: ${src.minLength}`);
  }
  if (src.maxLength !== undefined) {
    hints.push(`maxLength: ${src.maxLength}`);
  }
  if (src.default !== undefined) {
    try {
      hints.push(`default: ${JSON.stringify(src.default)}`);
    } catch {
      /* ignore */
    }
  }
  // enum / const
  let enumVals: unknown[] | undefined = Array.isArray(src.enum) ? (src.enum as unknown[]) : undefined;
  if (enumVals === undefined && src.const !== undefined) {
    enumVals = [src.const];
  }
  if (enumVals && enumVals.length) {
    const strs = enumVals.filter((v) => v !== null && v !== undefined).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    if (type === "string") {
      out.enum = strs;
    } else {
      hints.push("allowed: " + strs.join(", "));
    }
  }
  for (const k of NUMERIC_KEEP) {
    if (typeof src[k] === "number") {
      out[k] = src[k];
    }
  }
  if (hints.length) {
    appendDesc(out, hints.join("; "));
  }
  // 子结构
  if (type === "object") {
    const props: Json = {};
    if (isObj(src.properties)) {
      for (const [k, v] of Object.entries(src.properties)) {
        props[k] = cleanNode(v, root, depth + 1, opts);
      }
    }
    const req = Array.isArray(src.required) ? (src.required as unknown[]).filter((r): r is string => typeof r === "string" && r in props) : [];
    if (Object.keys(props).length === 0 && opts.placeholder) {
      // Claude VALIDATED：空对象 schema 必须有一个必填属性
      props.reason = { type: "string", description: "Brief explanation of why you are calling this tool" };
      out.properties = props;
      out.required = ["reason"];
    } else {
      out.properties = props;
      if (req.length) {
        out.required = req;
      } else if (opts.placeholder && depth > 0 && Object.keys(props).length) {
        // 嵌套对象有属性但都非必填 → 也给个占位（对齐 CPA）
        props._ = { type: "boolean" };
        out.required = ["_"];
      }
    }
  } else if (type === "array") {
    out.items = isObj(src.items) ? cleanNode(src.items, root, depth + 1, opts) : { type: "string" };
  }
  // 嵌套的空对象（如 additionalProperties 式的自由字典）：OBJECT 不能没有 properties，
  // 退成"JSON 文本"让模型以字符串形式传，工具侧解析——比 400 拒收强
  if (type === "object" && depth > 0 && isObj(out.properties) && Object.keys(out.properties).length === 0) {
    delete out.properties;
    delete out.required;
    out.type = "string";
    appendDesc(out, "JSON object encoded as a string");
  }
  // 其余键（$schema / additionalProperties / title / examples / x-* …）一律不透传
  return out;
}

/**
 * 工具参数 schema → Gemini 能收的形态。
 * 返回 undefined 表示"该工具没有参数"：Gemini 官方 API 拒绝 properties 为空的 OBJECT
 * （"parameters.properties: should be non-empty for OBJECT type"），此时整个 parameters 字段都不要发。
 */
export function cleanSchemaForGemini(schema: AnthropicJsonSchema | undefined, opts: CleanOpts): Json | undefined {
  const root: Json = isObj(schema) ? (schema as Json) : { type: "object", properties: {} };
  let cleaned = cleanNode(root, root, 0, opts);
  if (cleaned.type !== "object") {
    // 参数根必须是 object
    cleaned = opts.placeholder
      ? { type: "object", properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } }, required: ["reason"] }
      : { type: "object", properties: {} };
  }
  const props = isObj(cleaned.properties) ? cleaned.properties : {};
  return Object.keys(props).length ? cleaned : undefined;
}

// ---------------------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------------------

function parseArgs(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const v = JSON.parse(input);
      return isObj(v) ? v : {};
    } catch {
      return {};
    }
  }
  return isObj(input) ? input : {};
}

function reasoningOf(arm: CwAssistantResponseMessage): { text?: string; signature?: string } {
  const rc = arm.reasoningContent;
  let out: { text?: string; signature?: string };
  if (rc && typeof rc === "object") {
    out = { text: rc.reasoningText?.text, signature: rc.reasoningText?.signature ?? arm.reasoningSignature };
  } else if (typeof rc === "string") {
    out = { text: rc, signature: arm.reasoningSignature };
  } else {
    out = { signature: arm.reasoningSignature };
  }
  // OpenAI 通路（GLM / DeepSeek）留在历史里的思考带的是合成签名：那是别家模型想的，对 Gemini /
  // Antigravity 既不能回放也不该因此关掉本轮思考，当作没有。
  if (isSyntheticSignature(out.signature)) {
    return {};
  }
  return out;
}

/** 稳定的会话 id：Antigravity 的 sessionId 形如 "-<数字>"，用会话 id 哈希出一个。 */
export function geminiSessionId(convId: string): string {
  const h = crypto.createHash("sha256").update(String(convId || "")).digest("hex").slice(0, 15);
  return "-" + BigInt("0x" + h).toString();
}

export interface GeminiBuildOptions {
  /** Kiro 选中的思考档位（undefined=auto） */
  effort?: EffortLevel;
  /** 会话 id（Antigravity sessionId 用） */
  convId?: string;
}

export interface GeminiBuilt {
  /** 发给上游的模型 id（已按 provider 映射，并按目录里的 -<effort> 变体解析） */
  model: string;
  request: GeminiRequest;
  family: GeminiFamily;
}

/**
 * 模型 id 解析：Antigravity 目录里像 gemini-3.1-pro-low / gemini-3.6-flash-high 这种自带档位后缀的
 * id 是独立模型，Kiro 里显示成 base + 档位；请求进来时按 base+effort 找回真实 id：
 *  1) 目录里有精确 id → 用；2) 有 <base>-<effort> → 用；3) 只有别的档位变体 → 用第一个。
 */
export function resolveGeminiModel(provider: ProviderConfig, kiroModel: string, effort: EffortLevel | undefined, catalog: string[]): string {
  const mapped = resolveModelForProvider(provider, kiroModel);
  const lower = new Map(catalog.map((c) => [c.toLowerCase(), c] as const));
  if (!catalog.length || lower.has(mapped.toLowerCase())) {
    return mapped;
  }
  if (effort && hasEffortVariant(provider.id, mapped, effort)) {
    return `${mapped}-${effort}`;
  }
  for (const lvl of ["high", "medium", "low", "minimal", "xhigh", "max", "none"]) {
    const hit = lower.get(`${mapped}-${lvl}`.toLowerCase());
    if (hit) {
      return hit;
    }
  }
  return mapped;
}

const LEVEL_SUFFIX = /-(minimal|low|medium|high|xhigh|max|none)$/i;

/** 按模型家族 + 档位给 thinkingConfig。变体 id 自带档位（-high 等）时只开 includeThoughts。 */
export function geminiThinkingConfig(model: string, family: GeminiFamily, effort: EffortLevel | undefined, maxTokens: number): GeminiThinkingConfig | undefined {
  if (family === "other") {
    return undefined;
  }
  const cfg: GeminiThinkingConfig = { includeThoughts: true };
  if (LEVEL_SUFFIX.test(model) || !effort) {
    return cfg;
  }
  if (family === "claude") {
    const budgets: Record<string, number> = { none: 0, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 32000 };
    const b = budgets[effort] ?? 8192;
    if (b <= 0) {
      return undefined;
    }
    cfg.thinkingBudget = Math.max(1024, Math.min(b, maxTokens - 4096));
    return cfg;
  }
  if (family === "gemini25") {
    const budgets: Record<string, number> = { none: 0, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 32768 };
    const b = budgets[effort] ?? 8192;
    // 子型号的合法范围不同（Pro 128–32768 且不能关；Flash 0–24576；Flash-Lite 0 或 512–24576），越界上游 400：
    // 按型号限幅——超上限取上限、不可关的 none 取最小值；不认识的型号原值放行（见 geminiLimits）。
    const { budget, clamped, limits } = clampGeminiThinkingBudget(model, b);
    if (clamped) {
      debug("gemini thinkingBudget clamped", { model, effort, from: b, to: budget, limits });
    }
    if (budget <= 0) {
      cfg.thinkingBudget = 0;
      cfg.includeThoughts = false;
      return cfg;
    }
    cfg.thinkingBudget = budget;
    return cfg;
  }
  // gemini3：档位。Flash 系有 minimal/low/medium/high；Pro 系官方 API 只认 low/high（medium 会 400），
  // Antigravity 的 pro 虽然收 medium，统一映到 high 两边都安全。
  const isPro = /pro/.test(model.toLowerCase());
  const supportsMinimal = !isPro;
  const level: Record<string, string> = {
    none: supportsMinimal ? "minimal" : "low",
    low: "low",
    medium: isPro ? "high" : "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };
  cfg.thinkingLevel = level[effort] || "high";
  return cfg;
}

/**
 * 主转换。`catalog` 是该 provider 缓存里的模型 id（用于 -<effort> 变体解析），可为空。
 */
export function buildGeminiRequest(req: CwRequest, provider: ProviderConfig, opts: GeminiBuildOptions = {}, catalog: string[] = []): GeminiBuilt {
  const state = req.conversationState;
  const items = [...(state.history || [])];
  if (state.currentMessage) {
    items.push(state.currentMessage);
  }

  const kiroModel = latestModelId(req);
  const model = resolveGeminiModel(provider, kiroModel, opts.effort, catalog);
  const family = geminiFamilyOf(model);
  const placeholder = family === "claude" || /gemini-3(\.\d+)?-pro/i.test(model);

  const contents: GeminiContent[] = [];
  let declarations: GeminiFunctionDeclaration[] | undefined;
  /** toolUseId → 工具名（functionResponse 要 name） */
  const toolNames = new Map<string, string>();
  let pending: string[] = [];
  let thinkingDisabled = false;

  // Gemini 要求 contents 严格 user / model 交替：同角色连续出现时并进上一条（Kiro 历史正常总是交替，
  // 但历史被裁剪 / 取消过的会话可能留下相邻两条 assistant）。
  const pushRole = (role: "user" | "model", parts: GeminiPart[]) => {
    if (!parts.length) {
      return;
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };
  const pushUser = (parts: GeminiPart[]) => pushRole("user", parts);

  for (const item of items) {
    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      const parts: GeminiPart[] = [];
      const results: CwToolResult[] = uim.userInputMessageContext?.toolResults || [];
      const byId = new Map(results.filter((r) => r && r.toolUseId).map((r) => [r.toolUseId, r] as const));
      // 上一轮的每个 functionCall 都要有 functionResponse（顺序对应），没结果的补占位
      for (const id of pending) {
        const tr = byId.get(id);
        byId.delete(id);
        parts.push({
          functionResponse: {
            id,
            name: toolNames.get(id) || id,
            response: { result: tr ? toolResultToText(tr.content) : "(tool call was not completed)" },
          },
        });
      }
      pending = [];
      const orphan: string[] = [];
      for (const tr of byId.values()) {
        const t = toolResultToText(tr.content);
        if (t) {
          orphan.push(`[Tool result ${tr.toolUseId}]\n${t}`);
        }
      }
      const textPieces = [...orphan];
      const text = buildUserText(uim);
      if (text) {
        textPieces.push(text);
      }
      const joined = textPieces.join("\n\n");
      if (joined) {
        parts.push({ text: joined });
      }
      for (const img of uim.images || []) {
        const fmt = (img.format || "png").toLowerCase();
        parts.push({ inlineData: { mimeType: "image/" + (fmt === "jpg" ? "jpeg" : fmt), data: img.source.bytes } });
      }
      if (!parts.length) {
        parts.push({ text: "(empty)" });
      }
      pushUser(parts);

      if (uim.userInputMessageContext?.tools) {
        declarations = uim.userInputMessageContext.tools.map((spec) => {
          const { name, description, schema } = parseToolSpec(spec);
          const d: GeminiFunctionDeclaration = { name };
          const params = cleanSchemaForGemini(schema, { placeholder });
          if (params) {
            d.parameters = params; // 无参数的工具不发 parameters（Gemini 拒绝空 OBJECT）
          }
          if (description) {
            d.description = description;
          }
          return d;
        });
      }
    }

    if (item.assistantResponseMessage) {
      const arm = item.assistantResponseMessage;
      const parts: GeminiPart[] = [];
      const { text: thinkText, signature } = reasoningOf(arm);
      const sig = decodeGeminiSignature(signature);
      const calls = arm.toolUses || [];

      if (family === "claude") {
        // Claude 系：思考块必须带（我们存的）签名才回放；没签名整块丢，并关掉本次思考（对齐 CPA）
        if (thinkText && sig) {
          parts.push({ text: thinkText, thought: true, thoughtSignature: sig });
        } else if (thinkText) {
          thinkingDisabled = true;
        }
      }
      if (arm.content) {
        parts.push({ text: arm.content });
      }
      calls.forEach((tu, i) => {
        toolNames.set(tu.toolUseId, tu.name);
        const p: GeminiPart = { functionCall: { id: tu.toolUseId, name: tu.name, args: parseArgs(tu.input) } };
        if (i === 0 && family !== "claude") {
          // 真签名回到第一个 functionCall；Gemini 3 强制校验，没有真签名用哨兵绕过。
          // 2.5 及更老的不校验，别塞哨兵（它们会当成非法签名）。
          if (sig) {
            p.thoughtSignature = sig;
          } else if (family === "gemini3") {
            p.thoughtSignature = GEMINI_SKIP_SIGNATURE;
          }
        }
        parts.push(p);
      });
      if (!calls.length && sig && family !== "claude" && parts.length) {
        parts[parts.length - 1].thoughtSignature = sig;
      }
      if (!parts.length) {
        parts.push({ text: "(no content)" });
      }
      pushRole("model", parts);
      pending = calls.map((tu) => tu.toolUseId);
    }
  }

  if (pending.length) {
    pushUser(
      pending.map((id) => ({
        functionResponse: { id, name: toolNames.get(id) || id, response: { result: "(tool call was not completed)" } },
      }))
    );
  }
  // Gemini 要求第一条是 user
  if (contents.length && contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "(start)" }] });
  }

  const maxTokens = getMaxTokens();
  const request: GeminiRequest = { contents };
  const system = activePromptText();
  if (system) {
    request.systemInstruction = { role: "user", parts: [{ text: system }] };
  }
  if (declarations && declarations.length) {
    request.tools = [{ functionDeclarations: declarations }];
    if (family === "claude") {
      request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
    }
  }
  const gen: GeminiGenerationConfig = {};
  if (family === "claude") {
    // Antigravity 只对 Claude 收 maxOutputTokens（Gemini 系给了会被拒），且必须 ≤ 64000
    gen.maxOutputTokens = Math.min(maxTokens, 64000);
  }
  const thinking = thinkingDisabled ? undefined : geminiThinkingConfig(model, family, opts.effort, maxTokens);
  if (thinking) {
    gen.thinkingConfig = thinking;
  }
  if (Object.keys(gen).length) {
    request.generationConfig = gen;
  }
  if (opts.convId) {
    request.sessionId = geminiSessionId(opts.convId);
  }
  return { model, request, family };
}

/** Antigravity 信封（对齐 CPA geminiToAntigravity）。 */
export function antigravityEnvelope(model: string, request: GeminiRequest, project: string): Record<string, unknown> {
  return {
    model,
    project,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: "agent-" + crypto.randomUUID(),
    request,
  };
}

/** Gemini 官方 API 不认 sessionId 字段；发给它前剥掉。 */
export function stripAntigravityOnly(request: GeminiRequest): GeminiRequest {
  const { sessionId: _s, ...rest } = request;
  void _s;
  return rest;
}
