"use strict";
// tokenStore 的「写入落点」判定、穿透存储层的落盘确认、删 provider 覆盖 key: 命名空间。
const test = require("node:test");
const assert = require("node:assert");

const { TokenStore, TokenStoreLoadError } = require("./.build/oauth/tokenStore.js");

const SECRET_KEY = "api4kiro.oauthTokens.v1";

/**
 * 假 ExtensionContext。故障注入点刻意放在**存储层**（`store()` 抛错 / 静默不生效 / `get()` 抛错），
 * 不注入假 store 的 flush——真实 `TokenStore.flush()` 永不 reject，注入它测不出任何东西。
 */
function fakeContext(opts = {}) {
  const blob = new Map();
  const state = new Map();
  const secrets = opts.noSecrets
    ? undefined
    : {
        async get(k) {
          if (opts.getThrows) {
            throw new Error("keychain read boom");
          }
          return blob.get(k);
        },
        async store(k, v) {
          if (opts.storeThrows) {
            throw new Error("keychain write boom");
          }
          if (!opts.silentStore) {
            blob.set(k, v);
          }
        },
        async delete(k) {
          blob.delete(k);
        },
        onDidChange() {
          return { dispose() {} };
        },
      };
  return {
    blob,
    state,
    ctx: {
      secrets,
      globalState: {
        get: (k) => state.get(k),
        update: async (k, v) => (v === undefined ? state.delete(k) : state.set(k, v)),
      },
      subscriptions: [],
    },
  };
}

async function freshStore(opts = {}) {
  const h = fakeContext(opts);
  const store = new TokenStore();
  await store.init(h.ctx);
  return { ...h, store };
}

function storedTable(blob) {
  const text = blob.get(SECRET_KEY);
  return text ? JSON.parse(text) : undefined;
}

test("backend：无 SecretStorage ⇒ state；有 SecretStorage 但还没有 blob ⇒ secrets", async () => {
  const noSec = await freshStore({ noSecrets: true });
  assert.equal(noSec.store.backend(), "state");

  // HIGH-2 的回归点：只用 API Key、从没登录过第三方账号的用户钥匙串里没有 blob，
  // 「上次读到了什么」是 none，但写入落点是 secrets，必须判成可迁移。
  const sec = await freshStore();
  assert.equal(sec.blob.size, 0, "夹具前提：钥匙串里还没有 blob");
  assert.equal(sec.store.backend(), "secrets");
});

test("全部成功：resolve，且存储层能读到新值", async () => {
  const { store, blob } = await freshStore();
  store.setToken("key:p1/c1", { accessToken: "sk-abc", updatedAt: 1 });
  await store.flushVerified({ "key:p1/c1": "sk-abc" });
  assert.equal(storedTable(blob)["key:p1/c1"].accessToken, "sk-abc");
  assert.equal(storedTable(blob)["$meta"].stamp.length > 0, true);
});

test("store() 抛错 ⇒ reject TokenStoreLoadError", async () => {
  const { store } = await freshStore({ storeThrows: true });
  store.setToken("key:p1/c1", { accessToken: "sk-abc", updatedAt: 1 });
  await assert.rejects(
    () => store.flushVerified({ "key:p1/c1": "sk-abc" }),
    (e) => e instanceof TokenStoreLoadError && e.code === "keychain_read_failed"
  );
});

test("store() 静默不生效（get() 仍返回旧值）⇒ reject", async () => {
  // 先写入一次真实值，再让后续写入静默失败：内存视图里是新值，存储层还是旧值。
  const h = await freshStore();
  h.store.setToken("key:p1/c1", { accessToken: "old", updatedAt: 1 });
  await h.store.flushVerified({ "key:p1/c1": "old" });

  const silent = await freshStore({ silentStore: true });
  silent.store.setToken("key:p1/c1", { accessToken: "new", updatedAt: 2 });
  assert.equal(silent.store.getToken("key:p1/c1").accessToken, "new", "夹具前提：内存视图同步就有新值");
  await assert.rejects(() => silent.store.flushVerified({ "key:p1/c1": "new" }), (e) => e instanceof TokenStoreLoadError);
});

test("get() 抛错 ⇒ reject（且没有积压改动时也拒绝）", async () => {
  const h = await freshStore();
  h.store.setToken("key:p1/c1", { accessToken: "sk-abc", updatedAt: 1 });
  await h.store.flushVerified({ "key:p1/c1": "sk-abc" });

  const broken = await freshStore({ getThrows: true });
  // 无 pending：纯粹靠穿透存储层的读来确认，读失败必须 reject
  await assert.rejects(() => broken.store.flushVerified({ "key:p1/c1": "sk-abc" }), (e) => e instanceof TokenStoreLoadError);
});

test("expected 与实际不一致 ⇒ reject", async () => {
  const { store } = await freshStore();
  store.setToken("key:p1/c1", { accessToken: "actual", updatedAt: 1 });
  await assert.rejects(() => store.flushVerified({ "key:p1/c1": "expected" }), (e) => e instanceof TokenStoreLoadError);
  // 槽位根本不存在也算不一致
  await assert.rejects(() => store.flushVerified({ "key:p1/c2": "whatever" }), (e) => e instanceof TokenStoreLoadError);
});

test("后端是 state（无 secrets）时写入不落钥匙串 ⇒ 穿透校验拒绝", async () => {
  const h = await freshStore({ noSecrets: true });
  h.store.setToken("key:p1/c1", { accessToken: "sk-abc", updatedAt: 1 });
  await assert.rejects(() => h.store.flushVerified({ "key:p1/c1": "sk-abc" }), (e) => e instanceof TokenStoreLoadError);
  assert.ok(h.state.get("oauthTokens.v1"), "无 secrets 时会静默改道 globalState，所以必须有后端闸");
});

test("deleteProviderTokens 覆盖 key: 命名空间，但不碰同前缀的别家 provider", async () => {
  const { store } = await freshStore();
  store.setToken("p1", { accessToken: "oauth-c1", updatedAt: 1 });
  store.setToken("p1/c2", { accessToken: "oauth-c2", updatedAt: 1 });
  store.setToken("key:p1/c1", { accessToken: "k1", updatedAt: 1 });
  store.setToken("key:p1/c2", { accessToken: "k2", updatedAt: 1 });
  store.setToken("key:p1x/c1", { accessToken: "other", updatedAt: 1 });
  store.setToken("p2/c1", { accessToken: "keep", updatedAt: 1 });

  store.deleteProviderTokens("p1");
  await store.flush();

  for (const gone of ["p1", "p1/c2", "key:p1/c1", "key:p1/c2"]) {
    assert.equal(store.getToken(gone), undefined, `${gone} 应被删`);
  }
  assert.equal(store.getToken("key:p1x/c1").accessToken, "other", "同前缀的别家 provider 不能误删");
  assert.equal(store.getToken("p2/c1").accessToken, "keep");
});

test("deleteProviderTokens：没有匹配项时不改动、不落盘", async () => {
  const { store, blob } = await freshStore();
  const before = blob.size;
  store.deleteProviderTokens("nobody");
  await store.flush();
  assert.equal(blob.size, before);
});
