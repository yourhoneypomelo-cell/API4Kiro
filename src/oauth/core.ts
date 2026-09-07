/**
 * OAuth 通用件：PKCE、state、表单/JSON POST、JWT 载荷解析、本机回调服务器、设备码轮询。
 *
 * 两种登录流程（对齐 CLIProxyAPI 的 internal/auth/*）：
 *  - 授权码 + PKCE（Codex）：本机起一个 HTTP 服务器收浏览器回跳的 code，再用 code_verifier
 *    去 token 端点换 token。回调端口/路径由厂商注册的 redirect_uri 决定，不能改。
 *  - 设备码（Kimi / xAI，RFC 8628）：向设备授权端点要 user_code + verification_uri，用户在
 *    浏览器里确认，我们按 interval 轮询 token 端点直到拿到 token / 被拒 / 过期。
 *
 * 这里不认识任何具体厂商，全部由 vendors.ts 组装。
 */

import * as crypto from "crypto";
import * as http from "http";
import { URL } from "url";
import { requestUpstream, readBody } from "../upstream";
import { debug } from "../log";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636：43–128 字符的 verifier，S256 挑战。 */
export function generatePkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

export class OAuthHttpError extends Error {
  constructor(public status: number, public body: string, label: string) {
    super(`${label}：HTTP ${status}${body ? " " + body.slice(0, 200) : ""}`);
  }
}

/** 取消信号：登录弹窗关闭 / 用户点取消时置位，轮询与等待回调都看它。 */
export class CancelSignal {
  private flag = false;
  private waiters = new Set<() => void>();
  get cancelled(): boolean {
    return this.flag;
  }
  cancel(): void {
    if (this.flag) {
      return;
    }
    this.flag = true;
    for (const w of this.waiters) {
      w();
    }
    this.waiters.clear();
  }
  /** 被取消时 resolve。 */
  wait(): Promise<void> {
    if (this.flag) {
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.add(r));
  }
}

export class LoginCancelled extends Error {
  constructor() {
    super("登录已取消");
  }
}

