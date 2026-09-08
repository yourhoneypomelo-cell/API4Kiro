/**
 * OAuth 运行时：请求前拿一枚新鲜的 access token（快过期就刷新，并发只刷一次）；
 * 登录会话（起流程 / 取消 / 把进度推给 UI）。
 */

import { Credential, PRIMARY_CREDENTIAL_ID, ProviderConfig, checkOAuthHost, credentialsOf, tokenKeyOf } from "../providers";
import { debug, error, info } from "../log";
import { CancelSignal, DeviceCode, LoginCancelled } from "./core";
import { OAuthToken, getToken, setToken, tokenStoreLoadError } from "./tokenStore";
import { LoginContext, LoginMode, OAuthVendorId, VendorModel, VendorSpec, getVendor } from "./vendors";

/** 过期前这么久就刷新（对齐 CPA 的 5 分钟）。 */
const REFRESH_LEAD_MS = 5 * 60_000;

export class NeedsLoginError extends Error {
  constructor(public providerId: string, message: string) {
    super(message);
  }
}

/** 刷新失败（登录失效）的凭证（按 token 键）：记下错误给 UI 显示，直到重新登录成功。 */
const invalid = new Map<string, string>();
const inflight = new Map<string, Promise<OAuthToken>>();

export function vendorOf(p: Pick<ProviderConfig, "auth" | "oauthVendor">): VendorSpec | undefined {
  return p.auth === "oauth" ? getVendor(p.oauthVendor) : undefined;
}

export type OAuthLoginState = { state: "ok" | "expired" | "missing"; error?: string; token?: OAuthToken };

/** UI 用：该 provider 某把凭证（缺省首条）的登录状态。 */
export function oauthState(p: ProviderConfig, credentialId: string = PRIMARY_CREDENTIAL_ID): OAuthLoginState {
  const key = tokenKeyOf(p.id, credentialId);
  const tok = getToken(key);
  if (!tok) {
    // 钥匙串没读出来（不是真的没登录）：把原因带给 UI（编辑弹窗会显示 loginError）
    const le = tokenStoreLoadError();
    return le ? { state: "missing", error: le.message } : { state: "missing" };
  }
  const err = invalid.get(key);
  if (err) {
    return { state: "expired", error: err, token: tok };
  }
  return { state: "ok", token: tok };
}

function credOf(p: ProviderConfig, cred?: Credential): Credential {
  return cred || credentialsOf(p)[0];
}

function needsRefresh(tok: OAuthToken, force: boolean): boolean {
  if (force) {
    return true;
  }
  if (!tok.refreshToken) {
    return false;
  }
  return typeof tok.expiresAt === "number" && tok.expiresAt - Date.now() < REFRESH_LEAD_MS;
}

/**
 * 拿可用的 access token。快过期（或 force）就用 refresh token 换新并落盘；同一 provider
 * 并发只发一次刷新。没登录 / 刷新被拒 → NeedsLoginError。
 */
export async function ensureAccessToken(p: ProviderConfig, force = false, cred?: Credential): Promise<OAuthToken> {
  const spec = vendorOf(p);
  if (!spec) {
    throw new Error("provider 不是 OAuth 登录类型");
  }
  // 地址不是厂商规格宿主（且未 allowCustomHost）：连 token 都不交出去。调用方都是「拿到 token 就去请求 p.baseUrl」，
  // 这里拒绝等于那次请求根本不发生；原因不含凭据，可直接给用户看。
  const rejected = checkOAuthHost(p);
  if (rejected) {
    throw new Error(`「${p.name}」${rejected}`);
  }
  const c = credOf(p, cred);
  const key = tokenKeyOf(p.id, c.id);
  const who = c.id === PRIMARY_CREDENTIAL_ID ? p.name : `${p.name} · ${c.label || c.id}`;
  const tok = getToken(key);
  if (!tok) {
    const le = tokenStoreLoadError();
    throw new NeedsLoginError(p.id, le ? `「${who}」${le.message}` : `「${who}」尚未登录，请在 provider 设置里登录`);
  }
  if (!needsRefresh(tok, force)) {
    if (invalid.has(key) && !force) {
      // 上次刷新失败但 token 尚未到期（比如网络抖动）——继续用现有 token 试，成功了就清标记。
      invalid.delete(key);
    }
    return tok;
  }
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      debug("oauth refresh", { provider: p.id, credential: c.id, vendor: spec.id, force });
      try {
        const next = await spec.refresh(tok);
        if (!next.refreshToken) {
          next.refreshToken = tok.refreshToken;
        }
        if (!next.email && tok.email) {
          next.email = tok.email;
        }
        setToken(key, next);
        invalid.delete(key);
        info(`[${who}] 登录 token 已刷新`);
        return next;
      } catch (e) {
        const msg = (e as Error).message || String(e);
        // 明确的"登录失效"才标记；网络类错误保留现有 token 让请求自己去试。
        if (/失效|重新登录|invalid_grant|refresh_token_reused/i.test(msg) || force) {
          invalid.set(key, msg);
          error(`[${who}] 刷新登录失败：${msg}`);
          throw new NeedsLoginError(p.id, `「${who}」${msg}`);
        }
        error(`[${who}] 刷新登录出错（沿用现有 token）：${msg}`);
        return tok;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
  }
  return job;
}

