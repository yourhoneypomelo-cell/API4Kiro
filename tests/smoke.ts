/**
 * smoke：Anthropic 流转换的基本盘 + 跨协议共用的 streamShared 规则。
 *  - 文本 / 思考 / tool_use 分片重组
 *  - 每条流末必带 metadataEvent.stopReason（R7）
 *  - tokenUsage 必须是嵌套形
 *  - 整轮只有一条 meteringEvent（turnLedger + buildMeteringEvents）
 *  - 输出 token 口径：total − prompt → completion + reasoning → completion
 *  - Anthropic 请求组包：thinking 块排首、合成签名不回传、$ref 内联、system 注入
 */
import { AnthropicStreamConverter } from "../src/anthropicStream";
import { buildAnthropicRequest, applyEffort, parseToolSpec, toolResultToText, latestModelId, resolveModelForProvider } from "../src/translate";
import { buildMeteringEvents, resolveOutputTokens, toCwStopReason, contextWindowForModel } from "../src/streamShared";
import { addRequestUsage, beginTurn, takeTurnTotals, resetAll } from "../src/turnLedger";
import { buildIntentClassifierResponse, isIntentClassifierRequest } from "../src/intentClassifier";
import { SYNTHETIC_REASONING_SIGNATURE } from "../src/thinkingPolicy";
import { ProviderConfig } from "../src/providers";
import { CwRequest } from "../src/cwTypes";
import * as vscode from "vscode";
import {
  check,
  eq,
  feedAll,
  lastIsStopReason,
  meterings,
  reasonings,
  run,
  signatures,
  sse,
  stopReasons,
  texts,
  tokenUsages,
  toolUses,
  contextUsages,
  cwRequest,
  toolSpec,
} from "./lib/cw";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void };

const provider: ProviderConfig = { id: "p1", name: "anth", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };

function anthropicText(...deltas: string[]): string[] {
  const lines = [
    sse({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } }),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ];
  for (const d of deltas) {
    lines.push(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } }));
  }
  lines.push(sse({ type: "content_block_stop", index: 0 }));
  lines.push(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }));
  lines.push(sse({ type: "message_stop" }));
  return lines;
}

