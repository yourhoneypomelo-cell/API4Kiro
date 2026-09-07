/**
 * Kiro CodeWhisperer 请求 → OpenAI **Responses** API（/v1/responses）请求体。
 *
 * 与 Chat Completions（openaiTranslate.ts）的形态差异，逐条对应：
 * - 消息不叫 messages 叫 `input`，是一串「item」：
 *     user 消息   `{role:"user", content:[{type:"input_text",text}|{type:"input_image",image_url}]}`
 *     助手文本    `{role:"assistant", content:[{type:"output_text",text}]}`
 *     工具调用    `{type:"function_call", call_id, name, arguments}`   ← 独立 item，不挂在助手消息上
 *     工具结果    `{type:"function_call_output", call_id, output}`     ← 也是独立 item，无 role
 *     推理回放    `{type:"reasoning", summary:[], encrypted_content}`  ← 见下
 * - 工具声明是扁平的 `{type:"function", name, description, parameters}`（chat 是嵌在 function 下）
 * - 系统提示词走顶层 `instructions`
 * - 限长叫 `max_output_tokens`；思考档位是 `reasoning:{effort}`
 * - `store:false`：无状态，每次全量带历史，与 chat 一致；此时 OpenAI 要求回放推理必须带
 *   `encrypted_content`，故请求 `include:["reasoning.encrypted_content"]` 让上游把它吐回来。
 *
 * 推理回放：GPT-5 一类推理模型在工具循环里，若 function_call item 前没有它当时的 reasoning
 * item，官方接口会 400。我们把流里 `output_item.done(reasoning)` 的 encrypted_content 当作
 * 「签名」塞进 Kiro 历史的 reasoningContent.signature（同 Anthropic thinking 签名的存法，
 * Kiro 只保留带签名的推理），下一轮从历史里解出来还原成 reasoning item 放在 function_call 前。
 * 中转站不回 encrypted_content 时就没有 reasoning item（多数中转站也不校验）。
 *
 * 成对约束同 chat：每个 function_call 后面必须有同 call_id 的 function_call_output，
 * Kiro 历史里没有结果的补占位。
 */

import { AnthropicJsonSchema, CwRequest, CwToolResult } from "./cwTypes";
import { getMaxTokens, getOpenaiReasoningEffort } from "./config";
import { ProviderConfig } from "./providers";
import { EffortLevel, looksReasoningModel } from "./modelStore";
import { buildUserText, latestModelId, parseToolSpec, resolveModelForProvider, toolResultToText } from "./translate";
import { activePromptText } from "./promptStore";
import { declaredEffortValues } from "./thinkingPolicy";

export type ResponsesInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type ResponsesInputItem =
  | { role: "user" | "assistant"; content: ResponsesInputPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: Array<{ type: "summary_text"; text: string }>; encrypted_content: string };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: AnthropicJsonSchema;
  strict?: boolean;
}

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  stream: boolean;
  store: boolean;
  include?: string[];
  max_output_tokens?: number;
  reasoning?: { effort: string; summary?: string };
}

/** 推理签名的封装：我们塞进 Kiro 历史 signature 字段的字符串，能认出来才回放。 */
const SIG_PREFIX = "a2k-rs:";

export function encodeReasoningSignature(encryptedContent: string): string {
  return SIG_PREFIX + encryptedContent;
}

export function decodeReasoningSignature(sig: string | undefined): string | undefined {
  if (typeof sig !== "string" || !sig.startsWith(SIG_PREFIX)) {
    return undefined;
  }
  const enc = sig.slice(SIG_PREFIX.length);
  return enc ? enc : undefined;
}