/** 可取消的 sleep。 */
export function sleep(ms: number, signal?: CancelSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.wait().then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

const FORM_TIMEOUT_MS = 30_000;

/** POST application/x-www-form-urlencoded，解析 JSON 回复（非 2xx 也尝试解析，OAuth 错误体是 JSON）。 */
export async function postForm(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const body = new URLSearchParams(params).toString();
  const res = await requestUpstream(
    "POST",
    url,
    { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
    body,
    FORM_TIMEOUT_MS
  );
  const text = await readBody(res.body);
  return { status: res.statusCode, json: safeJson(text), text };
}

export async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await requestUpstream(
    "POST",
    url,
    { "Content-Type": "application/json", Accept: "application/json", ...headers },
    JSON.stringify(payload),
    FORM_TIMEOUT_MS
  );
  const text = await readBody(res.body);
  return { status: res.statusCode, json: safeJson(text), text };
}

export async function getJsonAuth(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await requestUpstream("GET", url, { Accept: "application/json", ...headers }, undefined, FORM_TIMEOUT_MS);
  const text = await readBody(res.body);
  return { status: res.statusCode, json: safeJson(text), text };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 只解 JWT 载荷，不验签（拿 email / account id 做展示，鉴权由服务端做）。 */
export function parseJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) {
    return {};
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** expires_in（秒）→ 绝对时刻；缺省/非法 → undefined。 */
export function expiresAtFrom(expiresIn: unknown): number | undefined {
  const n = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  return typeof n === "number" && isFinite(n) && n > 0 ? Date.now() + n * 1000 : undefined;
}

// ---------------------------------------------------------------------------------------
// 本机回调服务器（授权码流程）
// ---------------------------------------------------------------------------------------

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>API4Kiro · 登录成功</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141419;color:#e8e6f0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:420px;padding:32px 36px;border-radius:14px;background:#1c1b24;border:1px solid rgba(166,108,255,.45);box-shadow:0 0 28px rgba(166,108,255,.25);text-align:center}
h1{font-size:20px;margin:0 0 10px;color:#b98aff}p{margin:0;color:#b7b3c6}</style></head>
<body><div class="card"><h1>登录成功</h1><p>授权已交给 API4Kiro，可以关闭此页面回到 Kiro 继续。</p></div></body></html>`;

const FAIL_HTML = (msg: string) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>API4Kiro · 登录失败</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141419;color:#e8e6f0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:420px;padding:32px 36px;border-radius:14px;background:#1c1b24;border:1px solid rgba(255,107,107,.5);text-align:center}
h1{font-size:20px;margin:0 0 10px;color:#ff8080}p{margin:0;color:#b7b3c6;word-break:break-all}</style></head>
<body><div class="card"><h1>登录失败</h1><p>${msg}</p></div></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function listenOn(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => {
      server.removeListener("listening", onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(port, host);
  });
}

/**
 * 在本机 `port` 上起回调服务器，等一次 `path` 的回跳（GET ?code=&state=），校验 state 后
 * 给出 code。同时绑 127.0.0.1 与 ::1（浏览器解析 localhost 可能走任一族）；IPv6 绑不上就只用 IPv4。
 *
 * 返回时服务器**已在监听**（端口占用等错误在这里就抛，调用方还没打开浏览器）；
 * `result` 在收到回跳 / 超时 / 取消 / 授权被拒时结束，服务器随之一定被关掉。
 */
export async function openCallbackServer(
  port: number,
  path: string,
  expectedState: string,
  timeoutMs: number,
  signal?: CancelSignal
): Promise<{ result: Promise<CallbackResult> }> {
  let settle: ((r: CallbackResult) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url || "/", `http://localhost:${port}`);
    if (u.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code") || "";
    const state = u.searchParams.get("state") || "";
    const send = (status: number, html: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    };
    if (err) {
      const desc = u.searchParams.get("error_description") || "";
      send(400, FAIL_HTML(escapeHtml(err + (desc ? "：" + desc : ""))));
      fail?.(new Error(`授权被拒绝：${err}${desc ? "（" + desc + "）" : ""}`));
      return;
    }
    if (!code) {
      send(400, FAIL_HTML("回调里没有授权码"));
      fail?.(new Error("回调里没有授权码"));
      return;
    }
    // Anthropic 风格：code 里可能拼着 "#state"
    const [pureCode, fragState] = code.split("#");
    const gotState = state || fragState || "";
    if (gotState !== expectedState) {
      send(400, FAIL_HTML("state 不匹配，可能是过期的登录页；请回到 Kiro 重新发起登录"));
      fail?.(new Error("state 不匹配（可能点开了旧的登录页）"));
      return;
    }
    send(200, SUCCESS_HTML);
    settle?.({ code: pureCode, state: gotState });
  };

  const servers: http.Server[] = [];
  const v4 = http.createServer(handler);
  try {
    await listenOn(v4, port, "127.0.0.1");
    servers.push(v4);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EADDRINUSE"
        ? `本机端口 ${port} 被占用（可能是官方 CLI 正在登录，或上一次登录没关掉），请稍后重试`
        : `无法监听本机端口 ${port}：${(e as Error).message}`
    );
  }
  const v6 = http.createServer(handler);
  try {
    await listenOn(v6, port, "::1");
    servers.push(v6);
  } catch {
    /* 没有 IPv6 回环也没关系 */
  }
  debug("oauth callback server listening", { port, path });

  const timer = setTimeout(() => fail?.(new Error("等待浏览器授权超时（5 分钟）")), timeoutMs);
  void signal?.wait().then(() => fail?.(new LoginCancelled()));
  const closeAll = () => {
    clearTimeout(timer);
    for (const s of servers) {
      try {
        s.close();
        // 回调来的那条连接可能还在 keep-alive，强关免得服务器迟迟不退出。
        (s as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        /* ignore */
      }
    }
  };
  const guarded = result.then(
    (r) => {
      // 让浏览器把成功页收完再关（同步 close 会截断 keep-alive 上的响应）。
      setTimeout(closeAll, 300);
      return r;
    },
    (e) => {
      setTimeout(closeAll, 300);
      throw e;
    }
  );
  // 调用方可能在打开浏览器之后才 await；期间若已失败，不能变成 unhandled rejection 把宿主打崩。
  guarded.catch(() => undefined);
  return { result: guarded };
}

/** 通用回环回调：回跳的路径与全部 query 参数原样给出（Kiro 门户除 code 外还带 login_option / issuer_url …）。 */
export interface LoopbackCallback {
  path: string;
  params: Record<string, string>;
}

export interface LoopbackCallbackOpts {
  /**
   * 候选端口，按顺序尝试，全被占才失败（Kiro 门户只接受它固定的那几个 localhost 端口）；
   * 给 [0] 表示随机端口（IdC 的 OIDC 注册用的是 http://127.0.0.1/oauth/callback，端口任意）。
   */
  ports: number[];
  /** 接受的回调路径（Kiro 门户用 /oauth/callback 与 /signin/callback 两个）。 */
  paths: string[];
  expectedState: string;
  timeoutMs: number;
  signal?: CancelSignal;
  /** 回跳成功后给浏览器看什么：缺省是本插件的成功页；可按参数改成别的 HTML（IdC 还要在新页里继续），回 undefined 用缺省。 */
  successHtml?: (cb: LoopbackCallback) => string | undefined;
}

/** 与成功页同款式的提示页（登录还没完、浏览器会再开一页时用）。 */
export function noticePageHtml(title: string, msg: string): string {
  return SUCCESS_HTML.replace("<h1>登录成功</h1>", `<h1>${escapeHtml(title)}</h1>`).replace(
    "<p>授权已交给 API4Kiro，可以关闭此页面回到 Kiro 继续。</p>",
    `<p>${escapeHtml(msg)}</p>`
  );
}

/**
 * openCallbackServer 的通用版：多端口候选 + 多路径 + 全参数。返回时**已在监听**（`port` 是实际拿到的端口）；
 * `result` 在收到回跳 / 超时 / 取消 / 授权被拒时结束，服务器随之关闭。
 */
export async function openLoopbackCallback(opts: LoopbackCallbackOpts): Promise<{ port: number; result: Promise<LoopbackCallback> }> {
  let settle: ((r: LoopbackCallback) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const result = new Promise<LoopbackCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url || "/", "http://localhost");
    const send = (status: number, html: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    };
    if (!opts.paths.includes(u.pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      params[k] = v;
    });
    if (params.error) {
      const desc = params.error_description || "";
      send(400, FAIL_HTML(escapeHtml(params.error + (desc ? "：" + desc : ""))));
      fail?.(new Error(`授权被拒绝：${params.error}${desc ? "（" + desc + "）" : ""}`));
      return;
    }
    if ((params.state || "") !== opts.expectedState) {
      send(400, FAIL_HTML("state 不匹配，可能是过期的登录页；请回到 Kiro 重新发起登录"));
      fail?.(new Error("state 不匹配（可能点开了旧的登录页）"));
      return;
    }
    const cb: LoopbackCallback = { path: u.pathname, params };
    send(200, (opts.successHtml && opts.successHtml(cb)) || SUCCESS_HTML);
    settle?.(cb);
  };

  const servers: http.Server[] = [];
  let port = 0;
  let lastErr: NodeJS.ErrnoException | undefined;
  for (const candidate of opts.ports) {
    const v4 = http.createServer(handler);
    try {
      await listenOn(v4, candidate, "127.0.0.1");
      servers.push(v4);
      const addr = v4.address();
      port = typeof addr === "object" && addr ? addr.port : candidate;
      break;
    } catch (e) {
      lastErr = e as NodeJS.ErrnoException;
    }
  }
  if (!servers.length) {
    throw new Error(
      lastErr?.code === "EADDRINUSE"
        ? `本机回调端口（${opts.ports.join("/")}）都被占用了，请稍后重试`
        : `无法监听本机回调端口：${lastErr?.message || "未知错误"}`
    );
  }
  // 浏览器解析 localhost 可能走 IPv6，同一端口也在 ::1 上听一份（绑不上就算了）
  const v6 = http.createServer(handler);
  try {
    await listenOn(v6, port, "::1");
    servers.push(v6);
  } catch {
    /* 没有 IPv6 回环也没关系 */
  }
  debug("oauth loopback callback listening", { port, paths: opts.paths });

  const timer = setTimeout(() => fail?.(new Error(`等待浏览器授权超时（${Math.round(opts.timeoutMs / 60_000)} 分钟）`)), opts.timeoutMs);
  void opts.signal?.wait().then(() => fail?.(new LoginCancelled()));
  const closeAll = () => {
    clearTimeout(timer);
    for (const s of servers) {
      try {
        s.close();
        (s as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        /* ignore */
      }
    }
  };
  const guarded = result.then(
    (r) => {
      setTimeout(closeAll, 300);
      return r;
    },
    (e) => {
      setTimeout(closeAll, 300);
      throw e;
    }
  );
  guarded.catch(() => undefined);
  return { port, result: guarded };
}

// ---------------------------------------------------------------------------------------
// 设备码轮询
// ---------------------------------------------------------------------------------------

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** 秒。 */
  expiresIn?: number;
  /** 秒。 */
  interval?: number;
}

export function parseDeviceCode(json: Record<string, unknown>): DeviceCode {
  const str = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : "");
  const num = (k: string) => (typeof json[k] === "number" ? (json[k] as number) : Number(json[k]) || undefined);
  const dc: DeviceCode = {
    deviceCode: str("device_code"),
    userCode: str("user_code"),
    verificationUri: str("verification_uri") || str("verification_url"),
    verificationUriComplete: str("verification_uri_complete") || undefined,
    expiresIn: num("expires_in"),
    interval: num("interval"),
  };
  if (!dc.deviceCode || !dc.userCode || !(dc.verificationUri || dc.verificationUriComplete)) {
    throw new Error("设备授权回复不完整（缺 device_code / user_code / verification_uri）");
  }
  return dc;
}

