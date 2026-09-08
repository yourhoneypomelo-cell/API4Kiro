/**
 * 本地代理的身份握手。
 *
 * 多窗口共享模型下，后启动的窗口探测端口，发现是「自己人」就待机。原先只比对
 * 名字，于是**升级后旧实例会一直霸占端口**：新窗口探到 `api2kiro-dual` 就以为
 * 是自己的另一个窗口，安静地进入待机，用户重载多少次都还是旧代码在应答，且没有
 * 任何提示。实测踩过一次（2.0.0 占着 19810，2.0.1 全程待机）。
 *
 * 所以身份里带上版本，并加一个让位动作：新版本请求旧版本释放端口，旧版本让出后
 * 新版本接管。同版本仍按原来的多窗口共享逻辑走（先到先得）。
 *
 * 常量集中在本文件，krsServer / cpsServer / portBinder 都从这里取，避免以前
 * 「三处各存一份、要一起改」的隐患。
 *
 * **鉴权（4.13.53 起）**。让位是一个控制动作，此前服务端只看 URL 里自报的版本号：同机任何进程
 * （浏览器里的网页也够）都能让主实例释放端口，再用公开常量 PROXY_ID_TOKEN + 一个高版本号伪装成
 * 「更新的自己人」让后续窗口待机，从而接收 Kiro 发往本地端口的对话 / 代码上下文 / Kiro bearer
 * （`.verify-artifacts/poc-claim1/` 19/19 复现）。现在同一用户的所有窗口共享一枚随机密钥
 * （identityKey.ts，globalStorage 下的文件），握手两个方向都带 HMAC-SHA256，且载荷绑定端口角色：
 *  - 让位：身份应答里带服务端一次性 `nonce`（30s、内存表限量，表键带角色）；让位请求头
 *    `x-a2k-yield-nonce` 回传该 nonce、`x-a2k-yield-auth` = HMAC(key, "yield|" + role + "|" + nonce + "|" + yieldTo)。
 *    校验通过才让位；否则 403 + 一条 warn（不含密钥），端口不动。
 *  - 对端认证：探测请求带 `?nonce=<随机 hex>`，应答 `sig` = HMAC(key, "ident|" + role + "|" + nonce + "|" + version)。
 *    探测方校验不过 → 当作外部进程占用（portBinder 既有的 foreign 分支：不待机、不让位、状态栏报冲突）。
 *  - `role ∈ {"krs","cps"}` 是端口角色，两端各按**自己这一侧**算：服务端用自己的角色签、探测方用它要抢的那个
 *    端口的角色验（不是对端应答里自报的 role）。于是签名绑定端口：先抢到一个端口的冒占者把探测中转给同机
 *    另一角色的合法实例换来的 `sig`，在这个端口上验不过；它诱导另一角色的窗口签出的让位，也顶不掉本角色的
 *    主实例；KRS 发的 nonce 拿到 CPS 去用查不到（表键 `role|nonce`）。
 *
 * 兼容矩阵（正常用户的多窗口体验必须与之前逐字相同）：
 *  1. 旧版主实例（< 4.13.53，不校验）× 新版窗口：旧实例忽略它不认识的 `nonce` 参数与签名头，
 *     仍按版本让位；新版窗口对「自报版本 < 4.13.53 且无 sig」的应答沿用旧的 token 判定 → 升级路径不回归。
 *  2. 新版主实例 × 旧版窗口（无签名的让位请求）：拒绝（403，`yielding:false`）；旧版窗口按其原逻辑走
 *     「旧实例不支持让位 / 请完全退出所有 Kiro 窗口」提示并待机（旧版窗口版本本就更低，正常不会发让位）。
 *  3. 同版本 / 新旧两个新版之间共享密钥：探测 → 验签 → 待机 / 退出接管 / 升级让位，与之前相同，
 *     线上只多了两个 header 与 `nonce` / `sig` 两个 JSON 字段。同一角色的两端角色必然相同，角色绑定
 *     对正常多窗零影响。
 *  本实例没拿到密钥（存储不可写等）时：拒绝一切让位（安全侧），探测对端沿用旧判定（不比修复前更差）。
 */

import * as crypto from "crypto";
import * as http from "http";
import { getExtensionVersion } from "./config";
import { debug, warn } from "./log";

/** **必须**与原版 API2Kiro 不同，否则两个扩展会互相误判为自己人而一起待机。 */
export const PROXY_ID_PATH = "/__api2kiro_dual_identity";
export const PROXY_ID_TOKEN = "api2kiro-dual";

/** 首个在握手里带签名的版本：自报版本 ≥ 它却不带 `sig` 的应答不再被当作自己人。 */
export const SIGNED_IDENTITY_SINCE = "4.13.53";
export const YIELD_AUTH_HEADER = "x-a2k-yield-auth";
export const YIELD_NONCE_HEADER = "x-a2k-yield-nonce";

