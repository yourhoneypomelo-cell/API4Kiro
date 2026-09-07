/**
 * 真实 KrsProxyServer + 假上游（本地 http 吐固定 SSE）端到端：
 *  - 工具循环整轮只上报一条 meteringEvent，且总量为各次迭代之和；
 *  - 每条响应流末带 stopReason；
 *  - 未配置 / 配置不全的上游阻断且零外发；
 *  - autoRetry 只在未吐字时重试（5xx → 重发；关掉则直接报错，报错帧也带 stopReason）；
 *  - 上游拒图 → 学习 + 剥图重发一次。
 * 端口：假上游 19871，KRS 19872（19871–19898 段）。
 */
import * as http from "http";
import * as vscode from "vscode";
import { KrsProxyServer } from "../../src/krsServer";
import { EventStreamDecoder, DecodedEvent } from "../../src/eventstream";
import { initImagePolicy, clearLearned, isTextOnly } from "../../src/imagePolicy";
import { initConfig } from "../../src/config";
import { resetAll } from "../../src/turnLedger";
import { _resetPoolForTest, poolStatus } from "../../src/credentialPool";
import type { ProviderConfig } from "../../src/providers";
import { assistant, cwRequest, image, toolResult, toolUse, user } from "./fixtures";
import { STOP_REASONS, eq, ok, run, test } from "./harness";

const UPSTREAM_PORT = 19871;
const KRS_PORT = 19872;

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void; __makeContext(v?: string): vscode.ExtensionContext };

// ---------------------------------------------------------------- 假上游

interface Scripted {
  status: number;
  /** SSE 文本（或 JSON 错误体） */
  body: string;
  contentType?: string;
}

interface Hit {
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const hits: Hit[] = [];
let script: Scripted[] = [];
let upstream: http.Server;

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "GET") {
          // /models 之类的目录拉取：不计入 hits、不消耗脚本，回空清单（dispatchGemini 会先拉一次目录）
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"data":[],"models":[]}');
          return;
        }
        hits.push({ path: req.url || "", body, headers: req.headers });
        const s = script.shift() || { status: 500, body: '{"error":"script exhausted"}' };
        res.writeHead(s.status, { "Content-Type": s.contentType || (s.status === 200 ? "text/event-stream" : "application/json") });
        res.end(s.body);
      });
    });
    upstream.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve());
  });
}

function sse(events: unknown[]): string {
  return events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}`)).join("\n\n") + "\n\n";
}

function anthropicSse(text: string, stop: "end_turn" | "tool_use", usage: { in: number; out: number }, tool?: { id: string; name: string; input: unknown }): string {
  const evs: unknown[] = [
    { type: "message_start", message: { usage: { input_tokens: usage.in } } },
  ];
  if (text) {
    evs.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 }
    );
  }
  if (tool) {
    evs.push(
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: tool.id, name: tool.name } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } },
      { type: "content_block_stop", index: 1 }
    );
  }
  evs.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.out } }, { type: "message_stop" });
  return sse(evs);
}

function openaiSse(text: string, usage: { in: number; out: number }): string {
  return sse([
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out } },
    "data: [DONE]",
  ]);
}

// ---------------------------------------------------------------- KRS 客户端

interface KrsReply {
  status: number;
  events: DecodedEvent[];
  raw: Buffer;
}

function postKrs(body: unknown): Promise<KrsReply> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port: KRS_PORT, method: "POST", path: "/generateAssistantResponse", headers: { "Content-Type": "application/json", "Content-Length": payload.length, "user-agent": "test-kiro" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const dec = new EventStreamDecoder();
          resolve({ status: res.statusCode || 0, events: dec.feed(raw), raw });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function ofType(events: DecodedEvent[], type: string): DecodedEvent[] {
  return events.filter((e) => e.type === type);
}

function stopReasonOf(events: DecodedEvent[]): string | undefined {
  const md = ofType(events, "metadataEvent").map((e) => (e.payload as { stopReason?: string })?.stopReason).filter(Boolean);
  eq(md.length, 1, "exactly one stopReason frame");
  return md[0];
}

function textOf(events: DecodedEvent[]): string {
  return ofType(events, "assistantResponseEvent").map((e) => (e.payload as { content: string }).content).join("");
}

function meterings(events: DecodedEvent[]): Array<{ usage: number; unit: string; unitPlural?: string }> {
  return ofType(events, "meteringEvent").map((e) => e.payload as { usage: number; unit: string; unitPlural?: string });
}

// ---------------------------------------------------------------- 环境

const ctx = stub.__makeContext("9.9.9");
let krs: KrsProxyServer;

/** 换 provider 配置并清掉凭证池冷却状态（上一条用例的 5xx 会把唯一凭证冷却几十秒）。 */
function setProviders(list: unknown[]): void {
  stub.__setConfig("providers", list);
  _resetPoolForTest();
  resetAll();
}

const anthropicProvider = { id: "pa", name: "FakeAnthropic", protocol: "anthropic", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, apiKey: "sk-fake", enabled: true, enabledModels: ["claude-test"] };
const openaiProvider = { id: "po", name: "FakeOpenAI", protocol: "openai", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, apiKey: "sk-fake", enabled: true, enabledModels: ["gpt-test"] };
const responsesProvider = { id: "pr", name: "FakeResponses", protocol: "openai", openaiApi: "responses", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, apiKey: "sk-fake", enabled: true, enabledModels: ["gpt-5-test"] };
const geminiProvider = { id: "pg", name: "FakeGemini", protocol: "gemini", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1beta`, apiKey: "AIza-fake", enabled: true, enabledModels: ["gemini-3-flash"] };

