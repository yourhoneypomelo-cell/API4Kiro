/**
 * 第三方账号登录（OAuth）厂商表：Kimi / Codex(OpenAI) / xAI / Antigravity(Google) / Anthropic(Claude)。
 *
 * 每家一条 VendorSpec：怎么登录、怎么刷新、登录后请求打到哪、带什么头、有哪些模型、
 * 请求体要改什么。端点与 client id 全部来自 CLIProxyAPI（internal/auth/*）与各家官方客户端的
 * 公开注册信息——Kimi/Codex/xAI/Anthropic 是「公开客户端」没有 secret；Antigravity 是桌面应用内置的
 * Google OAuth 客户端（id+secret 都在安装包里，CPA 也是照抄）。
 *
 * 登录后的 provider：`auth:"oauth"` + `oauthVendor`，baseUrl 用 spec.baseUrl **原样**
 * （不再追加 /v1），鉴权头由 spec.headers(token) 给，token 在 tokenStore 里按 provider id 存。
 *
 * Anthropic 只做「如实自报家门的第三方客户端」这一种：走它面向第三方公开的 Sign in with Claude，
 * 用量计入账号的「额外用量」。不把请求伪装成 Claude Code 去占订阅套餐额度——那条路 Anthropic 明令禁止、
 * 会封号，CPA 为此维护 2000+ 行且频繁失效。见下方 Anthropic 段的说明。
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ApiFormat, AnthropicMode } from "../providers";
import type { OAuthToken } from "./tokenStore";
import {
  CancelSignal,
  DeviceCode,
  LoginCancelled,
  expiresAtFrom,
  generatePkce,
  getJsonAuth,
  noticePageHtml,
  openCallbackServer,
  openLoopbackCallback,
  parseDeviceCode,
  parseJwtPayload,
  pollDeviceToken,
  postForm,
  postJson,
  randomState,
  randomUuid,
} from "./core";

export type OAuthVendorId = "kimi" | "codex" | "xai" | "antigravity" | "anthropic" | "kiro";

export interface VendorModel {
  id: string;
  name: string;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
}

/**
 * 厂商在线拉到的模型条目（比内置目录多的元数据）。目前只有 Kiro 官方给：ListAvailableModels 的
 * tokenLimits / supportedInputTypes / additionalModelRequestFieldsSchema 原样带回，CPS 端照抄给 Kiro。
 */
export interface VendorLiveModel extends VendorModel {
  description?: string;
  maxOutputTokens?: number;
  /** 官方声明的 effort 取值（从 additionalModelRequestFieldsSchema 里抠出来），CPS 直接广播。 */
  effortLevels?: string[];
  effortSchemaPath?: string;
  defaultEffortLevel?: string;
  /** 官方 schema 原文；有它时 CPS 原样透传，不再自己拼。 */
  requestFieldsSchema?: unknown;
}

/**
 * 同一厂商可选的登录方式（目前只有 Kiro 官方分这么多种）：
 *  browser=走它的浏览器登录门户；import=读本机登录态；token=手填 access / refresh token；
 *  json=粘贴凭证 JSON（IDE 的 kiro-auth-token.json 或各家工具导出的格式）；apikey=Kiro 协议网关的 Base URL + Key。
 */
export type LoginMode =
  | "import"
  | "browser"
  | "oauth"
  | "token"
  | "access_token"
  | "json"
  | "apikey"
  | "api_key";

/** 需要用户手填的登录方式的表单项（UI 按这个渲染，填好的值原样进 LoginContext.input）。 */
export interface LoginField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  /** 密文输入（带眼睛切换）。 */
  secret?: boolean;
  /** 多行（textarea）。 */
  multiline?: boolean;
  /** 输入框下面的一行小字说明。 */
  hint?: string;
}

export interface LoginModeSpec {
  id: LoginMode;
  label: string;
  hint: string;
  /** 有表单项的方式：弹窗先让用户填，再开始；没有的直接开始（开浏览器 / 读文件）。 */
  fields?: LoginField[];
}

/** 登录过程给 UI 的回调。 */
export interface LoginContext {
  signal: CancelSignal;
  /** 用户在弹窗里选的登录方式；厂商只有一种时不传。 */
  mode?: LoginMode;
  /** 该方式表单里填的值（key 对应 LoginField.key）。 */
  input?: Record<string, string>;
  openUrl(url: string): void;
  /** 设备码流程：把 user code 与确认链接显示给用户。 */
  onDeviceCode(dc: DeviceCode): void;
  /** 授权码流程：已打开浏览器，等待回跳。 */
  onWaitingBrowser(url: string): void;
  /** 阶段文案（"正在换取 token…"）。 */
  onPhase(text: string): void;
}

