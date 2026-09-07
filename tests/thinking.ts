/**
 * thinking：OpenAI 兼容通路上的「思考」方言（thinkingPolicy / openaiTranslate / openaiStream）。
 *  - GLM-5.3 强制思考家族：五档折 low/high/max；不发 enable_thinking:false；手动「不支持」也只发 low
 *  - reasoning_content 回传白名单（GLM-4.7+/5、DeepSeek V3.2+/V4、Kimi K2/K3）+ 总开关
 *  - 合成签名 api4kiro:unsigned-reasoning：OpenAI 侧思考结束补发；Anthropic / Gemini 侧回放时跳过
 *  - thought gate 三档：off / exact / aggressive；promote（只有思考没正文）
 *  - effort 缓存：工具续跑轮缺 effort 时用本会话上一档
 */
import * as vscode from "vscode";
import { OpenaiStreamConverter, reasoningLooksLikeAnswer } from "../src/openaiStream";
import { applyOpenaiEffort, buildOpenaiRequest, shouldEchoReasoning } from "../src/openaiTranslate";
import {
  SYNTHETIC_REASONING_SIGNATURE,
  classifyReasoningHead,
  declaredEffortValues,
  forcedThinkingEffort,
  isForcedThinkingModel,
  isSyntheticSignature,
  wantsReasoningEcho,
  FORCED_THINKING_EFFORTS,
} from "../src/thinkingPolicy";
import { buildAnthropicRequest } from "../src/translate";
import { buildGeminiRequest } from "../src/geminiTranslate";
import { effortFromRequest, getSelectedEffort } from "../src/effort";
import { resetCatalogForTest } from "../src/modelCatalog";
import { ProviderConfig } from "../src/providers";
import { CwRequest } from "../src/cwTypes";
import { check, eq, feedAll, reasonings, run, signatures, sse, stopReasons, texts, toolUses, cwRequest } from "./lib/cw";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void };

