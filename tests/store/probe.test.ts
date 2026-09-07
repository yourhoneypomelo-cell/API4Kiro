/** providerProbe：404/405 视为可达；批量测活并发 3 可取消；Responses 测活 input 为 item 列表；chat 400 换 max_completion_tokens。 */
import * as vscode from "vscode";
import * as http from "http";
import { URL } from "url";
import { test, run, eq, ok, includes, waitFor, sleep } from "./harness";
import { ModelTestResult, ProviderDraft, draftToProvider, measureLatency, probeModels, testModel, testModels } from "../../src/providerProbe";
import { resolveApiUrl } from "../../src/providers";

const stub = vscode as unknown as { __reset(): void };
const PORT = 19875;
const BASE = `http://127.0.0.1:${PORT}`;

let inflight = 0;
let maxInflight = 0;
let chatCalls = 0;
const bodies: Array<Record<string, unknown>> = [];
const pending = new Set<http.ServerResponse>();

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}
function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", BASE);
  const p = u.pathname;
  if (p === "/nomodels/v1/models") return send(res, 404, { error: "not found" });
  if (p === "/nomethod/v1/models") return send(res, 405, "method not allowed");
  if (p === "/auth/v1/models") return send(res, 401, { error: { message: "Incorrect API key" } });
  if (p === "/boom/v1/models") return send(res, 500, { error: { message: "internal" } });
  if (p === "/v1/models") return send(res, 200, { data: [{ id: "zeta" }, { id: "alpha", name: "Alpha" }, { id: "alpha" }, { name: "models/gemini-x", displayName: "Gemini X" }, { bogus: 1 }] });
  if (p === "/html/v1/models") return send(res, 200, "<html>login</html>");
  if (p === "/v1/chat/completions" || p === "/strict/v1/chat/completions") {
    chatCalls++;
    const body = await readJson(req);
    bodies.push(body);
    if (p.startsWith("/strict") && body.max_tokens !== undefined) {
      return send(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    }
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    pending.add(res);
    await sleep(120);
    pending.delete(res);
    inflight--;
    if (body.model === "dead-model") return send(res, 404, { error: { message: "model not found" } });
    if (body.model === "err200") return send(res, 200, { error: { message: "quota exceeded inside 200" } });
    return send(res, 200, { choices: [{ message: { content: `hello from ${body.model}` } }] });
  }
  if (p === "/v1/responses") {
    const body = await readJson(req);
    bodies.push(body);
    if (!Array.isArray(body.input)) return send(res, 400, { error: { message: "Input must be a list" } });
    return send(res, 200, { output: [{ type: "message", content: [{ type: "output_text", text: "hi there" }] }] });
  }
  if (p === "/v1/messages") {
    const body = await readJson(req);
    bodies.push(body);
    return send(res, 200, { content: [{ type: "text", text: "anthropic ok" }] });
  }
  send(res, 404, { error: "no route " + p });
});

function draft(over: Partial<ProviderDraft> = {}): ProviderDraft {
  return { baseUrl: BASE, apiKey: "sk-test", format: "chat", ...over };
}

test("setup", async () => {
  stub.__reset();
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
});

test("draftToProvider / resolveApiUrl：手填地址补 /v1；带 /vN 或 exactBase 不补", () => {
  const p = draftToProvider(draft());
  eq(resolveApiUrl(p, "/models"), `${BASE}/v1/models`);
  eq(resolveApiUrl(draftToProvider(draft({ baseUrl: BASE + "/v4" })), "/models"), `${BASE}/v4/models`);
  eq(resolveApiUrl(draftToProvider(draft({ baseUrl: BASE + "/v1beta" })), "/models"), `${BASE}/v1beta/models`);
  eq(p.credentials![0].apiKey, "sk-test");
  eq(p.id, "__probe__");
});

test("measureLatency：200 通；404/405 视为可达（ok=true 带 note）；401 不通带鉴权提示；500 不通；连不上 ms=-1", async () => {
  const good = await measureLatency(draft());
  eq(good.ok, true);
  eq(good.status, 200);
  ok(good.ms >= 0 && good.ms < 5000);
  const nf = await measureLatency(draft({ baseUrl: BASE + "/nomodels" }));
  eq(nf.ok, true);
  eq(nf.status, 404);
  includes(nf.note || "", "可达");
  const nm = await measureLatency(draft({ baseUrl: BASE + "/nomethod" }));
  eq(nm.ok, true);
  eq(nm.status, 405);
  const au = await measureLatency(draft({ baseUrl: BASE + "/auth" }));
  eq(au.ok, false);
  eq(au.status, 401);
  includes(au.note || "", "鉴权失败");
  includes(au.error || "", "Incorrect API key");
  const boom = await measureLatency(draft({ baseUrl: BASE + "/boom" }));
  eq(boom.ok, false);
  eq(boom.status, 500);
  const down = await measureLatency(draft({ baseUrl: "http://127.0.0.1:19898" }));
  eq(down.ok, false);
  eq(down.ms, -1);
  eq(down.status, 0);
  eq((await measureLatency(draft({ baseUrl: "" }))).error, "地址为空");
});

