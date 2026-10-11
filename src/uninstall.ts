/**
 * 卸载清理入口（`vscode:uninstall` 钩子）：由 esbuild 打包为 `dist/uninstall.js`，
 * 在扩展宿主**之外**由 VS Code 以 `node ./dist/uninstall.js` 调用。
 *
 * 做两件事，顺序固定「**先 settings、后文件**」：
 *  1. 清掉本插件写进 Kiro `settings.json` 的三个 codewhisperer 端点（文本级 JSONC 编辑，保留注释 / 尾逗号）；
 *  2. 复用 `selectorStyle.syncGroupHeaderStyle(false)` 还原被本插件打过补丁的 Kiro 文件
 *     —— 与用户点「关闭代理」**逐字同一条代码路径**，不另写第二套还原实现。
 *
 * 为什么先 settings：这一步极快，即使文件还原被钩子超时截断，端点也已经不再指向死端口。
 * 退出码**永远 0**：VS Code 会忽略卸载钩子的失败，非零码只会让日志里出现无意义的报错。
 *
 * 边界：
 *  - 绝不修改真实 Kiro 之外的任何东西；`A2K_KIRO_APP_ROOT` / `A2K_KIRO_SETTINGS` 覆盖值同样要过校验
 *    （前者必须含 `extensions/kiro.kiro-agent`，后者必须是**文件**且是绝对路径），不合格就跳过该项；
 *  - 只删「每一项都指向本插件端口」的端点值，混有别的端点 / 指向 19800、19801 / https 中转一律保留；
 *  - 检测到 kiro-proxy 的残留只做报告：还原路径（enabled=false）本来就不会碰别人的字节。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { endpointListPointsAt } from "./endpointOwnership";
import { parsesAsObject, readTopLevel, removeTopLevelProperty } from "./jsoncEdit";
import { setHostAppRoot } from "./hostlessVscode";
import { syncGroupHeaderStyle } from "./selectorStyle";

/** 本插件默认端口（package.json 的默认值），与 api2kiroDual.port / cpsPort 一起构成端口集合。 */
const DEFAULT_PORTS = [19810, 19811];
/** 单文件读取上限：超过就跳过并记一行（防御性，正常 style.css 约 600 KB）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** settings.json 里的三个端点键（与 src/endpoints.ts 的 EndpointKey 一致）。 */
const ENDPOINT_KEYS = ["endpoints", "krsEndpoints", "cpsEndpoints"] as const;
const CW_CONFIG = "codewhisperer.config";
const NS = "api2kiroDual";

export type ResolveOutcome<T> = { value: T; detail?: string } | { value: undefined; detail: string };

/** 平台：只认 process.platform 的三种取值。 */
export type Platform = string;

function isAbsolutePath(p: string): boolean {
  return !!p && path.isAbsolute(p);
}

/**
 * 判定「这个目录是不是 Kiro 的 appRoot」：必须含 `extensions/kiro.kiro-agent`。
 * 显式覆盖值也要过这一关——否则环境变量就能把清理指向任意目录。
 */
function looksLikeKiroAppRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "extensions", "kiro.kiro-agent")).isDirectory();
  } catch {
    return false;
  }
}

/** 某个候选 appRoot：合格（含 kiro.kiro-agent）才算找到，否则返回 undefined。 */
function acceptAppRoot(dir: string): string | undefined {
  if (!dir || !isAbsolutePath(dir) || !looksLikeKiroAppRoot(dir)) {
    return undefined;
  }
  return dir;
}

/** 从 `process.execPath` 推导 appRoot 的候选（macOS / Windows / Linux 三种布局 + 逐级上溯）。 */
function appRootFromExecPath(execPath: string): string[] {
  if (!execPath) {
    return [];
  }
  const out: string[] = [];
  // macOS：…/Kiro.app/Contents/MacOS/Kiro → …/Kiro.app/Contents/Resources/app
  const mac = /^(.*\.app)\/Contents\/MacOS\//.exec(execPath);
  if (mac) {
    out.push(path.join(mac[1], "Contents/Resources/app"));
  }
  // Windows：…\Kiro\Kiro.exe → …\Kiro\resources\app
  const win = /^(.*)[\\/][^\\/]+\.exe$/i.exec(execPath);
  if (win) {
    out.push(path.join(win[1], "resources/app"));
  }
  // Linux：…/kiro/kiro → …/resources/app
  out.push(path.join(path.dirname(execPath), "resources/app"));
  // 最后一个候选：逐级上溯，取第一个含 extensions/kiro.kiro-agent 的目录（非常规布局）
  let cur = path.dirname(execPath);
  for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i++) {
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out;
}

