/** modelCatalog（规范化 / family 兜底 / TTL）与 modelStore（enabledModels 过滤 / 慢渠道不拖列表 / 路由 / effort 折叠）。 */
import * as vscode from "vscode";
import * as http from "http";
import { URL } from "url";
import { test, run, eq, ok, deepEq } from "./harness";
import { catalogProvider, catalogProviders, catalogReady, loadCatalogJsonForTest, lookupCapability, normalizeModelId, refreshCatalog, resetCatalogForTest } from "../../src/modelCatalog";
import { fetchAllModels, fetchProviderModels, getCachedModels, groupModelsByEffort, isGroupHeaderId, providerForModel, GROUP_HEADER_PREFIX } from "../../src/modelStore";
import { allPresets, getProviders, isModelEnabled, kiroModelIds, presetFromCatalog, splitQualifiedModelId } from "../../src/providers";
import { initConfig } from "../../src/config";

const stub = vscode as unknown as { __makeContext(): unknown; __reset(): void; __setConfig(k: string, v: unknown): void };
const PORT = 19876;
const BASE = `http://127.0.0.1:${PORT}`;
const pendingSlow = new Set<http.ServerResponse>();
let slowHits = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", BASE);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === "/fast/v1/models") {
    return json(200, { data: [{ id: "fast-a" }, { id: "fast-b" }, { id: "fast-b-high" }, { id: "fast-b-low" }, { id: "FAST-A" }] });
  }
  if (u.pathname === "/slow/v1/models") {
    slowHits++;
    pendingSlow.add(res);
    // 6s 后才回（超过 3s 预算）
    setTimeout(() => {
      pendingSlow.delete(res);
      json(200, { data: [{ id: "slow-real" }] });
    }, 6000);
    return;
  }
  json(404, {});
});

const CATALOG = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPSEEK_API_KEY"],
    doc: "https://platform.deepseek.com",
    models: {
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro", family: "deepseek", reasoning: true, reasoning_options: [{ type: "effort", values: [null, "max"] }], modalities: { input: ["text"] }, limit: { context: 128000, output: 32000 } },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-20250514": { name: "Claude Sonnet 4", family: "claude-sonnet", reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32000 }], attachment: true, limit: { context: 200000, output: 64000 } },
    },
  },
  bedrock: { id: "bedrock", name: "Bedrock", api: "", npm: "@ai-sdk/amazon-bedrock", env: [], models: { "x.y": { name: "x" } } },
  weird: { id: "weird", name: "Weird", api: "https://${ACCOUNT}.example/v1", npm: "@ai-sdk/openai-compatible", env: [], models: { w1: { name: "w1" } } },
};

test("setup", async () => {
  stub.__reset();
  initConfig(stub.__makeContext() as never);
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
});

test("normalizeModelId：小写、去 provider 前缀、去 effort/thinking 后缀、去日期尾巴、保留 -v4", () => {
  eq(normalizeModelId("OpenAI/GPT-5-High"), "gpt-5");
  eq(normalizeModelId("claude-sonnet-4-20250514"), "claude-sonnet-4");
  eq(normalizeModelId("gemini-2.5-pro:20250605"), "gemini-2.5-pro");
  eq(normalizeModelId("deepseek-v4-pro-thinking"), "deepseek-v4-pro");
  eq(normalizeModelId("qwen-max-2025-01-25"), "qwen-max");
  eq(normalizeModelId("deepseek-v4"), "deepseek-v4");
  eq(normalizeModelId("  "), "");
});

test("lookupCapability：精确规范化命中 → family 兜底 → undefined；能力字段解析", () => {
  loadCatalogJsonForTest(CATALOG);
  ok(catalogReady());
  const ds = lookupCapability("deepseek-v4-pro-max")!;
  eq(ds.id, "deepseek-v4-pro");
  eq(ds.reasoning, true);
  deepEq(ds.reasoningOptions, [{ type: "effort", values: ["none", "max"] }]);
  eq(ds.input.image, false);
  eq(ds.contextWindow, 128000);
  const fam = lookupCapability("deepseek-unknown-model")!;
  eq(fam.id, "deepseek-v4-pro", "family:deepseek 兜底");
  const cs = lookupCapability("anthropic/claude-sonnet-4-20250514")!;
  eq(cs.input.image, true, "attachment → image");
  deepEq(cs.reasoningOptions, [{ type: "budget", min: 1024, max: 32000 }]);
  eq(cs.maxOutputTokens, 64000);
  eq(lookupCapability("totally-unknown"), undefined);
  eq(lookupCapability(""), undefined);
});

test("refreshCatalog：24h 内且有数据 → 不重复拉（不发网络请求即返回 true）", async () => {
  loadCatalogJsonForTest(CATALOG);
  const started = Date.now();
  eq(await refreshCatalog(false), true);
  ok(Date.now() - started < 200, "没有走网络");
});

