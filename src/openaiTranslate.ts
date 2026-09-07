/**
 * Kiro CodeWhisperer 请求 → OpenAI /v1/chat/completions 请求体。
 *
 * 与 Anthropic 侧（translate.ts）的形态差异，逐条对应：
 * - 工具声明：`tools[].function.{name,description,parameters}`
 *   （Anthropic 是 `tools[].{name,description,input_schema}`）
 * - 工具结果：独立的 `role:"tool"` 消息 + `tool_call_id`
 *   （Anthropic 是 user 消息里的 tool_result 内容块）
 * - 工具调用：assistant 消息的 `tool_calls[]`，参数是**字符串**
 *   （Anthropic 是 tool_use 块，input 是对象）
 * - 图片：`image_url.url` 里塞 base64 data URL
 *   （Anthropic 是 `source:{type:"base64",media_type,data}`）
 * - 思考：OpenAI 协议没有签名思考块。历史里的 reasoning 默认丢弃、只在流式输出时展示
 *   （见 openaiStream.ts）；但 GLM-5 / DeepSeek / Kimi 这类要求 Preserved Thinking 的家族
 *   会以 `assistant.reasoning_content` 原样带回（见 thinkingPolicy.ts）。
 *
 * 一条硬约束贯穿全文：**每个 assistant.tool_calls[i].id 后面必须紧跟一条
 * 同 id 的 role:"tool" 消息**，否则严格网关（含 OpenAI 官方）直接 400。
 * Kiro 的历史不保证成对（用户可能中途取消工具），所以这里对没有结果的
 * tool_call 补发占位结果。
 */

import { AnthropicJsonSchema, CwAssistantResponseMessage, CwRequest, CwToolResult } from "./cwTypes";
import {
  getMaxTokens,
  getOpenaiMaxTokensField,
  getOpenaiReasoningEcho,
  getOpenaiReasoningEffort,
} from "./config";
import { ProviderConfig, bareModelId, overrideFor } from "./providers";
import { looksReasoningModel } from "./modelStore";
import {
  declaredEffortValues,
  forcedThinkingEffort,
  isForcedThinkingModel,
  wantsReasoningEcho,
} from "./thinkingPolicy";
import {
  buildUserText,
  latestModelId,
  parseToolSpec,
  resolveModelForProvider,
  toolResultToText,
} from "./translate";
import { EffortLevel } from "./modelStore";
import { activePromptText } from "./promptStore";

export type OpenaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenaiContentPart[] | null;
  tool_calls?: OpenaiToolCall[];
  tool_call_id?: string;
  /**
   * 上一轮的思考原文，只给要求回传的家族带（见 thinkingPolicy.wantsReasoningEcho）。
   * OpenAI 官方等严格网关不认这个字段。
   */
  reasoning_content?: string;
}

export interface OpenaiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: AnthropicJsonSchema;
  };
}

export interface OpenaiRequest {
  model: string;
  messages: OpenaiMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenaiTool[];
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  /**
   * 关思考的两种方言（用户在面板把该模型的「推理」手动设为「不支持」时才带）：
   *  - `enable_thinking:false`：SiliconFlow / 阿里百炼 / vLLM chat_template_kwargs 直通的网关；
   *  - `thinking:{type:"disabled"}`：智谱官方 / Z.ai / 部分 New API 中转。
   * 两个都带：不认识的网关会忽略未知字段（OpenAI 官方除外——官方模型不会被用户标成不支持推理）。
   */
  enable_thinking?: boolean;
  thinking?: { type: "enabled" | "disabled" };
}

