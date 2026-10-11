"use strict";
// API Key 迁入系统钥匙串：读取侧注水、写入漏斗、失败回退、孤儿回收、迁移的幂等与并发。
const test = require("node:test");
const assert = require("node:assert");

const { boot, rawProvider, slotValue } = require("./helpers.js");

const PLACEHOLDER = "__API4KIRO_KEYCHAIN__";

// ---------------------------------------------------------------------------- 单元级（假端口的纯函数）

/** 假端口：只服务 expectedSlots / withPlaceholders / mergeForWrite 的单元用例。 */
function fakePort(over = {}) {
  const credsOf = (p) =>
    p.credentials && p.credentials.length > 0
      ? p.credentials
      : [{ id: "c1", apiKey: p.auth === "oauth" ? undefined : p.apiKey || undefined, priority: 0, enabled: true }];
  return {
    readProviders: () => [],
    readProviderList: () => [],
    slotIndexFor: () => new Map(),
    credentialsOf: credsOf,
    writeProviders: async () => ({ settingsOk: true }),
    readLegacyRaw: () => "",
    writeLegacy: async () => ({ settingsOk: true }),
    readFallback: () => undefined,
    writeFallback: async () => ({ settingsOk: true }),
    ...over,
  };
}

function providerObj(over = {}) {
  return {
    id: "p1",
    name: "P1",
    protocol: "anthropic",
    baseUrl: "https://x",
    apiKey: "A",
    enabled: true,
    credentials: [
      { id: "c1", apiKey: "A", priority: 0, enabled: true },
      { id: "c2", apiKey: "B", priority: 1, enabled: true },
    ],
    ...over,
  };
}

test("expectedSlots：清除 Key ⇒ 空集；OAuth 不进；占位不算明文", () => {
  const { apiKeys } = boot();
  const port = fakePort();
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj()])], ["key:p1/c1", "key:p1/c2"]);
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj({ apiKey: "", credentials: [{ id: "c1", priority: 0, enabled: true }] })])], []);
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj({ auth: "oauth" })])], []);
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj({ apiKey: PLACEHOLDER, credentials: [{ id: "c1", apiKey: PLACEHOLDER, priority: 0, enabled: true }] })])], []);
  // 只有 apiKey 没有 credentials：合成一条 c1
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj({ credentials: undefined })])], ["key:p1/c1"]);
  // providerId 保留前缀：不进集合
  assert.deepEqual([...apiKeys.expectedSlots(port, [providerObj({ id: "key:weird" })])], []);
});

test("withPlaceholders：非空 ⇒ 占位，空 ⇒ 空串，OAuth 原样，且深拷贝", () => {
  const { apiKeys } = boot();
  const port = fakePort();
  const src = providerObj({ credentials: [{ id: "c1", apiKey: "A", priority: 0, enabled: true }, { id: "c2", apiKey: "", priority: 1, enabled: true }] });
  const out = apiKeys.withPlaceholders(port, [src]);
  assert.equal(out[0].apiKey, PLACEHOLDER);
  assert.deepEqual(out[0].credentials.map((c) => c.apiKey), [PLACEHOLDER, ""]);
  assert.notEqual(out[0], src, "必须是深拷贝");
  assert.notEqual(out[0].credentials, src.credentials);
  assert.equal(src.apiKey, "A", "原文不能被改");
  const oauth = apiKeys.withPlaceholders(port, [providerObj({ auth: "oauth", apiKey: "", credentials: undefined })]);
  assert.equal(oauth[0].apiKey, "");
});