run("smoke", async () => {
  // ---------- 1. 纯文本流 ----------
  {
    const c = new AnthropicStreamConverter("conv", "claude-x");
    const ev = feedAll(c, anthropicText("Hel", "lo", " world"));
    eq("text: 正文按 delta 顺序拼接", texts(ev), "Hello world");
    check("text: 首帧 messageMetadataEvent", !!ev[0].messageMetadataEvent && ev[0].messageMetadataEvent.conversationId === "conv");
    eq("text: stopReason=END_TURN", stopReasons(ev), ["END_TURN"]);
    check("text: 流末最后一帧是 stopReason", lastIsStopReason(ev));
    const tu = tokenUsages(ev);
    eq("text: tokenUsage 嵌套形 & uncached=input_tokens", tu, [{ uncachedInputTokens: 100, outputTokens: 42, cacheReadInputTokens: 20, cacheWriteInputTokens: 5 }]);
    check("text: 转换器自身不发 metering（轮末由泵统一发）", meterings(ev).length === 0);
    check("text: sawToolUse=false", c.sawToolUse === false);
    eq("text: meteringUsage 原样交出 cache 分项", c.meteringUsage(), { inputTokens: 100, outputTokens: 42, cacheReadTokens: 20, cacheCreationTokens: 5 });
    check("text: 有 usage 就有 contextUsageEvent", contextUsages(ev).length === 1 && contextUsages(ev)[0] > 0);
  }

  // ---------- 2. tool_use 分片重组 ----------
  {
    const c = new AnthropicStreamConverter("conv", "claude-x");
    const argObj = { path: "src/a.ts", content: "x".repeat(5000), nested: { a: [1, 2, 3], b: "中文 ✓" } };
    const full = JSON.stringify(argObj);
    const frags: string[] = [];
    for (let i = 0; i < full.length; i += 37) {
      frags.push(full.slice(i, i + 37));
    }
    const lines = [
      sse({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll write the file." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "fsWrite", input: {} } }),
      ...frags.map((f) => sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: f } })),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 300 } }),
    ];
    const ev = feedAll(c, lines);
    const tus = toolUses(ev);
    eq("tool: 恰好一个 toolUseEvent", tus.length, 1);
    eq("tool: id/name 透传", [tus[0].toolUseId, tus[0].name], ["toolu_01", "fsWrite"]);
    eq("tool: 分片拼回原 JSON", tus[0].input, full);
    check("tool: input 可解析且深层字段一致", JSON.parse(tus[0].input).nested.b === "中文 ✓");
    eq("tool: stopReason=TOOL_USE", stopReasons(ev), ["TOOL_USE"]);
    check("tool: sawToolUse=true", c.sawToolUse === true);
    check("tool: 正文在工具前", texts(ev) === "I'll write the file.");
  }

  // ---------- 3. 未收到 content_block_stop 的悬空 tool_use 由 flush 兜底 ----------
  {
    const c = new AnthropicStreamConverter("conv", "claude-x");
    const ev = feedAll(c, [
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t2", name: "readFile" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"p":"a"}' } }),
    ]);
    eq("tool-dangling: flush 补发 toolUseEvent", toolUses(ev).map((t) => t.input), ['{"p":"a"}']);
    eq("tool-dangling: stopReason=TOOL_USE", stopReasons(ev), ["TOOL_USE"]);
  }

  // ---------- 4. 空 input 的工具 → "{}" ----------
  {
    const c = new AnthropicStreamConverter("conv", "m");
    const ev = feedAll(c, [
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t3", name: "listDir" } }),
      sse({ type: "content_block_stop", index: 0 }),
    ]);
    eq("tool-empty: input 退成 {}", toolUses(ev)[0].input, "{}");
  }

  // ---------- 5. thinking 块 + 签名 ----------
  {
    const c = new AnthropicStreamConverter("conv", "m");
    const ev = feedAll(c, [
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIGabc" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    ]);
    eq("thinking: 思考文本进 reasoningContentEvent", reasonings(ev), "Let me think");
    eq("thinking: 签名在块尾单独一帧", signatures(ev), ["SIGabc"]);
    eq("thinking: 正文不含思考", texts(ev), "Answer");
    const idxSig = ev.findIndex((e) => e.reasoningContentEvent?.signature);
    const idxText = ev.findIndex((e) => e.assistantResponseEvent);
    check("thinking: 签名帧先于正文", idxSig < idxText);
  }

  // ---------- 6. 中转站错配：thinking 块里发 text_delta → 按块类型归思考 ----------
  {
    const c = new AnthropicStreamConverter("conv", "m");
    const ev = feedAll(c, [
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "secret thought" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "misrouted" } }),
      sse({ type: "content_block_stop", index: 1 }),
    ]);
    eq("mismatch: text_delta 在 thinking 块里仍是思考", reasonings(ev), "secret thoughtmisrouted");
    eq("mismatch: 正文为空", texts(ev), "");
    check("mismatch: 记录 anomalies", c.anomalies.has("text_in_thinking") && c.anomalies.has("thinking_in_text"));
  }

  // ---------- 7. stop_reason 归一 ----------
  {
    eq("stop: end_turn", toCwStopReason("end_turn", false), "END_TURN");
    eq("stop: max_tokens", toCwStopReason("max_tokens", false), "MAX_TOKENS");
    eq("stop: length(OpenAI)", toCwStopReason("length", false), "MAX_TOKENS");
    eq("stop: stop_sequence", toCwStopReason("stop_sequence", false), "STOP_SEQUENCE");
    eq("stop: tool_calls(OpenAI)", toCwStopReason("tool_calls", false), "TOOL_USE");
    eq("stop: sawToolUse 优先", toCwStopReason("end_turn", true), "TOOL_USE");
    eq("stop: 未知 → END_TURN（宁少续写不重发）", toCwStopReason("weird", false), "END_TURN");
    eq("stop: 空 → END_TURN", toCwStopReason(undefined, false), "END_TURN");
    const c = new AnthropicStreamConverter("conv", "m");
    const ev = feedAll(c, [sse({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } })]);
    eq("stop: Anthropic max_tokens 透传", stopReasons(ev), ["MAX_TOKENS"]);
    const c2 = new AnthropicStreamConverter("conv", "m");
    const ev2 = feedAll(c2, []);
    eq("stop: 空流也必带 stopReason", stopReasons(ev2), ["END_TURN"]);
  }

  // ---------- 8. 输出 token 口径 ----------
  {
    eq("out: total-prompt 优先（中转站 reasoning 不计入 completion）", resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125, total_tokens: 11928, completion_tokens_details: { reasoning_tokens: 11773 } }), 11898);
    eq("out: OpenAI 官方 completion 已含 reasoning，不双计", resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 200, total_tokens: 230, completion_tokens_details: { reasoning_tokens: 150 } }), 200);
    eq("out: 无 total → completion+reasoning", resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125, completion_tokens_details: { reasoning_tokens: 100 } }), 225);
    eq("out: 只有 completion", resolveOutputTokens({ prompt_tokens: 30, completion_tokens: 125 }), 125);
    eq("out: billing_usage.openai_usage 优先", resolveOutputTokens({ input_tokens: 30, output_tokens: 5, billing_usage: { openai_usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 1030 } } }), 1000);
    eq("out: undefined → 0", resolveOutputTokens(undefined), 0);
    const c = new AnthropicStreamConverter("conv", "m");
    feedAll(c, [sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 30, output_tokens: 5, billing_usage: { openai_usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 1030 } } } })]);
    eq("out: 转换器 captureUsage 用 total-prompt", c.usage.outputTokens, 1000);
  }

  // ---------- 9. 整轮一条 metering ----------
  {
    resetAll();
    beginTurn("c1");
    addRequestUsage("c1", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 0 });
    addRequestUsage("c1", { inputTokens: 1200, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 10 });
    addRequestUsage("c1", { inputTokens: 1300, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const total = takeTurnTotals("c1");
    eq("ledger: 三次请求累加", total, { inputTokens: 3500, outputTokens: 650, cacheReadTokens: 500, cacheCreationTokens: 10 });
    eq("ledger: 结账后清空", takeTurnTotals("c1"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const m = buildMeteringEvents(total);
    eq("metering: 恰好一条", m.length, 1);
    eq("metering: usage=in+cache+out", m[0].meteringEvent!.usage, 3500 + 500 + 10 + 650);
    eq("metering: unit 稳定", m[0].meteringEvent!.unit, "token");
    eq("metering: unitPlural 带分解", m[0].meteringEvent!.unitPlural, "tokens (in 4.01k / out 650)");
    eq("metering: 零用量不发", buildMeteringEvents({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }).length, 0);
    eq("metering: 紧凑计数 999999→1M", buildMeteringEvents({ inputTokens: 999999, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 })[0].meteringEvent!.unitPlural, "tokens (in 1M / out 1)");
    // 新一轮 beginTurn 会把上一轮泄漏的清掉
    addRequestUsage("c2", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    beginTurn("c2");
    eq("ledger: beginTurn 重置泄漏", takeTurnTotals("c2").inputTokens, 0);
  }

  // ---------- 10. 上下文窗口启发式 ----------
  {
    eq("ctx: fable-5 → 1M", contextWindowForModel("claude-fable-5-1"), 1000000);
    eq("ctx: opus-4-8 → 1M", contextWindowForModel("claude-opus-4-8"), 1000000);
    eq("ctx: sonnet-4-5 → 200K", contextWindowForModel("claude-sonnet-4-5"), 200000);
    eq("ctx: gpt → 272K", contextWindowForModel("gpt-5.6-terra"), 272000);
    eq("ctx: 未知 → 200K 兜底", contextWindowForModel("mystery"), 200000);
  }

  // ---------- 11. Anthropic 请求组包 ----------
  {
    stub.__resetConfig();
    const req = cwRequest({
      modelId: "claude-sonnet-4-5",
      content: "continue",
      history: [
        { userInputMessage: { content: "first", modelId: "claude-sonnet-4-5", userInputMessageContext: {} } },
        {
          assistantResponseMessage: {
            content: "let me read",
            toolUses: [{ toolUseId: "t1", name: "readFile", input: '{"path":"a"}' }],
            reasoningContent: { reasoningText: { text: "signed thought", signature: "REALSIG" } },
          },
        },
        { userInputMessage: { content: "", modelId: "claude-sonnet-4-5", userInputMessageContext: { toolResults: [{ toolUseId: "t1", content: [{ text: "file body" }], status: "success" }] } } },
        {
          assistantResponseMessage: {
            content: "ok",
            reasoningContent: { reasoningText: { text: "glm thought", signature: SYNTHETIC_REASONING_SIGNATURE } },
          },
        },
      ],
      tools: [toolSpec("readFile", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, "read a file")],
    }) as unknown as CwRequest;
    const body = buildAnthropicRequest(req, provider);
    eq("build: model 解析为裸 id", body.model, "claude-sonnet-4-5");
    check("build: stream=true", body.stream === true);
    const a1 = body.messages[1];
    check("build: 带签名的 thinking 块排在 assistant 消息最前", Array.isArray(a1.content) && a1.content[0].type === "thinking" && (a1.content[0] as { signature: string }).signature === "REALSIG");
    check("build: tool_use input 已解析为对象", Array.isArray(a1.content) && a1.content.some((b) => b.type === "tool_use" && typeof (b as { input: unknown }).input === "object"));
    const u2 = body.messages[2];
    check("build: tool_result 落在 user 消息里", Array.isArray(u2.content) && u2.content[0].type === "tool_result" && (u2.content[0] as { content: string }).content === "file body");
    const a3 = body.messages[3];
    check("build: 合成签名的思考不回传（否则 Claude 400 Invalid signature）", typeof a3.content === "string" && a3.content === "ok");
    eq("build: 工具声明形状", body.tools, [{ name: "readFile", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]);
    check("build: 无 system 时不带字段", body.system === undefined);
    check("build: 默认不带 thinking（auto 模式透传 effort）", body.thinking === undefined);

    // applyEffort：auto 透传 output_config
    applyEffort(body, "p1", "high");
    eq("effort: auto 模式透传 output_config.effort", body.output_config, { effort: "high" });
    applyEffort(body, "p1", "max", "pro");
    eq("effort: 带 reasoning mode", body.output_config, { effort: "max", mode: "pro" });
    const b2 = buildAnthropicRequest(req, provider);
    applyEffort(b2, "p1", undefined);
    check("effort: 无 effort 不加字段", b2.output_config === undefined && b2.thinking === undefined);
    stub.__setConfig("effortMode", "thinkingBudget");
    const b3 = buildAnthropicRequest(req, provider);
    applyEffort(b3, "p1", "high");
    eq("effort: thinkingBudget 模式换算 budget_tokens", b3.thinking, { type: "enabled", budget_tokens: 8192 });
    stub.__setConfig("effortMode", "off");
    const b4 = buildAnthropicRequest(req, provider);
    applyEffort(b4, "p1", "high");
    check("effort: off 模式不加字段", b4.output_config === undefined);
    stub.__resetConfig();
  }

  // ---------- 12. 辅助函数 ----------
  {
    eq("toolResultToText: 数组 text 拼接", toolResultToText([{ text: "a" }, { json: { x: 1 } }, "c"]), 'a\n{"x":1}\nc');
    eq("toolResultToText: null → 空", toolResultToText(null), "");
    eq("parseToolSpec: 裸 spec 形态", parseToolSpec({ name: "x", inputSchema: { type: "object", properties: {} } } as never).name, "x");
    const q = cwRequest({ modelId: "gpt-5@p2" }) as unknown as CwRequest;
    eq("latestModelId: 取 currentMessage", latestModelId(q), "gpt-5@p2");
    eq("resolveModelForProvider: 去渠道限定", resolveModelForProvider(provider, "gpt-5@p2"), "gpt-5");
    eq("resolveModelForProvider: modelMapping 优先", resolveModelForProvider({ ...provider, modelMapping: { "gpt-5": "real-gpt" } }, "gpt-5@p2"), "real-gpt");
    eq("resolveModelForProvider: defaultModel 兜底", resolveModelForProvider({ ...provider, defaultModel: "dflt" }, "unknown"), "dflt");
  }

  // ---------- 13. 意图分类器本地应答必带 stopReason ----------
  {
    const req = cwRequest({ modelId: "m", content: "You are an intent classifier for a language model ... (chat, do, spec) ... Here is the last user message: create a spec for login" }) as unknown as CwRequest;
    check("intent: 识别", isIntentClassifierRequest(req));
    const ev = buildIntentClassifierResponse(req, "c", "m");
    check("intent: 末帧 stopReason=END_TURN", lastIsStopReason(ev) && stopReasons(ev)[0] === "END_TURN");
    check("intent: spec 概率高", JSON.parse(texts(ev)).spec > 0.5);
  }
});
