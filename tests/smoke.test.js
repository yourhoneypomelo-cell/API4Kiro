"use strict";
// 骨架自检：证明 tests/build.js 的预编译与 vscode 桩都把测试链跑通了。
const test = require("node:test");
const assert = require("node:assert");

test("node:test 骨架可用", () => {
  assert.equal(1, 1);
});

test("编译产物能从 tests/.build 加载，且 vscode 桩在位", () => {
  const log = require("./.build/log.js");
  assert.equal(typeof log.redactText, "function");
  assert.equal(typeof log.maskKey, "function");
  const cfg = require("./.build/config.js");
  assert.equal(cfg.getPort(), 19810);
});
