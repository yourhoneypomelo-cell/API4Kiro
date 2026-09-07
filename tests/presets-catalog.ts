/**
 * 预制端点目录与模型聚合：
 *  - src/modelCatalog.ts：id 规范化、宽松匹配（精确 → 去日期 → family）、目录不可达回退、24h TTL、快照加载；
 *  - src/providers.ts：models.dev → 预设（SDK 表、占位符地址、与内置去重、热门排序）；
 *  - src/modelStore.ts：/models 三种形状、description 空串、effort 变体折叠、整体预算不等最慢者、路由；
 *  - src/cpsServer.ts：buildModelList 的分组标题条目（不绑端口）。
 * 目录地址指向本机假服务器或关着的端口，绝不访问 models.dev。
 */
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { CpsProxyServer } from "../src/cpsServer";
import {
  _setCatalogUrlForTest,
  catalogProvider,
  catalogProviders,
  catalogReady,
  catalogSize,
  initModelCatalog,
  loadCatalogJsonForTest,
  lookupCapability,
  normalizeModelId,
  onCatalogChanged,
  refreshCatalog,
  resetCatalogForTest,
} from "../src/modelCatalog";
import { fetchAllModels, fetchProviderModels, getCachedModels, groupModelsByEffort, modelEntryId, providerForModel } from "../src/modelStore";
import { ProviderConfig, allPresets, getPreset, presetFromCatalog } from "../src/providers";
import { check, deepEq, eq, fakeClock, finish, sendJson, startServer, test } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext; __setConfig(key: string, value: unknown): void; __resetConfig(): void };
const stub = vscode as unknown as Stub;

const CATALOG_JSON = {
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    doc: "https://platform.openai.com/docs",
    models: {
      "gpt-5": { name: "GPT-5", reasoning: true, reasoning_options: [{ type: "effort", values: [null, "low", "medium", "high"] }], modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 400000, output: 128000 } },
      "gpt-4.1-mini": { name: "GPT-4.1 mini", reasoning: false, modalities: { input: ["text", "image"] }, limit: { context: 1047576, output: 32768 } },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com/",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro", family: "deepseek", attachment: false, reasoning: true, reasoning_options: [{ type: "toggle" }], limit: { context: 128000, output: 8192 } },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", attachment: true, reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32000 }], limit: { context: 200000, output: 64000 } },
    },
  },
  zhipuai: {
    id: "zhipuai",
    name: "Zhipu AI",
    api: "https://open.bigmodel.cn/api/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    env: ["ZHIPU_API_KEY"],
    models: { "glm-5.3": { name: "GLM-5.3", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } },
  },
  "amazon-bedrock": { id: "amazon-bedrock", name: "Amazon Bedrock", api: "", npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID"], models: { "claude-x": { name: "x" } } },
  cloudflare: { id: "cloudflare", name: "Cloudflare", api: "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1", npm: "@ai-sdk/openai-compatible", env: ["CF_TOKEN"], models: { "@cf/x": { name: "x" } } },
  nomodels: { id: "nomodels", name: "No Models", api: "https://x.example", npm: "@ai-sdk/openai-compatible", env: [] },
};

