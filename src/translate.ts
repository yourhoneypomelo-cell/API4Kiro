import {
  AnthropicJsonSchema,
  CwRequest,
  CwToolSpec,
  CwUserInputMessage,
} from "./cwTypes";
import {
  getMaxTokens,
  getThinkingConfig,
  getThinkingBudget,
  ThinkingConfig,
} from "./config";
import { ProviderConfig, bareModelId } from "./providers";
import { hasEffortVariant, thinkingVariantOf, EffortLevel } from "./modelStore";
import { budgetForEffort, getEffortMode } from "./effort";
import { activePromptText } from "./promptStore";
import { inlineLocalRefs } from "./schemaUtil";
import { imageMediaType } from "./mediaType";
import { isRelaySignature } from "./thinkingPolicy";

const DEFAULT_MODEL_ID = "CLAUDE_SONNET_4_20250514_V1_0";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** 从 Kiro 历史 assistant 消息里提取带签名的 thinking 块（无签名则返回 null）。 */
function extractThinkingBlock(
  arm: import("./cwTypes").CwAssistantResponseMessage
): { type: "thinking"; thinking: string; signature: string } | null {
  const rc = arm.reasoningContent;
  let text: string | undefined;
  let signature: string | undefined;
  if (rc && typeof rc === "object") {
    text = rc.reasoningText?.text;
    signature = rc.reasoningText?.signature ?? arm.reasoningSignature;
  } else if (typeof rc === "string") {
    text = rc;
    signature = arm.reasoningSignature;
  }
  // Anthropic 硬要求 thinking 块带签名，否则后端 400。无签名则不回传。
  // 本扩展其它通路写进历史的签名也算"无签名"（Chat 的 api4kiro: 占位、Gemini 的 a2k-gm: 封装、
  // Responses 的 a2k-rs: 封装，见 thinkingPolicy.RELAY_SIGNATURE_PREFIXES）：那段思考是别家模型想的，
  // 用户中途切到 Claude 时原样带过去只会换来 400 "Invalid signature"。整块丢弃，不降级成正文。
  if (text && signature && text.length > 0 && signature.length > 0 && !isRelaySignature(signature)) {
    return { type: "thinking", thinking: text, signature };
  }
  return null;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: AnthropicJsonSchema;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: boolean;
  /**
   * 用户在「提示词」页启用的那条。Kiro 的请求体本身没有 system（它的系统提示词在
   * AWS 服务端拼），所以这就是第三方上游看到的全部 system；没启用则不带此字段。
   */
  system?: string;
  tools?: AnthropicTool[];
  thinking?: ThinkingConfig;
  /** Reasoning-effort level (low/medium/high/xhigh/max) + optional GPT reasoning
   *  mode (standard/pro). The relay maps these to CodeWhisperer output_config.effort
   *  (Claude) or upstream reasoning.{mode,effort} (GPT 5.6), so the user's chosen
   *  tier/mode actually reaches the backend instead of defaulting. `mode` is carried
   *  inside output_config; the relay ignores it for non-reasoning models. */
  output_config?: { effort: string; mode?: string };
}

/** Find the most recent modelId Kiro attached to any user message. */
export function latestModelId(req: CwRequest): string {
  const items = [
    ...(req.conversationState.history || []),
    ...(req.conversationState.currentMessage ? [req.conversationState.currentMessage] : []),
  ];
  for (let i = items.length - 1; i >= 0; i--) {
    const id = items[i].userInputMessage?.modelId;
    if (id) {
      return id;
    }
  }
  return DEFAULT_MODEL_ID;
}

export function conversationId(req: CwRequest): string {
  return req.conversationState.conversationId || "unknown";
}

/**
 * Kiro 选中的模型 ID → 该 provider 上游的真实模型 ID。
 * 先查 provider 自己的 modelMapping，再退到它的 defaultModel，最后原样返回。
 * 每个 provider 各带一张映射表，聚合场景下永远不会把 A 家的 id 发到 B 家。
 */
export function resolveModelForProvider(p: ProviderConfig, kiroModelId: string): string {
  // 带渠道限定的 id（<id>@<providerId>）先去掉限定——上游只认裸 id；映射表两种写法都查
  const bare = bareModelId(kiroModelId);
  const mapping = p.modelMapping || {};
  if (mapping[kiroModelId]) {
    return mapping[kiroModelId];
  }
  if (mapping[bare]) {
    return mapping[bare];
  }
  if (p.defaultModel) {
    return p.defaultModel;
  }
  return bare;
}

