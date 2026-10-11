/**
 * Provider 注册表 —— 本扩展从「双固定通道」升级为「N 个 provider 聚合」的核心。
 *
 * 一个 provider 就是一个上游接入点：第三方中转、官方 key、或任何 Anthropic/OpenAI
 * 兼容端点。所有「启用且配置完整」的 provider 的模型合并成一张列表进 Kiro 选择器，
 * 请求按模型 ID 路由回它所属的 provider（merge 运行时模型，见 modelStore.providerForModel）。
 *
 * 设计取自今晚读的 Kilo(OpenCode) provider 层：
 *  - 协议(protocol)与部署(baseUrl/auth)分离 —— DeepSeek/OpenRouter/官方 OpenAI 共用
 *    同一个 openai 协议，差别只是 baseURL；
 *  - 一个 provider ≈ 一条 {protocol, baseURL, auth} 记录，而非一个几百行的 handler。
 *
 * 存储在 `api2kiroDual.providers`（数组）。旧的双通道配置（baseUrl/apiKey/openaiBaseUrl…）
 * 在读取时自动合成为 provider 条目，不迁移不写回，保证旧配置零丢失、可回滚。
 */

import { CONFIG_NS, cfg, normalizeUrl, readFallbackRaw, readStrRaw, readUserLevelArray, updateSetting, writeFallbackRaw } from "./config";
import { warn } from "./log";
import { getToken, hasToken } from "./oauth/tokenStore";
import { isPlaceholder, keySlot, resolveKeyValue } from "./keyPlaceholder";
import { ApiKeyVault, initApiKeys, mergeForWrite, resolveLegacyKey, type KeySettingsPort, type RawSlotLocation } from "./apiKeys";
import { ANTHROPIC_URLS, ANTIGRAVITY_URLS, CODEX_URLS, KIMI_URLS, KIRO_URLS, VendorSpec, XAI_URLS, getVendor } from "./oauth/vendors";
import { CatalogProvider, catalogProvider, catalogProviders } from "./modelCatalog";
import { clientUserAgent, sessionIdFor } from "./clientIdentity";

/**
 * 上游协议：anthropic=/v1/messages；openai=/chat/completions 或 /responses（见 openaiApi）；
 * gemini=Google generateContent（AI Studio 官方 API，以及走 Gemini 协议的 Antigravity 登录）；
 * kiro=Kiro 官方后端（CodeWhisperer generateAssistantResponse）——Kiro 发来的请求体原样转发、
 * 响应 event-stream 原样回传，只换鉴权；仅用于「Kiro 官方」登录厂商。
 */
export type Protocol = "anthropic" | "openai" | "gemini" | "kiro";
/**
 * 鉴权方式：key=API Key（缺省，填在 apiKey）；oauth=第三方账号登录（Kimi / Codex / xAI / Antigravity / Anthropic），
 * token 存在 tokenStore（系统钥匙串）里按 provider id 取，apiKey 留空。
 */
export type AuthKind = "key" | "oauth";
/** anthropic 协议的两种子形态：kiro=深度兼容(注入 Kiro 私有字段)；official=纯 Anthropic 直通。 */
export type AnthropicMode = "kiro" | "official";
/**
 * openai 协议的两种接口：chat=/chat/completions（绝大多数中转站）；responses=/responses
 * （OpenAI 新一代接口，GPT-5 系与部分网关只开这个）。缺省 chat。
 */
export type OpenaiApi = "chat" | "responses";
/** UI 上的「API 格式」：四选一，落到 protocol(+openaiApi) 上；kiro 不可手选，只随「Kiro 官方」登录出现。 */
export type ApiFormat = "anthropic" | "chat" | "responses" | "gemini" | "kiro";

export function apiFormatOf(p: Pick<ProviderConfig, "protocol" | "openaiApi">): ApiFormat {
  if (p.protocol === "anthropic") {
    return "anthropic";
  }
  if (p.protocol === "gemini") {
    return "gemini";
  }
  if (p.protocol === "kiro") {
    return "kiro";
  }
  return p.openaiApi === "responses" ? "responses" : "chat";
}

/** 「API 格式」→ protocol/openaiApi 字段（anthropicMode 另给）。 */
export function fieldsForFormat(f: ApiFormat): Pick<ProviderConfig, "protocol" | "openaiApi"> {
  if (f === "anthropic") {
    return { protocol: "anthropic", openaiApi: undefined };
  }
  if (f === "gemini") {
    return { protocol: "gemini", openaiApi: undefined };
  }
  if (f === "kiro") {
    return { protocol: "kiro", openaiApi: undefined };
  }
  return { protocol: "openai", openaiApi: f === "responses" ? "responses" : "chat" };
}

/** 单个模型的能力手动覆盖（Kilo 式「推理/图片」勾选）。undefined=不覆盖，交给目录/推断。 */
export interface ModelOverride {
  image?: boolean;
  reasoning?: boolean;
}

/**
 * 一把凭证（key 池里的一条）。key 类填 apiKey；OAuth 类 apiKey 留空，token 在 tokenStore 里按
 * `<providerId>/<credentialId>` 存（首条沿用裸 providerId 作键，兼容升级前的数据）。
 */
export interface Credential {
  /** provider 内唯一（c1 / c2 …）。首条固定为 PRIMARY_CREDENTIAL_ID。 */
  id: string;
  /** 备注名（「主 key」「备用」…），空则 UI 显示序号。 */
  label?: string;
  apiKey?: string;
  /** 越小越优先；priority 策略按它排，least-used 策略平局时按它。 */
  priority: number;
  /** 手动停用：不参与调度，但保留配置。 */
  enabled: boolean;
}

/** 首条凭证的 id：它的 apiKey / token 同时镜像在 provider.apiKey / tokenStore[providerId] 上。 */
export const PRIMARY_CREDENTIAL_ID = "c1";

/** key 池的调度策略：priority=主备（默认，会话粘住 + 挂了才切）；least-used=分摊（选累计成功最少的）。 */
export type PoolStrategy = "priority" | "least-used";

export interface ProviderConfig {
  /** 稳定唯一 id，路由与 UI 都用它。 */
  id: string;
  /** 展示名。 */
  name: string;
  protocol: Protocol;
  /** 仅 anthropic 协议有意义；openai 忽略。缺省 kiro。 */
  anthropicMode?: AnthropicMode;
  /** 仅 openai 协议有意义；anthropic 忽略。缺省 chat。 */
  openaiApi?: OpenaiApi;
  baseUrl: string;
  /**
   * 首条凭证的 Key。历史字段，保留是为了向后兼容（旧版本读到的 settings 仍能用）；
   * 新代码一律走 credentialsOf(p)，写入时由 syncPrimaryCredential 保持两处一致。
   */
  apiKey: string;
  enabled: boolean;
  /**
   * key 池：同一渠道的 N 把凭证，对 Kiro 表现为一个条目。缺省 / 空数组 = 只有 apiKey 那一把
   * （读时由 credentialsOf 合成，不落盘）。OAuth 类 provider 的每条对应一个已登录账号。
   */
  credentials?: Credential[];
  /** 多把凭证时的调度策略，缺省 priority。 */
  poolStrategy?: PoolStrategy;
  /**
   * baseUrl 是精确前缀：后面直接拼 /chat/completions、/messages 等，不再按「没 /vN 就补 /v1」的
   * 启发式插版本段。models.dev 登记的地址都是这种（如 https://api.kilo.ai/api/gateway、
   * https://api.githubcopilot.com）。手填的地址缺省仍走启发式，保持老行为。
   */
  exactBase?: boolean;
  /** 鉴权方式，缺省 key。 */
  auth?: AuthKind;
  /** auth=oauth 时的厂商 id（kimi / codex / xai / antigravity / anthropic），决定登录流程、请求头与内置模型目录。 */
  oauthVendor?: string;
  /**
   * 仅 auth=oauth：放行用户自填的宿主。缺省 false——登录类 provider 的 token 只发往厂商规格地址
   * （见 allowedOAuthHosts），baseUrl 被改到别处时不发 token、provider 不可用。为 true 时该 baseUrl 的宿主
   * 也进允许集（用户明确要经自建中转转发）。只能在用户设置里写，面板不提供入口。
   */
  allowCustomHost?: boolean;
  /** 该 provider 的模型 ID 映射（Kiro 选中 id → 上游真实 id）。 */
  modelMapping?: Record<string, string>;
  /** 兜底模型（映射未命中时用）。 */
  defaultModel?: string;
  /** 来自哪个预设（UI 展示图标/分组用；纯自定义为空）。 */
  presetId?: string;
  /**
   * 用户手选的头像：`glyph:<name>`（assets/glyphs 里的线性图标）。缺省自动——预设/域名认出的厂商标，
   * 认不出就首字母。
   */
  icon?: string;
  /**
   * 每个模型的能力手动覆盖：`{ [modelId]: { image, reasoning } }`。
   * 优先级最高，压过 models.dev 目录与名字推断。用于中转站/目录都没给能力时用户自己声明。
   */
  modelOverrides?: Record<string, ModelOverride>;
  /**
   * 进入 Kiro 模型列表的模型（按去掉 effort 后缀的 base id 记）。
   *
   * 三种状态：
   *  - `undefined`：全部（含以后上游新增的）——只由旧双通道配置迁移产生，保住升级前
   *    "所有模型都在"的行为，不让升级把用户的选择器清空；
   *  - `[]`：一个都不进——UI 新建/连接的 provider 默认如此（严格 opt-in：连上 provider
   *    只是"能用"，还得到模型页勾选才"出现"）；
   *  - 非空数组：只有这些。
   *
   * 勾了 base id 即含其 `-none/-max` 等 effort 变体，与选择器里"一个模型多档位"的折叠一致。
   */
  enabledModels?: string[];
}

