/**
 * GitHub Release 更新检查与自更新。本扩展不在应用市场发布，"和 GitHub 同步" = 查仓库最新 Release
 * （`api.github.com/repos/<owner>/<repo>/releases/latest`），tag 比当前 `package.json` 版本新就提示。
 * - 启动静默查（`checkForUpdate`）：24h 一次，同一个新版本只弹一次通知（globalState 记忆）；通知给「立即更新」。
 * - 手动「检查更新」（面板头部图标 / 设置页按钮，`installLatestFromGitHub`）：查最新 Release → 有新版就把 Release 里的
 *   `api2kiro-dual-<ver>.vsix` 资产下载到 `globalStorageUri/updates/`，校验（zip 头 + 大小 + 包内 package.json 的 name /
 *   version）后调 `workbench.extensions.installExtension` 安装，再提示重载窗口；已是最新 / 失败都给结果。
 * 网络只读、只对 GitHub 域（api.github.com / github.com / objects.githubusercontent.com / release-assets.githubusercontent.com）；
 * 不带任何凭证；离线 / 限流 / 无 Release 时静默查安静失败，手动查给出原因并留「打开 Release 页」兜底。
 * 面板头部「检查更新」图标的小圆点由 `UpdateState`（`getUpdateState` / `onUpdateStateChanged`）驱动。
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as zlib from "zlib";
import { info, warn, error as logError } from "./log";

export const GITHUB_OWNER = "yourhoneypomelo-cell";
export const GITHUB_REPO = "API4Kiro";
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
/** 扩展内部 id（`package.json.name`）；Release 资产名与包内 package.json 都按它校验。 */
export const EXTENSION_NAME = "api2kiro-dual";
/** 单个 vsix 资产的大小上限（当前包不到 1 MB；超过它一定不是本扩展的包）。 */
export const MAX_VSIX_BYTES = 50 * 1024 * 1024;
/** 资产下载：跟随重定向的最大跳数（github.com → objects.githubusercontent.com 一跳，留余量）。 */
const MAX_REDIRECTS = 5;
/** 允许下载 / 重定向到的主机：GitHub 本体、API 与两代资产 CDN 域。 */
const GITHUB_HOSTS = new Set(["github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export interface SemVerParts {
  /** 核心数字段（去 `v` 前缀、按 `.` 分段；非数字段按 0）。 */
  core: number[];
  /** 预发布标识（`-` 之后、`+` 之前，按 `.` 分段）；正式版为空数组。 */
  prerelease: string[];
}

/**
 * 按 semver 拆版本号："v4.13.51" → core [4,13,51]；"4.13.51-beta.2+build.7" → core [4,13,51]、prerelease ["beta","2"]，
 * 构建元数据（`+` 之后）丢弃（semver §10：不参与优先级比较）。
 */
export function parseSemver(v: string): SemVerParts {
  let s = String(v).trim().replace(/^v/i, "");
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf("-");
  const corePart = dash >= 0 ? s.slice(0, dash) : s;
  const prePart = dash >= 0 ? s.slice(dash + 1) : "";
  const core = corePart.split(".").map((seg) => {
    const n = parseInt(seg, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const prerelease = prePart ? prePart.split(".").filter((x) => x.length > 0) : [];
  return { core, prerelease };
}

/** "v4.13.51" / "4.13.51-beta.2" → 核心数字段 [4,13,51]（预发布与构建元数据不在其中，见 `parseSemver`）。 */
export function parseVersion(v: string): number[] {
  return parseSemver(v).core;
}

/** semver §11.4：纯数字标识按数值比、数字低于字母数字、字母数字按 ASCII。 */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const d = Number(a) - Number(b);
    return d === 0 ? 0 : d > 0 ? 1 : -1;
  }
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * a 比 b 新 → 1；相等 → 0；旧 → -1。核心段逐段比较，缺段补 0（4.13 == 4.13.0）；
 * 核心段相同时按 semver：带预发布标识的低于同号正式版（4.13.53-beta.1 < 4.13.53），两个预发布逐标识比较、
 * 标识少的（是对方前缀的）低（beta < beta.1）；构建元数据不参与比较（4.13.53+build.7 == 4.13.53）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const m = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < m; i++) {
    if (i >= pa.prerelease.length) return -1;
    if (i >= pb.prerelease.length) return 1;
    const c = comparePrereleaseIdentifier(pa.prerelease[i], pb.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** tag → 纯版本号（去 `v` 前缀与首尾空白），用来拼资产名与校验包内版本。 */
export function versionOfTag(tag: string): string {
  return String(tag).trim().replace(/^v/i, "");
}

export interface ReleaseAsset {
  name: string;
  /** `browser_download_url`：github.com/<owner>/<repo>/releases/download/<tag>/<name>，实际 30x 到资产 CDN。 */
  url: string;
  /** GitHub 报的字节数；下载后逐字节核对。 */
  size: number;
}

export interface LatestRelease {
  tag: string;
  htmlUrl: string;
  name?: string;
  assets: ReleaseAsset[];
}

/** 本扩展某版本的 vsix 资产名（与 `npm run package` / CI 产物名一致）。 */
export function vsixAssetName(version: string): string {
  return `${EXTENSION_NAME}-${versionOfTag(version)}.vsix`;
}

/**
 * 从 Release 资产里挑要装的 vsix：先精确匹配 `api2kiro-dual-<ver>.vsix`；没有就退到「恰好只有一个 .vsix」；
 * 都不满足返回 undefined（多个 .vsix 又没有精确名 → 不猜）。
 */
export function pickVsixAsset(assets: ReleaseAsset[] | undefined, version: string): ReleaseAsset | undefined {
  const list = Array.isArray(assets) ? assets : [];
  const want = vsixAssetName(version);
  const exact = list.find((a) => a.name === want);
  if (exact) return exact;
  const vsix = list.filter((a) => /\.vsix$/i.test(a.name));
  return vsix.length === 1 ? vsix[0] : undefined;
}

function parseAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const a of raw as Array<Record<string, unknown>>) {
    if (!a || typeof a !== "object") continue;
    const name = typeof a.name === "string" ? a.name : "";
    const url = typeof a.browser_download_url === "string" ? a.browser_download_url : "";
    const size = typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? a.size : -1;
    if (name && url) out.push({ name, url, size });
  }
  return out;
}

/**
 * GET 最新 Release；任何非 200 / 解析失败 / 网络错误 / 服务端半途断连 / 超时都解析为 null（不抛），
 * 且一定在 `timeoutMs`（外加计时器抖动）内结算。
 * - socket `timeout` 只覆盖「一直没数据」；服务端发完响应头后断连时 Node 只在 `res` 上发 `aborted` / `close`
 *   （`error` 仅在有监听者时才发），`end` 永不到——所以 `res` 的 `aborted` / `error` / `close` 都要接，
 *   再用一个墙钟计时器兜底所有没想到的路径（慢速滴数据、被中间设备挂住等）。
 * - `url` 只供测试指向本地假服务；生产调用用默认值。
 */
export function fetchLatestRelease(timeoutMs = 8000, url = GITHUB_LATEST_RELEASE_API): Promise<LatestRelease | null> {
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const done = (v: LatestRelease | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(v);
    };
    const abort = () => {
      done(null);
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
    };
    const deadline = setTimeout(abort, timeoutMs);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      abort();
      return;
    }
    const lib = target.protocol === "http:" ? http : https;
    try {
      req = lib.request(
        {
          hostname: target.hostname,
          port: target.port ? Number(target.port) : undefined,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: {
            // GitHub API 要求 User-Agent，否则 403
            "User-Agent": "API4Kiro-extension",
            Accept: "application/vnd.github+json",
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            done(null);
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(body) as { tag_name?: string; html_url?: string; name?: string; assets?: unknown };
              if (j && typeof j.tag_name === "string" && j.tag_name) {
                done({ tag: j.tag_name, htmlUrl: j.html_url || GITHUB_RELEASES_URL, name: j.name, assets: parseAssets(j.assets) });
              } else {
                done(null);
              }
            } catch {
              done(null);
            }
          });
          // 半途断连：`end` 不会来，只会来这些
          res.on("aborted", () => done(null));
          res.on("error", () => done(null));
          res.on("close", () => done(null));
        }
      );
    } catch {
      abort();
      return;
    }
    req.on("error", () => done(null));
    req.on("timeout", abort);
    req.end();
  });
}