export function parseToolSpec(spec: CwToolSpec): {
  name: string;
  description?: string;
  schema?: AnthropicJsonSchema;
} {
  const ts = spec.toolSpecification || spec;
  const name = ts.name || "";
  const description = ts.description;
  let schema: AnthropicJsonSchema | undefined;
  const rawSchema = (ts as { inputSchema?: unknown }).inputSchema;
  if (rawSchema && typeof rawSchema === "object") {
    const asJson = (rawSchema as { json?: AnthropicJsonSchema }).json;
    schema = asJson && typeof asJson === "object" ? asJson : (rawSchema as AnthropicJsonSchema);
  }
  // Kiro 内置工具的 schema 带 "#/properties/…" 这种本地 $ref，严格校验的上游（xAI）解不开会 400；
  // 在这里统一内联，四种协议的翻译都从这儿拿 schema。
  return { name, description, schema: inlineLocalRefs(schema) };
}

/** Serialize a tool result payload (which may be structured) to plain text. */
export function toolResultToText(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item == null) {
        continue;
      }
      if (typeof item === "string") {
        parts.push(item);
      } else if (typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === "string") {
          parts.push(obj.text);
        } else if (obj.json !== undefined) {
          parts.push(typeof obj.json === "string" ? obj.json : JSON.stringify(obj.json));
        } else {
          parts.push(JSON.stringify(obj));
        }
      } else {
        parts.push(String(item));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    return JSON.stringify(obj);
  }
  return String(content);
}

/** Parse a tool_use input that may arrive as a JSON string or already-parsed object. */
function parseToolInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

/** Concatenate editor/context blocks Kiro attaches into a single text block. */
function buildContextText(msg: CwUserInputMessage): string {
  const parts: string[] = [];
  const ctx = msg.userInputMessageContext;
  for (const c of ctx?.additionalContext || []) {
    const inner = (c.innerContext || "").trim();
    if (!inner) {
      continue;
    }
    const label = [c.name, c.description].filter(Boolean).join(" - ");
    parts.push(`[Context${label ? ": " + label : ""}]\n${inner}`);
  }
  const editor = ctx?.editorState;
  if (editor?.document?.text) {
    parts.push(`[Active file: ${editor.document.relativeFilePath || ""}]\n${editor.document.text}`);
  }
  for (const d of editor?.relevantDocuments || []) {
    if (d?.text) {
      parts.push(`[File: ${d.relativeFilePath || ""}]\n${d.text}`);
    }
  }
  return parts.join("\n\n");
}

export function buildUserText(msg: CwUserInputMessage): string {
  const ctxText = buildContextText(msg);
  const content = msg.content || "";
  if (ctxText) {
    return content ? content + "\n\n" + ctxText : ctxText;
  }
  return content;
}

/**
 * Build an Anthropic /v1/messages request body from Kiro's CodeWhisperer
 * request. Ports the reference plugin's `buildAnthropicRequest`.
 */
export function buildAnthropicRequest(req: CwRequest, provider: ProviderConfig): AnthropicRequest {
  const state = req.conversationState;
  const items = [...(state.history || [])];
  if (state.currentMessage) {
    items.push(state.currentMessage);
  }

  const messages: AnthropicMessage[] = [];
  let tools: AnthropicTool[] | undefined;

  for (const item of items) {
    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      const blocks: AnthropicContentBlock[] = [];

      for (const tr of uim.userInputMessageContext?.toolResults || []) {
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolUseId,
          content: toolResultToText(tr.content),
        });
      }

      const text = buildUserText(uim);
      if (text) {
        blocks.push({ type: "text", text });
      }

      for (const img of uim.images || []) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            // Anthropic 只认 image/jpeg|png|gif|webp：jpg → jpeg、缺失 → png，与其它三通路同一归一
            media_type: imageMediaType(img.format),
            data: img.source.bytes,
          },
        });
      }

      if (blocks.length > 0) {
        messages.push({
          role: "user",
          content:
            blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
        });
      }

      if (uim.userInputMessageContext?.tools) {
        tools = uim.userInputMessageContext.tools.map((spec) => {
          const { name, description, schema } = parseToolSpec(spec);
          const input_schema: AnthropicJsonSchema = {
            type: "object",
            properties: schema?.properties ?? {},
          };
          if (schema?.required) {
            input_schema.required = schema.required;
          }
          return { name, description, input_schema };
        });
      }
    }

    if (item.assistantResponseMessage) {
      const arm = item.assistantResponseMessage;
      const blocks: AnthropicContentBlock[] = [];
      // 关键修复：把 Kiro 历史里带签名的推理块转成 Anthropic thinking 块，放在最前面。
      // 这是"直连能思考、插件不思考"的根因——Kiro 直连 AWS 时历史每轮都带 reasoningContent，
      // 让模型在工具循环中延续思考；而此前 buildAnthropicRequest 只读 content+toolUses，
      // 把它丢了，导致后端在工具轮停止思考。thinking 块必须排在 text/tool_use 之前。
      const thinkingBlock = extractThinkingBlock(arm);
      if (thinkingBlock) {
        blocks.push(thinkingBlock);
      }
      if (arm.content) {
        blocks.push({ type: "text", text: arm.content });
      }
      for (const tu of arm.toolUses || []) {
        blocks.push({
          type: "tool_use",
          id: tu.toolUseId,
          name: tu.name,
          input: parseToolInput(tu.input),
        });
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "(no content)" });
      }
      messages.push({
        role: "assistant",
        content:
          blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
      });
    }
  }

  const model = resolveModelForProvider(provider, latestModelId(req));
  const maxTokens = getMaxTokens();

  const looksThinking = /thinking/i.test(model);
  let thinking = getThinkingConfig();
  if (looksThinking && thinking?.type !== "disabled") {
    thinking = { type: "enabled", budget_tokens: getThinkingBudget() };
  }

  const body: AnthropicRequest = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  };
  const system = activePromptText();
  if (system) {
    body.system = system;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (thinking && thinking.type === "enabled" && thinking.budget_tokens) {
    setThinkingBudget(body, thinking.budget_tokens);
  }
  return body;
}