export interface VendorSpec {
  id: OAuthVendorId;
  name: string;
  /** 卡片副标题。 */
  blurb: string;
  /** device=设备码；pkce=浏览器授权码；import=直接读本机已有的登录态（Kiro 官方），不开浏览器。 */
  flow: "device" | "pkce" | "import";
  /** 有多种登录方式的厂商列出来（连接弹窗一种一行；login(ctx) 按 ctx.mode 分派）。缺省只有 flow 那一种。 */
  loginModes?: LoginModeSpec[];
  /** Kiro 自己的账号（不是「第三方」）：连接弹窗里单独一组、置顶。 */
  official?: boolean;
  /** 授权码流程的本机回调端口（UI 提示「浏览器会跳回 localhost:<port>」用）。 */
  callbackPort?: number;
  /** 登录后 provider 的 baseUrl，原样使用（已含版本段）。 */
  baseUrl: string;
  format: ApiFormat;
  anthropicMode?: AnthropicMode;
  /** 注册 / 订阅页，UI 上「立即注册」。 */
  signupUrl?: string;
  /** 该按钮的文案（缺省「立即注册」；Anthropic 是「开启额外用量」）。 */
  signupLabel?: string;
  /** 内置模型目录（这些接口大多没有 /models）。 */
  models: VendorModel[];
  /** 按账号（套餐）裁剪后的目录；不实现=全部。Codex 的 free / team / plus 能用的模型不同。 */
  modelsFor?(tok: OAuthToken): VendorModel[];
  /** 是否再试一次 GET {baseUrl}/models 与内置目录合并。 */
  tryModelsEndpoint?: boolean;
  /** 「测延迟」用的 GET 路径（缺省 /models）。Codex 的 /models 必须带 client_version 否则 400。 */
  latencyPath?: string;
  headers(tok: OAuthToken, stream: boolean): Record<string, string>;
  login(ctx: LoginContext): Promise<OAuthToken>;
  refresh(tok: OAuthToken): Promise<OAuthToken>;
  /** 上游请求体修正（Codex 拒绝 max_output_tokens 等）。 */
  adjustBody?(body: Record<string, unknown>, format: ApiFormat): void;
  /** 在线拉该账号的模型清单（Kiro 官方 ListAvailableModels）；拉不到时调用方退回内置目录。 */
  listModels?(tok: OAuthToken): Promise<VendorLiveModel[]>;
  /** 该账号请求实际打到哪个域（按 token 里的 region）；不实现 = provider.baseUrl。 */
  apiBaseFor?(tok: OAuthToken): string;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEVICE_MAX_WAIT_SEC = 15 * 60;
/** 设备码轮询下限（秒）；测试时调小。 */
let devicePollMinIntervalSec = 5;

function deviceModel(): string {
  const plat = os.platform();
  const name = plat === "win32" ? "Windows" : plat === "darwin" ? "macOS" : plat === "linux" ? "Linux" : plat;
  return `${name} ${os.arch()}`;
}

function hostName(): string {
  try {
    return os.hostname() || "unknown";
  } catch {
    return "unknown";
  }
}

/** 扩展版本，请求头里带（Kimi 的 X-Msh-Version）。由 extension 启动时设置。 */
let clientVersion = "0.0.0";
export function setOAuthClientVersion(v: string): void {
  clientVersion = v || "0.0.0";
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" && (o[k] as string) ? (o[k] as string) : undefined;
}

// ---------------------------------------------------------------------------------------
// Kimi（Moonshot）— 设备码
// ---------------------------------------------------------------------------------------

export const KIMI_URLS = {
  deviceCode: "https://auth.kimi.com/api/oauth/device_authorization",
  token: "https://auth.kimi.com/api/oauth/token",
  api: "https://api.kimi.com/coding/v1",
};
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

function kimiCommonHeaders(deviceId: string): Record<string, string> {
  return {
    "X-Msh-Platform": "api4kiro",
    "X-Msh-Version": clientVersion,
    "X-Msh-Device-Name": hostName(),
    "X-Msh-Device-Model": deviceModel(),
    "X-Msh-Device-Id": deviceId,
  };
}

function kimiTokenFrom(json: Record<string, unknown>, deviceId: string, prev?: OAuthToken): OAuthToken {
  const accessToken = str(json, "access_token") || "";
  // Kimi 的 token 回复不带身份、也没有 user-info 接口（官方 kimi-cli 同样不知道账号是谁）。
  // 若 access token 恰好是 JWT，尽量从载荷里捞一个可展示的标识；否则就是没有。
  const claims = parseJwtPayload(accessToken);
  const ident = str(claims, "email") || str(claims, "name") || str(claims, "preferred_username") || str(claims, "sub");
  return {
    accessToken,
    refreshToken: str(json, "refresh_token") || prev?.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    tokenType: str(json, "token_type") || "Bearer",
    deviceId,
    email: ident || prev?.email,
    extra: { scope: str(json, "scope") || prev?.extra?.scope || "" },
    updatedAt: Date.now(),
  };
}

const kimi: VendorSpec = {
  id: "kimi",
  name: "Kimi",
  blurb: "Kimi Code 订阅（设备授权登录）· K2.7 Code / K3 等",
  flow: "device",
  baseUrl: KIMI_URLS.api,
  format: "anthropic",
  anthropicMode: "official",
  signupUrl: "https://www.kimi.com/code",
  tryModelsEndpoint: true,
  models: [
    { id: "kimi-for-coding", name: "Kimi K2.7 Code", reasoning: true, contextWindow: 262144 },
    { id: "kimi-for-coding-highspeed", name: "Kimi K2.7 Code · 高速", reasoning: true, contextWindow: 262144 },
    { id: "k3", name: "Kimi K3", reasoning: true },
    { id: "k3-256k", name: "Kimi K3 · 256K", reasoning: true, contextWindow: 262144 },
    { id: "k2.6", name: "Kimi K2.6" },
    { id: "k2.5", name: "Kimi K2.5" },
    { id: "k2-thinking", name: "Kimi K2 Thinking", reasoning: true },
  ],
  headers(tok, stream) {
    return {
      Authorization: "Bearer " + tok.accessToken,
      "anthropic-version": "2023-06-01",
      Accept: stream ? "text/event-stream" : "application/json",
      ...kimiCommonHeaders(tok.deviceId || "api4kiro"),
    };
  },
  async login(ctx) {
    const deviceId = randomUuid();
    const h = kimiCommonHeaders(deviceId);
    ctx.onPhase("正在向 Kimi 申请设备码…");
    const dcRes = await postForm(KIMI_URLS.deviceCode, { client_id: KIMI_CLIENT_ID }, h);
    if (dcRes.status < 200 || dcRes.status >= 300) {
      throw new Error(`申请设备码失败：HTTP ${dcRes.status} ${dcRes.text.slice(0, 160)}`);
    }
    const dc = parseDeviceCode(dcRes.json);
    ctx.onDeviceCode(dc);
    ctx.openUrl(dc.verificationUriComplete || dc.verificationUri);
    const json = await pollDeviceToken({
      attempt: () =>
        postForm(
          KIMI_URLS.token,
          { client_id: KIMI_CLIENT_ID, device_code: dc.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
          h
        ),
      intervalSec: dc.interval,
      expiresInSec: dc.expiresIn,
      maxWaitSec: DEVICE_MAX_WAIT_SEC,
      minIntervalSec: devicePollMinIntervalSec,
      signal: ctx.signal,
    });
    return kimiTokenFrom(json, deviceId);
  },
  async refresh(tok) {
    if (!tok.refreshToken) {
      throw new Error("没有 refresh token，请重新登录");
    }
    const deviceId = tok.deviceId || randomUuid();
    const r = await postForm(
      KIMI_URLS.token,
      { client_id: KIMI_CLIENT_ID, grant_type: "refresh_token", refresh_token: tok.refreshToken },
      kimiCommonHeaders(deviceId)
    );
    if (r.status === 401 || r.status === 403) {
      throw new Error("Kimi 登录已失效，请重新登录");
    }
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`Kimi 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    return kimiTokenFrom(r.json, deviceId, tok);
  },
};

// ---------------------------------------------------------------------------------------
// Codex（OpenAI / ChatGPT 订阅）— 授权码 + PKCE，本机 1455 回调
// ---------------------------------------------------------------------------------------

export const CODEX_URLS = {
  authorize: "https://auth.openai.com/oauth/authorize",
  token: "https://auth.openai.com/oauth/token",
  api: "https://chatgpt.com/backend-api/codex",
  redirect: "http://localhost:1455/auth/callback",
};
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_USER_AGENT = "codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)";
const CODEX_ORIGINATOR = "codex-tui";

function codexTokenFrom(json: Record<string, unknown>, prev?: OAuthToken): OAuthToken {
  const idToken = str(json, "id_token");
  const claims = parseJwtPayload(idToken);
  const auth = (claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined) || {};
  return {
    accessToken: str(json, "access_token") || "",
    refreshToken: str(json, "refresh_token") || prev?.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    tokenType: str(json, "token_type") || "Bearer",
    idToken: idToken || prev?.idToken,
    email: str(claims, "email") || prev?.email,
    accountId: str(auth, "chatgpt_account_id") || prev?.accountId,
    plan: str(auth, "chatgpt_plan_type") || prev?.plan,
    updatedAt: Date.now(),
  };
}

const codex: VendorSpec = {
  id: "codex",
  name: "Codex (OpenAI)",
  blurb: "ChatGPT Plus / Pro / Team 订阅（浏览器授权登录）· GPT-5 系",
  flow: "pkce",
  callbackPort: CODEX_CALLBACK_PORT,
  baseUrl: CODEX_URLS.api,
  format: "responses",
  signupUrl: "https://chatgpt.com/#pricing",
  latencyPath: "/models?client_version=0.146.0",
  models: [
    { id: "gpt-5.5", name: "GPT-5.5", reasoning: true, image: true, contextWindow: 400000 },
    { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, image: true, contextWindow: 400000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true, image: true, contextWindow: 400000 },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", reasoning: true, contextWindow: 400000 },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, image: true },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true, image: true },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, image: true },
  ],
  // 套餐 → 可用模型（对齐 CPA models.json 的 codex-free / codex-team / codex-plus|pro）。
  // 用不该用的会被 400 "not supported when using Codex with a ChatGPT account"。未知套餐给全部。
  modelsFor(tok) {
    const plan = String(tok.plan || "").toLowerCase();
    const only = (ids: string[]) => codex.models.filter((m) => ids.includes(m.id));
    if (plan === "free") {
      return only(["gpt-5.5", "gpt-5.4-mini", "gpt-5.6-terra", "gpt-5.6-luna"]);
    }
    if (plan === "team" || plan === "business" || plan === "enterprise" || plan === "edu") {
      return only(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    }
    return codex.models;
  },
  headers(tok, stream) {
    const h: Record<string, string> = {
      Authorization: "Bearer " + tok.accessToken,
      "User-Agent": CODEX_USER_AGENT,
      Originator: CODEX_ORIGINATOR,
      Accept: stream ? "text/event-stream" : "application/json",
      Connection: "Keep-Alive",
    };
    if (tok.accountId) {
      h["Chatgpt-Account-Id"] = tok.accountId;
    }
    return h;
  },
  async login(ctx) {
    const pkce = generatePkce();
    const state = randomState();
    const q = new URLSearchParams({
      client_id: CODEX_CLIENT_ID,
      response_type: "code",
      redirect_uri: CODEX_URLS.redirect,
      scope: "openid email profile offline_access",
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });
    const authUrl = `${CODEX_URLS.authorize}?${q.toString()}`;
    ctx.onPhase("正在打开浏览器…");
    // 先起回调服务器（端口占用在这里就报错，不会白开一个浏览器页）再开浏览器。
    const cb = await openCallbackServer(CODEX_CALLBACK_PORT, CODEX_CALLBACK_PATH, state, LOGIN_TIMEOUT_MS, ctx.signal);
    ctx.onWaitingBrowser(authUrl);
    ctx.openUrl(authUrl);
    const { code } = await cb.result;
    ctx.onPhase("已收到授权码，正在换取 token…");
    const r = await postForm(CODEX_URLS.token, {
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: CODEX_URLS.redirect,
      code_verifier: pkce.verifier,
    });
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`换取 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    return codexTokenFrom(r.json);
  },
  async refresh(tok) {
    if (!tok.refreshToken) {
      throw new Error("没有 refresh token，请重新登录");
    }
    const r = await postForm(CODEX_URLS.token, {
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: tok.refreshToken,
      scope: "openid profile email",
    });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new Error(`Codex 登录已失效（${str(r.json, "error") || "HTTP " + r.status}），请重新登录`);
    }
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`Codex 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    return codexTokenFrom(r.json, tok);
  },
  adjustBody(body) {
    // Codex 后端拒绝这些字段（"Unsupported parameter"），并要求 store:false / stream:true / instructions 非空。
    delete body.max_output_tokens;
    delete body.max_completion_tokens;
    delete body.temperature;
    delete body.top_p;
    delete body.user;
    delete body.truncation;
    body.store = false;
    body.stream = true;
    if (typeof body.instructions !== "string") {
      body.instructions = "";
    }
    body.include = ["reasoning.encrypted_content"];
  },
};

// ---------------------------------------------------------------------------------------
// xAI（Grok）— OIDC 发现 + 设备码
// ---------------------------------------------------------------------------------------

export const XAI_URLS = {
  discovery: "https://auth.x.ai/.well-known/openid-configuration",
  api: "https://cli-chat-proxy.grok.com/v1",
};
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
/** cli-chat-proxy 要求的最低 Grok CLI 版本会随时间抬高（2026-09 要求 ≥ 0.1.202）；跟 CPA 保持一致。 */
const XAI_CLIENT_VERSION = "0.2.120";

async function xaiDiscover(): Promise<{ device: string; token: string }> {
  const r = await getJsonAuth(XAI_URLS.discovery);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`xAI OIDC 发现失败：HTTP ${r.status}`);
  }
  const device = str(r.json, "device_authorization_endpoint");
  const token = str(r.json, "token_endpoint");
  if (!device || !token) {
    throw new Error("xAI OIDC 发现回复缺少 device_authorization_endpoint / token_endpoint");
  }
  for (const [label, u] of [
    ["device_authorization_endpoint", device],
    ["token_endpoint", token],
  ] as const) {
    let host = "";
    try {
      const parsed = new URL(u);
      host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:" && !host.startsWith("127.") && host !== "localhost") {
        throw new Error("not https");
      }
    } catch {
      throw new Error(`xAI OIDC 发现的 ${label} 非法：${u}`);
    }
    if (!(host === "x.ai" || host.endsWith(".x.ai") || host === "localhost" || host.startsWith("127."))) {
      throw new Error(`xAI OIDC 发现的 ${label} 不在 x.ai 域下：${host}`);
    }
  }
  return { device, token };
}

function xaiTokenFrom(json: Record<string, unknown>, tokenEndpoint: string, prev?: OAuthToken): OAuthToken {
  const idToken = str(json, "id_token");
  const claims = parseJwtPayload(idToken);
  return {
    accessToken: str(json, "access_token") || "",
    refreshToken: str(json, "refresh_token") || prev?.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    tokenType: str(json, "token_type") || "Bearer",
    idToken: idToken || prev?.idToken,
    email: str(claims, "email") || prev?.email,
    accountId: str(claims, "sub") || prev?.accountId,
    extra: { tokenEndpoint },
    updatedAt: Date.now(),
  };
}

const xai: VendorSpec = {
  id: "xai",
  name: "xAI (Grok)",
  blurb: "Grok CLI 账号（设备授权登录）· Grok 4 系",
  flow: "device",
  baseUrl: XAI_URLS.api,
  format: "responses",
  signupUrl: "https://x.ai/grok",
  models: [
    { id: "grok-4.6", name: "Grok 4.6", reasoning: true, image: true },
    { id: "grok-build-0.1", name: "Grok Build 0.1", reasoning: true },
    { id: "grok-4.5", name: "Grok 4.5", reasoning: true, image: true },
    { id: "grok-4.3", name: "Grok 4.3", reasoning: true, image: true },
    { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 · 推理", reasoning: true },
    { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 · 非推理", reasoning: false },
    { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast" },
    { id: "grok-3-mini", name: "Grok 3 mini", reasoning: true },
    { id: "grok-3-mini-fast", name: "Grok 3 mini fast", reasoning: true },
  ],
  headers(tok, stream) {
    // cli-chat-proxy 按这几个头识别 Grok CLI；缺 x-grok-client-version 会回 426 "CLI version (none) is outdated"
    return {
      Authorization: "Bearer " + tok.accessToken,
      "User-Agent": "xai-grok-workspace/" + XAI_CLIENT_VERSION,
      "x-grok-client-version": XAI_CLIENT_VERSION,
      "x-grok-client-identifier": "grok-shell",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      Accept: stream ? "text/event-stream" : "application/json",
      Connection: "Keep-Alive",
    };
  },
  async login(ctx) {
    ctx.onPhase("正在查询 xAI 登录端点…");
    const ep = await xaiDiscover();
    ctx.onPhase("正在向 xAI 申请设备码…");
    const dcRes = await postForm(ep.device, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE });
    if (dcRes.status < 200 || dcRes.status >= 300) {
      throw new Error(`申请设备码失败：HTTP ${dcRes.status} ${dcRes.text.slice(0, 160)}`);
    }
    const dc = parseDeviceCode(dcRes.json);
    ctx.onDeviceCode(dc);
    ctx.openUrl(dc.verificationUriComplete || dc.verificationUri);
    const json = await pollDeviceToken({
      attempt: () =>
        postForm(ep.token, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: dc.deviceCode,
          client_id: XAI_CLIENT_ID,
        }),
      intervalSec: dc.interval,
      expiresInSec: dc.expiresIn,
      maxWaitSec: DEVICE_MAX_WAIT_SEC,
      minIntervalSec: devicePollMinIntervalSec,
      signal: ctx.signal,
    });
    return xaiTokenFrom(json, ep.token);
  },
  async refresh(tok) {
    if (!tok.refreshToken) {
      throw new Error("没有 refresh token，请重新登录");
    }
    const tokenEndpoint = tok.extra?.tokenEndpoint || (await xaiDiscover()).token;
    const r = await postForm(tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: tok.refreshToken,
    });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new Error(`xAI 登录已失效（${str(r.json, "error") || "HTTP " + r.status}），请重新登录`);
    }
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`xAI 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    return xaiTokenFrom(r.json, tokenEndpoint, tok);
  },
  adjustBody(body) {
    delete body.previous_response_id;
    delete body.user;
    delete body.truncation;
    body.store = false;
  },
};

// ---------------------------------------------------------------------------------------
// Antigravity（Google 账号）— 授权码（带 client_secret 的公开桌面客户端），本机 51121 回调；
// 登录后还要向 cloudcode-pa 的 loadCodeAssist / onboardUser 拿到 project id 才能发请求。
// 请求走 Gemini 协议（见 geminiTranslate.antigravityEnvelope）。
// ---------------------------------------------------------------------------------------

export const ANTIGRAVITY_URLS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
  api: "https://cloudcode-pa.googleapis.com",
  daily: "https://daily-cloudcode-pa.googleapis.com",
  redirect: "http://localhost:51121/oauth-callback",
};
const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// Antigravity（Google Cloud Code）登录的 client secret：安装型桌面客户端密钥，随 vsix 分发。
// 不硬编码进公开源码——Google 会扫描 GitHub 并自动吊销泄露的 GOCSPX 密钥。构建时由 esbuild 从本地
// gitignore 的 `antigravity.secret`（或环境变量 A2K_ANTIGRAVITY_CLIENT_SECRET）注入；从源码构建而未提供时为空串，
// 此时 Antigravity 登录需自备 Google OAuth client（见 README）。
const ANTIGRAVITY_CLIENT_SECRET = process.env.A2K_ANTIGRAVITY_CLIENT_SECRET || "";
const ANTIGRAVITY_CALLBACK_PORT = 51121;
const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
/** Cloud Code 对低于 2.9.0 的客户端拒绝新模型；与 CPA 的兜底版本一致。 */
export const ANTIGRAVITY_VERSION = "2.9.1";
export const antigravityUserAgent = () => `antigravity/hub/${ANTIGRAVITY_VERSION} darwin/arm64`;
const antigravityLongUserAgent = () => antigravityUserAgent() + " google-api-nodejs-client/10.3.0";