// ----------------------------------------------------------------------------------------
// 更新状态（面板头部图标的小圆点 / 转圈由它驱动）
// ----------------------------------------------------------------------------------------

export interface UpdateState {
  /** 当前安装的版本（`package.json.version`）。 */
  current: string;
  /** 最近一次查到的最新 Release tag（如 `v4.13.54`）；从未查到为 undefined。 */
  latest?: string;
  /** 最新 Release 比当前新。 */
  hasUpdate: boolean;
  /** 最新 Release 的页面地址（打开 Release 页兜底用）。 */
  htmlUrl?: string;
  /** 正在检查 / 下载 / 安装（按钮转圈、拒绝重复点击）。 */
  busy: boolean;
  /** 最近一次成功查到 Release 的时刻。 */
  checkedAt?: number;
  /** 本次会话里已经装好、等重载生效的版本 tag（装好后 `hasUpdate` 置回 false，避免重复下载）。 */
  installed?: string;
}

let updateState: UpdateState = { current: "", hasUpdate: false, busy: false };
const stateListeners = new Set<(s: UpdateState) => void>();

export function getUpdateState(): UpdateState {
  return { ...updateState };
}

export function onUpdateStateChanged(listener: (s: UpdateState) => void): vscode.Disposable {
  stateListeners.add(listener);
  return { dispose: () => void stateListeners.delete(listener) };
}