(async () => {
  const ctx = stub.__makeContext();
  initConfig(ctx);
  const closedPort = "http://127.0.0.1:9/api.json";
  _setCatalogUrlForTest(closedPort);

  await test("normalizeModelId：小写、去 provider 前缀、去档位后缀、去日期尾巴、保留真实版本号", () => {
    eq("provider/ 前缀", normalizeModelId("openai/gpt-5-high"), "gpt-5");
    eq("日期 -YYYYMMDD", normalizeModelId("claude-sonnet-4-20250514"), "claude-sonnet-4");
    eq("日期 -YYYY-MM-DD", normalizeModelId("gemini-2.5-pro-2025-06-05"), "gemini-2.5-pro");
    eq("日期 :YYYYMMDD", normalizeModelId("gemini-2.5-pro:20250605"), "gemini-2.5-pro");
    eq("大小写 + max 后缀", normalizeModelId("DeepSeek-V4-Pro-max"), "deepseek-v4-pro");
    eq("thinking 后缀", normalizeModelId("glm-5.3-thinking"), "glm-5.3");
    eq("-v4 是版本不是日期", normalizeModelId("model-v4"), "model-v4");
    eq("空 → 空", normalizeModelId("  "), "");
  });

  await test("loadCatalogJsonForTest + lookupCapability：精确 / 去日期 / family 兜底 / 三态档位", () => {
    loadCatalogJsonForTest(CATALOG_JSON);
    eq("目录就绪", catalogReady(), true);
    eq("去重后模型数（不含 family 别名）", catalogSize(), 7);
    const gpt5 = lookupCapability("gpt-5")!;
    eq("精确命中", gpt5.id, "gpt-5");
    eq("image 由 modalities.input", gpt5.input.image, true);
    deepEq("effort 档位 null → none", gpt5.reasoningOptions, [{ type: "effort", values: ["none", "low", "medium", "high"] }]);
    eq("contextWindow", gpt5.contextWindow, 400000);
    eq("带 provider 前缀 + 档位后缀也命中", lookupCapability("openrouter/gpt-5-high")?.id, "gpt-5");
    eq("带日期尾巴命中", lookupCapability("claude-sonnet-4-5-20250929")?.id, "claude-sonnet-4-5");
    eq("attachment:true → image", lookupCapability("claude-sonnet-4-5")?.input.image, true);
    deepEq("budget 形态", lookupCapability("claude-sonnet-4-5")?.reasoningOptions, [{ type: "budget", min: 1024, max: 32000 }]);
    eq("attachment:false → image=false", lookupCapability("deepseek-v4-pro")?.input.image, false);
    deepEq("toggle 形态", lookupCapability("deepseek-v4-pro")?.reasoningOptions, [{ type: "toggle" }]);
    eq("family 兜底：deepseek-v9-ultra → family=deepseek 的条目", lookupCapability("deepseek-v9-ultra")?.id, "deepseek-v4-pro");
    eq("完全未知 → undefined", lookupCapability("totally-unknown-model"), undefined);
    eq("空 id → undefined", lookupCapability(""), undefined);
    deepEq("providers 按 id 排序", catalogProviders().map((p) => p.id), ["amazon-bedrock", "anthropic", "cloudflare", "deepseek", "openai", "zhipuai"]);
    eq("没有 models 的 provider 不进目录", catalogProvider("nomodels"), undefined);
    deepEq("provider.models 清单", catalogProvider("openai")?.models, ["gpt-5", "gpt-4.1-mini"]);
    eq("api 去尾斜杠", catalogProvider("deepseek")?.api, "https://api.deepseek.com/");
  });

  await test("presetFromCatalog / allPresets：SDK 表、默认地址、占位符、内置去重、热门排序", () => {
    const openai = presetFromCatalog(catalogProvider("openai")!)!;
    eq("id 前缀 md:", openai.id, "md:openai");
    eq("api 为空 → SDK 默认地址", openai.baseUrl, "https://api.openai.com/v1");
    eq("exactBase", openai.exactBase, true);
    eq("keyHint 用 env 名", openai.keyHint, "OPENAI_API_KEY");
    eq("popular（在 POPULAR_ORDER）", openai.popular, true);
    eq("modelCount", openai.modelCount, 2);
    eq("protocol", openai.protocol, "openai");
    eq("openaiApi=chat", openai.openaiApi, "chat");
    const ds = presetFromCatalog(catalogProvider("deepseek")!)!;
    eq("目录地址去尾斜杠", ds.baseUrl, "https://api.deepseek.com");
    const an = presetFromCatalog(catalogProvider("anthropic")!)!;
    eq("anthropic SDK → official 模式", an.anthropicMode, "official");
    eq("不能填 key 即用的 SDK（Bedrock）→ undefined", presetFromCatalog(catalogProvider("amazon-bedrock")!), undefined);
    eq("地址含 ${} 占位符 → undefined", presetFromCatalog(catalogProvider("cloudflare")!), undefined);
    const all = allPresets();
    check("内置已覆盖的目录条目不重复出现（无 md:openai / md:anthropic / md:deepseek）", !all.some((p) => ["md:openai", "md:anthropic", "md:deepseek"].includes(p.id)), all.map((p) => p.id));
    check("目录里新家出现（md:zhipuai）", all.some((p) => p.id === "md:zhipuai"));
    const builtinOpenai = all.find((p) => p.id === "official-openai")!;
    eq("内置预设 modelCount 由目录补上", builtinOpenai.modelCount, 2);
    eq("内置预设 catalogId", builtinOpenai.catalogId, "openai");
    const ids = all.map((p) => p.id);
    check("热门在前：anthropic 官方排在 zhipuai 前", ids.indexOf("official-anthropic") < ids.indexOf("md:zhipuai"));
    check("热门顺序按 POPULAR_ORDER：anthropic < deepseek < openai < google < openrouter", ids.indexOf("official-anthropic") < ids.indexOf("deepseek") && ids.indexOf("deepseek") < ids.indexOf("official-openai") && ids.indexOf("official-openai") < ids.indexOf("official-gemini") && ids.indexOf("official-gemini") < ids.indexOf("openrouter"), ids);
    eq("getPreset 找到 md: 预设", getPreset("md:zhipuai")?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
    eq("getPreset 未知 → undefined", getPreset("md:nope"), undefined);
  });

  await test("refreshCatalog：24h 内不重复拉；不可达时静默回退保留既有目录；TTL 过期才真拉", async () => {
    resetCatalogForTest([{ id: "seed-model", input: { text: true, image: false, pdf: false, audio: false, video: false }, reasoning: false, reasoningOptions: [] }]);
    _setCatalogUrlForTest(closedPort);
    eq("刚刷过（fetchedAt=now）→ 不拉直接 true", await refreshCatalog(false), true);
    eq("目录仍在", lookupCapability("seed-model")?.id, "seed-model");
    const clock = fakeClock(Date.now());
    try {
      clock.advance(23 * 3600_000);
      eq("23h 仍在 TTL 内", await refreshCatalog(false), true);
      clock.advance(2 * 3600_000);
      eq("25h 后 TTL 过期 → 去拉 → 端口关着 → false", await refreshCatalog(false), false);
      eq("失败不清目录", lookupCapability("seed-model")?.id, "seed-model");
      eq("目录仍 ready", catalogReady(), true);
    } finally {
      clock.restore();
    }
    // 服务端 500 / 空目录 也回退
    let mode: "ok" | "500" | "empty" | "junk" = "500";
    const srv = await startServer((req, res) => {
      if (mode === "500") {
        sendJson(res, 500, { error: "boom" });
      } else if (mode === "empty") {
        sendJson(res, 200, {});
      } else if (mode === "junk") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>captive portal</html>");
      } else {
        sendJson(res, 200, CATALOG_JSON);
      }
    });
    _setCatalogUrlForTest(`${srv.url}/api.json`);
    eq("HTTP 500 → false", await refreshCatalog(true), false);
    mode = "empty";
    eq("解析后为空 → false（不拿空目录覆盖）", await refreshCatalog(true), false);
    mode = "junk";
    eq("非 JSON → false", await refreshCatalog(true), false);
    eq("三次失败后 seed 仍在", lookupCapability("seed-model")?.id, "seed-model");
    let notified = 0;
    const sub = onCatalogChanged(() => notified++);
    mode = "ok";
    eq("正常 → true", await refreshCatalog(true), true);
    eq("监听者被通知一次", notified, 1);
    eq("新目录生效", lookupCapability("gpt-5")?.id, "gpt-5");
    eq("旧 seed 被整份替换掉", lookupCapability("seed-model"), undefined);
    sub.dispose();
    await srv.close();
    _setCatalogUrlForTest(closedPort);
  });

  await test("initModelCatalog：从 globalState 快照加载（含 provider 层）；后台刷新失败不影响", async () => {
    const snapCtx = stub.__makeContext();
    await snapCtx.globalState.update("modelCatalog.snapshot", {
      at: Date.now() - 1000,
      models: [{ id: "snap-model", family: "snapfam", input: { text: true, image: true, pdf: false, audio: false, video: false }, reasoning: true, reasoningOptions: [], contextWindow: 123 }],
      providers: [{ id: "snapprov", name: "Snap", api: "https://snap.example/v1", npm: "@ai-sdk/openai-compatible", env: ["SNAP_KEY"], models: ["snap-model"] }],
    });
    _setCatalogUrlForTest(closedPort);
    initModelCatalog(snapCtx);
    eq("快照模型可查", lookupCapability("snap-model")?.contextWindow, 123);
    eq("family 别名也建了", lookupCapability("snapfam-other")?.id, "snap-model");
    eq("provider 层加载", catalogProvider("snapprov")?.env[0], "SNAP_KEY");
    await new Promise((r) => setTimeout(r, 200));
    eq("后台刷新失败后快照仍在", lookupCapability("snap-model")?.id, "snap-model");
  });

  // ---------------- modelStore ----------------
  loadCatalogJsonForTest(CATALOG_JSON);

  await test("modelEntryId：id / modelId / Gemini name:models/…", () => {
    eq("id", modelEntryId({ id: "a" }), "a");
    eq("modelId", modelEntryId({ modelId: "b" }), "b");
    eq("models/ 前缀", modelEntryId({ name: "models/gemini-2.5-pro" }), "gemini-2.5-pro");
    eq("无 → 空", modelEntryId({ name: "plain" }), "");
  });

  let shape: "data" | "models" | "bare" = "data";
  let slowMs = 0;
  let calls = 0;
  const fakeModels = await startServer(async (req, res) => {
    calls++;
    const path = (req.url || "").split("?")[0];
    if (path === "/slow/v1/models") {
      await new Promise((r) => setTimeout(r, slowMs));
      sendJson(res, 200, { data: [{ id: "slow-1" }, { id: "slow-2" }] });
      return;
    }
    if (path !== "/v1/models") {
      sendJson(res, 404, { error: "nope" });
      return;
    }
    const entries = [
      { id: "alpha-pro", description: "", context_window: 131072, capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
      { id: "alpha-pro-low" },
      { id: "alpha-pro-high" },
      { id: "orphan-high" },
      { id: "gpt-5", owned_by: "openai" },
      { id: "alpha-pro" },
      { id: "", note: "empty id dropped" },
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", description: "Google model", inputTokenLimit: 1048576, input_modalities: ["text"] },
    ];
    if (shape === "data") {
      sendJson(res, 200, { object: "list", data: entries });
    } else if (shape === "models") {
      sendJson(res, 200, { models: entries });
    } else {
      sendJson(res, 200, entries);
    }
  });

  const p1: ProviderConfig = { id: "p1", name: "Alpha 中转", protocol: "openai", openaiApi: "chat", baseUrl: fakeModels.url, apiKey: "sk-p1-secret", enabled: true, enabledModels: ["alpha-pro", "gpt-5", "gemini-2.5-pro"] };
  const p2: ProviderConfig = { id: "p2", name: "Slow 中转", protocol: "anthropic", anthropicMode: "kiro", baseUrl: `${fakeModels.url}/slow`, apiKey: "sk-p2-secret", enabled: true, enabledModels: ["slow-1"] };

  await test("fetchProviderModels：/models 三种形状；description 空串保留；上游能力声明；重复条目 / 空 id", async () => {
    for (const s of ["data", "models", "bare"] as const) {
      shape = s;
      const list = await fetchProviderModels(p1, true);
      deepEq(`${s}[] 形状 → 7 条（去掉空 id，重复保留由聚合层去重）`, list.map((m) => m.id), ["alpha-pro", "alpha-pro-low", "alpha-pro-high", "orphan-high", "gpt-5", "alpha-pro", "gemini-2.5-pro"]);
    }
    const list = await fetchProviderModels(p1, true);
    const alpha = list[0];
    eq("description 空串保留为空串（不是 undefined）", alpha.description, "");
    eq("context_window", alpha.contextWindow, 131072);
    eq("上游 capabilities.image_input → upstreamImage", alpha.upstreamImage, true);
    eq("上游 capabilities.thinking → upstreamReasoning", alpha.upstreamReasoning, true);
    const gem = list[6];
    eq("Gemini name:models/ → id", gem.id, "gemini-2.5-pro");
    eq("displayName 作名字", gem.name, "Gemini 2.5 Pro");
    eq("inputTokenLimit → contextWindow", gem.contextWindow, 1048576);
    eq("input_modalities 无 image → upstreamImage=false", gem.upstreamImage, false);
    const g5 = list[4];
    eq("上游没给上下文 → 目录补 400000", g5.contextWindow, 400000);
    eq("目录补 maxOutputTokens", g5.maxOutputTokens, 128000);
    const before = calls;
    await fetchProviderModels(p1, false);
    eq("60s 内缓存命中不再请求", calls, before);
  });

  await test("groupModelsByEffort：只在 base 存在时折叠；孤儿变体独立；description 空串不写入组", async () => {
    const list = await fetchProviderModels(p1, true);
    const groups = groupModelsByEffort(list);
    const alpha = groups.find((g) => g.baseId === "alpha-pro")!;
    deepEq("alpha-pro 折叠出 low/high", [...alpha.efforts].sort(), ["high", "low"]);
    eq("description 空串 → 组里 undefined", alpha.description, undefined);
    eq("maxInputTokens 取自 base", alpha.maxInputTokens, 131072);
    check("orphan-high 无 base → 独立一组", groups.some((g) => g.baseId === "orphan-high" && g.efforts.size === 0));
    eq("同 id 重复不产生两组", groups.filter((g) => g.baseId === "alpha-pro").length, 1);
    eq("gemini 描述非空写入组", groups.find((g) => g.baseId === "gemini-2.5-pro")?.description, "Google model");
  });

  await test("fetchAllModels：整体预算 3s，不等最慢者，慢渠道用勾选 id 顶上；按 enabledModels 过滤", async () => {
    stub.__resetConfig();
    stub.__setConfig("providers", [p1, p2]);
    slowMs = 4500;
    shape = "data";
    const t0 = Date.now();
    const merged = await fetchAllModels(true);
    const dt = Date.now() - t0;
    check("耗时落在预算附近（<4000ms，不等 4.5s 的慢渠道）", dt < 4000, dt);
    deepEq("p1 只留勾选的（勾 base 即含其档位变体；orphan-high 与重复条目被滤掉）", merged.filter((m) => m.providerId === "p1").map((m) => m.id), ["alpha-pro", "alpha-pro-low", "alpha-pro-high", "gpt-5", "gemini-2.5-pro"]);
    deepEq("p2 超时 → 勾选 id 作替身", merged.filter((m) => m.providerId === "p2").map((m) => m.id), ["slow-1"]);
    eq("替身条目的 protocol 跟 provider", merged.find((m) => m.providerId === "p2")?.protocol, "anthropic");
    eq("getCachedModels 与返回一致", getCachedModels().length, merged.length);
    eq("providerForModel：勾选模型 → 归属", providerForModel("gpt-5")?.id, "p1");
    eq("providerForModel：档位变体归到 base", providerForModel("alpha-pro-high")?.id, "p1");
    eq("providerForModel：带 @providerId 直接归属", providerForModel("anything@p2")?.id, "p2");
    eq("providerForModel：未勾选但上游列表有 → 仍归 p1（老会话不掉兜底）", providerForModel("orphan-high")?.id, "p1");
    eq("providerForModel：未知 → undefined", providerForModel("nope-model"), undefined);
    // 慢渠道真正拉完后进缓存，下一次立即可用
    await new Promise((r) => setTimeout(r, 2000));
    slowMs = 0;
    const again = await fetchAllModels(false);
    deepEq("慢渠道结果落缓存后：slow-1 仍是唯一勾选", again.filter((m) => m.providerId === "p2").map((m) => m.id), ["slow-1"]);
  });

  await test("CPS buildModelList：分组标题条目（modelName 空串、description 以 __A2K_GRP__| 开头）、默认模型不是标题", async () => {
    stub.__setConfig("providers", [p1, p2]);
    slowMs = 0;
    const cps = new CpsProxyServer(19887, () => undefined) as unknown as { buildModelList(): Promise<{ models: Array<{ modelId: string; modelName: string; description: string; supportedInputTypes: string[]; additionalModelRequestFieldsSchema?: unknown }>; defaultModel?: { modelId: string } }> };
    const list = await cps.buildModelList();
    const ids = list.models.map((m) => m.modelId);
    eq("第一条是 p1 的分组标题", ids[0], "a2k-group:p1");
    eq("标题 modelName 必须是空串（:empty 选择器靠它）", list.models[0].modelName, "");
    check("标题 description 以 __A2K_GRP__| 开头并含渠道名与数量", /^__A2K_GRP__\|Alpha 中转\|3\|/.test(list.models[0].description), list.models[0].description);
    check("p2 标题在其模型之前", ids.indexOf("a2k-group:p2") < ids.indexOf("slow-1") && ids.indexOf("a2k-group:p2") > ids.indexOf("gemini-2.5-pro"), ids);
    eq("defaultModel 是第一个真模型而非标题", list.defaultModel?.modelId, "alpha-pro");
    const alpha = list.models.find((m) => m.modelId === "alpha-pro")!;
    check("真模型 description 是能力标记 __A2K_MDL__|reasoning|image|window|isLast", /^__A2K_MDL__\|1\|1\|\d+\|0$/.test(alpha.description), alpha.description);
    check("description 第 3 位 = tokenLimits.maxInputTokens（弹层据此显示总窗口）", alpha.description.split("|")[3] === String(alpha.tokenLimits.maxInputTokens), { desc: alpha.description, limits: alpha.tokenLimits });
    const gem = list.models.find((m) => m.modelId === "gemini-2.5-pro")!;
    check("gemini：上游声明无图 → TEXT only；是 p1 最后一条 isLast=1", gem.supportedInputTypes.join(",") === "TEXT" && /\|1$/.test(gem.description), gem);
    const g5 = list.models.find((m) => m.modelId === "gpt-5")!;
    const schema = g5.additionalModelRequestFieldsSchema as { properties: { output_config: { properties: { effort: { enum: string[] } } } } } | undefined;
    deepEq("gpt-5 档位来自目录 reasoning_options", schema?.properties.output_config.properties.effort.enum, ["none", "low", "medium", "high"]);
    // 单渠道：不插标题，description 空串
    stub.__setConfig("providers", [p1]);
    const single = await cps.buildModelList();
    check("单渠道无标题行", !single.models.some((m) => m.modelId.startsWith("a2k-group:")), single.models.map((m) => m.modelId));
    eq("单渠道 description 空串", single.models[0].description, "");
  });

  await fakeModels.close();
  finish();
})();
