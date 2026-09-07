import { extractRawContextBreakdown, allocateContextTokens, RawContextBreakdown } from "./contextParser";
import * as http from "http";
import * as vscode from "vscode";
import { StringDecoder } from "string_decoder";
import { CwRequest } from "./cwTypes";
import { EVENT_STREAM_CONTENT_TYPE, EventStreamDecoder, encodeException } from "./eventstream";
import { rememberKiroClientHeaders } from "./oauth/vendors";
import { writeEvent } from "./cwEvents";
import { AnthropicStreamConverter } from "./anthropicStream";
import { OpenaiStreamConverter } from "./openaiStream";
import { ResponsesStreamConverter } from "./responsesStream";
import { StreamConverter } from "./streamShared";
import { buildAnthropicRequest, applyEffort, conversationId, latestModelId } from "./translate";
import { buildOpenaiRequest, applyOpenaiEffort, shouldEchoReasoning } from "./openaiTranslate";
import { isForcedThinkingModel } from "./thinkingPolicy";
import { buildResponsesRequest, applyResponsesEffort } from "./responsesTranslate";
import { antigravityEnvelope, buildGeminiRequest, stripAntigravityOnly } from "./geminiTranslate";
import { GeminiStreamConverter } from "./geminiStream";
import { getSelectedEffort, getSelectedMode } from "./effort";
import { isIntentClassifierRequest, buildIntentClassifierResponse } from "./intentClassifier";
import { requestUpstream, readBody } from "./upstream";
import { PortHolder, OwnershipListener } from "./portBinder";
import {
  Protocol,
  fetchAllModels,
  fetchProviderModels,
  getCachedModels,
  GROUP_HEADER_PREFIX,
  groupHeaderProviderName,
  isGroupHeaderId,
  providerForModel,
  resolveModelImage,
} from "./modelStore";
import {
  Credential,
  ProviderConfig,
  authHeaders,
  bareModelId,
  baseModelId,
  getActiveProviders,
  getProvider,
  getProviders,
  hasPool,
  isOAuthProvider,
  overrideFor,
  providerMissing,
  resolveApiUrl,
  tokenKeyOf,
} from "./providers";
import { NeedsLoginError, ensureAccessToken, vendorOf } from "./oauth";
import { isKiroApiKeyToken } from "./oauth/vendors";
import { getToken } from "./oauth/tokenStore";
import { markFailure, markSuccess, pickCredential, poolExhaustedHint, poolStatus } from "./credentialPool";
import { recordUsage } from "./usageStore";
import {
  isEnabled,
  isDebug,
  getInterceptIntentClassifier,
  getAutoRetry,
  getMaxRetries,
  getShowTokenUsage,
  getOpenaiThoughtDedupe,
} from "./config";
import { debug, error, info } from "./log";
import { serveIdentity } from "./proxyIdentity";
import { addRequestUsage, beginTurn, takeTurnTotals } from "./turnLedger";
import { buildMeteringEvents, stopReasonEvent } from "./streamShared";
import {
  ImageCount,
  countImages,
  isTextOnly,
  looksLikeImageRejection,
  markTextOnly,
  stripImages,
  strippedNotice,
} from "./imagePolicy";

/**
 * 上游线上格式：决定用哪个流转换器。anthropic=/messages；openai=/chat/completions；
 * responses=/responses；gemini=generateContent（官方 API 与 Antigravity）。记账时 openai/responses 归 openai 协议。
 */
type WireFormat = "anthropic" | "openai" | "responses" | "gemini" | "kiro";

function protocolOfWire(wire: WireFormat): Protocol {
  return wire === "anthropic" ? "anthropic" : wire === "gemini" ? "gemini" : wire === "kiro" ? "kiro" : "openai";
}

/**
 * 把常见的上游报错翻成"该怎么办"。只处理能明确定位到配置的几种，其余原样给用户看。
 */
export function upstreamErrorHint(status: number, body: string, provider: ProviderConfig, wire: WireFormat): string {
  const b = body.toLowerCase();
  // Kiro 官方直通：402 是账号月度额度用完（MONTHLY_REQUEST_COUNT），401/403 是登录态失效（IDE 里重新登录后再导入一次）
  if (wire === "kiro") {
    if (status === 402 || /monthly_request_count|usage limit/.test(b)) {
      return `「${provider.name}」这个 Kiro 账号本月额度已用完。可以在该 provider 的「编辑」里再导入一个账号成池，或等额度重置。`;
    }
    if (status === 401 || status === 403) {
      return `「${provider.name}」的 Kiro 登录态已失效：在 Kiro 里重新登录该账号，再到该 provider 的「编辑」里点「重新登录」重新导入。`;
    }
  }
  // New API / one-api 系中转：令牌所在分组没开放这条接口
  if (status === 403 && /does not allow .*dispatch|not allow(ed)? .*\/v1\/(messages|chat\/completions|responses)/.test(b)) {
    if (wire === "anthropic") {
      return `「${provider.name}」这把 Key 所在的分组不允许走 Anthropic 接口（/v1/messages）。到该 provider 的「编辑」里把 API 格式改成「OpenAI Chat Completions」，或换一个开放了 Anthropic 接口的分组/令牌。`;
    }
    return `「${provider.name}」这把 Key 所在的分组不允许当前接口。到该 provider 的「编辑」里换一种 API 格式试试，或换分组/令牌。`;
  }
  // Claude 账号登录：Anthropic 把第三方客户端的用量记在「额外用量」上，没开 / 余额为 0 / 只允许 Claude Code 的口径都落在这里。
  // 本扩展不伪装成 Claude Code 去占套餐额度（见 oauth/vendors.ts 的 Anthropic 段），所以只能请用户去开额外用量。
  if (
    vendorOf(provider)?.id === "anthropic" &&
    (status === 400 || status === 402 || status === 403 || status === 429) &&
    /extra usage|only authorized for use with claude code|usage limit|credit|billing|balance|not authorized/.test(b)
  ) {
    return `「${provider.name}」是用 Claude 账号登录的第三方客户端，Anthropic 规定其用量计入账号的「额外用量」而非订阅套餐额度：请到 https://claude.ai/settings/usage 开启额外用量并预存余额后再试（Free 账户没有额外用量功能，需先升级到 Pro / Max；或改用 console.anthropic.com 的 API Key 走「第三方 Key 直连 → Anthropic 官方」）。本扩展不会伪装成 Claude Code 去占用套餐额度。`;
  }
  if (status === 401 || (status === 403 && /invalid.*(key|token)|unauthori[sz]ed|authentication/.test(b))) {
    return isOAuthProvider(provider)
      ? `「${provider.name}」的登录可能已失效，到「编辑」里点「重新登录」。`
      : `「${provider.name}」的 API Key 被拒，检查 Key 是否正确 / 是否过期。`;
  }
  if (status === 404 && /model.*(not found|does not exist|不存在)|no such model|unknown model/.test(b)) {
    return `上游没有这个模型 id。在该 provider 的「编辑」里「刷新模型」看看它现在叫什么，或在模型页换一个。`;
  }
  if (status === 429) {
    return /quota|balance|insufficient|余额|额度|credit/.test(b) ? "额度/余额不足，请到该服务的控制台充值或更换 Key。" : "触发了上游限流，稍等再试；频繁出现可在设置里调低并发或换 provider。";
  }
  if (status === 400 && /\$ref|schema validation/.test(b)) {
    return "上游对工具参数 schema 校验失败。已内联本地 $ref；若仍报错，请把这段报错发给我们排查。";
  }
  return "";
}

/** 首发带图、且模型尚未被判定为纯文本时，供上游拒绝后剥图重发用的材料。 */
interface ImageFallback {
  original: CwRequest;
  kiroModel: string;
  images: ImageCount;
}

