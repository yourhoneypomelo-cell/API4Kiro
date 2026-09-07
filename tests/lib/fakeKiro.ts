/**
 * 假 Kiro 官方上游（一个 http 服务器、按路径前缀分角色）：
 *   /social/refreshToken    代际轮换：rt-gen1 → (acc-…-2, rt-gen2)，旧代作废 → 400 invalid_grant
 *   /social/oauth/token     门户换 token（校验 PKCE：sha256(code_verifier) == 记下的 code_challenge）
 *   /q/ListAvailableModels  分页（nextToken），API Key 需 `tokentype: API_KEY` 否则 403
 *   /q/getUsageLimits       按 access token 前缀给邮箱；未知 token 401
 *   /q/ListAvailableProfiles
 *   /oidc/client/register   /oidc/token（authorization_code + refresh_token，camelCase JSON）
 *   /rt|/q /generateAssistantResponse  二进制 eventstream：记下整套请求头与 body；401 / 402 / exception 帧按 token 触发
 * 全部为本机假数据，不含任何真实凭证。
 */
import * as crypto from "crypto";
import * as http from "http";
import { encodeEvent, encodeException } from "../../src/eventstream";
import { FakeServer, jsonBody, sendJson, startServer } from "./harness";

export const FIXED_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

export interface RtRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  raw: string;
}

export interface FakeKiro extends FakeServer {
  /** refreshToken → 下一代 */
  chain: Map<string, { accessToken: string; refreshToken: string; profileArn?: string }>;
  refreshCalls: Array<{ refreshToken: string; ua: string; kind: "social" | "oidc" }>;
  /** access token（前缀匹配）→ 邮箱 */
  emails: Map<string, string>;
  /** /rt 与 /q 接受的 OAuth access token */
  validTokens: Set<string>;
  /** 官方 API Key（ksk_…） */
  apiKeys: Set<string>;
  /** 返回 402 的 token */
  quotaTokens: Set<string>;
  /** 200 但流里是 exception 帧的 token */
  exceptionTokens: Set<string>;
  rtRequests: RtRequest[];
  qRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  usageCalls: number;
  /** 最近一次成功流写出的全部字节（断言直通逐字节一致） */
  lastStreamBytes: Buffer;
  /** 门户换 token 时期望的 PKCE challenge / code（由测试从 signin URL 里读出后写进来） */
  pkce: { challenge?: string; code?: string; lastTokenBody?: Record<string, unknown> };
  oidc: { registered: number; tokenBodies: Array<Record<string, unknown>> };
  /** 流帧间是否切成两半发送（测解帧重组） */
  splitFrames: boolean;
  /** splitFrames 时后半段延迟多少 ms（测客户端中途取消） */
  holdTailMs: number;
  /** 上游端观察到的被中断的流数量（客户端取消时 res 'close' 早于 finish） */
  abortedStreams: number;
  /** 生成一条标准成功流（供断言字节相等） */
  streamFor(convId: string): Buffer[];
}

