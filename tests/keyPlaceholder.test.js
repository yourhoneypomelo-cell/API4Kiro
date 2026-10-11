"use strict";
// Key 占位标记的语义（AC-22 的读取侧基础）。
const test = require("node:test");
const assert = require("node:assert");

const K = require("./.build/keyPlaceholder.js");

test("keySlot / legacyKeySlot 命名", () => {
  assert.equal(K.keySlot("p1", "c1"), "key:p1/c1");
  assert.equal(K.keySlot("p1", "c2"), "key:p1/c2");
  assert.equal(K.legacyKeySlot("apiKey"), "key:@legacy/apiKey");
  assert.equal(K.legacyKeySlot("officialApiKey"), "key:@legacy/officialApiKey");
  // 与 OAuth 的裸键 / providerId/cN 键物理隔离
  assert.notEqual(K.keySlot("p1", "c1"), "p1");
  assert.notEqual(K.keySlot("p1", "c1"), "p1/c1");
});

test("isPlaceholder 只看值本身", () => {
  assert.equal(K.isPlaceholder(K.API_KEY_PLACEHOLDER), true);
  assert.equal(K.isPlaceholder(" " + K.API_KEY_PLACEHOLDER + " "), true);
  assert.equal(K.isPlaceholder("sk-abc"), false);
  assert.equal(K.isPlaceholder(""), false);
  assert.equal(K.isPlaceholder(undefined), false);
  assert.equal(K.isPlaceholder(null), false);
  assert.equal(K.isPlaceholder(123), false);
});

test("resolveKeyValue 四条分支，且不产生 fail-closed 计数", () => {
  const seen = [];
  K.registerKeyLookup((slot) => {
    seen.push(slot);
    return slot === "key:p1/c1" ? "真值" : undefined;
  });
  const before = K.lookupCount();
  // ① 占位 + 钥匙串有条目 ⇒ 真值
  assert.equal(K.resolveKeyValue(K.API_KEY_PLACEHOLDER, "key:p1/c1"), "真值");
  // ② 占位 + 钥匙串无条目 ⇒ 空串（AC-22）
  assert.equal(K.resolveKeyValue(K.API_KEY_PLACEHOLDER, "key:p1/c2"), "");
  // ③ 明文原样返回（含前后空白原样）
  assert.equal(K.resolveKeyValue("sk-明文", "key:p1/c1"), "sk-明文");
  assert.equal(K.resolveKeyValue(" sk-明文 ", "key:p1/c1"), " sk-明文 ");
  // ④ 空 ⇒ 空串
  assert.equal(K.resolveKeyValue("", "key:p1/c1"), "");
  assert.deepEqual(seen, ["key:p1/c1", "key:p1/c2"]);
  assert.equal(K.lookupCount() - before, 0, "注册了查找器就不该出现 fail-closed 回落");
  // 明文与空值都不查钥匙串
  assert.equal(seen.length, 2);
});

test("未注册查找器时占位 fail-closed 为空串并计数", () => {
  K._resetKeyLookupForTest();
  assert.equal(K.lookupCount(), 0);
  assert.equal(K.resolveKeyValue(K.API_KEY_PLACEHOLDER, "key:p1/c1"), "");
  assert.equal(K.lookupCount(), 1, "未注册就被解析是一次 fail-closed 回落");
  // 复位，避免污染其它用例的「计数为 0」断言
  K._resetKeyLookupForTest();
  assert.equal(K.lookupCount(), 0);
});

test("查找器本身返回非字符串 ⇒ 空串", () => {
  K._resetKeyLookupForTest();
  K.registerKeyLookup(() => undefined);
  assert.equal(K.resolveKeyValue(K.API_KEY_PLACEHOLDER, "key:p1/c1"), "");
  assert.equal(K.lookupCount(), 0);
  K._resetKeyLookupForTest();
});