function setUpdateState(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch };
  const snapshot = getUpdateState();
  for (const l of Array.from(stateListeners)) {
    try {
      l(snapshot);
    } catch (e) {
      logError("update state listener failed:", (e as Error).message);
    }
  }
}

/** 测试用：清掉进程内的更新状态与监听者。 */
export function _resetUpdateStateForTest(): void {
  updateState = { current: "", hasUpdate: false, busy: false };
  stateListeners.clear();
}

function currentVersionOf(context: vscode.ExtensionContext): string {
  return String(context.extension.packageJSON.version || "0.0.0");
}

function recordRelease(current: string, rel: LatestRelease): number {
  const cmp = compareVersions(rel.tag, current);
  setUpdateState({ current, latest: rel.tag, hasUpdate: cmp > 0, htmlUrl: rel.htmlUrl, checkedAt: Date.now() });
  return cmp;
}

// ----------------------------------------------------------------------------------------
// 启动静默检查
// ----------------------------------------------------------------------------------------

const LAST_NOTIFIED_KEY = "api4kiro.updateNotifiedTag";
const LAST_CHECK_KEY = "api4kiro.updateLastCheckMs";
const CHECK_INTERVAL_MS = 24 * 3600_000;

export interface CheckOptions {
  /** true=用户手动点「检查更新」：总是查、总是给结果；false=启动静默查：24h 一次、同版本不重复弹。 */
  manual: boolean;
  /** 手动查时用面板 toast 反馈「已是最新 / 失败」；不传则回退到通知。 */
  toast?: (kind: "ok" | "error", msg: string) => void;
}

/**
 * 检查 GitHub 最新 Release 并按需提示。异步、非阻塞、失败静默（手动查才反馈失败）。
 * 查到的结果同时写进 `UpdateState`（面板头部图标据此显示小圆点）；新版通知带「立即更新」（走 `installLatestFromGitHub`）。
 */