test("mergeForWrite 五类夹具", () => {
  const { apiKeys } = boot();
  const port = fakePort();
  const list = [providerObj()];
  const previousRaw = [rawProvider({ apiKey: "A", credentials: [{ id: "c1", apiKey: "A", priority: 0 }, { id: "c2", apiKey: "B", priority: 1 }] })];
  // ① 无失败槽位 ⇒ 与 withPlaceholders 逐字相同
  const a = apiKeys.mergeForWrite(port, list, previousRaw, new Set());
  assert.deepEqual(a, apiKeys.withPlaceholders(port, list));
  // ② 有失败槽位且原文能定位到同 id、auth 未变 ⇒ Key 字段与原文逐字相同，metadata 取本次值
  const renamed = [{ ...providerObj(), name: "改名了" }];
  const b = apiKeys.mergeForWrite(port, renamed, previousRaw, new Set(["key:p1/c2"]));
  assert.equal(b[0].name, "改名了", "metadata 取本次值");
  assert.equal(b[0].apiKey, "A");
  assert.deepEqual(b[0].credentials.map((c) => c.apiKey), ["A", "B"], "Key 字段整体回退到原文");
  // ③ 原文定位不到 ⇒ 失败槽位写空串、成功槽位写占位
  const c = apiKeys.mergeForWrite(port, list, [], new Set(["key:p1/c2"]));
  assert.equal(c[0].apiKey, PLACEHOLDER);
  assert.deepEqual(c[0].credentials.map((x) => x.apiKey), [PLACEHOLDER, ""]);
  // ④ auth 变更（原文是 OAuth、这次变 Key 类）⇒ 不拿原文回退，失败槽位写空串
  const wasOauth = [rawProvider({ apiKey: "", auth: "oauth", oauthVendor: "kimi", credentials: undefined })];
  const d = apiKeys.mergeForWrite(port, list, wasOauth, new Set(["key:p1/c2"]));
  assert.deepEqual(d[0].credentials.map((x) => x.apiKey), [PLACEHOLDER, ""]);
  // OAuth 类 provider 的 key 字段一律不动（它没有 key 槽位，回退反而会把明文 key 复活到 OAuth provider 上）
  const d2 = apiKeys.mergeForWrite(port, [{ ...providerObj(), auth: "oauth" }], previousRaw, new Set(["key:p1/c2"]));
  assert.deepEqual(d2[0].credentials.map((x) => x.apiKey), ["A", "B"]);
  // ⑤ I15：原文 [c1=A, c2=B] → 内存删 c1（c2 改名成 c1）→ 保存失败 ⇒ 不得把已删的 A 写回
  const afterDelete = [providerObj({ apiKey: "B", credentials: [{ id: "c1", apiKey: "B", priority: 0, enabled: true }] })];
  const e = apiKeys.mergeForWrite(port, afterDelete, previousRaw, new Set(["key:p1/c1"]));
  assert.deepEqual(e[0].credentials.map((x) => x.apiKey), ["A", "B"], "落盘 Key 字段与原文逐字相同");
  assert.equal(e[0].apiKey, "A");
  assert.equal(e[0].credentials.length, 2, "不得留下半应用状态");
  // 下一次读 c1 仍是 A
  assert.equal(e[0].credentials[0].apiKey, "A");
});

test("slotIndexFor 自洽：键集合 == expectedSlots(归一列表)，每槽 raw 逐字等于原文", () => {
  const h = boot();
  const raw = [
    { id: "p1", protocol: "anthropic", baseUrl: "https://a", apiKey: "A", credentials: [{ id: "c1", apiKey: "A", priority: 0 }, { id: "c2", apiKey: "B", priority: 1 }] },
    { id: "p2", protocol: "openai", baseUrl: "https://b", apiKey: "C" },
    { id: "p3", protocol: "anthropic", baseUrl: "https://c", auth: "oauth", oauthVendor: "kimi" },
  ];
  globalThis.__a2kSettings = { providers: raw };
  const idx = h.providers.buildRawSlotIndex(raw);
  const list = h.providers.getProviders();
  const port = { credentialsOf: (p) => h.providers.credentialsOf(p) };
  assert.deepEqual([...idx.keys()].sort(), [...h.apiKeys.expectedSlots(port, list)].sort());
  assert.equal(idx.get("key:p1/c1").raw, "A");
  assert.equal(idx.get("key:p1/c2").raw, "B");
  assert.equal(idx.get("key:p2/c1").raw, "C");
  assert.equal(idx.get("key:p1/c2").providerId, "p1");
  assert.equal(idx.get("key:p1/c2").credentialId, "c2");
});

// ---------------------------------------------------------------------------- 集成级（真实实现 + 桩宿主）

test("A8 / AC-18：注水后读取入口与迁移前逐字一致；迁移幂等", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })], apiKey: "legacy-plain" } }).init();
  const before = { providers: h.providers.getProviders()[0].apiKey, kiro: h.config.getKiroApiKey() };
  assert.equal(before.providers, "sk-plain-1");
  assert.equal(before.kiro, "legacy-plain");

  const r = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(r.migrated, 2, `迁移应写入 2 个槽位：${JSON.stringify(r)}`);
  assert.equal(slotValue(h.blob, "key:p1/c1"), "sk-plain-1");
  assert.equal(slotValue(h.blob, "key:@legacy/apiKey"), "legacy-plain");
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER, "settings 里只留占位");
  assert.equal(h.settings().apiKey, PLACEHOLDER);

  // 注水：读到的值必须与迁移前逐字一致
  assert.equal(h.providers.getProviders()[0].apiKey, before.providers);
  assert.equal(h.config.getKiroApiKey(), before.kiro);
  // 再迁移一次是 no-op（占位不再被收集）
  assert.equal((await h.apiKeys.migrateApiKeysOnce()).migrated, 0);
});

