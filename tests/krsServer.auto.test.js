"use strict";
// Auto 模型回落（src/krsServer.ts 的未提交改动，+67 行）：三个辅助函数的行为。
const test = require("node:test");
const assert = require("node:assert");

/** 一份最小可用的 provider 记录（走 providers.coerce 归一后取回来用）。 */
function rawProvider(over = {}) {
  return {
    id: "p1",
    name: "渠道一",
    protocol: "anthropic",
    baseUrl: "https://api.example.com",
    apiKey: "k1",
    enabled: true,
    ...over,
  };
}

function setSettings(settings) {
  globalThis.__a2kSettings = settings;
}

// 先设定好 settings 再加载 krsServer / providers：归一期间就会读 settings。
setSettings({ providers: [rawProvider()] });
const K = require("./.build/krsServer.js");
const providers = require("./.build/providers.js");
const modelStore = require("./.build/modelStore.js");

test("isAutoModelId：裸 id / 大小写 / 空白 / 渠道限定", () => {
  assert.equal(K.isAutoModelId("auto"), true);
  assert.equal(K.isAutoModelId("AUTO"), true);
  assert.equal(K.isAutoModelId("  Auto  "), true);
  assert.equal(K.isAutoModelId("auto@p1"), true, "带渠道限定的 auto 仍是 auto");
  assert.equal(K.isAutoModelId("auto-mode"), false);
  assert.equal(K.isAutoModelId(""), false);
  assert.equal(K.isAutoModelId("gpt-4o"), false);
});

test("supportsAutoModel：只有 Kiro 官方后端认 auto", () => {
  assert.equal(K.supportsAutoModel({ protocol: "kiro" }), true);
  assert.equal(K.supportsAutoModel({ protocol: "anthropic", oauthVendor: "kiro" }), true);
  assert.equal(K.supportsAutoModel({ protocol: "anthropic" }), false);
  assert.equal(K.supportsAutoModel({ protocol: "openai" }), false);
  assert.equal(K.supportsAutoModel({ protocol: "gemini" }), false);
});

test("autoFallbackModel 第一级：渠道自己的兜底模型", () => {
  const p = providers.getProviders()[0];
  assert.equal(K.autoFallbackModel({ ...p, defaultModel: "claude-x" }), "claude-x");
  assert.equal(K.autoFallbackModel({ ...p, defaultModel: "  auto  " }), undefined, "兜底模型是 auto 等于没兜底");
});

test("autoFallbackModel 第一级（旧双通道）：legacy-anthropic 回落全局默认模型", () => {
  const p = providers.getProviders()[0];
  setSettings({ providers: [rawProvider()], defaultModel: "全局默认" });
  assert.equal(K.autoFallbackModel({ ...p, id: "legacy-anthropic" }), "全局默认");
  assert.equal(K.autoFallbackModel({ ...p, id: "legacy-anthropic", defaultModel: "自己的" }), "自己的", "自己的兜底优先");
  setSettings({ providers: [rawProvider()] });
  assert.equal(K.autoFallbackModel({ ...p, id: "legacy-openai" }), undefined);
});

test("autoFallbackModel 第二级：该渠道勾选的第一个模型（跳过 auto）", () => {
  const p = providers.getProviders()[0];
  assert.equal(K.autoFallbackModel({ ...p, enabledModels: ["m1", "m2"] }), "m1");
  assert.equal(K.autoFallbackModel({ ...p, enabledModels: ["auto", "m2"] }), "m2");
  assert.equal(K.autoFallbackModel({ ...p, enabledModels: ["auto", "  "] }), undefined);
});

test("autoFallbackModel 第三级：合并缓存里该渠道的第一个模型", async () => {
  const p = providers.getProviders()[0];
  modelStore.__seedRaw(p, [{ id: "cached-model", name: "Cached" }]);
  const list = await modelStore.fetchAllModels();
  assert.ok(list.some((m) => m.id === "cached-model"), `合并缓存里应有缓存的模型：${JSON.stringify(list)}`);
  assert.equal(K.autoFallbackModel({ ...p }), "cached-model");
});

test("autoFallbackModel 都没有 ⇒ undefined", () => {
  const p = providers.getProviders()[0];
  assert.equal(K.autoFallbackModel({ ...p, id: "unknown-provider" }), undefined);
});