export async function checkForUpdate(context: vscode.ExtensionContext, opts: CheckOptions): Promise<void> {
  const current = currentVersionOf(context);
  if (!updateState.current) setUpdateState({ current });
  if (!opts.manual) {
    const last = context.globalState.get<number>(LAST_CHECK_KEY) || 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
  }
  const rel = await fetchLatestRelease();
  if (!opts.manual) void context.globalState.update(LAST_CHECK_KEY, Date.now());
  if (!rel) {
    warn("update check: no release / unreachable");
    if (opts.manual) opts.toast?.("error", "检查更新失败：连不上 GitHub 或仓库还没有 Release");
    return;
  }
  const cmp = recordRelease(current, rel);
  info(`update check: latest ${rel.tag} vs current v${current} → ${cmp > 0 ? "newer" : cmp < 0 ? "older" : "same"}`);
  if (cmp > 0) {
    // 静默模式：同一个新版本只弹一次
    if (!opts.manual && context.globalState.get<string>(LAST_NOTIFIED_KEY) === rel.tag) return;
    if (!opts.manual) void context.globalState.update(LAST_NOTIFIED_KEY, rel.tag);
    const pick = await vscode.window.showInformationMessage(
      `API4Kiro 有新版本 ${rel.tag}（当前 v${current}）。可直接从 GitHub 下载安装。`,
      "立即更新",
      "打开 Release 页",
      "稍后"
    );
    if (pick === "立即更新") void installLatestFromGitHub(context, {});
    else if (pick === "打开 Release 页") void vscode.env.openExternal(vscode.Uri.parse(rel.htmlUrl));
  } else if (opts.manual) {
    opts.toast?.("ok", `已是最新版本 v${current}`);
  }
}

// ----------------------------------------------------------------------------------------
// 下载 + 校验 + 安装
// ----------------------------------------------------------------------------------------

/** 用户取消（进度通知上的「取消」）；与其它失败区分开，取消不弹错误。 */
export class UpdateCancelledError extends Error {
  constructor() {
    super("已取消更新");
    this.name = "UpdateCancelledError";
  }
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 下载 / 重定向目标主机是否允许：GitHub 四个域；`testOrigin`（测试注入的本地假服务）非空时再放行回环地址。
 * 生产路径 `testOrigin` 为 undefined，任何非 GitHub 域（含回环）都拒绝。
 */
export function isAllowedDownloadHost(hostname: string, testOrigin?: string): boolean {
  const h = String(hostname || "").toLowerCase();
  if (GITHUB_HOSTS.has(h)) return true;
  return !!testOrigin && isLoopbackHost(h);
}

export interface DownloadOptions {
  /** 单次 socket 空闲超时（无数据流动这么久就放弃）。 */
  idleTimeoutMs?: number;
  /** 整体墙钟上限。 */
  totalTimeoutMs?: number;
  /** 字节上限（`Content-Length` 超过或实际读到超过都失败）。 */
  maxBytes?: number;
  /** GitHub 报的资产大小；给了就要求实际字节数相等。 */
  expectedSize?: number;
  token?: vscode.CancellationToken;
  onProgress?: (received: number, total: number | undefined) => void;
  /** 测试注入：允许回环主机。 */
  testOrigin?: string;
}

/**
 * 把 `url` 下载到 `dest`：先写 `dest.part` 再 rename，任何失败删掉半成品。
 * 跟随最多 `MAX_REDIRECTS` 次 30x（每一跳都过主机白名单）；带 UA；校验 `Content-Length`（有则实际字节必须相等）、
 * `expectedSize`、`maxBytes`；空闲超时 + 总时限 + 取消令牌三层中止。返回实际字节数。
 */
export function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<number> {
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  const totalMs = opts.totalTimeoutMs ?? 10 * 60_000;
  const maxBytes = opts.maxBytes ?? MAX_VSIX_BYTES;
  const part = `${dest}.part`;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let out: fs.WriteStream | undefined;
    let received = 0;
    let tokenSub: vscode.Disposable | undefined;
    const cleanupPart = () => {
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* ignore */
      }
    };
    const finish = (err: Error | null, bytes = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      tokenSub?.dispose();
      if (!err) {
        resolve(bytes);
        return;
      }
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      // 半成品必须在 reject 之前删掉（调用方据此判断「无残留」）；Windows 上句柄还开着时删不掉，
      // 所以先等写流 close 再删，再兜一个计时器防 close 不来。
      let cleaned = false;
      const settle = () => {
        if (cleaned) return;
        cleaned = true;
        cleanupPart();
        reject(err);
      };
      if (!out || out.closed) {
        settle();
        return;
      }
      out.once("close", settle);
      setTimeout(settle, 2000).unref?.();
      if (!out.destroyed) out.destroy();
    };
    const deadline = setTimeout(() => finish(new Error(`下载超时（超过 ${Math.round(totalMs / 1000)} 秒）`)), totalMs);
    if (opts.token) {
      if (opts.token.isCancellationRequested) {
        finish(new UpdateCancelledError());
        return;
      }
      tokenSub = opts.token.onCancellationRequested(() => finish(new UpdateCancelledError()));
    }