test("AC-23（一）：明文写在 providers[0].apiKey 上，不得被占位覆盖", async () => {
  const h = await boot({
    settings: { providers: [rawProvider({ apiKey: "new-plain", credentials: [{ id: "c1", apiKey: PLACEHOLDER, priority: 0, enabled: true }] })] },
  }).init();
  h.tokenStore.setToken("key:p1/c1", { accessToken: "old-plain", updatedAt: 1 });
  await h.tokenStore.flushTokensOrThrow({ "key:p1/c1": "old-plain" });

  const p = h.providers.getProviders()[0];
  assert.equal(p.apiKey, "new-plain", "用户在旧字段上手填的新明文必须胜出");
  assert.equal(p.credentials[0].apiKey, "new-plain");
});

test("AC-23（二）：明文写在 credentials[0].apiKey 上，不得被占位覆盖", async () => {
  const h = await boot({
    settings: { providers: [rawProvider({ apiKey: PLACEHOLDER, credentials: [{ id: "c1", apiKey: "new-plain", priority: 0, enabled: true }] })] },
  }).init();
  h.tokenStore.setToken("key:p1/c1", { accessToken: "old-plain", updatedAt: 1 });
  await h.tokenStore.flushTokensOrThrow({ "key:p1/c1": "old-plain" });

  const p = h.providers.getProviders()[0];
  assert.equal(p.apiKey, "new-plain", "首条凭证上的明文必须胜出（旧值只在钥匙串里）");
  assert.equal(p.credentials[0].apiKey, "new-plain");
});

test("AC-22：占位 + 钥匙串无条目 ⇒ 空串（不会把占位当 key）", async () => {
  const h = await boot({
    settings: { providers: [rawProvider({ apiKey: PLACEHOLDER, credentials: [{ id: "c1", apiKey: PLACEHOLDER, priority: 0, enabled: true }] })] },
  }).init();
  const p = h.providers.getProviders()[0];
  assert.equal(p.apiKey, "");
  assert.equal(p.credentials[0].apiKey, undefined);
});

test("AC-24：saveProviders 后 settings 里没有非占位明文，钥匙串里有", async () => {
  const h = await boot({ settings: { providers: [] } }).init();
  const fresh = { ...providerObj({ id: "p9", apiKey: "sk-secret-9" }), credentials: undefined };
  const r = await h.providers.saveProviders([fresh]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keySlotsFailed, []);
  assert.equal(slotValue(h.blob, "key:p9/c1"), "sk-secret-9");
  assert.equal(h.settings().providers.find((x) => x.id === "p9").apiKey, PLACEHOLDER);
  assert.ok(!JSON.stringify(h.settings().providers).includes("sk-secret-9"), "settings 里不能残留明文");
});

test("I14：钥匙串读失败时 saveProviders 不 reject、metadata 已落盘、keySlotsFailed 非空", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] } }).init();
  const list = h.providers.getProviders(); // 面板手里的那份（此时钥匙串还正常）
  h.opts.failGet = true;
  await h.tokenStore.initTokenStore(h.ctx);
  assert.ok(h.tokenStore.tokenStoreLoadError(), "夹具前提：loadError 非空");

  const r = await h.providers.saveProviders([{ ...list[0], name: "改了名字" }]);
  assert.equal(r.ok, true, "settings 写入本身应成功");
  assert.ok(r.keySlotsFailed.length > 0, `应报出失败槽位：${JSON.stringify(r)}`);
  assert.equal(h.settings().providers[0].name, "改了名字", "metadata 必须落盘");
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1", "失败槽位的 Key 取原文，明文不得丢");
});

test("§8 边界 16b：只改 metadata 且保存失败时 Key 字段取原文", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] } }).init();
  const list = h.providers.getProviders();
  h.opts.failGet = true;
  await h.tokenStore.initTokenStore(h.ctx);
  const r = await h.providers.saveProviders([{ ...list[0], enabled: false }]);
  assert.equal(r.ok, true);
  assert.equal(h.settings().providers[0].enabled, false);
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1");
});

