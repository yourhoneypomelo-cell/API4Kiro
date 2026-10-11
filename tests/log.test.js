"use strict";
// 日志脱敏（AC-26 的基础：任何 key 值都不得进日志）。
const test = require("node:test");
const assert = require("node:assert");

const L = require("./.build/log.js");

test("maskSecretForLog 三档 + 幂等", () => {
  assert.equal(L.maskSecretForLog(""), "");
  assert.equal(L.maskSecretForLog("short"), "****");
  assert.equal(L.maskSecretForLog("a".repeat(15)), "****");
  assert.equal(L.maskSecretForLog("a".repeat(16)), "aa****aa");
  assert.equal(L.maskSecretForLog("a".repeat(31)), "aa****aa");
  assert.equal(L.maskSecretForLog("a".repeat(32)), "aaaa****aaaa");
  // 幂等：已是掩码形态的原样返回
  assert.equal(L.maskSecretForLog("aa****aa"), "aa****aa");
  assert.equal(L.maskSecretForLog("aaaa****aaaa"), "aaaa****aaaa");
  assert.equal(L.maskSecretForLog("****"), "****");
});

test("maskKey 三档（面板用，规则冻结）", () => {
  assert.equal(L.maskKey(""), "");
  assert.equal(L.maskKey("abcd"), "****");
  assert.equal(L.maskKey("abcde"), "ab****de");
  assert.equal(L.maskKey("abcdefgh"), "ab****gh");
  assert.equal(L.maskKey("abcdefghi"), "abcd****fghi");
});

test("redactText：authorization 五种写法", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz012345";
  const cases = [
    [`authorization: Bearer ${secret}`, `authorization: Bearer abcd****2345`],
    [`"authorization": "Bearer ${secret}"`, `"authorization": "Bearer abcd****2345"`],
    [`authorization: Basic ${secret}`, "authorization: Basic ****"],
    [`authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE`, "authorization: AWS4-HMAC-SHA256 ****"],
    [`proxy-authorization=Digest ${secret}`, "proxy-authorization=Digest ****"],
  ];
  for (const [input, want] of cases) {
    const out = L.redactText(input);
    assert.equal(out, want, input);
    assert.ok(!out.includes(secret), `未打码：${input} → ${out}`);
  }
});

test("redactText：已知 Key 形态", () => {
  const sk = "sk-" + "a".repeat(24);
  const csk = "csk-" + "b".repeat(24);
  for (const key of [sk, csk, "gsk_" + "c".repeat(24), "xai-" + "d".repeat(24), "AIza" + "e".repeat(24)]) {
    const out = L.redactText(`上游返回：${key}`);
    assert.ok(!out.includes(key), `${key} 未打码 → ${out}`);
    assert.ok(out.includes("****"), out);
  }
});

test("redactText：URL userinfo / query 密钥 / k=v 形态 / 长不透明串", () => {
  const pw = "pw0123456789ab";
  const u = L.redactText(`https://user:${pw}@host/v1/messages`);
  assert.ok(!u.includes(pw), u);

  const q = L.redactText("GET /v1?api_key=supersecretvalue123&x=1");
  assert.ok(!q.includes("supersecretvalue123"), q);

  const kv = L.redactText("x-api-key=supersecretvalue123");
  assert.ok(!kv.includes("supersecretvalue123"), kv);

  const op = "z".repeat(80);
  const o = L.redactText(`access_token: ${op}`);
  assert.ok(!o.includes(op), o);
  assert.ok(o.includes("****"), o);
});

test("redactText：普通文本不动，短串原样返回", () => {
  assert.equal(L.redactText("hello world"), "hello world");
  assert.equal(L.redactText("短"), "短");
  assert.equal(L.redactText(""), "");
});