    const go = (current: string, hops: number) => {
      if (settled) return;
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        finish(new Error(`下载地址不合法：${current}`));
        return;
      }
      if (target.protocol !== "https:" && !(target.protocol === "http:" && opts.testOrigin)) {
        finish(new Error(`下载地址协议不允许：${target.protocol}`));
        return;
      }
      if (!isAllowedDownloadHost(target.hostname, opts.testOrigin)) {
        finish(new Error(`下载地址不在 GitHub 域内，已拒绝：${target.hostname}`));
        return;
      }
      const lib = target.protocol === "http:" ? http : https;
      try {
        req = lib.request(
          {
            hostname: target.hostname,
            port: target.port ? Number(target.port) : undefined,
            path: `${target.pathname}${target.search}`,
            method: "GET",
            headers: { "User-Agent": "API4Kiro-extension", Accept: "application/octet-stream" },
            timeout: idleMs,
          },
          (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume();
              if (hops >= MAX_REDIRECTS) {
                finish(new Error("下载重定向次数过多"));
                return;
              }
              let next: string;
              try {
                next = new URL(res.headers.location, target).toString();
              } catch {
                finish(new Error("下载重定向地址不合法"));
                return;
              }
              go(next, hops + 1);
              return;
            }
            if (status !== 200) {
              res.resume();
              finish(new Error(`下载失败：HTTP ${status}`));
              return;
            }
            const lenHeader = res.headers["content-length"];
            const declared = lenHeader !== undefined ? Number(lenHeader) : undefined;
            if (declared !== undefined && (!Number.isFinite(declared) || declared < 0)) {
              res.resume();
              finish(new Error("下载失败：Content-Length 不合法"));
              return;
            }
            if (declared !== undefined && declared > maxBytes) {
              res.resume();
              finish(new Error(`安装包过大（${declared} 字节，上限 ${maxBytes}）`));
              return;
            }
            if (declared !== undefined && opts.expectedSize !== undefined && opts.expectedSize >= 0 && declared !== opts.expectedSize) {
              res.resume();
              finish(new Error(`安装包大小与 Release 资产不一致（服务端 ${declared} 字节，资产 ${opts.expectedSize} 字节）`));
              return;
            }
            try {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              out = fs.createWriteStream(part, { flags: "w" });
            } catch (e) {
              res.resume();
              finish(new Error(`无法写入下载目录：${(e as Error).message}`));
              return;
            }
            out.on("error", (e) => finish(new Error(`写入安装包失败：${e.message}`)));
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > maxBytes) {
                finish(new Error(`安装包过大（超过 ${maxBytes} 字节）`));
                return;
              }
              opts.onProgress?.(received, declared);
            });
            res.on("aborted", () => finish(new Error("下载被中断（连接提前关闭）")));
            res.on("error", (e) => finish(new Error(`下载出错：${e.message}`)));
            res.pipe(out);
            out.on("finish", () => {
              if (settled) return;
              if (declared !== undefined && received !== declared) {
                finish(new Error(`下载不完整（收到 ${received} 字节，应为 ${declared} 字节）`));
                return;
              }
              if (opts.expectedSize !== undefined && opts.expectedSize >= 0 && received !== opts.expectedSize) {
                finish(new Error(`安装包大小与 Release 资产不一致（收到 ${received} 字节，资产 ${opts.expectedSize} 字节）`));
                return;
              }
              try {
                fs.rmSync(dest, { force: true });
                fs.renameSync(part, dest);
              } catch (e) {
                finish(new Error(`落盘安装包失败：${(e as Error).message}`));
                return;
              }
              finish(null, received);
            });
          }
        );
      } catch (e) {
        finish(new Error(`发起下载失败：${(e as Error).message}`));
        return;
      }
      req.on("error", (e) => finish(new Error(`下载出错：${e.message}`)));
      req.on("timeout", () => finish(new Error(`下载超时（${Math.round(idleMs / 1000)} 秒无数据）`)));
      req.end();
    };
    go(url, 0);
  });
}

