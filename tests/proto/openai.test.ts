/**
 * model-gating 3.x：GLM-5.3 强制思考三档折算、reasoning_content 回传白名单、合成签名跳过、
 * thought gate（openaiThoughtDedupe off / exact / aggressive）。
 */
import * as vscode from "vscode";
import { resetCatalogForTest } from "../../src/modelCatalog";
import { OpenaiStreamConverter, reasoningLooksLikeAnswer } from "../../src/openaiStream";
import { applyOpenaiEffort, buildOpenaiRequest, shouldEchoReasoning, userDisabledReasoning } from "../../src/openaiTranslate";
import {
  SYNTHETIC_REASONING_SIGNATURE,
  classifyReasoningHead,
  forcedThinkingEffort,
  isForcedThinkingModel,
  isSyntheticSignature,
  wantsReasoningEcho,
} from "../../src/thinkingPolicy";
import { buildAnthropicRequest } from "../../src/translate";
import { assistant, cwRequest, provider, toolResult, toolUse, user } from "./fixtures";
import { assertTrailingStopReason, eq, feedSse, ok, reasoningOf, run, signaturesOf, test, textOf } from "./harness";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void };
const po = provider({ protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" });

// ---------------------------------------------------------------- GLM 强制思考

test("isForcedThinkingModel: GLM-5.3 系（含厂商前缀 / flash / highspeed）；GLM-5 / 4.7 不算", () => {
  ok(isForcedThinkingModel("zai-org/GLM-5.3-Flash"), "prefixed flash");
  ok(isForcedThinkingModel("glm-5.3"), "bare");
  ok(isForcedThinkingModel("GLM_5.3-highspeed"), "underscore");
  ok(!isForcedThinkingModel("glm-5"), "glm-5 not forced");
  ok(!isForcedThinkingModel("glm-4.7"), "4.7 not forced");
  ok(!isForcedThinkingModel("deepseek-v4"), "deepseek not forced");
});

test("forcedThinkingEffort: 五档 → 只有 low/high/max；medium→high；xhigh→max", () => {
  eq(forcedThinkingEffort("none"), "low", "none");
  eq(forcedThinkingEffort("minimal"), "low", "minimal");
  eq(forcedThinkingEffort("low"), "low", "low");
  eq(forcedThinkingEffort("medium"), "high", "medium → high");
  eq(forcedThinkingEffort("high"), "high", "high");
  eq(forcedThinkingEffort("xhigh"), "max", "xhigh → max");
  eq(forcedThinkingEffort("max"), "max", "max");
  for (const e of ["none", "low", "medium", "high", "xhigh", "max", "weird"]) {
    ok(["low", "high", "max"].includes(forcedThinkingEffort(e)), `never sends '${forcedThinkingEffort(e)}'`);
  }
});

test("applyOpenaiEffort: GLM 折三档，不看目录；不发 enable_thinking/thinking 关思考字段", () => {
  stub.__resetConfig();
  resetCatalogForTest([
    { id: "glm-5.3-flash", input: { text: true, image: false, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] },
  ]);
  const req = cwRequest("hi", { modelId: "zai-org/GLM-5.3-Flash" });
  for (const [kiro, want] of [["none", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"]] as const) {
    const body = buildOpenaiRequest(req, po);
    applyOpenaiEffort(body, kiro, po, req);
    eq(body.reasoning_effort, want, `${kiro} → ${want}`);
    ok(body.enable_thinking === undefined && body.thinking === undefined, `${kiro}: no disable fields on forced family`);
  }
  resetCatalogForTest([]);
});

test("applyOpenaiEffort: GLM 手动标「不支持推理」→ reasoning_effort:low，且 buildOpenaiRequest 不带 disable 字段", () => {
  stub.__resetConfig();
  const p = provider({ protocol: "openai", modelOverrides: { "zai-org/GLM-5.3-Flash": { reasoning: false } } });
  const req = cwRequest("hi", { modelId: "zai-org/GLM-5.3-Flash", effort: "high" });
  ok(userDisabledReasoning(p, "zai-org/GLM-5.3-Flash", req), "override detected");
  const body = buildOpenaiRequest(req, p);
  ok(body.enable_thinking === undefined && body.thinking === undefined, "forced family: no enable_thinking:false / thinking:disabled");
  applyOpenaiEffort(body, "high", p, req);
  eq(body.reasoning_effort, "low", "disabled on forced → low");
});

test("applyOpenaiEffort: 非强制模型手动「不支持」→ 两个关思考方言字段、无 effort；Kiro 选 none 同理", () => {
  stub.__resetConfig();
  const p = provider({ protocol: "openai", modelOverrides: { "qwen3-thinking": { reasoning: false } } });
  const req = cwRequest("hi", { modelId: "qwen3-thinking" });
  const body = buildOpenaiRequest(req, p);
  eq(body.enable_thinking, false, "enable_thinking:false");
  eq(body.thinking, { type: "disabled" }, "thinking:disabled");
  applyOpenaiEffort(body, "high", p, req);
  eq(body.reasoning_effort, undefined, "no effort when disabled");

  const req2 = cwRequest("hi", { modelId: "deepseek-reasoner" });
  const b2 = buildOpenaiRequest(req2, po);
  applyOpenaiEffort(b2, "none", po, req2);
  eq(b2.enable_thinking, false, "none → enable_thinking:false");
  eq(b2.reasoning_effort, undefined, "none → no effort");
});

test("applyOpenaiEffort: 目录声明的档位透传；未声明的推理模型折三档；普通模型不发；固定档位对 GLM 也折", () => {
  stub.__resetConfig();
  resetCatalogForTest([
    { id: "gpt-5.2", input: { text: true, image: true, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] },
  ]);
  const r1 = cwRequest("hi", { modelId: "gpt-5.2" });
  const b1 = buildOpenaiRequest(r1, po);
  applyOpenaiEffort(b1, "xhigh", po, r1);
  eq(b1.reasoning_effort, "xhigh", "declared xhigh passthrough");

  const r2 = cwRequest("hi", { modelId: "deepseek-reasoner" });
  const b2 = buildOpenaiRequest(r2, po);
  applyOpenaiEffort(b2, "max", po, r2);
  eq(b2.reasoning_effort, "high", "undeclared reasoning model: max → high");

  const r3 = cwRequest("hi", { modelId: "plain-chat" });
  const b3 = buildOpenaiRequest(r3, po);
  applyOpenaiEffort(b3, "high", po, r3);
  eq(b3.reasoning_effort, undefined, "plain model: nothing");

  stub.__setConfig("openaiReasoningEffort", "medium");
  const r4 = cwRequest("hi", { modelId: "glm-5.3" });
  const b4 = buildOpenaiRequest(r4, po);
  applyOpenaiEffort(b4, "low", po, r4);
  eq(b4.reasoning_effort, "high", "fixed medium on GLM folds to high");
  stub.__resetConfig();
  resetCatalogForTest([]);
});

// ---------------------------------------------------------------- reasoning_content 回传

test("wantsReasoningEcho 白名单：GLM-4.7+/5、DeepSeek v3.2+/v4/chat/reasoner、Kimi K2/K3；其余不回传", () => {
  for (const m of ["glm-4.7", "zai-org/GLM-5.3-Flash", "glm-5", "deepseek-v3.2", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner", "kimi-k2-thinking", "moonshot/kimi-k3"]) {
    ok(wantsReasoningEcho(m), `${m} echoes`);
  }
  for (const m of ["gpt-5.2", "glm-4.5", "glm-4.6", "deepseek-v3.1", "deepseek-v3", "qwen3", "kimi-k1.5", "claude-opus-4"]) {
    ok(!wantsReasoningEcho(m), `${m} does not echo`);
  }
});

test("shouldEchoReasoning: 开关 auto 走白名单；off 全关；always 全开；历史 reasoning_content 原样放回 assistant", () => {
  stub.__resetConfig();
  ok(shouldEchoReasoning("glm-5.3") && !shouldEchoReasoning("gpt-5.2"), "auto");
  stub.__setConfig("openaiReasoningEcho", "off");
  ok(!shouldEchoReasoning("glm-5.3"), "off");
  stub.__setConfig("openaiReasoningEcho", "always");
  ok(shouldEchoReasoning("gpt-5.2"), "always");
  stub.__resetConfig();

  const history = [user("u"), assistant("a", { toolUses: [toolUse("t1", "x", {})], reasoningContent: { reasoningText: { text: "原样思考", signature: SYNTHETIC_REASONING_SIGNATURE } } })];
  const glm = buildOpenaiRequest(cwRequest("ok", { modelId: "glm-5.3", history, toolResults: [toolResult("t1", "r")] }), po);
  const asst = glm.messages.find((m) => m.role === "assistant")!;
  eq(asst.reasoning_content, "原样思考", "echoed unmodified");
  // tool 消息紧跟 assistant
  const ia = glm.messages.indexOf(asst);
  eq(glm.messages[ia + 1].role, "tool", "tool follows assistant");
  eq(glm.messages[ia + 1].tool_call_id, "t1", "paired id");

  const gpt = buildOpenaiRequest(cwRequest("ok", { modelId: "gpt-5.2", history, toolResults: [toolResult("t1", "r")] }), po);
  ok(!gpt.messages.some((m) => m.reasoning_content), "non-whitelisted model: no reasoning_content");
});

test("合成签名：isSyntheticSignature 前缀判定；Anthropic 侧回放历史时跳过（不发 thinking 块）", () => {
  ok(isSyntheticSignature(SYNTHETIC_REASONING_SIGNATURE), "synthetic");
  ok(isSyntheticSignature("api4kiro:anything"), "prefix family");
  ok(!isSyntheticSignature("ErUBCkYIBxgC"), "real anthropic sig");
  ok(!isSyntheticSignature(undefined), "undefined");
  const pa = provider({ protocol: "anthropic" });
  const history = [user("u"), assistant("a", { reasoningContent: { reasoningText: { text: "glm thought", signature: SYNTHETIC_REASONING_SIGNATURE } } })];
  const body = buildAnthropicRequest(cwRequest("ok", { modelId: "claude-x", history }), pa);
  ok(JSON.stringify(body).indexOf("glm thought") === -1, "synthetic-signed thinking not replayed to Anthropic");
  const real = [user("u"), assistant("a", { reasoningContent: { reasoningText: { text: "real thought", signature: "REALSIG" } } })];
  const b2 = buildAnthropicRequest(cwRequest("ok", { modelId: "claude-x", history: real }), pa);
  const asst = b2.messages.find((m) => m.role === "assistant")!;
  ok(Array.isArray(asst.content) && (asst.content[0] as { type: string }).type === "thinking", "real signature → thinking block first");
});

// ---------------------------------------------------------------- thought gate

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

const ANSWER_THOUGHT = "你好！我是 Kiro，一个 AI 编程助手。很高兴见到你，有什么可以帮你的吗？";
const DELIB_THOUGHT = "The user is greeting me. Let me respond briefly and warmly in Chinese.";

test("classifyReasoningHead: 推敲 / 回答 / 未决", () => {
  eq(classifyReasoningHead("The user is asking about…"), "deliberation", "The user");
  eq(classifyReasoningHead("用户想要一个函数"), "deliberation", "用户");
  eq(classifyReasoningHead("你好！我是 Kiro"), "answer", "greeting");
  eq(classifyReasoningHead("## 标题\n内容"), "answer", "markdown heading");
  eq(classifyReasoningHead("- item"), "answer", "list");
  eq(classifyReasoningHead("好 👋"), "answer", "emoji");
  eq(classifyReasoningHead("短"), "undecided", "too short");
  eq(classifyReasoningHead("这是一段没有明显特征但已经足够长的文字了吧应该够二十四个字了"), "deliberation", "long neutral → deliberation");
});

test("gate off：思考一律直播，正文照发，不去重", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "off" });
  const first = c.processLine("data: " + JSON.stringify(chunk({ reasoning_content: ANSWER_THOUGHT.slice(0, 10) })));
  eq(first.filter((e) => e.reasoningContentEvent?.text).length, 1, "off: first reasoning chunk emitted immediately");
  const evs = [...first, ...feedSse(c, [chunk({ reasoning_content: ANSWER_THOUGHT.slice(10) }), chunk({ content: ANSWER_THOUGHT }), chunk({}, "stop")])];
  eq(reasoningOf(evs), ANSWER_THOUGHT, "all reasoning shown");
  eq(textOf(evs), ANSWER_THOUGHT, "content intact");
  ok(!c.anomalies.has("duplicate_thought_dropped"), "nothing dropped");
});

test("gate exact：开头像回答的思考扣住，正文逐字复读 → 丢思考、只留正文，记 duplicate_thought_dropped", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const held = c.processLine("data: " + JSON.stringify(chunk({ reasoning_content: ANSWER_THOUGHT })));
  eq(held.filter((e) => e.reasoningContentEvent).length, 0, "held: nothing emitted yet");
  const evs = [...held, ...feedSse(c, [chunk({ content: ANSWER_THOUGHT.slice(0, 20) }), chunk({ content: ANSWER_THOUGHT.slice(20) }), chunk({}, "stop")])];
  eq(reasoningOf(evs), "", "thought dropped");
  eq(textOf(evs), ANSWER_THOUGHT, "content complete (held content released)");
  ok(c.anomalies.has("duplicate_thought_dropped"), "anomaly");
  eq(assertTrailingStopReason(evs, "exact dup"), "END_TURN", "stopReason");
});

test("gate exact：开头像回答但正文不同 → 思考原样补发（不丢字）", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const evs = feedSse(c, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({ content: "这是一段完全不同的正式回答，和思考里写的不一样。" }), chunk({}, "stop")]);
  eq(reasoningOf(evs), ANSWER_THOUGHT, "thought released");
  ok(textOf(evs).startsWith("这是一段"), "content after");
  ok(!c.anomalies.has("duplicate_thought_dropped"), "not dropped");
  // 思考帧在正文帧之前
  const iR = evs.findIndex((e) => e.reasoningContentEvent?.text);
  const iT = evs.findIndex((e) => e.assistantResponseEvent);
  ok(iR >= 0 && iR < iT, "reasoning precedes content");
});

