/**
 * Kiro MCP 配置直管：读写 Kiro 自己的 `mcp.json`（用户级 `~/.kiro/settings/mcp.json`、工作区级
 * `<workspaceFolder>/.kiro/settings/mcp.json`），不另存副本。Kiro（1.0.437 副本核实）用 comment-json 解析这两份文件、
 * 用 chokidar 监视并在 300 ms 防抖后重连有变化的服务器，所以这里只管把文件写对，不调 Kiro 命令。
 *
 * 读：去 BOM → 字符串感知地去掉 `//` / `/* *\/` 注释与尾逗号 → `JSON.parse`；解析失败只报错、不写、不清空。
 * 写：写前重读 → 对象层面改（未知键与键序原样保留）→ `JSON.stringify(doc, null, 2) + "\n"`（与 Kiro 自己
 * `stringify(obj, null, 2)` 的规范化同形）→ 每文件每会话首次写前备份 `<file>.api4kiro.bak` → 临时文件 + rename
 * （失败重试四次，绝不退化为直接覆写）。注释无法保留：读到注释时 `hasComments=true`，面板据此提示。
 *
 * `env` / `headers` 的值不进日志；列表接口只给键名，完整值只在 `getServer`（打开编辑弹窗）返回。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { info, warn } from "./log";

export type McpScope = "user" | "workspace";
export type McpTransport = "stdio" | "http" | "invalid";

/** 一台服务器的配置；Kiro 认识的键之外的一律原样保留（`[key: string]: unknown`）。 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  disabled?: boolean;
  autoApprove?: string[];
  disabledTools?: string[];
  [key: string]: unknown;
}

/** 列表行：不带 `env` / `headers` 的值。 */
export interface McpServerRow {
  name: string;
  transport: McpTransport;
  /** stdio：command + args；http：url。单行摘要，webview 截断显示、悬停全文。 */
  summary: string;
  disabled: boolean;
  autoApprove: string[];
  disabledTools: string[];
  envKeys: string[];
  headerKeys: string[];
  timeout?: number;
  cwd?: string;
}

export interface McpFileInfo {
  scope: McpScope;
  path?: string;
  exists: boolean;
  hasComments: boolean;
  /** 文件存在但读不出 / 不是对象 / `mcpServers` 不是对象时的原因；此时 `servers` 为空且任何写操作都会拒绝。 */
  error?: string;
  servers: McpServerRow[];
}

export interface McpPathOptions {
  /** 测试注入；默认 `os.homedir()`。 */
  homeDir?: string;
  /** 第 0 个工作区文件夹；无工作区时为 undefined。 */
  workspaceDir?: string;
}

export class McpConfigError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

export const MCP_FILE = "mcp.json";
export const MCP_BACKUP_SUFFIX = ".api4kiro.bak";

/** Kiro 1.0.437（kiroAgent 1.0.794）注册的相关命令与设置键（只读副本核实）。 */
export const KIRO_MCP = {
  openUserConfig: "kiroAgent.openUserMcpConfig",
  openWorkspaceConfig: "kiroAgent.openWorkspaceMcpConfig",
  enable: "kiroAgent.mcp.enable",
  showLogs: "kiroAgent.mcp.showLogs",
  reconnectServer: "kiroAgent.mcp.reconnectServer",
  /** `kiroAgent.configureMCP` 默认 "Disabled"；为 "Enabled" 时 Kiro 才启动 MCP 服务器。 */
  configureSetting: "configureMCP",
} as const;

// ---------------------------------------------------------------- 路径

export function mcpConfigPath(scope: McpScope, opts: McpPathOptions = {}): string | undefined {
  if (scope === "user") {
    return path.join(opts.homeDir ?? os.homedir(), ".kiro", "settings", MCP_FILE);
  }
  const ws = (opts.workspaceDir ?? "").trim();
  return ws ? path.join(ws, ".kiro", "settings", MCP_FILE) : undefined;
}

// ---------------------------------------------------------------- JSONC 容错解析

export interface JsoncResult {
  value: unknown;
  hadComments: boolean;
  hadTrailingCommas: boolean;
}

