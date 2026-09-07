/**
 * GitHub Release 更新检查。本扩展不在应用市场发布，"和 GitHub 同步" = 查仓库最新 Release
 * （`api.github.com/repos/<owner>/<repo>/releases/latest`），tag 比当前 `package.json` 版本新就提示，
 * 并给「打开 Release 页」按钮（Release 里挂 `.vsix` 供下载安装）。
 * - 启动静默查：24h 一次，同一个新版本只弹一次通知（globalState 记忆）。
 * - 手动查（设置页「检查更新」）：总是查、总是给结果（新版弹通知 / 已最新用 toast / 失败 toast）。
 * 只读一个公开 JSON 端点，不带任何凭证；离线 / 限流 / 无 Release 一律安静失败，绝不打断使用。
 */
import * as vscode from "vscode";
import * as https from "https";
import { info, warn } from "./log";

export const GITHUB_OWNER = "yourhoneypomelo-cell";
export const GITHUB_REPO = "API4Kiro";
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

/** "v4.13.51" / "4.13.51-beta.2" → [4,13,51,...]；非数字段按 0，用于逐段比较。 */
export function parseVersion(v: string): number[] {
  return String(v)
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** a 比 b 新 → 1；相等 → 0；旧 → -1。逐段比较，缺段补 0（4.13 == 4.13.0）。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

interface LatestRelease {
  tag: string;
  htmlUrl: string;
  name?: string;
}

/** GET 最新 Release；任何非 200 / 解析失败 / 网络错误都解析为 null（不抛）。 */
function fetchLatestRelease(timeoutMs = 8000): Promise<LatestRelease | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: LatestRelease | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
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
            const j = JSON.parse(body) as { tag_name?: string; html_url?: string; name?: string };
            if (j && typeof j.tag_name === "string" && j.tag_name) {
              done({ tag: j.tag_name, htmlUrl: j.html_url || GITHUB_RELEASES_URL, name: j.name });
            } else {
              done(null);
            }
          } catch {
            done(null);
          }
        });
      }
    );
    req.on("error", () => done(null));
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.end();
  });
}

const LAST_NOTIFIED_KEY = "api4kiro.updateNotifiedTag";
const LAST_CHECK_KEY = "api4kiro.updateLastCheckMs";
const CHECK_INTERVAL_MS = 24 * 3600_000;

export interface CheckOptions {
  /** true=用户手动点「检查更新」：总是查、总是给结果；false=启动静默查：24h 一次、同版本不重复弹。 */
  manual: boolean;
  /** 手动查时用面板 toast 反馈「已是最新 / 失败」；不传则回退到通知。 */
  toast?: (kind: "ok" | "error", msg: string) => void;
}

/** 检查 GitHub 最新 Release 并按需提示。异步、非阻塞、失败静默（手动查才反馈失败）。 */
export async function checkForUpdate(context: vscode.ExtensionContext, opts: CheckOptions): Promise<void> {
  const current = String(context.extension.packageJSON.version || "0.0.0");
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
  const cmp = compareVersions(rel.tag, current);
  info(`update check: latest ${rel.tag} vs current v${current} → ${cmp > 0 ? "newer" : cmp < 0 ? "older" : "same"}`);
  if (cmp > 0) {
    // 静默模式：同一个新版本只弹一次
    if (!opts.manual && context.globalState.get<string>(LAST_NOTIFIED_KEY) === rel.tag) return;
    if (!opts.manual) void context.globalState.update(LAST_NOTIFIED_KEY, rel.tag);
    const pick = await vscode.window.showInformationMessage(
      `API4Kiro 有新版本 ${rel.tag}（当前 v${current}）。到 GitHub Release 页下载最新 .vsix 安装。`,
      "打开 Release 页",
      "稍后"
    );
    if (pick === "打开 Release 页") void vscode.env.openExternal(vscode.Uri.parse(rel.htmlUrl));
  } else if (opts.manual) {
    opts.toast?.("ok", `已是最新版本 v${current}`);
  }
}