const NONCE_TTL_MS = 30_000;
/** 内存表上限：正常一窗一次探测只留一条；满了淘汰最早的，攻击者刷探测也撑不大内存。 */
const NONCE_MAX = 256;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^[0-9a-f]{64}$/;

export interface ProxyIdentity {
  proxy: string;
  role: string;
  version: string;
  pid: number;
  yielding?: boolean;
  /** 服务端一次性挑战：随后的让位请求要对它签名（4.13.53 起）。 */
  nonce?: string;
  /** HMAC(key, "ident|" + 探测方 nonce + "|" + version)；探测方带了 nonce 且本实例有密钥时才有。 */
  sig?: string;
}

/** 只比较数字段，忽略预发布后缀。正数表示 a 比 b 新。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) {
      return d > 0 ? 1 : -1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- 密钥与签名

let identityKey: Buffer | undefined;

/** 由 identityKey.initIdentityKey 在激活时注入；测试直接注入。undefined = 无密钥（降级模式）。 */
export function setIdentityKey(key: Buffer | undefined): void {
  identityKey = key;
}

export function hasIdentityKey(): boolean {
  return !!identityKey;
}

function hmacHex(payload: string): string | undefined {
  return identityKey ? crypto.createHmac("sha256", identityKey).update(payload).digest("hex") : undefined;
}

/** 让位请求的签名：HMAC(key, "yield|" + role + "|" + nonce + "|" + yieldTo)。无密钥返回 undefined。 */
export function yieldSignature(role: string, nonce: string, yieldTo: string): string | undefined {
  return hmacHex(`yield|${role}|${nonce}|${yieldTo}`);
}

/** 身份应答的签名：HMAC(key, "ident|" + role + "|" + nonce + "|" + version)。无密钥返回 undefined。 */
export function identitySignature(role: string, nonce: string, version: string): string | undefined {
  return hmacHex(`ident|${role}|${nonce}|${version}`);
}

