/**
 * OAuth token 仓：按「provider id（首条凭证）」或「providerId/credentialId（key 池里其余账号）」
 * 存第三方账号登录拿到的 access/refresh token。键的构造见 providers.tokenKeyOf。
 *
 * 为什么不放 settings.json：
 *  - refresh 会频繁改写 access token，写 settings 会触发整套配置变更→重拉模型；
 *  - refresh token 等价于账号本身，不该和普通配置一起被同步/导出。
 * 所以用 VS Code 的 SecretStorage（系统钥匙串）；拿不到 secrets（老宿主 / 测试桩）时退到
 * globalState。整张表存成一个 JSON blob（SecretStorage 没有 list），进程内常驻一份缓存，
 * 读是同步的，写异步落盘。
 */

import * as vscode from "vscode";
import { debug, error } from "../log";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** 绝对过期时刻（ms）。缺省=未知，不主动刷新，401 时再刷。 */
  expiresAt?: number;
  tokenType?: string;
  idToken?: string;
  /** 账号展示：邮箱 / 用户名。 */
  email?: string;
  /** 厂商侧账号 id（Codex 的 chatgpt_account_id 等）。 */
  accountId?: string;
  /** 订阅档位等附加展示信息（Codex 的 plus/pro/team）。 */
  plan?: string;
  /** 设备码流程用的设备 id（Kimi 要求请求头里的设备 id 与登录时一致）。 */
  deviceId?: string;
  /** 厂商私有附加字段（xAI 的 token_endpoint 等）。 */
  extra?: Record<string, string>;
  /** 上次成功刷新/登录的时刻。 */
  updatedAt: number;
}

const SECRET_KEY = "api4kiro.oauthTokens.v1";
const STATE_KEY = "oauthTokens.v1";

let ctx: vscode.ExtensionContext | undefined;
let table: Record<string, OAuthToken> = {};
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function normalize(raw: unknown): OAuthToken | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const accessToken = typeof o.accessToken === "string" ? o.accessToken : "";
  if (!accessToken) {
    return undefined;
  }
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string) ? (o[k] as string) : undefined);
  const extra =
    o.extra && typeof o.extra === "object"
      ? Object.fromEntries(Object.entries(o.extra as Record<string, unknown>).filter(([, v]) => typeof v === "string"))
      : undefined;
  return {
    accessToken,
    refreshToken: str("refreshToken"),
    expiresAt: typeof o.expiresAt === "number" && isFinite(o.expiresAt) ? o.expiresAt : undefined,
    tokenType: str("tokenType"),
    idToken: str("idToken"),
    email: str("email"),
    accountId: str("accountId"),
    plan: str("plan"),
    deviceId: str("deviceId"),
    extra: extra as Record<string, string> | undefined,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}

function parseTable(text: string | undefined): Record<string, OAuthToken> {
  if (!text) {
    return {};
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, OAuthToken> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const t = normalize(v);
      if (t) {
        out[k] = t;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function secrets(): vscode.SecretStorage | undefined {
  const s = (ctx as { secrets?: vscode.SecretStorage } | undefined)?.secrets;
  return s && typeof s.get === "function" && typeof s.store === "function" ? s : undefined;
}

/** 启动时调用；从 SecretStorage（或 globalState）加载整张表。 */
export async function initTokenStore(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  const sec = secrets();
  let text: string | undefined;
  if (sec) {
    try {
      text = await sec.get(SECRET_KEY);
    } catch (e) {
      error("oauth token store: secrets.get failed:", (e as Error).message);
    }
  }
  if (text === undefined) {
    // 首次启用 secrets 或 secrets 不可用：看 globalState 里有没有（老数据 / 回退存储）。
    text = context.globalState.get<string>(STATE_KEY);
    if (text && sec) {
      // 迁进钥匙串，globalState 里的明文清掉。
      try {
        await sec.store(SECRET_KEY, text);
        await context.globalState.update(STATE_KEY, undefined);
      } catch {
        /* 留在 globalState 也能用 */
      }
    }
  }
  table = parseTable(text);
  debug("oauth token store loaded", { providers: Object.keys(table) });
}

function persist(): void {
  const text = JSON.stringify(table);
  const c = ctx;
  if (!c) {
    return;
  }
  writeChain = writeChain
    .then(async () => {
      const sec = secrets();
      if (sec) {
        await sec.store(SECRET_KEY, text);
      } else {
        await c.globalState.update(STATE_KEY, text);
      }
    })
    .catch((e) => error("oauth token store: persist failed:", (e as Error).message));
}

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/** token 表变化时通知（UI 刷新登录状态）。 */
export function onTokensChanged(l: () => void): vscode.Disposable {
  listeners.add(l);
  return { dispose: () => listeners.delete(l) };
}

export function getToken(providerId: string): OAuthToken | undefined {
  return table[providerId];
}

export function hasToken(providerId: string): boolean {
  return !!table[providerId]?.accessToken;
}

export function setToken(providerId: string, token: OAuthToken): void {
  table[providerId] = { ...token, updatedAt: token.updatedAt || Date.now() };
  persist();
  emit();
}

export function deleteToken(key: string): void {
  if (table[key]) {
    delete table[key];
    persist();
    emit();
  }
}

/** 删掉某 provider 的全部 token（裸键 + 所有 providerId/cN 键）。删 provider 时用。 */
export function deleteProviderTokens(providerId: string): void {
  let changed = false;
  for (const k of Object.keys(table)) {
    if (k === providerId || k.startsWith(providerId + "/")) {
      delete table[k];
      changed = true;
    }
  }
  if (changed) {
    persist();
    emit();
  }
}

/** 复制一份 token（「创建副本」时新 provider 共用同一账号）。 */
export function copyToken(fromKey: string, toKey: string): void {
  const t = table[fromKey];
  if (t) {
    table[toKey] = { ...t, extra: t.extra ? { ...t.extra } : undefined };
    persist();
    emit();
  }
}

/** 把 token 从一个键挪到另一个键（删 c1 时把下一把提升为首条）。 */
export function moveToken(fromKey: string, toKey: string): void {
  const t = table[fromKey];
  delete table[fromKey];
  if (t) {
    table[toKey] = t;
  } else {
    delete table[toKey];
  }
  persist();
  emit();
}

/** 等待未完成的落盘（测试 / 停用时用）。 */
export function flushTokens(): Promise<void> {
  return writeChain;
}

/** 仅测试用。 */
export function _resetTokenStoreForTest(): void {
  table = {};
}