test("setup: 启动假上游与 KRS", async () => {
  stub.__resetConfig();
  stub.__setConfig("enabled", true);
  stub.__setConfig("debug", false);
  initConfig(ctx);
  initImagePolicy(ctx);
  await clearLearned();
  await startUpstream();
  krs = new KrsProxyServer(ctx, KRS_PORT);
  await krs.start();
  ok(krs.isOwner(), "KRS owns its port");
});

test("阻断：没有任何 provider → 本地引导消息，带 stopReason，零外发", async () => {
  setProviders([]);
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "claude-test" }));
  eq(r.status, 200, "200 event-stream");
  eq(stopReasonOf(r.events), "END_TURN", "END_TURN on setup message");
  ok(textOf(r.events).includes("尚无可用的 provider"), "setup text");
  eq(hits.length, before, "no upstream request");
});

test("阻断：provider 缺 API Key（配置不完整）→ 不算可用，零外发", async () => {
  setProviders([{ ...anthropicProvider, apiKey: "" }]);
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "claude-test" }));
  eq(stopReasonOf(r.events), "END_TURN", "stopReason");
  ok(textOf(r.events).includes("缺少 API Key"), "explains missing key");
  eq(hits.length, before, "no upstream request");
});

test("Anthropic 工具循环：两次迭代 → 第一响应 TOOL_USE 无 metering；第二响应 END_TURN 且恰一条 metering = 两次之和", async () => {
  setProviders([anthropicProvider]);
  resetAll();
  script = [
    { status: 200, body: anthropicSse("让我看看。", "tool_use", { in: 100, out: 10 }, { id: "tu_1", name: "readFile", input: { path: "a.ts" } }) },
    { status: 200, body: anthropicSse("看完了。", "end_turn", { in: 200, out: 20 }) },
  ];
  const conv = "conv-loop";
  const before = hits.length;

  const r1 = await postKrs(cwRequest("读一下 a.ts", { modelId: "claude-test", convId: conv }));
  eq(r1.status, 200, "200");
  eq(r1.events[0].type, "messageMetadataEvent", "first frame is messageMetadataEvent");
  eq(stopReasonOf(r1.events), "TOOL_USE", "TOOL_USE");
  const tu = ofType(r1.events, "toolUseEvent");
  eq(tu.length, 1, "one toolUseEvent");
  eq((tu[0].payload as { name: string; stop: boolean }).name, "readFile", "tool name");
  eq((tu[0].payload as { stop: boolean }).stop, true, "toolUseEvent has stop:true");
  eq(meterings(r1.events).length, 0, "no metering mid-turn");
  const tokenUsage = ofType(r1.events, "metadataEvent").map((e) => (e.payload as { tokenUsage?: unknown }).tokenUsage).filter(Boolean);
  eq(tokenUsage.length, 1, "one nested tokenUsage frame");
  eq(tokenUsage[0], { uncachedInputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, "nested shape");

  const r2 = await postKrs(
    cwRequest("", {
      modelId: "claude-test",
      convId: conv,
      history: [user("读一下 a.ts"), assistant("让我看看。", { toolUses: [toolUse("tu_1", "readFile", { path: "a.ts" })] })],
      toolResults: [toolResult("tu_1", "file content")],
    })
  );
  eq(stopReasonOf(r2.events), "END_TURN", "END_TURN");
  eq(textOf(r2.events), "看完了。", "text");
  const m = meterings(r2.events);
  eq(m.length, 1, "exactly one meteringEvent for the whole turn");
  eq(m[0].usage, 330, "usage = (100+10) + (200+20)");
  eq(m[0].unit, "token", "unit");
  ok(/in 300 \/ out 30/.test(m[0].unitPlural || ""), `decomposition of whole turn in unitPlural: ${m[0].unitPlural}`);

  eq(hits.length - before, 2, "two upstream calls");
  const sent2 = JSON.parse(hits[hits.length - 1].body);
  ok(JSON.stringify(sent2.messages).includes('"tool_result"'), "second request carries tool_result");
  eq(hits[hits.length - 1].path, "/v1/messages", "anthropic path");
  eq(hits[hits.length - 1].headers["x-api-key"], "sk-fake", "key header");
});

test("OpenAI Chat 单轮：END_TURN + 一条 metering；上游收到 stream_options.include_usage", async () => {
  setProviders([openaiProvider]);
  resetAll();
  script = [{ status: 200, body: openaiSse("Hello!", { in: 40, out: 4 }) }];
  const r = await postKrs(cwRequest("hi", { modelId: "gpt-test", convId: "conv-oai" }));
  eq(stopReasonOf(r.events), "END_TURN", "END_TURN");
  eq(textOf(r.events), "Hello!", "text");
  const m = meterings(r.events);
  eq(m.length, 1, "one metering");
  eq(m[0].usage, 44, "usage");
  const sent = JSON.parse(hits[hits.length - 1].body);
  eq(sent.stream_options, { include_usage: true }, "include_usage");
  eq(hits[hits.length - 1].path, "/v1/chat/completions", "chat path");
});

test("新一轮（无 toolResults）清空账本：上一轮泄漏的用量不带进来", async () => {
  setProviders([openaiProvider]);
  resetAll();
  // 第一次：上游返回 tool_calls（轮未结束，账本留着 in=1000）
  script = [
    {
      status: 200,
      body: sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 } },
        "data: [DONE]",
      ]),
    },
    { status: 200, body: openaiSse("fresh", { in: 10, out: 1 }) },
  ];
  const conv = "conv-leak";
  const r1 = await postKrs(cwRequest("ls", { modelId: "gpt-test", convId: conv }));
  eq(stopReasonOf(r1.events), "TOOL_USE", "tool");
  eq(meterings(r1.events).length, 0, "no metering");
  // 用户放弃工具循环，直接发新消息（无 toolResults）
  const r2 = await postKrs(cwRequest("new question", { modelId: "gpt-test", convId: conv }));
  const m = meterings(r2.events);
  eq(m.length, 1, "one metering");
  eq(m[0].usage, 11, "only the new turn's usage (1005 discarded)");
});