test("gate exact：开头是推敲 → 直播；exact 模式下推敲不会被丢", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const first = c.processLine("data: " + JSON.stringify(chunk({ reasoning_content: DELIB_THOUGHT })));
  eq(first.filter((e) => e.reasoningContentEvent?.text).length, 1, "deliberation streamed immediately");
  const evs = [...first, ...feedSse(c, [chunk({ content: "你好！" }), chunk({}, "stop")])];
  eq(reasoningOf(evs), DELIB_THOUGHT, "kept");
  eq(textOf(evs), "你好！", "content");
});

test("gate aggressive：开头像回答、正文改写着再答 → 也丢；推敲照样放行", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "aggressive" });
  const evs = feedSse(c, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({ content: "嗨！我是 Kiro 助手，很开心认识你～需要我做点什么？" }), chunk({}, "stop")]);
  eq(reasoningOf(evs), "", "aggressive drops rewritten duplicate");
  ok(textOf(evs).startsWith("嗨"), "content kept");
  ok(c.anomalies.has("duplicate_thought_dropped"), "anomaly");

  const d = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "aggressive" });
  const ev2 = feedSse(d, [chunk({ reasoning_content: DELIB_THOUGHT }), chunk({ content: "答" }), chunk({}, "stop")]);
  eq(reasoningOf(ev2), DELIB_THOUGHT, "deliberation never dropped");
});