/** 去掉 effort/思考后缀，得到模型的 base id（deepseek-v4-pro-max → deepseek-v4-pro）。 */
export function baseModelId(id: string): string {
  return String(id || "").replace(/-(none|minimal|low|medium|high|xhigh|max)$/i, "");
}

/**
 * 同一个模型 id 在多个渠道都勾了时，Kiro 那边的 id 必须唯一：第一个渠道（按注册顺序）用原 id，
 * 之后的渠道用 `<id>@<providerId>`（providerId 形如 p3 / legacy-anthropic）。名字不变，只是 id 带上归属，
 * 这样 Kiro 选择器里每个渠道的同名模型都能各自被选中、各自路由。
 */
export const MODEL_QUALIFIER_SEP = "@";
export function qualifyModelId(id: string, providerId: string): string {
  return `${id}${MODEL_QUALIFIER_SEP}${providerId}`;
}
/**
 * 拆 `<id>@<providerId>`。尾巴是已知 provider → 限定；尾巴长得像我们生成的 provider id
 * （p12 / legacy-xxx）但 provider 已删 → 仍去掉限定（旧会话带着它发请求，至少裸 id 还能按常规路由）；
 * 其它情况（模型 id 本身含 @）当纯 id。
 */
export function splitQualifiedModelId(kiroId: string): { modelId: string; providerId?: string } {
  const s = String(kiroId || "");
  const at = s.lastIndexOf(MODEL_QUALIFIER_SEP);
  if (at <= 0 || at === s.length - 1) {
    return { modelId: s };
  }
  const tail = s.slice(at + 1);
  if (getProviders().some((p) => p.id === tail) || /^(p\d+|legacy-[a-z]+)$/.test(tail)) {
    return { modelId: s.slice(0, at), providerId: tail };
  }
  return { modelId: s };
}
/** 去掉渠道限定，得到上游认识的裸模型 id。 */
export function bareModelId(kiroId: string): string {
  return splitQualifiedModelId(kiroId).modelId;
}
/**
 * 给一串（按渠道顺序排好的）模型分配 Kiro id：同名（忽略大小写）第一次出现用原 id，之后的带渠道限定。
 * cpsServer 广播列表和面板模型页都用它，保证两边对同一行算出同一个 id。
 */
export function kiroModelIds(entries: Array<{ id: string; providerId: string }>): string[] {
  const firstOwner = new Map<string, string>();
  return entries.map((e) => {
    const key = e.id.toLowerCase();
    const owner = firstOwner.get(key);
    if (owner === undefined) {
      firstOwner.set(key, e.providerId);
      return e.id;
    }
    return owner === e.providerId ? e.id : qualifyModelId(e.id, e.providerId);
  });
}

/** 该模型是否被选进 Kiro 列表。见 ProviderConfig.enabledModels 的三态说明。 */
export function isModelEnabled(p: ProviderConfig, modelId: string): boolean {
  if (p.enabledModels === undefined) {
    return true;
  }
  if (p.enabledModels.length === 0) {
    return false;
  }
  const id = String(modelId || "").toLowerCase();
  const base = baseModelId(id);
  for (const e of p.enabledModels) {
    const el = String(e || "").toLowerCase();
    if (el === id || el === base) {
      return true;
    }
  }
  return false;
}

export interface Preset {
  id: string;
  name: string;
  protocol: Protocol;
  anthropicMode?: AnthropicMode;
  openaiApi?: OpenaiApi;
  baseUrl: string;
  /** baseUrl 是精确前缀（见 ProviderConfig.exactBase）。 */
  exactBase?: boolean;
  /** API Key 输入框占位提示。 */
  keyHint: string;
  /** 该服务的说明/申请页，UI 上可点。 */
  docsUrl?: string;
  /** 简短说明，UI 卡片副标题。 */
  blurb: string;
  /** 来源：手写内置 / models.dev 目录。 */
  source?: "builtin" | "models.dev";
  /** 热门（选择弹窗默认可见）；其余收在「查看更多提供商」里。 */
  popular?: boolean;
  /** models.dev 登记的模型数（副标题用）。 */
  modelCount?: number;
  /** 对应的 models.dev provider id（/models 拉不到时用它的清单）。 */
  catalogId?: string;
}

/**
 * 内置预设：填好 baseURL，用户只需贴 Key。
 * 覆盖你点选的「OpenRouter / DeepSeek / 官方 Anthropic / 官方 OpenAI / 通用中转站」。
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "generic-anthropic",
    name: "通用中转站 (Anthropic 格式)",
    protocol: "anthropic",
    anthropicMode: "kiro",
    baseUrl: "",
    keyHint: "sk-...",
    blurb: "kiro2cc-proxy 一类，保留 Kiro 私有字段与思考/计费显示",
  },
  {
    id: "generic-openai",
    name: "通用中转站 (OpenAI 格式)",
    protocol: "openai",
    baseUrl: "",
    keyHint: "sk-...",
    blurb: "任意 OpenAI /v1/chat/completions 兼容端点",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
    blurb: "一个 Key 聚合上百家模型",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "sk-...",
    docsUrl: "https://platform.deepseek.com/api_keys",
    blurb: "DeepSeek 官方 API",
  },
  {
    id: "official-openai",
    name: "OpenAI 官方",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    docsUrl: "https://platform.openai.com/api-keys",
    blurb: "OpenAI 官方直连（自带 key）",
  },
  {
    id: "official-anthropic",
    name: "Anthropic 官方",
    protocol: "anthropic",
    anthropicMode: "official",
    baseUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    blurb: "Anthropic 官方直连（自带 key，纯 /v1/messages）",
  },
  {
    id: "official-gemini",
    name: "Google Gemini 官方",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyHint: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    blurb: "Google AI Studio 的 Gemini API（自带 key，generateContent）",
  },
] as const;

/** 内置预设都算热门；并标上对应的 models.dev id，避免目录里再出一条重复的。 */
const BUILTIN_CATALOG_ID: Record<string, string> = {
  openrouter: "openrouter",
  deepseek: "deepseek",
  "official-openai": "openai",
  "official-anthropic": "anthropic",
  "official-gemini": "google",
};

/**
 * AI SDK 包名 → 协议 + （api 为空时的）默认地址。models.dev 里 172 家是 openai-compatible 并带地址；
 * 少数厂商用专用 SDK、api 留空，地址就是 SDK 里写死的那个。需要云凭证/多字段配置的（Bedrock、Azure、
 * Vertex、Watsonx…）不在表里 → 不生成预设，这些不是「填 key 即用」。
 */
