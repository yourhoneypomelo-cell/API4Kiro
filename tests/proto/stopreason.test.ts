/**
 * R7 / proxy-core 2.6：四协议流末必带 metadataEvent.stopReason；tokenUsage 必须嵌套形；
 * 输出 token 取 total − prompt 优先；turnLedger 整轮一条。
 */
import { AnthropicStreamConverter } from "../../src/anthropicStream";
import { OpenaiStreamConverter } from "../../src/openaiStream";
import { ResponsesStreamConverter } from "../../src/responsesStream";
import { GeminiStreamConverter } from "../../src/geminiStream";
import { buildMeteringEvents, resolveOutputTokens, toCwStopReason } from "../../src/streamShared";
import { addRequestUsage, beginTurn, resetAll, takeTurnTotals } from "../../src/turnLedger";
import { buildIntentClassifierResponse } from "../../src/intentClassifier";
import { cwRequest } from "./fixtures";
import { assertTrailingStopReason, eq, feedSse, ok, run, test, textOf, tokenUsageFrames, toolUsesOf } from "./harness";

// ---------------------------------------------------------------- Anthropic

test("anthropic: 纯文本 end_turn → END_TURN，tokenUsage 嵌套", () => {
  const c = new AnthropicStreamConverter("c1", "claude-x");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  eq(assertTrailingStopReason(evs, "anthropic end_turn"), "END_TURN", "END_TURN");
  eq(textOf(evs), "你好", "text");
  const tu = tokenUsageFrames(evs);
  eq(tu.length, 1, "one tokenUsage frame");
  eq(tu[0], { uncachedInputTokens: 100, outputTokens: 7, cacheReadInputTokens: 20, cacheWriteInputTokens: 5 }, "nested shape & values");
});

test("anthropic: max_tokens → MAX_TOKENS；stop_sequence → STOP_SEQUENCE", () => {
  for (const [raw, want] of [["max_tokens", "MAX_TOKENS"], ["stop_sequence", "STOP_SEQUENCE"], ["refusal", "END_TURN"]] as const) {
    const c = new AnthropicStreamConverter("c1", "m");
    const evs = feedSse(c, [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: raw }, usage: { output_tokens: 1 } },
    ]);
    eq(assertTrailingStopReason(evs, raw), want, raw);
  }
});

test("anthropic: tool_use 块 → toolUseEvent 且 TOOL_USE；sawToolUse=true", () => {
  const c = new AnthropicStreamConverter("c1", "m");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "readFile" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
  ]);
  eq(assertTrailingStopReason(evs, "tool"), "TOOL_USE", "TOOL_USE");
  eq(toolUsesOf(evs), [{ toolUseId: "tu1", name: "readFile", input: '{"path":"a.ts"}' }], "tool use event");
  ok(c.sawToolUse, "sawToolUse");
});

test("anthropic: 没有 message_delta 也必须有 stopReason（默认 END_TURN）", () => {
  const c = new AnthropicStreamConverter("c1", "m");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  ]);
  eq(assertTrailingStopReason(evs, "no message_delta"), "END_TURN", "default END_TURN");
});

test("anthropic: usage 只在 message_start 出现时 flush 兜底补 tokenUsage（修复项）", () => {
  const c = new AnthropicStreamConverter("c1", "m");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 9 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]);
  const tu = tokenUsageFrames(evs);
  eq(tu.length, 1, "exactly one tokenUsage frame from flush");
  eq(tu[0].uncachedInputTokens, 42, "input");
  eq(tu[0].outputTokens, 9, "output");
  // 且 tokenUsage 帧在 stopReason 帧之前
  const iTu = evs.findIndex((e) => e.metadataEvent?.tokenUsage);
  const iSr = evs.findIndex((e) => e.metadataEvent?.stopReason);
  ok(iTu < iSr, "tokenUsage before stopReason");
});

test("anthropic: message_delta 有 usage 时 flush 不重复发 tokenUsage", () => {
  const c = new AnthropicStreamConverter("c1", "m");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  ]);
  eq(tokenUsageFrames(evs).length, 1, "single tokenUsage frame");
});

test("anthropic: 思考块里发 text_delta（中转站错译）仍归到思考，anomaly 记录", () => {
  const c = new AnthropicStreamConverter("c1", "m");
  const evs = feedSse(c, [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "思考中" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig1" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正文" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  ]);
  eq(textOf(evs), "正文", "text only");
  eq(evs.map((e) => e.reasoningContentEvent?.text).filter(Boolean), ["思考中"], "thinking routed by block type");
  eq(evs.map((e) => e.reasoningContentEvent?.signature).filter(Boolean), ["sig1"], "signature emitted at block stop");
  ok(c.anomalies.has("text_in_thinking"), "anomaly flagged");
});

// ---------------------------------------------------------------- OpenAI Chat

function oaiChunk(delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) {
  return { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage };
}