function antigravityTokenFrom(json: Record<string, unknown>, prev?: OAuthToken): OAuthToken {
  return {
    accessToken: str(json, "access_token") || "",
    refreshToken: str(json, "refresh_token") || prev?.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    tokenType: str(json, "token_type") || "Bearer",
    email: prev?.email,
    extra: prev?.extra ? { ...prev.extra } : {},
    updatedAt: Date.now(),
  };
}

function extractProject(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return "";
  }
  for (const k of ["cloudaicompanionProject", "projectId", "project"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string") {
      return String((v as Record<string, unknown>).id).trim();
    }
  }
  return "";
}

/** loadCodeAssist 拿 project；没有就 onboardUser（免费档）轮询直到 done。 */
async function antigravityFetchProject(accessToken: string, onPhase?: (t: string) => void): Promise<string> {
  const auth = { Authorization: "Bearer " + accessToken, Accept: "*/*" };
  onPhase?.("正在获取 Antigravity 项目信息…");
  const load = await postJson(`${ANTIGRAVITY_URLS.api}/v1internal:loadCodeAssist`, { metadata: { ideType: "ANTIGRAVITY" } }, { ...auth, "User-Agent": antigravityUserAgent() });
  if (load.status < 200 || load.status >= 300) {
    throw new Error(`loadCodeAssist 失败：HTTP ${load.status} ${load.text.slice(0, 160)}`);
  }
  const direct = extractProject(load.json);
  if (direct) {
    return direct;
  }
  // 挑默认档位
  let tier = "free-tier";
  const tiers = Array.isArray(load.json.allowedTiers) ? (load.json.allowedTiers as Array<Record<string, unknown>>) : [];
  const def = tiers.find((t) => t && t.isDefault === true && typeof t.id === "string");
  if (def) {
    tier = String(def.id);
  } else if (load.json.currentTier && typeof (load.json.currentTier as Record<string, unknown>).id === "string") {
    tier = String((load.json.currentTier as Record<string, unknown>).id);
  }
  onPhase?.("首次使用，正在开通（onboardUser）…");
  const body = {
    tier_id: tier,
    metadata: { ide_type: "ANTIGRAVITY", ide_version: ANTIGRAVITY_VERSION, ide_name: "antigravity" },
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await postJson(`${ANTIGRAVITY_URLS.daily}/v1internal:onboardUser`, body, {
      ...auth,
      "User-Agent": antigravityLongUserAgent(),
      "X-Goog-Api-Client": "gl-node/22.21.1",
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`onboardUser 失败：HTTP ${r.status} ${r.text.slice(0, 200)}`);
    }
    if (r.json.done === true) {
      const p = extractProject(r.json.response as Record<string, unknown> | undefined);
      if (!p) {
        throw new Error("onboardUser 完成但没有返回 project id");
      }
      return p;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("onboardUser 轮询 5 次仍未完成，请稍后重试登录");
}

const antigravity: VendorSpec = {
  id: "antigravity",
  name: "Antigravity (Google)",
  blurb: "Google 账号登录（浏览器授权）· Gemini 3 系 / Claude 4.6 / GPT-OSS",
  flow: "pkce",
  callbackPort: ANTIGRAVITY_CALLBACK_PORT,
  baseUrl: ANTIGRAVITY_URLS.api,
  format: "gemini",
  signupUrl: "https://antigravity.google/",
  models: [
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (high)", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (high)", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (low)", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "gemini-pro-agent", name: "Gemini Pro (Agent)", reasoning: true, image: true, contextWindow: 1048576 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, image: true, contextWindow: 200000 },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", reasoning: true, image: true, contextWindow: 200000 },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (medium)", reasoning: true, contextWindow: 114000 },
  ],
  headers(tok, stream) {
    return {
      Authorization: "Bearer " + tok.accessToken,
      "User-Agent": antigravityUserAgent(),
      Accept: stream ? "text/event-stream" : "application/json",
    };
  },
  async login(ctx) {
    const state = randomState();
    const q = new URLSearchParams({
      access_type: "offline",
      client_id: ANTIGRAVITY_CLIENT_ID,
      prompt: "consent",
      redirect_uri: ANTIGRAVITY_URLS.redirect,
      response_type: "code",
      scope: ANTIGRAVITY_SCOPES.join(" "),
      state,
    });
    const authUrl = `${ANTIGRAVITY_URLS.authorize}?${q.toString()}`;
    ctx.onPhase("正在打开浏览器…");
    const cb = await openCallbackServer(ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_CALLBACK_PATH, state, LOGIN_TIMEOUT_MS, ctx.signal);
    ctx.onWaitingBrowser(authUrl);
    ctx.openUrl(authUrl);
    const { code } = await cb.result;
    ctx.onPhase("已收到授权码，正在换取 token…");
    const r = await postForm(ANTIGRAVITY_URLS.token, {
      code,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      redirect_uri: ANTIGRAVITY_URLS.redirect,
      grant_type: "authorization_code",
    });
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`换取 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    const tok = antigravityTokenFrom(r.json);
    // 账号邮箱（展示用，失败不致命）
    try {
      const ui = await getJsonAuth(ANTIGRAVITY_URLS.userinfo, { Authorization: "Bearer " + tok.accessToken, "User-Agent": antigravityUserAgent() });
      tok.email = str(ui.json, "email");
    } catch {
      /* ignore */
    }
    const project = await antigravityFetchProject(tok.accessToken, ctx.onPhase);
    tok.extra = { ...(tok.extra || {}), project };
    return tok;
  },
  async refresh(tok) {
    if (!tok.refreshToken) {
      throw new Error("没有 refresh token，请重新登录");
    }
    const r = await postForm(ANTIGRAVITY_URLS.token, {
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: tok.refreshToken,
      grant_type: "refresh_token",
    });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new Error(`Google 登录已失效（${str(r.json, "error") || "HTTP " + r.status}），请重新登录`);
    }
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`Google 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    const next = antigravityTokenFrom(r.json, tok);
    if (!next.extra?.project) {
      // 老 token 里没有 project（理论上不会）：补一次
      try {
        next.extra = { ...(next.extra || {}), project: await antigravityFetchProject(next.accessToken) };
      } catch {
        /* 下次请求再补 */
      }
    }
    return next;
  },
};

// ---------------------------------------------------------------------------------------
// Anthropic（Claude 账号）— 授权码 + PKCE，本机 54545 回调
//
// 走的是 Anthropic 面向第三方应用公开的「Sign in with Claude」：公开 client id（Claude Code / opencode /
// pi 等用的同一个）、claude.ai 的授权页、console 的 token 端点；调 API 用 Bearer +
// `anthropic-beta: oauth-2025-04-20`，不带 x-api-key。
//
// 有意不做的事：不把请求伪装成 Claude Code（不冒用它的 UA / 系统提示开头 / 计费文本块 / 十几个 beta /
// 设备与会话头）。Anthropic 对第三方客户端的口径是：允许用 Claude 账号登录，但用量计入账号的「额外用量」
// （在 claude.ai/settings/usage 开启并预存，按 token 计费），不吃订阅套餐的额度；伪装成 Claude Code 去
// 占套餐额度才是被明令禁止、会封号的那条路。所以这里就是一个如实自报家门的第三方客户端——账号没开
// 额外用量或余额为 0 时上游会 4xx，krsServer.upstreamErrorHint 会把这一点讲给用户。
// ---------------------------------------------------------------------------------------

export const ANTHROPIC_URLS = {
  authorize: "https://claude.ai/oauth/authorize",
  token: "https://console.anthropic.com/v1/oauth/token",
  /** 账号 / 组织 / 订阅档位（展示用）。 */
  profile: "https://api.anthropic.com/api/oauth/profile",
  api: "https://api.anthropic.com/v1",
  redirect: "http://localhost:54545/callback",
};
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_CALLBACK_PORT = 54545;
const ANTHROPIC_CALLBACK_PATH = "/callback";
const ANTHROPIC_SCOPE = "org:create_api_key user:profile user:inference";
/** OAuth Bearer 走 Messages API 必带的 beta 标记。 */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const anthropicUserAgent = () => `api4kiro/${clientVersion}`;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function anthropicTokenFrom(json: Record<string, unknown>, prev?: OAuthToken): OAuthToken {
  // token 回复顺带账号与组织：{ account: { uuid, email_address }, organization: { uuid, name } }
  const account = obj(json.account);
  const org = obj(json.organization);
  const extra: Record<string, string> = { ...(prev?.extra || {}) };
  const scope = str(json, "scope");
  if (scope) {
    extra.scope = scope;
  }
  const orgName = str(org, "name");
  if (orgName) {
    extra.organization = orgName;
  }
  return {
    accessToken: str(json, "access_token") || "",
    refreshToken: str(json, "refresh_token") || prev?.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    tokenType: str(json, "token_type") || "Bearer",
    email: str(account, "email_address") || str(account, "email") || prev?.email,
    accountId: str(account, "uuid") || prev?.accountId,
    plan: prev?.plan,
    extra,
    updatedAt: Date.now(),
  };
}

/**
 * 订阅档位（展示用）：/api/oauth/profile 的 organization_type（claude_max / claude_pro / claude_team…）
 * 与 rate_limit_tier（…_5x / …_20x）拼成「Max 20x」这样的短标签。拿不到不致命。
 */
async function anthropicFetchProfile(accessToken: string): Promise<{ email?: string; plan?: string } | undefined> {
  const r = await getJsonAuth(ANTHROPIC_URLS.profile, {
    Authorization: "Bearer " + accessToken,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    "User-Agent": anthropicUserAgent(),
  });
  if (r.status < 200 || r.status >= 300) {
    return undefined;
  }
  const account = obj(r.json.account);
  const org = obj(r.json.organization);
  const type = (str(org, "organization_type") || "").toLowerCase().replace(/^claude_/, "");
  let plan = type ? type.charAt(0).toUpperCase() + type.slice(1) : "";
  const mult = /(\d+)x/.exec((str(org, "rate_limit_tier") || "").toLowerCase());
  if (plan && mult) {
    plan += ` ${mult[1]}x`;
  }
  return { email: str(account, "email") || str(account, "email_address"), plan: plan || undefined };
}

const anthropic: VendorSpec = {
  id: "anthropic",
  name: "Anthropic (Claude)",
  blurb: "Claude Pro / Max 账号登录（浏览器授权）· Claude 5 / Opus 4.8 系 · 用量计入「额外用量」，需开启并充值；Free 账户不可用",
  flow: "pkce",
  callbackPort: ANTHROPIC_CALLBACK_PORT,
  baseUrl: ANTHROPIC_URLS.api,
  format: "anthropic",
  anthropicMode: "official",
  signupUrl: "https://claude.ai/settings/usage",
  signupLabel: "开启额外用量",
  tryModelsEndpoint: true,
  // 目录对齐 models.dev 的 anthropic 条目；/v1/models 拉得到的会再合并进来。
  models: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-fable-5", name: "Claude Fable 5", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, image: true, contextWindow: 200000 },
  ],
  headers(tok, stream) {
    return {
      Authorization: "Bearer " + tok.accessToken,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "User-Agent": anthropicUserAgent(),
      Accept: stream ? "text/event-stream" : "application/json",
    };
  },
  async login(ctx) {
    const pkce = generatePkce();
    const state = randomState();
    const q = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: ANTHROPIC_URLS.redirect,
      scope: ANTHROPIC_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });
    const authUrl = `${ANTHROPIC_URLS.authorize}?${q.toString()}`;
    ctx.onPhase("正在打开浏览器…");
    const cb = await openCallbackServer(ANTHROPIC_CALLBACK_PORT, ANTHROPIC_CALLBACK_PATH, state, LOGIN_TIMEOUT_MS, ctx.signal);
    ctx.onWaitingBrowser(authUrl);
    ctx.openUrl(authUrl);
    const { code } = await cb.result;
    ctx.onPhase("已收到授权码，正在换取 token…");
    // 这家的 token 端点收 JSON 而不是表单，且要把 state 一并带回
    const r = await postJson(
      ANTHROPIC_URLS.token,
      {
        grant_type: "authorization_code",
        client_id: ANTHROPIC_CLIENT_ID,
        code,
        state,
        redirect_uri: ANTHROPIC_URLS.redirect,
        code_verifier: pkce.verifier,
      },
      { "User-Agent": anthropicUserAgent() }
    );
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`换取 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    const tok = anthropicTokenFrom(r.json);
    try {
      const prof = await anthropicFetchProfile(tok.accessToken);
      if (prof) {
        tok.email = prof.email || tok.email;
        tok.plan = prof.plan;
      }
    } catch {
      /* 展示信息，拿不到就算 */
    }
    return tok;
  },
  async refresh(tok) {
    if (!tok.refreshToken) {
      throw new Error("没有 refresh token，请重新登录");
    }
    const r = await postJson(
      ANTHROPIC_URLS.token,
      { grant_type: "refresh_token", client_id: ANTHROPIC_CLIENT_ID, refresh_token: tok.refreshToken },
      { "User-Agent": anthropicUserAgent() }
    );
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new Error(`Anthropic 登录已失效（${str(r.json, "error") || "HTTP " + r.status}），请重新登录`);
    }
    if (r.status < 200 || r.status >= 300 || !str(r.json, "access_token")) {
      throw new Error(`Anthropic 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
    return anthropicTokenFrom(r.json, tok);
  },
};