test("gate：只有思考没有正文且像回答 → 提升为正文（thought_promoted_to_content）；像推敲 → 按思考放行", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const evs = feedSse(c, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({}, "stop")]);
  eq(textOf(evs), ANSWER_THOUGHT, "promoted to content");
  eq(reasoningOf(evs), "", "no reasoning");
  ok(c.anomalies.has("thought_promoted_to_content"), "anomaly");
  assertTrailingStopReason(evs, "promote");

  const d = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const ev2 = feedSse(d, [chunk({ reasoning_content: DELIB_THOUGHT }), chunk({}, "stop")]);
  eq(reasoningOf(ev2), DELIB_THOUGHT, "deliberation released");
  eq(textOf(ev2), "", "no content");
});

test("gate 边界：工具调用到来时扣住的思考原样放行；扣住超过 6000 字放行直播；finish=length 且正文是思考短前缀 → 放行", () => {
  const c = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const evs = feedSse(c, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({ tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "ls", arguments: "{}" } }] }), chunk({}, "tool_calls")]);
  eq(reasoningOf(evs), ANSWER_THOUGHT, "released on tool call");
  eq(assertTrailingStopReason(evs, "tool"), "TOOL_USE", "TOOL_USE");

  const d = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const long = ANSWER_THOUGHT + "很长".repeat(3100);
  const out = d.processLine("data: " + JSON.stringify(chunk({ reasoning_content: long })));
  eq(reasoningOf(out), long, "over cap → released live");

  const e = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact" });
  const ev3 = feedSse(e, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({ content: ANSWER_THOUGHT.slice(0, 12) }), chunk({}, "length")]);
  eq(reasoningOf(ev3), ANSWER_THOUGHT, "length-truncated content: thought is the full answer → released");
  eq(assertTrailingStopReason(ev3, "length"), "MAX_TOKENS", "MAX_TOKENS");
});

