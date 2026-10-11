"use strict";
// 单测共用的夹具：假扩展上下文（SecretStorage + globalState）、假设置对象、真实模块的装载。
// 约定：`init()` 之后 `providers.saveProviders` / `getProviders` / `apiKeys.migrateApiKeysOnce`
// 都是**真实实现**在跑，只有宿主 API 是桩。
const path = require("path");

const BUILD = path.join(__dirname, ".build");

/** 假扩展上下文。`failGet` / `failStore` / `silentStore` 是存储层的故障注入点。 */
function fakeContext(opts = {}) {
  const blob = new Map();
  const state = new Map(Object.entries(opts.globalStateEntries || {}));
  const secrets = opts.noSecrets
    ? undefined
    : {
        async get(k) {
          if (opts.failGet) {
            throw new Error("keychain read boom");
          }
          return blob.get(k);
        },
        async store(k, v) {
          if (opts.failStore) {
            throw new Error("keychain write boom");
          }
          if (opts.silentStore) {
            return;
          }
          blob.set(k, v);
        },
        async delete(k) {
          blob.delete(k);
        },
        onDidChange() {
          return { dispose() {} };
        },
      };
  const ctx = {
    secrets,
    globalState: {
      get: (k) => state.get(k),
      update: async (k, v) => (v === undefined ? state.delete(k) : state.set(k, v)),
    },
    subscriptions: [],
  };
  return { ctx, blob, state, opts };
}

/** 钥匙串 blob 里的整表（含 `$meta`）。 */
function table(blob, key = "api4kiro.oauthTokens.v1") {
  const text = blob.get(key);
  return text ? JSON.parse(text) : undefined;
}

/** 读某个槽位的明文（拿不到就返回 undefined）。 */
function slotValue(blob, slot) {
  return table(blob)?.[slot]?.accessToken;
}

/**
 * 装载真实模块。`settings` 会整体替换 `globalThis.__a2kSettings`（vscode 桩的设置源）。
 * 返回的 `init()` 顺序与 activate 一致：initTokenStore → initConfig → initApiKeySettings。
 */
function boot(opts = {}) {
  globalThis.__a2kSettings = { ...(opts.settings || {}) };
  const h = fakeContext(opts);
  const tokenStore = require(path.join(BUILD, "oauth/tokenStore.js"));
  const config = require(path.join(BUILD, "config.js"));
  const providers = require(path.join(BUILD, "providers.js"));
  const apiKeys = require(path.join(BUILD, "apiKeys.js"));
  const keyPlaceholder = require(path.join(BUILD, "keyPlaceholder.js"));
  const settings = () => globalThis.__a2kSettings;
  return {
    ...h,
    tokenStore,
    config,
    providers,
    apiKeys,
    keyPlaceholder,
    settings,
    async init() {
      await tokenStore.initTokenStore(h.ctx);
      config.initConfig(h.ctx);
      providers.initApiKeySettings();
      return this;
    },
  };
}

/** 造一条 provider 原文（写进 settings 用）。 */
function rawProvider(over = {}) {
  return {
    id: "p1",
    name: "渠道一",
    protocol: "anthropic",
    baseUrl: "https://api.example.com",
    apiKey: "sk-plain-1",
    enabled: true,
    ...over,
  };
}

module.exports = { BUILD, fakeContext, table, slotValue, boot, rawProvider };