test("autoRetry：上游 500 后 200 → 未吐字时透明重试，两次外发，用户只看到一份回复", async () => {
  setProviders([openaiProvider]);
  stub.__setConfig("autoRetry", true);
  stub.__setConfig("maxRetries", 2);
  resetAll();
  script = [{ status: 500, body: '{"error":"flaky"}' }, { status: 200, body: openaiSse("ok after retry", { in: 5, out: 3 }) }];
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "gpt-test", convId: "conv-retry" }));
  eq(hits.length - before, 2, "retried once");
  eq(textOf(r.events), "ok after retry", "single reply");
  eq(stopReasonOf(r.events), "END_TURN", "stopReason");
  eq(ofType(r.events, "messageMetadataEvent").length, 1, "one messageMetadataEvent");
});

test("autoRetry 关闭：上游 500 → 一次外发即报错；报错流仍带 stopReason 与 exception 帧", async () => {
  setProviders([openaiProvider]);
  stub.__setConfig("autoRetry", false);
  resetAll();
  script = [{ status: 500, body: '{"error":"down"}' }, { status: 200, body: openaiSse("should not be used", { in: 1, out: 1 }) }];
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "gpt-test", convId: "conv-noretry" }));
  eq(hits.length - before, 1, "no retry");
  ok(textOf(r.events).includes("上游返回 500"), "error text surfaced");
  eq(stopReasonOf(r.events), "END_TURN", "stopReason even on error");
  const exc = r.events.filter((e) => e.messageType === "exception");
  eq(exc.length, 1, "exception frame");
  eq(exc[0].type, "InternalServerException", "exception type");
  script = [];
  stub.__setConfig("autoRetry", true);
});