interface DispatchOpts {
  /** 发送前已剥图时给用户的提示（紧跟 messageMetadataEvent 之后输出）。 */
  notice?: string;
  fallback?: ImageFallback;
  /** 本次请求选中的凭证（key 池里的一把；单凭证 provider 就是它唯一的那把）。 */
  credential: Credential;
  /** 带图发出，且图片支持是用户手动钉成「支持」的（被拒时提示里要点明）。 */
  forcedImage?: boolean;
  /** Kiro 发来的原始请求头（Kiro 官方直通要整套镜像过去）。 */
  inHeaders?: http.IncomingHttpHeaders;
  /** 提取的原始上下文成分字符数，供结束时按真实 inputTokens 严格无损分配。 */
  rawContextBreakdown?: RawContextBreakdown;
}

interface RetryOpts extends DispatchOpts {
  /** 上游以"不支持图片"拒绝时，返回剥图后重新组好的请求体。 */
  onImageRejection?: () => Promise<string | undefined>;
  /** 请求体依赖凭证（Kiro 官方的 profileArn 随账号变）：换凭证后按新凭证重组请求体。 */
  bodyFor?: (cred: Credential) => Promise<string>;
  /** 目标地址依赖凭证（Kiro 官方：API Key 账号打 q.{region}，OAuth 账号打 runtime.{region}.kiro.dev）。 */
  urlFor?: (cred: Credential) => string;
  /**
   * 上游 401 时（OAuth token 被提前吊销 / 服务端时钟不齐），对**当前凭证**强制刷新登录并返回新请求头；
   * 返回 undefined 表示刷不了（需要重新登录），按普通失败处理。每把凭证只用一次。
   */
  onAuthRejected?: (cred: Credential) => Promise<Record<string, string> | undefined>;
  /**
   * key 池：换到另一把凭证后重新造请求头（OAuth 类会先把该凭证的 token 刷新鲜）。
   * 返回 undefined 表示这把也用不了（登录失效），调度器会继续换下一把。
   */
  headersFor?: (cred: Credential) => Promise<Record<string, string> | undefined>;
  /** 记账用的请求元信息。 */
  meta: UsageMeta;
}

/** 一次上游请求落账所需的上下文（用量页数据源，见 usageStore.ts）。 */
interface UsageMeta {
  provider: ProviderConfig;
  /** 本次实际用的凭证（key 池里的哪一把）；换 key 重发时会被更新。 */
  credential: Credential;
  /** Kiro 选中的模型（去 effort 后缀）。 */
  kiroModel: string;
  /** 实际发给上游的模型 id。 */
  upstreamModel: string;
  convId: string;
  startedAt: number;
  rawContextBreakdown?: RawContextBreakdown;
}

/** 取响应头（Node 已小写化键名；多值取第一个）。 */
function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 这次请求是否是工具循环的延续。Kiro 把上一轮 assistant 声明的工具的执行结果放在
 * currentMessage 里回传；没有 toolResults 就说明是用户新发起的一轮。
 */
function hasToolResults(req: CwRequest): boolean {
  const results =
    req.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults;
  return Array.isArray(results) && results.length > 0;
}