test("openai: stop → END_TURN，usage 帧 → 嵌套 tokenUsage（uncached = prompt − cached）", () => {
  const c = new OpenaiStreamConverter("c1", "gpt-x", { thoughtDedupe: "off" });
  const evs = feedSse(c, [
    oaiChunk({ role: "assistant", content: "" }),
    oaiChunk({ content: "Hello" }),
    oaiChunk({}, "stop"),
    { id: "x", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_tokens_details: { cached_tokens: 30 } } },
    "data: [DONE]",
  ]);
  eq(assertTrailingStopReason(evs, "openai stop"), "END_TURN", "END_TURN");
  eq(textOf(evs), "Hello", "text");
  const tu = tokenUsageFrames(evs);
  eq(tu.length, 1, "one tokenUsage");
  eq(tu[0], { uncachedInputTokens: 20, outputTokens: 5, cacheReadInputTokens: 30, cacheWriteInputTokens: 0 }, "values");
});

test("openai: length → MAX_TOKENS；tool_calls → TOOL_USE 且参数按 index 累加", () => {
  const c1 = new OpenaiStreamConverter("c1", "m", { thoughtDedupe: "off" });
  const e1 = feedSse(c1, [oaiChunk({ content: "trunc" }), oaiChunk({}, "length")]);
  eq(assertTrailingStopReason(e1, "length"), "MAX_TOKENS", "MAX_TOKENS");

  const c2 = new OpenaiStreamConverter("c1", "m", { thoughtDedupe: "off" });
  const e2 = feedSse(c2, [
    oaiChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }] }),
    oaiChunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "write", arguments: '{"p":' } }] }),
    oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"f":1}' } }] }),
    oaiChunk({ tool_calls: [{ index: 1, function: { arguments: "2}" } }] }),
    oaiChunk({}, "tool_calls"),
  ]);
  eq(assertTrailingStopReason(e2, "tool_calls"), "TOOL_USE", "TOOL_USE");
  eq(toolUsesOf(e2), [
    { toolUseId: "call_a", name: "read", input: '{"f":1}' },
    { toolUseId: "call_b", name: "write", input: '{"p":2}' },
  ], "two tool uses, interleaved args merged");
});

test("openai: 网关无视 stream 整包 JSON 回复 → flush 兜底解析并带 stopReason", () => {
  const c = new OpenaiStreamConverter("c1", "m", { thoughtDedupe: "off" });
  const body = JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "whole" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  const evs = [...c.processLine(body), ...c.flush()];
  eq(textOf(evs), "whole", "text parsed from raw JSON");
  eq(assertTrailingStopReason(evs, "raw json"), "END_TURN", "stopReason");
});

// ---------------------------------------------------------------- Responses