// ---------------------------------------------------------------------------------------
// Kiro 官方 — 复用本机 Kiro 的登录态，请求直通 Kiro 自己的后端
// ---------------------------------------------------------------------------------------
//
// 不新开登录流程：Kiro IDE 登录后把 token 落在 ~/.aws/sso/cache/kiro-auth-token.json（social 登录的
// Google/GitHub 账号；Builder ID / IdC 账号另有 clientId+clientSecret 的注册文件），本插件直接读进来。
// 刷新与 IDE 协作（见 peekKiroLocalToken / adoptKiroLocalToken / writeBackKiroLocalToken 上方说明）：IDE 当前登录的
// 账号优先接管 IDE 刷出来的新 token；自己刷了就写回文件。要加第二个账号：在 Kiro 里换账号登录后再导入一次，进同一个账号池。
//
// 端点对齐 Kiro 1.0.411 自身的默认值（kiro-agent 包里 krsEndpoints / cpsEndpoints 的预设）：
//   流式  https://runtime.{region}.kiro.dev/generateAssistantResponse   —— 模型 id 就是可读形式
//   模型  https://q.{region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=50&profileArn=…
//         （kiro.qizhu 实测始终走 q.* 域；management.*.kiro.dev 是档案接口）
//   刷新  social → POST https://prod.{region}.auth.desktop.kiro.dev/refreshToken {refreshToken}
//         IdC/Builder ID → POST https://oidc.{ssoRegion}.amazonaws.com/token
//                          {grantType:"refresh_token", refreshToken, clientId, clientSecret}（camelCase JSON）
// 请求头：generateAssistantResponse 直接镜像 Kiro 发来的那一套（user-agent / x-amz-user-agent /
// x-amzn-kiro-agent-mode / x-amzn-codewhisperer-optout / amz-sdk-*），只换 Authorization；自己发起的
// ListAvailableModels / getUsageLimits 用上次从 Kiro 请求里记下的同一套头，没记到就按 IDE 风格合成。
// 缺任何一个头 AWS 会走更严格的 anti-abuse 路径（kiro.qizhu 注释：高并发下直接 403）。

export const KIRO_URLS = {
  runtime: "https://runtime.{region}.kiro.dev",
  q: "https://q.{region}.amazonaws.com",
  socialAuth: "https://prod.{region}.auth.desktop.kiro.dev",
  oidc: "https://oidc.{region}.amazonaws.com",
  /** Kiro 统一登录门户（IDE 的「Sign in」就是开这个页；里面选 Google / GitHub / Builder ID / IdC）。 */
  portal: "https://app.kiro.dev",
  /** provider.baseUrl 的缺省（us-east-1）；真实请求按 token 的 region 用 apiBaseFor 算。 */
  api: "https://runtime.us-east-1.kiro.dev",
};
/** 门户只往这几个 localhost 端口回跳（kiro-shared PortalAuthServer.CALLBACK_PORTS），按序试到一个空的。 */
export const KIRO_PORTAL_CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153];
/** IdC 客户端注册申请的 scope（kiro-shared IDCAuthProvider.GRANT_SCOPES，前缀 codewhisperer）。 */
const KIRO_IDC_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations", "codewhisperer:transformations", "codewhisperer:taskassist"];
/** 社交账号 / Builder ID 的 profileArn 是固定值（kiro-agent profiles 模块的 getFixedProfileArn）。 */
const KIRO_FIXED_PROFILE_ARN: Record<string, string> = {
  Google: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  Github: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  BuilderId: "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
};
const KIRO_BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const KIRO_DEFAULT_REGION = "us-east-1";
/** Kiro 官方后端能接受的 region（token 是绑 region 的；其它值一律回落 us-east-1）。 */
const KIRO_REGIONS = new Set(["us-east-1", "eu-central-1", "us-gov-east-1", "us-gov-west-1"]);

function kiroRegionOf(tok: Pick<OAuthToken, "extra">): string {
  const r = tok.extra?.region || "";
  return KIRO_REGIONS.has(r) ? r : KIRO_DEFAULT_REGION;
}
function kiroUrl(tpl: string, region: string): string {
  return tpl.replace("{region}", region);
}

/** ARN 里的 region（arn:aws:codewhisperer:us-east-1:…）。 */
function regionFromArn(arn: string | undefined): string | undefined {
  const m = /^arn:aws[a-z-]*:[a-z0-9-]+:([a-z0-9-]+):/i.exec(arn || "");
  return m ? m[1] : undefined;
}

/** IdC 的 clientId 是 base64，解出来尾部就是 SSO region（kiro.qizhu extractSSORegionFromClientID）。 */
function ssoRegionFromClientId(clientId: string | undefined, fallback: string): string {
  try {
    const decoded = Buffer.from(clientId || "", "base64").toString("utf8");
    const m = /([a-z]{2}(?:-[a-z]+)+-[0-9]+)$/.exec(decoded.trim());
    if (m) {
      return m[1];
    }
  } catch {
    /* 不是 base64 就用回落值 */
  }
  return fallback;
}

/**
 * 最近一次 Kiro 发到本地代理的请求里带的客户端标识头。generateAssistantResponse 直通时整套镜像，
 * 这里只记我们自己发起的请求（拉模型 / 查用量）要复用的几项。
 */
let kiroClientHeaders: Record<string, string> = {};
const KIRO_MIRROR_KEYS = ["user-agent", "x-amz-user-agent", "x-amzn-kiro-agent-mode", "x-amzn-codewhisperer-optout"];
export function rememberKiroClientHeaders(incoming: Record<string, string | string[] | undefined>): void {
  const picked: Record<string, string> = {};
  for (const k of KIRO_MIRROR_KEYS) {
    const v = incoming[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s) {
      picked[k] = s;
    }
  }
  // 只有真像 Kiro 的（UA 含 KiroIDE）才记，别把测试桩 / 别的客户端的头记进去
  if (picked["user-agent"] && /kiroide/i.test(picked["user-agent"])) {
    kiroClientHeaders = picked;
  }
}
/** 没记到 Kiro 的头时按 IDE 风格合成（常量对齐 kiro.qizhu / KAM 的实测值）。 */
function kiroIdeHeaders(tok: OAuthToken): Record<string, string> {
  if (kiroClientHeaders["user-agent"]) {
    return { ...kiroClientHeaders };
  }
  const machineId = crypto.createHash("sha256").update("KotlinNativeAPI/" + (tok.refreshToken || tok.accessToken)).digest("hex");
  const plat = os.platform() === "win32" ? "win32" : os.platform() === "darwin" ? "macos" : "linux";
  const osv = os.platform() === "win32" ? "10.0.26100" : os.platform() === "darwin" ? "15.0.0" : "5.15.0";
  const social = (tok.extra?.authMethod || "social") === "social" || tok.extra?.authMethod === "builder-id";
  return {
    "user-agent": `aws-sdk-js/1.0.34 ua/2.1 os/${plat}#${osv} lang/js md/nodejs#22.22.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-1.0.411-${machineId}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.34 KiroIDE-1.0.411-${machineId}`,
    "x-amzn-kiro-agent-mode": social ? "spec" : "vibe",
    "x-amzn-codewhisperer-optout": "true",
  };
}