export function base64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startFakeKiro(): Promise<FakeKiro> {
  const state = {
    chain: new Map<string, { accessToken: string; refreshToken: string; profileArn?: string }>(),
    refreshCalls: [] as Array<{ refreshToken: string; ua: string; kind: "social" | "oidc" }>,
    emails: new Map<string, string>(),
    validTokens: new Set<string>(),
    apiKeys: new Set<string>(),
    quotaTokens: new Set<string>(),
    exceptionTokens: new Set<string>(),
    rtRequests: [] as RtRequest[],
    qRequests: [] as Array<{ url: string; headers: http.IncomingHttpHeaders }>,
    usageCalls: 0,
    lastStreamBytes: Buffer.alloc(0),
    pkce: {} as { challenge?: string; code?: string; lastTokenBody?: Record<string, unknown> },
    oidc: { registered: 0, tokenBodies: [] as Array<Record<string, unknown>> },
    splitFrames: false,
    holdTailMs: 30,
    abortedStreams: 0,
  };

  const bearerOf = (req: http.IncomingMessage): string => {
    const a = String(req.headers.authorization || "");
    return a.replace(/^Bearer\s+/i, "");
  };
  const emailFor = (token: string): string | undefined => {
    for (const [prefix, email] of state.emails) {
      if (token.startsWith(prefix)) {
        return email;
      }
    }
    return undefined;
  };
  const streamFor = (convId: string): Buffer[] => [
    encodeEvent("messageMetadataEvent", { conversationId: convId }),
    encodeEvent("assistantResponseEvent", { content: "Hel" }),
    encodeEvent("assistantResponseEvent", { content: "lo from fake Kiro" }),
    encodeEvent("metadataEvent", {
      tokenUsage: { uncachedInputTokens: 120, cacheReadInputTokens: 30, cacheWriteInputTokens: 5, outputTokens: 7, totalTokens: 162 },
      stopReason: "END_TURN",
    }),
  ];

  const srv = await startServer(async (req, res, body) => {
    const url = req.url || "/";
    const path = url.split("?")[0];
    const json = jsonBody(body);

    // ---- 登录服务（social） ----
    if (path === "/social/refreshToken") {
      const rt = String(json.refreshToken || "");
      state.refreshCalls.push({ refreshToken: rt, ua: String(req.headers["user-agent"] || ""), kind: "social" });
      const next = state.chain.get(rt);
      if (!next) {
        sendJson(res, 400, { error: "invalid_grant", message: "refresh token expired or revoked" });
        return;
      }
      state.chain.delete(rt);
      state.validTokens.add(next.accessToken);
      sendJson(res, 200, { accessToken: next.accessToken, refreshToken: next.refreshToken, profileArn: next.profileArn || FIXED_ARN, expiresIn: 3600 });
      return;
    }
    if (path === "/social/oauth/token") {
      state.pkce.lastTokenBody = json;
      const verifier = String(json.code_verifier || "");
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      if (!state.pkce.challenge || challenge !== state.pkce.challenge || String(json.code) !== state.pkce.code) {
        sendJson(res, 400, { message: "invalid code or PKCE verifier" });
        return;
      }
      state.validTokens.add("acc-portal-1");
      state.chain.set("rt-portal-1", { accessToken: "acc-portal-2", refreshToken: "rt-portal-2" });
      sendJson(res, 200, { accessToken: "acc-portal-1", refreshToken: "rt-portal-1", profileArn: FIXED_ARN, expiresIn: 3600 });
      return;
    }

    // ---- IdC ----
    if (path === "/oidc/client/register") {
      state.oidc.registered++;
      sendJson(res, 200, { clientId: "cid-fake", clientSecret: "csec-fake", clientIdIssuedAt: 1, clientSecretExpiresAt: 9999999999 });
      return;
    }
    if (path === "/oidc/token") {
      state.oidc.tokenBodies.push(json);
      if (json.grantType === "refresh_token") {
        const rt = String(json.refreshToken || "");
        state.refreshCalls.push({ refreshToken: rt, ua: String(req.headers["user-agent"] || ""), kind: "oidc" });
        const next = state.chain.get(rt);
        if (!next || json.clientId !== "cid-fake" || json.clientSecret !== "csec-fake") {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        state.chain.delete(rt);
        state.validTokens.add(next.accessToken);
        sendJson(res, 200, { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresIn: 28800 });
        return;
      }
      state.validTokens.add("acc-idc-1");
      sendJson(res, 200, { accessToken: "acc-idc-1", refreshToken: "rt-idc-1", expiresIn: 28800 });
      return;
    }

    // ---- q.* 控制面 ----
    if (path === "/q/ListAvailableModels") {
      state.qRequests.push({ url, headers: req.headers });
      const tok = bearerOf(req);
      if (state.apiKeys.has(tok)) {
        if (String(req.headers.tokentype || "").toUpperCase() !== "API_KEY") {
          sendJson(res, 403, { message: "API key presented as OAuth token" });
          return;
        }
      } else if (!state.validTokens.has(tok)) {
        sendJson(res, 401, { message: "invalid token" });
        return;
      }
      const q = new URL(url, "http://x").searchParams;
      const schema = { type: "object", properties: { output_config: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "max"], default: "high" } } } } };
      if (q.get("nextToken") === "page2") {
        sendJson(res, 200, {
          models: [{ modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5", supportedInputTypes: ["TEXT"], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 32000 } }],
        });
        return;
      }
      sendJson(res, 200, {
        models: [
          { modelId: "auto", modelName: "Auto", supportedInputTypes: ["TEXT", "IMAGE"], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } },
          { modelId: "claude-sonnet-5", modelName: "Claude Sonnet 5", description: "", supportedInputTypes: ["TEXT", "IMAGE"], tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 }, additionalModelRequestFieldsSchema: schema },
        ],
        nextToken: "page2",
      });
      return;
    }
    if (path === "/q/getUsageLimits") {
      state.usageCalls++;
      const tok = bearerOf(req);
      const email = state.apiKeys.has(tok) ? undefined : emailFor(tok);
      if (!email && !state.apiKeys.has(tok)) {
        sendJson(res, 401, { message: "invalid token" });
        return;
      }
      sendJson(res, 200, { userInfo: { email }, subscriptionInfo: { subscriptionTitle: "Kiro Pro" } });
      return;
    }
    if (path === "/q/ListAvailableProfiles") {
      sendJson(res, 200, { profiles: [{ arn: "arn:aws:codewhisperer:eu-central-1:111111111111:profile/ENTERPRISE1", profileName: "ent" }] });
      return;
    }

    // ---- 流式端点（OAuth 走 /rt，API Key 走 /q） ----
    if (path === "/rt/generateAssistantResponse" || path === "/q/generateAssistantResponse") {
      state.rtRequests.push({ url, headers: req.headers, body: json, raw: body.toString("utf8") });
      const tok = bearerOf(req);
      if (state.apiKeys.has(tok)) {
        if (String(req.headers.tokentype || "").toUpperCase() !== "API_KEY") {
          sendJson(res, 403, { message: "API key presented as OAuth token" });
          return;
        }
      } else if (state.quotaTokens.has(tok)) {
        sendJson(res, 402, { message: "MONTHLY_REQUEST_COUNT limit reached", reason: "MONTHLY_REQUEST_COUNT" });
        return;
      } else if (!state.validTokens.has(tok)) {
        sendJson(res, 401, { message: "The security token included in the request is invalid" });
        return;
      }
      const convId = String((json.conversationState as Record<string, unknown> | undefined)?.conversationId || "conv");
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
      let frames: Buffer[];
      if (state.exceptionTokens.has(tok)) {
        frames = [encodeEvent("messageMetadataEvent", { conversationId: convId }), encodeException("ThrottlingException", { message: "Too many requests, please wait." })];
      } else {
        frames = streamFor(convId);
      }
      const all = Buffer.concat(frames);
      state.lastStreamBytes = all;
      if (state.splitFrames) {
        // 故意在第二帧中间切开，两段之间隔一拍
        const cut = frames[0].length + Math.floor(frames[1].length / 2);
        let aborted = false;
        res.on("close", () => {
          if (!res.writableFinished) {
            aborted = true;
            state.abortedStreams++;
          }
        });
        res.write(all.subarray(0, cut));
        await new Promise((r) => setTimeout(r, state.holdTailMs));
        if (!aborted) {
          res.end(all.subarray(cut));
        }
      } else {
        res.end(all);
      }
      return;
    }

    sendJson(res, 404, { message: "no such route: " + path });
  });

  // 处理函数读写的是 state 本体：把服务器句柄合并到 state 上再返回，测试改 fake.xxx 与处理函数看到的是同一份。
  return Object.assign(state, srv, { streamFor });
}
