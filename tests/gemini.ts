/**
 * gemini：Gemini generateContent 通路（geminiTranslate / geminiStream）。R9 + 4.8.4 五处 400 修复：
 *  - 无参数工具不发 parameters；$ref / anyOf / additionalProperties 清洗；枚举只留字符串
 *  - 哨兵 skip_thought_signature_validator 只给 Gemini 3；2.5 不塞；Claude 系不塞
 *  - 2.0 / 1.5 / Gemma 不发 thinkingConfig；2.5 用 thinkingBudget；3 系用 thinkingLevel
 *  - 3 Pro medium→high，none→low；Flash none→minimal，认四档
 *  - image/jpg → image/jpeg
 *  - a2k-gm: 签名往返：流里 functionCall 的 thoughtSignature → Kiro 历史 → 下一轮贴回第一个 functionCall
 *  - thought:true → reasoningContentEvent；usageMetadata → contextUsageEvent + 嵌套 tokenUsage
 *  - contents 严格 user/model 交替、首条 user；连续 user 合并
 */
import { GeminiStreamConverter } from "../src/geminiStream";
import {
  GEMINI_SKIP_SIGNATURE,
  antigravityEnvelope,
  buildGeminiRequest,
  cleanSchemaForGemini,
  decodeGeminiSignature,
  encodeGeminiSignature,
  geminiFamilyOf,
  geminiThinkingConfig,
  resolveGeminiModel,
  stripAntigravityOnly,
} from "../src/geminiTranslate";
import { __seedRaw } from "../src/modelStore";
import { ProviderConfig } from "../src/providers";
import { CwRequest } from "../src/cwTypes";
import { check, eq, feedAll, lastIsStopReason, reasonings, run, signatures, sse, stopReasons, texts, tokenUsages, toolUses, contextUsages, cwRequest, toolSpec } from "./lib/cw";

const prov: ProviderConfig = { id: "pg", name: "gem", protocol: "gemini", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };

function build(modelId: string, extra: Partial<Parameters<typeof cwRequest>[0]> = {}, effort?: string) {
  const req = cwRequest({ modelId, ...extra }) as unknown as CwRequest;
  return buildGeminiRequest(req, prov, { effort: effort as never, convId: "conv-1" });
}