/** Kiro 的本机登录态：token 文件 + （IdC）client 注册文件 + 当前 profile。 */
interface KiroCachePaths {
  dir: string;
  token: string;
  profile: string;
}
let kiroCachePathsOverride: KiroCachePaths | undefined;
/** 测试用：把「本机 Kiro 登录态」指到临时目录。 */
export function _setKiroCachePathsForTest(paths?: KiroCachePaths): void {
  kiroCachePathsOverride = paths;
}
function kiroCachePaths(): KiroCachePaths {
  if (kiroCachePathsOverride) {
    return kiroCachePathsOverride;
  }
  const home = os.homedir();
  const dir = path.join(home, ".aws", "sso", "cache");
  const appData = process.env.APPDATA || path.join(home, os.platform() === "darwin" ? "Library/Application Support" : ".config");
  return {
    dir,
    token: path.join(dir, "kiro-auth-token.json"),
    profile: path.join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent", "profile.json"),
  };
}
function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
function parseIsoMs(v: unknown): number | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const t = Date.parse(v);
  return isFinite(t) ? t : undefined;
}

/** 从本机 Kiro 登录态组 OAuthToken。测试可传入替代的文件路径。 */
export function importKiroLocalToken(paths: KiroCachePaths = kiroCachePaths()): OAuthToken {
  const raw = readJsonFile(paths.token);
  if (!raw) {
    throw new Error(`本机 Kiro 未登录（找不到 ${paths.token}）。请先在 Kiro 里登录账号，再回来导入。`);
  }
  const accessToken = str(raw, "accessToken");
  const refreshToken = str(raw, "refreshToken");
  if (!accessToken || !refreshToken) {
    throw new Error("Kiro 的登录态文件里没有 accessToken / refreshToken，请在 Kiro 里重新登录后再导入。");
  }
  const authMethod = (str(raw, "authMethod") || "").toLowerCase() || (str(raw, "clientId") ? "builder-id" : "social");
  let clientId = str(raw, "clientId");
  let clientSecret = str(raw, "clientSecret");
  if (authMethod !== "social" && (!clientId || !clientSecret)) {
    // Builder ID / IdC：client 注册在同目录另一个 <sha1>.json 里（clientId+clientSecret+expiresAt），取最新的一份
    try {
      const cands = fs
        .readdirSync(paths.dir)
        .filter((f) => f.endsWith(".json") && f !== "kiro-auth-token.json")
        .map((f) => ({ f: path.join(paths.dir, f), m: fs.statSync(path.join(paths.dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const c of cands) {
        const j = readJsonFile(c.f);
        if (j && str(j, "clientId") && str(j, "clientSecret")) {
          clientId = str(j, "clientId");
          clientSecret = str(j, "clientSecret");
          break;
        }
      }
    } catch {
      /* 目录读不了就当没有 */
    }
    if (!clientId || !clientSecret) {
      throw new Error("这是 Builder ID / IdC 账号，但找不到 client 注册文件（~/.aws/sso/cache/<hash>.json），无法自行刷新 token。");
    }
  }
  let profileArn = str(raw, "profileArn");
  if (!profileArn) {
    const prof = readJsonFile(paths.profile);
    profileArn = prof ? str(prof, "arn") || str(prof, "profileArn") || str(prof, "arnString") : undefined;
  }
  const region = str(raw, "region") || regionFromArn(profileArn) || KIRO_DEFAULT_REGION;
  const extra: Record<string, string> = { authMethod, region };
  if (profileArn) {
    extra.profileArn = profileArn;
  }
  const idp = str(raw, "provider");
  if (idp) {
    extra.provider = idp;
  }
  if (clientId && clientSecret) {
    extra.clientId = clientId;
    extra.clientSecret = clientSecret;
  }
  const startUrl = str(raw, "startUrl");
  if (startUrl) {
    extra.startUrl = startUrl;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: parseIsoMs(raw.expiresAt),
    tokenType: "Bearer",
    email: str(raw, "email"),
    extra,
    updatedAt: Date.now(),
  };
}

// 与 Kiro IDE 共用一个账号的刷新协作（Kiro 1.0.411 kiro-shared AuthProvider / TokenStorage 的行为）：
//  · IDE 每 60s 巡检，到期前 10 分钟就刷（比我们的 5 分钟早）；刷新会换代 refresh token，旧的作废，新 token 写回文件；
//  · IDE 用 fs.watchFile 盯着 kiro-auth-token.json，文件一变就换用文件里的 token；自己刷失败时也会再读文件，
//    文件里若已是另一代且未过期就直接采用（多窗口并发刷新的既有逻辑）；
//  · 但若刷失败且文件里仍是旧的那一代，IDE 会判定登录失效并把用户登出。
// 所以：刷之前先看文件——同账号已换代就直接接管；自己刷成功后若文件里还是刚被我们消费掉的那一代，务必写回。

function peekKiroLocalToken(): OAuthToken | undefined {
  try {
    return importKiroLocalToken();
  } catch {
    return undefined;
  }
}

/** 文件里的登录态是不是「同一账号、比手上这份新」——是就接管它（不再打刷新接口）。 */
async function adoptKiroLocalToken(local: OAuthToken, tok: OAuthToken): Promise<OAuthToken | undefined> {
  if ((local.extra?.authMethod || "social") !== (tok.extra?.authMethod || "social")) {
    return undefined;
  }
  const merged: OAuthToken = {
    ...tok,
    accessToken: local.accessToken,
    refreshToken: local.refreshToken,
    expiresAt: local.expiresAt,
    extra: { ...(tok.extra || {}), ...(local.extra || {}) },
    updatedAt: Date.now(),
  };
  if (local.refreshToken === tok.refreshToken) {
    // 同一代 refresh token：只有 access token 更新过（刷新接口没换代）才有接管价值
    return local.accessToken !== tok.accessToken && (local.expiresAt || 0) > (tok.expiresAt || 0) ? merged : undefined;
  }
  // 换代了：可能是同账号被 IDE 刷过，也可能是用户在 Kiro 里换了账号——拿文件里的 token 问一下邮箱
  if (!tok.email || tok.email.includes(" · ")) {
    return undefined;
  }
  const info = await kiroAccountInfo(local);
  if (!info.email || info.email.toLowerCase() !== tok.email.toLowerCase()) {
    return undefined;
  }
  if (info.plan) {
    merged.plan = info.plan;
  }
  return merged;
}

/** 自己刷成功后，把新 token 写回本机文件（只在文件里仍是刚被消费掉的那一代时；写法同 IDE：临时文件 + 改名，0600）。 */
function writeBackKiroLocalToken(consumedRefresh: string, fresh: OAuthToken): boolean {
  const file = kiroCachePaths().token;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  const raw = readJsonFile(file);
  if (!raw || str(raw, "refreshToken") !== consumedRefresh) {
    return false;
  }
  const next: Record<string, unknown> = { ...raw, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken || consumedRefresh };
  if (fresh.expiresAt) {
    next.expiresAt = new Date(fresh.expiresAt).toISOString();
  }
  if (fresh.extra?.profileArn) {
    next.profileArn = fresh.extra.profileArn;
  }
  const tmp = `${file}.${process.pid}.a2k.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, undefined, 2), { mode: 0o600 });
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 3 || (code !== "EPERM" && code !== "EACCES")) {
          throw e;
        }
      }
    }
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能没建成 */
    }
    return false;
  }
}

/** 账号邮箱 / 套餐：getUsageLimits?isEmailRequired=true 顺便带回来（拿不到不算失败）。 */
async function kiroAccountInfo(tok: OAuthToken): Promise<{ email?: string; plan?: string }> {
  const region = kiroRegionOf(tok);
  const arn = tok.extra?.profileArn;
  const url =
    kiroUrl(KIRO_URLS.q, region) +
    "/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST" +
    (arn ? "&profileArn=" + encodeURIComponent(arn) : "");
  try {
    const r = await getJsonAuth(url, kiroApiHeaders(tok));
    if (r.status < 200 || r.status >= 300) {
      return {};
    }
    const j = r.json;
    const info = (j.userInfo && typeof j.userInfo === "object" ? j.userInfo : j) as Record<string, unknown>;
    const sub = (j.subscriptionInfo && typeof j.subscriptionInfo === "object" ? j.subscriptionInfo : {}) as Record<string, unknown>;
    return { email: str(info, "email") || str(j, "email"), plan: str(sub, "subscriptionTitle") || str(sub, "type") };
  } catch {
    return {};
  }
}

/**
 * API Key 模式（官方 ksk_ Key）的请求头：Key 同时放 x-api-key 与 Bearer，并声明 `tokentype: API_KEY`——
 * 不声明时服务端会把 Bearer 当 OAuth token 校验而 403（krsServer 直通路径同一规则）。
 */
function kiroApiKeyHeaders(tok: OAuthToken): Record<string, string> {
  return {
    "x-api-key": tok.accessToken,
    Authorization: "Bearer " + tok.accessToken,
    tokentype: "API_KEY",
    "Content-Type": "application/json",
    Accept: "application/json",
    ...kiroIdeHeaders(tok),
    "amz-sdk-invocation-id": randomUuid(),
    "amz-sdk-request": "attempt=1; max=1",
  };
}

/** 我们自己发起的 Kiro 官方接口调用（拉模型 / 查用量）用的整套头。 */
function kiroApiHeaders(tok: OAuthToken): Record<string, string> {
  if (tok.extra?.authMethod === "api_key") {
    return kiroApiKeyHeaders(tok);
  }
  const h: Record<string, string> = {
    Authorization: "Bearer " + tok.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...kiroIdeHeaders(tok),
    "amz-sdk-invocation-id": randomUuid(),
    "amz-sdk-request": "attempt=1; max=1",
  };
  if (tok.extra?.authMethod === "external_idp") {
    h.TokenType = "EXTERNAL_IDP";
  }
  return h;
}

/** 从官方 additionalModelRequestFieldsSchema 里抠 effort 取值（output_config.effort 或 reasoning.effort）。 */
function effortsFromSchema(schema: unknown): { levels?: string[]; path?: string; def?: string } {
  const s = schema as { properties?: Record<string, { properties?: Record<string, { enum?: unknown; default?: unknown }> }> } | undefined;
  const props = s?.properties;
  if (!props || typeof props !== "object") {
    return {};
  }
  for (const key of ["output_config", "reasoning"]) {
    const eff = props[key]?.properties?.effort;
    if (eff && Array.isArray(eff.enum) && eff.enum.length) {
      return { levels: eff.enum.filter((x): x is string => typeof x === "string"), path: key, def: typeof eff.default === "string" ? eff.default : undefined };
    }
  }
  return {};
}

// ---- 浏览器授权登录：走 Kiro 自己的登录门户（对齐 kiro-shared PortalAuthProvider / IDCAuthProvider）----
//
// 门户 https://app.kiro.dev/signin?state&code_challenge&code_challenge_method=S256&redirect_uri=http://localhost:<port>&redirect_from=KiroIDE
// 用户在页里选 Google / GitHub / Builder ID / IdC，然后回跳 <redirect_uri>/oauth/callback（或 /signin/callback）：
//   · 社交：?login_option=google|github&code=…&state=…  → POST auth.desktop/oauth/token {code, code_verifier, redirect_uri}
//     （redirect_uri 要拼成 "<redirect_uri><回跳路径>?login_option=<选项>"，服务端按这个字面值校验）
//   · Builder ID / IdC：?login_option=builderid|awsidc|internal&issuer_url=…&idc_region=…
//     → 标准 IAM Identity Center OIDC：/client/register → /authorize（再开一页浏览器，回跳 http://127.0.0.1:<随机端口>/oauth/callback）→ /token
// 登录服务只认 IDE 的 UA `KiroIDE-<版本>-<machineId>`。

/** 我们自己调 Kiro 登录服务（换 token / 刷新）时的 UA：优先沿用 Kiro 发来的那串里的 KiroIDE-… 段，没记到就按本机合成。 */
function kiroAuthUserAgent(): string {
  const m = /KiroIDE-[\w.-]+/.exec(kiroClientHeaders["user-agent"] || "");
  if (m) {
    return m[0];
  }
  let who = "";
  try {
    who = os.userInfo().username;
  } catch {
    /* 拿不到用户名就只用主机名 */
  }
  const machineId = crypto.createHash("sha256").update(os.hostname() + "/" + who).digest("hex");
  return `KiroIDE-1.0.411-${machineId}`;
}

function kiroPortalUrl(state: string, codeChallenge: string, redirectUri: string): string {
  const params = new URLSearchParams({
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    redirect_from: "KiroIDE",
  });
  return `${KIRO_URLS.portal}/signin?${params.toString()}`;
}

function isKiroIdcOption(option: string): boolean {
  return option === "builderid" || option === "awsidc" || option === "internal";
}

async function kiroPortalLogin(ctx: LoginContext): Promise<OAuthToken> {
  const state = randomUuid();
  const pkce = generatePkce();
  ctx.onPhase("正在起本机回调服务…");
  const cb = await openLoopbackCallback({
    ports: KIRO_PORTAL_CALLBACK_PORTS,
    paths: ["/oauth/callback", "/signin/callback"],
    expectedState: state,
    timeoutMs: LOGIN_TIMEOUT_MS,
    signal: ctx.signal,
    successHtml: (r) =>
      isKiroIdcOption(r.params.login_option || "")
        ? noticePageHtml("还差一步", "已选择 Builder ID / IAM Identity Center：浏览器马上会再打开一页 AWS 登录，请在那里完成；之后回到 Kiro。")
        : undefined,
  });
  const redirectUri = `http://localhost:${cb.port}`;
  const portalUrl = kiroPortalUrl(state, pkce.challenge, redirectUri);
  ctx.openUrl(portalUrl);
  ctx.onWaitingBrowser(portalUrl);
  const r = await cb.result;
  const option = r.params.login_option || "";
  if (option === "google" || option === "github") {
    if (!r.params.code) {
      throw new Error("Kiro 登录门户回跳里没有授权码");
    }
    ctx.onPhase("正在向 Kiro 换取 token…");
    const provider = option === "google" ? "Google" : "Github";
    const res = await postJson(
      kiroUrl(KIRO_URLS.socialAuth, KIRO_DEFAULT_REGION) + "/oauth/token",
      { code: r.params.code, code_verifier: pkce.verifier, redirect_uri: `${redirectUri}${r.path}?login_option=${option}` },
      { "User-Agent": kiroAuthUserAgent() }
    );
    const accessToken = str(res.json, "accessToken");
    if (res.status < 200 || res.status >= 300 || !accessToken) {
      throw new Error(`Kiro 换取 token 失败：HTTP ${res.status} ${(str(res.json, "message") || res.text).slice(0, 200)}`);
    }
    const arn = str(res.json, "profileArn") || KIRO_FIXED_PROFILE_ARN[provider];
    return {
      accessToken,
      refreshToken: str(res.json, "refreshToken"),
      expiresAt: expiresAtFrom(res.json.expiresIn) || parseIsoMs(res.json.expiresAt) || Date.now() + 3600_000,
      tokenType: "Bearer",
      extra: { authMethod: "social", provider, region: regionFromArn(arn) || KIRO_DEFAULT_REGION, profileArn: arn },
      updatedAt: Date.now(),
    };
  }
  if (isKiroIdcOption(option)) {
    const provider = option === "builderid" ? "BuilderId" : option === "awsidc" ? "Enterprise" : "Internal";
    const startUrl = r.params.issuer_url || (provider === "BuilderId" ? KIRO_BUILDER_ID_START_URL : "");
    if (!startUrl) {
      throw new Error("Kiro 登录门户回跳里没有 issuer_url");
    }
    return kiroIdcLogin(ctx, provider, startUrl, r.params.idc_region || KIRO_DEFAULT_REGION);
  }
  if (option === "external_idp") {
    throw new Error("暂不支持企业外部 IdP（external_idp）方式；请先在 Kiro 里登录，再用「导入本机登录」。");
  }
  throw new Error(`Kiro 登录门户返回了未知的登录方式：${option || "(空)"}`);
}

/** IAM Identity Center（Builder ID / 企业 IdC）授权码 + PKCE；client 注册信息随 token 存，刷新要用。 */
async function kiroIdcLogin(ctx: LoginContext, provider: "BuilderId" | "Enterprise" | "Internal", startUrl: string, idcRegion: string): Promise<OAuthToken> {
  const oidc = kiroUrl(KIRO_URLS.oidc, idcRegion);
  ctx.onPhase("正在向 IAM Identity Center 注册客户端…");
  const reg = await postJson(oidc + "/client/register", {
    clientName: "Kiro IDE",
    clientType: "public",
    scopes: KIRO_IDC_SCOPES,
    grantTypes: ["authorization_code", "refresh_token"],
    redirectUris: ["http://127.0.0.1/oauth/callback"],
    issuerUrl: startUrl,
  });
  const clientId = str(reg.json, "clientId");
  const clientSecret = str(reg.json, "clientSecret");
  if (reg.status < 200 || reg.status >= 300 || !clientId || !clientSecret) {
    throw new Error(`IAM Identity Center 客户端注册失败：HTTP ${reg.status} ${(str(reg.json, "error_description") || str(reg.json, "message") || reg.text).slice(0, 200)}`);
  }
  if (ctx.signal.cancelled) {
    throw new LoginCancelled();
  }
  const state = randomUuid();
  const pkce = generatePkce();
  const cb = await openLoopbackCallback({ ports: [0], paths: ["/oauth/callback"], expectedState: state, timeoutMs: LOGIN_TIMEOUT_MS, signal: ctx.signal });
  const redirectUri = `http://127.0.0.1:${cb.port}/oauth/callback`;
  const authorizeUrl =
    oidc +
    "/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scopes: KIRO_IDC_SCOPES.join(","),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }).toString();
  ctx.openUrl(authorizeUrl);
  ctx.onWaitingBrowser(authorizeUrl);
  const r = await cb.result;
  if (!r.params.code) {
    throw new Error("IAM Identity Center 回跳里没有授权码");
  }
  ctx.onPhase("正在换取 token…");
  const t = await postJson(oidc + "/token", {
    clientId,
    clientSecret,
    grantType: "authorization_code",
    redirectUri,
    code: r.params.code,
    codeVerifier: pkce.verifier,
  });
  const accessToken = str(t.json, "accessToken");
  if (t.status < 200 || t.status >= 300 || !accessToken) {
    throw new Error(`IAM Identity Center 换取 token 失败：HTTP ${t.status} ${(str(t.json, "error_description") || str(t.json, "error") || t.text).slice(0, 200)}`);
  }
  const extra: Record<string, string> = { authMethod: "idc", provider, region: idcRegion, ssoRegion: idcRegion, clientId, clientSecret, startUrl };
  const tok: OAuthToken = {
    accessToken,
    refreshToken: str(t.json, "refreshToken"),
    expiresAt: expiresAtFrom(t.json.expiresIn) || Date.now() + 8 * 3600_000,
    tokenType: "Bearer",
    extra,
    updatedAt: Date.now(),
  };
  const fixed = KIRO_FIXED_PROFILE_ARN[provider];
  if (fixed) {
    extra.profileArn = fixed;
  } else {
    // 企业 IdC：profile 由管理员分配，得问 ListAvailableProfiles（先问 IdC 所在 region，再兜底常见 region）
    ctx.onPhase("正在查询可用的 Kiro profile…");
    const arn = await kiroFirstProfileArn(tok, idcRegion);
    if (!arn) {
      throw new Error("你的组织管理员还没有给这个账号分配 Kiro profile，无法使用；请联系管理员。");
    }
    extra.profileArn = arn;
    extra.region = regionFromArn(arn) || idcRegion;
  }
  return tok;
}

async function kiroFirstProfileArn(tok: OAuthToken, idcRegion: string): Promise<string | undefined> {
  const regions = Array.from(new Set([idcRegion, KIRO_DEFAULT_REGION, "eu-central-1"]));
  for (const region of regions) {
    try {
      const r = await postJson(kiroUrl(KIRO_URLS.q, region) + "/ListAvailableProfiles", {}, kiroApiHeaders({ ...tok, extra: { ...(tok.extra || {}), region } }));
      if (r.status < 200 || r.status >= 300) {
        continue;
      }
      const profiles = Array.isArray(r.json.profiles) ? (r.json.profiles as Array<Record<string, unknown>>) : [];
      const first = profiles.find((p) => str(p, "arn"));
      if (first) {
        return str(first, "arn");
      }
    } catch {
      /* 这个 region 不通，试下一个 */
    }
  }
  return undefined;
}

// ---- 手填凭证：Kiro Access Token（逐项填）/ JSON（整段粘）----
//
// 各家工具导出的凭证长得不一样，这里统一收：
//   IDE 文件      {accessToken, refreshToken, expiresAt, profileArn, authMethod:"social"|"IdC", provider, clientId?, clientSecret?, region?}
//   kiro2api      {"auth":"Social"|"IdC", "refreshToken", "clientId"?, "clientSecret"?}（也可能是数组）
//   snake_case    {access_token, refresh_token, profile_arn, client_id, client_secret, expires_at|expires_in, auth_method}
//   包一层的      {"token": {...}} / {"credentials": {...}} / {"data": {...}}
// 有 clientId+clientSecret 视为 IdC（Builder ID / 企业），否则 social；profileArn 没给就用固定值 / 查 ListAvailableProfiles。

function pick(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
    if (typeof v === "number" && isFinite(v)) {
      return String(v);
    }
  }
  return undefined;
}

/** 把一份「凭证记录」整理成 OAuthToken（不联网；缺 access token 也放行，激活时会去刷）。 */
export function kiroTokenFromRecord(input: Record<string, unknown>): OAuthToken {
  let rec = input;
  const parentEmail = pick(rec, "email", "mail", "user", "userId", "nickname");
  for (const wrap of ["credentials", "token", "credential", "data", "auth", "account"]) {
    const inner = rec[wrap];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      rec = { ...inner, ...(parentEmail && !(inner as Record<string, unknown>).email ? { email: parentEmail } : {}) } as Record<string, unknown>;
    }
  }
  const accessToken = pick(rec, "accessToken", "access_token", "token") || "";
  const refreshToken = pick(rec, "refreshToken", "refresh_token");
  if (!accessToken && !refreshToken) {
    throw new Error("凭证里没有 accessToken / refreshToken（至少要有 refresh token 才能长期使用）");
  }
  const clientId = pick(rec, "clientId", "client_id");
  const clientSecret = pick(rec, "clientSecret", "client_secret");
  const rawMethod = (pick(rec, "authMethod", "auth_method", "auth", "type", "provider", "idp") || "").toLowerCase();
  if (/external[_-]?idp/.test(rawMethod)) {
    // 手填 / JSON 路径没有企业 IdP 的刷新参数，按 social 去刷只会得到「登录失效」；与门户登录一致地拒绝并引导
    throw new Error("暂不支持企业外部 IdP（external_idp）凭证的手填 / JSON 导入；请先在 Kiro 里登录，再用「导入本机登录」。");
  }
  const authMethod = /idc|builder|enterprise|sso/.test(rawMethod) || (!/social|google|github/.test(rawMethod) && clientId && clientSecret) ? "idc" : "social";
  if (authMethod === "idc" && (!clientId || !clientSecret)) {
    throw new Error("这是 Builder ID / IdC 账号，需要一并提供 clientId 和 clientSecret（Kiro 的 ~/.aws/sso/cache/<hash>.json 里有）");
  }
  const provider = pick(rec, "provider", "idp");
  const profileArn = pick(rec, "profileArn", "profile_arn", "arn") || (authMethod === "social" ? KIRO_FIXED_PROFILE_ARN.Google : undefined);
  const region = pick(rec, "region") || regionFromArn(profileArn) || KIRO_DEFAULT_REGION;
  const extra: Record<string, string> = { authMethod, region };
  if (profileArn) {
    extra.profileArn = profileArn;
  }
  if (provider) {
    extra.provider = provider;
  }
  if (clientId && clientSecret) {
    extra.clientId = clientId;
    extra.clientSecret = clientSecret;
  }
  const startUrl = pick(rec, "startUrl", "start_url", "issuerUrl", "issuer_url");
  if (startUrl) {
    extra.startUrl = startUrl;
  }
  const ssoRegion = pick(rec, "ssoRegion", "sso_region", "idcRegion", "idc_region");
  if (ssoRegion) {
    extra.ssoRegion = ssoRegion;
  }
  const rawExp = rec.expiresAt ?? rec.expires_at;
  // 到期时间：ISO 串 / 毫秒或秒的时间戳 / expiresIn 秒数，都认
  const epochMs = typeof rawExp === "number" && isFinite(rawExp) && rawExp > 0 ? (rawExp < 1e12 ? rawExp * 1000 : rawExp) : undefined;
  const expiresAt = parseIsoMs(rawExp) || epochMs || expiresAtFrom(rec.expiresIn ?? rec.expires_in);
  return {
    accessToken,
    refreshToken,
    // 没给到期时间又有 access token：当它还能用一会儿，激活时会真的去探一下
    expiresAt: expiresAt || (accessToken ? Date.now() + 30 * 60_000 : 0),
    tokenType: "Bearer",
    email: pick(rec, "email", "nickname", "userId") || parentEmail,
    extra,
    updatedAt: Date.now(),
  };
}

/** 递归扫描任意层级嵌套中的凭证记录（支持 kiro-accounts.json、导出数组、多账号嵌套等） */
function extractKiroCandidateRecords(root: unknown): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  function dig(item: unknown, parentEmail?: string) {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const el of item) dig(el, parentEmail);
      return;
    }
    const obj = item as Record<string, unknown>;
    const email = pick(obj, "email", "mail", "user", "userId", "nickname") || parentEmail;
    if (obj.accessToken || obj.access_token || obj.refreshToken || obj.refresh_token) {
      list.push(email && !obj.email ? { ...obj, email } : obj);
      return;
    }
    if (obj.credentials && typeof obj.credentials === "object") {
      const cred = obj.credentials as Record<string, unknown>;
      list.push({ ...cred, email: cred.email || email });
      return;
    }
    if (Array.isArray(obj.accounts)) {
      for (const a of obj.accounts) dig(a, email);
      return;
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object" && obj[key] !== null) {
        dig(obj[key], email);
      }
    }
  }
  dig(root);
  return list;
}

