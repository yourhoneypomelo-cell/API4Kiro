/**
 * 凭证配置归一（src/providers.ts）：池的候选集从这里来——
 * credentials[] 的 id / priority 补全、c1 置首并镜像 apiKey、无 key 条目丢弃、OAuth 条目靠 tokenStore 判定；
 * addCredential / removeCredential（删 c1 提升下一把）；tokenKeyOf；enabledModels 三态；渠道限定 id；resolveApiUrl。
 */
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { _resetTokenStoreForTest, setToken } from "../src/oauth/tokenStore";
import {
  ProviderConfig,
  addCredential,
  configuredCredentials,
  credentialsOf,
  getActiveProviders,
  getProviders,
  hasPool,
  isModelEnabled,
  isProviderUsable,
  kiroModelIds,
  providerMissing,
  removeCredential,
  resolveApiUrl,
  splitQualifiedModelId,
  tokenKeyOf,
} from "../src/providers";
import { check, deepEq, eq, finish, test } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext; __setConfig(k: string, v: unknown): void; __resetConfig(): void };
const stub = vscode as unknown as Stub;

(async () => {
  initConfig(stub.__makeContext());

  await test("coerce：credentials 归一（补 id、c1 置首、apiKey 以旧字段为准、无 key 丢弃、priority 缺省按序）", () => {
    stub.__resetConfig();
    stub.__setConfig("providers", [
      {
        id: "p1",
        name: "池",
        protocol: "openai",
        baseUrl: "https://r.example/v1",
        apiKey: "sk-from-legacy-field",
        credentials: [
          { id: "c2", apiKey: "sk-two", priority: 5 },
          { apiKey: "sk-three" },
          { id: "c1", apiKey: "sk-one-stale", label: "  主号  ", priority: -3.7 },
          { id: "c2", apiKey: "sk-dup-id" },
          { apiKey: "" },
          { id: "bogus", apiKey: "sk-bogus-id" },
          "not an object",
        ],
        poolStrategy: "least-used",
      },
    ]);
    const p = getProviders()[0];
    const creds = credentialsOf(p);
    deepEq("id 序列：c1 置首，缺 id / 非法 id / 重复 id 依次补新号", creds.map((c) => c.id), ["c1", "c2", "c3", "c4", "c5"]);
    eq("c1 的 key 以旧字段 apiKey 为准", creds[0].apiKey, "sk-from-legacy-field");
    eq("provider.apiKey 与 c1 镜像一致", p.apiKey, "sk-from-legacy-field");
    eq("label 去空白", creds[0].label, "主号");
    eq("负数 priority 钳到 0 并取整", creds[0].priority, 0);
    eq("缺省 priority 按插入序", creds[2].priority, 1);
    eq("空 key 的条目被丢弃", creds.length, 5);
    deepEq("没写 id 的两把 key 都保留（不被 c1 镜像覆盖掉）", creds.map((c) => c.apiKey), ["sk-from-legacy-field", "sk-two", "sk-three", "sk-dup-id", "sk-bogus-id"]);
    eq("重复 id c2：首次出现者保留 c2", creds[1].apiKey, "sk-two");
    eq("hasPool", hasPool(p), true);
    eq("poolStrategy 保留", p.poolStrategy, "least-used");
    deepEq("configuredCredentials = 全部有 key 且启用", configuredCredentials(p).map((c) => c.id), ["c1", "c2", "c3", "c4", "c5"]);
    stub.__setConfig("providers", [{ id: "p2", name: "无池", protocol: "anthropic", baseUrl: "https://a.example", apiKey: "sk-solo", credentials: [] }]);
    const solo = getProviders()[0];
    eq("空数组 → credentials undefined", solo.credentials, undefined);
    deepEq("credentialsOf 合成 c1", credentialsOf(solo).map((c) => `${c.id}:${c.apiKey}`), ["c1:sk-solo"]);
    eq("hasPool=false", hasPool(solo), false);
    stub.__setConfig("providers", [{ id: "p3", name: "坏", protocol: "openai", baseUrl: "https://x", apiKey: "", credentials: [{ id: "c1" }] }]);
    eq("全无 key → credentials undefined、provider 不可用", isProviderUsable(getProviders()[0]), false);
    eq("providerMissing 报缺 Key", providerMissing(getProviders()[0]), "缺少 API Key");
  });

  await test("OAuth provider：凭证是否配置齐全看 tokenStore；tokenKeyOf 首条裸 id", () => {
    stub.__resetConfig();
    _resetTokenStoreForTest();
    stub.__setConfig("providers", [{ id: "po", name: "登录", protocol: "openai", baseUrl: "https://o.example", apiKey: "", auth: "oauth", oauthVendor: "codex", credentials: [{ id: "c1" }, { id: "c2", label: "第二个号" }, { id: "c3", enabled: false }] }]);
    const p = getProviders()[0];
    eq("OAuth 条目无 key 也保留", credentialsOf(p).length, 3);
    eq("tokenKeyOf(c1) 是裸 providerId", tokenKeyOf(p.id, "c1"), "po");
    eq("tokenKeyOf(c2) 带后缀", tokenKeyOf(p.id, "c2"), "po/c2");
    deepEq("没登录 → 无候选", configuredCredentials(p).map((c) => c.id), []);
    eq("providerMissing=未登录", providerMissing(p), "未登录");
    eq("不在 active 里", getActiveProviders().length, 0);
    setToken("po/c2", { accessToken: "t2", updatedAt: Date.now() });
    deepEq("只有 c2 登录 → 候选 c2", configuredCredentials(p).map((c) => c.id), ["c2"]);
    setToken("po", { accessToken: "t1", updatedAt: Date.now() });
    setToken("po/c3", { accessToken: "t3", updatedAt: Date.now() });
    deepEq("c3 停用不参与", configuredCredentials(p).map((c) => c.id), ["c1", "c2"]);
    eq("可用", isProviderUsable(p), true);
    eq("进入 active", getActiveProviders().length, 1);
  });

  await test("addCredential / removeCredential：物化 c1、追加编号与 priority、删 c1 提升下一把", () => {
    const p: ProviderConfig = { id: "pa", name: "a", protocol: "openai", baseUrl: "https://a", apiKey: "sk-first", enabled: true };
    const c2 = addCredential(p, { apiKey: " sk-second ", label: "备用" });
    eq("新条目 id c2", c2.id, "c2");
    eq("key 去空白", c2.apiKey, "sk-second");
    eq("priority 递增", c2.priority, 1);
    deepEq("隐含 c1 被物化", p.credentials!.map((c) => `${c.id}:${c.apiKey}`), ["c1:sk-first", "c2:sk-second"]);
    const c3 = addCredential(p, { apiKey: "sk-third" });
    eq("c3", c3.id, "c3");
    const gone = removeCredential(p, "c1")!;
    eq("删的是 c1", gone.removed.apiKey, "sk-first");
    eq("提升自 c2", gone.promotedFromId, "c2");
    deepEq("剩余：原 c2 改名 c1，c3 不变", p.credentials!.map((c) => `${c.id}:${c.apiKey}`), ["c1:sk-second", "c3:sk-third"]);
    eq("apiKey 镜像跟着换", p.apiKey, "sk-second");
    eq("删不存在 → undefined", removeCredential(p, "c9"), undefined);
    removeCredential(p, "c3");
    const last = removeCredential(p, "c1")!;
    eq("删到空 → 不再提升", last.promotedFromId, undefined);
    eq("空池 credentials undefined", p.credentials, undefined);
    eq("空池 apiKey 清空", p.apiKey, "");
    const po: ProviderConfig = { id: "po", name: "o", protocol: "openai", baseUrl: "https://o", apiKey: "", enabled: true, auth: "oauth", oauthVendor: "codex" };
    const oc2 = addCredential(po, { apiKey: "ignored-for-oauth" });
    eq("OAuth 追加不存 key", oc2.apiKey, undefined);
    eq("OAuth 不镜像 apiKey", po.apiKey, "");
  });

  await test("enabledModels 三态与 base id 匹配", () => {
    const base: ProviderConfig = { id: "pm", name: "m", protocol: "openai", baseUrl: "https://m", apiKey: "k", enabled: true };
    eq("undefined → 全部", isModelEnabled(base, "anything"), true);
    eq("[] → 一个都不", isModelEnabled({ ...base, enabledModels: [] }, "gpt-5"), false);
    const some = { ...base, enabledModels: ["GPT-5", "deepseek-v4-pro"] };
    eq("命中（忽略大小写）", isModelEnabled(some, "gpt-5"), true);
    eq("档位变体归 base", isModelEnabled(some, "deepseek-v4-pro-max"), true);
    eq("未勾选", isModelEnabled(some, "gpt-4.1"), false);
    eq("勾了带后缀的精确 id 也认", isModelEnabled({ ...base, enabledModels: ["o3-high"] }, "o3-high"), true);
  });

  await test("渠道限定 id：kiroModelIds 首现用原 id、后续带 @providerId；splitQualifiedModelId 三种尾巴", () => {
    stub.__resetConfig();
    stub.__setConfig("providers", [
      { id: "p1", name: "A", protocol: "openai", baseUrl: "https://a", apiKey: "k" },
      { id: "p2", name: "B", protocol: "openai", baseUrl: "https://b", apiKey: "k" },
    ]);
    deepEq(
      "同名模型第二渠道带限定；大小写视为同名",
      kiroModelIds([
        { id: "gpt-5", providerId: "p1" },
        { id: "GPT-5", providerId: "p2" },
        { id: "gpt-5", providerId: "p1" },
        { id: "only-b", providerId: "p2" },
      ]),
      ["gpt-5", "GPT-5@p2", "gpt-5", "only-b"]
    );
    deepEq("已知 provider 尾巴 → 拆", splitQualifiedModelId("gpt-5@p2"), { modelId: "gpt-5", providerId: "p2" });
    deepEq("像我们生成的 id 但已删（p77）→ 仍拆", splitQualifiedModelId("gpt-5@p77"), { modelId: "gpt-5", providerId: "p77" });
    deepEq("legacy-xxx 尾巴 → 拆", splitQualifiedModelId("m@legacy-openai"), { modelId: "m", providerId: "legacy-openai" });
    deepEq("模型 id 自带 @（非 provider）→ 不拆", splitQualifiedModelId("org@corp/model"), { modelId: "org@corp/model" });
    deepEq("尾巴为空 → 不拆", splitQualifiedModelId("gpt-5@"), { modelId: "gpt-5@" });
  });

  await test("resolveApiUrl：启发式 /v1、已有版本段、exactBase、OAuth 原样、空地址", () => {
    const k = (over: Partial<ProviderConfig>): ProviderConfig => ({ id: "x", name: "x", protocol: "openai", baseUrl: "https://h.example", apiKey: "k", enabled: true, ...over });
    eq("无版本段 → 补 /v1", resolveApiUrl(k({}), "models"), "https://h.example/v1/models");
    eq("/v1 → 原样", resolveApiUrl(k({ baseUrl: "https://h.example/v1" }), "/models"), "https://h.example/v1/models");
    eq("/v4 → 原样", resolveApiUrl(k({ baseUrl: "https://h.example/v4" }), "/chat/completions"), "https://h.example/v4/chat/completions");
    eq("/v1beta → 原样", resolveApiUrl(k({ baseUrl: "https://h.example/v1beta" }), "/models"), "https://h.example/v1beta/models");
    eq("exactBase → 原样（无版本段也不补）", resolveApiUrl(k({ baseUrl: "https://h.example/api/gateway", exactBase: true }), "/models"), "https://h.example/api/gateway/models");
    eq("OAuth → 原样", resolveApiUrl(k({ baseUrl: "https://h.example/backend-api/codex", auth: "oauth", oauthVendor: "codex" }), "/models"), "https://h.example/backend-api/codex/models");
    eq("空地址 → 空", resolveApiUrl(k({ baseUrl: "" }), "/models"), "");
  });

  finish();
})();