export class KrsProxyServer {
  private holder: PortHolder;
  private port: number;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, port: number, onOwnershipChange?: OwnershipListener) {
    this.context = context;
    this.port = port;
    this.holder = new PortHolder(
      port,
      "KRS",
      () => http.createServer((req, res) => this.handleRequest(req, res)),
      onOwnershipChange
    );
  }

  async start(): Promise<void> {
    await this.holder.start();
  }

  async stop(): Promise<void> {
    await this.holder.stop();
  }

  isOwner(): boolean {
    return this.holder.isOwner();
  }

  hadForeignConflict(): boolean {
    return this.holder.hadForeignConflict();
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (serveIdentity(url, res, "krs")) {
      return;
    }

    // 入站体按 UTF-8 流式解码：Kiro 每轮重放全部历史，几百 KB 的中文请求体会被 TCP 切成多块，
    // 逐块 toString() 会把跨块的多字节字解成 U+FFFD，提示词被静默改写后发往上游。
    let body = "";
    const bodyDecoder = new StringDecoder("utf8");
    req.on("data", (chunk: Buffer) => {
      body += bodyDecoder.write(chunk);
    });
    req.on("end", async () => {
      body += bodyDecoder.end();
      try {
        if (!isEnabled()) {
          // Proxy disabled: shouldn't normally be reachable, but be safe.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        const path = url.split("?")[0];
        const isGenerate =
          path === "/generateAssistantResponse" ||
          path === "/SendMessageStreaming" ||
          (method === "POST" && body.indexOf("conversationState") !== -1);

        if (isGenerate) {
          // Kiro 官方直通要镜像这套头；顺带记下客户端标识，供我们自己发起的官方接口调用复用
          rememberKiroClientHeaders(req.headers);
          await this.handleGenerate(res, body, req.headers);
        } else if (method === "POST" && this.looksLikeJsonRpc(body)) {
          // Kiro 的 InvokeMCPCommand（服务端 MCP 工具发现）走的是流式客户端端点，
          // 会被路由到这里。本地就地应答一个合法的 JSON-RPC 结果。
          this.handleMcpJsonRpc(res, body);
        } else {
          info("KRS unhandled:", method, path);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      } catch (e) {
        error("KRS error:", (e as Error).message);
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json",
            "x-amzn-errortype": "InternalServerException",
          });
        }
        res.end(JSON.stringify({ __type: "InternalServerException", message: (e as Error).message }));
      }
    });
  }

  /** Heuristic: Kiro's InvokeMCPCommand body is JSON-RPC ({"jsonrpc","method",...}). */
  private looksLikeJsonRpc(body: string): boolean {
    return body.indexOf('"jsonrpc"') !== -1 && body.indexOf('"method"') !== -1;
  }

  /**
   * Answer Kiro's server-side MCP discovery (InvokeMCPCommand) locally.
   *
   * Kiro routes CodeWhisperer streaming-client commands (including InvokeMCPCommand)
   * to the runtime endpoint, which this proxy now owns. Against a real AWS backend
   * that call returns the backend's hosted MCP tools; against a third-party relay
   * there are none. Returning `{}` is invalid JSON-RPC and makes Kiro's
   * RemoteToolsDiscovery fail (the agent then looks like it has no tools). Kiro's
   * file/terminal capabilities are client-side (ACP) and unaffected, so we reply
   * with a *valid* JSON-RPC result advertising no remote tools — discovery then
   * succeeds cleanly and the local tools remain available.
   */
  private handleMcpJsonRpc(res: http.ServerResponse, rawBody: string): void {
    let id: unknown = null;
    let rpcMethod = "";
    try {
      const parsed = JSON.parse(rawBody);
      id = parsed?.id ?? null;
      rpcMethod = typeof parsed?.method === "string" ? parsed.method : "";
    } catch {
      /* fall through to a generic empty result */
    }

    info("KRS MCP:", rpcMethod || "(unparsed)");

    // JSON-RPC notifications carry no id and expect no response body.
    if (id === null || id === undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
      return;
    }

    const version = this.context.extension.packageJSON.version || "0.0.0";
    let result: unknown;
    switch (rpcMethod) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "api2kiro-dual", version },
        };
        break;
      case "tools/list":
        result = { tools: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      default:
        result = {};
        break;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private beginEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": EVENT_STREAM_CONTENT_TYPE,
      "Transfer-Encoding": "chunked",
    });
    try {
      res.socket?.setNoDelay(true);
    } catch {
      /* ignore */
    }
  }

  /** Emit a friendly setup message as a normal assistant reply. */
  private writeSetupMessage(res: http.ServerResponse, convId: string, msg: string): void {
    this.beginEventStream(res);
    writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
    writeEvent(res, { assistantResponseEvent: { content: msg, modelId: "api2kiro-dual-setup" } });
    // 没有 stopReason 的纯文本会被 Kiro 当作截断而自动重发一次（见 streamShared.toCwStopReason）
    writeEvent(res, stopReasonEvent("END_TURN"));
    res.end();
  }

  /**
   * 决定这次请求发给哪个 provider。
   *
   * 优先级（高到低）：
   *  1. 只有一个启用 provider → 就用它；
   *  2. 模型 id 在合并缓存里属于哪个 provider（冷启动缓存为空时先拉一次）；
   *  3. 用户在某个 provider 的 modelMapping 里显式写了这个 id → 用那个 provider；
   *  4. 兜底：第一个启用 provider。
   */
  private async pickProvider(kiroModel: string): Promise<ProviderConfig | undefined> {
    const active = getActiveProviders();
    if (active.length === 0) {
      return undefined;
    }
    if (active.length === 1) {
      return active[0];
    }

    // 冷启动/上次拉取失败时缓存为空，先补一次（60s 缓存，代价可忽略）。
    if (getCachedModels().length === 0) {
      await fetchAllModels(false);
    }
    const byList = providerForModel(kiroModel);
    if (byList) {
      return byList;
    }

    // 用户显式映射：把这个 Kiro id 写进了某 provider 的 modelMapping。
    const bare = bareModelId(kiroModel);
    for (const p of active) {
      if (p.modelMapping && (p.modelMapping[kiroModel] || p.modelMapping[bare])) {
        return p;
      }
    }
    return active[0];
  }

  private async handleGenerate(res: http.ServerResponse, rawBody: string, inHeaders: http.IncomingHttpHeaders = {}): Promise<void> {
    let parsed: CwRequest;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    const convId = conversationId(parsed);
    let kiroModelRaw = latestModelId(parsed);

    // 轮次边界：带 toolResults 的是工具循环的延续，不带的是用户发起的新一轮。
    // 在这里重置账本，即使上一轮因取消/报错没能结算，也不会把旧数字带进新一轮。
    if (!hasToolResults(parsed)) {
      beginTurn(convId);
    }

    const active = getActiveProviders();
    if (active.length === 0) {
      const all = getProviders();
      const lines = all.map((p) => `· ${p.name}：${providerMissing(p) || "就绪"}`);
      this.writeSetupMessage(
        res,
        convId,
        "⚠️ API4Kiro 尚无可用的 provider。\n\n请在左侧面板添加并启用至少一个 provider（填好地址 + API Key，或完成账号登录）。\n\n" +
          (lines.length ? lines.join("\n") : "（当前没有任何 provider）")
      );
      return;
    }

    // Intercept Kiro's intent classifier locally to save an upstream call.
    if (getInterceptIntentClassifier() && isIntentClassifierRequest(parsed)) {
      debug("intent classifier intercepted", { conversationId: convId });
      this.beginEventStream(res);
      for (const ev of buildIntentClassifierResponse(parsed, convId, kiroModelRaw)) {
        writeEvent(res, ev);
      }
      res.end();
      return;
    }

    // 选中了渠道分组标题行：智能回落到该渠道的第一个可用模型，避免「无模型/空白」
    if (isGroupHeaderId(kiroModelRaw)) {
      const pid = kiroModelRaw.slice(GROUP_HEADER_PREFIX.length);
      const targetProv = getProvider(pid);
      const firstModel = targetProv?.enabledModels?.[0];
      if (firstModel) {
        info(`[KRS] 选中的是渠道分组标题「${targetProv.name}」，智能回落到该渠道首选模型「${firstModel}」`);
        kiroModelRaw = firstModel;
        // 四个 build*Request 都经 latestModelId(req) 从请求体里取模型（当前消息优先，其次历史倒序），
        // 只改局部变量会把 a2k-group:… 原样发给上游 → 404。请求体里所有分组标题 id 一并改写
        // （Kiro 官方直通还会把历史 modelId 原样带过去）。
        const state = parsed.conversationState;
        for (const item of [...(state.history || []), ...(state.currentMessage ? [state.currentMessage] : [])]) {
          const uim = item.userInputMessage;
          if (uim && typeof uim.modelId === "string" && isGroupHeaderId(uim.modelId)) {
            uim.modelId = firstModel;
          }
        }
      } else {
        const name = groupHeaderProviderName(kiroModelRaw);
        this.writeSetupMessage(
          res,
          convId,
          `ℹ️ 「${name}」是渠道分组标题，不是具体模型。\n\n请在模型选择器里选择该标题下面的具体模型。`
        );
        return;
      }
    }

    // 路由用 Kiro 给的完整 id（可能带 @providerId 渠道限定）；之后的能力判定 / 日志 / 记账都用裸 id
    const provider = await this.pickProvider(kiroModelRaw);
    if (!provider) {
      this.writeSetupMessage(res, convId, "⚠️ 没有可用的 provider，请在面板中配置。");
      return;
    }
    const kiroModel = bareModelId(kiroModelRaw);

    // key 池：选一把凭证（会话粘性 → 策略 → 优先没在冷却的）。全部冷却也不在本地拒绝：
    // 用最早解冻的那把照常发，成功即清冷却，失败让用户看到真实的上游错误。拿不到凭证只剩「根本没配」一种情况。
    const picked = pickCredential(provider, convId);
    if (!picked) {
      this.writeSetupMessage(res, convId, `⚠️ 「${provider.name}」没有可用的凭证：${providerMissing(provider) || "请在面板里补全"}。`);
      return;
    }
    let credential = picked.credential;
    if (picked.cooling) {
      info(`[${provider.name}] 凭证 ${credential.label || credential.id} 仍在冷却，但没有别的可用，照常再试一次 conv=${convId}`);
    } else if (hasPool(provider)) {
      debug("credential picked", { provider: provider.id, credential: credential.id, sticky: picked.sticky, conv: convId });
    }

    // 登录类 provider：请求前把 token 刷新鲜；刷不了（登录失效）就换下一把，全都刷不了才告诉用户去重新登录。
    if (isOAuthProvider(provider)) {
      const tried = new Set<string>();
      let lastErr = "";
      for (;;) {
        try {
          await ensureAccessToken(provider, false, credential);
          break;
        } catch (e) {
          lastErr = e instanceof NeedsLoginError ? e.message : `「${provider.name}」登录状态异常：${(e as Error).message}`;
          tried.add(credential.id);
          markFailure(provider, credential, 401, lastErr);
          const next = pickCredential(provider, convId, tried);
          if (!next) {
            this.writeSetupMessage(res, convId, `⚠️ ${lastErr}\n\n请到左侧「提供商」页，在该 provider 的设置里点「重新登录」。`);
            return;
          }
          credential = next.credential;
        }
      }
    }

    // 图片策略。判定优先级（对齐 resolveModelImage）：
    //   - 用户/目录明确「支持图片」 → 原样发，且不做被拒学习（用户说了算）；
    //   - 用户/目录明确「不支持」或曾被学习为纯文本 → 发送前剥图（含历史，否则一张图污染整个对话）；
    //   - 未知 → 先照发，被上游以"不支持图片"拒绝时再学习 + 剥图重发（见 streamWithRetry）。
    const images = countImages(parsed);
    const imageDecided = resolveModelImage(kiroModel, provider.id); // true/false/undefined
    const knownTextOnly = imageDecided === false || (imageDecided === undefined && isTextOnly(kiroModel));
    let request = parsed;
    let notice: string | undefined;
    if (images.total > 0 && knownTextOnly) {
      request = stripImages(parsed);
      notice = strippedNotice(kiroModel, images);
      info(`模型 ${kiroModel} 为纯文本，已剥离 ${images.total} 张图片（当前消息 ${images.inCurrent} 张）`);
    }
    // 只有「能力未知」时才保留被拒后学习的兜底；用户已明确声明支持则不学习。
    const fallback: ImageFallback | undefined =
      images.total > 0 && request === parsed && imageDecided === undefined
        ? { original: parsed, kiroModel, images }
        : undefined;
    // 用户手动把一个模型钉成「支持图片」、带图发出去却被上游拒了：不学习、不剥图重发（尊重用户），
    // 但要把"是你钉的"这件事说清楚，否则报错看起来像代理坏了。
    const forcedImage = images.total > 0 && request === parsed && overrideFor(provider, kiroModel)?.image === true;

    const rawContextBreakdown = extractRawContextBreakdown(parsed);
    const version = this.context.extension.packageJSON.version || "0.0.0";
    const dispatch: DispatchOpts = { notice, fallback, credential, forcedImage, inHeaders, rawContextBreakdown };
    if (provider.protocol === "kiro") {
      await this.dispatchKiro(res, request, convId, kiroModel, provider, version, dispatch);
    } else if (provider.protocol === "gemini") {
      await this.dispatchGemini(res, request, convId, kiroModel, provider, version, dispatch);
    } else if (provider.protocol === "openai" && provider.openaiApi === "responses") {
      await this.dispatchResponses(res, request, convId, kiroModel, provider, version, dispatch);
    } else if (provider.protocol === "openai") {
      await this.dispatchOpenai(res, request, convId, kiroModel, provider, version, dispatch);
    } else {
      await this.dispatchAnthropic(res, request, convId, kiroModel, provider, version, dispatch);
    }
  }

  /**
   * 上游请求头（用指定凭证）。key 类：协议鉴权头 + 我们的 X-Client；OAuth 类：厂商规定的整套头
   * （Bearer / 账号 id / UA / 设备 id…），不再附加自报家门的 X-Client，免得被当成异常客户端。
   */
  private upstreamHeaders(provider: ProviderConfig, version: string, cred: Credential, inHeaders?: http.IncomingHttpHeaders): Record<string, string> {
    if (provider.protocol === "kiro") {
      return this.kiroHeaders(provider, cred, inHeaders);
    }
    if (isOAuthProvider(provider)) {
      return { "Content-Type": "application/json", ...authHeaders(provider, true, cred), Accept: "text/event-stream" };
    }
    return {
      "Content-Type": "application/json",
      ...authHeaders(provider, false, cred),
      Accept: "text/event-stream",
      "X-Client": "api2kiro-dual/" + version,
    };
  }

  /**
   * Kiro 官方直通的请求头：Kiro 发来的整套头原样镜像（user-agent / x-amz-user-agent /
   * x-amzn-kiro-agent-mode / x-amzn-codewhisperer-optout / amz-sdk-* …），只去掉逐跳头与压缩协商，
   * 再用该凭证的 token 换掉 Authorization。厂商给的合成头只做兜底（Kiro 没带时才用）。
   */
  private kiroHeaders(provider: ProviderConfig, cred: Credential, inHeaders?: http.IncomingHttpHeaders): Record<string, string> {
    const drop = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding", "authorization", "accept-encoding", "te", "upgrade", "cookie", "proxy-authorization", "proxy-connection"]);
    const h: Record<string, string> = { ...authHeaders(provider, true, cred) };
    for (const [k, v] of Object.entries(inHeaders || {})) {
      const key = k.toLowerCase();
      const val = Array.isArray(v) ? v[0] : v;
      if (val && !drop.has(key) && !key.startsWith("proxy-")) {
        h[key] = val;
      }
    }
    const tok = getToken(tokenKeyOf(provider.id, cred.id));
    if (tok) {
      h.authorization = "Bearer " + tok.accessToken;
    }
    delete h.Authorization;
    // 官方 API Key（ksk_）当 Bearer 用时必须声明 tokentype，否则服务端按 OAuth token 校验 → 403
    if (isKiroApiKeyToken(tok)) {
      h.tokentype = "API_KEY";
    } else {
      delete h.tokentype;
    }
    return h;
  }

  /** OAuth 类 provider 的 401 兜底：对当前凭证强制刷新一次 token，给出新请求头。 */
  private authRetry(provider: ProviderConfig, version: string, inHeaders?: http.IncomingHttpHeaders): RetryOpts["onAuthRejected"] {
    if (!isOAuthProvider(provider)) {
      return undefined;
    }
    return async (cred) => {
      try {
        await ensureAccessToken(provider, true, cred);
        return this.upstreamHeaders(provider, version, cred, inHeaders);
      } catch (e) {
        error(`[${provider.name}] 401 后刷新登录失败:`, (e as Error).message);
        return undefined;
      }
    };
  }

  /** key 池换凭证后的请求头：OAuth 类先把该凭证 token 刷新鲜，刷不了返回 undefined 让调度器继续换。 */
  private headersFor(provider: ProviderConfig, version: string, inHeaders?: http.IncomingHttpHeaders): RetryOpts["headersFor"] {
    if (!hasPool(provider)) {
      return undefined;
    }
    return async (cred) => {
      if (isOAuthProvider(provider)) {
        try {
          await ensureAccessToken(provider, false, cred);
        } catch (e) {
          error(`[${provider.name}] 切换到凭证 ${cred.label || cred.id} 失败:`, (e as Error).message);
          return undefined;
        }
      }
      return this.upstreamHeaders(provider, version, cred, inHeaders);
    };
  }

  /** 四个 dispatch 共用的 RetryOpts 尾部。 */
  private retryOpts(provider: ProviderConfig, version: string, opts: DispatchOpts, upstreamModel: string, kiroModel: string, convId: string, build: (req: CwRequest) => Promise<object>): RetryOpts {
    return {
      notice: opts.notice,
      credential: opts.credential,
      forcedImage: opts.forcedImage,
      onImageRejection: opts.fallback ? async () => JSON.stringify(await build(stripImages(opts.fallback!.original))) : undefined,
      onAuthRejected: this.authRetry(provider, version, opts.inHeaders),
      headersFor: this.headersFor(provider, version, opts.inHeaders),
      fallback: opts.fallback,
      meta: { provider, credential: opts.credential, kiroModel: baseModelId(kiroModel), upstreamModel, convId, startedAt: Date.now(), rawContextBreakdown: opts.rawContextBreakdown },
    };
  }

  /**
   * Kiro 官方：不翻译。Kiro 发来的 CodeWhisperer 请求体原样转发到 Kiro 自己的后端
   * （runtime.<region>.kiro.dev/generateAssistantResponse），只做三件事：
   *   · 模型 id 去掉我们加的 @providerId 渠道限定（官方只认裸 id）；
   *   · profileArn 换成该账号自己的（Kiro 发来的是它当前登录账号的，池里换账号就对不上）；
   *   · 请求头整套镜像 + 换 Authorization（见 kiroHeaders）。
   * 响应是同一种 event-stream，字节直通（见 pumpKiroPassthrough）。
   */
  private async dispatchKiro(
    res: http.ServerResponse,
    parsed: CwRequest,
    convId: string,
    kiroModel: string,
    provider: ProviderConfig,
    version: string,
    opts: DispatchOpts
  ): Promise<void> {
    const spec = vendorOf(provider);
    const build = async (req: CwRequest, cred: Credential) => {
      const body = JSON.parse(JSON.stringify(req)) as CwRequest & { profileArn?: string };
      const uim = body.conversationState?.currentMessage?.userInputMessage;
      if (uim && typeof uim.modelId === "string") {
        uim.modelId = bareModelId(uim.modelId);
      }
      for (const h of body.conversationState?.history || []) {
        if (h.userInputMessage && typeof h.userInputMessage.modelId === "string") {
          h.userInputMessage.modelId = bareModelId(h.userInputMessage.modelId);
        }
      }
      const tok = getToken(tokenKeyOf(provider.id, cred.id));
      const arn = tok?.extra?.profileArn;
      if (arn) {
        body.profileArn = arn;
      } else if (isKiroApiKeyToken(tok)) {
        // 官方 API Key（ksk_）没有 profile：Kiro 发来的是它自己账号的 ARN，带着打 q.* 端点会 403
        delete body.profileArn;
      }
      return body;
    };
    const urlFor = (cred: Credential) => {
      const tok = getToken(tokenKeyOf(provider.id, cred.id));
      const base = spec?.apiBaseFor && tok ? spec.apiBaseFor(tok) : provider.baseUrl;
      return base.replace(/\/+$/, "") + "/generateAssistantResponse";
    };
    const body = await build(parsed, opts.credential);
    const targetUrl = urlFor(opts.credential);
    const headers = this.upstreamHeaders(provider, version, opts.credential, opts.inHeaders);
    const model = body.conversationState?.currentMessage?.userInputMessage?.modelId || kiroModel;

    info(`→ [${provider.name}${this.credTag(provider, opts.credential)}] kiro passthrough model=${model} (kiro=${kiroModel}) conv=${convId}`);
    debug("upstream request", { url: targetUrl, profileArn: body.profileArn, model });

    const ro = this.retryOpts(provider, version, opts, model, kiroModel, convId, (req) => build(req, opts.credential));
    ro.bodyFor = async (cred) => JSON.stringify(await build(parsed, cred));
    ro.urlFor = urlFor;
    await this.streamWithRetry(res, "kiro", targetUrl, headers, JSON.stringify(body), convId, model, ro);
  }

  /** 厂商对请求体的硬性修正（Codex 拒绝 max_output_tokens 等）。 */
  private adjustForVendor(provider: ProviderConfig, body: object, format: "anthropic" | "chat" | "responses"): void {
    vendorOf(provider)?.adjustBody?.(body as Record<string, unknown>, format);
  }

  /** Anthropic 协议：/v1/messages。 */
  private async dispatchAnthropic(
    res: http.ServerResponse,
    parsed: CwRequest,
    convId: string,
    kiroModel: string,
    provider: ProviderConfig,
    version: string,
    opts: DispatchOpts
  ): Promise<void> {
    const official = provider.anthropicMode === "official";
    let effortInfo = "";
    // 同一套组包逻辑既用于首发，也用于"上游拒绝图片后剥图重发"，必须可重入。
    const build = async (req: CwRequest) => {
      const body = buildAnthropicRequest(req, provider);
      if (official) {
        // 官方 Anthropic 模式：纯透传，剥掉 Kiro 私有 / 思考字段（output_config 私有；thinking 交给上游默认）
        delete body.thinking;
        delete body.output_config;
      } else {
        const effort = await getSelectedEffort(req);
        const reasoningMode = getSelectedMode(req);
        applyEffort(body, provider.id, effort, reasoningMode);
        effortInfo = `${effort ? ", effort=" + effort : ""}${reasoningMode ? ", mode=" + reasoningMode : ""}`;
      }
      this.adjustForVendor(provider, body, "anthropic");
      return body;
    };
    const body = await build(parsed);
    const targetUrl = resolveApiUrl(provider, "/messages");
    const headers = this.upstreamHeaders(provider, version, opts.credential);

    info(
      `→ [${provider.name}${this.credTag(provider, opts.credential)}] /messages [${official ? "official" : "kiro"}] model=${body.model} (kiro=${kiroModel}${effortInfo}) conv=${convId}`
    );
    debug("upstream request", { url: targetUrl, body });

    await this.streamWithRetry(res, "anthropic", targetUrl, headers, JSON.stringify(body), convId, body.model,
      this.retryOpts(provider, version, opts, body.model, kiroModel, convId, build));
  }

  /** 日志里标出用的是池里哪一把（单凭证不标）。 */
  private credTag(provider: ProviderConfig, cred: Credential): string {
    return hasPool(provider) ? ` · ${cred.label || cred.id}` : "";
  }

  /** OpenAI 协议：/v1/chat/completions。 */
  private async dispatchOpenai(
    res: http.ServerResponse,
    parsed: CwRequest,
    convId: string,
    kiroModel: string,
    provider: ProviderConfig,
    version: string,
    opts: DispatchOpts
  ): Promise<void> {
    const build = async (req: CwRequest) => {
      const body = buildOpenaiRequest(req, provider);
      applyOpenaiEffort(body, await getSelectedEffort(req), provider, req);
      this.adjustForVendor(provider, body, "chat");
      return body;
    };
    const body = await build(parsed);
    const targetUrl = resolveApiUrl(provider, "/chat/completions");
    const headers = this.upstreamHeaders(provider, version, opts.credential);

    info(
      `→ [${provider.name}${this.credTag(provider, opts.credential)}] /chat/completions model=${body.model} (kiro=${kiroModel}` +
        `${body.reasoning_effort ? ", reasoning_effort=" + body.reasoning_effort : ""}) conv=${convId}`
    );
    debug("upstream request", { url: targetUrl, body });

    await this.streamWithRetry(res, "openai", targetUrl, headers, JSON.stringify(body), convId, body.model,
      this.retryOpts(provider, version, opts, body.model, kiroModel, convId, build));
  }

  /** OpenAI Responses 接口：/v1/responses。 */
  private async dispatchResponses(
    res: http.ServerResponse,
    parsed: CwRequest,
    convId: string,
    kiroModel: string,
    provider: ProviderConfig,
    version: string,
    opts: DispatchOpts
  ): Promise<void> {
    const build = async (req: CwRequest) => {
      const body = buildResponsesRequest(req, provider);
      applyResponsesEffort(body, await getSelectedEffort(req));
      this.adjustForVendor(provider, body, "responses");
      return body;
    };
    const body = await build(parsed);
    const targetUrl = resolveApiUrl(provider, "/responses");
    const headers = this.upstreamHeaders(provider, version, opts.credential);

    info(
      `→ [${provider.name}${this.credTag(provider, opts.credential)}] /responses model=${body.model} (kiro=${kiroModel}` +
        `${body.reasoning ? ", reasoning=" + body.reasoning.effort : ""}) conv=${convId}`
    );
    debug("upstream request", { url: targetUrl, body });

    await this.streamWithRetry(res, "responses", targetUrl, headers, JSON.stringify(body), convId, body.model,
      this.retryOpts(provider, version, opts, body.model, kiroModel, convId, build));
  }

  /**
   * Gemini 协议：官方 API 打 /models/{model}:streamGenerateContent；Antigravity 打
   * /v1internal:streamGenerateContent 并包信封（project 来自登录时拿到的 token.extra.project）。
   */
  private async dispatchGemini(
    res: http.ServerResponse,
    parsed: CwRequest,
    convId: string,
    kiroModel: string,
    provider: ProviderConfig,
    version: string,
    opts: DispatchOpts
  ): Promise<void> {
    const vendor = vendorOf(provider);
    const isAntigravity = vendor?.id === "antigravity";
    // Antigravity 的 project 是账号级的，跟着选中的那把凭证走
    const project = isAntigravity ? getToken(tokenKeyOf(provider.id, opts.credential.id))?.extra?.project || "" : "";
    if (isAntigravity && !project) {
      this.writeSetupMessage(res, convId, `⚠️ 「${provider.name}」没有 Antigravity 项目信息，请在 provider 设置里重新登录。`);
      return;
    }
    // 变体解析要看该 provider 的模型目录（gemini-3.1-pro-low 一类自带档位的 id）
    const catalog = (await fetchProviderModels(provider, false)).map((m) => m.id);
    let model = "";
    const build = async (req: CwRequest) => {
      const effort = await getSelectedEffort(req);
      const built = buildGeminiRequest(req, provider, { effort, convId }, catalog);
      model = built.model;
      return isAntigravity ? antigravityEnvelope(built.model, built.request, project) : stripAntigravityOnly(built.request);
    };
    const body = await build(parsed);
    const targetUrl = isAntigravity
      ? provider.baseUrl.replace(/\/+$/, "") + "/v1internal:streamGenerateContent?alt=sse"
      : resolveApiUrl(provider, `/models/${encodeURIComponent(model)}:streamGenerateContent`) + "?alt=sse";
    const headers = this.upstreamHeaders(provider, version, opts.credential);

    info(`→ [${provider.name}${this.credTag(provider, opts.credential)}] ${isAntigravity ? "antigravity" : "gemini"} model=${model} (kiro=${kiroModel}) conv=${convId}`);
    debug("upstream request", { url: targetUrl, body });

    const ro = this.retryOpts(provider, version, opts, model, kiroModel, convId, build);
    if (isAntigravity) {
      // 请求体里嵌着账号的 project，换账号得连 body 一起换——这里不支持请求中途换 key，
      // 只在请求前（pickCredential）按冷却状态选；失败照样冷却，下一次请求自然落到别的账号。
      ro.headersFor = undefined;
    }
    await this.streamWithRetry(res, "gemini", targetUrl, headers, JSON.stringify(body), convId, model, ro);
  }

  /**
   * 发起上游请求并流式转换回 Kiro。重试只发生在**拿到 2xx 之前**：连接失败 / 可重试状态码
   * (5xx/429) 按 maxRetries 重发；剥图重发、401 强刷登录、key 池换凭证另计、不占重试配额。
   * 上游一旦回了 2xx 就进入泵（pumpStream / pumpKiroPassthrough），之后流中途断掉**不重试**
   * （已向客户端输出的内容无法撤回，重发会重复），只由泵尽力收尾：flush 补 stopReason、记账、结束响应。
   */
  private async streamWithRetry(
    res: http.ServerResponse,
    wire: WireFormat,
    targetUrl: string,
    initialHeaders: Record<string, string>,
    initialBody: string,
    convId: string,
    modelId: string,
    opts: RetryOpts
  ): Promise<void> {
    const maxAttempts = getAutoRetry() ? getMaxRetries() + 1 : 1;
    let lastReason = "";
    let bodyStr = initialBody;
    let url = targetUrl;
    let notice = opts.notice;
    // 剥图重发独立于普通重试次数：它不是"上游抖了"，而是我们发错了内容，理应有一次纠正机会。
    let imageRetryUsed = false;
    // 同理，401 后强刷登录再发一次也不占重试配额（每把凭证一次）。
    const authRetried = new Set<string>();
    let headers = initialHeaders;
    const meta = opts.meta;
    const provider = meta.provider;
    const protocol: Protocol = protocolOfWire(wire);
    // key 池：本次请求已经试过的凭证；换 key 重发次数上限 = 池大小（每把最多轮到一次）
    const triedCreds = new Set<string>([meta.credential.id]);
    const pool = hasPool(provider);

    /** 失败落账（连接失败 / 非 2xx 最终放弃）。重试中途的失败不记，只记最终结果。 */
    const recordFailure = (status: number, err: string) => {
      recordUsage({
        ts: Date.now(),
        providerId: provider.id,
        providerName: provider.name,
        credentialId: pool ? meta.credential.id : undefined,
        model: meta.kiroModel,
        upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
        protocol,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: Date.now() - meta.startedAt,
        status,
        ok: false,
        error: err.slice(0, 200),
        conversationId: meta.convId,
      });
    };

    /**
     * 池里换一把：只换到健康的（跳过已试过的和冷却中的——同一请求内不回头去碰刚失败过的 key；
     * 冷却中的 key 由下一次请求的首选兜底再试）；拿到后重造请求头（OAuth 刷 token 可能失败，
     * 失败就把那把也标掉继续换）。换成功返回 true（调用方 continue），没有健康的可换返回 false。
     */
    const rotateCredential = async (why: string): Promise<boolean> => {
      if (!opts.headersFor) {
        return false;
      }
      for (;;) {
        const next = pickCredential(provider, convId, triedCreds, { allowCooling: false });
        if (!next) {
          return false;
        }
        triedCreds.add(next.credential.id);
        const h = await opts.headersFor(next.credential);
        if (!h) {
          markFailure(provider, next.credential, 401, "token refresh failed");
          continue;
        }
        headers = h;
        meta.credential = next.credential;
        if (opts.bodyFor) {
          bodyStr = await opts.bodyFor(next.credential);
        }
        if (opts.urlFor) {
          url = opts.urlFor(next.credential);
        }
        lastReason = `${why}，切换到凭证 ${next.credential.label || next.credential.id}`;
        info(`↻ [${provider.name}] ${lastReason} conv=${convId}`);
        return true;
      }
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const backoff = Math.min(300 * (attempt - 1), 1500);
        info(`↻ 自动重试 ${attempt}/${maxAttempts} (${backoff}ms后) conv=${convId} 原因=${lastReason}`);
        await new Promise((r) => setTimeout(r, backoff));
      }

      // 1) 发起上游请求（连接失败可重试）
      let upstream;
      try {
        upstream = await requestUpstream("POST", url, headers, bodyStr);
      } catch (e) {
        lastReason = "连接失败: " + (e as Error).message;
        error("upstream fetch failed:", (e as Error).message);
        // 网络错误是链路问题不是 key 问题：短冷却但不换 key（换了大概率一样）
        markFailure(provider, meta.credential, 0, (e as Error).message);
        if (attempt < maxAttempts) {
          continue;
        }
        recordFailure(0, "连接失败: " + (e as Error).message);
        res.writeHead(502, {
          "Content-Type": "application/json",
          "x-amzn-errortype": "InternalServerException",
        });
        res.end(
          JSON.stringify({
            __type: "InternalServerException",
            message: "无法连接中转站：" + (e as Error).message,
          })
        );
        return;
      }

      // 2) 非 2xx：5xx/429 可重试；"不支持图片"的 4xx 剥图重发一次；凭证类错误换 key；其余(4xx)直接透传给客户端
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const errText = await readBody(upstream.body);
        error(`upstream ${upstream.statusCode}:`, errText.slice(0, 300));

        if (
          !imageRetryUsed &&
          opts.onImageRejection &&
          opts.fallback &&
          looksLikeImageRejection(upstream.statusCode, errText)
        ) {
          imageRetryUsed = true;
          const fb = opts.fallback;
          await markTextOnly(fb.kiroModel);
          const rebuilt = await opts.onImageRejection();
          if (rebuilt) {
            bodyStr = rebuilt;
            notice = strippedNotice(fb.kiroModel, fb.images);
            lastReason = "上游拒绝图片输入，已剥离图片重发";
            attempt--; // 不占用普通重试配额
            continue;
          }
        }

        // 401 先给当前凭证一次"强刷 token 再试"的机会（OAuth 类）；刷不了再走下面的换 key / 报错
        if (upstream.statusCode === 401 && !authRetried.has(meta.credential.id) && opts.onAuthRejected) {
          authRetried.add(meta.credential.id);
          const fresh = await opts.onAuthRejected(meta.credential);
          if (fresh) {
            headers = fresh;
            lastReason = "上游 401，已刷新登录重发";
            attempt--;
            continue;
          }
        }

        // key 池记账：按错误类型冷却这把；凭证自身的问题（401/402/403/额度）且池里还有别的 → 换一把重发
        const verdict = markFailure(provider, meta.credential, upstream.statusCode, errText, headerValue(upstream.headers, "retry-after"));
        if (verdict.rotate && (await rotateCredential(`凭证${verdict.kind === "quota" ? "额度不足" : verdict.kind === "auth" ? "鉴权失败" : "无权限"}`))) {
          attempt--; // 换 key 不占普通重试配额
          continue;
        }
        // 429 在池里也值得换一把再试：这把被限流不代表别的也被限（同一账号多把 key 除外，那由冷却兜底）
        if (pool && verdict.kind === "ratelimit" && (await rotateCredential("凭证被限流"))) {
          attempt--;
          continue;
        }

        const retryable = upstream.statusCode >= 500 || upstream.statusCode === 429;
        if (retryable && attempt < maxAttempts) {
          lastReason = `上游 ${upstream.statusCode}`;
          continue;
        }
        recordFailure(upstream.statusCode, errText);
        this.beginEventStream(res);
        writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
        let hint = upstreamErrorHint(upstream.statusCode, errText, provider, wire);
        if (opts.forcedImage && looksLikeImageRejection(upstream.statusCode, errText)) {
          hint =
            `这个模型在「${provider.name}」的编辑弹窗里被手动设成了「支持图片」，但上游拒绝了图片输入。` +
            `请把它的「图片」标签切回「自动」或「不支持」，代理会在发送前自动剥掉图片。` +
            (hint ? `\n\n${hint}` : "");
        }
        if (pool && poolStatus(provider).cooling === poolStatus(provider).configured) {
          hint = poolExhaustedHint(provider) + (hint ? `\n\n${hint}` : "");
        } else if (pool && triedCreds.size > 1) {
          hint = `已尝试 ${triedCreds.size} 把凭证均失败。` + (hint ? " " + hint : "");
        }
        writeEvent(res, {
          assistantResponseEvent: {
            content: `❌ 上游返回 ${upstream.statusCode}：\n\n${errText.slice(0, 800)}${hint ? `\n\n💡 ${hint}` : ""}`,
            modelId,
          },
        });
        writeEvent(res, stopReasonEvent("END_TURN"));
        res.write(encodeException("InternalServerException", { message: `Upstream ${upstream.statusCode}` }));
        res.end();
        return;
      }

      // 3) 2xx：正常流式回传。一旦开始流就不再重试、不再换 key（避免重复内容）。
      markSuccess(provider, meta.credential);
      this.beginEventStream(res);
      if (wire === "kiro") {
        await this.pumpKiroPassthrough(res, upstream.body, convId, modelId, notice, meta, upstream.statusCode);
      } else {
        await this.pumpStream(res, wire, upstream.body, convId, modelId, notice, meta, upstream.statusCode);
      }
      return;
    }
  }

  /**
   * Read the upstream SSE stream, convert each event, and write to Kiro.
   *
   * 两个协议共用这一套泵：转换器都实现 StreamConverter（processLine/flush/usage），
   * 按行喂进去、把返回的 CwEvent 写出去。协议差异全部收在转换器里。
   */
  private pumpStream(
    res: http.ServerResponse,
    wire: WireFormat,
    body: http.IncomingMessage,
    convId: string,
    modelId: string,
    notice: string | undefined,
    meta: UsageMeta,
    statusCode: number
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const showUsage = getShowTokenUsage();
      const protocol: Protocol = protocolOfWire(wire);
      // 提示要紧跟在 messageMetadataEvent 之后、正文之前，这样用户第一眼就知道图片被忽略了。
      let pendingNotice = notice;
      const converter: StreamConverter =
        wire === "responses"
          ? new ResponsesStreamConverter(convId, modelId)
          : wire === "openai"
          ? new OpenaiStreamConverter(convId, modelId, {
              echoReasoning: shouldEchoReasoning(modelId),
              thoughtDedupe: getOpenaiThoughtDedupe(),
            })
          : wire === "gemini"
          ? new GeminiStreamConverter(convId, modelId)
          : new AnthropicStreamConverter(convId, modelId, { trace: isDebug() });
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let clientClosed = false;
      let finished = false;
      /** 第一个正文/思考字节到达的时刻（记账里的首 token 延迟）。 */
      let firstTokenAt: number | undefined;
      let streamError: string | undefined;
      // debug 开着时把上游原始 SSE 行攒下来（截断到 64KB），流末连同"思考 / 正文各多少字"一起打进日志。
      // 排查"思考里是正文"、"回复重复"一类问题时，这是唯一能看清上游到底发了什么的地方。
      const rawCapture: string[] | undefined = isDebug() ? [] : undefined;
      let rawCaptured = 0;
      let reasoningChars = 0;
      let contentChars = 0;

      const done = () => {
        if (finished) {
          return;
        }
        finished = true;
        res.removeListener("close", onClientClose);
        try {
          if (!clientClosed && !res.writableEnded) {
            for (const ev of converter.flush()) {
              writeEvent(res, ev);
            }
            // 记一笔账。工具循环里每次迭代都是独立请求，必须攒到轮末再上报：
            // Kiro 只认第一条 metering 的 unitPlural，逐次上报会让页脚的分解与
            // 总量对不上（详见 turnLedger.ts）。
            addRequestUsage(convId, converter.meteringUsage());
            if (!converter.sawToolUse) {
              const turnTotal = takeTurnTotals(convId);
              debug("turn total", turnTotal);
              if (showUsage) {
                for (const ev of buildMeteringEvents(turnTotal)) {
                  writeEvent(res, ev);
                }
              }
            }
            res.end();
          }
        } catch {
          /* ignore */
        }
        debug("upstream usage", converter.usage);
        debug(`stream split: reasoning=${reasoningChars} chars, content=${contentChars} chars, toolUse=${converter.sawToolUse}`);
        // Anthropic 流的事件轨迹（debug 时）：排查"思考被当正文 / 回复重复"一类中转站翻译问题时看这一行
        const trace = (converter as { trace?: string[] }).trace;
        if (trace && trace.length) {
          debug("upstream sse trace", trace.join(" "));
        }
        if (rawCapture && rawCapture.length) {
          debug(`upstream raw sse (${rawCapture.length} lines${rawCaptured >= 65536 ? ", truncated" : ""}):\n` + rawCapture.join("\n"));
        }
        const anomalies = (converter as { anomalies?: Set<string> }).anomalies;
        if (anomalies && anomalies.size) {
          const a = [...anomalies];
          if (a.includes("duplicate_thought_dropped")) {
            info(
              `✂️ [${meta.provider.name}] ${meta.upstreamModel}：模型把回答先写进了思考通道、正文又复述了一遍，已隐藏这段思考、只保留正文` +
                `（api2kiroDual.openaiThoughtDedupe=${getOpenaiThoughtDedupe()}）。`
            );
          }
          if (a.includes("thought_promoted_to_content")) {
            info(
              `✂️ [${meta.provider.name}] ${meta.upstreamModel}：上游只在思考通道里给了一份回答、正文为空，已把它作为正文发给 Kiro（否则是一个空回复）。`
            );
          }
          if (a.includes("answer_in_reasoning")) {
            const remedy = isForcedThinkingModel(meta.upstreamModel)
              ? `该模型是强制思考模型（GLM-5.3 系），思考关不掉；在 Kiro 的档位选择器里把 ${meta.kiroModel} 切到 low 可明显压短思考。` +
                `闲聊式问题上它习惯先在思考里把回答写一遍再正式回答，这是模型行为，写代码、跑工具时不会这样。`
              : `处理：到「提供商」页该 provider 的编辑弹窗，把 ${meta.kiroModel} 的「推理」标签设为「不支持」，代理会在请求里带 enable_thinking:false 关掉思考；或换用该模型的非思考变体。`;
            info(
              `⚠️ [${meta.provider.name}] ${meta.upstreamModel}：思考通道（reasoning_content）里是一份完整回答，随后 content 里又答了一遍——` +
                `Kiro 里表现为「Thought complete」折叠里是完整回答、下面再来一份。这段思考的开头像推敲、正文也不是它的复读，` +
                `所以去重闸门（openaiThoughtDedupe）放行了，发出去的思考撤不回。` +
                remedy
            );
          }
          const typeMismatch = a.filter(
            (x) => x !== "answer_in_reasoning" && x !== "duplicate_thought_dropped" && x !== "thought_promoted_to_content"
          );
          if (typeMismatch.length) {
            info(`⚠️ [${meta.provider.name}] ${meta.upstreamModel}：上游 SSE 的 delta 类型与所在 content_block 不一致（${typeMismatch.join(", ")}），已按块类型纠正——思考不会再漏进正文。这是中转站翻译层的问题。`);
          }
        }

        // 用量页记账：每个上游 HTTP 请求一行。客户端中途取消也记（token 是上游已经
        // 算了钱的），只是标成非 ok；流内报错同理。
        // 口径与 Kiro 直通一致（usageStore.ts）：inputTokens 只算未命中缓存，缓存读/写单列——
        // 不能拿 meteringUsage()：它为避免页脚双计把 OpenAI / Responses / Gemini 的缓存清零了。
        const u = converter.ledgerUsage();
        const now = Date.now();
        const cb = meta.rawContextBreakdown ? allocateContextTokens(meta.rawContextBreakdown, u.inputTokens) : undefined;
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheCreationTokens,
          contextBreakdown: cb,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });
        resolve();
      };

      const onClientClose = () => {
        clientClosed = true;
        try {
          body.destroy();
        } catch {
          /* ignore */
        }
        done();
      };
      res.on("close", onClientClose);

      const processBuffer = () => {
        // SSE events are separated by blank lines; process complete lines.
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (!line) {
            continue;
          }
          if (rawCapture && rawCaptured < 65536) {
            rawCapture.push(line.length > 400 ? line.slice(0, 400) + `…(+${line.length - 400})` : line);
            rawCaptured += line.length;
          }
          const events = converter.processLine(line);
          for (const ev of events) {
            if (clientClosed) {
              return;
            }
            if (firstTokenAt === undefined && (ev.assistantResponseEvent || ev.reasoningContentEvent || ev.toolUseEvent)) {
              firstTokenAt = Date.now();
            }
            if (ev.assistantResponseEvent) {
              contentChars += ev.assistantResponseEvent.content.length;
            } else if (ev.reasoningContentEvent?.text) {
              reasoningChars += ev.reasoningContentEvent.text.length;
            }
            writeEvent(res, ev);
            if (pendingNotice && ev.messageMetadataEvent) {
              writeEvent(res, { assistantResponseEvent: { content: pendingNotice, modelId } });
              pendingNotice = undefined;
            }
          }
        }
      };

      body.on("data", (chunk: Buffer) => {
        if (clientClosed) {
          return;
        }
        buffer += decoder.write(chunk);
        try {
          processBuffer();
        } catch (e) {
          error("stream process error:", (e as Error).message);
        }
      });

      body.on("end", () => {
        buffer += decoder.end();
        try {
          processBuffer();
        } catch {
          /* ignore */
        }
        done();
      });

      body.on("error", (e) => {
        error("upstream stream error:", (e as Error).message);
        streamError = "流中断: " + (e as Error).message;
        done();
      });
    });
  }

  /**
   * Kiro 官方直通的泵：上游本来就是 Kiro 要的 event-stream，字节原样写给 Kiro（不解码再编码，
   * 签名 / 计费 / 上下文用量事件一个不丢）。旁路解一遍帧只为记账：metadataEvent.tokenUsage 的输入 /
   * 输出 token、第一个正文帧的时刻、exception 帧的错误文本。剥图提示同样紧跟 messageMetadataEvent 之后。
   */
  private pumpKiroPassthrough(
    res: http.ServerResponse,
    body: http.IncomingMessage,
    convId: string,
    modelId: string,
    notice: string | undefined,
    meta: UsageMeta,
    statusCode: number
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const decoder = new EventStreamDecoder();
      let pendingNotice = notice;
      let clientClosed = false;
      let finished = false;
      let firstTokenAt: number | undefined;
      let streamError: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let frames = 0;

      const done = () => {
        if (finished) {
          return;
        }
        finished = true;
        res.removeListener("close", onClientClose);
        try {
          if (!clientClosed && !res.writableEnded) {
            res.end();
          }
        } catch {
          /* ignore */
        }
        debug(`kiro passthrough: ${frames} frames, in=${inputTokens} out=${outputTokens} cacheRead=${cacheRead}`);
        const now = Date.now();
        const cb = meta.rawContextBreakdown ? allocateContextTokens(meta.rawContextBreakdown, inputTokens) : undefined;
        recordUsage({
          ts: now,
          providerId: meta.provider.id,
          providerName: meta.provider.name,
          credentialId: hasPool(meta.provider) ? meta.credential.id : undefined,
          model: meta.kiroModel,
          upstreamModel: meta.upstreamModel !== meta.kiroModel ? meta.upstreamModel : undefined,
          protocol: "kiro",
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          contextBreakdown: cb,
          latencyMs: now - meta.startedAt,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - meta.startedAt : undefined,
          status: statusCode,
          ok: !streamError && !clientClosed,
          error: streamError || (clientClosed ? "客户端取消" : undefined),
          conversationId: meta.convId,
        });
        resolve();
      };

      const onClientClose = () => {
        clientClosed = true;
        try {
          body.destroy();
        } catch {
          /* ignore */
        }
        done();
      };
      res.on("close", onClientClose);

      const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
      const inspect = (chunk: Buffer) => {
        for (const ev of decoder.feed(chunk)) {
          frames++;
          if (ev.messageType === "exception" || ev.messageType === "error") {
            const p = (ev.payload || {}) as Record<string, unknown>;
            streamError = `${ev.type || "exception"}: ${typeof p.message === "string" ? p.message : JSON.stringify(p).slice(0, 200)}`;
            error(`[${meta.provider.name}] kiro passthrough exception:`, streamError);
            continue;
          }
          if (firstTokenAt === undefined && (ev.type === "assistantResponseEvent" || ev.type === "reasoningContentEvent" || ev.type === "toolUseEvent")) {
            firstTokenAt = Date.now();
          }
          if (ev.type === "metadataEvent") {
            // 用量页的口径与 Anthropic 一致：inputTokens 只算未命中缓存的部分，缓存读/写单独记（三者相加才是输入总量）
            const tu = ((ev.payload as Record<string, unknown>)?.tokenUsage || {}) as Record<string, unknown>;
            inputTokens = num(tu.uncachedInputTokens) || inputTokens;
            cacheRead = num(tu.cacheReadInputTokens) || cacheRead;
            cacheWrite = num(tu.cacheWriteInputTokens) || cacheWrite;
            outputTokens = num(tu.outputTokens) || outputTokens;
          }
        }
      };

      body.on("data", (chunk: Buffer) => {
        if (clientClosed) {
          return;
        }
        // 剥图提示（官方 Claude 系都支持图片，这里几乎走不到）：作为第一段正文插在上游帧之前，
        // 不另发 messageMetadataEvent——上游第一帧就是它，发两个 Kiro 会当成两条消息
        if (pendingNotice) {
          writeEvent(res, { assistantResponseEvent: { content: pendingNotice, modelId } });
          pendingNotice = undefined;
        }
        res.write(chunk);
        try {
          inspect(chunk);
        } catch (e) {
          debug("kiro passthrough decode error:", (e as Error).message);
        }
      });
      body.on("end", done);
      body.on("error", (e) => {
        error("upstream stream error:", (e as Error).message);
        streamError = "流中断: " + (e as Error).message;
        done();
      });
    });
  }
}