/** JSON 登录：整段文本 → 记录（数组取第一条，多余的提示用户分别导入）。 */
export function kiroTokenFromJson(text: string): { tok: OAuthToken; total: number } {
  let v: unknown;
  try {
    v = JSON.parse(text.trim());
  } catch {
    // 有人会把 .json 文件里的内容连同 BOM / 注释粘进来，退一步只抠花括号或中括号里的
    const m = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(text);
    if (!m) {
      throw new Error("不是合法的 JSON：请粘贴 kiro-auth-token.json 的内容或工具导出的凭证 JSON");
    }
    try {
      v = JSON.parse(m[0]);
    } catch {
      throw new Error("不是合法的 JSON：请粘贴 kiro-auth-token.json 的内容或工具导出的凭证 JSON");
    }
  }
  const candidates = extractKiroCandidateRecords(v);
  if (!candidates.length) {
    throw new Error("JSON 里未找到有效的 Kiro 凭证（需包含 accessToken 或 refreshToken）");
  }
  return { tok: kiroTokenFromRecord(candidates[0]), total: candidates.length };
}

/**
 * 手填的凭证先激活再入池：没有 access token / 已过期 → 先刷一次（顺带验证 refresh token）；
 * 有 access token → 打一下 getUsageLimits，401/403 再刷；刷也不行就是凭证无效，不入池。
 */
