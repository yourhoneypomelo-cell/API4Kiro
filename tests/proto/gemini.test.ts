/**
 * R9 / proxy-core 2.3 2.7：Gemini 档位分档、无参工具、哨兵、交替、thought 实时、签名往返、jpg→jpeg。
 */
import {
  GEMINI_SKIP_SIGNATURE,
  buildGeminiRequest,
  cleanSchemaForGemini,
  decodeGeminiSignature,
  encodeGeminiSignature,
  geminiFamilyOf,
  geminiThinkingConfig,
} from "../../src/geminiTranslate";
import { GeminiStreamConverter } from "../../src/geminiStream";
import { SYNTHETIC_REASONING_SIGNATURE } from "../../src/thinkingPolicy";
import { assistant, cwRequest, image, provider, toolResult, toolSpec, toolUse, user } from "./fixtures";
import { assertTrailingStopReason, eq, feedSse, ok, reasoningOf, run, signaturesOf, test, textOf } from "./harness";

const pg = provider({ protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" });

test("geminiFamilyOf: 3.x / pro-agent → gemini3；2.5 → gemini25；2.0/1.5/gemma → other；claude → claude", () => {
  eq(geminiFamilyOf("gemini-3-flash"), "gemini3", "3 flash");
  eq(geminiFamilyOf("gemini-3.8-flash"), "gemini3", "3.8 flash");
  eq(geminiFamilyOf("gemini-3.1-pro"), "gemini3", "3.1 pro");
  eq(geminiFamilyOf("gemini-pro-agent"), "gemini3", "pro-agent alias");
  eq(geminiFamilyOf("gemini-2.5-pro"), "gemini25", "2.5");
  eq(geminiFamilyOf("gemini-2.0-flash"), "other", "2.0");
  eq(geminiFamilyOf("gemini-1.5-pro"), "other", "1.5");
  eq(geminiFamilyOf("gemma-3-27b"), "other", "gemma");
  eq(geminiFamilyOf("claude-sonnet-4-5"), "claude", "claude via antigravity");
});

test("thinkingLevel: Flash 四档 minimal/low/medium/high；none→minimal；xhigh/max→high", () => {
  const m = "gemini-3.8-flash";
  const lvl = (e: string) => geminiThinkingConfig(m, "gemini3", e as never, 32000)?.thinkingLevel;
  eq(lvl("none"), "minimal", "none");
  eq(lvl("low"), "low", "low");
  eq(lvl("medium"), "medium", "medium");
  eq(lvl("high"), "high", "high");
  eq(lvl("xhigh"), "high", "xhigh folds to high");
  eq(lvl("max"), "high", "max folds to high");
  eq(geminiThinkingConfig(m, "gemini3", "high", 32000)?.includeThoughts, true, "includeThoughts always on");
});

test("thinkingLevel: Pro 只认 low/high；medium→high；none→low", () => {
  const m = "gemini-3.1-pro";
  const lvl = (e: string) => geminiThinkingConfig(m, "gemini3", e as never, 32000)?.thinkingLevel;
  eq(lvl("none"), "low", "none → low (no minimal on Pro)");
  eq(lvl("low"), "low", "low");
  eq(lvl("medium"), "high", "medium → high (Pro rejects medium)");
  eq(lvl("high"), "high", "high");
  eq(lvl("max"), "high", "max → high");
  for (const e of ["none", "low", "medium", "high", "xhigh", "max"]) {
    ok(["low", "high"].includes(lvl(e)!), `Pro never sends '${lvl(e)}' for ${e}`);
  }
});

test("thinkingConfig: 2.0/1.5/Gemma 不发；2.5 用 thinkingBudget；自带 -high 后缀的变体只开 includeThoughts；auto 不发档位", () => {
  eq(geminiThinkingConfig("gemini-2.0-flash", "other", "high", 32000), undefined, "other → undefined");
  const g25 = geminiThinkingConfig("gemini-2.5-pro", "gemini25", "high", 32000)!;
  eq(g25.thinkingBudget, 24576, "2.5 high budget");
  ok(!g25.thinkingLevel, "2.5 no thinkingLevel");
  const g25none = geminiThinkingConfig("gemini-2.5-flash", "gemini25", "none", 32000)!;
  eq(g25none.thinkingBudget, 0, "2.5 none → budget 0");
  eq(g25none.includeThoughts, false, "2.5 none → includeThoughts false");
  eq(geminiThinkingConfig("gemini-3.1-pro-high", "gemini3", "low", 32000), { includeThoughts: true }, "variant id carries level");
  eq(geminiThinkingConfig("gemini-3-flash", "gemini3", undefined, 32000), { includeThoughts: true }, "auto → no level");
  // 请求组装层：2.0 请求体里没有 thinkingConfig
  const req = cwRequest("hi", { modelId: "gemini-2.0-flash", effort: "high" });
  const built = buildGeminiRequest(req, pg, { effort: "high" });
  eq(built.request.generationConfig, undefined, "no generationConfig for 2.0");
});

test("无参数工具不发 parameters；有参数的发清洗后的 OBJECT", () => {
  eq(cleanSchemaForGemini({ type: "object", properties: {} }, { placeholder: false }), undefined, "empty props → undefined");
  eq(cleanSchemaForGemini(undefined, { placeholder: false }), undefined, "undefined → undefined");
  const req = cwRequest("hi", {
    modelId: "gemini-3-flash",
    tools: [toolSpec("noArgs", { type: "object", properties: {} }), toolSpec("withArgs", { type: "object", properties: { p: { type: "string" } }, required: ["p"] })],
  });
  const decls = buildGeminiRequest(req, pg).request.tools![0].functionDeclarations;
  eq(decls.length, 2, "two decls");
  ok(!("parameters" in decls[0]), "noArgs has no parameters key");
  eq(decls[0].name, "noArgs", "name");
  eq(decls[1].parameters, { type: "object", properties: { p: { type: "string" } }, required: ["p"] }, "withArgs params");
  // Claude 系（VALIDATED 模式）空 schema 给占位属性，且 toolConfig=VALIDATED
  const reqC = cwRequest("hi", { modelId: "claude-sonnet-4-5", tools: [toolSpec("noArgs", { type: "object", properties: {} })] });
  const bc = buildGeminiRequest(reqC, pg);
  eq(bc.request.toolConfig, { functionCallingConfig: { mode: "VALIDATED" } }, "claude VALIDATED");
  eq(bc.request.tools![0].functionDeclarations[0].parameters?.required, ["reason"], "claude placeholder");
});

test("哨兵 skip_thought_signature_validator 只给 Gemini 3 的第一个 functionCall；2.5 / 2.0 / Claude 不给", () => {
  const history = [
    user("read it"),
    assistant("", { toolUses: [toolUse("t1", "read", { p: "a" }), toolUse("t2", "read", { p: "b" })] }),
  ];
  const mk = (modelId: string) => buildGeminiRequest(cwRequest("ok", { modelId, history, toolResults: [toolResult("t1", "A"), toolResult("t2", "B")] }), pg).request;

  const g3 = mk("gemini-3-flash");
  const modelTurn = g3.contents[1];
  eq(modelTurn.role, "model", "model turn");
  eq(modelTurn.parts[0].thoughtSignature, GEMINI_SKIP_SIGNATURE, "gemini3: sentinel on first call");
  ok(!modelTurn.parts[1].thoughtSignature, "gemini3: not on second call");

  for (const m of ["gemini-2.5-pro", "gemini-2.0-flash", "claude-sonnet-4-5"]) {
    const r = mk(m);
    ok(JSON.stringify(r).indexOf(GEMINI_SKIP_SIGNATURE) === -1, `${m}: no sentinel`);
  }
  // functionResponse 紧随在 user 轮，顺序与 functionCall 对应，name 从 toolUses 找回
  const userTurn = g3.contents[2];
  eq(userTurn.role, "user", "user turn");
  eq(userTurn.parts[0].functionResponse?.name, "read", "fr name");
  eq(userTurn.parts[0].functionResponse?.id, "t1", "fr id order");
  eq(userTurn.parts[1].functionResponse?.id, "t2", "fr id order 2");
});

test("contents 严格交替：首条为 user；连续 user 合并；连续 model 合并（修复项）；缺结果的 functionCall 补占位", () => {
  // 历史以 assistant 开头（被裁剪）→ 补 (start)
  const r1 = buildGeminiRequest(cwRequest("q", { modelId: "gemini-3-flash", history: [assistant("prev")] }), pg).request;
  eq(r1.contents[0].role, "user", "first is user");
  eq(r1.contents[0].parts[0].text, "(start)", "synthetic start");
  eq(r1.contents.map((c) => c.role), ["user", "model", "user"], "alternating");

  // 连续两个 user（历史里的 user 后紧跟 currentMessage user）
  const r2 = buildGeminiRequest(cwRequest("second", { modelId: "gemini-3-flash", history: [user("first")] }), pg).request;
  eq(r2.contents.map((c) => c.role), ["user"], "consecutive users merged");
  eq(r2.contents[0].parts.map((p) => p.text), ["first", "second"], "both texts kept");

  // 连续两个 assistant
  const r3 = buildGeminiRequest(cwRequest("q", { modelId: "gemini-3-flash", history: [user("u"), assistant("a1"), assistant("a2")] }), pg).request;
  eq(r3.contents.map((c) => c.role), ["user", "model", "user"], "consecutive models merged");
  eq(r3.contents[1].parts.map((p) => p.text), ["a1", "a2"], "model parts merged");

  for (const r of [r1, r2, r3]) {
    for (let i = 1; i < r.contents.length; i++) {
      ok(r.contents[i].role !== r.contents[i - 1].role, "no two adjacent same roles");
    }
  }

  // 末尾 assistant 有 functionCall 但 currentMessage 没带结果 → 补占位 functionResponse
  const r4 = buildGeminiRequest(cwRequest("", { modelId: "gemini-3-flash", history: [user("u"), assistant("", { toolUses: [toolUse("t9", "ls", {})] })] }), pg).request;
  const last = r4.contents[r4.contents.length - 1];
  eq(last.role, "user", "trailing user");
  ok(last.parts.some((p) => p.functionResponse?.id === "t9"), "placeholder functionResponse present");
});

test("thought:true 增量实时转 reasoningContentEvent；usageMetadata → contextUsageEvent；签名以 a2k-gm: 前缀在流末发出", () => {
  const c = new GeminiStreamConverter("c1", "gemini-3-flash");
  const evs: ReturnType<typeof c.processLine> = [];
  evs.push(...c.processLine("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "思考一", thought: true }] } }] })));
  eq(reasoningOf(evs), "思考一", "first thought emitted immediately (before flush)");
  evs.push(...c.processLine("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "思考二", thought: true, thoughtSignature: "SIGTEXT" }] } }] })));
  evs.push(...c.processLine("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "fc1", name: "read", args: {} }, thoughtSignature: "SIGCALL" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 200000, candidatesTokenCount: 5 } })));
  evs.push(...c.flush());
  eq(reasoningOf(evs), "思考一思考二", "thoughts streamed");
  eq(textOf(evs), "", "no text");
  const sigs = signaturesOf(evs);
  eq(sigs, [encodeGeminiSignature("SIGCALL")], "functionCall signature preferred, a2k-gm: prefix");
  const ctxEv = evs.find((e) => e.contextUsageEvent);
  ok(!!ctxEv && ctxEv.contextUsageEvent!.contextUsagePercentage > 0, "contextUsageEvent emitted");
  eq(assertTrailingStopReason(evs, "gemini tool"), "TOOL_USE", "TOOL_USE");
  // 没有思考文本时签名前补占位空格，保住 Kiro 历史
  const d = new GeminiStreamConverter("c1", "gemini-3-flash");
  const ed = feedSse(d, [{ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} }, thought_signature: "SNAKE" }] } }] }]);
  const iText = ed.findIndex((e) => e.reasoningContentEvent?.text === " ");
  const iSig = ed.findIndex((e) => e.reasoningContentEvent?.signature);
  ok(iText >= 0 && iText < iSig, "placeholder text before signature");
  eq(decodeGeminiSignature(ed[iSig].reasoningContentEvent!.signature), "SNAKE", "snake_case thought_signature accepted");
});

test("签名往返：流末 a2k-gm: 签名进 Kiro 历史 → 下一轮贴回第一个 functionCall；无 functionCall 贴到末尾部件", () => {
  const sig = encodeGeminiSignature("REAL_SIG");
  const history = [
    user("do"),
    assistant("", {
      toolUses: [toolUse("t1", "read", {})],
      reasoningContent: { reasoningText: { text: "thinking…", signature: sig } },
    }),
  ];
  const r = buildGeminiRequest(cwRequest("ok", { modelId: "gemini-3-flash", history, toolResults: [toolResult("t1", "A")] }), pg).request;
  eq(r.contents[1].parts[0].functionCall?.name, "read", "call");
  eq(r.contents[1].parts[0].thoughtSignature, "REAL_SIG", "decoded signature on first functionCall");
  ok(JSON.stringify(r).indexOf(GEMINI_SKIP_SIGNATURE) === -1, "no sentinel when real signature exists");
  ok(!r.contents[1].parts.some((p) => p.thought), "gemini family: thought text not replayed");

  const r2 = buildGeminiRequest(cwRequest("ok", { modelId: "gemini-3-flash", history: [user("u"), assistant("answer", { reasoningContent: { reasoningText: { text: "t", signature: sig } } })] }), pg).request;
  eq(r2.contents[1].parts[r2.contents[1].parts.length - 1].thoughtSignature, "REAL_SIG", "no call → on last part");

  eq(decodeGeminiSignature("a2k-rs:xyz"), undefined, "responses signature not decoded as gemini");
  eq(decodeGeminiSignature(undefined), undefined, "undefined");
  eq(decodeGeminiSignature("a2k-gm:"), undefined, "empty inner");
});

test("合成签名 api4kiro:unsigned-reasoning 在 Gemini 侧视为无签名：不回放、不关思考、Gemini 3 仍用哨兵", () => {
  const history = [
    user("u"),
    assistant("", { toolUses: [toolUse("t1", "read", {})], reasoningContent: { reasoningText: { text: "glm thought", signature: SYNTHETIC_REASONING_SIGNATURE } } }),
  ];
  const r = buildGeminiRequest(cwRequest("ok", { modelId: "gemini-3-flash", history, toolResults: [toolResult("t1", "A")], effort: "high" }), pg, { effort: "high" }).request;
  eq(r.contents[1].parts[0].thoughtSignature, GEMINI_SKIP_SIGNATURE, "sentinel used");
  ok(JSON.stringify(r).indexOf("glm thought") === -1, "foreign thought not replayed");
  eq(r.generationConfig?.thinkingConfig?.thinkingLevel, "high", "thinking still on");
  // Claude 系：合成签名当作无签名 → 不因它关掉本轮 thinking
  const rc = buildGeminiRequest(cwRequest("ok", { modelId: "claude-sonnet-4-5", history, toolResults: [toolResult("t1", "A")] }), pg, { effort: "high" }).request;
  ok(!!rc.generationConfig?.thinkingConfig, "claude: thinking not disabled by synthetic signature");
});

test("图片 jpg → image/jpeg；systemInstruction 无提示词时不带；空 user 消息补 (empty)", () => {
  const r = buildGeminiRequest(cwRequest("look", { modelId: "gemini-3-flash", images: [image("jpg"), image("PNG")] }), pg).request;
  const parts = r.contents[0].parts;
  eq(parts[1].inlineData?.mimeType, "image/jpeg", "jpg → jpeg");
  eq(parts[2].inlineData?.mimeType, "image/png", "png lowercased");
  ok(!r.systemInstruction, "no system when no prompt enabled");
  const r2 = buildGeminiRequest(cwRequest("", { modelId: "gemini-3-flash" }), pg).request;
  eq(r2.contents[0].parts[0].text, "(empty)", "empty placeholder");
});

void run();