const oai: ProviderConfig = { id: "p1", name: "oai", protocol: "openai", openaiApi: "chat", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return sse({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
}

run("thinking", async () => {
  // ---------- 1. 强制思考家族识别与折档 ----------
  {
    check("forced: glm-5.3", isForcedThinkingModel("glm-5.3"));
    check("forced: zai-org/GLM-5.3-Flash", isForcedThinkingModel("zai-org/GLM-5.3-Flash"));
    check("forced: glm-5.3-highspeed", isForcedThinkingModel("glm-5.3-highspeed"));
    check("forced: glm-5.2 不是", !isForcedThinkingModel("glm-5.2"));
    check("forced: glm-4.7 不是", !isForcedThinkingModel("glm-4.7"));
    eq("fold: none→low", forcedThinkingEffort("none"), "low");
    eq("fold: low→low", forcedThinkingEffort("low"), "low");
    eq("fold: medium→high（不是 low）", forcedThinkingEffort("medium"), "high");
    eq("fold: high→high", forcedThinkingEffort("high"), "high");
    eq("fold: xhigh→max", forcedThinkingEffort("xhigh"), "max");
    eq("fold: max→max", forcedThinkingEffort("max"), "max");
    eq("fold: 三档常量", [...FORCED_THINKING_EFFORTS], ["low", "high", "max"]);
  }

  // ---------- 2. applyOpenaiEffort 对 GLM：无条件折三档，目录里的 medium 不当真 ----------
  {
    stub.__resetConfig();
    resetCatalogForTest([
      { id: "glm-5.3-flash", input: { text: true, image: false, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "max"] }] },
      { id: "gpt-5.4", input: { text: true, image: true, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }] },
      { id: "deepseek-v4-pro", family: "deepseek", input: { text: true, image: false, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [] },
    ]);
    const mk = (model: string) => ({ model, messages: [], stream: true } as Parameters<typeof applyOpenaiEffort>[0]);
    for (const [k, v] of [["none", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"]] as const) {
      const b = mk("glm-5.3-flash");
      applyOpenaiEffort(b, k);
      eq(`glm: ${k} → reasoning_effort=${v}`, b.reasoning_effort, v);
      check(`glm: ${k} 不带 enable_thinking / thinking 字段`, b.enable_thinking === undefined && b.thinking === undefined);
    }
    // 目录声明透传（Chat 通路 4.11.1 已做）
    const g = mk("gpt-5.4");
    applyOpenaiEffort(g, "xhigh");
    eq("catalog: gpt-5.4 xhigh 原样透传", g.reasoning_effort, "xhigh");
    const g2 = mk("gpt-5.4");
    applyOpenaiEffort(g2, "max");
    eq("catalog: gpt-5.4 max 不在声明里 → 折 high", g2.reasoning_effort, "high");
    const g3 = mk("gpt-5.4");
    applyOpenaiEffort(g3, "none");
    check("catalog: none 在声明里 → 透传 none 而非关思考字段", g3.reasoning_effort === "none" && g3.enable_thinking === undefined);
    // 非推理模型：none → 关思考方言
    const d = mk("qwen-plain");
    applyOpenaiEffort(d, "none");
    check("plain: none → enable_thinking:false + thinking:disabled", d.enable_thinking === false && d.thinking?.type === "disabled" && d.reasoning_effort === undefined);
    const d2 = mk("qwen-plain");
    applyOpenaiEffort(d2, "high");
    check("plain: 不像推理模型 → 不发 reasoning_effort", d2.reasoning_effort === undefined);
    const r1 = mk("deepseek-reasoner");
    applyOpenaiEffort(r1, "xhigh");
    eq("heuristic: reasoner 名 + 无目录声明 → 折 high", r1.reasoning_effort, "high");
    // 全局固定档位
    stub.__setConfig("openaiReasoningEffort", "medium");
    const f1 = mk("glm-5.3");
    applyOpenaiEffort(f1, "low");
    eq("global: 固定 medium 对 GLM 折成 high", f1.reasoning_effort, "high");
    const f2 = mk("plain-model");
    applyOpenaiEffort(f2, undefined);
    eq("global: 固定 medium 对普通模型无条件发", f2.reasoning_effort, "medium");
    stub.__setConfig("openaiReasoningEffort", "off");
    const f3 = mk("glm-5.3");
    applyOpenaiEffort(f3, "high");
    check("global: off 不发任何字段", f3.reasoning_effort === undefined);
    stub.__resetConfig();
    // 手动「不支持推理」：强制家族仍发 low；普通模型走 buildOpenaiRequest 的关思考字段
    const provOff: ProviderConfig = { ...oai, modelOverrides: { "glm-5.3": { reasoning: false }, "qwen-x": { reasoning: false } } };
    const reqG = cwRequest({ modelId: "glm-5.3", effort: "high" }) as unknown as CwRequest;
    const bG = buildOpenaiRequest(reqG, provOff);
    applyOpenaiEffort(bG, "high", provOff, reqG);
    check("manual-off: GLM 不发 disable 字段，改发 low", bG.enable_thinking === undefined && bG.thinking === undefined && bG.reasoning_effort === "low");
    const reqQ = cwRequest({ modelId: "qwen-x", effort: "high" }) as unknown as CwRequest;
    const bQ = buildOpenaiRequest(reqQ, provOff);
    applyOpenaiEffort(bQ, "high", provOff, reqQ);
    check("manual-off: 普通模型带 enable_thinking:false + thinking:disabled，不发 effort", bQ.enable_thinking === false && bQ.thinking?.type === "disabled" && bQ.reasoning_effort === undefined);
    eq("declared: 无目录 → undefined", declaredEffortValues("nobody-knows"), undefined);
    resetCatalogForTest([]);
  }

  // ---------- 3. reasoning_content 回传白名单 ----------
  {
    stub.__resetConfig();
    for (const m of ["glm-5.3", "glm-5", "GLM-4.7", "zai-org/glm-4.9", "deepseek-v3.2", "deepseek-v4", "deepseek-chat", "deepseek-reasoner", "kimi-k2-thinking", "moonshot/kimi-k3"]) {
      check(`echo: ${m} 要回传`, wantsReasoningEcho(m));
    }
    for (const m of ["gpt-5", "claude-sonnet-4-5", "qwen3", "deepseek-v3.1", "glm-4.6", "kimi-k1"]) {
      check(`echo: ${m} 不回传`, !wantsReasoningEcho(m));
    }
    check("echo: 总开关 auto → 按家族", shouldEchoReasoning("glm-5.3") && !shouldEchoReasoning("gpt-5"));
    stub.__setConfig("openaiReasoningEcho", "off");
    check("echo: off 全关", !shouldEchoReasoning("glm-5.3"));
    stub.__setConfig("openaiReasoningEcho", "always");
    check("echo: always 全开", shouldEchoReasoning("gpt-5"));
    stub.__resetConfig();

    // buildOpenaiRequest：历史 assistant 的 reasoning_content 只给白名单家族带
    const hist = [
      { userInputMessage: { content: "q", modelId: "glm-5.3", userInputMessageContext: {} } },
      { assistantResponseMessage: { content: "a", reasoningContent: { reasoningText: { text: "the thought", signature: SYNTHETIC_REASONING_SIGNATURE } } } },
    ];
    const rG = cwRequest({ modelId: "glm-5.3", history: hist }) as unknown as CwRequest;
    const bG = buildOpenaiRequest(rG, oai);
    const aG = bG.messages.find((m) => m.role === "assistant")!;
    eq("echo-build: GLM 历史带 reasoning_content 原文", aG.reasoning_content, "the thought");
    const rO = cwRequest({ modelId: "gpt-5", history: hist.map((h) => (h.userInputMessage ? { userInputMessage: { ...h.userInputMessage, modelId: "gpt-5" } } : h)) }) as unknown as CwRequest;
    const bO = buildOpenaiRequest(rO, oai);
    const aO = bO.messages.find((m) => m.role === "assistant")!;
    check("echo-build: GPT 历史不带 reasoning_content（严格网关 400）", aO.reasoning_content === undefined);
  }

  // ---------- 4. 合成签名：OpenAI 侧补发；Anthropic / Gemini 侧跳过 ----------
  {
    check("sig: 常量前缀 api4kiro:", isSyntheticSignature(SYNTHETIC_REASONING_SIGNATURE) && SYNTHETIC_REASONING_SIGNATURE === "api4kiro:unsigned-reasoning");
    check("sig: 真签名不算合成", !isSyntheticSignature("EqQBCkYIBxgC") && !isSyntheticSignature(undefined) && !isSyntheticSignature(""));

    // OpenAI 流：echoReasoning=true 的家族思考结束补一帧签名；其它不补
    const cEcho = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "off" });
    const evEcho = feedAll(cEcho, [chunk({ reasoning_content: "The user asks X. Let me think." }), chunk({ content: "Answer" }), chunk({}, "stop"), "data: [DONE]"]);
    eq("sig-oai: echo 家族思考结束补合成签名", signatures(evEcho), [SYNTHETIC_REASONING_SIGNATURE]);
    const iSig = evEcho.findIndex((e) => e.reasoningContentEvent?.signature);
    const iTxt = evEcho.findIndex((e) => e.assistantResponseEvent);
    check("sig-oai: 签名帧在正文之前", iSig >= 0 && iSig < iTxt);
    const cNo = new OpenaiStreamConverter("c", "gpt-5", { echoReasoning: false, thoughtDedupe: "off" });
    const evNo = feedAll(cNo, [chunk({ reasoning_content: "The user asks X." }), chunk({ content: "Answer" }), chunk({}, "stop")]);
    eq("sig-oai: 非 echo 家族不补签名", signatures(evNo), []);
    // 只有思考、没正文的流也要收束（签名在 flush 补）
    const cOnly = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "off" });
    const evOnly = feedAll(cOnly, [chunk({ reasoning_content: "The user wants… still thinking" }), chunk({}, "length")]);
    eq("sig-oai: 只思考无正文 flush 也补签名", signatures(evOnly), [SYNTHETIC_REASONING_SIGNATURE]);
    eq("sig-oai: finish=length → MAX_TOKENS", stopReasons(evOnly), ["MAX_TOKENS"]);

    // Anthropic 侧：历史里带合成签名的 reasoning 不转 thinking 块
    const anth: ProviderConfig = { id: "pa", name: "a", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };
    const rA = cwRequest({
      modelId: "claude-sonnet-4-5",
      history: [
        { userInputMessage: { content: "q", modelId: "claude-sonnet-4-5", userInputMessageContext: {} } },
        { assistantResponseMessage: { content: "a", reasoningContent: { reasoningText: { text: "glm thought", signature: SYNTHETIC_REASONING_SIGNATURE } } } },
        { userInputMessage: { content: "q2", modelId: "claude-sonnet-4-5", userInputMessageContext: {} } },
        { assistantResponseMessage: { content: "b", reasoningContent: { reasoningText: { text: "claude thought", signature: "REAL" } } } },
      ],
    }) as unknown as CwRequest;
    const bA = buildAnthropicRequest(rA, anth);
    const asst = bA.messages.filter((m) => m.role === "assistant");
    check("sig-anth: 合成签名的思考被跳过（content 退成纯字串）", typeof asst[0].content === "string" && asst[0].content === "a");
    check("sig-anth: 真签名的思考保留为 thinking 块", Array.isArray(asst[1].content) && asst[1].content[0].type === "thinking");

    // Gemini 侧：合成签名当作没有 → Gemini 3 用哨兵，且不关本轮 thinking
    const gem: ProviderConfig = { id: "pg", name: "g", protocol: "gemini", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };
    const rG = cwRequest({
      modelId: "gemini-3.6-flash",
      history: [
        { userInputMessage: { content: "q", modelId: "gemini-3.6-flash", userInputMessageContext: {} } },
        { assistantResponseMessage: { content: "", toolUses: [{ toolUseId: "t1", name: "ls", input: "{}" }], reasoningContent: { reasoningText: { text: "glm thought", signature: SYNTHETIC_REASONING_SIGNATURE } } } },
      ],
      toolResults: [{ toolUseId: "t1", content: [{ text: "ok" }] }],
      effort: "high",
    }) as unknown as CwRequest;
    const bG = buildGeminiRequest(rG, gem, { effort: "high" });
    const modelTurn = bG.request.contents.find((c) => c.role === "model")!;
    const fc = modelTurn.parts.find((p) => p.functionCall)!;
    eq("sig-gem: 合成签名不回放 → functionCall 用官方哨兵", fc.thoughtSignature, "skip_thought_signature_validator");
    check("sig-gem: 合成签名不导致 thinkingConfig 被关", !!bG.request.generationConfig?.thinkingConfig);
    check("sig-gem: 不产生 thought:true 部件", !modelTurn.parts.some((p) => p.thought));
  }

  // ---------- 5. thought gate ----------
  {
    // ≥120 个非空白字符：reasoningLooksLikeAnswer 的长度门槛
    const answerish =
      "你好！👋 我是 Kiro，一个专注于软件工程的 AI 编程助手，可以在你的 IDE 里直接阅读、修改和运行代码。\n\n" +
      "我可以帮你：\n- 编写新功能与单元测试\n- 定位并修复 bug\n- 重构与解释现有代码\n- 起草规格与设计文档\n\n" +
      "把你想做的事情告诉我，我们现在就开始。有什么可以帮你的吗？";
    const delib = "The user is greeting me. Let me respond warmly and briefly introduce myself.";
    eq("head: 推敲开头", classifyReasoningHead(delib), "deliberation");
    eq("head: 中文推敲开头", classifyReasoningHead("用户在打招呼，我应该简短回应"), "deliberation");
    eq("head: 问候开头像回答", classifyReasoningHead(answerish), "answer");
    eq("head: markdown 标题像回答", classifyReasoningHead("## 概述\n这是..."), "answer");
    eq("head: 太短两边都不像 → undecided", classifyReasoningHead("Well"), "undecided");
    eq("head: 空 → undecided", classifyReasoningHead(""), "undecided");
    eq("head: 攒够字仍不像回答 → deliberation", classifyReasoningHead("Some fairly long neutral sentence about nothing in particular here."), "deliberation");

    // exact：正文是思考的逐字复读 → 丢思考，只留正文
    const cx = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "exact" });
    const evx = feedAll(cx, [
      chunk({ reasoning_content: answerish.slice(0, 20) }),
      chunk({ reasoning_content: answerish.slice(20) }),
      chunk({ content: answerish.slice(0, 15) }),
      chunk({ content: answerish.slice(15, 60) }),
      chunk({ content: answerish.slice(60) }),
      chunk({}, "stop"),
    ]);
    eq("gate-exact: 复读的思考被丢", reasonings(evx), "");
    eq("gate-exact: 正文完整", texts(evx), answerish);
    check("gate-exact: anomaly=duplicate_thought_dropped", cx.anomalies.has("duplicate_thought_dropped"));
    eq("gate-exact: 丢了思考就不补签名", signatures(evx), []);
    eq("gate-exact: stopReason", stopReasons(evx), ["END_TURN"]);

    // exact：正文不同于思考（改写）→ 原样放行思考（不丢字）
    const cx2 = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "exact" });
    const rewritten = "嗨！很高兴见到你。我是 Kiro，一个 AI 编程助手，可以帮你写代码、修 bug、重构和写文档。今天需要什么帮助？";
    const evx2 = feedAll(cx2, [chunk({ reasoning_content: answerish }), chunk({ content: rewritten }), chunk({}, "stop")]);
    eq("gate-exact: 改写版不算复读，思考放行", reasonings(evx2), answerish);
    eq("gate-exact: 正文照发", texts(evx2), rewritten);
    eq("gate-exact: 放行的思考补签名", signatures(evx2), [SYNTHETIC_REASONING_SIGNATURE]);
    check("gate-exact: 放行后整段仍像回答 → answer_in_reasoning", cx2.anomalies.has("answer_in_reasoning"));

    // aggressive：开头像回答的思考，正文改写也丢
    const ca = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "aggressive" });
    const eva = feedAll(ca, [chunk({ reasoning_content: answerish }), chunk({ content: rewritten }), chunk({}, "stop")]);
    eq("gate-aggressive: 改写版也丢思考", reasonings(eva), "");
    eq("gate-aggressive: 正文照发", texts(eva), rewritten);
    check("gate-aggressive: anomaly=duplicate_thought_dropped", ca.anomalies.has("duplicate_thought_dropped"));

    // aggressive 不误伤真推敲
    const ca2 = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "aggressive" });
    const eva2 = feedAll(ca2, [chunk({ reasoning_content: delib }), chunk({ content: "Hi there!" }), chunk({}, "stop")]);
    eq("gate-aggressive: 真推敲直播不扣", reasonings(eva2), delib);

    // off：一律直播
    const co = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "off" });
    const evo = feedAll(co, [chunk({ reasoning_content: answerish }), chunk({ content: answerish }), chunk({}, "stop")]);
    eq("gate-off: 复读也直播", reasonings(evo), answerish);
    eq("gate-off: 正文照发", texts(evo), answerish);

    // promote：只有像回答的思考、没有正文 → 提升为正文
    const cp = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "exact" });
    const evp = feedAll(cp, [chunk({ reasoning_content: answerish }), chunk({}, "stop")]);
    eq("gate-promote: 思考提升为正文", texts(evp), answerish);
    eq("gate-promote: 不再作为思考发", reasonings(evp), "");
    check("gate-promote: anomaly=thought_promoted_to_content", cp.anomalies.has("thought_promoted_to_content"));
    check("gate-promote: 仍带 stopReason", stopReasons(evp).length === 1);

    // 工具调用到达时扣住的思考原样放行
    const ct = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "exact" });
    const evt = feedAll(ct, [
      chunk({ reasoning_content: "## 计划\n1. 读文件" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "readFile", arguments: '{"p":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    eq("gate-tool: 扣住的思考随工具调用放行", reasonings(evt), "## 计划\n1. 读文件");
    eq("gate-tool: 工具参数分片重组", toolUses(evt).map((t) => [t.toolUseId, t.name, t.input]), [["call_1", "readFile", '{"p":"a"}']]);
    eq("gate-tool: stopReason=TOOL_USE", stopReasons(evt), ["TOOL_USE"]);

    // 短思考（sniff 阶段未决）+ 长正文：不丢
    const cs = new OpenaiStreamConverter("c", "glm-5.3", { echoReasoning: true, thoughtDedupe: "aggressive" });
    const evs = feedAll(cs, [chunk({ reasoning_content: "Hmm" }), chunk({ content: "A completely different long answer that goes on." }), chunk({}, "stop")]);
    eq("gate-sniff: 未决的短思考放行", reasonings(evs), "Hmm");

    // reasoningLooksLikeAnswer 形态判定
    check("shape: 排版+emoji+收尾提问 → 像回答", reasoningLooksLikeAnswer(answerish, "x".repeat(50)));
    check("shape: 短思考不判", !reasoningLooksLikeAnswer("你好👋", "x".repeat(50)));
    check("shape: 正文太短不判", !reasoningLooksLikeAnswer(answerish, "ok"));
    check("shape: 纯推敲不判", !reasoningLooksLikeAnswer("The user wants a function that sorts. I need to consider edge cases like empty arrays, duplicates, and stability. Quick sort or merge sort. Merge sort is stable. I'll go with merge sort and explain complexity.", "x".repeat(50)));
  }

  // ---------- 6. OpenAI 流杂项：reasoning 字段变体、usage、非流式整包 ----------
  {
    const c = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const ev = feedAll(c, [
      chunk({ reasoning: "openrouter style" }),
      chunk({ content: [{ type: "text", text: "parts " }, { type: "text", text: "content" }] }),
      chunk({}, "stop"),
      sse({ id: "x", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } }),
      "data: [DONE]",
    ]);
    eq("oai: reasoning 字段（OpenRouter）也认", reasonings(ev), "openrouter style");
    eq("oai: content parts 数组拼接", texts(ev), "parts content");
    const tu = ev.find((e) => e.metadataEvent?.tokenUsage)!.metadataEvent!.tokenUsage!;
    eq("oai: tokenUsage uncached = prompt - cached", tu, { uncachedInputTokens: 60, outputTokens: 20, cacheReadInputTokens: 40, cacheWriteInputTokens: 0 });
    eq("oai: meteringUsage 缓存清零（prompt 已含）", c.meteringUsage(), { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });
    // 网关无视 stream:true 的整包 JSON
    const c2 = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const whole = JSON.stringify({ id: "y", choices: [{ index: 0, message: { role: "assistant", content: "whole body" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const ev2 = feedAll(c2, whole.split("\n"));
    eq("oai: 非 SSE 整包在 flush 解析", texts(ev2), "whole body");
    eq("oai: 整包 stopReason", stopReasons(ev2), ["END_TURN"]);
    // 流中错误
    const c3 = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const ev3 = feedAll(c3, [sse({ error: { message: "quota exceeded", type: "insufficient_quota" } })]);
    check("oai: 200 流里的 error 转成可见文本", texts(ev3).includes("quota exceeded"));
    check("oai: 出错仍有 stopReason", stopReasons(ev3).length === 1);
    // 旧式 function_call
    const c4 = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const ev4 = feedAll(c4, [chunk({ function_call: { name: "legacy", arguments: '{"a":1}' } }), chunk({}, "function_call")]);
    eq("oai: 旧式 function_call → toolUseEvent", toolUses(ev4).map((t) => [t.name, t.input]), [["legacy", '{"a":1}']]);
    check("oai: 无 id 时合成 toolUseId", toolUses(ev4)[0].toolUseId.startsWith("call_c_"));
  }

  // ---------- 7. effort 缓存：续跑轮缺 effort 用本会话上一档 ----------
  {
    const r1 = cwRequest({ convId: "conv-eff", modelId: "m", effort: "xhigh" }) as unknown as CwRequest;
    eq("effort: 请求内嵌", effortFromRequest(r1), "xhigh");
    eq("effort: getSelectedEffort 取内嵌并缓存", await getSelectedEffort(r1), "xhigh");
    const r2 = cwRequest({ convId: "conv-eff", modelId: "m", toolResults: [{ toolUseId: "t", content: "x" }] }) as unknown as CwRequest;
    eq("effort: 续跑轮无 effort → 会话缓存", await getSelectedEffort(r2), "xhigh");
    const r3 = cwRequest({ convId: "conv-other", modelId: "m" }) as unknown as CwRequest;
    eq("effort: 别的会话无缓存 → undefined", await getSelectedEffort(r3), undefined);
    const cmd = vscode.commands.registerCommand("kiro.agentModels.getEffortLevel", async () => "low");
    eq("effort: Kiro 命令可用时优先于缓存", await getSelectedEffort(r2), "low");
    cmd.dispose();
    eq("effort: 命令结果也进缓存", await getSelectedEffort(r2), "low");
    eq("effort: 非法值不认", effortFromRequest(cwRequest({ modelId: "m", effort: "ultra" }) as unknown as CwRequest), undefined);
  }
});