async function kiroActivateManualToken(ctx: LoginContext, tok: OAuthToken): Promise<OAuthToken> {
  let cur = tok;
  const stale = !cur.accessToken || (cur.expiresAt || 0) < Date.now() + 60_000;
  if (stale) {
    ctx.onPhase("正在用 refresh token 换取新的 access token…");
    cur = await kiroRefreshToken(cur);
  } else {
    ctx.onPhase("正在向 Kiro 官方验证凭证…");
    const r = await getJsonAuth(kiroUrl(KIRO_URLS.q, kiroRegionOf(cur)) + "/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST" + (cur.extra?.profileArn ? "&profileArn=" + encodeURIComponent(cur.extra.profileArn) : ""), kiroApiHeaders(cur));
    if (r.status === 401 || r.status === 403) {
      if (!cur.refreshToken) {
        throw new Error(`这个 access token 已失效（HTTP ${r.status}），又没有 refresh token 可续期`);
      }
      ctx.onPhase("access token 已失效，正在用 refresh token 换新…");
      cur = await kiroRefreshToken(cur);
    }
  }
  if (ctx.signal.cancelled) {
    throw new LoginCancelled();
  }
  // 企业 IdC 手填时常常没有 profileArn：现在有 access token 了，问一下
  if (cur.extra?.authMethod === "idc" && !cur.extra.profileArn) {
    ctx.onPhase("正在查询可用的 Kiro profile…");
    const arn = await kiroFirstProfileArn(cur, cur.extra.ssoRegion || cur.extra.region || KIRO_DEFAULT_REGION);
    cur = { ...cur, extra: { ...cur.extra, profileArn: arn || KIRO_FIXED_PROFILE_ARN.BuilderId, provider: cur.extra.provider || (arn ? "Enterprise" : "BuilderId") } };
  }
  return cur;
}