/**
 * Enable extended thinking with a budget that always satisfies Anthropic's
 * constraints: 1024 <= budget_tokens < max_tokens. We clamp the budget under
 * max_tokens instead of raising max_tokens, because many relays cap a model's
 * output tokens and would reject an inflated max_tokens. If the window is too
 * small to fit a valid budget, thinking is left off.
 */
export function setThinkingBudget(body: AnthropicRequest, budget: number): void {
  if (!budget || budget <= 0) {
    return;
  }
  const ceiling = body.max_tokens - 4096;
  const b = Math.min(budget, ceiling);
  if (b >= 1024) {
    body.thinking = { type: "enabled", budget_tokens: b };
  }
}

/**
 * Apply Kiro's selected effort level (max/xhigh/high/medium/low) to the request.
 *
 * 与 Kiro 官方对齐的核心：Kiro 原生**只**发 `additionalModelRequestFields =
 * { output_config: { effort } }`（见 Kiro 客户端 We7()），既不发 `thinking`
 * 也不发 budget_tokens，思考深度完全交给模型按 effort 自适应。因此默认（auto）
 * 模式就**原样透传** `output_config.effort`，不再自造 `thinking:adaptive`/budget
 * ——那套"模拟"是此前思考行为与官方对不齐、反复修不好的根因。
 *
 * 另外两种模式仅为兼容"不认 output_config.effort 的通用中转站"而保留，需用户显式开启：
 * - `modelVariant`：改调中转站暴露的 `<model>-<effort>` 或 `-thinking` 变体模型。
 * - `thinkingBudget`：把 effort 换算成 Anthropic 标准 `thinking.budget_tokens`。
 *
 * Mutates `body` in place. `effort` is the resolved level (or undefined).
 */
export function applyEffort(
  body: AnthropicRequest,
  providerId: string,
  effort: EffortLevel | undefined,
  reasoningMode?: string
): void {
  if (!effort) {
    // Kiro 未给 effort（auto 档 / 老版本）→ 不加任何字段，让模型走默认，
    // 与 Kiro 原生 We7() 返回 undefined 的行为一致。
    return;
  }
  const mode = getEffortMode();
  if (mode === "off") {
    return;
  }

  // 透传 Kiro 原生 effort（+ GPT reasoning 模型的 mode）：中转站据此发 output_config.effort，
  // 或把 output_config.{effort,mode} 映射为上游 reasoning.{mode,effort}。mode 仅 reasoning 模型
  // 有意义，非 reasoning 模型中转站会忽略，故这里一并带上无害。
  body.output_config = reasoningMode ? { effort, mode: reasoningMode } : { effort };

  // 变体模式（可选）：部分中转站用独立的 <model>-<effort> / -thinking 模型承载思考。
  if (mode === "auto" || mode === "modelVariant") {
    if (hasEffortVariant(providerId, body.model, effort)) {
      body.model = `${body.model}-${effort}`;
      return;
    }
    if (mode === "modelVariant") {
      const tv = thinkingVariantOf(providerId, body.model);
      if (tv) {
        body.model = tv;
        setThinkingBudget(body, budgetForEffort(effort));
      }
      return;
    }
  }

  // thinkingBudget 模式（可选，面向只认 Anthropic 标准 thinking 的通用中转站）：
  // 把 effort 换算成固定预算。默认 auto 模式**不走这里**——纯透传 output_config，
  // 与 Kiro 官方完全一致。
  if (mode === "thinkingBudget") {
    setThinkingBudget(body, budgetForEffort(effort));
  }
}