export interface VsixExpectation {
  name: string;
  version: string;
  /** GitHub 报的资产大小；给了（≥ 0）就要求文件大小相等。 */
  size?: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 在 zip 里按名字找一个条目并解出内容（只支持 stored / deflate；不支持 ZIP64 与加密——vsix 从不用）。 */
export function readZipEntry(buf: Buffer, entryName: string): Buffer | undefined {
  if (buf.length < 22) return undefined;
  // EOCD 在文件尾部，注释最长 65535 字节；从尾部向前找签名
  const minPos = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 缺少中央目录结尾记录");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("不支持 ZIP64 格式");
  if (cdOffset + cdSize > buf.length) throw new Error("zip 中央目录越界");
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== entryName) continue;
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("不支持 ZIP64 格式");
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("zip 本地文件头损坏");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error("zip 条目数据越界");
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return Buffer.from(raw);
    if (method === 8) {
      const inflated = zlib.inflateRawSync(raw);
      if (inflated.length !== uncompSize) throw new Error("zip 条目解压后大小不符");
      return inflated;
    }
    throw new Error(`zip 条目压缩方式不支持（method ${method}）`);
  }
  return undefined;
}

/**
 * 校验下载好的 vsix：文件大小（给了 `size`）、zip 本地文件头 `PK\x03\x04`、包内 `extension/package.json` 的
 * `name` / `version` 与期望一致。任一不满足抛 Error（文案直接给用户看）。
 */
export async function verifyVsix(file: string, expect: VsixExpectation): Promise<{ name: string; version: string; bytes: number }> {
  const st = await fs.promises.stat(file);
  if (expect.size !== undefined && expect.size >= 0 && st.size !== expect.size) {
    throw new Error(`安装包大小与 Release 资产不一致（${st.size} 字节，应为 ${expect.size} 字节）`);
  }
  if (st.size > MAX_VSIX_BYTES) throw new Error(`安装包过大（${st.size} 字节）`);
  const buf = await fs.promises.readFile(file);
  if (buf.length < 4 || buf.readUInt32LE(0) !== SIG_LOCAL) throw new Error("安装包不是 zip / vsix 文件（缺少 PK 头）");
  let manifest: Buffer | undefined;
  try {
    manifest = readZipEntry(buf, "extension/package.json");
  } catch (e) {
    throw new Error(`安装包结构损坏：${(e as Error).message}`);
  }
  if (!manifest) throw new Error("安装包里没有 extension/package.json");
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(manifest.toString("utf8"));
  } catch {
    throw new Error("安装包内 package.json 不是合法 JSON");
  }
  const name = typeof pkg.name === "string" ? pkg.name : "";
  const version = typeof pkg.version === "string" ? pkg.version : "";
  if (name !== expect.name) throw new Error(`安装包不是本扩展（package.json name=${name || "?"}，应为 ${expect.name}）`);
  if (!version || versionOfTag(version) !== versionOfTag(expect.version)) {
    throw new Error(`安装包版本不符（包内 ${version || "?"}，Release 为 ${expect.version}）`);
  }
  return { name, version, bytes: st.size };
}

/** `globalStorageUri/updates`：下载的 vsix 落在这里；每次成功安装后只保留刚装的那一个。 */
export function updatesDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "updates");
}