export const SDK_TABLE: Record<string, { protocol: Protocol; openaiApi?: OpenaiApi; anthropicMode?: AnthropicMode; defaultBase?: string }> = {
  "@ai-sdk/openai-compatible": { protocol: "openai", openaiApi: "chat" },
  "@ai-sdk/openai": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.openai.com/v1" },
  "@ai-sdk/anthropic": { protocol: "anthropic", anthropicMode: "official", defaultBase: "https://api.anthropic.com/v1" },
  "@ai-sdk/google": { protocol: "gemini", defaultBase: "https://generativelanguage.googleapis.com/v1beta" },
  "@ai-sdk/xai": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.x.ai/v1" },
  "@ai-sdk/groq": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.groq.com/openai/v1" },
  "@ai-sdk/mistral": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.mistral.ai/v1" },
  "@ai-sdk/togetherai": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.together.xyz/v1" },
  "@ai-sdk/cerebras": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.cerebras.ai/v1" },
  "@ai-sdk/deepinfra": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.deepinfra.com/v1/openai" },
  "@ai-sdk/perplexity": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.perplexity.ai" },
  "@ai-sdk/cohere": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.cohere.ai/compatibility/v1" },
  "@openrouter/ai-sdk-provider": { protocol: "openai", openaiApi: "chat", defaultBase: "https://openrouter.ai/api/v1" },
  "@aihubmix/ai-sdk-provider": { protocol: "openai", openaiApi: "chat", defaultBase: "https://aihubmix.com/v1" },
  "@ai-sdk/gateway": { protocol: "openai", openaiApi: "chat", defaultBase: "https://ai-gateway.vercel.sh/v1" },
  "@ai-sdk/vercel": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.v0.dev/v1" },
  "venice-ai-sdk-provider": { protocol: "openai", openaiApi: "chat", defaultBase: "https://api.venice.ai/api/v1" },
};

/**
 * 推荐排序：Kilo 的 PROVIDER_PRIORITY 打头（Anthropic / DeepSeek / OpenAI / Google / OpenRouter），再是国内常用与主流聚合站。
 * 选择弹窗永远只直接列 RECOMMENDED_COUNT（10）家——已经连上的不再列，就从这张榜上往后补位，所以榜要比 10 长；
 * 其余一两百家收进「查看更多供应商」弹窗。
 */
export const RECOMMENDED_COUNT = 10;
export const POPULAR_ORDER = [
  "anthropic", "deepseek", "openai", "google", "openrouter",
  "kimi-for-coding", "zhipuai", "alibaba-cn", "minimax", "siliconflow",
  "moonshotai", "volcengine", "xai", "groq", "mistral", "togetherai", "fireworks-ai", "aihubmix", "302ai",
  "kilo", "opencode", "github-copilot", "cerebras", "nvidia", "huggingface",
];

/** 由 models.dev 的一条 provider 造预设；不适合「填 key 即用」的返回 undefined。 */
export function presetFromCatalog(cp: CatalogProvider): Preset | undefined {
  const sdk = SDK_TABLE[cp.npm];
  if (!sdk) {
    return undefined;
  }
  let base = cp.api.replace(/\/+$/, "");
  if (base.includes("${")) {
    return undefined; // 地址里要填账号 id 之类的占位符，不是通用地址
  }
  if (!base) {
    base = sdk.defaultBase || "";
  }
  if (!base) {
    return undefined;
  }
  const rank = POPULAR_ORDER.indexOf(cp.id);
  return {
    id: "md:" + cp.id,
    name: cp.name,
    protocol: sdk.protocol,
    openaiApi: sdk.protocol === "openai" ? sdk.openaiApi ?? "chat" : undefined,
    anthropicMode: sdk.protocol === "anthropic" ? sdk.anthropicMode ?? "official" : undefined,
    baseUrl: base,
    exactBase: true,
    keyHint: cp.env[0] || "API Key",
    docsUrl: cp.doc,
    blurb: `${apiFormatLabel(sdk.protocol, sdk.openaiApi)}${cp.env[0] ? " · " + cp.env[0] : ""}`,
    source: "models.dev",
    popular: rank >= 0,
    modelCount: cp.models.length,
    catalogId: cp.id,
  };
}

function apiFormatLabel(protocol: Protocol, openaiApi?: OpenaiApi): string {
  if (protocol === "anthropic") {
    return "Anthropic";
  }
  if (protocol === "gemini") {
    return "Gemini";
  }
  return openaiApi === "responses" ? "Responses" : "Chat";
}

/**
 * 全部预设 = 手写内置（热门，带说明）+ models.dev 衍生（去掉与内置重复的、去掉不能填 key 即用的）。
 * 排序：热门按 POPULAR_ORDER，其余按名字。目录未就绪时只有内置那几条。
 */