test("合成签名只给回传家族补：echoReasoning=true 思考结束发 api4kiro:unsigned-reasoning；false 不发", () => {
  const a = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "off", echoReasoning: true });
  const ea = feedSse(a, [chunk({ reasoning_content: DELIB_THOUGHT }), chunk({ content: "hi" }), chunk({}, "stop")]);
  eq(signaturesOf(ea), [SYNTHETIC_REASONING_SIGNATURE], "synthetic signature after thought");
  const iSig = ea.findIndex((e) => e.reasoningContentEvent?.signature);
  const iText = ea.findIndex((e) => e.assistantResponseEvent);
  ok(iSig < iText, "signature closes reasoning before content");
  const b = new OpenaiStreamConverter("c", "gpt-5.2", { thoughtDedupe: "off", echoReasoning: false });
  const eb = feedSse(b, [chunk({ reasoning: DELIB_THOUGHT }), chunk({ content: "hi" }), chunk({}, "stop")]);
  eq(signaturesOf(eb), [], "no synthetic signature");
  eq(reasoningOf(eb), DELIB_THOUGHT, "`reasoning` field (OpenRouter) accepted");
  // 丢掉的思考不补签名
  const d = new OpenaiStreamConverter("c", "glm-5.3", { thoughtDedupe: "exact", echoReasoning: true });
  const ed = feedSse(d, [chunk({ reasoning_content: ANSWER_THOUGHT }), chunk({ content: ANSWER_THOUGHT }), chunk({}, "stop")]);
  eq(signaturesOf(ed), [], "dropped thought → no orphan signature");
});

test("reasoningLooksLikeAnswer 形态判定：排版 + emoji + 对话式收尾 ≥ 2 项且够长", () => {
  const answerish = "你好！👋 很高兴见到你。\n\n- **第一点**：说明\n- **第二点**：说明\n\n有什么可以帮你的吗？" + "补充说明。".repeat(20);
  ok(reasoningLooksLikeAnswer(answerish, "正文".repeat(30)), "answer-like");
  ok(!reasoningLooksLikeAnswer("The user asks a question. Let me think about the approach: first parse, then compute. ".repeat(3), "正文".repeat(30)), "deliberation");
  ok(!reasoningLooksLikeAnswer(answerish, "短"), "content too short → false");
});

void run();