function stringifyArgs(input: unknown): string {
  if (typeof input === "string") {
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

/** 同 chat：把上一条助手的 function_call 与本轮 toolResults 配对；无结果补占位；孤儿结果降级成文本。 */
function pairToolResults(
  pending: string[],
  results: CwToolResult[]
): { items: ResponsesInputItem[]; orphanText: string[] } {
  const byId = new Map<string, CwToolResult>();
  for (const tr of results) {
    if (tr && tr.toolUseId) {
      byId.set(tr.toolUseId, tr);
    }
  }
  const items: ResponsesInputItem[] = [];
  for (const id of pending) {
    const tr = byId.get(id);
    byId.delete(id);
    items.push({
      type: "function_call_output",
      call_id: id,
      output: tr ? toolResultToText(tr.content) : "(tool call was not completed)",
    });
  }
  const orphanText: string[] = [];
  for (const tr of byId.values()) {
    const text = toolResultToText(tr.content);
    if (text) {
      orphanText.push(`[Tool result ${tr.toolUseId}]\n${text}`);
    }
  }
  return { items, orphanText };
}

export function buildResponsesRequest(req: CwRequest, provider: ProviderConfig): ResponsesRequest {
  const state = req.conversationState;
  const items = [...(state.history || [])];
  if (state.currentMessage) {
    items.push(state.currentMessage);
  }

  const input: ResponsesInputItem[] = [];
  let tools: ResponsesTool[] | undefined;
  let pending: string[] = [];

  for (const item of items) {
    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      const results = uim.userInputMessageContext?.toolResults || [];
      const paired = pairToolResults(pending, results);
      pending = [];
      input.push(...paired.items);

      const parts: ResponsesInputPart[] = [];
      const textPieces: string[] = [...paired.orphanText];
      const text = buildUserText(uim);
      if (text) {
        textPieces.push(text);
      }
      const joined = textPieces.join("\n\n");
      if (joined) {
        parts.push({ type: "input_text", text: joined });
      }
      for (const img of uim.images || []) {
        const mime = "image/" + (img.format || "png").toLowerCase();
        parts.push({ type: "input_image", image_url: `data:${mime};base64,${img.source.bytes}` });
      }
      if (parts.length > 0) {
        input.push({ role: "user", content: parts });
      }

      if (uim.userInputMessageContext?.tools) {
        tools = uim.userInputMessageContext.tools.map((spec) => {
          const { name, description, schema } = parseToolSpec(spec);
          const parameters: AnthropicJsonSchema = { type: "object", properties: schema?.properties ?? {} };
          if (schema?.required) {
            parameters.required = schema.required;
          }
          const t: ResponsesTool = { type: "function", name, parameters, strict: false };
          if (description) {
            t.description = description;
          }
          return t;
        });
      }
    }

    if (item.assistantResponseMessage) {
      const arm = item.assistantResponseMessage;
      // 推理回放：只认我们自己写进去的 encrypted_content 签名；Anthropic 的签名或无签名一律跳过。
      const rc = arm.reasoningContent;
      const sig =
        rc && typeof rc === "object" ? rc.reasoningText?.signature ?? arm.reasoningSignature : arm.reasoningSignature;
      const enc = decodeReasoningSignature(sig);
      if (enc) {
        input.push({ type: "reasoning", summary: [], encrypted_content: enc });
      }
      if (arm.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: arm.content }] });
      }
      const calls = arm.toolUses || [];
      for (const tu of calls) {
        input.push({ type: "function_call", call_id: tu.toolUseId, name: tu.name, arguments: stringifyArgs(tu.input) });
      }
      if (!arm.content && calls.length === 0 && !enc) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: "(no content)" }] });
      }
      pending = calls.map((tu) => tu.toolUseId);
    }
  }

  if (pending.length > 0) {
    input.push(...pairToolResults(pending, []).items);
  }

  const model = resolveModelForProvider(provider, latestModelId(req));
  const body: ResponsesRequest = {
    model,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: getMaxTokens(),
  };
  const system = activePromptText();
  if (system) {
    body.instructions = system;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  return body;
}

/**
 * Kiro 档位 → Responses `reasoning.effort`。
 *
 * Kiro 选择器里的档位来自目录声明（cpsServer.catalogEfforts），用户选中的值在目录声明里时
 * **原样透传**——与 Chat 通路（openaiTranslate.applyOpenaiEffort）同一规则。此前这里无条件折成
 * low/medium/high：用户在 GPT-5.x 上选 xhigh / Max 实发 high，选 none 反而发成 high（default 分支）。
 *
 * 目录没声明时才折叠：none→low、xhigh/max→high（OpenAI 之外的 Responses 网关未必认 none / xhigh，
 * 而 Kiro 只会展示我们广播的档位，走到这里多半是换模型后沿用了上一轮的会话缓存档位）。
 */
export function mapResponsesEffort(effort: EffortLevel, model: string): string {
  const declared = declaredEffortValues(model);
  if (declared && declared.includes(effort)) {
    return effort;
  }
  switch (effort) {
    case "none":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/**
 * 按需加 `reasoning.effort`。与 chat 侧同一套开关（openaiReasoningEffort）：
 * auto 时只对看着像推理模型的加；普通模型收到 reasoning 字段可能 400。
 * 顺带要 `summary:"auto"`，不然 Responses 默认不吐推理摘要，思考过程在 Kiro 里就看不见。
 */
export function applyResponsesEffort(body: ResponsesRequest, effort: EffortLevel | undefined): void {
  const pref = getOpenaiReasoningEffort();
  if (pref === "off") {
    return;
  }
  if (pref !== "auto") {
    body.reasoning = { effort: pref, summary: "auto" };
    return;
  }
  if (effort && looksReasoningModel(body.model)) {
    body.reasoning = { effort: mapResponsesEffort(effort, body.model), summary: "auto" };
  }
}