/** tool_calls[].function.arguments 必须是字符串化的 JSON。 */
function stringifyArgs(input: unknown): string {
  if (typeof input === "string") {
    // 已是字符串：确认能解析，不能解析就退化成空对象（免得网关 400）。
    try {
      JSON.parse(input);
      return input;
    } catch {
      return "{}";
    }
  }
  if (input == null) {
    return "{}";
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

/**
 * 把上一轮 assistant 声明的 tool_call 与本轮 user 携带的 toolResults 配对，
 * 生成必须紧跟在 assistant 之后的 role:"tool" 消息。
 *
 * - 已声明且有结果 → 正常 tool 消息。
 * - 已声明但无结果（用户取消/Kiro 截断历史）→ 补占位，维持成对约束。
 * - 有结果但未声明（历史被裁剪掉了那轮 assistant）→ 不能发 role:"tool"
 *   （没有可引用的 tool_call_id），降级成 user 文本返回给调用方内联。
 */
function pairToolResults(
  pending: string[],
  results: CwToolResult[]
): { toolMsgs: OpenaiMessage[]; orphanText: string[] } {
  const byId = new Map<string, CwToolResult>();
  for (const tr of results) {
    if (tr && tr.toolUseId) {
      byId.set(tr.toolUseId, tr);
    }
  }

  const toolMsgs: OpenaiMessage[] = [];
  for (const id of pending) {
    const tr = byId.get(id);
    byId.delete(id);
    toolMsgs.push({
      role: "tool",
      tool_call_id: id,
      content: tr ? toolResultToText(tr.content) : "(tool call was not completed)",
    });
  }

  const orphanText: string[] = [];
  for (const tr of byId.values()) {
    const text = toolResultToText(tr.content);
    if (text) {
      orphanText.push(`[Tool result ${tr.toolUseId}]\n${text}`);
    }
  }
  return { toolMsgs, orphanText };
}

/** Kiro 历史里 assistant 那一轮的思考原文（嵌套 / 扁平两种形态都认；没有就是空串）。 */
function historyReasoningText(arm: CwAssistantResponseMessage): string {
  const rc = arm.reasoningContent;
  if (!rc) {
    return "";
  }
  if (typeof rc === "string") {
    return rc;
  }
  return rc.reasoningText?.text || "";
}

/** 该模型的历史 assistant 消息要不要带 reasoning_content（总开关 + 家族判定）。 */
export function shouldEchoReasoning(model: string): boolean {
  const pref = getOpenaiReasoningEcho();
  if (pref === "off") {
    return false;
  }
  if (pref === "always") {
    return true;
  }
  return wantsReasoningEcho(model);
}

/** 用户在面板里把该模型的「推理」**手动**设成了不支持（按上游 id 或 Kiro id 任一命中）。 */
export function userDisabledReasoning(provider: ProviderConfig, model: string, req: CwRequest): boolean {
  return (
    overrideFor(provider, model)?.reasoning === false ||
    overrideFor(provider, bareModelId(latestModelId(req)))?.reasoning === false
  );
}

/** Build an OpenAI /v1/chat/completions body from Kiro's CodeWhisperer request. */
export function buildOpenaiRequest(req: CwRequest, provider: ProviderConfig): OpenaiRequest {
  const state = req.conversationState;
  const items = [...(state.history || [])];
  if (state.currentMessage) {
    items.push(state.currentMessage);
  }

  const model = resolveModelForProvider(provider, latestModelId(req));
  const echoReasoning = shouldEchoReasoning(model);
  const messages: OpenaiMessage[] = [];
  let tools: OpenaiTool[] | undefined;
  // 上一条 assistant 声明了、但还没配上结果的 tool_call id。
  let pending: string[] = [];

  for (const item of items) {
    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      const results = uim.userInputMessageContext?.toolResults || [];
      const { toolMsgs, orphanText } = pairToolResults(pending, results);
      pending = [];
      messages.push(...toolMsgs);

      const parts: OpenaiContentPart[] = [];
      const textPieces: string[] = [...orphanText];
      const text = buildUserText(uim);
      if (text) {
        textPieces.push(text);
      }
      const joined = textPieces.join("\n\n");
      if (joined) {
        parts.push({ type: "text", text: joined });
      }

      for (const img of uim.images || []) {
        const mime = "image/" + (img.format || "png").toLowerCase();
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${img.source.bytes}` },
        });
      }

      if (parts.length > 0) {
        // 纯文本时发字符串而不是单元素数组：老网关对 content 数组的兼容性差些。
        const onlyText = parts.length === 1 && parts[0].type === "text";
        messages.push({
          role: "user",
          content: onlyText ? (parts[0] as { text: string }).text : parts,
        });
      }

      if (uim.userInputMessageContext?.tools) {
        tools = uim.userInputMessageContext.tools.map((spec) => {
          const { name, description, schema } = parseToolSpec(spec);
          const parameters: AnthropicJsonSchema = {
            type: "object",
            properties: schema?.properties ?? {},
          };
          if (schema?.required) {
            parameters.required = schema.required;
          }
          const fn: OpenaiTool["function"] = { name, parameters };
          if (description) {
            fn.description = description;
          }
          return { type: "function", function: fn };
        });
      }
    }

    if (item.assistantResponseMessage) {
      const arm = item.assistantResponseMessage;
      const toolCalls: OpenaiToolCall[] = (arm.toolUses || []).map((tu) => ({
        id: tu.toolUseId,
        type: "function" as const,
        function: { name: tu.name, arguments: stringifyArgs(tu.input) },
      }));

      const msg: OpenaiMessage = {
        role: "assistant",
        // 带 tool_calls 时 content 允许为 null；两者都空则给个占位，
        // 避免网关把「content 缺失」当非法消息。
        content: arm.content ? arm.content : toolCalls.length > 0 ? null : "(no content)",
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      // Preserved Thinking：原样带回，不改不删（Z.ai 明说编辑/重排会掉性能和缓存命中）。
      if (echoReasoning) {
        const reasoning = historyReasoningText(arm);
        if (reasoning) {
          msg.reasoning_content = reasoning;
        }
      }
      messages.push(msg);
      pending = toolCalls.map((tc) => tc.id);
    }
  }

  // 收尾：末尾 assistant 还有未配对的 tool_call（正常不会发生，Kiro 总是把
  // 工具结果放在 currentMessage 里），补齐以防严格网关拒收。
  if (pending.length > 0) {
    const { toolMsgs } = pairToolResults(pending, []);
    messages.push(...toolMsgs);
  }

  // 用户启用的提示词 → 首条 system 消息。Kiro 请求里没有 system，这就是上游看到的全部。
  const system = activePromptText();
  if (system) {
    messages.unshift({ role: "system", content: system });
  }

  const body: OpenaiRequest = {
    model,
    messages,
    stream: true,
    // 不带这个，多数实现的最后一帧不会给 usage，页脚就没数。
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const maxTokens = getMaxTokens();
  const field = getOpenaiMaxTokensField();
  if (field === "max_tokens" || field === "both") {
    body.max_tokens = maxTokens;
  }
  if (field === "max_completion_tokens" || field === "both") {
    body.max_completion_tokens = maxTokens;
  }

  // 用户在面板里把这个模型的「推理」**手动**设成了不支持 → 明确告诉上游别思考。
  // 只认手动覆盖，不认目录判定：目录说"不支持"多半是模型本来就不会思考，多带字段只会惹严格网关 400。
  // GLM-5.3 系关不掉，这两个字段对它无效（严格网关还会 400），改由 applyOpenaiEffort 压到 reasoning_effort:low。
  if (userDisabledReasoning(provider, model, req) && !isForcedThinkingModel(model)) {
    body.enable_thinking = false;
    body.thinking = { type: "disabled" };
  }

  return body;
}

/** Kiro 的 5 档 effort → OpenAI 的 3 档 reasoning_effort。 */
function mapEffort(effort: EffortLevel): "low" | "medium" | "high" {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      // high / xhigh / max 都落到 high：minimal 与 xhigh 是较新的取值，
      // 通用网关认不出会 400，这里保守取三档。
      return "high";
  }
}

/**
 * 按需给 OpenAI 请求加 `reasoning_effort`（或关思考的方言字段）。
 *
 * 必须谨慎：普通 chat 模型收到这个字段会直接 400（"unrecognized request
 * argument"），所以只在「模型看起来是 reasoning 模型」或用户显式指定档位时发。
 *
 * 取值的来源按优先级：
 *  1. 用户把该模型「推理」手动设为不支持 → 不发 effort（buildOpenaiRequest 已带关思考字段）；
 *     强制思考家族（GLM-5.3）关不掉，退而求其次发 low；
 *  2. 全局固定档位（openaiReasoningEffort=low/medium/high）；
 *  3. Kiro 选的档位：强制思考家族 → 无条件折到 low/high/max（不看目录）；
 *     目录声明了该模型的 effort 取值（选择器展示的就是它，含 none）→ 原样透传；
 *     其余：none → 关思考方言；推理模型 → 折到 low/medium/high。
 * Mutates `body` in place.
 */
export function applyOpenaiEffort(
  body: OpenaiRequest,
  effort: EffortLevel | undefined,
  provider?: ProviderConfig,
  req?: CwRequest
): void {
  const model = body.model;
  const forced = isForcedThinkingModel(model);

  if (provider && req && userDisabledReasoning(provider, model, req)) {
    if (forced) {
      body.reasoning_effort = "low";
    }
    return;
  }

  const pref = getOpenaiReasoningEffort();
  if (pref === "off") {
    return;
  }
  if (pref !== "auto") {
    // 用户显式选了档位：无条件发，责任在用户。GLM-5.3 不认 medium（会按 max 解析），先折一下。
    body.reasoning_effort = forced ? forcedThinkingEffort(pref) : pref;
    return;
  }
  if (!effort) {
    return;
  }
  // 强制思考家族先折：上游只认 low/high/max，medium 是硬 400（SiliconFlow 实测），
  // 目录里个别条目声明的 medium/xhigh 不能当真，所以这一步要排在目录透传之前。none 也落 low。
  if (forced) {
    body.reasoning_effort = forcedThinkingEffort(effort);
    return;
  }
  // Kiro 选择器里的档位来自目录声明（cpsServer.catalogEfforts），用户选的就是上游认的值，原样发。
  // 这一步必须排在下面的 none 方言之前：GPT-5.1+ 在目录里声明了 none（reasoning_effort:"none"），
  // 若先走 none 分支就会给 OpenAI 官方发 enable_thinking / thinking 这两个它不认的字段 → 400。
  const declared = declaredEffortValues(model);
  if (declared && declared.includes(effort)) {
    body.reasoning_effort = effort;
    return;
  }
  if (effort === "none") {
    body.enable_thinking = false;
    body.thinking = { type: "disabled" };
    return;
  }
  // 兜底：只有模型名看着像 reasoning 模型才发，且折成通用三档。
  if (looksReasoningModel(model, provider?.id)) {
    body.reasoning_effort = mapEffort(effort);
  }
}
