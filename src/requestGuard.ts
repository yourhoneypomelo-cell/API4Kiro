/**
 * 本地 HTTP 服务（KRS / CPS）的请求来源守卫（4.13.53 起）。
 *
 * 两个服务只绑 127.0.0.1，但「本机发来」不等于「可信」：本机浏览器里打开的任意网页都能向
 * `http://127.0.0.1:19810/generateAssistantResponse` 发 `fetch(POST, text/plain)`——这是 CORS 意义上的
 * 简单请求，连预检都不需要——借用户配好的 API Key / OAuth 账号发一次完整对话请求；KRS 此前对所有响应加
 * `Access-Control-Allow-Origin: *`，网页还能逐帧读回模型输出。`<img src>` 一个裸 GET 就能让 CPS 对全部
 * 启用 provider 做一次带 Key 的模型列表拉取。审计：`.verify-artifacts/external-review-2026-09-07-surfaceA-http-log.md`
 * §1（路由与副作用清单）、§3 G1 / G2（修法）。
 *
 * 只放行「本机非浏览器客户端」，三条全部满足才放行：
 *  (i)   `Host` 头去掉端口后必须是 `127.0.0.1` / `localhost` / `[::1]` / `::1` 之一；缺失也拒绝（HTTP/1.1 必带）。
 *        挡 DNS 重绑定：攻击者域名解析到 127.0.0.1 时浏览器把请求当同站甚至同源，同源策略不再保护，
 *        但 `Host` 会是攻击者域名。
 *  (ii)  不得带 `Origin` 头；`Sec-Fetch-Site` 若存在必须是 `none`。浏览器对所有跨源请求与同源非 GET/HEAD
 *        请求都附 `Origin`，对每个请求都附 `Sec-Fetch-Site`（`Sec-` 前缀是禁止请求头，脚本改不了也删不掉；
 *        只有地址栏直接输入这类用户主动导航才是 `none`）。Node `http.request`、aws-sdk `NodeHttpHandler`、
 *        Node 全局 `fetch`（undici 对 origin 为 "client" 的请求不加 Origin）、curl 都不带这两个头。
 *  (iii) TCP 远端地址必须是回环（127.0.0.0/8、`::1`、`::ffff:127.0.0.0/8`）。服务本就只绑 127.0.0.1，这一条是纵深。
 *
 * 合法调用方逐个核对（零可见影响）：
 *  - Kiro 的 kiro-agent 扩展：只读副本 `.verify-artifacts/kiro-copy-1.0.437/extensions/kiro.kiro-agent/dist/extension.js`
 *    里 `getKrsConfig` / `getCpsConfig`（L16863）只喂给 Node 侧 `CodeWhispererStreaming`（L17886:C30710）与
 *    `CodeWhispererRuntimeClient`（L17886:C1111），运行时处理器 `NodeHttpHandler`（Node `http.request`，
 *    `Host` = `127.0.0.1:<port>`，无 Origin / Sec-Fetch-*）→ 放行。
 *  - Kiro 的 webview 包 `packages/kiro-ui-agent-chat/dist/assets/mermaid-*.js`：不含 `krsEndpoints` / `cpsEndpoints` /
 *    `codewhisperer.config` / `generateAssistantResponse` / `ListAvailableModels` / `127.0.0.1` / `XMLHttpRequest`；
 *    唯一一处真正的网络 `fetch(n)` 是 markdown 图片组件的「下载图片」按钮（L113），`vscode-webview://` 只出现在
 *    图片 src 允许集（L397）。没有 webview 直连本地端口，所以不放行任何 `Origin`（含 `vscode-webview://`）。
 *  - 本扩展其它窗口的 `probeIdentity`（`proxyIdentity.ts`，`http.request` 到 127.0.0.1）→ 放行。
 *  - 本扩展侧边栏面板：经 `postMessage` 与扩展通信，CSP 无 `connect-src`，不发 HTTP → 无影响。
 *  - 用户 curl / 回归网的 `http.request` 桩 → 放行。
 *
 * 不采用的方案：按 User-Agent 只放 Kiro（Node 攻击者改 UA 零成本，却会误伤 curl / probe / 测试桩）；要求自定义头或
 * 共享密钥（Kiro 不会带，等于把 Kiro 拒之门外）。
 *
 * 拒绝：403、`Content-Type: text/plain`、正文一行说明，**不带任何 CORS 头**（浏览器读不到响应体），并按
 * 「服务 + 原因」限频记一条 warn（同一原因 60 秒内最多一条——网页可以刷请求，日志不能被刷爆；被压掉的走 debug）。
 */

import * as http from "http";
import { debug, warn } from "./log";

/** 拒绝原因（机器可读；限频与响应正文都用它，不回显攻击者可控的头值）。 */
export type GuardReason = "ok" | "host-missing" | "host-not-loopback" | "origin-present" | "sec-fetch-site" | "remote-not-loopback";