/** 删掉 `dir` 里除 `keep` 之外的 *.vsix 与 *.part（旧版本安装包、半成品）。返回删掉的文件名。 */
export function cleanupUpdatesDir(dir: string, keep?: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const n of names) {
    if (!/\.(vsix|part)$/i.test(n)) continue;
    const full = path.join(dir, n);
    if (keep && path.resolve(full) === path.resolve(keep)) continue;
    try {
      fs.rmSync(full, { force: true });
      removed.push(n);
    } catch {
      /* 占用中就留着，下次再清 */
    }
  }
  return removed;
}

export type InstallStatus = "busy" | "unreachable" | "up-to-date" | "no-asset" | "installed" | "pending-reload" | "cancelled" | "failed";

export interface InstallResult {
  status: InstallStatus;
  current: string;
  latest?: string;
  /** 下载到本地的 vsix 路径（下载成功后才有，失败时也给，供用户手动安装）。 */
  vsixPath?: string;
  error?: string;
}

export interface InstallOptions {
  /** 面板 toast（重复点击等轻量反馈）；不传则静默。 */
  toast?: (kind: "ok" | "error", msg: string) => void;
  /** 测试注入：本地假服务的 releases/latest 地址；同时放行回环主机的资产下载。 */
  apiUrl?: string;
  /** 查 Release 的超时（默认 8s）。 */
  fetchTimeoutMs?: number;
  /** 下载参数覆盖（测试缩短超时）。 */
  download?: Pick<DownloadOptions, "idleTimeoutMs" | "totalTimeoutMs" | "maxBytes">;
}

const INSTALL_COMMAND = "workbench.extensions.installExtension";

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 失败兜底：错误通知 + 「打开 Release 页」（用户可自行下载安装）。 */
async function offerReleasePage(message: string, htmlUrl: string | undefined): Promise<void> {
  const pick = await vscode.window.showErrorMessage(message, "打开 Release 页");
  if (pick === "打开 Release 页") void vscode.env.openExternal(vscode.Uri.parse(htmlUrl || GITHUB_RELEASES_URL));
}

/**
 * 「检查更新」的完整流程：查最新 Release → 比版本 → 挑 vsix 资产 → 带进度、可取消地下载到 `updates/` →
 * 校验 → `workbench.extensions.installExtension` 安装 → 清理旧包 → 提示重载。
 * 已是最新 / 没有资产 / 下载与校验失败 / 安装失败都各自给结果；同一时间只跑一个。
 */
