/**
 * 探测与转发共用的底层健壮性：
 *  - src/upstream.ts：非法 URL、空闲超时（连接后不吐字 / 头到了正文停住）、重定向不跟随（现状断言）、getJson 竞速、多字节跨 chunk；
 *  - src/config.ts：updateSetting 写后回读校验与本地兜底（工作区遮蔽时的「假成功」防护）。
 */
import * as vscode from "vscode";
import { cfg, initConfig, isEnabled, updateSetting } from "../src/config";
import { getJson, readBody, requestUpstream } from "../src/upstream";
import { check, eq, finish, rejects, startServer, test } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext; __setConfig(k: string, v: unknown, t?: number): void; __resetConfig(): void };
const stub = vscode as unknown as Stub;

(async () => {
  const ctx = stub.__makeContext();
  initConfig(ctx);

  const srv = await startServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/hang") {
      return; // 永不应答
    }
    if (path === "/stall") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
      return; // 正文停住
    }
    if (path === "/redirect") {
      res.writeHead(302, { Location: `/final` });
      res.end();
      return;
    }
    if (path === "/final") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (path === "/multibyte") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      const bytes = Buffer.from("模型：你好", "utf8");
      res.write(bytes.subarray(0, 4)); // 切在「型」的中间
      await new Promise((r) => setTimeout(r, 20));
      res.write(bytes.subarray(4, 10));
      await new Promise((r) => setTimeout(r, 20));
      res.end(bytes.subarray(10));
      return;
    }
    if (path === "/json500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    if (path === "/echo") {
      res.writeHead(200, { "Content-Type": "application/json", "x-seen-cl": String(req.headers["content-length"] || "") });
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization || null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await test("requestUpstream：非法 URL 立刻拒绝；正常请求带 Content-Length", async () => {
    await rejects("非法 URL", requestUpstream("GET", "not a url", {}), "Invalid upstream URL");
    const r = await requestUpstream("POST", `${srv.url}/echo`, { Authorization: "Bearer t" }, "héllo");
    eq("状态码", r.statusCode, 200);
    eq("Content-Length 按字节数（é 占 2 字节）", String(r.headers["x-seen-cl"]), "6");
    const body = JSON.parse(await readBody(r.body)) as { method: string; auth: string };
    eq("方法与头透传", `${body.method} ${body.auth}`, "POST Bearer t");
  });

  await test("超时：连接后不应答 → 按 timeoutMs 拒绝；头到了正文停住 → readBody 也在空闲超时后结束", async () => {
    const t0 = Date.now();
    await rejects("不应答 → upstream request timeout", requestUpstream("GET", `${srv.url}/hang`, {}, undefined, 300), "upstream request timeout");
    const dt = Date.now() - t0;
    check("耗时 ≈ timeoutMs（<1500ms）", dt >= 250 && dt < 1500, dt);
    const r = await requestUpstream("GET", `${srv.url}/stall`, {}, undefined, 300);
    eq("头先到 → 立即 resolve 200", r.statusCode, 200);
    const t1 = Date.now();
    await rejects("正文停住 → 空闲超时把流打断，readBody 拒绝（aborted）", readBody(r.body), /timeout|aborted/);
    const dt1 = Date.now() - t1;
    check("正文超时也 ≈ timeoutMs", dt1 >= 250 && dt1 < 1500, dt1);
  });

  await test("重定向：不跟随（现状）——3xx 原样返给调用方，调用方按状态码处理", async () => {
    const r = await requestUpstream("GET", `${srv.url}/redirect`, {});
    eq("302 原样", r.statusCode, 302);
    eq("Location 可见", String(r.headers.location), "/final");
    await readBody(r.body);
  });

  await test("getJson：解析 / 非 2xx 抛 HTTP 状态 / 竞速超时", async () => {
    const j = (await getJson(`${srv.url}/final`, {})) as { ok: boolean };
    eq("解析 JSON", j.ok, true);
    await rejects("500 → HTTP 500: …", getJson(`${srv.url}/json500`, {}), "HTTP 500: {\"error\":\"boom\"}");
    const t0 = Date.now();
    await rejects("不应答 → request timeout", getJson(`${srv.url}/hang`, {}, 300), /timeout/);
    check("竞速在 timeoutMs 附近结束", Date.now() - t0 < 1500, Date.now() - t0);
  });

  await test("readBody：多字节字符跨 chunk 不乱码", async () => {
    const r = await requestUpstream("GET", `${srv.url}/multibyte`, {});
    eq("utf8 解码正确", await readBody(r.body), "模型：你好");
  });

  await test("config.updateSetting：写后回读一致 → ok 并清兜底；被工作区遮蔽 → 报错并落本地兜底，读侧以兜底为准", async () => {
    stub.__resetConfig();
    const ok = await updateSetting("enabled", true);
    eq("正常写入 ok", ok.settingsOk, true);
    eq("Global 已写", cfg().inspect("enabled")?.globalValue, true);
    eq("isEnabled 读到 true", isEnabled(), true);
    eq("无兜底残留", ctx.globalState.get("fallback.enabled"), undefined);
    // 工作区层写死 false，遮蔽 Global
    stub.__setConfig("enabled", false, vscode.ConfigurationTarget.Workspace);
    const shadowed = await updateSetting("enabled", true);
    eq("回读不一致 → settingsOk=false", shadowed.settingsOk, false);
    check("错误提示点明遮蔽", /遮蔽|未持久化/.test(shadowed.error || ""), shadowed.error);
    eq("兜底已落 globalState", ctx.globalState.get("fallback.enabled"), true);
    eq("读侧以兜底为准：isEnabled=true", isEnabled(), true);
    eq("而 VS Code 有效值仍是 false", cfg().get("enabled"), false);
    // 工作区改回一致后再写 → 清兜底
    stub.__setConfig("enabled", undefined, vscode.ConfigurationTarget.Workspace);
    const again = await updateSetting("enabled", true);
    eq("恢复一致 → ok", again.settingsOk, true);
    eq("兜底清除", ctx.globalState.get("fallback.enabled"), undefined);
    const off = await updateSetting("enabled", false);
    eq("关闭写入 ok", off.settingsOk, true);
    eq("isEnabled=false", isEnabled(), false);
  });

  await srv.close();
  finish();
})();