/** 该 provider 账号能用的内置模型目录（按首条凭证的套餐裁剪；没登录/厂商不分套餐 → 全部）。 */
export function vendorModelsFor(p: Pick<ProviderConfig, "id" | "auth" | "oauthVendor">): VendorModel[] {
  const spec = vendorOf(p);
  if (!spec) {
    return [];
  }
  const tok = getToken(p.id);
  return tok && spec.modelsFor ? spec.modelsFor(tok) : spec.models;
}

/** 同步版：用缓存里的 token 直接造请求头（调用方应先 ensureAccessToken）。 */
export function oauthHeaders(p: ProviderConfig, stream: boolean, cred?: Credential): Record<string, string> {
  const spec = vendorOf(p);
  const tok = getToken(tokenKeyOf(p.id, credOf(p, cred).id));
  if (!spec || !tok) {
    return {};
  }
  return spec.headers(tok, stream);
}

/** 请求前一步到位：确保 token 新鲜 → 造头。 */
export async function prepareOAuthHeaders(p: ProviderConfig, stream: boolean, force = false, cred?: Credential): Promise<Record<string, string>> {
  const spec = vendorOf(p);
  if (!spec) {
    return {};
  }
  const tok = await ensureAccessToken(p, force, cred);
  return spec.headers(tok, stream);
}

/** 手动登录成功后清掉失效标记（按 token 键）。 */
export function markLoggedIn(tokenKey: string): void {
  invalid.delete(tokenKey);
}

// ---------------------------------------------------------------------------------------
// 登录会话
// ---------------------------------------------------------------------------------------

export interface LoginStatus {
  sessionId: string;
  vendor: OAuthVendorId;
  phase: "starting" | "device" | "browser" | "exchanging" | "done" | "error" | "cancelled";
  text?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  authUrl?: string;
  error?: string;
  account?: { email?: string; plan?: string; accountId?: string };
}

interface Session {
  id: string;
  vendor: OAuthVendorId;
  signal: CancelSignal;
}

const sessions = new Map<string, Session>();
let seq = 0;

export interface StartLoginOpts {
  vendor: OAuthVendorId;
  /** 厂商有多种登录方式时用户选的那种（Kiro 官方：oauth / import / access_token / json / api_key 等）。 */
  mode?: LoginMode;
  /** 手填凭证方式用户输入的表单字段。 */
  input?: Record<string, string>;
  openUrl(url: string): void;
  onStatus(s: LoginStatus): void;
  /** 拿到 token 后由调用方决定存到哪个 provider（新建 / 重新登录既有的）。 */
  onToken(tok: OAuthToken): Promise<void> | void;
}

/** 起一段登录。同一厂商同时只跑一段：再起会先取消上一段。返回 sessionId。 */
export function startLogin(opts: StartLoginOpts): string {
  const spec = getVendor(opts.vendor);
  if (!spec) {
    throw new Error("未知的登录厂商：" + opts.vendor);
  }
  for (const s of sessions.values()) {
    if (s.vendor === opts.vendor) {
      s.signal.cancel();
      sessions.delete(s.id);
    }
  }
  const id = `login${++seq}`;
  const session: Session = { id, vendor: spec.id, signal: new CancelSignal() };
  sessions.set(id, session);
  const post = (s: Omit<LoginStatus, "sessionId" | "vendor">) => {
    if (!sessions.has(id) && s.phase !== "cancelled") {
      return; // 已被取消/替换的会话不再吱声
    }
    opts.onStatus({ sessionId: id, vendor: spec.id, ...s });
  };
  const ctx: LoginContext = {
    signal: session.signal,
    mode: opts.mode,
    input: opts.input,
    openUrl: opts.openUrl,
    onDeviceCode: (dc: DeviceCode) =>
      post({
        phase: "device",
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        verificationUriComplete: dc.verificationUriComplete,
        text: "已打开浏览器，请在页面里确认授权",
      }),
    onWaitingBrowser: (url) => post({ phase: "browser", authUrl: url, text: "已打开浏览器，请完成登录并授权" }),
    onPhase: (text) => post({ phase: session.signal.cancelled ? "cancelled" : "starting", text }),
  };
  post({ phase: "starting", text: "正在准备登录…" });
  void (async () => {
    try {
      const tok = await spec.login(ctx);
      if (session.signal.cancelled) {
        return;
      }
      post({ phase: "exchanging", text: "登录成功，正在保存…" });
      await opts.onToken(tok);
      post({ phase: "done", text: "登录成功", account: { email: tok.email, plan: tok.plan, accountId: tok.accountId } });
    } catch (e) {
      if (e instanceof LoginCancelled || session.signal.cancelled) {
        post({ phase: "cancelled", text: "已取消" });
      } else {
        const msg = (e as Error).message || String(e);
        error(`[${spec.name}] 登录失败：${msg}`);
        post({ phase: "error", error: msg });
      }
    } finally {
      sessions.delete(id);
    }
  })();
  return id;
}

export function cancelLogin(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    s.signal.cancel();
    sessions.delete(sessionId);
  }
}

export function cancelAllLogins(): void {
  for (const s of sessions.values()) {
    s.signal.cancel();
  }
  sessions.clear();
}