export async function installLatestFromGitHub(context: vscode.ExtensionContext, opts: InstallOptions = {}): Promise<InstallResult> {
  const current = currentVersionOf(context);
  if (updateState.busy) {
    opts.toast?.("ok", "正在检查更新，请稍候");
    return { status: "busy", current };
  }
  setUpdateState({ current, busy: true });
  const dir = updatesDir(context);
  let dest: string | undefined;
  let downloaded = false;
  let latestUrl: string | undefined;
  try {
    const rel = await fetchLatestRelease(opts.fetchTimeoutMs ?? 8000, opts.apiUrl ?? GITHUB_LATEST_RELEASE_API);
    if (!rel) {
      warn("update: releases/latest unreachable or empty");
      void offerReleasePage("API4Kiro 检查更新失败：连不上 GitHub 或仓库还没有 Release。", undefined);
      return { status: "unreachable", current };
    }
    latestUrl = rel.htmlUrl;
    const alreadyInstalled = updateState.installed === rel.tag;
    const cmp = recordRelease(current, rel);
    info(`update: latest ${rel.tag} vs current v${current} → ${cmp > 0 ? "newer" : cmp < 0 ? "older" : "same"}`);
    if (cmp <= 0) {
      void vscode.window.showInformationMessage(`API4Kiro 已是最新版本 v${current}。`);
      return { status: "up-to-date", current, latest: rel.tag };
    }
    if (alreadyInstalled) {
      // 本次会话已经装过这一版，只差重载；不再下载第二遍
      setUpdateState({ hasUpdate: false, installed: rel.tag });
      void vscode.window
        .showInformationMessage(`API4Kiro ${rel.tag} 已安装，重新加载窗口后生效。`, "重新加载窗口", "稍后")
        .then((choice) => {
          if (choice === "重新加载窗口") void vscode.commands.executeCommand("workbench.action.reloadWindow");
        });
      return { status: "pending-reload", current, latest: rel.tag };
    }
    const version = versionOfTag(rel.tag);
    const asset = pickVsixAsset(rel.assets, version);
    if (!asset) {
      warn(`update: release ${rel.tag} has no installable .vsix asset (${rel.assets.length} assets)`);
      void offerReleasePage(`API4Kiro ${rel.tag} 的 Release 里没有可安装的 .vsix 资产，请到 Release 页手动下载。`, rel.htmlUrl);
      return { status: "no-asset", current, latest: rel.tag };
    }
    fs.mkdirSync(dir, { recursive: true });
    cleanupUpdatesDir(dir);
    dest = path.join(dir, vsixAssetName(version));
    const target = dest;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `API4Kiro 正在更新到 ${rel.tag}`, cancellable: true },
      async (progress, token) => {
        let lastPct = 0;
        progress.report({ message: `下载 ${asset.name}…` });
        const bytes = await downloadFile(asset.url, target, {
          ...(opts.download || {}),
          expectedSize: asset.size >= 0 ? asset.size : undefined,
          token,
          testOrigin: opts.apiUrl && opts.apiUrl !== GITHUB_LATEST_RELEASE_API ? opts.apiUrl : undefined,
          onProgress: (received, total) => {
            if (total) {
              const pct = Math.min(100, Math.floor((received / total) * 100));
              if (pct > lastPct) {
                progress.report({ increment: pct - lastPct, message: `下载 ${fmtBytes(received)} / ${fmtBytes(total)}` });
                lastPct = pct;
              }
            } else {
              progress.report({ message: `下载 ${fmtBytes(received)}` });
            }
          },
        });
        downloaded = true;
        info(`update: downloaded ${asset.name} (${bytes} bytes)`);
        if (token.isCancellationRequested) throw new UpdateCancelledError();
        progress.report({ message: "校验安装包…" });
        await verifyVsix(target, { name: EXTENSION_NAME, version, size: asset.size >= 0 ? asset.size : undefined });
        if (token.isCancellationRequested) throw new UpdateCancelledError();
        progress.report({ message: "正在安装…" });
        await vscode.commands.executeCommand(INSTALL_COMMAND, vscode.Uri.file(target));
      }
    );
    cleanupUpdatesDir(dir, dest);
    info(`update: installed ${rel.tag} from ${dest}`);
    // 当前宿主仍跑着旧版本：小圆点改成「已安装，重载后生效」，再点不重复下载
    setUpdateState({ hasUpdate: false, installed: rel.tag });
    void vscode.window
      .showInformationMessage(`API4Kiro 已安装 ${rel.tag}，重新加载窗口后生效。`, "重新加载窗口", "稍后")
      .then((choice) => {
        if (choice === "重新加载窗口") void vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
    return { status: "installed", current, latest: rel.tag, vsixPath: dest };
  } catch (e) {
    const err = e as Error;
    if (err instanceof UpdateCancelledError || err?.name === "UpdateCancelledError") {
      info("update: cancelled by user");
      if (dest) cleanupUpdatesDir(dir);
      void vscode.window.showInformationMessage("API4Kiro 已取消更新。");
      return { status: "cancelled", current, latest: updateState.latest };
    }
    const reason = err?.message || String(e);
    logError("update failed:", reason);
    const where = downloaded && dest ? `安装包已下载到 ${dest}，可在 Kiro 里「从 VSIX 安装」手动安装。` : "";
    void offerReleasePage(`API4Kiro 更新失败：${reason}。${where}`, latestUrl);
    return { status: "failed", current, latest: updateState.latest, vsixPath: downloaded ? dest : undefined, error: reason };
  } finally {
    setUpdateState({ busy: false });
  }
}
