/**
 * Responses 通路：mapEffort 目录透传 / 折档（修复项）、多段摘要分隔（修复项）、encrypted_content 签名往返、
 * function_call 成对约束。
 */
import * as vscode from "vscode";
import { resetCatalogForTest } from "../../src/modelCatalog";
import { ResponsesStreamConverter, SUMMARY_PART_SEPARATOR } from "../../src/responsesStream";
import {
  applyResponsesEffort,
  buildResponsesRequest,
  decodeReasoningSignature,
  encodeReasoningSignature,
  mapResponsesEffort,
} from "../../src/responsesTranslate";
import { assistant, cwRequest, provider, toolResult, toolUse, user } from "./fixtures";
import { assertTrailingStopReason, eq, feedSse, ok, reasoningOf, run, signaturesOf, test, textOf, toolUsesOf } from "./harness";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void };
const pr = provider({ protocol: "openai", openaiApi: "responses", baseUrl: "https://api.openai.com/v1" });

function seedCatalog(): void {
  resetCatalogForTest([
    {
      id: "gpt-5.2",
      family: "gpt-5.2",
      input: { text: true, image: true, pdf: false, audio: false, video: false },
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    },
    {
      id: "o3",
      input: { text: true, image: true, pdf: false, audio: false, video: false },
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    },
  ]);
}

test("mapResponsesEffort: 目录声明的档位原样透传（xhigh / none 不再折成 high）", () => {
  seedCatalog();
  eq(mapResponsesEffort("xhigh", "gpt-5.2"), "xhigh", "xhigh passthrough");
  eq(mapResponsesEffort("none", "gpt-5.2"), "none", "none passthrough");
  eq(mapResponsesEffort("high", "gpt-5.2"), "high", "high");
  eq(mapResponsesEffort("low", "gpt-5.2"), "low", "low");
  eq(mapResponsesEffort("medium", "gpt-5.2"), "medium", "medium");
  // 目录没声明 max：折到 high（不会发上游不认的 max）
  eq(mapResponsesEffort("max", "gpt-5.2"), "high", "max not declared → high");
  resetCatalogForTest([]);
});

test("mapResponsesEffort: 目录未命中时保守折叠 none→low、xhigh/max→high；o3 不透传 xhigh", () => {
  resetCatalogForTest([]);
  eq(mapResponsesEffort("none", "unknown-reasoner"), "low", "none → low (was: high)");
  eq(mapResponsesEffort("low", "unknown-reasoner"), "low", "low");
  eq(mapResponsesEffort("medium", "unknown-reasoner"), "medium", "medium");
  eq(mapResponsesEffort("high", "unknown-reasoner"), "high", "high");
  eq(mapResponsesEffort("xhigh", "unknown-reasoner"), "high", "xhigh → high");
  eq(mapResponsesEffort("max", "unknown-reasoner"), "high", "max → high");
  seedCatalog();
  eq(mapResponsesEffort("xhigh", "o3"), "high", "o3 catalog lacks xhigh → high");
  eq(mapResponsesEffort("none", "o3"), "low", "o3 catalog lacks none → low");
  resetCatalogForTest([]);
});

test("applyResponsesEffort: auto 只对推理模型加 reasoning 且带 summary:auto；off 不加；固定档位无条件加", () => {
  seedCatalog();
  stub.__resetConfig();
  const b1 = buildResponsesRequest(cwRequest("hi", { modelId: "gpt-5.2" }), pr);
  applyResponsesEffort(b1, "xhigh");
  eq(b1.reasoning, { effort: "xhigh", summary: "auto" }, "xhigh reaches wire");

  const b2 = buildResponsesRequest(cwRequest("hi", { modelId: "plain-chat-model" }), pr);
  applyResponsesEffort(b2, "high");
  eq(b2.reasoning, undefined, "non-reasoning model gets no reasoning field");

  stub.__setConfig("openaiReasoningEffort", "off");
  const b3 = buildResponsesRequest(cwRequest("hi", { modelId: "gpt-5.2" }), pr);
  applyResponsesEffort(b3, "high");
  eq(b3.reasoning, undefined, "off");

  stub.__setConfig("openaiReasoningEffort", "low");
  const b4 = buildResponsesRequest(cwRequest("hi", { modelId: "plain-chat-model" }), pr);
  applyResponsesEffort(b4, "high");
  eq(b4.reasoning, { effort: "low", summary: "auto" }, "fixed pref");
  stub.__resetConfig();
  resetCatalogForTest([]);
});

test("多段 reasoning summary：part.done 之后同 item 的下一段前补分隔；段末不多余；跨 item 不串", () => {
  const c = new ResponsesStreamConverter("c1", "gpt-5.2");
  const evs = feedSse(c, [
    { type: "response.output_item.added", item: { type: "reasoning", id: "rs1" } },
    { type: "response.reasoning_summary_part.added", item_id: "rs1", part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "**标题A**" },
    { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: " 内容A" },
    { type: "response.reasoning_summary_text.done", item_id: "rs1", text: "**标题A** 内容A" },
    { type: "response.reasoning_summary_part.done", item_id: "rs1", part: { type: "summary_text", text: "**标题A** 内容A" } },
    { type: "response.reasoning_summary_part.added", item_id: "rs1", part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "**标题B**" },
    { type: "response.reasoning_summary_text.done", item_id: "rs1", text: "**标题B**" },
    { type: "response.reasoning_summary_part.done", item_id: "rs1", part: { type: "summary_text", text: "**标题B**" } },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "**标题A** 内容A" }, { type: "summary_text", text: "**标题B**" }], encrypted_content: "ENC" } },
    { type: "response.output_text.delta", item_id: "m1", delta: "答" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  eq(reasoningOf(evs), `**标题A** 内容A${SUMMARY_PART_SEPARATOR}**标题B**`, "separator between parts, none trailing");
  eq(textOf(evs), "答", "text");
  eq(signaturesOf(evs), [encodeReasoningSignature("ENC")], "encrypted_content → a2k-rs: signature once");
  // done 里的 summary 不会重复补发（已见过 delta）
  eq(evs.filter((e) => e.reasoningContentEvent?.text).length, 4, "3 deltas + 1 separator, no re-emit from item.done");
  assertTrailingStopReason(evs, "summary parts");
});