export function allPresets(): Preset[] {
  const builtin: Preset[] = PRESETS.filter((p) => p.baseUrl).map((p) => ({
    ...p,
    source: "builtin" as const,
    popular: true,
    catalogId: BUILTIN_CATALOG_ID[p.id],
    modelCount: BUILTIN_CATALOG_ID[p.id] ? catalogProvider(BUILTIN_CATALOG_ID[p.id])?.models.length : undefined,
  }));
  const covered = new Set(Object.values(BUILTIN_CATALOG_ID));
  const derived: Preset[] = [];
  for (const cp of catalogProviders()) {
    if (covered.has(cp.id)) {
      continue;
    }
    const ps = presetFromCatalog(cp);
    if (ps) {
      derived.push(ps);
    }
  }
  const rankOf = (ps: Preset) => {
    const cid = ps.catalogId || "";
    const i = POPULAR_ORDER.indexOf(cid);
    return i >= 0 ? i : ps.source === "builtin" ? 0 : 1e6;
  };
  return [...builtin, ...derived].sort((a, b) => {
    const pa = a.popular ? 0 : 1, pb = b.popular ? 0 : 1;
    if (pa !== pb) {
      return pa - pb;
    }
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) {
      return ra - rb;
    }
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
}

export function getPreset(id: string | undefined): Preset | undefined {
  if (!id) {
    return undefined;
  }
  return PRESETS.find((p) => p.id === id) || allPresets().find((p) => p.id === id);
}

const STORE_KEY = "providers";

/** 归一出一个 provider 的 id（`coerce` 与 `buildRawSlotIndex` 共用，保证两处认的是同一个 id）。 */
function providerIdOf(r: Record<string, unknown>, index: number): string {
  return typeof r.id === "string" && r.id.trim() ? r.id.trim() : `p${index + 1}`;
}

/**
 * c1 槽位在原文里取哪个值：旧字段 `apiKey` 与 `credentials[0].apiKey` 的胜者——**与 `coerce` 的注水同一条规则**。
 * 两处共用它，于是「迁移收集到的值」与「注水解出来的值」不可能不一致（否则会把一个被覆盖的旧值搬进钥匙串）。
 */
function primaryRaw(
  providerId: string,
  rawApiKey: string,
  rawCred0: string,
  cred0Present: boolean
): { raw: string; field: string } {
  const slot = keySlot(providerId, PRIMARY_CREDENTIAL_ID);
  const apiKeyResolved = resolveKeyValue(rawApiKey, slot);
  const cred0Resolved = resolveKeyValue(rawCred0, slot);
  if (!isPlaceholder(rawApiKey) && apiKeyResolved !== "" && cred0Resolved !== apiKeyResolved) {
    return { raw: rawApiKey, field: "apiKey" };
  }
  return cred0Present ? { raw: rawCred0, field: "credentials[0].apiKey" } : { raw: rawApiKey, field: "apiKey" };
}

/** 校验并归一一条 provider 记录，非法则返回 undefined。 */
function coerce(raw: unknown, index: number): ProviderConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const protocol: Protocol =
    r.protocol === "openai" ? "openai" : r.protocol === "gemini" ? "gemini" : r.protocol === "kiro" ? "kiro" : "anthropic";
  const id = providerIdOf(r, index);
  const anthropicMode: AnthropicMode = r.anthropicMode === "official" ? "official" : "kiro";
  const openaiApi: OpenaiApi = r.openaiApi === "responses" ? "responses" : "chat";
  const modelMapping =
    r.modelMapping && typeof r.modelMapping === "object"
      ? (r.modelMapping as Record<string, string>)
      : undefined;
  const modelOverrides =
    r.modelOverrides && typeof r.modelOverrides === "object"
      ? (r.modelOverrides as Record<string, ModelOverride>)
      : undefined;
  // 缺省 undefined（=全部）而非 []：settings.json 里手写的 provider 没写这个字段时
  // 按"全部"理解，与 3.x 之前的行为一致；UI 新建的会显式写 []。
  const enabledModels = Array.isArray(r.enabledModels)
    ? (r.enabledModels as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : undefined;
  const auth: AuthKind | undefined = r.auth === "oauth" ? "oauth" : undefined;
  const apiKey = typeof r.apiKey === "string" ? r.apiKey.trim() : "";
  const { credentials, slots } = normalizeCredentials(r.credentials, auth === "oauth", id, index, apiKey);
  const p: ProviderConfig = {
    id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : id,
    protocol,
    anthropicMode: protocol === "anthropic" ? anthropicMode : undefined,
    openaiApi: protocol === "openai" ? openaiApi : undefined,
    baseUrl: normalizeUrl(typeof r.baseUrl === "string" ? r.baseUrl : ""),
    apiKey,
    enabled: r.enabled !== false,
    credentials,
    poolStrategy: r.poolStrategy === "least-used" ? "least-used" : r.poolStrategy === "priority" ? "priority" : undefined,
    exactBase: r.exactBase === true ? true : undefined,
    auth,
    oauthVendor: auth === "oauth" && typeof r.oauthVendor === "string" && r.oauthVendor.trim() ? r.oauthVendor.trim() : undefined,
    allowCustomHost: auth === "oauth" && r.allowCustomHost === true ? true : undefined,
    modelMapping,
    defaultModel: typeof r.defaultModel === "string" ? r.defaultModel.trim() : undefined,
    presetId: typeof r.presetId === "string" ? r.presetId : undefined,
    modelOverrides,
    enabledModels,
  };
  hydrateKeys(p, apiKey, slots);
  syncPrimaryCredential(p);
  return p;
}

/**
 * 读取侧注水（D5）：把 settings 里读到的占位标记换成钥匙串真值。顺序**不可调换**。
 *
 * 为什么「旧字段 apiKey 覆盖 c1」的规则要从 `coerceCredentials` 挪到这里：迁移之后
 * `r.apiKey` 与 `credentials[0].apiKey` 都是**非空占位**，先覆盖再注水会把用户在
 * `credentials[0].apiKey` 上手填的**新明文覆盖成占位**，随后注水读到钥匙串里的旧值，
 * 下一次 `saveProviders` 又把占位写回 → 新明文永久消失且从未进钥匙串。
 * 改成「比较**解析后**的值」后，占位（旧字段）对上明文（首条凭证）时明文胜出，那个明文就是待迁移的新值。
 */
function hydrateKeys(p: ProviderConfig, rawApiKey: string, slots: Map<string, RawSlotLocation>): void {
  const slot0 = keySlot(p.id, PRIMARY_CREDENTIAL_ID);
  const rawCred0 = slots.get(slot0)?.raw ?? rawApiKey;
  const apiKeyResolved = resolveKeyValue(rawApiKey, slot0);
  const cred0Resolved = resolveKeyValue(rawCred0, slot0);
  const winner =
    !isPlaceholder(rawApiKey) && apiKeyResolved !== "" && cred0Resolved !== apiKeyResolved ? apiKeyResolved : cred0Resolved;
  if (p.credentials && p.credentials.length > 0) {
    p.credentials[0].apiKey = winner || undefined;
    for (let i = 1; i < p.credentials.length; i++) {
      const c = p.credentials[i];
      const slot = keySlot(p.id, c.id);
      c.apiKey = resolveKeyValue(slots.get(slot)?.raw ?? "", slot) || undefined;
    }
  }
  p.apiKey = winner;
}

/**
 * 把 settings 原文映射成 `槽位 → 原文位置`。**必须与 `coerce` 共用同一套归一序**（本函数与 `coerce`
 * 同调 `normalizeCredentials`），否则迁移会搬错值、失败回退会回退错字段。
 */
export function buildRawSlotIndex(rawProviders: unknown[]): Map<string, RawSlotLocation> {
  const out = new Map<string, RawSlotLocation>();
  rawProviders.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const r = raw as Record<string, unknown>;
    const id = providerIdOf(r, index);
    const apiKey = typeof r.apiKey === "string" ? r.apiKey.trim() : "";
    const { slots } = normalizeCredentials(r.credentials, r.auth === "oauth", id, index, apiKey);
    for (const [slot, loc] of slots) {
      if (!out.has(slot)) {
        out.set(slot, loc);
      }
    }
  });
  return out;
}

/** 归一 + 槽位表（`coerce` 与 `buildRawSlotIndex` 的唯一入口）。 */
function normalizeCredentials(
  raw: unknown,
  oauth: boolean,
  providerId: string,
  providerIndex: number,
  rawApiKey: string
): { credentials: Credential[] | undefined; slots: Map<string, RawSlotLocation> } {
  const slots = new Map<string, RawSlotLocation>();
  const norm = coerceCredentials(raw, oauth);
  if (oauth) {
    // OAuth 类 provider 的 key 字段永远是空的（token 在钥匙串里按裸键存），槽位表里没有它，
    // 于是「槽位集合 == expectedSlots(归一列表)」这条自洽性对两种 provider 都成立。
    return { credentials: norm.credentials, slots };
  }
  if (!norm.credentials || norm.credentials.length === 0) {
    // 没写 credentials：c1 的原文就是旧字段 apiKey
    slots.set(keySlot(providerId, PRIMARY_CREDENTIAL_ID), {
      providerIndex,
      providerId,
      credentialId: PRIMARY_CREDENTIAL_ID,
      field: "apiKey",
      raw: rawApiKey,
    });
    return { credentials: undefined, slots };
  }
  const rawCred0 = norm.rawKeys.get(PRIMARY_CREDENTIAL_ID) ?? rawApiKey;
  const primary = primaryRaw(providerId, rawApiKey, rawCred0, norm.rawKeys.has(PRIMARY_CREDENTIAL_ID));
  slots.set(keySlot(providerId, PRIMARY_CREDENTIAL_ID), {
    providerIndex,
    providerId,
    credentialId: PRIMARY_CREDENTIAL_ID,
    field: primary.field,
    raw: primary.raw,
  });
  for (let i = 1; i < norm.credentials.length; i++) {
    const c = norm.credentials[i];
    slots.set(keySlot(providerId, c.id), {
      providerIndex,
      providerId,
      credentialId: c.id,
      field: `credentials[${i}].apiKey`,
      raw: norm.rawKeys.get(c.id) ?? "",
    });
  }
  return { credentials: norm.credentials, slots };
}

/**
 * 归一 credentials 数组：去掉非法项、补 id / priority、保证首条是 c1。
 * 没写或为空 → credentials undefined（读时按"只有 apiKey 这一把"理解，见 credentialsOf）。
 * `rawKeys` 是「归一号 → 该条目在原文里的 apiKey 串」，供槽位表使用。
 */