/** 平台常见安装路径。 */
function appRootFromPlatform(platform: Platform, home: string): string[] {
  if (platform === "darwin") {
    return ["/Applications/Kiro.app/Contents/Resources/app", path.join(home, "Applications/Kiro.app/Contents/Resources/app")];
  }
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    return [path.join(local, "Programs/Kiro/resources/app"), path.join(pf, "Kiro/resources/app")];
  }
  return ["/usr/share/kiro/resources/app", "/opt/Kiro/resources/app"];
}

/**
 * 解析 appRoot：覆盖优先（但要过校验），否则 execPath 推导 → 平台常见路径。
 * 解析不到返回 `value: undefined` + 一句中文说明（调用方跳过文件还原、照常走 settings 那一步）。
 */
export function resolveAppRoot(opts?: { env?: NodeJS.ProcessEnv; platform?: Platform; execPath?: string; home?: string }): ResolveOutcome<string> {
  const env = opts?.env || process.env;
  const platform = opts?.platform || process.platform;
  const home = opts?.home || os.homedir();
  const override = (env.A2K_KIRO_APP_ROOT || "").trim();
  if (override) {
    if (!isAbsolutePath(override)) {
      return { value: undefined, detail: `A2K_KIRO_APP_ROOT 不是绝对路径，已跳过：${override}` };
    }
    const ok = acceptAppRoot(override);
    return ok
      ? { value: ok, detail: `A2K_KIRO_APP_ROOT 覆盖：${ok}` }
      : { value: undefined, detail: `A2K_KIRO_APP_ROOT 指向的目录不是 Kiro 安装（缺少 extensions/kiro.kiro-agent），已跳过：${override}` };
  }
  const candidates = [...appRootFromExecPath(opts?.execPath || process.execPath), ...appRootFromPlatform(platform, home)];
  for (const c of candidates) {
    const ok = acceptAppRoot(c);
    if (ok) {
      return { value: ok, detail: `推断到 Kiro 安装：${ok}` };
    }
  }
  return { value: undefined, detail: "没有找到 Kiro 安装目录（可用 A2K_KIRO_APP_ROOT 显式指定）" };
}

/** settings.json 的平台默认位置。 */
export function defaultSettingsPath(platform: Platform, home: string): string {
  if (platform === "darwin") {
    return path.join(home, "Library/Application Support/Kiro/User/settings.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData/Roaming");
    return path.join(appData, "Kiro/User/settings.json");
  }
  return path.join(home, ".config/Kiro/User/settings.json");
}

/** 解析 settings.json：覆盖优先（必须是绝对路径 + 是文件），否则平台默认（存在才算）。 */
export function resolveSettingsPath(opts?: { env?: NodeJS.ProcessEnv; platform?: Platform; home?: string }): ResolveOutcome<string> {
  const env = opts?.env || process.env;
  const platform = opts?.platform || process.platform;
  const home = opts?.home || os.homedir();
  const override = (env.A2K_KIRO_SETTINGS || "").trim();
  if (override) {
    if (!isAbsolutePath(override)) {
      return { value: undefined, detail: `A2K_KIRO_SETTINGS 不是绝对路径，已跳过：${override}` };
    }
    try {
      if (!fs.statSync(override).isFile()) {
        return { value: undefined, detail: `A2K_KIRO_SETTINGS 不是文件，已跳过：${override}` };
      }
    } catch {
      return { value: undefined, detail: `A2K_KIRO_SETTINGS 指向的文件不存在，已跳过：${override}` };
    }
    return { value: override, detail: `A2K_KIRO_SETTINGS 覆盖：${override}` };
  }
  const def = defaultSettingsPath(platform, home);
  return fs.existsSync(def) ? { value: def, detail: `平台默认：${def}` } : { value: undefined, detail: `没有找到 Kiro 设置文件：${def}` };
}

/** 同一份 settings 里 `api2kiroDual.port` / `cpsPort` 的合法正整数（1–65535）。 */
function configuredPorts(doc: string): number[] {
  const out: number[] = [];
  for (const key of ["port", "cpsPort"]) {
    const v = readTopLevel(doc, `${NS}.${key}`);
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 65535) {
      out.push(n);
    }
  }
  return out;
}

export interface EndpointCleanupResult {
  /** 删掉的本插件端点键。 */
  removed: string[];
  /** 值不属于本插件、原样保留的键。 */
  notOurs: string[];
  /** 文本解析失败，整份文件原样保留。 */
  parseFailed: boolean;
  /** 文件不存在 / 读不到 / 太大。 */
  readFailed?: string;
}