test("凭证冷却中：上一条 500 让唯一凭证进入冷却 → 下一条仍照常外发（冷却不拦请求），成功即清冷却", async () => {
  // 不调 setProviders（它会清冷却），沿用上一条留下的状态
  eq(poolStatus(openaiProvider as unknown as ProviderConfig).cooling, 1, "前置：唯一凭证确在冷却（上一条 500 → upstream 3s）");
  script = [{ status: 200, body: openaiSse("reached upstream", { in: 1, out: 1 }) }];
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "gpt-test", convId: "conv-cooling" }));
  eq(hits.length - before, 1, "唯一凭证冷却中也要外发一次，不得本地拒绝");
  eq(textOf(r.events), "reached upstream", "上游回复原样到达");
  eq(stopReasonOf(r.events), "END_TURN", "stopReason");
  eq(poolStatus(openaiProvider as unknown as ProviderConfig).cooling, 0, "成功一次即清冷却");
  script = [];
});

test("4xx 不重试（非 5xx/429）：上游 400 → 一次外发，错误透传", async () => {
  setProviders([openaiProvider]);
  resetAll();
  script = [{ status: 400, body: '{"error":{"message":"bad request"}}' }, { status: 200, body: openaiSse("nope", { in: 1, out: 1 }) }];
  const before = hits.length;
  const r = await postKrs(cwRequest("hi", { modelId: "gpt-test", convId: "conv-400" }));
  eq(hits.length - before, 1, "single attempt");
  ok(textOf(r.events).includes("400"), "400 surfaced");
  eq(stopReasonOf(r.events), "END_TURN", "stopReason");
  script = [];
});

test("剥图学习：未知模型带图被 400（提到 image）→ 记为纯文本、剥图重发一次、回复前带提示", async () => {
  setProviders([openaiProvider]);
  await clearLearned();
  resetAll();
  script = [
    { status: 400, body: '{"error":{"message":"This model does not support image input"}}' },
    { status: 200, body: openaiSse("text-only answer", { in: 7, out: 2 }) },
  ];
  const before = hits.length;
  const r = await postKrs(cwRequest("看图", { modelId: "gpt-test", convId: "conv-img", images: [image("png")] }));
  eq(hits.length - before, 2, "rejected then re-sent");
  ok(hits[hits.length - 2].body.includes("image_url"), "first attempt carried the image");
  ok(!hits[hits.length - 1].body.includes("image_url"), "retry stripped the image");
  ok(hits[hits.length - 1].body.includes("图片已省略"), "placeholder text in retry");
  ok(textOf(r.events).includes("不支持图片输入") && textOf(r.events).includes("text-only answer"), "notice + answer");
  eq(stopReasonOf(r.events), "END_TURN", "stopReason");
  ok(isTextOnly("gpt-test"), "model learned as text-only");

  // 学会之后：直接剥图，不再撞 400
  script = [{ status: 200, body: openaiSse("second", { in: 7, out: 2 }) }];
  const b2 = hits.length;
  const r2 = await postKrs(cwRequest("再看", { modelId: "gpt-test", convId: "conv-img2", images: [image("png")] }));
  eq(hits.length - b2, 1, "one call");
  ok(!hits[hits.length - 1].body.includes("image_url"), "pre-stripped");
  ok(textOf(r2.events).includes("已忽略 1 张图片"), "notice");
  await clearLearned();
});