export interface DevicePollOptions {
  /** 每次轮询发一次 token 请求，返回原始 JSON + 状态码。 */
  attempt: () => Promise<{ status: number; json: Record<string, unknown> }>;
  intervalSec?: number;
  expiresInSec?: number;
  /** 兜底上限（秒）。 */
  maxWaitSec: number;
  minIntervalSec?: number;
  signal?: CancelSignal;
}

/**
 * RFC 8628 轮询：authorization_pending / slow_down 继续（slow_down 加 5s），
 * expired_token / access_denied / 其它错误终止；拿到 access_token 即返回 JSON。
 */
export async function pollDeviceToken(o: DevicePollOptions): Promise<Record<string, unknown>> {
  const minInterval = (o.minIntervalSec ?? 5) * 1000;
  let interval = Math.max((o.intervalSec ?? 5) * 1000, minInterval);
  const deadline = Date.now() + Math.min(o.maxWaitSec, o.expiresInSec && o.expiresInSec > 0 ? o.expiresInSec : o.maxWaitSec) * 1000;
  for (;;) {
    await sleep(interval, o.signal);
    if (o.signal?.cancelled) {
      throw new LoginCancelled();
    }
    if (Date.now() > deadline) {
      throw new Error("设备码已过期，请重新发起登录");
    }
    const { status, json } = await o.attempt();
    const err = typeof json.error === "string" ? json.error : "";
    if (err) {
      if (err === "authorization_pending") {
        continue;
      }
      if (err === "slow_down") {
        // RFC 8628：每次 slow_down 把间隔加一个步长（缺省 5s；与轮询下限同源，测试时可调小）
        interval += minInterval;
        continue;
      }
      if (err === "expired_token") {
        throw new Error("设备码已过期，请重新发起登录");
      }
      if (err === "access_denied") {
        throw new Error("你在浏览器里拒绝了授权");
      }
      const desc = typeof json.error_description === "string" ? json.error_description : "";
      throw new Error(`授权失败：${err}${desc ? "（" + desc + "）" : ""}`);
    }
    if (status < 200 || status >= 300) {
      throw new Error(`token 端点返回 HTTP ${status}`);
    }
    if (typeof json.access_token === "string" && json.access_token) {
      return json;
    }
    throw new Error("token 回复里没有 access_token");
  }
}