/**
 * 去掉注释与尾逗号后 `JSON.parse`。字符串内的 `//`（如 `https://`）与转义引号不受影响。
 * 与 Kiro 用的 comment-json 同一容忍面：行 / 块注释、`}` `]` 前的尾逗号；不支持单引号 / 裸键。
 * 空白文件视为 `{}`。语法错误抛 SyntaxError。
 */
export function parseJsonc(text: string): JsoncResult {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let hadComments = false;
  let hadTrailingCommas = false;
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  let inStr = false;
  while (i < n) {
    const ch = src[i];
    if (inStr) {
      out.push(ch);
      if (ch === "\\" && i + 1 < n) {
        out.push(src[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '"') {
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      hadComments = true;
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      hadComments = true;
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === ",") {
      // 向前看：只隔着空白就碰到 } 或 ] → 尾逗号，丢弃
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) {
        j++;
      }
      if (j < n && (src[j] === "}" || src[j] === "]")) {
        hadTrailingCommas = true;
        i++;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  src = out.join("");
  if (src.trim() === "") {
    return { value: {}, hadComments, hadTrailingCommas };
  }
  return { value: JSON.parse(src), hadComments, hadTrailingCommas };
}

// ---------------------------------------------------------------- 文件读写

type Doc = Record<string, unknown>;

interface ReadResult {
  exists: boolean;
  doc: Doc;
  hadComments: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 读一份 mcp.json 成对象。不存在 → `{ exists:false, doc:{} }`；存在但不合法 → 抛 McpConfigError（调用方不得写）。 */
export function readMcpDoc(file: string): ReadResult {
  if (!fs.existsSync(file)) {
    return { exists: false, doc: {}, hadComments: false };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new McpConfigError(`读取失败：${(e as Error).message}`, "EREAD");
  }
  let parsed: JsoncResult;
  try {
    parsed = parseJsonc(text);
  } catch (e) {
    throw new McpConfigError(`不是合法的 JSON：${(e as Error).message}`, "EJSON");
  }
  if (!isObj(parsed.value)) {
    throw new McpConfigError("顶层不是 JSON 对象", "ESHAPE");
  }
  if ("mcpServers" in parsed.value && !isObj(parsed.value.mcpServers)) {
    throw new McpConfigError("`mcpServers` 不是对象", "ESHAPE");
  }
  return { exists: true, doc: parsed.value, hadComments: parsed.hadComments };
}

export function serializeMcpDoc(doc: Doc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

const backedUp = new Set<string>();

/** 每文件每会话首次写前复制一份 `<file>.api4kiro.bak`；文件不存在时不备份。 */
function backupOnce(file: string): string | undefined {
  if (backedUp.has(file) || !fs.existsSync(file)) {
    return undefined;
  }
  const bak = file + MCP_BACKUP_SUFFIX;
  fs.copyFileSync(file, bak);
  backedUp.add(file);
  return bak;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 临时文件 + rename（同 `selectorStyle.ts` 的 `writeAtomic` 形状）：rename 在 Windows 上可能被杀软 / 索引器短暂占用，
 * 重试四次；仍失败就清掉临时文件并抛错，绝不退化为直接覆写。
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.api4kiro-${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, "utf8");
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (e) {
        lastErr = e;
        await sleep(20 * (attempt + 1));
      }
    }
    throw lastErr;
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

async function writeMcpDoc(file: string, doc: Doc): Promise<void> {
  const bak = backupOnce(file);
  await writeAtomic(file, serializeMcpDoc(doc));
  if (bak) {
    info("mcp: backup written", { file: bak });
  }
}

function serversOf(doc: Doc): Record<string, unknown> {
  if (!isObj(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  return doc.mcpServers as Record<string, unknown>;
}

function resolveFile(scope: McpScope, opts: McpPathOptions): string {
  const file = mcpConfigPath(scope, opts);
  if (!file) {
    throw new McpConfigError("当前没有打开工作区文件夹，没有工作区级 mcp.json", "ENOWS");
  }
  return file;
}

// ---------------------------------------------------------------- 只读列表

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const keysOf = (v: unknown): string[] => (isObj(v) ? Object.keys(v) : []);

export function transportOf(cfg: McpServerConfig): McpTransport {
  // 与 Kiro `rlt` 同序：有 command 即 stdio（即使同时有 url），否则有 url 即 http
  if (typeof cfg.command === "string" && cfg.command.trim()) {
    return "stdio";
  }
  if (typeof cfg.url === "string" && cfg.url.trim()) {
    return "http";
  }
  return "invalid";
}

export function summaryOf(cfg: McpServerConfig): string {
  const t = transportOf(cfg);
  if (t === "stdio") {
    return [cfg.command!.trim(), ...strList(cfg.args)].join(" ").trim();
  }
  if (t === "http") {
    return cfg.url!.trim();
  }
  return "";
}

export function toRow(name: string, raw: unknown): McpServerRow {
  const cfg: McpServerConfig = isObj(raw) ? (raw as McpServerConfig) : {};
  return {
    name,
    transport: transportOf(cfg),
    summary: summaryOf(cfg),
    disabled: cfg.disabled === true,
    autoApprove: strList(cfg.autoApprove),
    disabledTools: strList(cfg.disabledTools),
    envKeys: keysOf(cfg.env),
    headerKeys: keysOf(cfg.headers),
    timeout: typeof cfg.timeout === "number" ? cfg.timeout : undefined,
    cwd: typeof cfg.cwd === "string" && cfg.cwd ? cfg.cwd : undefined,
  };
}

/** 列出一个作用域的服务器（不含 env / headers 值）。读失败不抛，放进 `error`。 */
export function listServers(scope: McpScope, opts: McpPathOptions = {}): McpFileInfo {
  const file = mcpConfigPath(scope, opts);
  if (!file) {
    return { scope, path: undefined, exists: false, hasComments: false, servers: [], error: "当前没有打开工作区文件夹" };
  }
  try {
    const r = readMcpDoc(file);
    const servers = isObj(r.doc.mcpServers) ? Object.entries(r.doc.mcpServers).map(([n, v]) => toRow(n, v)) : [];
    return { scope, path: file, exists: r.exists, hasComments: r.hadComments, servers };
  } catch (e) {
    return { scope, path: file, exists: true, hasComments: false, servers: [], error: (e as Error).message };
  }
}

/** 取一台服务器的完整配置（含 env / headers 明文）——只在打开编辑弹窗时调用。 */
export function getServer(scope: McpScope, name: string, opts: McpPathOptions = {}): McpServerConfig | undefined {
  const file = mcpConfigPath(scope, opts);
  if (!file) {
    return undefined;
  }
  const r = readMcpDoc(file);
  const raw = isObj(r.doc.mcpServers) ? r.doc.mcpServers[name] : undefined;
  return isObj(raw) ? ({ ...raw } as McpServerConfig) : undefined;
}

// ---------------------------------------------------------------- 校验

/** 与 Kiro `isHttpsOrLocalhost` 同口径：https，或 localhost / 127.0.0.1 / ::1 的任意协议。 */
export function isHttpsOrLocalhost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") {
      return true;
    }
    const h = u.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export interface ValidateOptions {
  /** 同作用域已有的服务器名 */
  existingNames?: Iterable<string>;
  /** 编辑时的原名（重名检查时排除自己） */
  originalName?: string;
}

/** 表单 / 导入共用校验，返回可直接显示的错误句；空数组即通过。与 Kiro `deepValidateMCPServerOptions` 同口径再加表单规则。 */
export function validateServer(name: string, cfg: McpServerConfig, o: ValidateOptions = {}): string[] {
  const errs: string[] = [];
  const nm = name.trim();
  if (!nm) {
    errs.push("名称不能为空");
  } else if (nm !== name) {
    errs.push("名称首尾不能有空白");
  }
  const taken = new Set(o.existingNames ?? []);
  if (o.originalName) {
    taken.delete(o.originalName);
  }
  if (nm && taken.has(nm)) {
    errs.push(`已有同名服务器「${nm}」`);
  }
  const t = transportOf(cfg);
  if (t === "invalid") {
    errs.push("必须填写 command（本地 stdio）或 url（远程 HTTP）之一");
  }
  if (t === "http") {
    const url = cfg.url!.trim();
    let ok = false;
    try {
      new URL(url);
      ok = true;
    } catch {
      errs.push(`URL 不合法：${url}`);
    }
    if (ok && !isHttpsOrLocalhost(url)) {
      errs.push("远程服务器必须是 https，或 localhost / 127.0.0.1 的 http（Kiro 会忽略其它地址）");
    }
  }
  if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || !Number.isFinite(cfg.timeout) || cfg.timeout <= 0 || Math.floor(cfg.timeout) !== cfg.timeout)) {
    errs.push("timeout 必须是正整数（毫秒）");
  }
  for (const [label, rec] of [["env", cfg.env], ["headers", cfg.headers]] as const) {
    if (rec === undefined) {
      continue;
    }
    if (!isObj(rec)) {
      errs.push(`${label} 必须是对象`);
      continue;
    }
    for (const [k, v] of Object.entries(rec)) {
      if (!k.trim()) {
        errs.push(`${label} 里有空的键名`);
      }
      if (typeof v !== "string") {
        errs.push(`${label}.${k} 的值必须是字符串`);
      }
    }
  }
  if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
    errs.push("args 必须是数组");
  }
  for (const k of ["autoApprove", "disabledTools"] as const) {
    const v = cfg[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
      errs.push(`${k} 必须是字符串数组`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------- 写操作

export interface UpsertOptions extends McpPathOptions {
  /** 改名：把 `originalName` 这一项在原位置换成 `name` */
  originalName?: string;
  /** true：整体替换该服务器对象；false（默认）：在现有对象上合并 patch，值为 null 的键删除，未知键保留 */
  replace?: boolean;
}

/** 按原键序把 `from` 换成 `to`（值为 value）；`from` 不存在则追加到末尾。 */
function setKeyInOrder(obj: Record<string, unknown>, from: string, to: string, value: unknown): void {
  if (!(from in obj)) {
    obj[to] = value;
    return;
  }
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) {
    delete obj[k];
  }
  for (const [k, v] of entries) {
    if (k === from) {
      obj[to] = value;
    } else if (k !== to) {
      obj[k] = v;
    }
  }
}

/** 新增或修改一台服务器（写前重读；未知键与键序保留）。返回写入后的完整配置。 */
export async function upsertServer(scope: McpScope, name: string, patch: Record<string, unknown>, o: UpsertOptions = {}): Promise<McpServerConfig> {
  const file = resolveFile(scope, o);
  const r = readMcpDoc(file);
  const servers = serversOf(r.doc);
  const from = o.originalName && o.originalName in servers ? o.originalName : name;
  const existing = isObj(servers[from]) ? (servers[from] as Record<string, unknown>) : {};
  let next: Record<string, unknown>;
  if (o.replace) {
    next = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== null && v !== undefined) {
        next[k] = v;
      }
    }
  } else {
    next = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
  }
  if (from !== name && name in servers) {
    throw new McpConfigError(`已有同名服务器「${name}」`, "EDUP");
  }
  setKeyInOrder(servers, from, name, next);
  await writeMcpDoc(file, r.doc);
  info("mcp: server saved", { scope, name, renamedFrom: from !== name ? from : undefined, transport: transportOf(next as McpServerConfig), bytes: serializeMcpDoc(r.doc).length });
  return next as McpServerConfig;
}

/** 文件不存在时写 Kiro 同款模板 `{ "mcpServers": {} }`（Kiro `ensureAndOpenMcpConfig` 同形）；返回路径。 */
export async function ensureMcpFile(scope: McpScope, o: McpPathOptions = {}): Promise<string> {
  const file = resolveFile(scope, o);
  if (!fs.existsSync(file)) {
    await writeMcpDoc(file, { mcpServers: {} });
    info("mcp: created empty config", { scope });
  }
  return file;
}

export async function deleteServer(scope: McpScope, name: string, o: McpPathOptions = {}): Promise<boolean> {
  const file = resolveFile(scope, o);
  const r = readMcpDoc(file);
  const servers = serversOf(r.doc);
  if (!(name in servers)) {
    return false;
  }
  delete servers[name];
  await writeMcpDoc(file, r.doc);
  info("mcp: server deleted", { scope, name });
  return true;
}

export async function setDisabled(scope: McpScope, name: string, disabled: boolean, o: McpPathOptions = {}): Promise<void> {
  const file = resolveFile(scope, o);
  const r = readMcpDoc(file);
  const servers = serversOf(r.doc);
  if (!isObj(servers[name])) {
    throw new McpConfigError(`没有名为「${name}」的服务器`, "ENOENT");
  }
  (servers[name] as Record<string, unknown>).disabled = disabled;
  await writeMcpDoc(file, r.doc);
  info("mcp: server toggled", { scope, name, disabled });
}

export async function setAutoApprove(scope: McpScope, name: string, tools: string[], o: McpPathOptions = {}): Promise<void> {
  const file = resolveFile(scope, o);
  const r = readMcpDoc(file);
  const servers = serversOf(r.doc);
  if (!isObj(servers[name])) {
    throw new McpConfigError(`没有名为「${name}」的服务器`, "ENOENT");
  }
  (servers[name] as Record<string, unknown>).autoApprove = [...tools];
  await writeMcpDoc(file, r.doc);
  info("mcp: autoApprove updated", { scope, name, count: tools.length });
}

// ---------------------------------------------------------------- 外部形状归一（粘贴 JSON / VS Code / cc-switch）

export interface NormalizedExternal {
  server: McpServerConfig;
  /** 源里有、Kiro 不认或语义不同、未带入的键 */
  unmapped: string[];
  /** 需要用户知道的兼容性备注 */
  note?: string;
}

const KIRO_KEYS = new Set(["command", "args", "env", "cwd", "url", "headers", "timeout", "disabled", "autoApprove", "disabledTools", "oauth", "oauthScopes", "type"]);

/**
 * 把 Claude Code / Codex / cc-switch / VS Code 形状的服务器对象归一成 Kiro 形状：
 * `type: stdio` → command / args / env；`type: http | sse | streamable-http` → url / headers；无 `type` 按 command / url 判。
 * Kiro 本身不看 `type` 字段（有 command 即 stdio），归一后不写 `type`。
 */
export function normalizeExternalServer(raw: unknown): NormalizedExternal | string {
  if (!isObj(raw)) {
    return "不是对象";
  }
  const src = raw as Record<string, unknown>;
  const type = typeof src.type === "string" ? src.type.toLowerCase() : "";
  const server: McpServerConfig = {};
  const unmapped: string[] = [];
  let note: string | undefined;
  const hasCmd = typeof src.command === "string" && src.command.trim() !== "";
  const hasUrl = typeof src.url === "string" && src.url.trim() !== "";
  const remote = type === "http" || type === "sse" || type === "streamable-http" || type === "streamable_http" || (!type && !hasCmd && hasUrl);
  if (remote) {
    if (!hasUrl) {
      return `type 为 ${type || "远程"} 却没有 url`;
    }
    server.url = (src.url as string).trim();
    if (isObj(src.headers)) {
      server.headers = Object.fromEntries(Object.entries(src.headers).map(([k, v]) => [k, String(v)]));
    }
    if (type === "sse") {
      note = "来源标为 SSE 传输；Kiro 按 HTTP 连接，可能不兼容";
    }
  } else {
    if (!hasCmd) {
      return "没有 command 也没有 url";
    }
    server.command = (src.command as string).trim();
    if (Array.isArray(src.args)) {
      server.args = src.args.map((a) => String(a));
    }
    if (isObj(src.env)) {
      server.env = Object.fromEntries(Object.entries(src.env).map(([k, v]) => [k, String(v)]));
    }
    if (typeof src.cwd === "string" && src.cwd) {
      server.cwd = src.cwd;
    }
  }
  if (typeof src.disabled === "boolean") {
    server.disabled = src.disabled;
  }
  for (const k of ["autoApprove", "disabledTools"] as const) {
    if (Array.isArray(src[k])) {
      server[k] = (src[k] as unknown[]).filter((x): x is string => typeof x === "string");
    }
  }
  if (typeof src.timeout === "number" && src.timeout > 0) {
    server.timeout = src.timeout;
  }
  for (const k of Object.keys(src)) {
    if (k === "type") {
      continue;
    }
    if (!KIRO_KEYS.has(k) || (remote && (k === "command" || k === "args" || k === "env" || k === "cwd")) || (!remote && (k === "url" || k === "headers"))) {
      unmapped.push(k);
    }
  }
  return { server, unmapped, note };
}

// ---------------------------------------------------------------- 粘贴 JSON 导入

export interface ImportOptions extends McpPathOptions {
  /** 粘贴的是单个服务器对象时的名字 */
  name?: string;
  /** 同名是否覆盖（默认 false → 记入 conflicts、不写） */
  overwrite?: boolean;
  /** false → 一律写成 disabled:true；true / undefined → 源里没写 disabled 的写 disabled:false */
  enable?: boolean;
}

export interface ImportResult {
  added: string[];
  overwritten: string[];
  conflicts: string[];
  skipped: Array<{ name: string; reason: string }>;
  notes: Array<{ name: string; note: string }>;
}

/** 解析粘贴文本，返回 `名字 → 原始对象` 的有序表。识别 `{mcpServers:{…}}`、VS Code `{servers:{…}}`、单个服务器对象（需 `name`）。 */
export function parseImportSnippet(text: string, name?: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseJsonc(text).value;
  } catch (e) {
    throw new McpConfigError(`不是合法的 JSON：${(e as Error).message}`, "EJSON");
  }
  if (!isObj(value)) {
    throw new McpConfigError("顶层不是 JSON 对象", "ESHAPE");
  }
  if (isObj(value.mcpServers)) {
    return value.mcpServers;
  }
  if (isObj(value.servers)) {
    return value.servers;
  }
  if ("command" in value || "url" in value) {
    const nm = (name ?? "").trim();
    if (!nm) {
      throw new McpConfigError("粘贴的是单个服务器对象，需要填写名称", "ENAME");
    }
    return { [nm]: value };
  }
  throw new McpConfigError("无法识别：需要 {\"mcpServers\":{…}}、{\"servers\":{…}} 或单个服务器对象", "ESHAPE");
}

export async function importSnippet(scope: McpScope, text: string, o: ImportOptions = {}): Promise<ImportResult> {
  const entries = parseImportSnippet(text, o.name);
  return importServers(scope, entries, o);
}

/** 把「名字 → 外部形状对象」批量写入（归一 + 校验 + 冲突处理），一次写盘。 */
export async function importServers(scope: McpScope, entries: Record<string, unknown>, o: ImportOptions = {}): Promise<ImportResult> {
  const file = resolveFile(scope, o);
  const res: ImportResult = { added: [], overwritten: [], conflicts: [], skipped: [], notes: [] };
  const r = readMcpDoc(file);
  const servers = serversOf(r.doc);
  let changed = false;
  for (const [rawName, raw] of Object.entries(entries)) {
    const name = rawName.trim();
    if (!name) {
      res.skipped.push({ name: rawName, reason: "名称为空" });
      continue;
    }
    const norm = normalizeExternalServer(raw);
    if (typeof norm === "string") {
      res.skipped.push({ name, reason: norm });
      continue;
    }
    const cfg = norm.server;
    if (o.enable === false) {
      cfg.disabled = true;
    } else if (cfg.disabled === undefined) {
      cfg.disabled = false;
    }
    const errs = validateServer(name, cfg, {});
    if (errs.length) {
      res.skipped.push({ name, reason: errs.join("；") });
      continue;
    }
    if (norm.note) {
      res.notes.push({ name, note: norm.note });
    }
    if (name in servers) {
      if (!o.overwrite) {
        res.conflicts.push(name);
        continue;
      }
      res.overwritten.push(name);
    } else {
      res.added.push(name);
    }
    servers[name] = cfg;
    changed = true;
  }
  if (changed) {
    await writeMcpDoc(file, r.doc);
    info("mcp: imported", { scope, added: res.added.length, overwritten: res.overwritten.length, conflicts: res.conflicts.length, skipped: res.skipped.length });
  }
  return res;
}

// ---------------------------------------------------------------- cc-switch 只读扫描

export interface CcSwitchMcpCandidate {
  id: string;
  name: string;
  transport: McpTransport;
  summary: string;
  /** 完整配置（含 env / headers 明文）——只留在扩展侧，发给 webview 前去掉值 */
  server: McpServerConfig;
  envKeys: string[];
  headerKeys: string[];
  unmapped: string[];
  note?: string;
  /** 目标作用域里已有同名 */
  exists: boolean;
}

export interface CcSwitchMcpScan {
  path?: string;
  candidates: CcSwitchMcpCandidate[];
  skipped: Array<{ name: string; reason: string }>;
}

/** cc-switch `mcp_servers` 表的一行 → 候选。`server_config` 是 Claude Code 形状的 JSON 文本。纯函数，便于测试。 */
export function ccSwitchRowToCandidate(row: Record<string, unknown>, existingNames: Set<string>): CcSwitchMcpCandidate | { name: string; reason: string } {
  const name = String(row.name ?? row.id ?? "").trim();
  if (!name) {
    return { name: "(未命名)", reason: "没有名字" };
  }
  let raw: unknown = row.server_config;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { name, reason: "server_config 不是合法 JSON" };
    }
  }
  const norm = normalizeExternalServer(raw);
  if (typeof norm === "string") {
    return { name, reason: norm };
  }
  const errs = validateServer(name, norm.server, {});
  if (errs.length) {
    return { name, reason: errs.join("；") };
  }
  return {
    id: String(row.id ?? name),
    name,
    transport: transportOf(norm.server),
    summary: summaryOf(norm.server),
    server: norm.server,
    envKeys: keysOf(norm.server.env),
    headerKeys: keysOf(norm.server.headers),
    unmapped: norm.unmapped,
    note: norm.note,
    exists: existingNames.has(name),
  };
}

/** 扫本机 cc-switch 库的 `mcp_servers` 表（只读；库不存在或无该表 → 空）。 */
export function scanCcSwitchMcp(existingNames: Iterable<string>, deps: { findStore: () => string | undefined; readTable: (db: string, table: string) => Array<Record<string, unknown>> | undefined }): CcSwitchMcpScan {
  const file = deps.findStore();
  if (!file || !/\.db$/i.test(file)) {
    return { path: file, candidates: [], skipped: [] };
  }
  const rows = deps.readTable(file, "mcp_servers");
  if (!rows) {
    return { path: file, candidates: [], skipped: [] };
  }
  const taken = new Set(existingNames);
  const out: CcSwitchMcpScan = { path: file, candidates: [], skipped: [] };
  for (const row of rows) {
    const c = ccSwitchRowToCandidate(row, taken);
    if ("reason" in c) {
      out.skipped.push(c);
    } else {
      out.candidates.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 监视外部改动

export interface McpWatcher {
  dispose(): void;
  /** 目录刚被创建（本扩展首次写工作区级文件）后重新挂监视 */
  rearm(): void;
}

/**
 * 监视两份文件所在目录（目录不存在时跳过），只认 `mcp.json` 文件名，300 ms 防抖后回调作用域。
 * 用目录而不是文件：文件被 rename 替换（本扩展与编辑器都这么写）时文件级 watch 会失效。
 */
export function watchMcpFiles(onChange: (scope: McpScope) => void, opts: McpPathOptions = {}, debounceMs = 300): McpWatcher {
  const watchers = new Map<McpScope, fs.FSWatcher>();
  const timers = new Map<McpScope, NodeJS.Timeout>();
  let disposed = false;
  const arm = () => {
    for (const scope of ["user", "workspace"] as McpScope[]) {
      if (watchers.has(scope)) {
        continue;
      }
      const file = mcpConfigPath(scope, opts);
      if (!file) {
        continue;
      }
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        continue;
      }
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
          if (disposed) {
            return;
          }
          const fn = filename == null ? "" : String(filename);
          if (fn && fn !== MCP_FILE) {
            return;
          }
          const t = timers.get(scope);
          if (t) {
            clearTimeout(t);
          }
          timers.set(
            scope,
            setTimeout(() => {
              timers.delete(scope);
              if (!disposed) {
                onChange(scope);
              }
            }, debounceMs)
          );
        });
        w.on("error", (e) => warn("mcp: watcher error", { scope, message: (e as Error).message }));
        watchers.set(scope, w);
      } catch (e) {
        warn("mcp: watch failed", { scope, message: (e as Error).message });
      }
    }
  };
  arm();
  return {
    rearm: arm,
    dispose() {
      disposed = true;
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      watchers.clear();
    },
  };
}

/** 测试用：清掉「本会话已备份」记录。 */
export function _resetMcpConfigForTest(): void {
  backedUp.clear();
}