/** 刷新（social 走 Kiro 登录服务，IdC 走 OIDC）；与本机 Kiro IDE 共用账号时先看文件、刷完写回（见上）。 */
async function kiroRefreshToken(tok: OAuthToken): Promise<OAuthToken> {
  if (!tok.refreshToken) {
    throw new Error("Kiro 登录已失效（没有 refresh token），请重新登录 / 导入");
  }
  // 这个账号若正是 Kiro IDE 当前登录的那个，IDE 大概率已经先刷过并写回文件了——直接接管，别再拿旧 refresh token 去碰接口
  const local = peekKiroLocalToken();
  const adopted = local ? await adoptKiroLocalToken(local, tok) : undefined;
  if (adopted) {
    return adopted;
  }
  const method = tok.extra?.authMethod || "social";
  const region = kiroRegionOf(tok);
  let r: { status: number; json: Record<string, unknown>; text: string };
  if (method === "social") {
    // 与 IDE 自己的 AuthServiceClient.refreshToken 一致：JSON 体 + KiroIDE UA，别的头都不带；
    // 登录服务是全局一个（IDE 写死 prod.us-east-1），不随账号的 region 变
    r = await postJson(kiroUrl(KIRO_URLS.socialAuth, KIRO_DEFAULT_REGION) + "/refreshToken", { refreshToken: tok.refreshToken }, { "User-Agent": kiroAuthUserAgent() });
  } else {
    const clientId = tok.extra?.clientId;
    const clientSecret = tok.extra?.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error("Kiro 登录已失效（缺少 IdC client 注册信息 clientId / clientSecret），请重新登录 / 导入");
    }
    // 浏览器登录时记下了注册所在 region；导入的没有，从 clientId 里解
    const sso = tok.extra?.ssoRegion || ssoRegionFromClientId(clientId, region);
    r = await postJson(kiroUrl(KIRO_URLS.oidc, sso) + "/token", {
      grantType: "refresh_token",
      refreshToken: tok.refreshToken,
      clientId,
      clientSecret,
    });
  }
  const err = str(r.json, "error") || str(r.json, "__type") || str(r.json, "message") || "";
  if (r.status === 400 || r.status === 401 || r.status === 403 || /invalid_grant|InvalidGrant|ExpiredToken|InvalidClient|UnauthorizedClient/i.test(err)) {
    // 被拒的常见原因是 IDE 刚刚（在我们看完文件之后）把这一代作废了——再看一眼文件
    const again = peekKiroLocalToken();
    const late = again && again.refreshToken !== tok.refreshToken ? await adoptKiroLocalToken(again, tok) : undefined;
    if (late) {
      return late;
    }
    throw new Error(`Kiro 登录已失效（${err || "HTTP " + r.status}），请重新登录 / 导入`);
  }
  const accessToken = str(r.json, "accessToken");
  if (r.status < 200 || r.status >= 300 || !accessToken) {
    throw new Error(`Kiro 刷新 token 失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  const extra = { ...(tok.extra || {}) };
  const arn = str(r.json, "profileArn");
  if (arn) {
    extra.profileArn = arn;
  }
  const fresh: OAuthToken = {
    ...tok,
    accessToken,
    refreshToken: str(r.json, "refreshToken") || tok.refreshToken,
    expiresAt: expiresAtFrom(r.json.expiresIn) || parseIsoMs(r.json.expiresAt) || Date.now() + 3600_000,
    extra,
    updatedAt: Date.now(),
  };
  // 文件里还是刚被我们消费掉的那一代（IDE 还没刷）：写回去，IDE 几秒内就会换用；不写它稍后会刷失败并把用户登出
  if (local && local.refreshToken === tok.refreshToken && fresh.refreshToken !== tok.refreshToken) {
    writeBackKiroLocalToken(tok.refreshToken, fresh);
  }
  return fresh;
}

/** 导入 / 浏览器登录拿到 token 后：补账号邮箱与套餐；没有邮箱就合成一个可区分的展示名。 */
async function kiroFinishLogin(ctx: LoginContext, tok: OAuthToken): Promise<OAuthToken> {
  if (ctx.signal.cancelled) {
    throw new LoginCancelled();
  }
  ctx.onPhase("正在向 Kiro 官方核对账号…");
  const info = await kiroAccountInfo(tok);
  if (info.email) {
    tok.email = info.email;
  }
  if (info.plan) {
    tok.plan = info.plan;
  }
  if (!tok.email) {
    // 没拿到邮箱：用登录方式 + refresh token 尾巴当展示名（social 账号的 profileArn 全都一样，不能用它区分）
    const idp = tok.extra?.provider || tok.extra?.authMethod || "Kiro";
    const tail = (tok.refreshToken || tok.accessToken).slice(-6);
    tok.email = `${idp} · ${tail}`;
  }
  return tok;
}

const kiro: VendorSpec = {
  id: "kiro",
  name: "Kiro 官方",
  blurb: "官方 Claude 系模型直通 · 导入本机 Kiro 的登录账号，或用浏览器再登一个（Google / GitHub / Builder ID），多账号成池",
  flow: "import",
  official: true,
  loginModes: [
    {
      id: "oauth",
      label: "OAuth 授权",
      hint: "打开 Kiro 官方统一登录门户（app.kiro.dev），用 Google / GitHub / Builder ID 账号登录并授权。",
    },
    {
      id: "import",
      label: "本地导入",
      hint: "直接读取本机 Kiro 当前登录的账号（~/.aws/sso/cache/kiro-auth-token.json），不用再登录；token 到期由 Kiro 和本插件协同刷新。",
    },
    {
      id: "access_token",
      label: "Kiro Access Token",
      hint: "填入 Access Token，可选附带 Refresh Token、Profile ARN、Region，由插件在线激活并加入账号池。",
      fields: [
        { key: "accessToken", label: "Access Token", placeholder: "Bearer 访问令牌（若填了 refresh token 可留空）", secret: true },
        { key: "refreshToken", label: "Refresh Token", placeholder: "刷新令牌（长期使用建议提供）", secret: true },
        { key: "profileArn", label: "Profile ARN", placeholder: "可选，留空自动检测或使用官方默认" },
        { key: "region", label: "AWS Region", placeholder: "默认 us-east-1" },
      ],
    },
    {
      id: "json",
      label: "JSON 登录",
      hint: "整段粘贴 kiro-auth-token.json 内容或第三方工具导出的凭据 JSON。",
      fields: [
        { key: "jsonText", label: "凭据 JSON 内容", placeholder: "粘贴包含 accessToken/refreshToken 的 JSON 对象或数组", multiline: true, required: true },
      ],
    },
    {
      id: "api_key",
      label: "API Key 登录",
      hint: "填入 Kiro / Bedrock 官方 API Key，请求直连 q.{region}.amazonaws.com。",
      fields: [
        { key: "apiKey", label: "API Key", placeholder: "填入官方 API Key", secret: true, required: true },
        { key: "region", label: "AWS Region", placeholder: "默认 us-east-1" },
        { key: "endpoint", label: "自定义端点", placeholder: "可选，留空使用官方 q.{region}.amazonaws.com" },
      ],
    },
  ],
  baseUrl: KIRO_URLS.api,
  format: "kiro",
  signupUrl: "https://kiro.dev",
  signupLabel: "打开 kiro.dev",
  // 拉不到官方清单时的兜底（对齐 Kiro 1.0.411 ListAvailableModels 的常见条目）
  models: [
    { id: "auto", name: "Auto", reasoning: true, image: true },
    { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", reasoning: true, image: true, contextWindow: 1000000 },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", reasoning: true, image: true, contextWindow: 200000 },
  ],
  latencyPath: "/ListAvailableModels?origin=AI_EDITOR&maxResults=1",
  apiBaseFor(tok) {
    if (tok.extra?.authMethod === "api_key") {
      if (tok.extra?.endpoint) {
        // 老数据可能带尾斜杠：调用方直接拼 "/generateAssistantResponse"，这里统一去掉
        return tok.extra.endpoint.replace(/\/+$/, "");
      }
      return kiroUrl(KIRO_URLS.q, kiroRegionOf(tok));
    }
    return kiroUrl(KIRO_URLS.runtime, kiroRegionOf(tok));
  },
  headers(tok) {
    return kiroApiHeaders(tok);
  },
  async login(ctx) {
    const mode = ctx.mode || "import";
    if (mode === "browser" || mode === "oauth") {
      return kiroFinishLogin(ctx, await kiroPortalLogin(ctx));
    }
    if (mode === "import") {
      ctx.onPhase("正在读取本机 Kiro 的登录态…");
      return kiroFinishLogin(ctx, importKiroLocalToken());
    }
    if (mode === "access_token" || mode === "token") {
      const inp = ctx.input || {};
      ctx.onPhase("正在解析并核验 Access Token…");
      const tok = kiroTokenFromRecord({
        accessToken: inp.accessToken,
        refreshToken: inp.refreshToken,
        profileArn: inp.profileArn,
        region: inp.region,
      });
      const activated = await kiroActivateManualToken(ctx, tok);
      return kiroFinishLogin(ctx, activated);
    }
    if (mode === "json") {
      const inp = ctx.input || {};
      const text = (inp.jsonText || inp.json || "").trim();
      if (!text) {
        throw new Error("请粘贴凭证 JSON 内容");
      }
      ctx.onPhase("正在解析凭证 JSON…");
      const { tok } = kiroTokenFromJson(text);
      const activated = await kiroActivateManualToken(ctx, tok);
      return kiroFinishLogin(ctx, activated);
    }
    if (mode === "api_key" || mode === "apikey") {
      const inp = ctx.input || {};
      const key = (inp.apiKey || inp.key || "").trim();
      if (!key) {
        throw new Error("请输入 API Key");
      }
      // region / endpoint 会被拼进主机名：只认 AWS region 形态、只认 http(s) 地址，
      // 否则一个手滑（region 填成域名）就把 Key 发去了别的主机
      const region = (inp.region || "").trim().toLowerCase() || KIRO_DEFAULT_REGION;
      if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
        throw new Error(`AWS Region 格式不对：「${inp.region}」（应形如 us-east-1 / eu-central-1）`);
      }
      const endpoint = (inp.endpoint || "").trim().replace(/\/+$/, "");
      if (endpoint && !/^https?:\/\/[^\s/?#]+/i.test(endpoint)) {
        throw new Error(`自定义端点必须是 http(s) 地址：「${inp.endpoint}」`);
      }
      ctx.onPhase("正在验证 API Key…");
      const tok: OAuthToken = {
        accessToken: key,
        tokenType: "ApiKey",
        extra: {
          authMethod: "api_key",
          region,
          ...(endpoint ? { endpoint } : {}),
        },
        email: `API Key · ${key.slice(-6)}`,
        updatedAt: Date.now(),
      };
      try {
        const qUrl = endpoint || kiroUrl(KIRO_URLS.q, region);
        const url = `${qUrl}/ListAvailableModels?origin=AI_EDITOR&maxResults=1`;
        const r = await getJsonAuth(url, kiroApiKeyHeaders(tok));
        if (r.status === 401 || r.status === 403) {
          throw new Error(`API Key 验证被拒绝（HTTP ${r.status}）：${r.text.slice(0, 160)}`);
        }
      } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("API Key 验证")) {
          throw e;
        }
        // 网络不通 / 端点 404 等不算 Key 无效：仍然入池，真正请求时再报
      }
      return tok;
    }
    throw new Error(`未知的 Kiro 授权方式：${mode}`);
  },
  refresh(tok) {
    if (tok.extra?.authMethod === "api_key") {
      return Promise.resolve(tok);
    }
    return kiroRefreshToken(tok);
  },
  async listModels(tok) {
    const region = kiroRegionOf(tok);
    const arn = tok.extra?.profileArn;
    const out: VendorLiveModel[] = [];
    let next: string | undefined;
    const qBase = (tok.extra?.endpoint || kiroUrl(KIRO_URLS.q, region)).replace(/\/+$/, "");
    for (let page = 0; page < 8; page++) {
      const url =
        qBase +
        "/ListAvailableModels?origin=AI_EDITOR&maxResults=50" +
        (arn ? "&profileArn=" + encodeURIComponent(arn) : "") +
        (next ? "&nextToken=" + encodeURIComponent(next) : "");
      const r = await getJsonAuth(url, kiroApiHeaders(tok));
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`ListAvailableModels HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      }
      const models = Array.isArray(r.json.models) ? (r.json.models as Array<Record<string, unknown>>) : [];
      for (const m of models) {
        const id = str(m, "modelId");
        if (!id) {
          continue;
        }
        const limits = (m.tokenLimits && typeof m.tokenLimits === "object" ? m.tokenLimits : {}) as Record<string, unknown>;
        const inputs = Array.isArray(m.supportedInputTypes) ? (m.supportedInputTypes as unknown[]) : [];
        const eff = effortsFromSchema(m.additionalModelRequestFieldsSchema);
        out.push({
          id,
          name: str(m, "modelName") || id,
          description: str(m, "description"),
          image: inputs.some((x) => String(x).toUpperCase() === "IMAGE"),
          reasoning: !!eff.levels?.length,
          contextWindow: typeof limits.maxInputTokens === "number" ? (limits.maxInputTokens as number) : undefined,
          maxOutputTokens: typeof limits.maxOutputTokens === "number" ? (limits.maxOutputTokens as number) : undefined,
          effortLevels: eff.levels,
          effortSchemaPath: eff.path,
          defaultEffortLevel: eff.def,
          requestFieldsSchema: m.additionalModelRequestFieldsSchema,
        });
      }
      next = str(r.json, "nextToken");
      if (!next) {
        break;
      }
    }
    return out;
  },
};

export function isKiroApiKeyToken(tok: OAuthToken | undefined): boolean {
  return tok?.tokenType === "ApiKey" || tok?.extra?.authMethod === "api_key" || !!(tok?.accessToken && tok.accessToken.startsWith("ksk_"));
}

export const OAUTH_VENDORS: readonly VendorSpec[] = [kimi, codex, xai, antigravity, anthropic, kiro];

export function getVendor(id: string | undefined): VendorSpec | undefined {
  return id ? OAUTH_VENDORS.find((v) => v.id === id) : undefined;
}

/** 测试用：把某家的端点指到本地假服务器。 */
export function _setVendorUrlsForTest(
  vendor: OAuthVendorId,
  urls: Partial<typeof KIMI_URLS & typeof CODEX_URLS & typeof XAI_URLS & typeof ANTIGRAVITY_URLS & typeof ANTHROPIC_URLS & typeof KIRO_URLS>
): void {
  const target =
    vendor === "kimi" ? KIMI_URLS : vendor === "codex" ? CODEX_URLS : vendor === "xai" ? XAI_URLS : vendor === "anthropic" ? ANTHROPIC_URLS : vendor === "kiro" ? KIRO_URLS : ANTIGRAVITY_URLS;
  Object.assign(target, urls);
  const spec = getVendor(vendor);
  if (spec && typeof urls.api === "string") {
    (spec as { baseUrl: string }).baseUrl = urls.api;
  }
}

/** 测试用：缩短设备码轮询下限。 */
export function _setDevicePollMinIntervalForTest(sec: number): void {
  devicePollMinIntervalSec = sec;
}