function coerceCredentials(raw: unknown, oauth: boolean): { credentials: Credential[] | undefined; rawKeys: Map<string, string> } {
  const rawKeys = new Map<string, string>();
  if (!Array.isArray(raw) || raw.length === 0) {
    return { credentials: undefined, rawKeys };
  }
  // 先把合法条目挑出来，并保留它们显式写的 id（首次出现者优先）；没写 / 非法 / 重复的 id 第二遍再补号。
  // 若边扫边补号，一条排在前面、没写 id 的凭证会抢走 "c1"，随后被旧字段 apiKey 覆盖——那把 key 就丢了，
  // 而用户显式标成 c1（带备注 / 优先级）的那条被改名挪走。
  const items: Array<{ c: Record<string, unknown>; key: string; id: string }> = [];
  const used = new Set<string>();
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const c = item as Record<string, unknown>;
    const key = typeof c.apiKey === "string" ? c.apiKey.trim() : "";
    // key 类：没 key 的条目没意义（OAuth 类的 key 天然为空，靠 token 仓判断）
    if (!oauth && !key) {
      continue;
    }
    let cid = typeof c.id === "string" && /^c\d+$/.test(c.id.trim()) ? c.id.trim() : "";
    if (cid && used.has(cid)) {
      cid = "";
    }
    if (cid) {
      used.add(cid);
    }
    items.push({ c, key, id: cid });
  }
  const out: Credential[] = [];
  for (const it of items) {
    if (!it.id) {
      it.id = freshCredentialId(Array.from(used, (id) => ({ id })));
      used.add(it.id);
    }
    const c = it.c;
    out.push({
      id: it.id,
      label: typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 40) : undefined,
      apiKey: it.key || undefined,
      priority: typeof c.priority === "number" && isFinite(c.priority) ? Math.max(0, Math.floor(c.priority)) : out.length,
      enabled: c.enabled !== false,
    });
    rawKeys.set(it.id, it.key);
  }
  if (out.length === 0) {
    return { credentials: undefined, rawKeys };
  }
  // 首条必须是 c1（它镜像到 apiKey / tokenStore[providerId]）；不是就把 c1 挪到最前，没有 c1 就把第一条改名
  const idx = out.findIndex((c) => c.id === PRIMARY_CREDENTIAL_ID);
  if (idx > 0) {
    out.unshift(...out.splice(idx, 1));
  } else if (idx < 0) {
    // 第一条改名成 c1：它在原文里的值跟着搬到新号上
    const oldKey = rawKeys.get(out[0].id) ?? "";
    out[0].id = PRIMARY_CREDENTIAL_ID;
    rawKeys.set(PRIMARY_CREDENTIAL_ID, oldKey);
  }
  // 旧字段 apiKey 与 c1 不一致时「以 apiKey 为准」的规则**移出本函数**：
  // 迁移之后两个字段都是占位，先覆盖再注水会吃掉用户在 credentials[0] 上手填的明文。
  // 现在的落点是 coerce 的 hydrateKeys（比较解析后的值），见那里的注释。
  return { credentials: out, rawKeys };
}

export function freshCredentialId(existing: Array<{ id: string }>): string {
  const used = new Set(existing.map((c) => c.id));
  for (let i = 1; i < 10000; i++) {
    const id = `c${i}`;
    if (!used.has(id)) {
      return id;
    }
  }
  return `c${Date.now()}`;
}

/**
 * 该 provider 的凭证列表（永远非空、首条为 c1）。没显式写 credentials 时合成一条：
 * key 类用 apiKey，OAuth 类是空 key 的占位（token 按 providerId 取）。
 */
export function credentialsOf(p: ProviderConfig): Credential[] {
  if (p.credentials && p.credentials.length > 0) {
    return p.credentials;
  }
  return [{ id: PRIMARY_CREDENTIAL_ID, apiKey: p.auth === "oauth" ? undefined : p.apiKey || undefined, priority: 0, enabled: true }];
}

/** 是否真的配了多把（UI 上决定显示"key 池"还是单个 Key 框）。 */
export function hasPool(p: ProviderConfig): boolean {
  return (p.credentials?.length || 0) > 1;
}

/**
 * 把 c1 的 key 镜像回历史字段 apiKey（反向也成立：只有 apiKey 没 credentials 时不动）。
 * 写盘前调用，保证旧版本 / 其它读 apiKey 的地方看到的是首条凭证。
 */
export function syncPrimaryCredential(p: ProviderConfig): void {
  if (!p.credentials || p.credentials.length === 0) {
    return;
  }
  if (p.auth !== "oauth") {
    p.apiKey = p.credentials[0].apiKey || "";
  }
}

/** OAuth token 在 tokenStore 里的键：首条沿用裸 providerId（兼容升级前），其余带凭证后缀。 */
export function tokenKeyOf(providerId: string, credentialId: string): string {
  return credentialId === PRIMARY_CREDENTIAL_ID ? providerId : `${providerId}/${credentialId}`;
}

/**
 * 凭证的自定义备注（没有就是空串）。不再自动起「主凭证 / 凭证 2」这类名字：面板里每行本来就有序号，
 * 登录类显示账号邮箱、Key 类显示掩码，够辨认了；起了名反而让首条和后续账号的行长得不一样。
 */
export function credentialLabel(c: Credential): string {
  return c.label || "";
}

/**
 * 查一个模型在某 provider 下的手动能力覆盖。宽松匹配：精确 id 优先，其次去 effort
 * 后缀的 base id（deepseek-v4-pro-max 命中用户对 deepseek-v4-pro 的设置）。
 */
export function overrideFor(p: ProviderConfig | undefined, modelId: string): ModelOverride | undefined {
  if (!p?.modelOverrides) {
    return undefined;
  }
  const exact = p.modelOverrides[modelId];
  if (exact) {
    return exact;
  }
  const base = baseModelId(modelId);
  return base !== modelId ? p.modelOverrides[base] : undefined;
}

/**
 * 旧「双通道」配置 → provider 数组。
 *
 * 仅当注册表为空时使用（首次升级 / 从未配过 providers）。读时合成，不写回：
 * 用户一旦在新面板保存，就以注册表为准，旧键从此忽略但保留在 settings.json 里可回滚。
 */
function migrateFromLegacy(): ProviderConfig[] {
  const c = cfg();
  const out: ProviderConfig[] = [];

  const routing = (c.get<string>("routing", "merge") || "merge").trim();
  const mode = (c.get<string>("mode", "kiro") || "kiro").trim() === "anthropic" ? "official" : "kiro";

  const anthBase = normalizeUrl(
    mode === "official" ? c.get<string>("officialBaseUrl", "") || "" : c.get<string>("baseUrl", "") || ""
  );
  const anthKey = resolveLegacyKey(
    mode === "official" ? c.get<string>("officialApiKey", "") || "" : c.get<string>("apiKey", "") || "",
    mode === "official" ? "officialApiKey" : "apiKey"
  ).trim();
  if (anthBase || anthKey) {
    out.push({
      id: "legacy-anthropic",
      name: mode === "official" ? "Anthropic 官方（迁移）" : "Anthropic 中转（迁移）",
      protocol: "anthropic",
      anthropicMode: mode,
      baseUrl: anthBase,
      apiKey: anthKey,
      enabled: routing !== "openaiOnly",
      modelMapping:
        c.get<Record<string, string>>(mode === "official" ? "officialModelMapping" : "modelMapping", {}) ||
        undefined,
      defaultModel:
        (c.get<string>(mode === "official" ? "officialDefaultModel" : "defaultModel", "") || "").trim() ||
        undefined,
      presetId: mode === "official" ? "official-anthropic" : "generic-anthropic",
    });
  }

  const oaiBase = normalizeUrl(c.get<string>("openaiBaseUrl", "") || "");
  const oaiKey = resolveLegacyKey(c.get<string>("openaiApiKey", "") || "", "openaiApiKey").trim();
  const oaiEnabledFlag = c.get<boolean>("openaiEnabled", false);
  if (oaiBase || oaiKey) {
    out.push({
      id: "legacy-openai",
      name: "OpenAI 通道（迁移）",
      protocol: "openai",
      baseUrl: oaiBase,
      apiKey: oaiKey,
      enabled: routing === "openaiOnly" || (routing === "merge" && oaiEnabledFlag),
      modelMapping: c.get<Record<string, string>>("openaiModelMapping", {}) || undefined,
      defaultModel: (c.get<string>("openaiDefaultModel", "") || "").trim() || undefined,
      presetId: "generic-openai",
    });
  }

  return out;
}

/**
 * 读注册表。空则回退到旧配置合成（读时迁移，不写回）。
 *
 * 只取用户级值：工作区 / 工作区文件夹层的 providers 一律忽略（仓库不能决定 Key 与 token 发往哪里），
 * 出现时记一条 warn；工作区值消失后再出现会再记一次。见 config.readUserLevelArray。
 */
export function getProviders(): ProviderConfig[] {
  const { value: raw, shadowed } = readUserLevelArray(STORE_KEY);
  noteWorkspaceShadow(shadowed);
  if (raw.length > 0) {
    return raw.map(coerce).filter((p): p is ProviderConfig => !!p);
  }
  return migrateFromLegacy();
}

let workspaceShadowWarned = false;

/**
 * 交给 `apiKeys.ts` 的设置端口：**只读写设置**，钥匙串操作全在 `ApiKeyVault` 里。
 * 归一序（`slotIndexFor`）与 `coerce` 共用 `normalizeCredentials`，不存在第二套实现。
 */
