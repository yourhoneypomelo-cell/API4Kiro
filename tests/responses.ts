/**
 * responses：OpenAI Responses API 通路（responsesTranslate / responsesStream）。
 *  - 三种 reasoning 事件都认（summary_text.delta / reasoning_text.delta / reasoning_summary.delta）
 *  - mapResponsesEffort：目录声明透传（含 none / xhigh / max）；未声明才折 low/medium/high；none→low
 *  - 多段摘要（summary_part.done 之后再来 delta）之间补 "\n\n"，段末不悬空；done 里整段 summary[] 同样连接
 *  - encrypted_content → "a2k-rs:" 签名往返；function_call 参数按 item_id 累加、done 以整串为准
 *  - stopReason：incomplete/max_output_tokens → MAX_TOKENS；tool → TOOL_USE
 *  - 非 SSE 整包 Response 对象兜底
 */
import * as vscode from "vscode";
import { ResponsesStreamConverter, SUMMARY_PART_SEPARATOR } from "../src/responsesStream";
import {
  applyResponsesEffort,
  buildResponsesRequest,
  decodeReasoningSignature,
  encodeReasoningSignature,
  mapResponsesEffort,
} from "../src/responsesTranslate";
import { resetCatalogForTest } from "../src/modelCatalog";
import { ProviderConfig } from "../src/providers";
import { CwRequest } from "../src/cwTypes";
import { check, eq, feedAll, lastIsStopReason, reasonings, run, signatures, sse, stopReasons, texts, tokenUsages, toolUses, contextUsages, cwRequest, toolSpec } from "./lib/cw";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void };

const prov: ProviderConfig = { id: "pr", name: "resp", protocol: "openai", openaiApi: "responses", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };

run("responses", async () => {
  // ---------- 1. 三种 reasoning 事件 ----------
  {
    for (const t of ["response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.reasoning_summary.delta"]) {
      const c = new ResponsesStreamConverter("c", "gpt-5");
      const ev = feedAll(c, [
        sse({ type: "response.created", response: { id: "r" } }),
        sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } }),
        sse({ type: t, item_id: "rs_1", delta: "think " }),
        sse({ type: t, item_id: "rs_1", delta: "more" }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "answer" }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      ]);
      eq(`reasoning: ${t.split(".")[1]} → reasoningContentEvent`, reasonings(ev), "think more");
      eq(`reasoning: ${t.split(".")[1]} 正文独立`, texts(ev), "answer");
    }
  }

  // ---------- 2. 多段摘要分隔（缺陷 b） ----------
  {
    eq("sep: 常量是空行", SUMMARY_PART_SEPARATOR, "\n\n");
    const c = new ResponsesStreamConverter("c", "gpt-5");
    const ev = feedAll(c, [
      sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } }),
      sse({ type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "**标题A**" }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: " 内容A" }),
      sse({ type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "**标题A** 内容A" }),
      sse({ type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "**标题A** 内容A" } }),
      sse({ type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1, part: { type: "summary_text", text: "" } }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "**标题B**" }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: " 内容B" }),
      sse({ type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 1, text: "**标题B** 内容B" }),
      sse({ type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1, part: { type: "summary_text", text: "**标题B** 内容B" } }),
      sse({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**标题A** 内容A" }, { type: "summary_text", text: "**标题B** 内容B" }], encrypted_content: "ENC1" } }),
      sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "hi" }),
      sse({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    const r = reasonings(ev);
    eq("sep: 两段之间有空行，段末不悬空", r, "**标题A** 内容A\n\n**标题B** 内容B");
    check("sep: 不会拼成 **标题A****标题B**", !r.includes("****"));
    check("sep: done 里的 summary 不重复补发", (r.match(/标题A/g) || []).length === 1);
    eq("sep: 签名 a2k-rs: 前缀", signatures(ev), ["a2k-rs:ENC1"]);
    // 只有一段：不加分隔
    const c1 = new ResponsesStreamConverter("c", "gpt-5");
    const ev1 = feedAll(c1, [
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "only" }),
      sse({ type: "response.reasoning_summary_part.done", item_id: "rs_1" }),
      sse({ type: "response.output_text.delta", item_id: "m", delta: "x" }),
    ]);
    eq("sep: 单段无分隔", reasonings(ev1), "only");
    // 两个不同 reasoning item 互不影响
    const c2 = new ResponsesStreamConverter("c", "gpt-5");
    const ev2 = feedAll(c2, [
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "A" }),
      sse({ type: "response.reasoning_summary_part.done", item_id: "rs_1" }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_2", delta: "B" }),
    ]);
    eq("sep: 不同 item 之间不补分隔（按 item 记）", reasonings(ev2), "AB");
    // done 里整段 summary[]（网关不发 delta）
    const c3 = new ResponsesStreamConverter("c", "gpt-5");
    const ev3 = feedAll(c3, [
      sse({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_9", summary: [{ type: "summary_text", text: "**A**" }, { type: "summary_text", text: "**B**" }] } }),
    ]);
    eq("sep: done 整段 summary 用同一分隔连接", reasonings(ev3), "**A**\n\n**B**");
  }

  // ---------- 3. mapResponsesEffort（缺陷 a） ----------
  {
    resetCatalogForTest([
      { id: "gpt-5.4", input: { text: true, image: true, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }] },
      { id: "o3-mini", input: { text: true, image: false, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] },
    ]);
    eq("mapEffort: 目录声明 xhigh → 透传", mapResponsesEffort("xhigh", "gpt-5.4"), "xhigh");
    eq("mapEffort: 目录声明 none → 透传", mapResponsesEffort("none", "gpt-5.4"), "none");
    eq("mapEffort: 目录未声明 max → 折 high", mapResponsesEffort("max", "gpt-5.4"), "high");
    eq("mapEffort: o3-mini xhigh 未声明 → high", mapResponsesEffort("xhigh", "o3-mini"), "high");
    eq("mapEffort: 无目录 none → low", mapResponsesEffort("none", "unknown-r1"), "low");
    eq("mapEffort: 无目录 medium → medium", mapResponsesEffort("medium", "unknown-r1"), "medium");
    eq("mapEffort: 无目录 max → high", mapResponsesEffort("max", "unknown-r1"), "high");
    stub.__resetConfig();
    const body = buildResponsesRequest(cwRequest({ modelId: "gpt-5.4", effort: "xhigh" }) as unknown as CwRequest, prov);
    applyResponsesEffort(body, "xhigh");
    eq("applyEffort: 推理模型带 reasoning.effort=xhigh + summary auto", body.reasoning, { effort: "xhigh", summary: "auto" });
    const b2 = buildResponsesRequest(cwRequest({ modelId: "plain-chat" }) as unknown as CwRequest, prov);
    applyResponsesEffort(b2, "high");
    check("applyEffort: 非推理模型不带 reasoning", b2.reasoning === undefined);
    const b3 = buildResponsesRequest(cwRequest({ modelId: "gpt-5.4" }) as unknown as CwRequest, prov);
    applyResponsesEffort(b3, undefined);
    check("applyEffort: 无 effort 不带 reasoning", b3.reasoning === undefined);
    stub.__setConfig("openaiReasoningEffort", "low");
    const b4 = buildResponsesRequest(cwRequest({ modelId: "plain-chat" }) as unknown as CwRequest, prov);
    applyResponsesEffort(b4, "max");
    eq("applyEffort: 全局固定档位无条件发", b4.reasoning, { effort: "low", summary: "auto" });
    stub.__setConfig("openaiReasoningEffort", "off");
    const b5 = buildResponsesRequest(cwRequest({ modelId: "gpt-5.4" }) as unknown as CwRequest, prov);
    applyResponsesEffort(b5, "high");
    check("applyEffort: off 不发", b5.reasoning === undefined);
    stub.__resetConfig();
    resetCatalogForTest([]);
  }

  // ---------- 4. 请求组包 ----------
  {
    const req = cwRequest({
      modelId: "gpt-5",
      content: "go",
      history: [
        { userInputMessage: { content: "q1", modelId: "gpt-5", userInputMessageContext: {} } },
        {
          assistantResponseMessage: {
            content: "",
            toolUses: [{ toolUseId: "call_1", name: "readFile", input: { path: "a" } }],
            reasoningContent: { reasoningText: { text: "sum", signature: encodeReasoningSignature("ENCX") } },
          },
        },
        { userInputMessage: { content: "", modelId: "gpt-5", userInputMessageContext: { toolResults: [{ toolUseId: "call_1", content: [{ text: "body" }] }] } } },
        { assistantResponseMessage: { content: "done", reasoningContent: { reasoningText: { text: "anthropic thought", signature: "NOTOURS" } } } },
      ],
      tools: [toolSpec("readFile", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, "read")],
      images: [{ format: "png", bytes: "AAAA" }],
    }) as unknown as CwRequest;
    const b = buildResponsesRequest(req, prov);
    check("build: store=false + include encrypted_content", b.store === false && Array.isArray(b.include) && b.include.includes("reasoning.encrypted_content"));
    const types = b.input.map((i) => ("type" in i ? i.type : i.role));
    eq("build: item 顺序 user→reasoning→function_call→function_call_output→assistant→user", types, ["user", "reasoning", "function_call", "function_call_output", "assistant", "user"]);
    const rs = b.input.find((i) => "type" in i && i.type === "reasoning") as { encrypted_content: string };
    eq("build: reasoning item 还原 encrypted_content", rs.encrypted_content, "ENCX");
    const fc = b.input.find((i) => "type" in i && i.type === "function_call") as { call_id: string; arguments: string };
    eq("build: function_call arguments 字符串化", [fc.call_id, fc.arguments], ["call_1", '{"path":"a"}']);
    const fo = b.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
    eq("build: function_call_output", fo.output, "body");
    check("build: 非本通路签名不产生 reasoning item", b.input.filter((i) => "type" in i && i.type === "reasoning").length === 1);
    const last = b.input[b.input.length - 1] as { role: string; content: Array<{ type: string }> };
    eq("build: 当前消息 input_text + input_image", last.content.map((p) => p.type), ["input_text", "input_image"]);
    eq("build: 工具声明扁平 + strict:false", b.tools, [{ type: "function", name: "readFile", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, strict: false, description: "read" }]);
    check("build: max_output_tokens 取配置", typeof b.max_output_tokens === "number" && b.max_output_tokens > 0);
    eq("sig: 往返", decodeReasoningSignature(encodeReasoningSignature("abc")), "abc");
    eq("sig: 非本前缀 → undefined", decodeReasoningSignature("api4kiro:unsigned-reasoning"), undefined);
    eq("sig: 空 → undefined", decodeReasoningSignature("a2k-rs:"), undefined);
    // 未配对的 tool_call 补占位
    const req2 = cwRequest({
      modelId: "gpt-5",
      history: [
        { userInputMessage: { content: "q", modelId: "gpt-5", userInputMessageContext: {} } },
        { assistantResponseMessage: { toolUses: [{ toolUseId: "c9", name: "x", input: "{}" }] } },
      ],
    }) as unknown as CwRequest;
    const b2 = buildResponsesRequest(req2, prov);
    const outs = b2.input.filter((i) => "type" in i && i.type === "function_call_output") as Array<{ call_id: string; output: string }>;
    eq("build: 无结果的 function_call 补占位输出", outs.map((o) => [o.call_id, o.output]), [["c9", "(tool call was not completed)"]]);
  }

  // ---------- 5. function_call 流 ----------
  {
    const c = new ResponsesStreamConverter("c", "gpt-5");
    const ev = feedAll(c, [
      sse({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "fsWrite", arguments: "" } }),
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' }),
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' }),
      sse({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"path":"a.ts"}' }),
      sse({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "fsWrite", arguments: '{"path":"a.ts"}' } }),
      sse({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_def", name: "readFile" } }),
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"p":1}' }),
      sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 20 } } } }),
    ]);
    const tus = toolUses(ev);
    eq("fc: 两个调用各发一次，toolUseId=call_id", tus.map((t) => [t.toolUseId, t.name, t.input]), [["call_abc", "fsWrite", '{"path":"a.ts"}'], ["call_def", "readFile", '{"p":1}']]);
    eq("fc: stopReason=TOOL_USE", stopReasons(ev), ["TOOL_USE"]);
    check("fc: 末帧 stopReason", lastIsStopReason(ev));
    eq("fc: tokenUsage uncached=input-cached，output 已含 reasoning 不再反推", tokenUsages(ev), [{ uncachedInputTokens: 40, outputTokens: 30, cacheReadInputTokens: 60, cacheWriteInputTokens: 0 }]);
    eq("fc: meteringUsage 缓存清零", c.meteringUsage(), { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 });
    check("fc: contextUsageEvent", contextUsages(ev).length === 1);
    // 只有 delta 没有 added（id 首见于 delta）
    const c2 = new ResponsesStreamConverter("c", "gpt-5");
    const ev2 = feedAll(c2, [
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_x", delta: '{"a":1}' }),
      sse({ type: "response.output_item.done", item: { type: "function_call", id: "fc_x", call_id: "call_x", name: "late" } }),
    ]);
    eq("fc: 参数先到、名字后到也能凑齐", toolUses(ev2).map((t) => [t.toolUseId, t.name, t.input]), [["call_x", "late", '{"a":1}']]);
    // 非法 JSON 参数退 {}
    const c3 = new ResponsesStreamConverter("c", "gpt-5");
    const ev3 = feedAll(c3, [sse({ type: "response.output_item.done", item: { type: "function_call", id: "f", call_id: "cc", name: "bad", arguments: "{not json" } })]);
    eq("fc: 非法 JSON 参数 → {}", toolUses(ev3)[0].input, "{}");
  }

  // ---------- 6. 结束与异常 ----------
  {
    const c = new ResponsesStreamConverter("c", "gpt-5");
    const ev = feedAll(c, [
      sse({ type: "response.output_text.delta", item_id: "m", delta: "partial" }),
      sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]);
    eq("end: incomplete/max_output_tokens → MAX_TOKENS", stopReasons(ev), ["MAX_TOKENS"]);
    check("end: 截断提示", texts(ev).includes("max_output_tokens"));
    const c2 = new ResponsesStreamConverter("c", "gpt-5");
    const ev2 = feedAll(c2, [sse({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } })]);
    check("end: response.failed → 可见错误文本", texts(ev2).includes("server_error: boom"));
    eq("end: 失败流仍带 stopReason", stopReasons(ev2), ["END_TURN"]);
    const c3 = new ResponsesStreamConverter("c", "gpt-5");
    const ev3 = feedAll(c3, [sse({ type: "error", code: "rate_limit", message: "slow down" })]);
    check("end: 顶层 error 事件", texts(ev3).includes("rate_limit: slow down"));
    // 只有签名没有文本：补占位空格保住签名
    const c4 = new ResponsesStreamConverter("c", "gpt-5");
    const ev4 = feedAll(c4, [sse({ type: "response.output_item.done", item: { type: "reasoning", id: "rs", summary: [], encrypted_content: "E" } })]);
    eq("sig: 无文本时补占位空格", reasonings(ev4), " ");
    eq("sig: 签名照发", signatures(ev4), ["a2k-rs:E"]);
    // output_item.done(message) 只在没收到过 delta 时兜底
    const c5 = new ResponsesStreamConverter("c", "gpt-5");
    const ev5 = feedAll(c5, [
      sse({ type: "response.output_text.delta", item_id: "m", delta: "streamed" }),
      sse({ type: "response.output_item.done", item: { type: "message", id: "m", content: [{ type: "output_text", text: "streamed" }] } }),
    ]);
    eq("text: 收到过 delta 就不再用 done 整段（不重复）", texts(ev5), "streamed");
    const c6 = new ResponsesStreamConverter("c", "gpt-5");
    const ev6 = feedAll(c6, [sse({ type: "response.output_item.done", item: { type: "message", id: "m", content: [{ type: "output_text", text: "whole" }] } })]);
    eq("text: 没有 delta 时用 done 整段", texts(ev6), "whole");
  }

  // ---------- 7. 非 SSE 整包 ----------
  {
    const c = new ResponsesStreamConverter("c", "gpt-5");
    const whole = JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "**A**" }, { type: "summary_text", text: "**B**" }], encrypted_content: "EE" },
        { type: "message", id: "m", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", id: "fc", call_id: "call_1", name: "t", arguments: "{}" },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const ev = feedAll(c, whole.split("\n"));
    eq("whole: 摘要多段连接", reasonings(ev), "**A**\n\n**B**");
    eq("whole: 签名", signatures(ev), ["a2k-rs:EE"]);
    eq("whole: 正文", texts(ev), "hello");
    eq("whole: 工具", toolUses(ev).map((t) => t.toolUseId), ["call_1"]);
    eq("whole: stopReason=TOOL_USE", stopReasons(ev), ["TOOL_USE"]);
    eq("whole: usage", c.usage.inputTokens, 7);
  }
});