test("Responses 通路：/v1/responses，摘要多段带分隔，encrypted_content 以 a2k-rs: 签名回给 Kiro，END_TURN + 一条 metering", async () => {
  setProviders([responsesProvider]);
  script = [
    {
      status: 200,
      body: sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs1" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "**A**" },
        { type: "response.reasoning_summary_part.done", item_id: "rs1" },
        { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "**B**" },
        { type: "response.output_item.done", item: { type: "reasoning", id: "rs1", summary: [], encrypted_content: "ENC1" } },
        { type: "response.output_text.delta", item_id: "m1", delta: "answer" },
        { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 12 } } },
      ]),
    },
  ];
  const r = await postKrs(cwRequest("q", { modelId: "gpt-5-test", convId: "conv-rs" }));
  eq(hits[hits.length - 1].path, "/v1/responses", "responses path");
  const sent = JSON.parse(hits[hits.length - 1].body);
  eq(sent.store, false, "stateless");
  eq(sent.include, ["reasoning.encrypted_content"], "include encrypted_content");
  const reasoning = ofType(r.events, "reasoningContentEvent").map((e) => e.payload as { text?: string; signature?: string });
  eq(reasoning.map((x) => x.text).filter(Boolean).join(""), "**A**\n\n**B**", "separator between summary parts");
  eq(reasoning.map((x) => x.signature).filter(Boolean), ["a2k-rs:ENC1"], "signature");
  eq(textOf(r.events), "answer", "text");
  eq(stopReasonOf(r.events), "END_TURN", "END_TURN");
  eq(meterings(r.events).map((m) => m.usage), [42], "one metering");
});

test("Gemini 通路：/v1beta/models/<id>:streamGenerateContent?alt=sse，thought 实时、functionCall 签名 a2k-gm:、TOOL_USE", async () => {
  setProviders([geminiProvider]);
  script = [
    {
      status: 200,
      body: sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "思考…", thought: true }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fc1", name: "readFile", args: { path: "x" } }, thoughtSignature: "GSIG" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, thoughtsTokenCount: 20 } },
      ]),
    },
  ];
  const r = await postKrs(cwRequest("read x", { modelId: "gemini-3-flash", convId: "conv-gm", effort: "high" }));
  const last = hits[hits.length - 1];
  eq(last.path, "/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse", "gemini path");
  eq(last.headers["x-goog-api-key"], "AIza-fake", "gemini key header");
  const sent = JSON.parse(last.body);
  eq(sent.generationConfig?.thinkingConfig, { includeThoughts: true, thinkingLevel: "high" }, "flash high → thinkingLevel high");
  ok(!("sessionId" in sent), "Antigravity-only sessionId stripped for official API");
  const reasoning = ofType(r.events, "reasoningContentEvent").map((e) => e.payload as { text?: string; signature?: string });
  eq(reasoning.map((x) => x.text).filter(Boolean).join(""), "思考…", "thought streamed");
  eq(reasoning.map((x) => x.signature).filter(Boolean), ["a2k-gm:GSIG"], "signature");
  const tu = ofType(r.events, "toolUseEvent");
  eq((tu[0].payload as { name: string }).name, "readFile", "tool");
  eq(stopReasonOf(r.events), "TOOL_USE", "TOOL_USE");
  eq(meterings(r.events).length, 0, "no metering mid-turn");
  const tokenUsage = ofType(r.events, "metadataEvent").map((e) => (e.payload as { tokenUsage?: { outputTokens: number } }).tokenUsage).filter(Boolean);
  eq(tokenUsage[0]!.outputTokens, 25, "output = candidates + thoughts");
});

test("每条流的 stopReason 均在合法枚举内（回放本套件所有响应）", async () => {
  setProviders([anthropicProvider]);
  resetAll();
  script = [{ status: 200, body: anthropicSse("x", "end_turn", { in: 1, out: 1 }) }];
  const r = await postKrs(cwRequest("hi", { modelId: "claude-test", convId: "conv-enum" }));
  const sr = stopReasonOf(r.events);
  ok(!!sr && STOP_REASONS.includes(sr), `stopReason ${sr} in enum`);
  // stopReason 是最后一个 metadataEvent，且在 meteringEvent 之前（metering 由泵在 flush 后追加）
  const idxStop = r.events.findIndex((e) => e.type === "metadataEvent" && (e.payload as { stopReason?: string }).stopReason);
  const idxMeter = r.events.findIndex((e) => e.type === "meteringEvent");
  ok(idxStop >= 0 && idxMeter > idxStop, "metering after stopReason");
});

test("teardown: 关闭 KRS 与假上游", async () => {
  await krs.stop();
  await new Promise<void>((res) => upstream.close(() => res()));
  ok(!krs.isOwner(), "released");
});

void run();
