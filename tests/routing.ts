/**
 * routing：起**真实** KrsProxyServer（19871–19898 之一）+ 两个本地假上游，端到端验证：
 *  - claude-* → Anthropic provider 的 /v1/messages；gpt-* → OpenAI provider 的 /v1/chat/completions
 *  - 同名模型归先注册的 provider；带 @providerId 限定的走指定 provider
 *  - 未配置上游（无 baseUrl / 无 key）阻断：返回引导文案 + stopReason，零外发
 *  - 上游 4xx：报文透出 + 💡 处置提示 + stopReason + exception 帧；401 不重试
 *  - autoRetry：5xx 且未吐字 → 重试；已吐字后流断 → 不重试、仍收尾带 stopReason；重试耗尽 → 透出 5xx
 *  - 流式分片边界：SSE 行被 TCP 切成两半、UTF-8 多字节字被切成两半，都能拼回
 *  - 工具循环：迭代帧不发 metering，轮末（无 toolResults 的新一轮 / 无工具调用的收尾）恰好一条累计 metering
 *  - 意图分类器本地应答、分组标题回落、身份探测
 * 全程只打 127.0.0.1，不碰任何真实 Key。
 */
import * as vscode from "vscode";
import * as net from "net";
import { KrsProxyServer, upstreamErrorHint } from "../src/krsServer";
import { initConfig, isEnabled } from "../src/config";
import { activate, deactivate, _configChangesSettledForTest } from "../src/extension";
import { _setCatalogUrlForTest } from "../src/modelCatalog";
import { _resetPoolForTest } from "../src/credentialPool";
import { ProviderConfig } from "../src/providers";
import { CwEvent } from "../src/cwTypes";
import { PROXY_ID_PATH, PROXY_ID_TOKEN } from "../src/proxyIdentity";
import {
  check,
  eq,
  includes,
  run,
  startFakeUpstream,
  writeSse,
  postRaw,
  pickPort,
  decodeEventStream,
  framesToCwEvents,
  texts,
  stopReasons,
  meterings,
  tokenUsages,
  toolUses,
  lastIsStopReason,
  cwRequest,
  sleep,
  FakeUpstream,
} from "./lib/cw";
import * as http from "http";

const stub = vscode as unknown as {
  __setConfig(k: string, v: unknown): void;
  __resetConfig(): void;
  __fireConfigChange(keys: string[]): void;
  __makeContext(o?: { version?: string }): unknown;
  __outputLines(): string[];
};

type Scenario =
  | { kind: "text"; text: string[] }
  | { kind: "tool" }
  | { kind: "status"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "fail-then-ok"; failStatus: number; failTimes: number; text: string[] }
  | { kind: "break-after-output"; text: string }
  | { kind: "split-utf8" }
  | { kind: "split-line" };

const scenario: { anth: Scenario; oai: Scenario } = { anth: { kind: "text", text: ["hi"] }, oai: { kind: "text", text: ["hi"] } };
const counters = { anthFail: 0, oaiFail: 0 };

function anthropicSse(deltas: string[], opts?: { tool?: boolean }): unknown[] {
  const ev: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 10 } } }];
  ev.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const d of deltas) {
    ev.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } });
  }
  ev.push({ type: "content_block_stop", index: 0 });
  if (opts?.tool) {
    ev.push({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "readFile" } });
    ev.push({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } });
    ev.push({ type: "content_block_stop", index: 1 });
    ev.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } });
  } else {
    ev.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
  }
  ev.push({ type: "message_stop" });
  return ev;
}

function openaiSse(deltas: string[]): unknown[] {
  const ev: unknown[] = deltas.map((d) => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: d }, finish_reason: null }] }));
  ev.push({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  ev.push({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } });
  return ev;
}