const keySettingsPort: KeySettingsPort = {
  readProviders: () => readUserLevelArray(STORE_KEY).value,
  readProviderList: () => getProviders(),
  slotIndexFor: (raw) => buildRawSlotIndex(raw),
  credentialsOf: (p) => credentialsOf(p),
  writeProviders: (list) => updateSetting(STORE_KEY, list),
  readLegacyRaw: (key) => readStrRaw(key),
  writeLegacy: (key, value) => updateSetting(key, value),
  readFallback: (key) => readFallbackRaw(key),
  writeFallback: async (key, value) => {
    try {
      await writeFallbackRaw(key, value);
      return { settingsOk: true };
    } catch (e) {
      return { settingsOk: false, error: (e as Error)?.message || String(e) };
    }
  },
};

let vault: ApiKeyVault | undefined;

/** 本模块自己的 vault 实例：写入漏斗不依赖 `initApiKeys` 的调用顺序。 */
function keyVault(): ApiKeyVault {
  if (!vault) {
    vault = new ApiKeyVault({ port: keySettingsPort });
  }
  return vault;
}

/** activate 里调用：把同一个端口交给 `apiKeys` 的模块级包装（迁移与旧键读取用）。 */
export function initApiKeySettings(): void {
  initApiKeys(keySettingsPort);
}

/** 仅测试用：拿到本模块组装的那份设置端口（测试要自己造 `ApiKeyVault` 注入假日志时用）。 */
export function _keySettingsPortForTest(): KeySettingsPort {
  return keySettingsPort;
}

function noteWorkspaceShadow(shadowed: boolean): void {
  if (!shadowed) {
    workspaceShadowWarned = false;
    return;
  }
  if (workspaceShadowWarned) {
    return;
  }
  workspaceShadowWarned = true;
  warn(`工作区级 ${CONFIG_NS}.${STORE_KEY} 已被忽略：该项只在用户设置里生效（scope: machine），本次按用户级值读取`);
}

/**
 * 写整张注册表。写前把 c1 镜像回 apiKey，两处永远一致。
 *
 * 三段（顺序即语义）：
 *  ① `persistProviderKeys`：后端闸 → 写钥匙串 → 穿透存储层确认 → 回收孤儿槽位。只产出失败槽位，**任何一个都不外抛**；
 *  ② 写 settings 之前的原文快照（失败时按 provider 级整体回退用）；
 *  ③ **无条件**写 settings：metadata（改名 / 勾选模型 / 开关…）必须落盘，Key 字段按失败槽位决定写占位还是回退原文。
 */
export async function saveProviders(
  list: ProviderConfig[]
): Promise<{ ok: boolean; error?: string; keySlotsFailed?: string[] }> {
  for (const p of list) {
    syncPrimaryCredential(p);
  }
  const keySlotsFailed = await keyVault().persistProviderKeys(list);
  const previousRaw = readUserLevelArray(STORE_KEY).value;
  const r = await updateSetting(STORE_KEY, mergeForWrite(keySettingsPort, list, previousRaw, new Set(keySlotsFailed)));
  return { ok: r.settingsOk, error: r.error, keySlotsFailed };
}

export function getProvider(id: string): ProviderConfig | undefined {
  return getProviders().find((p) => p.id === id);
}

export function isOAuthProvider(p: Pick<ProviderConfig, "auth">): boolean {
  return p.auth === "oauth";
}

// ---------------------------------------------------------------------------------------
// OAuth token 只发往厂商规格地址
//
// 登录类 provider 的 baseUrl 存在 settings 里，而 token 存在钥匙串里按 provider id 取——两者原本没有绑定：
// 谁能改 settings（旧版工作台会把仓库 .vscode/settings.json 合并进来）就能让 token 发去任意主机。
// 这里把「允许把 token 发往哪些宿主」从**运行时**的 VendorSpec 派生（spec.baseUrl 与厂商表里其它会带 token
// 请求的地址），不硬编码域名：_setVendorUrlsForTest 把规格指到 127.0.0.1 时允许集随之变化，测试套件不用改。
// 只校验 provider.baseUrl（四条 dispatch 与 /models 都从它拼 URL）；Kiro 直通按 token 的 region 用
// apiBaseFor 定域、地址来自钥匙串而非 settings，不在校验范围内。key 类 provider 不受影响。
// ---------------------------------------------------------------------------------------