test("responses: completed → END_TURN；incomplete(max_output_tokens) → MAX_TOKENS；function_call → TOOL_USE", () => {
  const a = new ResponsesStreamConverter("c1", "gpt-5");
  const ea = feedSse(a, [
    { type: "response.created", response: { id: "r" } },
    { type: "response.output_text.delta", item_id: "m1", delta: "Hi" },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 4 } } } },
  ]);
  eq(assertTrailingStopReason(ea, "completed"), "END_TURN", "END_TURN");
  eq(tokenUsageFrames(ea)[0], { uncachedInputTokens: 6, outputTokens: 4, cacheReadInputTokens: 4, cacheWriteInputTokens: 0 }, "usage");

  const b = new ResponsesStreamConverter("c1", "gpt-5");
  const eb = feedSse(b, [
    { type: "response.output_text.delta", item_id: "m1", delta: "Hi" },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  eq(assertTrailingStopReason(eb, "incomplete"), "MAX_TOKENS", "MAX_TOKENS");

  const c = new ResponsesStreamConverter("c1", "gpt-5");
  const ec = feedSse(c, [
    { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "ls", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"dir":' },
    { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '"."}' },
    { type: "response.function_call_arguments.done", item_id: "fc1", arguments: '{"dir":"."}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "ls", arguments: '{"dir":"."}' } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  eq(assertTrailingStopReason(ec, "function_call"), "TOOL_USE", "TOOL_USE");
  eq(toolUsesOf(ec), [{ toolUseId: "call_1", name: "ls", input: '{"dir":"."}' }], "tool use once");
});

// ---------------------------------------------------------------- Gemini

test("gemini: STOP → END_TURN；MAX_TOKENS → MAX_TOKENS；functionCall → TOOL_USE；usageMetadata → tokenUsage(含 thoughts)", () => {
  const a = new GeminiStreamConverter("c1", "gemini-3-flash");
  const ea = feedSse(a, [
    { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] },
    { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 30, cachedContentTokenCount: 40 } },
  ]);
  eq(assertTrailingStopReason(ea, "STOP"), "END_TURN", "END_TURN");
  eq(tokenUsageFrames(ea)[0], { uncachedInputTokens: 60, outputTokens: 40, cacheReadInputTokens: 40, cacheWriteInputTokens: 0 }, "usage: out = candidates + thoughts");

  const b = new GeminiStreamConverter("c1", "gemini-3-flash");
  const eb = feedSse(b, [{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }]);
  eq(assertTrailingStopReason(eb, "MAX_TOKENS"), "MAX_TOKENS", "MAX_TOKENS");

  const c = new GeminiStreamConverter("c1", "gemini-3-flash");
  const ec = feedSse(c, [{ candidates: [{ content: { parts: [{ functionCall: { id: "fc-1", name: "read", args: { p: 1 } } }] }, finishReason: "STOP" }] }]);
  eq(assertTrailingStopReason(ec, "functionCall"), "TOOL_USE", "TOOL_USE");
  eq(toolUsesOf(ec), [{ toolUseId: "fc-1", name: "read", input: '{"p":1}' }], "tool use");

  // Antigravity 信封 {response:{...}} 也认
  const d = new GeminiStreamConverter("c1", "gemini-3-flash");
  const ed = feedSse(d, [{ response: { candidates: [{ content: { parts: [{ text: "env" }] }, finishReason: "STOP" }] } }]);
  eq(textOf(ed), "env", "envelope unwrapped");
  assertTrailingStopReason(ed, "envelope");
});

// ---------------------------------------------------------------- 本地应答路径

test("intentClassifier 本地应答带 stopReason", () => {
  const req = cwRequest("You are an intent classifier for a language model ... (chat, do, spec) Here is the last user message: fix bug");
  const evs = buildIntentClassifierResponse(req, "c1", "m");
  eq(assertTrailingStopReason(evs, "intent"), "END_TURN", "END_TURN");
});

// ---------------------------------------------------------------- 归一函数

test("toCwStopReason: 各家原始值归一；认不出 → END_TURN；sawToolUse 优先", () => {
  eq(toCwStopReason("end_turn", false), "END_TURN", "end_turn");
  eq(toCwStopReason("stop", false), "END_TURN", "stop");
  eq(toCwStopReason("length", false), "MAX_TOKENS", "length");
  eq(toCwStopReason("max_output_tokens", false), "MAX_TOKENS", "max_output_tokens");
  eq(toCwStopReason("function_call", false), "TOOL_USE", "function_call");
  eq(toCwStopReason("stop_sequence", false), "STOP_SEQUENCE", "stop_sequence");
  eq(toCwStopReason(undefined, false), "END_TURN", "undefined");
  eq(toCwStopReason("weird", false), "END_TURN", "unknown");
  eq(toCwStopReason("stop", true), "TOOL_USE", "sawToolUse wins");
});

test("resolveOutputTokens: total − prompt 优先；退 completion + reasoning；再退 completion；billing_usage 嵌套优先", () => {
  eq(resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125, total_tokens: 11928, completion_tokens_details: { reasoning_tokens: 11773 } }), 11898, "total - prompt");
  eq(resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125, completion_tokens_details: { reasoning_tokens: 100 } }), 225, "completion + reasoning when no total");
  eq(resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125 }), 125, "completion only");
  eq(resolveOutputTokens({ input_tokens: 10, output_tokens: 5, billing_usage: { openai_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 315 } } }), 305, "nested billing_usage wins");
  eq(resolveOutputTokens({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 120 }), 50, "total-prompt < completion → max(completion)");
  eq(resolveOutputTokens(undefined), 0, "undefined → 0");
});

// ---------------------------------------------------------------- turnLedger

test("turnLedger: 三次迭代只结一次账，总量为和；新轮 beginTurn 清空", () => {
  resetAll();
  beginTurn("conv");
  addRequestUsage("conv", { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 1 });
  addRequestUsage("conv", { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });
  addRequestUsage("conv", { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 });
  const total = takeTurnTotals("conv");
  eq(total, { inputTokens: 600, outputTokens: 60, cacheReadTokens: 5, cacheCreationTokens: 1 }, "summed");
  eq(takeTurnTotals("conv"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, "taken → empty");

  addRequestUsage("conv", { inputTokens: 999, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
  beginTurn("conv"); // 新轮：上一轮泄漏的 999 被清掉
  addRequestUsage("conv", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
  eq(takeTurnTotals("conv").inputTokens, 1, "beginTurn resets leaked usage");

  const met = buildMeteringEvents({ inputTokens: 600, outputTokens: 60, cacheReadTokens: 5, cacheCreationTokens: 1 });
  eq(met.length, 1, "exactly one meteringEvent");
  eq(met[0].meteringEvent?.usage, 666, "usage = in(incl. cache) + out");
  eq(met[0].meteringEvent?.unit, "token", "unit stable");
  ok(/in 606 \/ out 60/.test(met[0].meteringEvent?.unitPlural || ""), "decomposition inside unitPlural");
  eq(buildMeteringEvents({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), [], "zero → none");
});

test("meteringUsage 口径：Anthropic 保留缓存字段；OpenAI/Responses/Gemini 清零缓存（prompt 已含）", () => {
  const a = new AnthropicStreamConverter("c", "m");
  feedSse(a, [{ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }]);
  eq(a.meteringUsage().cacheReadTokens, 5, "anthropic keeps cache");
  const o = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
  feedSse(o, [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } } }]);
  eq(o.usage.cacheReadTokens, 5, "openai raw usage keeps cache");
  eq(o.meteringUsage().cacheReadTokens, 0, "openai metering zeroes cache");
  eq(o.meteringUsage().inputTokens, 10, "openai metering input = prompt");
});

void run();