test("HIGH-1：迁移完成（settings 只剩占位）+ 钥匙串读失败 ⇒ 占位逐字保留、如实报失败、不给成功提示", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] } }).init();
  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 1, JSON.stringify(m));
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER, "夹具前提：迁移完成后 settings 里只剩占位");
  assert.equal(slotValue(h.blob, "key:p1/c1"), "sk-plain-1");

  // 下一次激活时钥匙串读不出来
  h.opts.failGet = true;
  await h.tokenStore.initTokenStore(h.ctx);
  assert.ok(h.tokenStore.tokenStoreLoadError(), "夹具前提：loadError 非空");
  const list = h.providers.getProviders();
  assert.equal(list[0].apiKey, "", "读失败期间面板看到的 key 是空的（占位解析不到真值）");

  const r = await h.providers.saveProviders([{ ...list[0], name: "改了名字" }]);
  assert.equal(r.ok, true, "settings 写入本身应成功");
  // ① settings 里的占位仍逐字保留（不得被抹成空串）
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER, JSON.stringify(h.settings().providers[0]));
  // ② 钥匙串条目仍被引用（不是孤儿）
  assert.equal(slotValue(h.blob, "key:p1/c1"), "sk-plain-1");
  // ③ 如实报告失败槽位
  assert.deepEqual(r.keySlotsFailed, ["key:p1/c1"], JSON.stringify(r));
  // ④ 组合语义：sidebar 的成功提示分支是 `ok && keySlotsFailed.length === 0`，这里必须走不到
  assert.ok(!(r.ok && (r.keySlotsFailed || []).length === 0), "不得给出「已保存」成功提示");
  // metadata 照常落盘
  assert.equal(h.settings().providers[0].name, "改了名字");

  // 恢复后（重载成功）渠道恢复可用，占位继续解析到真值
  h.opts.failGet = false;
  await h.tokenStore.reloadTokens();
  assert.equal(h.tokenStore.tokenStoreLoadError(), undefined);
  assert.equal(h.providers.getProviders()[0].apiKey, "sk-plain-1");
  assert.equal(h.providers.isProviderUsable(h.providers.getProviders()[0]), true);
});

test("MEDIUM-3：读失败 ⇒ 重载成功 ⇒ loadError 清掉、key 类渠道恢复可用（多凭证 + 撤销场景一起验）", async () => {
  const h = await boot({
    settings: {
      providers: [
        rawProvider({
          apiKey: "A",
          credentials: [
            { id: "c1", apiKey: "A", priority: 0, enabled: true },
            { id: "c2", apiKey: "B", priority: 1, enabled: true },
          ],
        }),
      ],
    },
  }).init();
  await h.apiKeys.migrateApiKeysOnce();
  assert.equal(slotValue(h.blob, "key:p1/c2"), "B");

  h.opts.failGet = true;
  await h.tokenStore.initTokenStore(h.ctx);
  assert.equal(h.tokenStore.tokenStoreLoadError().code, "keychain_read_failed");
  const dark = h.providers.getProviders()[0];
  assert.equal(dark.apiKey, "");
  assert.ok(!h.providers.isProviderUsable(dark), "读失败期间 key 类渠道不可用");
  assert.equal(h.providers.providerMissing(dark), "缺少 API Key");

  h.opts.failGet = false;
  await h.tokenStore.reloadTokens();
  assert.equal(h.tokenStore.tokenStoreLoadError(), undefined, "重载成功后 loadError 必须清掉");
  const lit = h.providers.getProviders()[0];
  assert.equal(lit.apiKey, "A");
  assert.deepEqual(lit.credentials.map((c) => c.apiKey), ["A", "B"], "两把 key 都回来了");
  assert.equal(h.providers.isProviderUsable(lit), true);
});

test("HIGH-1 反向：钥匙串可读时「清除 Key」仍然生效（占位 → 空串是用户意图，不得被保住）", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "A" })] } }).init();
  await h.providers.saveProviders(h.providers.getProviders());
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER);
  const list = h.providers.getProviders();
  list[0].apiKey = "";
  list[0].credentials = undefined;
  const r = await h.providers.saveProviders(list);
  assert.deepEqual(r.keySlotsFailed, []);
  assert.equal(h.settings().providers[0].apiKey, "", "钥匙串可读时清 Key 必须能落盘成空");
  assert.equal(slotValue(h.blob, "key:p1/c1"), undefined, "槽位被回收");
});

