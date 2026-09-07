/**
 * 草稿探测（src/providerProbe.ts）：测延迟（404/405/400 算可达、401 报鉴权）、拉模型（三种形状 / 目录兜底）、
 * 测活（anthropic / chat / responses / gemini 最小请求；Responses 的 input 必须是 item 列表；chat 被拒 max_tokens 换字段重试）、
 * 批量测活（并发 3、可取消、逐个回调）。全部打本机假上游，Key 是假的。
 */
import * as http from "http";
import { initConfig } from "../src/config";
import * as vscode from "vscode";
import { loadCatalogJsonForTest } from "../src/modelCatalog";
import { ProviderDraft, draftToProvider, measureLatency, probeModels, testModel, testModels } from "../src/providerProbe";
import { resolveApiUrl } from "../src/providers";
import { check, deepEq, eq, finish, includes, jsonBody, sendJson, sleep, startServer, test } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext };
const stub = vscode as unknown as Stub;

let modelsMode: "data" | "models" | "bare" | "404" | "405" | "400" | "401" | "500" | "html" | "empty" = "data";
let inflight = 0;
let maxInflight = 0;
let chatDelayMs = 0;
const seen: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];

(async () => {
  initConfig(stub.__makeContext());
  loadCatalogJsonForTest({
    zhipuai: { id: "zhipuai", name: "Zhipu", api: "https://open.bigmodel.cn/api/paas/v4", npm: "@ai-sdk/openai-compatible", env: ["ZHIPU_API_KEY"], models: { "glm-5.3": { name: "GLM-5.3" }, "glm-4.7-flash": { name: "GLM-4.7 Flash" } } },
  });

  const srv = await startServer(async (req, res, raw) => {
    const path = (req.url || "").split("?")[0];
    const body = jsonBody(raw);
    seen.push({ path, body, headers: req.headers });
    if (/\/models$/.test(path) && req.method === "GET") {
      const entries = [{ id: "zeta" }, { id: "alpha", display_name: "Alpha!" }, { id: "alpha" }, { name: "models/gemini-x", displayName: "Gemini X" }];
      switch (modelsMode) {
        case "data":
          return sendJson(res, 200, { data: entries });
        case "models":
          return sendJson(res, 200, { models: entries });
        case "bare":
          return sendJson(res, 200, entries);
        case "empty":
          return sendJson(res, 200, { data: [] });
        case "404":
          return sendJson(res, 404, { error: { message: "Not Found" } });
        case "405":
          res.writeHead(405, { Allow: "POST" });
          return res.end();
        case "400":
          return sendJson(res, 400, { error: { message: "missing param" } });
        case "401":
          return sendJson(res, 401, { error: { message: "Invalid API key provided: sk-bad" } });
        case "500":
          return sendJson(res, 500, { error: { message: "boom" } });
        case "html":
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end("<html>login</html>");
      }
    }
    if (/\/messages$/.test(path)) {
      if (body.model === "anth-404") {
        return sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "model: anth-404 not found" } });
      }
      return sendJson(res, 200, { id: "msg", type: "message", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" });
    }
    if (/\/chat\/completions$/.test(path)) {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (chatDelayMs) {
          await sleep(chatDelayMs);
        }
        if (body.model === "o-reason" && "max_tokens" in body) {
          return sendJson(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error" } });
        }
        if (body.model === "err200") {
          return sendJson(res, 200, { error: { message: "model overloaded, try later" } });
        }
        if (body.model === "reasoning-empty") {
          return sendJson(res, 200, { choices: [{ message: { content: "", reasoning_content: "thinking..." } }] });
        }
        return sendJson(res, 200, { choices: [{ message: { role: "assistant", content: `Hi from ${String(body.model)}` } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
      } finally {
        inflight--;
      }
    }
    if (/\/responses$/.test(path)) {
      const input = body.input as unknown;
      const okList = Array.isArray(input) && input.every((it) => it && typeof it === "object" && Array.isArray((it as { content?: unknown }).content) && ((it as { content: Array<{ type?: string }> }).content[0]?.type === "input_text"));
      if (!okList) {
        return sendJson(res, 400, { error: { message: "Input must be a list" } });
      }
      if (body.stream !== false || body.store !== false) {
        return sendJson(res, 400, { error: { message: "expected stream:false store:false" } });
      }
      return sendJson(res, 200, { id: "resp", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi from responses" }] }] });
    }
    if (/:generateContent$/.test(path)) {
      return sendJson(res, 200, { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Hey" }] } }] });
    }
    sendJson(res, 404, { error: { message: "no route " + path } });
  });

  const draft = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({ baseUrl: srv.url, apiKey: "sk-fake-probe-key-000000", format: "chat", ...over });

  await test("draftToProvider / resolveApiUrl：启发式 /v1、已带版本段、exactBase 预设", () => {
    eq("无版本段补 /v1", resolveApiUrl(draftToProvider(draft()), "/models"), `${srv.url}/v1/models`);
    eq("已带 /v4 原样", resolveApiUrl(draftToProvider(draft({ baseUrl: `${srv.url}/v4` })), "/models"), `${srv.url}/v4/models`);
    eq("已带 /v1beta 原样", resolveApiUrl(draftToProvider(draft({ baseUrl: `${srv.url}/v1beta`, format: "gemini" })), "/models"), `${srv.url}/v1beta/models`);
    eq("md: 预设 → exactBase 不补 /v1", resolveApiUrl(draftToProvider(draft({ baseUrl: `${srv.url}/api/paas/v4`, presetId: "md:zhipuai" })), "/models"), `${srv.url}/api/paas/v4/models`);
    const p = draftToProvider(draft({ credentialId: "c3" }));
    eq("草稿 id 为 __probe__", p.id, "__probe__");
    eq("草稿只带指定那一把凭证", p.credentials?.[0].id, "c3");
    eq("草稿 key 落到凭证", p.credentials?.[0].apiKey, "sk-fake-probe-key-000000");
    eq("尾斜杠去掉", draftToProvider(draft({ baseUrl: `${srv.url}///` })).baseUrl, srv.url);
  });

  await test("measureLatency：2xx 可达；404/405/400 可达但无清单；401 鉴权；5xx / 连不上 不通", async () => {
    modelsMode = "data";
    const ok = await measureLatency(draft());
    check("200 → ok 且 ms≥0", ok.ok && ok.ms >= 0 && ok.status === 200, ok);
    eq("鉴权头 Bearer 带上", String(seen[seen.length - 1].headers.authorization), "Bearer sk-fake-probe-key-000000");
    for (const m of ["404", "405", "400"] as const) {
      modelsMode = m;
      const r = await measureLatency(draft());
      check(`${m} → 可达`, r.ok && r.status === Number(m), r);
      includes(`${m} → note 说明 /models 不可用`, r.note, "/models 不可用");
    }
    modelsMode = "401";
    const auth = await measureLatency(draft());
    eq("401 → 不通", auth.ok, false);
    eq("401 → note 鉴权失败（Key）", auth.note, "鉴权失败：Key 不对或无权限");
    includes("401 → error 抠出上游 message", auth.error, "HTTP 401: Invalid API key");
    modelsMode = "500";
    const bad = await measureLatency(draft());
    check("500 → 不通", !bad.ok && bad.status === 500, bad);
    const dead = await measureLatency(draft({ baseUrl: "http://127.0.0.1:9" }));
    check("连不上 → ok=false ms=-1 status=0", !dead.ok && dead.ms === -1 && dead.status === 0, dead);
    includes("连不上 → error 含 ECONNREFUSED", dead.error, "ECONNREFUSED");
    eq("地址为空", (await measureLatency(draft({ baseUrl: "" }))).error, "地址为空");
    modelsMode = "data";
  });

  await test("probeModels：三种形状去重排序；Gemini name；目录兜底；401 不被目录掩盖", async () => {
    for (const m of ["data", "models", "bare"] as const) {
      modelsMode = m;
      const r = await probeModels(draft());
      deepEq(`${m}[] → 去重排序`, r.models.map((x) => x.id), ["alpha", "gemini-x", "zeta"]);
      eq(`${m}[] → display_name 作名字`, r.models[0].name, "Alpha!");
      eq(`${m}[] → displayName 作名字`, r.models[1].name, "Gemini X");
    }
    modelsMode = "404";
    const none = await probeModels(draft());
    check("404 且无预设 → ok=false", !none.ok && none.status === 404, none);
    const fb = await probeModels(draft({ presetId: "md:zhipuai" }));
    check("404 + 预设 → 目录兜底 ok", fb.ok && fb.status === 404, fb);
    deepEq("兜底清单来自目录（排序）", fb.models.map((m) => m.id), ["glm-4.7-flash", "glm-5.3"]);
    eq("兜底名字取目录 name", fb.models[1].name, "GLM-5.3");
    includes("兜底附说明", fb.error, "已用 models.dev 登记的清单");
    modelsMode = "401";
    const auth = await probeModels(draft({ presetId: "md:zhipuai" }));
    check("401 + 预设 → 不用目录掩盖鉴权错误", !auth.ok && auth.status === 401, auth);
    modelsMode = "html";
    const html = await probeModels(draft({ presetId: "md:zhipuai" }));
    check("非 JSON + 预设 → 目录兜底", html.ok && html.models.length === 2, html);
    includes("非 JSON 说明", html.error, "不是 JSON");
    eq("非 JSON 无预设 → ok=false", (await probeModels(draft())).ok, false);
    modelsMode = "empty";
    const empty = await probeModels(draft({ presetId: "md:zhipuai" }));
    check("空清单 + 预设 → 目录兜底", empty.ok && empty.models.length === 2, empty);
    const dead = await probeModels(draft({ baseUrl: "http://127.0.0.1:9", presetId: "md:zhipuai" }));
    check("连不上 + 预设 → 目录兜底 status=0", dead.ok && dead.status === 0 && dead.models.length === 2, dead);
    modelsMode = "data";
  });

  await test("testModel：四种格式的最小请求与样本；Responses input 用 item 列表；chat 被拒 max_tokens 换字段", async () => {
    seen.length = 0;
    const a = await testModel(draft({ format: "anthropic" }), "claude-x");
    check("anthropic ok + sample", a.ok && a.sample === "Hello", a);
    const ab = seen.find((s) => s.path.endsWith("/messages"))!;
    check("anthropic 请求体 max_tokens=16 stream=false", ab.body.max_tokens === 16 && ab.body.stream === false, ab.body);
    eq("anthropic 带 x-api-key", String(ab.headers["x-api-key"]), "sk-fake-probe-key-000000");
    eq("anthropic 带 anthropic-version", String(ab.headers["anthropic-version"]), "2023-06-01");
    seen.length = 0;
    const c = await testModel(draft(), "gpt-plain");
    check("chat ok + sample", c.ok && c.sample === "Hi from gpt-plain", c);
    eq("chat 只发一次", seen.filter((s) => s.path.endsWith("/chat/completions")).length, 1);
    seen.length = 0;
    const r = await testModel(draft(), "o-reason");
    check("chat 被拒 max_tokens → 换 max_completion_tokens 后 ok", r.ok && r.sample === "Hi from o-reason", r);
    const chats = seen.filter((s) => s.path.endsWith("/chat/completions"));
    eq("发了两次", chats.length, 2);
    check("第一次 max_tokens", "max_tokens" in chats[0].body && !("max_completion_tokens" in chats[0].body));
    check("第二次 max_completion_tokens", "max_completion_tokens" in chats[1].body && !("max_tokens" in chats[1].body));
    seen.length = 0;
    const resp = await testModel(draft({ format: "responses" }), "gpt-5");
    check("responses ok + sample", resp.ok && resp.sample === "hi from responses", resp);
    const rb = seen.find((s) => s.path.endsWith("/responses"))!.body;
    check("responses input 是 item 列表且 content[0].type=input_text", Array.isArray(rb.input) && (rb.input as Array<{ content: Array<{ type: string }> }>)[0].content[0].type === "input_text", rb.input);
    eq("responses max_output_tokens=16", rb.max_output_tokens, 16);
    const g = await testModel(draft({ format: "gemini", baseUrl: `${srv.url}/v1beta` }), "gemini-x");
    check("gemini ok，样本跳过 thought part", g.ok && g.sample === "Hey", g);
    const e200 = await testModel(draft(), "err200");
    check("200 里塞 error → 不算活", !e200.ok && /overloaded/.test(e200.error || ""), e200);
    const re = await testModel(draft(), "reasoning-empty");
    check("2xx 正文为空（推理模型）仍算活、无样本", re.ok && re.sample === undefined, re);
    const nf = await testModel(draft({ format: "anthropic" }), "anth-404");
    check("404 → 不活，error 抠出 message", !nf.ok && nf.status === 404 && /anth-404 not found/.test(nf.error || ""), nf);
    eq("模型名为空", (await testModel(draft(), "  ")).error, "模型名为空");
    const dead = await testModel(draft({ baseUrl: "http://127.0.0.1:9" }), "x");
    check("连不上 → status 0 ok=false", !dead.ok && dead.status === 0, dead);
  });

  await test("testModels：并发 3、逐个回调带 index/total、可取消", async () => {
    chatDelayMs = 120;
    maxInflight = 0;
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const got: Array<{ id: string; index: number; total: number; ok: boolean }> = [];
    const h = testModels(draft(), ids, (r, index, total) => got.push({ id: r.modelId, index, total, ok: r.ok }));
    await h.done;
    eq("7 个都回来了", got.length, 7);
    eq("并发上限 3", maxInflight, 3);
    deepEq("index 对应原顺序", [...got].sort((a, b) => a.index - b.index).map((g) => `${g.index}:${g.id}`), ids.map((id, i) => `${i}:${id}`));
    check("total 恒为 7", got.every((g) => g.total === 7));
    check("全部 ok", got.every((g) => g.ok));
    // 取消：第一个结果一到就 cancel → 在途的跑完即丢，不再发新请求
    seen.length = 0;
    maxInflight = 0;
    const got2: string[] = [];
    const h2 = testModels(draft(), ids, (r) => {
      got2.push(r.modelId);
      h2.cancel();
    });
    await h2.done;
    eq("取消后只回调了第一个", got2.length, 1);
    eq("上游只收到并发数那几条（3）", seen.filter((s) => s.path.endsWith("/chat/completions")).length, 3);
    // 空列表立即完成；并发数不超过数量
    let n = 0;
    await testModels(draft(), [], () => n++).done;
    eq("空列表零回调", n, 0);
    maxInflight = 0;
    await testModels(draft(), ["only"], () => undefined, 5).done;
    eq("1 个模型并发 1", maxInflight, 1);
    chatDelayMs = 0;
  });

  await srv.close();
  finish();
})();