async function serveScenario(which: "anth" | "oai", s: Scenario, res: http.ServerResponse): Promise<void> {
  const mk = which === "anth" ? (t: string[]) => anthropicSse(t) : openaiSse;
  switch (s.kind) {
    case "text":
      writeSse(res, mk(s.text));
      return;
    case "tool":
      writeSse(res, anthropicSse(["I'll read it."], { tool: true }));
      return;
    case "status":
      res.writeHead(s.status, { "Content-Type": "application/json", ...(s.headers || {}) });
      res.end(s.body);
      return;
    case "fail-then-ok": {
      const n = which === "anth" ? counters.anthFail++ : counters.oaiFail++;
      if (n < s.failTimes) {
        res.writeHead(s.failStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `transient ${s.failStatus}` } }));
        return;
      }
      writeSse(res, mk(s.text));
      return;
    }
    case "break-after-output": {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const first = mk([s.text]).slice(0, which === "anth" ? 3 : 1);
      for (const e of first) {
        res.write("data: " + JSON.stringify(e) + "\n\n");
      }
      await sleep(40);
      res.destroy();
      return;
    }
    case "split-utf8": {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      const line = "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好世界" } }) + "\n\n";
      const buf = Buffer.from(line, "utf8");
      const hao = Buffer.from("好", "utf8");
      const idx = buf.indexOf(hao);
      res.write(buf.subarray(0, idx + 1));
      await sleep(40);
      res.write(buf.subarray(idx + 1));
      await sleep(10);
      res.write("data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) + "\n\n");
      res.end();
      return;
    }
    case "split-line": {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      const line = "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half-line-ok" } }) + "\n\n";
      const cut = line.indexOf('"text_delta"') + 5;
      res.write(line.slice(0, cut));
      await sleep(40);
      res.write(line.slice(cut));
      await sleep(10);
      res.write("data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) + "\n\n");
      res.end();
      return;
    }
  }
}

async function callKrs(krsBase: string, body: unknown): Promise<{ status: number; events: CwEvent[]; frames: ReturnType<typeof decodeEventStream>; raw: Buffer }> {
  const r = await postRaw(krsBase + "/generateAssistantResponse", JSON.stringify(body));
  const frames = decodeEventStream(r.buf);
  return { status: r.status, events: framesToCwEvents(frames), frames, raw: r.buf };
}