/**
 * 清掉 settings.json 里指向本插件端点的三个键（**文本级**编辑，保留注释与格式）。
 *
 * - 端口集合 = {19810, 19811} ∪ 同一份 settings 里 `api2kiroDual.port` / `cpsPort`；
 * - 只有「非空数组且每一项都指向端口集合」才删（`endpointListPointsAt`，与原版 19800/19801 区分开）；
 * - 写之前逐键自校验，失败就回滚为原文；
 * - 有变更才写，走临时文件 + 原子改名（避免写到一半被中断留下半个 settings.json）。
 */
export function cleanupEndpoints(settingsPath: string, opts?: { dryRun?: boolean }): EndpointCleanupResult {
  const result: EndpointCleanupResult = { removed: [], notOurs: [], parseFailed: false };
  if (!settingsPath) {
    result.readFailed = "未提供 settings.json 路径";
    return result;
  }
  let original: string;
  try {
    const st = fs.statSync(settingsPath);
    if (st.size > MAX_FILE_BYTES) {
      result.readFailed = `文件超过 ${MAX_FILE_BYTES} 字节`;
      return result;
    }
    original = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    result.readFailed = (e as Error)?.message || String(e);
    return result;
  }
  const trimmed = original.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return result;
  }
  // 解析失败（不是合法的 JSONC 对象）：不动文件——把整份 settings 覆盖成空对象是灾难。
  // 判据走 jsoncEdit 的解析器（它容忍文件开头的行 / 块注释），不能只看首个非空白字符是不是 `{`：
  // 那样会把「开头有一行注释」的正常 settings.json 判成解析失败，端点清理静默失效。
  if (!parsesAsObject(original)) {
    result.parseFailed = true;
    return result;
  }
  const ports = [...DEFAULT_PORTS, ...configuredPorts(original)];
  let text = original;
  for (const short of ENDPOINT_KEYS) {
    const key = `${CW_CONFIG}.${short}`;
    const value = readTopLevel(text, key);
    if (value === undefined) {
      // 键不在（或整份文本已解析不出来）时都要如实区分：解析失败不能当成「无需清理」
      continue;
    }
    if (!endpointListPointsAt(value, ports)) {
      result.notOurs.push(key);
      continue;
    }
    const r = removeTopLevelProperty(text, key);
    if (r.removed && readTopLevel(r.text, key) === undefined) {
      text = r.text;
      result.removed.push(key);
    } else {
      console.log(`[API4Kiro 卸载] 删除 ${key} 后自校验失败，已回滚（settings.json 保持不变）`);
      result.parseFailed = true;
      result.removed = [];
      return result;
    }
  }
  if (result.removed.length === 0 || opts?.dryRun) {
    return result;
  }
  try {
    const tmp = `${settingsPath}.api4kiro-uninstall.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    result.readFailed = (e as Error)?.message || String(e);
    console.log(`[API4Kiro 卸载] 写回 settings.json 失败，原文件保持不变：${result.readFailed}`);
    result.removed = [];
  }
  return result;
}

export interface RestoreResult {
  status: string;
  targets: Record<string, string>;
  extras: Record<string, string>;
  detail?: string;
  /** 只读检测：目标文件里是否还有 kiro-proxy 的残留（还原路径不碰它们的字节）。 */
  kiroProxyResidue: string[];
}

/** 检测目标文件里的 kiro-proxy 残留（只报告，不处理 —— 那不是本扩展注入的字节）。 */
function detectKiroProxyResidue(appRoot: string): string[] {
  const ext = path.join(appRoot, "extensions/kiro.kiro-agent");
  const files: string[] = [path.join(ext, "dist/extension.js")];
  const pkgs = path.join(ext, "packages");
  try {
    for (const pkg of fs.readdirSync(pkgs)) {
      const dist = path.join(pkgs, pkg, "dist");
      files.push(path.join(dist, "style.css"));
      const assets = path.join(dist, "assets");
      if (!fs.existsSync(assets)) {
        continue;
      }
      for (const f of fs.readdirSync(assets)) {
        if (f.startsWith("mermaid-") && f.endsWith(".js")) {
          files.push(path.join(assets, f));
        }
      }
    }
  } catch {
    /* 目录不存在就只查 dist/extension.js */
  }
  const hits: string[] = [];
  for (const f of files) {
    try {
      if (fs.statSync(f).size > MAX_FILE_BYTES) {
        continue;
      }
      if (fs.readFileSync(f, "utf8").includes("kiroproxy-")) {
        hits.push(f);
      }
    } catch {
      /* 读不到就跳过 */
    }
  }
  return hits;
}

/**
 * 还原被本扩展打过补丁的 Kiro 文件：与用户点「关闭代理」**逐字同一条代码路径**。
 * 通过 `setHostAppRoot` 把探测到的 appRoot 注入宿主桩（`vscode.env.appRoot` 的取值来源）。
 */
export async function restoreKiroFiles(appRoot: string): Promise<RestoreResult> {
  setHostAppRoot(appRoot);
  const residue = detectKiroProxyResidue(appRoot);
  const r = await syncGroupHeaderStyle(false);
  return {
    status: r.status,
    targets: r.targets as unknown as Record<string, string>,
    extras: r.extras as unknown as Record<string, string>,
    detail: r.detail,
    kiroProxyResidue: residue,
  };
}

/** 打印一行中文摘要。 */
function reportEndpoints(r: EndpointCleanupResult, settings: ResolveOutcome<string>): void {
  if (!settings.value) {
    console.log(`[API4Kiro 卸载] 跳过端点清理：${settings.detail}`);
    return;
  }
  if (r.readFailed) {
    console.log(`[API4Kiro 卸载] 跳过端点清理（读不到文件）：${settings.value} —— ${r.readFailed}`);
    return;
  }
  if (r.parseFailed) {
    console.log(`[API4Kiro 卸载] settings.json 解析失败，整份文件原样保留：${settings.value}`);
    return;
  }
  if (r.removed.length === 0 && r.notOurs.length === 0) {
    console.log(`[API4Kiro 卸载] settings.json 无需清理（没有本插件写入的端点）：${settings.value}`);
    return;
  }
  console.log(
    `[API4Kiro 卸载] settings.json：已清理 ${r.removed.length} 个端点键` +
      (r.removed.length ? `（${r.removed.join(", ")}）` : "") +
      (r.notOurs.length ? `；保留 ${r.notOurs.length} 个非本插件写入的键（${r.notOurs.join(", ")}）` : "")
  );
}

/** 主流程：顶层 try/catch，任何异常只打印 + 退出码 0。 */
export async function main(): Promise<void> {
  console.log("[API4Kiro 卸载] 开始清理本扩展写入的 Kiro 端点与文件补丁");
  // ① 先 settings（极快；即使第 ② 步被钩子超时截断，端点也已经不再指向死端口）
  try {
    const settings = resolveSettingsPath();
    const r = cleanupEndpoints(settings.value || "");
    reportEndpoints(r, settings);
  } catch (e) {
    console.log(`[API4Kiro 卸载] 端点清理出错（已忽略，不影响其它步骤）：${(e as Error)?.message || String(e)}`);
  }
  // ② 后文件
  try {
    const appRoot = resolveAppRoot();
    if (!appRoot.value) {
      console.log(`[API4Kiro 卸载] 跳过 Kiro 文件还原：${appRoot.detail}`);
    } else {
      const r = await restoreKiroFiles(appRoot.value);
      console.log(
        `[API4Kiro 卸载] Kiro 文件还原：status=${r.status} ` +
          `style=${r.targets.style} selectorScript=${r.targets.selectorScript} backend=${r.targets.backend}` +
          (r.detail ? ` detail=${r.detail}` : "")
      );
      if (r.kiroProxyResidue.length > 0) {
        console.log(
          `[API4Kiro 卸载] 注意：${r.kiroProxyResidue.length} 个文件里还有 kiro-proxy 的补丁残留（kiroproxy-…），` +
            `本脚本只删自己注入的段、不会碰别人的字节；如需出厂态请在 kiro-proxy 一侧还原，或重装 / 更新 Kiro。`
        );
      }
    }
  } catch (e) {
    console.log(`[API4Kiro 卸载] Kiro 文件还原出错（已忽略）：${(e as Error)?.message || String(e)}`);
  }
  console.log("[API4Kiro 卸载] 完成（下一个 Kiro 窗口启动时端点与外观都会回到官方原生）");
}

// 只在被直接执行时跑（tests/uninstall.test.js 会 require 本模块拿纯函数）
if (require.main === module) {
  void main()
    .catch((e) => {
      console.log(`[API4Kiro 卸载] 未预期的错误（已忽略）：${(e as Error)?.message || String(e)}`);
    })
    .then(() => {
      // 退出码恒 0：VS Code 会忽略卸载钩子的失败，非零码只会制造无意义的报错日志。
      process.exitCode = 0;
    });
}