test("probeModels：data[] 去重排序、Gemini 的 models/ 前缀、跳过无 id；401 如实报；非 JSON 报错", async () => {
  const r = await probeModels(draft());
  eq(r.ok, true);
  eq(
    r.models.map((m) => m.id).join(","),
    "alpha,gemini-x,zeta"
  );
  eq(r.models.find((m) => m.id === "alpha")!.name, "Alpha");
  eq(r.models.find((m) => m.id === "gemini-x")!.name, "Gemini X");
  const au = await probeModels(draft({ baseUrl: BASE + "/auth" }));
  eq(au.ok, false);
  eq(au.status, 401);
  const html = await probeModels(draft({ baseUrl: BASE + "/html" }));
  eq(html.ok, false);
  includes(html.error || "", "不是 JSON");
  const nf = await probeModels(draft({ baseUrl: BASE + "/nomodels" }));
  eq(nf.ok, false, "无预设目录可兜底 → 失败");
  eq(nf.status, 404);
});

test("testModel：chat 2xx 判活并抠样本；200 里塞 error 判死；404 判死；网关无 max_tokens 时换 max_completion_tokens 重试", async () => {
  bodies.length = 0;
  const ok1 = await testModel(draft(), "gpt-x");
  eq(ok1.ok, true);
  eq(ok1.sample, "hello from gpt-x");
  eq(bodies[0].max_tokens, 16);
  eq((bodies[0].messages as unknown[]).length, 1);
  const bad = await testModel(draft(), "err200");
  eq(bad.ok, false);
  includes(bad.error || "", "quota exceeded");
  const dead = await testModel(draft(), "dead-model");
  eq(dead.ok, false);
  eq(dead.status, 404);
  eq((await testModel(draft(), "  ")).error, "模型名为空");
  bodies.length = 0;
  const strict = await testModel(draft({ baseUrl: BASE + "/strict" }), "o9");
  eq(strict.ok, true);
  eq(bodies.length, 2, "先 max_tokens 被拒，再 max_completion_tokens");
  eq(bodies[0].max_tokens, 16);
  eq(bodies[1].max_tokens, undefined);
  eq(bodies[1].max_completion_tokens, 16);
});

test("testModel：responses 的 input 是 item 列表（role/content[input_text]）；anthropic 走 /messages", async () => {
  bodies.length = 0;
  const r = await testModel(draft({ format: "responses" }), "gpt-5");
  eq(r.ok, true);
  eq(r.sample, "hi there");
  const input = bodies[0].input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  ok(Array.isArray(input), "input 是数组");
  eq(input[0].role, "user");
  eq(input[0].content[0].type, "input_text");
  eq(input[0].content[0].text, "hi");
  eq(bodies[0].store, false);
  eq(bodies[0].max_output_tokens, 16);
  bodies.length = 0;
  const a = await testModel(draft({ format: "anthropic" }), "claude");
  eq(a.ok, true);
  eq(a.sample, "anthropic ok");
  eq(bodies[0].max_tokens, 16);
});

test("testModels：并发上限 3、逐个回调、全部完成", async () => {
  inflight = 0;
  maxInflight = 0;
  const results: ModelTestResult[] = [];
  const idx: number[] = [];
  const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
  const h = testModels(draft(), ids, (r, i, total) => {
    results.push(r);
    idx.push(i);
    eq(total, 7);
  });
  await h.done;
  eq(results.length, 7);
  ok(maxInflight <= 3, `并发峰值 ${maxInflight}`);
  ok(maxInflight >= 2, `确实并行了（峰值 ${maxInflight}）`);
  eq([...idx].sort((a, b) => a - b).join(","), "0,1,2,3,4,5,6");
  ok(results.every((r) => r.ok));
});

test("testModels：cancel 后不再发新请求，在途的结果丢弃；空列表立即完成", async () => {
  chatCalls = 0;
  const results: ModelTestResult[] = [];
  const ids = Array.from({ length: 12 }, (_, i) => "c" + i);
  const h = testModels(draft(), ids, (r) => results.push(r));
  await waitFor(() => results.length >= 1, 5000);
  h.cancel();
  await h.done;
  ok(results.length < 12, `取消后只收到 ${results.length} 个结果`);
  ok(chatCalls <= 6, `取消后不再发新请求（共发 ${chatCalls}）`);
  const empty = testModels(draft(), [], () => undefined);
  await empty.done;
});

test("teardown", async () => {
  for (const r of pending) {
    try {
      r.end();
    } catch {
      /* ignore */
    }
  }
  (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

run();