run("routing", async () => {
  // ---------- 假上游 ----------
  const anth: FakeUpstream = await startFakeUpstream(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-test" }, { id: "shared-model" }, { id: "claude-second" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/messages") {
      await serveScenario("anth", scenario.anth, res);
      return;
    }
    res.writeHead(404);
    res.end("no route " + req.url);
  });
  const oai: FakeUpstream = await startFakeUpstream(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-test" }, { id: "shared-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await serveScenario("oai", scenario.oai, res);
      return;
    }
    res.writeHead(404);
    res.end("no route " + req.url);
  });

  const provAnth: ProviderConfig = { id: "p1", name: "Anth", protocol: "anthropic", anthropicMode: "kiro", baseUrl: anth.base, apiKey: "sk-fake-anth", enabled: true, enabledModels: ["claude-test", "shared-model", "claude-second"] };
  const provOai: ProviderConfig = { id: "p2", name: "Oai", protocol: "openai", openaiApi: "chat", baseUrl: oai.base, apiKey: "sk-fake-oai", enabled: true, enabledModels: ["gpt-test", "shared-model"] };

  stub.__resetConfig();
  stub.__setConfig("enabled", true);
  stub.__setConfig("providers", [provAnth, provOai]);
  stub.__setConfig("autoRetry", true);
  stub.__setConfig("maxRetries", 2);

  const port = await pickPort();
  const ctx = stub.__makeContext({ version: "4.13.30" }) as never;
  initConfig(ctx);
  const krs = new KrsProxyServer(ctx, port);
  await krs.start();
  check(`krs: 在 ${port} 成为 OWNER`, krs.isOwner());
  const krsBase = `http://127.0.0.1:${port}`;

  try {
    // ---------- 1. 身份 / OPTIONS ----------
    {
      const r = await postRaw(krsBase + PROXY_ID_PATH, "");
      const j = JSON.parse(r.buf.toString("utf8"));
      check("identity: 应答身份 token + 版本", j.proxy === PROXY_ID_TOKEN && j.version === "4.13.30" && j.role === "krs");
    }

    // ---------- 2. claude-* → /v1/messages ----------
    {
      scenario.anth = { kind: "text", text: ["Hello", " from", " Claude"] };
      anth.requests.length = 0;
      oai.requests.length = 0;
      const { status, events } = await callKrs(krsBase, cwRequest({ convId: "r1", modelId: "claude-test", content: "hi" }));
      eq("route-anth: 200", status, 200);
      eq("route-anth: 只打了 Anthropic 假上游一次 /v1/messages", anth.requests.filter((r) => r.url === "/v1/messages").length, 1);
      eq("route-anth: OpenAI 假上游未收到生成请求", oai.requests.filter((r) => r.method === "POST").length, 0);
      const up = anth.requests.find((r) => r.url === "/v1/messages")!;
      eq("route-anth: 上游 model 为裸 id", (up.json as { model: string }).model, "claude-test");
      eq("route-anth: x-api-key 用该 provider 的 key", up.headers["x-api-key"], "sk-fake-anth");
      check("route-anth: X-Client 自报家门", String(up.headers["x-client"]).startsWith("api2kiro-dual/4.13.30"));
      eq("route-anth: 正文完整", texts(events), "Hello from Claude");
      eq("route-anth: stopReason", stopReasons(events), ["END_TURN"]);
      eq("route-anth: 轮末恰好一条 metering", meterings(events).length, 1);
      eq("route-anth: metering 总量 = in100 + cache10 + out20", meterings(events)[0].usage, 130);
      eq("route-anth: tokenUsage 嵌套", tokenUsages(events), [{ uncachedInputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10, cacheWriteInputTokens: 0 }]);
      const stopIdx = events.findIndex((e) => e.metadataEvent?.stopReason);
      const meterIdx = events.findIndex((e) => e.meteringEvent);
      check("route-anth: stopReason 在 metering 之前（泵在 flush 后补 metering）", stopIdx >= 0 && meterIdx > stopIdx);
    }

    // ---------- 3. gpt-* → /v1/chat/completions ----------
    {
      scenario.oai = { kind: "text", text: ["GPT", " says", " hi"] };
      anth.requests.length = 0;
      oai.requests.length = 0;
      const { events } = await callKrs(krsBase, cwRequest({ convId: "r2", modelId: "gpt-test" }));
      eq("route-oai: 打了 /v1/chat/completions", oai.requests.filter((r) => r.url === "/v1/chat/completions").length, 1);
      eq("route-oai: Anthropic 未收到生成请求", anth.requests.filter((r) => r.method === "POST").length, 0);
      const up = oai.requests.find((r) => r.url === "/v1/chat/completions")!;
      eq("route-oai: Bearer 用该 provider 的 key", up.headers["authorization"], "Bearer sk-fake-oai");
      check("route-oai: stream_options.include_usage", (up.json as { stream_options: { include_usage: boolean } }).stream_options.include_usage === true);
      eq("route-oai: 正文", texts(events), "GPT says hi");
      eq("route-oai: stopReason", stopReasons(events), ["END_TURN"]);
      eq("route-oai: metering = 50 + 7", meterings(events)[0].usage, 57);
    }

    // ---------- 4. 同名模型归先注册者；@限定走指定 ----------
    {
      scenario.anth = { kind: "text", text: ["A"] };
      scenario.oai = { kind: "text", text: ["O"] };
      anth.requests.length = 0;
      oai.requests.length = 0;
      const a = await callKrs(krsBase, cwRequest({ convId: "r3", modelId: "shared-model" }));
      eq("shared: 裸 id 归先注册的 Anthropic", [anth.requests.filter((r) => r.method === "POST").length, oai.requests.filter((r) => r.method === "POST").length], [1, 0]);
      eq("shared: 回的是 Anthropic 的正文", texts(a.events), "A");
      anth.requests.length = 0;
      oai.requests.length = 0;
      const o = await callKrs(krsBase, cwRequest({ convId: "r4", modelId: "shared-model@p2" }));
      eq("shared: @p2 限定走 OpenAI", [anth.requests.filter((r) => r.method === "POST").length, oai.requests.filter((r) => r.method === "POST").length], [0, 1]);
      eq("shared: 上游拿到的是裸 id", (oai.requests.find((r) => r.method === "POST")!.json as { model: string }).model, "shared-model");
      eq("shared: 回的是 OpenAI 的正文", texts(o.events), "O");
    }

    // ---------- 5. 工具循环：迭代不发 metering，轮末一条累计 ----------
    {
      scenario.anth = { kind: "tool" };
      anth.requests.length = 0;
      const first = await callKrs(krsBase, cwRequest({ convId: "loop", modelId: "claude-test", content: "read a" }));
      eq("loop-1: toolUseEvent", toolUses(first.events).map((t) => t.name), ["readFile"]);
      eq("loop-1: stopReason=TOOL_USE", stopReasons(first.events), ["TOOL_USE"]);
      eq("loop-1: 迭代帧不发 metering", meterings(first.events).length, 0);
      check("loop-1: toolUseEvent 帧带 stop:true", first.frames.some((f) => f.type === "toolUseEvent" && (f.payload as { stop?: boolean }).stop === true));
      scenario.anth = { kind: "text", text: ["done"] };
      const second = await callKrs(
        krsBase,
        cwRequest({
          convId: "loop",
          modelId: "claude-test",
          content: "",
          history: [
            { userInputMessage: { content: "read a", modelId: "claude-test", userInputMessageContext: {} } },
            { assistantResponseMessage: { content: "I'll read it.", toolUses: [{ toolUseId: "toolu_1", name: "readFile", input: '{"path":"a"}' }] } },
          ],
          toolResults: [{ toolUseId: "toolu_1", content: [{ text: "file body" }], status: "success" }],
        })
      );
      eq("loop-2: 收尾 stopReason=END_TURN", stopReasons(second.events), ["END_TURN"]);
      eq("loop-2: 轮末恰好一条 metering", meterings(second.events).length, 1);
      // 第一次 in100+cache10+out30=140，第二次 in100+cache10+out20=130 → 270
      eq("loop-2: metering 是两次请求的累计", meterings(second.events)[0].usage, 270);
      check("loop-2: unitPlural 分解与总量自洽", /in 220 \/ out 50/.test(meterings(second.events)[0].unitPlural || ""));
      const up2 = anth.requests.filter((r) => r.method === "POST")[1].json as { messages: Array<{ role: string; content: unknown }> };
      check("loop-2: 上游收到 tool_result 块", JSON.stringify(up2.messages).includes('"tool_result"'));
    }

    // ---------- 6. 上游 4xx ----------
    {
      scenario.oai = { kind: "status", status: 401, body: JSON.stringify({ error: { message: "Invalid API key provided", type: "invalid_request_error" } }) };
      oai.requests.length = 0;
      const { status, events, frames } = await callKrs(krsBase, cwRequest({ convId: "e401", modelId: "gpt-test" }));
      eq("4xx: HTTP 200 + event-stream（错误走帧）", status, 200);
      eq("4xx: 401 不重试（只打一次）", oai.requests.filter((r) => r.method === "POST").length, 1);
      includes("4xx: 报文透出", texts(events), "❌ 上游返回 401");
      includes("4xx: 原始错误文本", texts(events), "Invalid API key provided");
      includes("4xx: 💡 处置提示", texts(events), "API Key 被拒");
      eq("4xx: stopReason=END_TURN", stopReasons(events), ["END_TURN"]);
      check("4xx: 末尾 exception 帧", frames.some((f) => f.messageType === "exception" && f.type === "InternalServerException"));
      eq("4xx: 不发 metering", meterings(events).length, 0);
      // 单凭证 401 → 该 key 进入冷却，但冷却是避让不是封锁：下一次请求仍照常外发（用户可能已在上游侧修好 Key），
      // 上游仍 401 就把真实错误原样给用户，不出现「全部在冷却中 / N 分钟后恢复」这类本地拒绝文案。
      oai.requests.length = 0;
      const cooled = await callKrs(krsBase, cwRequest({ convId: "e401b", modelId: "gpt-test" }));
      eq("4xx: 401 后同 key 冷却中 → 仍外发一次", oai.requests.filter((r) => r.method === "POST").length, 1);
      includes("4xx: 仍是真实上游错误", texts(cooled.events), "❌ 上游返回 401");
      check("4xx: 不出现本地拒绝文案", !/全部在冷却中|后恢复/.test(texts(cooled.events)), texts(cooled.events).slice(0, 200));
      eq("4xx: 仍带 stopReason", stopReasons(cooled.events), ["END_TURN"]);
      // 用户修好 Key：下一次直接成功，冷却随之清零
      scenario.oai = { kind: "text", text: ["fixed"] };
      oai.requests.length = 0;
      const fixed = await callKrs(krsBase, cwRequest({ convId: "e401c", modelId: "gpt-test" }));
      eq("4xx: 修好后立刻外发", oai.requests.filter((r) => r.method === "POST").length, 1);
      includes("4xx: 修好后是正常回复", texts(fixed.events), "fixed");
      check("4xx: 修好后无错误文案", !/❌ 上游返回/.test(texts(fixed.events)), texts(fixed.events).slice(0, 120));
      _resetPoolForTest();
      // 404 model not found 的提示
      scenario.oai = { kind: "status", status: 404, body: JSON.stringify({ error: { message: "The model `gpt-test` does not exist" } }) };
      const r404 = await callKrs(krsBase, cwRequest({ convId: "e404", modelId: "gpt-test" }));
      includes("4xx: 404 模型不存在提示", texts(r404.events), "上游没有这个模型 id");
      _resetPoolForTest();
      // upstreamErrorHint 单元
      includes("hint: 403 分组不允许 /v1/messages", upstreamErrorHint(403, "token does not allow dispatch to /v1/messages", provAnth, "anthropic"), "OpenAI Chat Completions");
      includes("hint: 429 额度", upstreamErrorHint(429, "insufficient quota", provOai, "openai"), "额度");
      includes("hint: 429 限流", upstreamErrorHint(429, "rate limit exceeded", provOai, "openai"), "限流");
      includes("hint: 400 $ref", upstreamErrorHint(400, "Schema validation failed: unresolvable $ref", provOai, "openai"), "$ref");
      eq("hint: 普通 400 无提示", upstreamErrorHint(400, "bad request", provOai, "openai"), "");
    }

    // ---------- 7. autoRetry ----------
    {
      // 5xx 两次后成功：3 次上游请求，正文完整
      counters.oaiFail = 0;
      scenario.oai = { kind: "fail-then-ok", failStatus: 503, failTimes: 2, text: ["re", "tried"] };
      oai.requests.length = 0;
      const ok = await callKrs(krsBase, cwRequest({ convId: "retry1", modelId: "gpt-test" }));
      eq("retry: 503×2 后成功 → 共 3 次上游请求", oai.requests.filter((r) => r.method === "POST").length, 3);
      eq("retry: 正文来自第 3 次", texts(ok.events), "retried");
      eq("retry: stopReason", stopReasons(ok.events), ["END_TURN"]);
      _resetPoolForTest();
      // 5xx 一直失败：maxRetries=2 → 3 次后放弃
      counters.oaiFail = 0;
      scenario.oai = { kind: "fail-then-ok", failStatus: 500, failTimes: 99, text: [] };
      oai.requests.length = 0;
      const bad = await callKrs(krsBase, cwRequest({ convId: "retry2", modelId: "gpt-test" }));
      eq("retry: 一直 500 → 恰好 1+maxRetries=3 次", oai.requests.filter((r) => r.method === "POST").length, 3);
      includes("retry: 透出 500", texts(bad.events), "❌ 上游返回 500");
      _resetPoolForTest();
      // 已吐字后流断：不重试；仍带 stopReason
      scenario.oai = { kind: "break-after-output", text: "partial-output" };
      oai.requests.length = 0;
      const broken = await callKrs(krsBase, cwRequest({ convId: "retry3", modelId: "gpt-test" }));
      eq("retry: 已吐字后中断 → 只打一次（不重复内容）", oai.requests.filter((r) => r.method === "POST").length, 1);
      includes("retry: 已吐出的正文保留", texts(broken.events), "partial-output");
      check("retry: 中断后仍收尾 stopReason", lastIsStopReason(broken.events) || stopReasons(broken.events).length === 1);
      // autoRetry=false：500 直接透出，一次
      stub.__setConfig("autoRetry", false);
      counters.oaiFail = 0;
      scenario.oai = { kind: "fail-then-ok", failStatus: 502, failTimes: 99, text: [] };
      oai.requests.length = 0;
      const noRetry = await callKrs(krsBase, cwRequest({ convId: "retry4", modelId: "gpt-test" }));
      eq("retry: autoRetry=false → 只打一次", oai.requests.filter((r) => r.method === "POST").length, 1);
      includes("retry: 透出 502", texts(noRetry.events), "❌ 上游返回 502");
      stub.__setConfig("autoRetry", true);
      _resetPoolForTest();
    }

    // ---------- 8. 分片边界 ----------
    {
      scenario.anth = { kind: "split-utf8" };
      const u = await callKrs(krsBase, cwRequest({ convId: "utf8", modelId: "claude-test" }));
      eq("chunk: UTF-8 多字节字被切两半仍拼回", texts(u.events), "你好世界");
      check("chunk: 无替换字符", !texts(u.events).includes("\uFFFD"));
      eq("chunk: stopReason", stopReasons(u.events), ["END_TURN"]);
      scenario.anth = { kind: "split-line" };
      const l = await callKrs(krsBase, cwRequest({ convId: "line", modelId: "claude-test" }));
      eq("chunk: SSE 行被切两半仍完整解析", texts(l.events), "half-line-ok");
    }

    // ---------- 9. 意图分类器本地应答 ----------
    {
      anth.requests.length = 0;
      oai.requests.length = 0;
      const { events } = await callKrs(krsBase, cwRequest({ convId: "intent", modelId: "claude-test", content: "You are an intent classifier for a language model. Output (chat, do, spec). Here is the last user message: fix the bug" }));
      eq("intent: 零外发", anth.requests.filter((r) => r.method === "POST").length + oai.requests.filter((r) => r.method === "POST").length, 0);
      check("intent: 本地 JSON 概率", /"do":0\.9/.test(texts(events)));
      eq("intent: stopReason", stopReasons(events), ["END_TURN"]);
    }

    // ---------- 10. 分组标题 id → 回落该渠道首个勾选模型 ----------
    {
      scenario.oai = { kind: "text", text: ["fallback"] };
      oai.requests.length = 0;
      const { events } = await callKrs(krsBase, cwRequest({ convId: "grp", modelId: "a2k-group:p2" }));
      const post = oai.requests.find((r) => r.method === "POST");
      check("group: 路由到标题所属的 p2", !!post);
      // 回落后请求体里的 modelId 必须同步改写：build*Request 经 latestModelId(req) 取模型，否则标题 id 原样发给上游（真实上游 404）
      eq("group: 上游收到的 model 是回落后的 gpt-test", post ? (post.json as { model: string }).model : undefined, "gpt-test");
      eq("group: 正文", texts(events), "fallback");
      // 当前消息没有 modelId、只有历史里带标题 id（latestModelId 倒序取历史）：历史里的标题 id 也要改写
      oai.requests.length = 0;
      const histOnly = cwRequest({ convId: "grp2", modelId: "a2k-group:p2", content: "again", history: [{ userInputMessage: { content: "earlier", modelId: "a2k-group:p2", userInputMessageContext: {} } }, { assistantResponseMessage: { content: "ok" } }] }) as { conversationState: { currentMessage: { userInputMessage: { modelId?: string } } } };
      delete histOnly.conversationState.currentMessage.userInputMessage.modelId;
      const h = await callKrs(krsBase, histOnly);
      const post2 = oai.requests.find((r) => r.method === "POST");
      eq("group: 只有历史带标题 id 时上游 model 也是 gpt-test", post2 ? (post2.json as { model: string }).model : undefined, "gpt-test");
      eq("group: 历史场景正文", texts(h.events), "fallback");
    }

    // ---------- 11. 未配置上游阻断（零外发） ----------
    {
      anth.requests.length = 0;
      oai.requests.length = 0;
      stub.__setConfig("providers", [{ ...provAnth, baseUrl: "" }, { ...provOai, apiKey: "" }]);
      const { status, events } = await callKrs(krsBase, cwRequest({ convId: "blocked", modelId: "claude-test" }));
      eq("blocked: 仍 200 event-stream", status, 200);
      includes("blocked: 引导文案", texts(events), "尚无可用的 provider");
      includes("blocked: 列出缺什么（缺少地址）", texts(events), "缺少地址");
      includes("blocked: 列出缺什么（缺少 API Key）", texts(events), "缺少 API Key");
      eq("blocked: stopReason=END_TURN（不让 Kiro 判截断重发）", stopReasons(events), ["END_TURN"]);
      eq("blocked: 零外发", anth.requests.length + oai.requests.length, 0);
      // 完全没有 provider
      stub.__setConfig("providers", []);
      const none = await callKrs(krsBase, cwRequest({ convId: "blocked2", modelId: "claude-test" }));
      includes("blocked: 无 provider 文案", texts(none.events), "当前没有任何 provider");
      eq("blocked: 零外发（无 provider）", anth.requests.length + oai.requests.length, 0);
      stub.__setConfig("providers", [provAnth, provOai]);
    }

    // ---------- 12. 代理关闭时不外发 ----------
    {
      stub.__setConfig("enabled", false);
      anth.requests.length = 0;
      const r = await postRaw(krsBase + "/generateAssistantResponse", JSON.stringify(cwRequest({ modelId: "claude-test" })));
      eq("disabled: 返回 {}", r.buf.toString("utf8"), "{}");
      eq("disabled: 零外发", anth.requests.length, 0);
      stub.__setConfig("enabled", true);
    }

    // ---------- 13. 非法 JSON 请求体 ----------
    {
      const r = await postRaw(krsBase + "/generateAssistantResponse", "{conversationState: nope");
      eq("badjson: 400", r.status, 400);
    }

    // ---------- 14. 大体积中文请求体：入站分块不能切坏 UTF-8 ----------
    {
      // Kiro 每轮重放全部历史，请求体几百 KB 很常见；正文含大量 3 字节汉字时，TCP 分块边界几乎必然落在某个字中间。
      scenario.anth = { kind: "text", text: ["ok"] };
      let corrupted = 0;
      let tried = 0;
      for (const n of [100_000, 100_001, 100_002, 150_000]) {
        anth.requests.length = 0;
        const zh = "中文字符串测试".repeat(Math.ceil(n / 7)).slice(0, n);
        await callKrs(krsBase, cwRequest({ convId: "zh" + n, modelId: "claude-test", content: zh }));
        const up = anth.requests.find((r) => r.method === "POST");
        const got = up ? ((up.json as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "") : "";
        tried++;
        if (got !== zh || got.includes("\uFFFD")) {
          corrupted++;
        }
      }
      check(`inbound-utf8: ${tried} 个大中文请求体经 KRS 转发后逐字相等`, corrupted === 0, `${corrupted}/${tried} 个请求被切坏（含 U+FFFD 或与原文不等）`);
      // 边界对齐：把切点精确落在 3 字节汉字中间 —— 手工分两段写 TCP，第一段止于某个字的第 1 个字节
      {
        anth.requests.length = 0;
        const zh = "边界切割测试".repeat(2000);
        const payload = Buffer.from(JSON.stringify(cwRequest({ convId: "zh-cut", modelId: "claude-test", content: zh })), "utf8");
        const cut = payload.indexOf(Buffer.from("割", "utf8")) + 1;
        await new Promise<void>((resolve, reject) => {
          const u = new URL(krsBase + "/generateAssistantResponse");
          const req = http.request(
            { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "Content-Type": "application/json", "Content-Length": payload.length } },
            (res) => {
              res.on("data", () => undefined);
              res.on("end", resolve);
              res.on("error", reject);
            }
          );
          req.on("error", reject);
          req.write(payload.subarray(0, cut));
          setTimeout(() => {
            req.write(payload.subarray(cut));
            req.end();
          }, 30);
        });
        const up = anth.requests.find((r) => r.method === "POST");
        const got = up ? ((up.json as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "") : "";
        eq("inbound-utf8: 切点落在汉字第 1 字节后仍逐字相等", got === zh && !got.includes("\uFFFD"), true);
      }
    }

    // ---------- 14. 日志脱敏 ----------
    {
      const lines = stub.__outputLines().join("\n");
      check("log: 输出通道里不出现明文 key", !lines.includes("sk-fake-anth") && !lines.includes("sk-fake-oai"));
    }

    // ---------- 15. 配置回调串行化：enabled 快速抖动后「端点劫持」与「端口监听」必须自洽 ----------
    {
      // 激活整个扩展（vscode 桩）。模型目录 URL 指到假上游的 404（静默失败），全程不出网；
      // 端口另挑两个空闲的，不碰上面那台 KRS 也不碰真实的 19810/19811。
      _setCatalogUrlForTest(anth.base + "/models.dev-nope");
      stub.__setConfig("providers", []);
      stub.__setConfig("enabled", false);
      const extPort = await pickPort(port + 1);
      const extCps = await pickPort(extPort + 1);
      stub.__setConfig("port", extPort);
      stub.__setConfig("cpsPort", extCps);
      const extCtx = stub.__makeContext({ version: "4.13.30" }) as vscode.ExtensionContext;
      await activate(extCtx);
      const hijacked = () => vscode.workspace.getConfiguration("codewhisperer.config").inspect("krsEndpoints")!.globalValue;
      const listening = (p: number) =>
        new Promise<boolean>((resolve) => {
          const s = net.connect(p, "127.0.0.1");
          s.once("connect", () => {
            s.destroy();
            resolve(true);
          });
          s.once("error", () => resolve(false));
        });
      const toggle = (v: boolean) => {
        stub.__setConfig("enabled", v);
        stub.__fireConfigChange(["api2kiroDual.enabled"]);
      };
      check("cfg: 激活时 enabled=false → 端点未劫持、KRS 端口无人监听", hijacked() === undefined && !(await listening(extPort)), hijacked());

      // true→false 连发（第二条在第一条的 await 中途到达）
      toggle(true);
      toggle(false);
      await _configChangesSettledForTest();
      eq("cfg: true→false 后 isEnabled=false", isEnabled(), false);
      check("cfg: true→false 后端点未被劫持（无残留 Global 值）", hijacked() === undefined, hijacked());
      check("cfg: true→false 后 KRS 端口无人监听", !(await listening(extPort)));
      check("cfg: true→false 后 CPS 端口无人监听", !(await listening(extCps)));

      // true→false→true 连发：最终必须是「已劫持 + 在监听 + 能应答身份」
      toggle(true);
      toggle(false);
      toggle(true);
      await _configChangesSettledForTest();
      eq("cfg: true→false→true 后 isEnabled=true", isEnabled(), true);
      check("cfg: true→false→true 后端点指向本机 KRS", JSON.stringify(hijacked() ?? "").includes(`127.0.0.1:${extPort}`), hijacked());
      check("cfg: true→false→true 后 KRS 在监听", await listening(extPort));
      check("cfg: true→false→true 后 CPS 在监听", await listening(extCps));
      const id = await postRaw(`http://127.0.0.1:${extPort}${PROXY_ID_PATH}`, "");
      eq("cfg: 该 KRS 应答身份 token", JSON.parse(id.buf.toString("utf8")).proxy, PROXY_ID_TOKEN);

      // 收尾：关闭后必须完全复原
      toggle(false);
      await _configChangesSettledForTest();
      check("cfg: 关闭后端点恢复、两个端口都释放", hijacked() === undefined && !(await listening(extPort)) && !(await listening(extCps)), hijacked());
      await deactivate();
      for (const d of extCtx.subscriptions) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      stub.__setConfig("providers", [provAnth, provOai]);
      stub.__setConfig("enabled", true);
    }
  } finally {
    await krs.stop();
    await anth.close();
    await oai.close();
  }
});