test("catalogProviders / presetFromCatalog：只给填 key 即用的；占位符地址与云凭证 SDK 不生成预设", () => {
  loadCatalogJsonForTest(CATALOG);
  deepEq(
    catalogProviders().map((p) => p.id),
    ["anthropic", "bedrock", "deepseek", "weird"]
  );
  const ds = presetFromCatalog(catalogProvider("deepseek")!)!;
  eq(ds.id, "md:deepseek");
  eq(ds.protocol, "openai");
  eq(ds.exactBase, true);
  eq(ds.baseUrl, "https://api.deepseek.com");
  eq(ds.keyHint, "DEEPSEEK_API_KEY");
  eq(ds.popular, true);
  eq(presetFromCatalog(catalogProvider("bedrock")!), undefined);
  eq(presetFromCatalog(catalogProvider("weird")!), undefined);
  const all = allPresets();
  ok(all.some((p) => p.id === "official-anthropic"), "内置预设在");
  ok(!all.some((p) => p.id === "md:anthropic"), "与内置重复的目录条目去掉");
  ok(!all.some((p) => p.id === "md:deepseek"), "deepseek 也是内置");
});

test("isModelEnabled 三态与 splitQualifiedModelId / kiroModelIds", () => {
  const base = { id: "p1", name: "x", protocol: "openai" as const, baseUrl: "", apiKey: "k", enabled: true };
  eq(isModelEnabled({ ...base, enabledModels: undefined }, "any"), true, "undefined=全部");
  eq(isModelEnabled({ ...base, enabledModels: [] }, "any"), false, "[]=一个都不进");
  eq(isModelEnabled({ ...base, enabledModels: ["Fast-B"] }, "fast-b-high"), true, "勾 base 含 effort 变体，忽略大小写");
  eq(isModelEnabled({ ...base, enabledModels: ["fast-b"] }, "fast-a"), false);
  deepEq(kiroModelIds([{ id: "m", providerId: "p1" }, { id: "M", providerId: "p2" }, { id: "m", providerId: "p1" }]), ["m", "M@p2", "m"]);
  deepEq(splitQualifiedModelId("m@p2"), { modelId: "m", providerId: "p2" });
  deepEq(splitQualifiedModelId("user@host-model"), { modelId: "user@host-model" });
  deepEq(splitQualifiedModelId("m@legacy-openai"), { modelId: "m", providerId: "legacy-openai" });
});

test("fetchAllModels：慢渠道不拖累列表（3s 预算后用勾选 id 顶上）；只保留 enabledModels；同渠道去重", async () => {
  resetCatalogForTest([]);
  stub.__setConfig("api2kiroDual.providers", [
    { id: "pfast", name: "快", protocol: "openai", baseUrl: BASE + "/fast", apiKey: "k1", enabled: true, enabledModels: ["fast-a", "fast-b"] },
    { id: "pslow", name: "慢", protocol: "openai", baseUrl: BASE + "/slow", apiKey: "k2", enabled: true, enabledModels: ["slow-picked"] },
    { id: "pnone", name: "没勾", protocol: "openai", baseUrl: BASE + "/fast", apiKey: "k3", enabled: true, enabledModels: [] },
    { id: "poff", name: "停用", protocol: "openai", baseUrl: BASE + "/fast", apiKey: "k4", enabled: false },
  ]);
  eq(getProviders().length, 4);
  const started = Date.now();
  const merged = await fetchAllModels(true);
  const elapsed = Date.now() - started;
  ok(elapsed < 4500, `整体 ${elapsed}ms，不等最慢渠道`);
  ok(elapsed >= 2900, `确实等了预算 ${elapsed}ms`);
  deepEq(
    merged.map((m) => `${m.providerId}:${m.id}`),
    ["pfast:fast-a", "pfast:fast-b", "pfast:fast-b-high", "pfast:fast-b-low", "pslow:slow-picked"],
    "FAST-A 与 fast-a 同渠道去重；未勾的不进；慢渠道用勾选 id 顶上"
  );
  eq(slowHits, 1, "慢渠道只请求了一次");
  eq(getCachedModels().length, 5);
  eq(providerForModel("fast-b-high")!.id, "pfast");
  eq(providerForModel("slow-picked")!.id, "pslow");
  eq(providerForModel("fast-a@pfast")!.id, "pfast");
  eq(providerForModel("nope"), undefined);
});

test("fetchProviderModels：60s 内命中缓存；没 key 的渠道不请求", async () => {
  const p = getProviders().find((x) => x.id === "pfast")!;
  const a = await fetchProviderModels(p);
  const b = await fetchProviderModels(p);
  eq(a, b, "同一缓存对象");
  const nokey = { ...p, id: "pnokey", apiKey: "", credentials: undefined };
  deepEq(await fetchProviderModels(nokey), []);
});

test("groupModelsByEffort：只在 base 存在时折叠、同渠道内折叠；组标题 id 判定", async () => {
  const merged = getCachedModels();
  const groups = groupModelsByEffort(merged);
  const fb = groups.find((g) => g.baseId === "fast-b")!;
  deepEq([...fb.efforts].sort(), ["high", "low"]);
  eq(groups.length, 3, "fast-a / fast-b(含两档) / slow-picked");
  const orphan = groupModelsByEffort([{ id: "x-high", name: "x-high", providerId: "p", protocol: "openai" }]);
  eq(orphan[0].baseId, "x-high", "没有 base 不折叠");
  eq(isGroupHeaderId(GROUP_HEADER_PREFIX + "p1"), true);
  eq(isGroupHeaderId("gpt-5"), false);
});

test("teardown", async () => {
  for (const r of pendingSlow) {
    try {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
    } catch {
      /* ignore */
    }
  }
  (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

run();