test("后端闸：假上下文没有 secrets ⇒ 不写钥匙串、Key 处理全部报失败、明文保留", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] }, noSecrets: true }).init();
  const r = await h.providers.saveProviders(h.providers.getProviders());
  assert.deepEqual(r.keySlotsFailed, ["key:p1/c1"]);
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1", "明文必须保留（不得被占位覆盖）");
  assert.equal(h.state.get("oauthTokens.v1"), undefined, "也不能以明文形式改道落进插件本地存储");

  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 0);
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1");
});

test("store() 抛错：Key 变更未生效、明文保留；恢复后下一次激活重试成功", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] }, failStore: true }).init();
  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 0);
  assert.ok(m.failed.length > 0);
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1");
  h.opts.failStore = false;
  const m2 = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m2.migrated, 1);
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER);
});

test("store() 静默不生效（回读不一致）⇒ 不得写占位", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] }, silentStore: true }).init();
  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 0);
  assert.equal(h.settings().providers[0].apiKey, "sk-plain-1", "钥匙串没写成功就不能把明文换成占位");
});

test("AC-20 事件序列：清明文发生在「写入 + 穿透回读」之后", async () => {
  const events = [];
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] } }).init();
  const origStore = h.ctx.secrets.store.bind(h.ctx.secrets);
  const origGet = h.ctx.secrets.get.bind(h.ctx.secrets);
  h.ctx.secrets.store = async (k, v) => {
    events.push("keychain.store");
    return origStore(k, v);
  };
  h.ctx.secrets.get = async (k) => {
    events.push("keychain.get");
    return origGet(k);
  };
  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 1);
  const storeAt = events.indexOf("keychain.store");
  assert.ok(storeAt >= 0, `应先写钥匙串：${events.join(",")}`);
  assert.ok(events.slice(storeAt + 1).includes("keychain.get"), `写完必须回读确认：${events.join(",")}`);
  assert.equal(h.settings().providers[0].apiKey, PLACEHOLDER);
});

test("AC-21 幂等 + 并发：重复运行 no-op；两个窗口共用同一钥匙串不丢 key", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-plain-1" })] } }).init();
  assert.equal((await h.apiKeys.migrateApiKeysOnce()).migrated, 1);
  assert.equal((await h.apiKeys.migrateApiKeysOnce()).migrated, 0, "第二次必须 no-op");

  const { TokenStore } = h.tokenStore;
  const a = new TokenStore();
  const b = new TokenStore();
  await a.init(h.ctx);
  await b.init(h.ctx);
  a.setToken("key:pa/c1", { accessToken: "A", updatedAt: 1 });
  b.setToken("key:pb/c1", { accessToken: "B", updatedAt: 1 });
  await Promise.all([a.flushVerified({ "key:pa/c1": "A" }), b.flushVerified({ "key:pb/c1": "B" })]);
  assert.equal(slotValue(h.blob, "key:pa/c1"), "A");
  assert.equal(slotValue(h.blob, "key:pb/c1"), "B");
});

test("AC-25 生命周期：删凭证 / 删 provider 之后没有孤儿槽位", async () => {
  const h = await boot({
    settings: {
      providers: [
        rawProvider({ id: "p1", apiKey: "A", credentials: [{ id: "c1", apiKey: "A", priority: 0, enabled: true }, { id: "c2", apiKey: "B", priority: 1, enabled: true }] }),
      ],
    },
  }).init();
  await h.providers.saveProviders(h.providers.getProviders());
  assert.equal(slotValue(h.blob, "key:p1/c1"), "A");
  assert.equal(slotValue(h.blob, "key:p1/c2"), "B");

  // 删掉 c1（只剩 c2）
  const list = h.providers.getProviders();
  list[0].credentials = [list[0].credentials[1]];
  list[0].apiKey = "B";
  await h.providers.saveProviders(list);
  assert.equal(slotValue(h.blob, "key:p1/c1"), undefined, "不再期望的槽位要回收");
  assert.equal(slotValue(h.blob, "key:p1/c2"), "B");

  // 删整个 provider：与面板同一条链（persist 先落盘，随后 deleteProviderTokens 清掉该 provider 的全部槽位）
  await h.providers.saveProviders([]);
  h.tokenStore.deleteProviderTokens("p1");
  await h.tokenStore.flushTokens();
  assert.equal(slotValue(h.blob, "key:p1/c2"), undefined);
  assert.equal(slotValue(h.blob, "key:p1/c1"), undefined);
});

