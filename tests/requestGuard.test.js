"use strict";
// 本地 HTTP 服务的来源守卫（纯函数部分）。
const test = require("node:test");
const assert = require("node:assert");

const G = require("./.build/requestGuard.js");

test("hostWithoutPort", () => {
  assert.equal(G.hostWithoutPort("127.0.0.1:19810"), "127.0.0.1");
  assert.equal(G.hostWithoutPort("127.0.0.1"), "127.0.0.1");
  assert.equal(G.hostWithoutPort("[::1]:19810"), "[::1]");
  assert.equal(G.hostWithoutPort("[::1]"), "[::1]");
  assert.equal(G.hostWithoutPort("::1"), "::1");
  assert.equal(G.hostWithoutPort("LOCALHOST:80"), "localhost");
  assert.equal(G.hostWithoutPort("  localhost  "), "localhost");
  assert.equal(G.hostWithoutPort("evil.example.com:19810"), "evil.example.com");
});

test("isLoopbackAddress", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "127.255.255.255", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) {
    assert.equal(G.isLoopbackAddress(a), true, a);
  }
  for (const a of [undefined, "", "10.0.0.1", "192.168.1.1", "::2", "0.0.0.0", "127.0.0.999", "::ffff:10.0.0.1"]) {
    assert.equal(G.isLoopbackAddress(a), false, String(a));
  }
});

/** 造一组「本机非浏览器客户端」的合法头。 */
function okHeaders(extra = {}) {
  return { host: "127.0.0.1:19810", ...extra };
}

test("放行：合法本机客户端", () => {
  const v = G.classifyLocalRequest(okHeaders(), "127.0.0.1");
  assert.equal(v.allow, true);
  assert.equal(v.reason, "ok");
  // Sec-Fetch-Site: none（地址栏直接导航）也放行
  assert.equal(G.classifyLocalRequest(okHeaders({ "sec-fetch-site": "none" }), "::1").allow, true);
});

test("拒绝六条分支", () => {
  assert.equal(G.classifyLocalRequest({}, "127.0.0.1").reason, "host-missing");
  assert.equal(G.classifyLocalRequest({ host: "  " }, "127.0.0.1").reason, "host-missing");
  assert.equal(G.classifyLocalRequest({ host: "evil.example.com" }, "127.0.0.1").reason, "host-not-loopback");
  assert.equal(G.classifyLocalRequest(okHeaders({ origin: "https://evil.example.com" }), "127.0.0.1").reason, "origin-present");
  assert.equal(G.classifyLocalRequest(okHeaders({ origin: "vscode-webview://x" }), "127.0.0.1").reason, "origin-present");
  assert.equal(G.classifyLocalRequest(okHeaders({ "sec-fetch-site": "cross-site" }), "127.0.0.1").reason, "sec-fetch-site");
  assert.equal(G.classifyLocalRequest(okHeaders(), "10.0.0.5").reason, "remote-not-loopback");
  assert.equal(G.classifyLocalRequest(okHeaders(), undefined).reason, "remote-not-loopback");
});

test("拒绝时 detail 不含控制字符、有长度上限", () => {
  const v = G.classifyLocalRequest({ host: "a".repeat(500) }, "127.0.0.1");
  assert.equal(v.allow, false);
  assert.ok(!/[\x00-\x1f]/.test(v.detail));
  assert.ok(v.detail.length < 200);
});

test("_resetGuardForTest 可清限频表（重复调用不抛）", () => {
  G._resetGuardForTest();
  G._resetGuardForTest();
  assert.equal(typeof G.GUARD_WARN_INTERVAL_MS, "number");
});