test("只有 done 里给 summary（无 delta）的网关：多段用分隔连接；只有签名无文本 → 占位空格 + 签名", () => {
  const c = new ResponsesStreamConverter("c1", "gpt-5.2");
  const evs = feedSse(c, [
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "A" }, { type: "summary_text", text: "B" }] } },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs2", summary: [], encrypted_content: "E2" } },
    { type: "response.completed", response: {} },
  ]);
  const texts = evs.map((e) => e.reasoningContentEvent?.text).filter((t): t is string => typeof t === "string");
  eq(texts[0], `A${SUMMARY_PART_SEPARATOR}B`, "joined with separator");
  eq(texts[1], " ", "placeholder before signature-only item");
  eq(signaturesOf(evs), [encodeReasoningSignature("E2")], "signature");
  assertTrailingStopReason(evs, "done-only");
});

test("签名往返：a2k-rs: 进历史 → 下一轮回放 reasoning item（encrypted_content）放在 function_call 之前；Anthropic/合成签名跳过", () => {
  const sig = encodeReasoningSignature("ENCRYPTED");
  const history = [
    user("do"),
    assistant("", { toolUses: [toolUse("call_1", "ls", { d: "." })], reasoningContent: { reasoningText: { text: "sum", signature: sig } } }),
  ];
  const body = buildResponsesRequest(cwRequest("ok", { modelId: "gpt-5.2", history, toolResults: [toolResult("call_1", "files")] }), pr);
  const types = body.input.map((i) => ("type" in i ? i.type : i.role));
  eq(types, ["user", "reasoning", "function_call", "function_call_output", "user"], "order: reasoning before function_call, output right after");
  const rs = body.input[1] as { type: "reasoning"; encrypted_content: string; summary: unknown[] };
  eq(rs.encrypted_content, "ENCRYPTED", "decoded");
  eq(rs.summary, [], "summary empty on replay");
  eq(body.store, false, "stateless");
  eq(body.include, ["reasoning.encrypted_content"], "ask upstream to return encrypted_content");

  const foreign = buildResponsesRequest(cwRequest("ok", { modelId: "gpt-5.2", history: [user("u"), assistant("a", { reasoningContent: { reasoningText: { text: "t", signature: "api4kiro:unsigned-reasoning" } } })] }), pr);
  ok(!foreign.input.some((i) => "type" in i && i.type === "reasoning"), "synthetic signature not replayed");
  const anth = buildResponsesRequest(cwRequest("ok", { modelId: "gpt-5.2", history: [user("u"), assistant("a", { reasoningContent: { reasoningText: { text: "t", signature: "ErUBCkYIBxgC" } } })] }), pr);
  ok(!anth.input.some((i) => "type" in i && i.type === "reasoning"), "anthropic signature not replayed");
  eq(decodeReasoningSignature("a2k-gm:x"), undefined, "gemini prefix ignored");
});

test("成对约束：无结果的 function_call 补占位 output；孤儿结果降级成 user 文本", () => {
  const history = [user("u"), assistant("", { toolUses: [toolUse("c1", "a", {}), toolUse("c2", "b", {})] })];
  const body = buildResponsesRequest(cwRequest("next", { modelId: "gpt-5.2", history, toolResults: [toolResult("c1", "R1"), toolResult("orphan", "ORPHAN")] }), pr);
  const outs = body.input.filter((i) => "type" in i && i.type === "function_call_output") as Array<{ call_id: string; output: string }>;
  eq(outs.map((o) => o.call_id), ["c1", "c2"], "one output per call, in order");
  eq(outs[1].output, "(tool call was not completed)", "placeholder for missing result");
  const lastUser = body.input[body.input.length - 1] as { role: string; content: Array<{ type: string; text?: string }> };
  ok(lastUser.content[0].text!.includes("[Tool result orphan]") && lastUser.content[0].text!.includes("ORPHAN") && lastUser.content[0].text!.includes("next"), "orphan inlined into user text");
});

test("Responses 流：整包 JSON 兜底解析 output[]（message / function_call / reasoning）", () => {
  const c = new ResponsesStreamConverter("c1", "gpt-5.2");
  const body = JSON.stringify({
    id: "r", object: "response", status: "completed",
    output: [
      { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "S1" }, { type: "summary_text", text: "S2" }], encrypted_content: "E" },
      { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "function_call", id: "fc", call_id: "call_x", name: "run", arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 5, output_tokens: 3 },
  });
  const evs = [...c.processLine(body), ...c.flush()];
  eq(reasoningOf(evs), `S1${SUMMARY_PART_SEPARATOR}S2`, "summary joined");
  eq(textOf(evs), "hello", "text");
  eq(toolUsesOf(evs), [{ toolUseId: "call_x", name: "run", input: '{"a":1}' }], "tool");
  eq(assertTrailingStopReason(evs, "raw"), "TOOL_USE", "TOOL_USE");
});

void run();
