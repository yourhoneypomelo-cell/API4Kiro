"use strict";
// 「端点属于本插件」判定的形状矩阵（D4）。
const test = require("node:test");
const assert = require("node:assert");

const { endpointListPointsAt } = require("./.build/endpointOwnership.js");

const PORTS = [19810, 19811];
const ok = (port) => [{ region: "us-east-1", endpoint: `http://127.0.0.1:${port}` }];

test("每一项都指向本插件端口 ⇒ true", () => {
  assert.equal(endpointListPointsAt(ok(19810), PORTS), true);
  assert.equal(endpointListPointsAt(ok(19811), PORTS), true);
  assert.equal(endpointListPointsAt([...ok(19810), ...ok(19811)], PORTS), true);
});

test("空数组 / 非数组 ⇒ false", () => {
  for (const v of [[], undefined, null, "x", 42, {}, ok(19810)[0]]) {
    assert.equal(endpointListPointsAt(v, PORTS), false, JSON.stringify(v));
  }
});

test("别的端口 / https / 大小写 ⇒ false", () => {
  assert.equal(endpointListPointsAt(ok(19800), PORTS), false);
  assert.equal(endpointListPointsAt(ok(19801), PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: "https://127.0.0.1:19810" }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: "http://127.0.0.1:19810/" }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: "HTTP://127.0.0.1:19810" }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: "http://localhost:19810" }], PORTS), false);
});

test("混项 ⇒ false（不能因为有一项像我们的就整组清掉）", () => {
  assert.equal(endpointListPointsAt([...ok(19810), { endpoint: "http://127.0.0.1:19800" }], PORTS), false);
  assert.equal(endpointListPointsAt([...ok(19810), { region: "us-east-1" }], PORTS), false);
  assert.equal(endpointListPointsAt([...ok(19810), null], PORTS), false);
  assert.equal(endpointListPointsAt([...ok(19810), "http://127.0.0.1:19810"], PORTS), false);
});

test("endpoint 字段缺失 / 非字符串 ⇒ false", () => {
  assert.equal(endpointListPointsAt([{ region: "us-east-1" }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: 19810 }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: null }], PORTS), false);
  assert.equal(endpointListPointsAt([{ endpoint: undefined }], PORTS), false);
});

test("端口集合为空 ⇒ 恒 false", () => {
  assert.equal(endpointListPointsAt(ok(19810), []), false);
});
