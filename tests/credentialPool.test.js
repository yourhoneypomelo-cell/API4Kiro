"use strict";
// key 池调度：分类、冷却、选择与轮换。
const test = require("node:test");
const assert = require("node:assert");

const P = require("./.build/credentialPool.js");

function provider(over = {}) {
  return {
    id: "p1",
    name: "渠道一",
    protocol: "anthropic",
    baseUrl: "https://api.example.com",
    apiKey: "k1",
    enabled: true,
    credentials: [
      { id: "c1", apiKey: "k1", priority: 0, enabled: true },
      { id: "c2", apiKey: "k2", priority: 1, enabled: true },
    ],
    ...over,
  };
}

test.beforeEach(() => P._resetPoolForTest());

test("classifyFailure：每个分支的成功与失败两侧", () => {
  assert.equal(P.classifyFailure(0, ""), "network");
  assert.equal(P.classifyFailure(401, "unauthorized"), "auth");
  assert.equal(P.classifyFailure(401, "invalid api key"), "auth");
  assert.equal(P.classifyFailure(402, "payment required"), "quota");
  assert.equal(P.classifyFailure(403, "forbidden"), "forbidden");
  assert.equal(P.classifyFailure(403, "insufficient balance"), "quota");
  assert.equal(P.classifyFailure(429, "too many requests"), "ratelimit");
  assert.equal(P.classifyFailure(429, "quota exceeded"), "quota");
  assert.equal(P.classifyFailure(500, "boom"), "upstream");
  assert.equal(P.classifyFailure(503, ""), "upstream");
  assert.equal(P.classifyFailure(400, "invalid model"), "other");
  assert.equal(P.classifyFailure(400, "Your credit balance is too low to access the Anthropic API"), "quota");
  assert.equal(P.classifyFailure(400, "insufficient_quota"), "quota");
  // 单个词不能当欠费（否则一次参数错会把整池 key 烧一遍）
  assert.equal(P.classifyFailure(400, "quota field invalid"), "other");
});

test("shouldRotate：只有凭证自身的问题才换 key", () => {
  assert.equal(P.shouldRotate("auth"), true);
  assert.equal(P.shouldRotate("quota"), true);
  assert.equal(P.shouldRotate("forbidden"), true);
  assert.equal(P.shouldRotate("ratelimit"), false);
  assert.equal(P.shouldRotate("upstream"), false);
  assert.equal(P.shouldRotate("network"), false);
  assert.equal(P.shouldRotate("other"), false);
});

test("parseRetryAfter：秒数 / HTTP 日期 / 垃圾值", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(P.parseRetryAfter("30", now), 30_000);
  assert.equal(P.parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(P.parseRetryAfter("Wed, 01 Jan 2026 00:01:00 GMT", now), 60_000);
  assert.equal(P.parseRetryAfter(undefined, now), undefined);
  assert.equal(P.parseRetryAfter("", now), undefined);
  assert.equal(P.parseRetryAfter("soon", now), undefined);
  assert.equal(P.parseRetryAfter("Wed, 01 Jan 2020 00:00:00 GMT", now), undefined, "过期日期不算");
});

test("pickCredential：priority 策略选主 key，会话粘住", () => {
  const p = provider();
  const a = P.pickCredential(p, "conv-1");
  assert.equal(a.credential.id, "c1");
  assert.equal(a.sticky, false);
  assert.equal(a.cooling, false);
  const b = P.pickCredential(p, "conv-1");
  assert.equal(b.credential.id, "c1");
  assert.equal(b.sticky, true);
});

test("pickCredential：least-used 按成功数分摊", () => {
  const p = provider({ poolStrategy: "least-used" });
  P.markSuccess(p, p.credentials[0]);
  P.markSuccess(p, p.credentials[0]);
  const a = P.pickCredential(p, "conv-a");
  assert.equal(a.credential.id, "c2");
});

test("pickCredential：exclude 与全停用 ⇒ undefined", () => {
  const p = provider();
  assert.equal(P.pickCredential(p, "c", new Set(["c1", "c2"])), undefined);
  const off = provider({ credentials: [{ id: "c1", apiKey: "", priority: 0, enabled: true }] });
  assert.equal(P.pickCredential(off, "c"), undefined);
});

test("pickCredential：冷却时避让；全都冷却仍给最早解冻的那把", () => {
  const p = provider();
  P.markFailure(p, p.credentials[0], 401, "invalid api key");
  const a = P.pickCredential(p, "conv-1");
  assert.equal(a.credential.id, "c2", "冷却中的 c1 应被避让");
  P.markFailure(p, p.credentials[1], 401, "invalid api key");
  const b = P.pickCredential(p, "conv-2");
  assert.equal(b.cooling, true, "全冷却时不能本地拒绝请求");
  // allowCooling=false（换 key 重发）时不再回头
  assert.equal(P.pickCredential(p, "conv-3", new Set(), { allowCooling: false }), undefined);
});

test("markFailure：冷却时长、原因、rotate 判定", () => {
  const p = provider();
  const r401 = P.markFailure(p, p.credentials[0], 401, "invalid api key");
  assert.equal(r401.kind, "auth");
  assert.equal(r401.cooldownMs, P.COOLDOWN_MS.auth);
  assert.equal(r401.rotate, true, "池里还有健康的 c2 才建议换 key");
  const r429 = P.markFailure(p, p.credentials[1], 429, "too many requests", "30");
  assert.equal(r429.kind, "ratelimit");
  assert.equal(r429.cooldownMs, 30_000);
  assert.equal(r429.rotate, false);
  const single = provider({ credentials: [{ id: "c1", apiKey: "k", priority: 0, enabled: true }] });
  assert.equal(P.markFailure(single, single.credentials[0], 401, "x").rotate, false, "只有一把时无处可换");
});

test("markFailure：不缩短已有的更长冷却，原因跟着当前冷却期", () => {
  const p = provider();
  const long = P.markFailure(p, p.credentials[0], 402, "payment required");
  assert.equal(long.kind, "quota");
  const short = P.markFailure(p, p.credentials[0], 500, "boom");
  const rt = P.credentialRuntimes(p).find((x) => x.credentialId === "c1");
  assert.equal(rt.cooldownReason, "quota", "冷却期末端不能被更短的失败改写");
  assert.equal(rt.failures, 2);
  assert.equal(short.kind, "upstream");
});

test("markSuccess：清冷却并累计成功数", () => {
  const p = provider();
  P.markFailure(p, p.credentials[0], 401, "x");
  P.markSuccess(p, p.credentials[0]);
  const rt = P.credentialRuntimes(p).find((x) => x.credentialId === "c1");
  assert.equal(rt.successes, 1);
  assert.equal(rt.cooldownUntil, undefined);
  assert.equal(P.pickCredential(p, "conv-1").credential.id, "c1");
});

test("credentialRuntimes：永远按 credentialsOf 全量返回，含没状态的那把", () => {
  const p = provider();
  const list = P.credentialRuntimes(p);
  assert.deepEqual(list.map((r) => r.credentialId), ["c1", "c2"]);
  assert.equal(list[1].successes, 0);
  assert.equal(list[1].failures, 0);
  assert.equal(list[1].cooldownUntil, undefined);
  // 没显式 credentials 时合成一条 c1
  const synth = provider({ credentials: undefined });
  assert.deepEqual(P.credentialRuntimes(synth).map((r) => r.credentialId), ["c1"]);
});
