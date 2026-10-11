"use strict";
// 卸载脚本的 settings.json 文本级编辑（AC-10 的夹具形态）。
const test = require("node:test");
const assert = require("node:assert");

const J = require("./.build/jsoncEdit.js");

const KEY = "codewhisperer.config.endpoints";
const LIST = '[{"region":"us-east-1","endpoint":"http://127.0.0.1:19810"}]';

test("readTopLevel 读得到值", () => {
  const text = `{\n  "a": 1,\n  // 注释\n  "${KEY}": ${LIST},\n  "b": true\n}\n`;
  assert.deepEqual(J.readTopLevel(text, KEY), [{ region: "us-east-1", endpoint: "http://127.0.0.1:19810" }]);
  assert.equal(J.readTopLevel(text, "nope"), undefined);
});

test("removeTopLevelProperty：有注释 + 尾逗号，删完仍能解析且注释键序都留住", () => {
  const text = [
    "{",
    "  // 顶部注释",
    '  "editor.fontSize": 14,',
    `  "${KEY}": ${LIST}, // 本插件写的`,
    '  "b": 2,',
    "}",
    "",
  ].join("\n");
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, true);
  assert.equal(J.readTopLevel(r.text, KEY), undefined);
  assert.equal(J.readTopLevel(r.text, "editor.fontSize"), 14);
  assert.equal(J.readTopLevel(r.text, "b"), 2);
  assert.ok(r.text.includes("// 顶部注释"), "注释要留住");
  assert.ok(r.text.includes("// 本插件写的") === false, "被删成员所在的那一行一并删掉");
});

test("removeTopLevelProperty：最后一个成员连带前一个逗号", () => {
  const text = `{\n  "a": 1,\n  "${KEY}": ${LIST}\n}\n`;
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, true);
  assert.deepEqual(J.readTopLevel(r.text, "a"), 1);
  assert.equal(J.readTopLevel(r.text, KEY), undefined);
});

test("removeTopLevelProperty：唯一成员", () => {
  const text = `{"${KEY}": ${LIST}}`;
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, true);
  assert.deepEqual(J.topLevelKeys(r.text), []);
  assert.equal(J.readTopLevel(r.text, KEY), undefined);
});

test("removeTopLevelProperty：无关键 ⇒ no-op", () => {
  const text = `{\n  "a": 1,\n  "b": 2\n}\n`;
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, false);
  assert.equal(r.text, text);
});

test("BOM + CRLF + 块注释 + 尾逗号", () => {
  const text = `\uFEFF{\r\n  /* 块注释 */\r\n  "a": 1,\r\n  "${KEY}": ${LIST},\r\n}\r\n`;
  assert.deepEqual(J.readTopLevel(text, "a"), 1);
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, true);
  assert.ok(r.text.startsWith("\uFEFF"));
  assert.equal(J.readTopLevel(r.text, "a"), 1);
});

test("单行压缩（无任何空白）", () => {
  const text = `{"a":1,"${KEY}":${LIST},"b":2}`;
  const r = J.removeTopLevelProperty(text, KEY);
  assert.equal(r.removed, true);
  assert.equal(r.text, '{"a":1,"b":2}');
});

test("解析失败 / 非对象顶层 ⇒ 原样返回", () => {
  for (const bad of ["", "{", '{"a":}', "[1,2]", '{"a":1} trailing', "null"]) {
    const r = J.removeTopLevelProperty(bad, KEY);
    assert.equal(r.removed, false, `不该删：${JSON.stringify(bad)}`);
    assert.equal(r.text, bad);
  }
});

test("嵌套对象 / 数组里的同名字符串不会被误当顶层键", () => {
  const text = `{"outer":{"${KEY}":"内层"},"b":2}`;
  const r = J.removeTopLevelProperty(text, "outer");
  assert.equal(r.removed, true);
  assert.equal(r.text, '{"b":2}');
  assert.deepEqual(J.readTopLevel(`{"outer":{"${KEY}":"内层"}}`, KEY), undefined);
});

test("AC-10 三种键的混项形态：只删本插件那一项，其余字节不动", () => {
  // 混有其它端点（19800/19801、https 中转）时，值不是「每一项都指向本插件端口」，
  // 判定在调用方（endpointOwnership）；本模块只保证「删指定的那个键、别的一个字节不动」。
  const other = '[{"region":"us-east-1","endpoint":"http://127.0.0.1:19800"}]';
  const text = `{\n  "codewhisperer.config.krsEndpoints": ${LIST},\n  "codewhisperer.config.cpsEndpoints": ${LIST},\n  "codewhisperer.config.endpoints": ${other},\n  "x": 1\n}\n`;
  const a = J.removeTopLevelProperty(text, "codewhisperer.config.krsEndpoints");
  const b = J.removeTopLevelProperty(a.text, "codewhisperer.config.cpsEndpoints");
  assert.equal(a.removed, true);
  assert.equal(b.removed, true);
  assert.deepEqual(J.readTopLevel(b.text, "codewhisperer.config.endpoints"), [{ region: "us-east-1", endpoint: "http://127.0.0.1:19800" }]);
  assert.equal(J.readTopLevel(b.text, "x"), 1);
  assert.equal(J.topLevelKeys(b.text).length, 2);
});