run("gemini", async () => {
  // ---------- 1. 家族识别 ----------
  {
    eq("family: gemini-3.6-flash", geminiFamilyOf("gemini-3.6-flash"), "gemini3");
    eq("family: gemini-3.1-pro", geminiFamilyOf("gemini-3.1-pro"), "gemini3");
    eq("family: gemini-pro-agent", geminiFamilyOf("gemini-pro-agent"), "gemini3");
    eq("family: gemini-2.5-pro", geminiFamilyOf("gemini-2.5-pro"), "gemini25");
    eq("family: gemini-2.0-flash", geminiFamilyOf("gemini-2.0-flash"), "other");
    eq("family: gemini-1.5-pro", geminiFamilyOf("gemini-1.5-pro"), "other");
    eq("family: gemma-3-27b", geminiFamilyOf("gemma-3-27b"), "other");
    eq("family: claude 经 Antigravity", geminiFamilyOf("claude-sonnet-4-5"), "claude");
    eq("family: 未知 gemini-* → gemini3", geminiFamilyOf("gemini-4-ultra"), "gemini3");
  }

  // ---------- 2. thinkingConfig 按家族与档位 ----------
  {
    const tc = (m: string, e?: string) => geminiThinkingConfig(m, geminiFamilyOf(m), e as never, 32000);
    eq("think: 2.0 不发 thinkingConfig", tc("gemini-2.0-flash", "high"), undefined);
    eq("think: 1.5 不发", tc("gemini-1.5-pro", "high"), undefined);
    eq("think: gemma 不发", tc("gemma-3-27b", "high"), undefined);
    eq("think: Flash high → thinkingLevel high", tc("gemini-3.6-flash", "high"), { includeThoughts: true, thinkingLevel: "high" });
    eq("think: Flash medium → medium", tc("gemini-3.6-flash", "medium"), { includeThoughts: true, thinkingLevel: "medium" });
    eq("think: Flash low → low", tc("gemini-3.6-flash", "low"), { includeThoughts: true, thinkingLevel: "low" });
    eq("think: Flash none → minimal", tc("gemini-3.6-flash", "none"), { includeThoughts: true, thinkingLevel: "minimal" });
    eq("think: Flash xhigh/max → high", [tc("gemini-3.6-flash", "xhigh")!.thinkingLevel, tc("gemini-3.6-flash", "max")!.thinkingLevel], ["high", "high"]);
    eq("think: Pro medium → high（官方 API 不认 medium）", tc("gemini-3.1-pro", "medium"), { includeThoughts: true, thinkingLevel: "high" });
    eq("think: Pro none → low（Pro 无 minimal）", tc("gemini-3.1-pro", "none"), { includeThoughts: true, thinkingLevel: "low" });
    eq("think: Pro low → low", tc("gemini-3.1-pro", "low")!.thinkingLevel, "low");
    eq("think: 无 effort 只开 includeThoughts", tc("gemini-3.6-flash", undefined), { includeThoughts: true });
    eq("think: 变体 id 自带档位 → 只开 includeThoughts", tc("gemini-3.6-flash-high", "low"), { includeThoughts: true });
    eq("think: 2.5 用 thinkingBudget", tc("gemini-2.5-pro", "high"), { includeThoughts: true, thinkingBudget: 24576 });
    eq("think: 2.5 none → budget 0 且关 includeThoughts", tc("gemini-2.5-flash", "none"), { includeThoughts: false, thinkingBudget: 0 });
    eq("think: Claude 系 budget 钳在 max-4096 内", tc("claude-sonnet-4-5", "max"), { includeThoughts: true, thinkingBudget: Math.min(32000, 32000 - 4096) });
    eq("think: Claude none → 不带", tc("claude-sonnet-4-5", "none"), undefined);
    const b20 = build("gemini-2.0-flash", {}, "high");
    check("build: 2.0 请求体无 generationConfig.thinkingConfig", !b20.request.generationConfig?.thinkingConfig);
    const b25 = build("gemini-2.5-pro", {}, "high");
    check("build: 2.5 带 thinkingBudget 不带 thinkingLevel", b25.request.generationConfig?.thinkingConfig?.thinkingBudget === 24576 && !b25.request.generationConfig?.thinkingConfig?.thinkingLevel);
    const b3p = build("gemini-3.1-pro", {}, "medium");
    eq("build: 3 Pro medium → high", b3p.request.generationConfig?.thinkingConfig?.thinkingLevel, "high");
    check("build: Gemini 系不带 maxOutputTokens（Antigravity 只对 Claude 收）", b3p.request.generationConfig?.maxOutputTokens === undefined);
    const bc = build("claude-sonnet-4-5", {}, "high");
    check("build: Claude 系带 maxOutputTokens ≤ 64000", typeof bc.request.generationConfig?.maxOutputTokens === "number" && bc.request.generationConfig!.maxOutputTokens! <= 64000);
  }

  // ---------- 3. 工具声明清洗 ----------
  {
    const b = build("gemini-3.6-flash", {
      tools: [
        toolSpec("listDir", { type: "object", properties: {} }, "no params"),
        toolSpec("noSchema", undefined, "no schema at all"),
        toolSpec("readFile", {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "file path", format: "uri-reference" },
            mode: { type: ["string", "null"], enum: ["r", "w", null] },
            count: { type: "integer", enum: [1, 2, 3], minimum: 1 },
            opts: { $ref: "#/$defs/Opts" },
            either: { anyOf: [{ type: "string" }, { type: "number" }] },
            tags: { type: "array" },
            free: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["path", "ghost"],
          $defs: { Opts: { type: "object", properties: { deep: { type: "boolean" } } } },
        }),
      ],
    });
    const decls = b.request.tools![0].functionDeclarations;
    const byName = new Map(decls.map((d) => [d.name, d]));
    check("tools: 无参数工具不发 parameters", byName.get("listDir")!.parameters === undefined);
    check("tools: 无 schema 工具不发 parameters", byName.get("noSchema")!.parameters === undefined);
    eq("tools: description 保留", byName.get("listDir")!.description, "no params");
    const p = byName.get("readFile")!.parameters as Record<string, unknown>;
    const props = p.properties as Record<string, Record<string, unknown>>;
    check("tools: 去 $schema / additionalProperties / $defs", !("$schema" in p) && !("additionalProperties" in p) && !("$defs" in p));
    check("tools: format 挪进 description", String(props.path.description).includes("format: uri-reference"));
    eq("tools: type 数组含 null → nullable + 字符串枚举去 null", [props.mode.type, props.mode.nullable, props.mode.enum], ["string", true, ["r", "w"]]);
    check("tools: 非字符串枚举挪进 description", props.count.enum === undefined && String(props.count.description).includes("allowed: 1, 2, 3") && props.count.minimum === 1);
    eq("tools: $ref 内联", (props.opts.properties as Record<string, unknown>).deep, { type: "boolean" });
    check("tools: anyOf 取首分支并标注", props.either.type === "string" && String(props.either.description).includes("one of"));
    eq("tools: array 缺 items 补 string", props.tags.items, { type: "string" });
    check("tools: 空对象 additionalProperties 字典 → 字符串占位", props.free.type === "string" && !("properties" in props.free));
    eq("tools: required 只保留实际存在的属性", p.required, ["path"]);
    check("tools: Gemini 系不带 toolConfig", b.request.toolConfig === undefined);
    // Claude 系（VALIDATED）：空对象要占位属性
    const cl = cleanSchemaForGemini({ type: "object", properties: {} }, { placeholder: true });
    eq("tools: Claude VALIDATED 空 schema 占位 reason", cl, { type: "object", properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } }, required: ["reason"] });
    const bc = build("claude-sonnet-4-5", { tools: [toolSpec("x", { type: "object", properties: { a: { type: "string" } } })] });
    eq("tools: Claude 系 toolConfig=VALIDATED", bc.request.toolConfig, { functionCallingConfig: { mode: "VALIDATED" } });
    eq("tools: cleanSchema 非对象根 → undefined（无参数）", cleanSchemaForGemini({ type: "string" }, { placeholder: false }), undefined);
  }

  // ---------- 4. 图片 mime ----------
  {
    const b = build("gemini-3.6-flash", { images: [{ format: "jpg", bytes: "AAA" }, { format: "PNG", bytes: "BBB" }, { format: "jpeg", bytes: "CCC" }] });
    const parts = b.request.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData!.mimeType);
    eq("image: jpg→jpeg, PNG→png, jpeg 保持", parts, ["image/jpeg", "image/png", "image/jpeg"]);
  }

  // ---------- 5. 签名往返 ----------
  {
    eq("sig: encode/decode", decodeGeminiSignature(encodeGeminiSignature("SIG123")), "SIG123");
    eq("sig: 非本前缀 → undefined", decodeGeminiSignature("a2k-rs:x"), undefined);
    eq("sig: 空 → undefined", decodeGeminiSignature("a2k-gm:"), undefined);
    // 流：functionCall 上的签名优先，flush 时发 a2k-gm: 签名帧
    const c = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev = feedAll(c, [
      sse({ candidates: [{ content: { role: "model", parts: [{ text: "Planning…", thought: true, thoughtSignature: "TEXTSIG" }] } }] }),
      sse({ candidates: [{ content: { role: "model", parts: [{ text: "I'll read it." }] } }] }),
      sse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fc-1", name: "readFile", args: { path: "a.ts" } }, thoughtSignature: "CALLSIG" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, thoughtsTokenCount: 80, cachedContentTokenCount: 100 } }),
    ]);
    eq("stream: thought:true → reasoningContentEvent", reasonings(ev), "Planning…");
    eq("stream: 正文", texts(ev), "I'll read it.");
    eq("stream: functionCall → toolUseEvent", toolUses(ev).map((t) => [t.toolUseId, t.name, t.input]), [["fc-1", "readFile", '{"path":"a.ts"}']]);
    eq("stream: 签名取 functionCall 上的、带 a2k-gm: 前缀", signatures(ev), ["a2k-gm:CALLSIG"]);
    eq("stream: 有工具 → TOOL_USE", stopReasons(ev), ["TOOL_USE"]);
    check("stream: 末帧 stopReason", lastIsStopReason(ev));
    eq("stream: usageMetadata → 嵌套 tokenUsage（out=candidates+thoughts）", tokenUsages(ev), [{ uncachedInputTokens: 400, outputTokens: 100, cacheReadInputTokens: 100, cacheWriteInputTokens: 0 }]);
    check("stream: usageMetadata → contextUsageEvent", contextUsages(ev).length === 1 && contextUsages(ev)[0] > 0);
    eq("stream: meteringUsage 缓存清零", c.meteringUsage(), { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });

    // 回放：Kiro 历史带 a2k-gm: 签名 → 贴回第一个 functionCall
    const hist = [
      { userInputMessage: { content: "read a.ts", modelId: "gemini-3.6-flash", userInputMessageContext: {} } },
      {
        assistantResponseMessage: {
          content: "I'll read it.",
          toolUses: [{ toolUseId: "fc-1", name: "readFile", input: '{"path":"a.ts"}' }, { toolUseId: "fc-2", name: "listDir", input: "{}" }],
          reasoningContent: { reasoningText: { text: "Planning…", signature: "a2k-gm:CALLSIG" } },
        },
      },
    ];
    const b = build("gemini-3.6-flash", { history: hist, toolResults: [{ toolUseId: "fc-1", content: [{ text: "file body" }] }, { toolUseId: "fc-2", content: "a b c" }], content: "" });
    const roles = b.request.contents.map((c) => c.role);
    eq("replay: user/model/user 交替", roles, ["user", "model", "user"]);
    const model = b.request.contents[1];
    const calls = model.parts.filter((p) => p.functionCall);
    eq("replay: 真签名贴到第一个 functionCall，第二个不贴", [calls[0].thoughtSignature, calls[1].thoughtSignature], ["CALLSIG", undefined]);
    eq("replay: functionCall args 解析为对象", calls[0].functionCall!.args, { path: "a.ts" });
    check("replay: Gemini 系不产生 thought:true 部件", !model.parts.some((p) => p.thought));
    const resp = b.request.contents[2].parts.filter((p) => p.functionResponse);
    eq("replay: functionResponse 顺序与 name 对应", resp.map((p) => [p.functionResponse!.id, p.functionResponse!.name, p.functionResponse!.response.result]), [["fc-1", "readFile", "file body"], ["fc-2", "listDir", "a b c"]]);
    eq("replay: sessionId 稳定（同 convId 同值）", b.request.sessionId, build("gemini-3.6-flash", {}).request.sessionId);
    check("replay: sessionId 形如 -<digits>", /^-\d+$/.test(b.request.sessionId || ""));

    // 无签名历史：Gemini 3 用哨兵；2.5 不塞；Claude 不塞
    const histNoSig = [hist[0], { assistantResponseMessage: { ...hist[1].assistantResponseMessage, reasoningContent: undefined } }];
    const g3 = build("gemini-3.6-flash", { history: histNoSig, toolResults: [{ toolUseId: "fc-1", content: "x" }] });
    eq("sentinel: Gemini 3 无签名 → 哨兵", g3.request.contents[1].parts.find((p) => p.functionCall)!.thoughtSignature, GEMINI_SKIP_SIGNATURE);
    const g25 = build("gemini-2.5-pro", { history: histNoSig.map((h) => (h.userInputMessage ? { userInputMessage: { ...h.userInputMessage, modelId: "gemini-2.5-pro" } } : h)), toolResults: [{ toolUseId: "fc-1", content: "x" }] });
    eq("sentinel: 2.5 不塞哨兵", g25.request.contents[1].parts.find((p) => p.functionCall)!.thoughtSignature, undefined);
    const g20 = build("gemini-2.0-flash", { history: histNoSig.map((h) => (h.userInputMessage ? { userInputMessage: { ...h.userInputMessage, modelId: "gemini-2.0-flash" } } : h)), toolResults: [{ toolUseId: "fc-1", content: "x" }] });
    eq("sentinel: 2.0 不塞哨兵", g20.request.contents[1].parts.find((p) => p.functionCall)!.thoughtSignature, undefined);
    const gc = build("claude-sonnet-4-5", { history: histNoSig.map((h) => (h.userInputMessage ? { userInputMessage: { ...h.userInputMessage, modelId: "claude-sonnet-4-5" } } : h)), toolResults: [{ toolUseId: "fc-1", content: "x" }] });
    eq("sentinel: Claude 系 functionCall 不塞哨兵", gc.request.contents[1].parts.find((p) => p.functionCall)!.thoughtSignature, undefined);

    // Claude 系：带签名的思考回放为 thought 部件；无签名思考整块丢并关本轮 thinking
    const histClaudeSigned = [
      { userInputMessage: { content: "q", modelId: "claude-sonnet-4-5", userInputMessageContext: {} } },
      { assistantResponseMessage: { content: "a", reasoningContent: { reasoningText: { text: "deep", signature: "a2k-gm:CSIG" } } } },
    ];
    const bcs = build("claude-sonnet-4-5", { history: histClaudeSigned }, "high");
    const tp = bcs.request.contents[1].parts.find((p) => p.thought);
    eq("claude: 带签名思考 → thought 部件 + thoughtSignature", [tp?.text, tp?.thoughtSignature], ["deep", "CSIG"]);
    check("claude: thinkingConfig 保留", !!bcs.request.generationConfig?.thinkingConfig);
    const histClaudeUnsigned = [histClaudeSigned[0], { assistantResponseMessage: { content: "a", reasoningContent: { reasoningText: { text: "deep" } } } }];
    const bcu = build("claude-sonnet-4-5", { history: histClaudeUnsigned }, "high");
    check("claude: 无签名思考整块丢", !bcu.request.contents[1].parts.some((p) => p.thought));
    check("claude: 无签名思考 → 本轮关 thinkingConfig", !bcu.request.generationConfig?.thinkingConfig);
  }

  // ---------- 6. contents 交替与合并 ----------
  {
    const b = build("gemini-3.6-flash", {
      history: [
        { assistantResponseMessage: { content: "orphan model first" } },
        { userInputMessage: { content: "u1", modelId: "gemini-3.6-flash", userInputMessageContext: {} } },
        { userInputMessage: { content: "u2", modelId: "gemini-3.6-flash", userInputMessageContext: {} } },
        { assistantResponseMessage: {} },
      ],
      content: "u3",
    });
    const roles = b.request.contents.map((c) => c.role);
    eq("alt: 首条补 user(start)，连续 user 合并", roles, ["user", "model", "user", "model", "user"]);
    eq("alt: 补的首条是 (start)", b.request.contents[0].parts[0].text, "(start)");
    eq("alt: 连续 user 合并为多 parts", b.request.contents[2].parts.map((p) => p.text), ["u1", "u2"]);
    eq("alt: 空 assistant → (no content)", b.request.contents[3].parts[0].text, "(no content)");
  }

  // ---------- 7. 变体 id 解析 / 信封 ----------
  {
    eq("variant: 目录里有精确 id → 原样", resolveGeminiModel(prov, "gemini-3.1-pro-low", undefined, ["gemini-3.1-pro-low", "gemini-3.1-pro-high"]), "gemini-3.1-pro-low");
    eq("variant: base+effort 命中变体", resolveGeminiModel(prov, "gemini-3.1-pro", "high", ["gemini-3.1-pro-low", "gemini-3.1-pro-high"]), "gemini-3.1-pro-high");
    eq("variant: 只有别的档位 → 取第一个", resolveGeminiModel(prov, "gemini-3.1-pro", "xhigh", ["gemini-3.1-pro-low"]), "gemini-3.1-pro-low");
    eq("variant: 目录为空 → 原样", resolveGeminiModel(prov, "gemini-3.6-flash", "high", []), "gemini-3.6-flash");
    __seedRaw(prov, [{ id: "gemini-3.1-pro-medium" }]);
    eq("variant: hasEffortVariant 命中 provider 缓存", resolveGeminiModel(prov, "gemini-3.1-pro", "medium", ["something-else"]), "gemini-3.1-pro-medium");
    const env = antigravityEnvelope("m", { contents: [] }, "proj-1");
    check("envelope: 形状", env.model === "m" && env.project === "proj-1" && env.userAgent === "antigravity" && env.requestType === "agent" && String(env.requestId).startsWith("agent-"));
    const stripped = stripAntigravityOnly({ contents: [], sessionId: "-1" });
    check("envelope: 官方 API 剥 sessionId", !("sessionId" in stripped));
  }

  // ---------- 8. 流：错误 / 截断 / 信封 / 整包 ----------
  {
    const c = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev = feedAll(c, [sse({ response: { candidates: [{ content: { parts: [{ text: "wrapped" }] }, finishReason: "MAX_TOKENS" }] } })]);
    eq("stream: Antigravity 信封解包", texts(ev).startsWith("wrapped"), true);
    eq("stream: MAX_TOKENS 透传", stopReasons(ev), ["MAX_TOKENS"]);
    check("stream: 截断提示", texts(ev).includes("maxOutputTokens"));
    const c2 = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev2 = feedAll(c2, [sse({ error: { code: 400, message: "thinkingConfig not supported", status: "INVALID_ARGUMENT" } })]);
    check("stream: 流中 error 可见", texts(ev2).includes("400 INVALID_ARGUMENT thinkingConfig not supported"));
    eq("stream: 错误流 stopReason", stopReasons(ev2), ["END_TURN"]);
    const c3 = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev3 = feedAll(c3, [sse({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "SAFETY" }] })]);
    check("stream: 非 STOP 非工具的 finishReason 提示", texts(ev3).includes("上游提前结束：SAFETY"));
    const c4 = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev4 = feedAll(c4, [sse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })]);
    check("stream: promptFeedback 阻断可见", texts(ev4).includes("prompt blocked: PROHIBITED_CONTENT"));
    // 非 SSE 整包数组
    const c5 = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const whole = JSON.stringify([
      { candidates: [{ content: { parts: [{ text: "A", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "B" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
    ]);
    const ev5 = feedAll(c5, [whole]);
    eq("stream: 整包数组 思考/正文", [reasonings(ev5), texts(ev5)], ["A", "B"]);
    eq("stream: 整包 stopReason", stopReasons(ev5), ["END_TURN"]);
    // 只有签名没有思考文本：补占位空格
    const c6 = new GeminiStreamConverter("conv", "gemini-3.6-flash");
    const ev6 = feedAll(c6, [sse({ candidates: [{ content: { parts: [{ functionCall: { name: "t", args: {} }, thought_signature: "SNAKE" }] } }] })]);
    eq("stream: thought_signature（蛇形）也认，无文本补空格", [reasonings(ev6), signatures(ev6)], [" ", ["a2k-gm:SNAKE"]]);
    check("stream: functionCall 无 id 时合成", toolUses(ev6)[0].toolUseId.startsWith("t-"));
  }
});