test("「清除 Key」：槽位被删、下次读为空、不复活", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "A" })] } }).init();
  await h.providers.saveProviders(h.providers.getProviders());
  assert.equal(slotValue(h.blob, "key:p1/c1"), "A");

  const list = h.providers.getProviders();
  list[0].apiKey = "";
  list[0].credentials = undefined;
  await h.providers.saveProviders(list);
  assert.equal(slotValue(h.blob, "key:p1/c1"), undefined);
  assert.equal(h.providers.getProviders()[0].apiKey, "");
});

test("reconcile：删除后的落盘确认失败 ⇒ 记 warn、不抛（I14）", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "A" })] } }).init();
  await h.providers.saveProviders(h.providers.getProviders());
  const warns = [];
  const { ApiKeyVault } = h.apiKeys;
  const list = h.providers.getProviders();
  list[0].apiKey = "";
  list[0].credentials = undefined;
  // 钥匙串读失败：删除留在内存视图里，穿透确认必然失败
  h.opts.failGet = true;
  await h.tokenStore.reloadTokens();
  const vault = new ApiKeyVault({ port: h.providers._keySettingsPortForTest(), log: { warn: (...a) => warns.push(a.join(" ")) } });
  const failed = await vault.reconcile(list);
  assert.ok(warns.some((w) => w.includes("api key 回收")), `应有回收相关的 warn：${warns.join(" | ")}`);
  assert.deepEqual(failed, []);
});

test("I13：全占位列表 ⇒ 跳过 reconcile、槽位仍在、有 warn", async () => {
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "A" })] } }).init();
  await h.providers.saveProviders(h.providers.getProviders());
  const warns = [];
  const { ApiKeyVault } = h.apiKeys;
  const vault = new ApiKeyVault({ port: h.providers._keySettingsPortForTest(), log: { warn: (...a) => warns.push(a.join(" ")) } });
  const allPlaceholder = [providerObj({ apiKey: PLACEHOLDER, credentials: [{ id: "c1", apiKey: PLACEHOLDER, priority: 0, enabled: true }] })];
  const failed = await vault.reconcile(allPlaceholder);
  assert.deepEqual(failed, []);
  assert.equal(slotValue(h.blob, "key:p1/c1"), "A", "槽位必须还在");
  assert.ok(warns.some((w) => w.includes("占位")), `应有 warn：${warns.join(" | ")}`);
});

test("槽位命名互不冲突：apiKey / officialApiKey / openaiApiKey 各占一槽", async () => {
  const h = await boot({
    settings: { providers: [], apiKey: "中转明文", officialApiKey: "官方明文", openaiApiKey: "openai明文" },
  }).init();
  const m = await h.apiKeys.migrateApiKeysOnce();
  assert.equal(m.migrated, 3, `三个旧键各占一个槽位：${JSON.stringify(m)}`);
  assert.equal(slotValue(h.blob, "key:@legacy/apiKey"), "中转明文");
  assert.equal(slotValue(h.blob, "key:@legacy/officialApiKey"), "官方明文");
  assert.equal(slotValue(h.blob, "key:@legacy/openaiApiKey"), "openai明文");
  assert.equal(h.settings().apiKey, PLACEHOLDER);
  assert.equal(h.settings().officialApiKey, PLACEHOLDER);
  assert.equal(h.settings().openaiApiKey, PLACEHOLDER);
  assert.equal(h.config.getApiKey(), "中转明文");
  assert.equal(h.config.getOfficialApiKey(), "官方明文");
  assert.equal(h.config.getOpenaiApiKey(), "openai明文");
});

test("AC-26：迁移与保存的日志里不出现任何 key 值", async () => {
  const logs = [];
  const h = await boot({ settings: { providers: [rawProvider({ apiKey: "sk-very-secret-value" })] } }).init();
  const log = require("./.build/log.js");
  for (const name of ["info", "warn", "error", "debug"]) {
    log[name] = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  }
  await h.apiKeys.migrateApiKeysOnce();
  await h.providers.saveProviders(h.providers.getProviders());
  assert.ok(!logs.join("\n").includes("sk-very-secret-value"), `日志里出现了 key 值：${logs.join(" | ")}`);
});