/** URL 的 scheme 与 host（hostname[:port]，小写）；不是 http(s) 地址返回 undefined。 */
function parseOrigin(url: string): { scheme: "http" | "https"; host: string } | undefined {
  const m = /^(https?):\/\/([^/?#\s]+)/i.exec(String(url || "").trim());
  if (!m) {
    return undefined;
  }
  // 去掉 userinfo；host 里的端口保留（127.0.0.1:19871 与 127.0.0.1:19872 是两个宿主）
  const host = m[2].replace(/^[^@]*@/, "").toLowerCase();
  return host ? { scheme: m[1].toLowerCase() as "http" | "https", host } : undefined;
}

/**
 * 厂商表里会带 access token 去请求的地址（当前运行时的值）。Kiro 的模板含 `{region}`，匹配时当一个域名段。
 * 刷新 / 授权端点不在其中——那里发的是 refresh token / 授权码，与 provider.baseUrl 无关。
 */
function vendorRequestUrls(vendorId: string): string[] {
  switch (vendorId) {
    case "kimi":
      return [KIMI_URLS.api];
    case "codex":
      return [CODEX_URLS.api];
    case "xai":
      return [XAI_URLS.api];
    case "antigravity":
      return [ANTIGRAVITY_URLS.api, ANTIGRAVITY_URLS.daily];
    case "anthropic":
      return [ANTHROPIC_URLS.api];
    case "kiro":
      return [KIRO_URLS.api, KIRO_URLS.runtime, KIRO_URLS.q];
    default:
      return [];
  }
}

/**
 * 该 OAuth 厂商的 token 允许发往的宿主集合（`hostname[:port]`，小写；Kiro 的 `runtime.{region}.kiro.dev` 保留
 * `{region}` 占位）。由运行时 spec.baseUrl 与厂商表派生；`allowCustomHost` 为 true 时 provider 自己的 baseUrl
 * 宿主也在其中。规格未知返回空集。纯函数，无副作用。
 */
export function allowedOAuthHosts(
  spec: Pick<VendorSpec, "id" | "baseUrl"> | undefined,
  provider?: Pick<ProviderConfig, "baseUrl" | "allowCustomHost">
): Set<string> {
  const out = new Set<string>();
  if (spec) {
    for (const url of [spec.baseUrl, ...vendorRequestUrls(spec.id)]) {
      const o = parseOrigin(url);
      if (o) {
        out.add(o.host);
      }
    }
  }
  if (provider?.allowCustomHost === true) {
    const o = parseOrigin(provider.baseUrl);
    if (o) {
      out.add(o.host);
    }
  }
  return out;
}

/** host 是否命中集合里的某一项（`{region}` 占位匹配一个 `[a-z0-9-]+` 域名段，其余逐字）。 */
export function oauthHostMatches(hosts: Iterable<string>, host: string): boolean {
  const h = String(host || "").toLowerCase();
  if (!h) {
    return false;
  }
  for (const pat of hosts) {
    if (pat === h) {
      return true;
    }
    if (pat.includes("{region}")) {
      const re = new RegExp("^" + pat.split("{region}").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$");
      if (re.test(h)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 该 provider 的 baseUrl（或指定 url）是否允许作为其 OAuth token 的发送目标。
 * key 类恒 true；`allowCustomHost` 为 true 恒 true；否则宿主必须在 allowedOAuthHosts 里，且不得从规格的
 * https 降级为 http（规格本身是 http 时——测试把厂商指到本机——不限制）。规格未知一律 false。
 */
export function isOAuthHostAllowed(
  p: Pick<ProviderConfig, "auth" | "oauthVendor" | "baseUrl" | "allowCustomHost">,
  url: string = p.baseUrl
): boolean {
  if (!isOAuthProvider(p)) {
    return true;
  }
  if (p.allowCustomHost === true) {
    return true;
  }
  const spec = getVendor(p.oauthVendor);
  const target = parseOrigin(url);
  if (!spec || !target) {
    return false;
  }
  if (target.scheme === "http" && parseOrigin(spec.baseUrl)?.scheme !== "http") {
    return false;
  }
  return oauthHostMatches(allowedOAuthHosts(spec, p), target.host);
}

/** 拒绝原因（面板状态 / 引导文案 / 抛错用）；允许时返回 undefined。不含任何凭据。 */
export function oauthHostRejection(p: Pick<ProviderConfig, "name" | "auth" | "oauthVendor" | "baseUrl" | "allowCustomHost">): string | undefined {
  if (isOAuthHostAllowed(p)) {
    return undefined;
  }
  const spec = getVendor(p.oauthVendor);
  const vendorName = spec?.name || p.oauthVendor || "未知厂商";
  const specHost = spec ? parseOrigin(spec.baseUrl)?.host || spec.baseUrl : "—";
  const host = parseOrigin(p.baseUrl)?.host || p.baseUrl || "(空)";
  return `地址 ${host} 不是「${vendorName}」的规格地址（${specHost}），已拒绝向它发送登录凭据；确需经自建中转转发，请在用户设置里给该 provider 加 allowCustomHost: true`;
}

/** 每个 provider 对同一个被拒地址只记一条 warn；地址换了或恢复正常后再出问题会再记。 */
const hostRejectionLogged = new Map<string, string>();

/**
 * 请求前的宿主门：允许返回 undefined；拒绝时记一条 warn（不含 token）并返回原因。
 * ensureAccessToken（取 token 前）与 authHeaders（造头前）都经过这里，任何一条路径都发不出 token。
 */
export function checkOAuthHost(p: ProviderConfig): string | undefined {
  const reason = oauthHostRejection(p);
  if (!reason) {
    hostRejectionLogged.delete(p.id);
    return undefined;
  }
  if (hostRejectionLogged.get(p.id) !== p.baseUrl) {
    hostRejectionLogged.set(p.id, p.baseUrl);
    warn(`[${p.name}] ${reason}`);
  }
  return reason;
}

/** 某把凭证是否配置齐全：key 类有 key；oauth 类在 token 仓里有 token。 */
export function isCredentialConfigured(p: ProviderConfig, c: Credential): boolean {
  return isOAuthProvider(p) ? hasToken(tokenKeyOf(p.id, c.id)) : !!c.apiKey;
}

/** 启用且配置齐全的凭证（调度候选集，未考虑冷却）。 */
export function configuredCredentials(p: ProviderConfig): Credential[] {
  return credentialsOf(p).filter((c) => c.enabled && isCredentialConfigured(p, c));
}

/**
 * 配置完整才算「可用」：有地址，且至少一把凭证配置齐全（key 类有 key / oauth 类已登录）；
 * oauth 类还要求地址是厂商规格宿主（或显式 allowCustomHost），否则不进路由、不进模型列表
 * （被拒时经 checkOAuthHost 记一条 warn，同一地址不重复）。
 */
export function isProviderUsable(p: ProviderConfig): boolean {
  if (!p.baseUrl) {
    return false;
  }
  if (isOAuthProvider(p) && checkOAuthHost(p)) {
    return false;
  }
  return configuredCredentials(p).length > 0;
}

/** 缺什么（krsServer 的引导文案 / UI 状态用）。 */
export function providerMissing(p: ProviderConfig): string | undefined {
  if (!p.enabled) {
    return "已停用";
  }
  if (isOAuthProvider(p)) {
    const rejected = oauthHostRejection(p);
    if (rejected) {
      return rejected;
    }
    return configuredCredentials(p).length > 0 ? undefined : "未登录";
  }
  const hasKey = configuredCredentials(p).length > 0;
  if (!p.baseUrl && !hasKey) {
    return "缺少地址和 Key";
  }
  if (!p.baseUrl) {
    return "缺少地址";
  }
  if (!hasKey) {
    return "缺少 API Key";
  }
  return undefined;
}

/** 启用且可用的 provider —— 真正参与模型合并与路由的集合。 */
export function getActiveProviders(): ProviderConfig[] {
  return getProviders().filter((p) => p.enabled && isProviderUsable(p));
}

/** 生成一个不与现有 id 冲突的新 id。 */
export function freshProviderId(existing: ProviderConfig[]): string {
  const used = new Set(existing.map((p) => p.id));
  for (let i = 1; i < 10000; i++) {
    const id = `p${i}`;
    if (!used.has(id)) {
      return id;
    }
  }
  return `p${Date.now()}`;
}

/** 从预设造一条新 provider（未填 key）。模型默认一个都不进列表，等用户到模型页勾选。 */
export function providerFromPreset(preset: Preset, existing: ProviderConfig[]): ProviderConfig {
  return {
    id: freshProviderId(existing),
    name: preset.name,
    protocol: preset.protocol,
    anthropicMode: preset.protocol === "anthropic" ? preset.anthropicMode ?? "kiro" : undefined,
    openaiApi: preset.protocol === "openai" ? preset.openaiApi ?? "chat" : undefined,
    baseUrl: preset.baseUrl,
    exactBase: preset.exactBase ? true : undefined,
    apiKey: "",
    enabled: false,
    presetId: preset.id,
    enabledModels: [],
  };
}

/** 该 provider 对应的 models.dev 目录条目（内置预设经映射表；md: 预设直接取）。 */
export function catalogProviderFor(p: Pick<ProviderConfig, "presetId">): CatalogProvider | undefined {
  const pid = p.presetId || "";
  if (!pid) {
    return undefined;
  }
  if (pid.startsWith("md:")) {
    return catalogProvider(pid.slice(3));
  }
  const mapped = BUILTIN_CATALOG_ID[pid];
  return mapped ? catalogProvider(mapped) : undefined;
}

/** 登录厂商 → 图标 id（OpenCode 图标库按 models.dev id 命名；Codex 就是 OpenAI 的标，Antigravity 用 Google 的）。 */
const OAUTH_VENDOR_ICON: Record<string, string> = {
  kimi: "kimi-for-coding",
  codex: "openai",
  xai: "xai",
  antigravity: "google",
  anthropic: "anthropic",
  kiro: "kiro",
};

function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

/** 合法的手选头像值：glyph:<lucide 名>（只允许小写字母、数字、连字符）。 */
export function normalizeIcon(v: unknown): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const s = v.trim();
  return /^glyph:[a-z0-9-]{1,40}$/.test(s) ? s : undefined;
}

/**
 * provider 的图标 id。用户手选的（icon 字段）优先；否则自动认：
 * 预设建的直接映射到 OpenCode / Kilo 图标库的文件名（= models.dev 的 provider id）；登录类查厂商表；
 * 自定义的按 Base URL 的域名到目录里认——例如手填 api.deepseek.com 也能拿到 DeepSeek 的标。
 * 认不出返回 ""，前端退回首字母。
 */
export function providerIconId(p: Pick<ProviderConfig, "presetId" | "baseUrl" | "auth" | "oauthVendor" | "icon">): string {
  const chosen = normalizeIcon(p.icon);
  if (chosen) {
    return chosen;
  }
  return autoIconId(p);
}

/** 不看手选、只按预设 / 厂商 / 域名自动认出的图标 id（头像选择器里的「自动」项用）。 */
export function autoIconId(p: Pick<ProviderConfig, "presetId" | "baseUrl" | "auth" | "oauthVendor">): string {
  if (p.auth === "oauth") {
    return OAUTH_VENDOR_ICON[p.oauthVendor || ""] || "";
  }
  const pid = p.presetId || "";
  if (pid.startsWith("md:")) {
    return pid.slice(3);
  }
  if (BUILTIN_CATALOG_ID[pid]) {
    return BUILTIN_CATALOG_ID[pid];
  }
  const host = hostOf(p.baseUrl || "");
  if (!host) {
    return "";
  }
  for (const cp of catalogProviders()) {
    const h = hostOf(cp.api || SDK_TABLE[cp.npm]?.defaultBase || "");
    if (h && h === host) {
      return cp.id;
    }
  }
  return "";
}

/** 预设 / 登录厂商的图标 id（同上，给选择弹窗用）。 */
export function presetIconId(ps: Pick<Preset, "catalogId">): string {
  return ps.catalogId || "";
}
export function vendorIconId(vendorId: string): string {
  return OAUTH_VENDOR_ICON[vendorId] || "";
}

/**
 * 从 OAuth 厂商造一条新 provider（token 另存 tokenStore）。登录即可用：enabled=true；
 * 模型仍是严格 opt-in（enabledModels=[]），等用户在登录弹窗 / 模型页勾选。
 */
export function providerFromOAuthVendor(vendorId: string, existing: ProviderConfig[], account?: string): ProviderConfig {
  const spec = getVendor(vendorId);
  if (!spec) {
    throw new Error("未知的登录厂商：" + vendorId);
  }
  const f = fieldsForFormat(spec.format);
  const names = new Set(existing.map((x) => x.name));
  // 名字只用厂商名（账号显示在行副标题里）；同厂商第二个账号起加序号。
  let name = spec.name;
  for (let n = 2; names.has(name); n++) {
    name = `${spec.name} ${n}`;
  }
  void account;
  return {
    id: freshProviderId(existing),
    name,
    protocol: f.protocol,
    openaiApi: f.openaiApi,
    anthropicMode: f.protocol === "anthropic" ? spec.anthropicMode ?? "official" : undefined,
    baseUrl: spec.baseUrl,
    apiKey: "",
    enabled: true,
    auth: "oauth",
    oauthVendor: spec.id,
    presetId: "oauth-" + spec.id,
    enabledModels: [],
  };
}

/**
 * 往 provider 的 key 池追加一把凭证，返回新条目。首次追加时把隐含的 c1 物化出来。
 * key 类必须给 apiKey；OAuth 类 apiKey 留空，调用方随后把 token 存到 tokenKeyOf(p.id, cred.id)。
 */
export function addCredential(p: ProviderConfig, init: { apiKey?: string; label?: string }): Credential {
  const list = [...credentialsOf(p)];
  const cred: Credential = {
    id: freshCredentialId(list),
    label: init.label?.trim() ? init.label.trim().slice(0, 40) : undefined,
    apiKey: p.auth === "oauth" ? undefined : (init.apiKey || "").trim() || undefined,
    priority: list.reduce((m, c) => Math.max(m, c.priority), -1) + 1,
    enabled: true,
  };
  list.push(cred);
  p.credentials = list;
  syncPrimaryCredential(p);
  return cred;
}

/**
 * 从池里移除一把凭证。c1 不能直接删（它镜像着 apiKey / 裸 providerId 的 token）：删 c1 时把下一条
 * 提升为 c1——返回值告诉调用方需要把哪把 token 挪到裸 providerId 键上。
 */
export function removeCredential(
  p: ProviderConfig,
  credentialId: string
): { removed: Credential; promotedFromId?: string } | undefined {
  const list = [...credentialsOf(p)];
  const idx = list.findIndex((c) => c.id === credentialId);
  if (idx < 0) {
    return undefined;
  }
  const [removed] = list.splice(idx, 1);
  let promotedFromId: string | undefined;
  if (removed.id === PRIMARY_CREDENTIAL_ID && list.length > 0) {
    promotedFromId = list[0].id;
    list[0] = { ...list[0], id: PRIMARY_CREDENTIAL_ID };
  }
  p.credentials = list.length > 0 ? list : undefined;
  if (list.length === 0) {
    p.apiKey = "";
  }
  syncPrimaryCredential(p);
  return { removed, promotedFromId };
}

/**
 * 解析 URL：/models 等 API 路径。anthropic 与 openai 都是 /vN 版本化，规则一致。
 * OAuth 厂商的 baseUrl 是完整前缀（Codex 的 /backend-api/codex 没有版本段），原样拼接。
 */
export function resolveApiUrl(p: ProviderConfig, apiPath: string): string {
  if (!p.baseUrl) {
    return "";
  }
  const path = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  // 精确前缀（models.dev 预设 / 登录厂商）与已带版本段（/v1、/v1beta、/v4…）的地址原样拼
  if (p.exactBase || isOAuthProvider(p) || /\/v\d+(alpha|beta)?$/i.test(p.baseUrl)) {
    return p.baseUrl + path;
  }
  return p.baseUrl + "/v1" + path;
}

/** 解析相对根（剥掉 /vN）的 URL：用量/仪表盘类接口。 */
export function resolveRootUrl(p: ProviderConfig, apiPath: string): string {
  if (!p.baseUrl) {
    return "";
  }
  const root = p.baseUrl.replace(/\/v\d+$/i, "");
  const path = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  return root + path;
}

/**
 * 该 provider 用某把凭证的鉴权头（缺省首条）。OAuth 类用缓存里的 token 按厂商规则造头
 * （调用方在请求前应先 `ensureAccessToken` 让它新鲜）；key 类按协议给 Bearer / x-api-key。
 *
 * `sessionKey` 是本次请求所属的会话 id（Kiro 的 conversationId）。只有少数上游要它
 * （见 clientRequiredHeaders），但**所有**发往上游的请求头都从这里出，所以在这里统一合并，
 * 聊天、测活、拉模型列表四条路径不会漏。
 */
export function authHeaders(p: ProviderConfig, stream = false, cred?: Credential, sessionKey?: string): Record<string, string> {
  return { ...baseAuthHeaders(p, stream, cred), ...clientRequiredHeaders(p, sessionKey) };
}

/**
 * 上游**要求客户端自己发**的头，缺了就直接 400。按地址认端点、而不是按预设 id：
 * 用户手填地址、从别处（CC Switch）导入、或以后 models.dev 改了条目，都还能命中同一个端点。
 * 目前表里只有 OpenCode Go 一家。
 */
function clientRequiredHeaders(p: ProviderConfig, sessionKey?: string): Record<string, string> {
  if (!isOpencodeGo(p)) {
    return {};
  }
  // OpenCode Go 的硬要求：会话 id 必须在同一会话内稳定（路由亲和 + 提示缓存），
  // 且客户端得自报家门（它明确不要通用 SDK / HTTP 库的 UA）。
  return { "x-opencode-session": sessionIdFor(sessionKey), "User-Agent": clientUserAgent() };
}

/**
 * 是不是 OpenCode Go 通道（opencode.ai/zen/go）。
 *
 * 只认 /zen/go：同域同源的另一条通道 opencode.ai/zen/v1（Zen 本体）不要求这个头，别顺带发过去。
 * 预设建出来的（presetId = md:opencode-go）地址被改到自建中转时照样算——要求跟的是这条通道，
 * 不是那个域名。
 */
function isOpencodeGo(p: Pick<ProviderConfig, "baseUrl" | "presetId">): boolean {
  if (p.presetId === "md:opencode-go") {
    return true;
  }
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(p.baseUrl || "");
  if (!m) {
    return false;
  }
  const host = m[1].toLowerCase().replace(/:\d+$/, "");
  if (host !== "opencode.ai" && host !== "www.opencode.ai") {
    return false;
  }
  return /^\/zen\/go(\/|$)/i.test(m[2] || "");
}

/** 协议自带的鉴权头（不含上游额外要求的客户端头，见 authHeaders）。 */
function baseAuthHeaders(p: ProviderConfig, stream = false, cred?: Credential): Record<string, string> {
  const c = cred || credentialsOf(p)[0];
  if (isOAuthProvider(p)) {
    // 地址不是厂商规格宿主 → 不造任何带 token 的头（上层 isProviderUsable / ensureAccessToken 已先拦，这里是最后一道）
    if (checkOAuthHost(p)) {
      return {};
    }
    const spec = getVendor(p.oauthVendor);
    const tok = getToken(tokenKeyOf(p.id, c.id));
    return spec && tok ? spec.headers(tok, stream) : {};
  }
  const key = c.apiKey || "";
  if (p.protocol === "openai") {
    return { Authorization: "Bearer " + key };
  }
  if (p.protocol === "gemini") {
    // Gemini 官方 API 认 x-goog-api-key 头（也可 ?key=，头更干净）
    return { "x-goog-api-key": key };
  }
  const h: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // 官方兼容网关通常认 Bearer；深度兼容中转站两者都带无害。
  h["Authorization"] = "Bearer " + key;
  return h;
}