export interface GuardVerdict {
  allow: boolean;
  /** 放行时为 "ok"；拒绝时为具体原因。 */
  reason: GuardReason;
  /** 供日志用的一句说明（含截短、去控制字符后的头值）；放行时为空串。 */
  detail: string;
}

/** 同一「服务 + 原因」两条 warn 之间的最小间隔。 */
export const GUARD_WARN_INTERVAL_MS = 60_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 日志里只放对端自报值的前几十个字符，控制字符替换掉，别让一个超长或带回车的头把日志撑爆。 */
function short(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[^\x20-\x7e\u00a0-\uffff]/g, "?")
    .slice(0, max);
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `Host` 头去端口。`[::1]:19810` → `[::1]`；`127.0.0.1:19810` → `127.0.0.1`；`localhost` → `localhost`；
 * 裸 `::1`（多个冒号、无方括号）原样返回。返回小写。
 */
export function hostWithoutPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const first = h.indexOf(":");
  if (first !== -1 && first === h.lastIndexOf(":")) {
    return h.slice(0, first);
  }
  return h;
}

/** 127.0.0.0/8、::1、::ffff:127.0.0.0/8 算回环。 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) {
    return false;
  }
  let a = addr.trim().toLowerCase();
  if (a === "::1") {
    return true;
  }
  if (a.startsWith("::ffff:")) {
    a = a.slice("::ffff:".length);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return !!m && m[1] === "127" && [m[2], m[3], m[4]].every((o) => Number(o) <= 255);
}

/**
 * 纯函数：按文件头三条规则判定一个入站请求能否放行。
 * `headers` 是 Node 已小写化键名的请求头；`socketRemoteAddress` 是 `req.socket.remoteAddress`。
 */
export function classifyLocalRequest(headers: http.IncomingHttpHeaders, socketRemoteAddress: string | undefined): GuardVerdict {
  const host = firstHeader(headers.host);
  if (host === undefined || host.trim() === "") {
    return { allow: false, reason: "host-missing", detail: "request has no Host header" };
  }
  if (!LOOPBACK_HOSTS.has(hostWithoutPort(host))) {
    return { allow: false, reason: "host-not-loopback", detail: `Host is not loopback: ${short(host, 64)}` };
  }
  const origin = firstHeader(headers.origin);
  if (origin !== undefined) {
    return { allow: false, reason: "origin-present", detail: `browser Origin header present: ${short(origin, 64)}` };
  }
  const site = firstHeader(headers["sec-fetch-site"]);
  if (site !== undefined && site.trim().toLowerCase() !== "none") {
    return { allow: false, reason: "sec-fetch-site", detail: `browser Sec-Fetch-Site header present: ${short(site, 16)}` };
  }
  if (!isLoopbackAddress(socketRemoteAddress)) {
    return { allow: false, reason: "remote-not-loopback", detail: `remote address is not loopback: ${short(socketRemoteAddress, 48)}` };
  }
  return { allow: true, reason: "ok", detail: "" };
}

// ---------------------------------------------------------------- 限频 warn

/** `${role}|${reason}` → 上一条 warn 的时刻。 */
const lastWarnAt = new Map<string, number>();

function warnLimited(role: string, verdict: GuardVerdict, method: string, path: string): void {
  const key = `${role}|${verdict.reason}`;
  const now = Date.now();
  const last = lastWarnAt.get(key);
  const text = `${role} 拒绝非本机客户端请求（${verdict.reason}：${verdict.detail}；${method} ${short(path, 80)}）→ 403`;
  if (last !== undefined && now - last < GUARD_WARN_INTERVAL_MS) {
    debug(text);
    return;
  }
  lastWarnAt.set(key, now);
  warn(text);
}

/** 测试用：清空限频表。 */
export function _resetGuardForTest(): void {
  lastWarnAt.clear();
}

// ---------------------------------------------------------------- 接线助手

/**
 * 在 KRS / CPS 的请求入口第一行调用。返回 true 表示通过、继续原有处理；返回 false 表示已用 403 应答完毕，
 * 调用方直接 return。必须放在任何 `Access-Control-Allow-*` 头之前——拒绝响应不得带 CORS 头。
 */
export function applyGuard(req: http.IncomingMessage, res: http.ServerResponse, role = "KRS"): boolean {
  const verdict = classifyLocalRequest(req.headers, req.socket?.remoteAddress);
  if (verdict.allow) {
    return true;
  }
  const url = req.url || "/";
  warnLimited(role, verdict, req.method || "GET", url.split("?")[0]);
  // 丢弃请求体（不读进内存），再应答；不 destroy，让对端能完整收到 403。
  req.resume();
  res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`Forbidden: this API4Kiro local endpoint only accepts requests from local non-browser clients (${verdict.reason})\n`);
  return false;
}