function sigEquals(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected || !SIG_RE.test(given) || !SIG_RE.test(expected)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/** 日志里只放对端自报值的前几十个字符，别让一个超长 query 把日志撑爆。 */
function short(v: unknown): string {
  return String(v ?? "").slice(0, 32);
}

// ---------------------------------------------------------------- 服务端 nonce 表

/**
 * `role|nonce` → 过期时刻。键里带发出它的角色：KRS 签发的 nonce 拿到 CPS 去用查不到，反之亦然。
 * Map 按插入序遍历，满了就淘汰最早的。
 */
const issuedNonces = new Map<string, number>();

const nonceKey = (role: string, nonce: string) => `${role}|${nonce}`;

function issueNonce(role: string): string {
  const now = Date.now();
  for (const [k, exp] of issuedNonces) {
    if (exp <= now) {
      issuedNonces.delete(k);
    }
  }
  while (issuedNonces.size >= NONCE_MAX) {
    const oldest = issuedNonces.keys().next().value as string;
    issuedNonces.delete(oldest);
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  issuedNonces.set(nonceKey(role, nonce), now + NONCE_TTL_MS);
  return nonce;
}

/**
 * 校验让位请求。通过时消费掉 nonce（一次性）。返回拒绝原因，通过返回 undefined。
 * `role` 是本实例这个端口的角色：nonce 必须是本角色签发的，签名也按本角色算。
 * 无密钥时一律拒绝：既无法鉴权，就不让任何人动端口。
 */
function verifyYield(headers: http.IncomingHttpHeaders | undefined, role: string, yieldTo: string): string | undefined {
  if (!identityKey) {
    return "本实例没有共享密钥";
  }
  const nonce = headers?.[YIELD_NONCE_HEADER];
  const auth = headers?.[YIELD_AUTH_HEADER];
  if (typeof nonce !== "string" || typeof auth !== "string") {
    return "缺少签名头";
  }
  const key = nonceKey(role, nonce);
  const exp = NONCE_RE.test(nonce) ? issuedNonces.get(key) : undefined;
  if (exp === undefined || exp <= Date.now()) {
    return "nonce 无效或已过期";
  }
  if (!sigEquals(auth, yieldSignature(role, nonce, yieldTo))) {
    return "签名不匹配";
  }
  issuedNonces.delete(key);
  return undefined;
}

// ---------------------------------------------------------------- 服务端

/** role -> 释放端口的动作。由 PortHolder 注册。 */
const yielders = new Map<string, () => void>();

export function registerYielder(role: string, release: () => void): void {
  yielders.set(role, release);
}

/**
 * 应答身份探测。返回 true 表示本次请求已处理完毕。
 *
 * `?yieldTo=<version>`：调用方声明自己的版本，比本实例新**且让位签名校验通过**时本实例让出端口；
 * 版本更新但签名不过 → 403，端口不动。`?nonce=<hex>`：调用方要求对身份签名（见文件头）。
 * `role` 是本端口的角色（krs / cps），签名与 nonce 表都按它算。
 * 仅监听 127.0.0.1，且只会让出本扩展自己占的端口。
 */
export function serveIdentity(
  url: string,
  res: http.ServerResponse,
  role: string,
  headers?: http.IncomingHttpHeaders
): boolean {
  const [path, query] = url.split("?");
  if (path !== PROXY_ID_PATH) {
    return false;
  }

  const mine = getExtensionVersion();
  const params = new URLSearchParams(query || "");
  const yieldTo = params.get("yieldTo");
  const wantsYield = !!yieldTo && compareVersions(yieldTo, mine) > 0;
  const refusal = wantsYield ? verifyYield(headers, role, yieldTo) : undefined;
  const yielding = wantsYield && !refusal;

  const body: ProxyIdentity = {
    proxy: PROXY_ID_TOKEN,
    role,
    version: mine,
    pid: process.pid,
    yielding,
    nonce: issueNonce(role),
  };
  const probeNonce = params.get("nonce");
  if (probeNonce && NONCE_RE.test(probeNonce)) {
    const sig = identitySignature(role, probeNonce, mine);
    if (sig) {
      body.sig = sig;
    }
  }

  if (wantsYield && refusal) {
    warn(`${role.toUpperCase()} 拒绝未鉴权的让位请求（yieldTo=${short(yieldTo)}）：${refusal}，端口不释放`);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));

  if (yielding) {
    // 先让响应写出去再关服务器，否则对端可能收到 RST 而判定探测失败。
    setTimeout(() => yielders.get(role)?.(), 50);
  }
  return true;
}

// ---------------------------------------------------------------- 探测端

/** 每个端口只对「验签失败」告警一次，验签通过后重置；持续被冒占时不至于每 2.5s 一条。 */
const peerWarned = new Set<number>();

function peerWarn(port: number, text: string): void {
  if (peerWarned.has(port)) {
    debug(`port ${port}: ${text}`);
    return;
  }
  peerWarned.add(port);
  warn(`端口 ${port} ${text}`);
}

/**
 * 对端是否可信为本扩展的另一个实例。有 `sig` 就必须验过；没有 `sig` 只接受自报版本早于
 * SIGNED_IDENTITY_SINCE 的真·旧版本。本实例无密钥时无法校验，沿用旧的 token 判定。
 * `role` 是**本方要抢的端口**的角色，不是对端自报的 `id.role`（那是攻击者可控的）。
 */
function authenticPeer(id: ProxyIdentity, role: string, nonce: string, port: number): boolean {
  if (!identityKey) {
    return true;
  }
  const version = String(id.version ?? "");
  if (id.sig !== undefined) {
    if (sigEquals(id.sig, identitySignature(role, nonce, version))) {
      peerWarned.delete(port);
      return true;
    }
    peerWarn(port, `上的实例身份签名不匹配（自报 v${short(version)}，pid ${short(id.pid)}），按外部进程占用处理`);
    return false;
  }
  if (compareVersions(version, SIGNED_IDENTITY_SINCE) >= 0) {
    peerWarn(port, `上的实例自报 v${short(version)} 却没有身份签名，按外部进程占用处理`);
    return false;
  }
  peerWarned.delete(port);
  return true;
}

/**
 * 探测端口上是谁。返回 null 表示无应答、应答不可解析、不是本扩展，或身份签名校验不过
 * （即被外部进程占用，无法共享）。
 *
 * `role`：这个端口在本方的角色（krs / cps），身份验签与让位签名都按它算。
 * `yieldTo`：请求对方让位；`serverNonce` 是上一次探测应答里对方给的 nonce，有它（且本实例有密钥）
 * 让位请求才带签名头——旧版对端不给 nonce，也不看头，行为与之前一致。
 */
export function probeIdentity(port: number, role: string, yieldTo?: string, serverNonce?: string): Promise<ProxyIdentity | null> {
  const myNonce = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams();
  if (yieldTo) {
    params.set("yieldTo", yieldTo);
  }
  params.set("nonce", myNonce);
  const path = `${PROXY_ID_PATH}?${params.toString()}`;

  const headers: Record<string, string> = {};
  if (yieldTo && serverNonce && NONCE_RE.test(serverNonce)) {
    const auth = yieldSignature(role, serverNonce, yieldTo);
    if (auth) {
      headers[YIELD_NONCE_HEADER] = serverNonce;
      headers[YIELD_AUTH_HEADER] = auth;
    }
  }

  return new Promise((resolve) => {
    const req = http.request(
      { method: "GET", host: "127.0.0.1", port, path, headers, timeout: 1500 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (!json || json.proxy !== PROXY_ID_TOKEN) {
              resolve(null);
              return;
            }
            resolve(authenticPeer(json as ProxyIdentity, role, myNonce, port) ? (json as ProxyIdentity) : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
