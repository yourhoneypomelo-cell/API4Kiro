/**
 * Kiro 自定义 agent / 子代理配置文件的读写层（R28；版本停 4.13.55）。
 *
 * 事实来源（只读研究 `.verify-artifacts/agent-context-research.md` §A，Kiro 1.0.437 `kiro.kiro-agent/dist/extension.js`）：
 *  - 两级目录：用户级 `~/.kiro/agents/`、工作区级 `<root>/.kiro/agents/`（每个 workspace folder 各一份），Kiro 递归扫描、
 *    只收 `.md` 与 `.json`，agentId = 相对路径去扩展名（`/` 连接），前置元数据 / JSON 的 `name` 存在时覆盖它；
 *  - `.md` = `---` YAML 前置元数据（name / description / tools / excludedTools / model / effortLevel / includeMcpJson /
 *    includePowers / mcpServers / resources / permissions / welcomeMessage / dispatchKind / hooks）+ 正文即 system prompt；
 *    `.json` = 同一组字段 + `prompt`（Kiro CLI 格式，允许注释与尾逗号）；
 *  - zod schema 剥离未知键不报错 → 这里把未知字段与三个结构化字段（mcpServers / permissions / hooks）当作不透明块原样保留；
 *  - JSON 文件含 `allowedTools` / `toolsSettings` 且无 `permissions` 时 Kiro IDE 整份静默跳过（`cli_only_agent`）；
 *  - Kiro 用 chokidar 监听两级目录（300 ms 防抖），写完即生效，没有任何 agent 相关命令。
 *
 * 写入约定与 `mcpConfig.ts` 同源：第一次改动前留一份 `<file>.bak`（已有则不覆盖）+ 临时文件 → rename 原子写；
 * 不直接覆写目标文件。任何解析失败只记 `error`，不抛、不阻断其它文件。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type AgentScope = "user" | "workspace";
export type AgentFormat = "md" | "json";
export type DispatchKind = "sub-agent" | "custom-agent" | "spec";

export const DISPATCH_KINDS: readonly DispatchKind[] = ["sub-agent", "custom-agent", "spec"];
/** Kiro 内置模式名（`dFr`）：与之撞名的 agent 文件会被 Kiro 整份跳过。 */
export const BUILTIN_MODE_IDS: readonly string[] = ["vibe", "spec", "quick-spec", "bug-fix", "plan", "autonomous"];
/** Kiro 1.0.437 工具标签（`ot`）+ 文档标签；编辑弹窗下拉候选，自由文本也放行。 */
export const TOOL_TAGS: readonly string[] = ["read", "write", "shell", "web", "subagent", "spec", "context", "@mcp", "@powers", "@builtin", "*"];
/** JSON 文件里的 CLI 专用字段：存在且无 `permissions` 时 Kiro IDE 忽略整份文件。 */
export const CLI_ONLY_FIELDS: readonly string[] = ["allowedTools", "toolsSettings"];

/** 编辑弹窗能改的字段（Kiro schema 里的标量 / 字符串数组）。 */
export interface AgentFields {
  name?: string;
  description?: string;
  /** `.md` 的正文；`.json` 的 `prompt`（可能是 `file://` 引用，原样保留）。 */
  prompt: string;
  tools?: string[] | "*";
  excludedTools?: string[];
  model?: string;
  effortLevel?: string;
  includeMcpJson?: boolean;
  includePowers?: boolean;
  resources?: string[];
  welcomeMessage?: string;
  dispatchKind?: DispatchKind;
}

/** 不做表单、只显示数量并原样保留的结构化字段。 */
export interface AgentOpaque {
  mcpServers: number;
  mcpServerNames: string[];
  permissions: number;
  hooks: number;
  /** 其它未知顶层字段名（原样保留）。 */
  other: string[];
}

export interface AgentEntry {
  /** Kiro 的 agentId：`name` 存在取 name，否则相对路径去扩展名（`/` 连接）。 */
  id: string;
  scope: AgentScope;
  /** 该级的 agents 目录。 */
  dir: string;
  filePath: string;
  /** 相对 agents 目录的路径（`/` 连接，含扩展名）。 */
  rel: string;
  format: AgentFormat;
  fields: AgentFields;
  opaque: AgentOpaque;
  /** 非致命提示：Kiro 会忽略 / 撞内置名 / 同名覆盖 / 注释将丢失。 */
  warnings: string[];
  /** 解析失败原因；有值时条目只读（仅能打开 / 删除）。 */
  error?: string;
  size: number;
  mtime: number;
}

export interface AgentRoots {
  /** 用户级 agents 目录（`~/.kiro/agents`）。 */
  user: string;
  /** 各 workspace folder 的 agents 目录（`<root>/.kiro/agents`）。 */
  workspaces: string[];
}

export function defaultAgentRoots(workspaceFolders: readonly string[], homeDir: string = os.homedir()): AgentRoots {
  return {
    user: path.join(homeDir, ".kiro", "agents"),
    workspaces: workspaceFolders.map((w) => path.join(w, ".kiro", "agents")),
  };
}

// ---------------------------------------------------------------- 小工具

export class AgentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFileError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 按字段名读写 AgentFields（已知键集合以外不会传进来）。 */
const rec = (f: AgentFields): Record<string, unknown> => f as unknown as Record<string, unknown>;

/** 临时文件 + rename；rename 失败重试 4 次后抛错并清掉临时文件，绝不退化为直接覆写。 */
export async function writeAtomic(file: string, content: string): Promise<void> {
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

/** 第一次改动前备份一份 `<file>.bak`；已有备份不覆盖（保住最早的原文）。文件不存在则什么都不做。 */
export async function backupOnce(file: string): Promise<boolean> {
  const bak = `${file}.bak`;
  try {
    await fs.promises.access(bak);
    return false;
  } catch {
    /* no backup yet */
  }
  try {
    await fs.promises.copyFile(file, bak);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw e;
  }
}

/** 文件名 = slug(name)：小写、`[a-z0-9._-]` 之外一律 `-`、去首尾 `-`；空则 `agent`。 */
export function slugifyAgentName(name: string): string {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return s || "agent";
}

/** 与 Kiro `nlt` 同义：去行注释与块注释、去尾逗号（字符串内不动）。 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inStr) {
      out += ch;
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && nx === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // 尾逗号：`,` 后只有空白就遇到 `}` / `]`
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ---------------------------------------------------------------- YAML 前置元数据（子集）

interface FmBlock {
  key: string;
  /** 块的原始行（含首行），逐字保留。 */
  lines: string[];
}

interface FrontMatter {
  blocks: FmBlock[];
  /** 前置元数据之前的行（BOM / 空行）与分隔线原文，写回时沿用。 */
  open: string;
  close: string;
  body: string;
  eol: string;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/;

/** 切出 `---` 包住的前置元数据；没有则抛 AgentFileError（与 Kiro 一致：无前置元数据不是 agent 文件）。 */
export function splitFrontMatter(text: string): FrontMatter {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const src = text.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !/^---\s*$/.test(lines[i])) {
    throw new AgentFileError("No front matter found");
  }
  const open = lines[i];
  let j = i + 1;
  while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
  if (j >= lines.length) {
    throw new AgentFileError("Front matter not closed");
  }
  const fmLines = lines.slice(i + 1, j);
  const blocks: FmBlock[] = [];
  let cur: FmBlock | undefined;
  for (const ln of fmLines) {
    const m = KEY_LINE.exec(ln);
    if (m && !/^\s/.test(ln)) {
      cur = { key: m[1], lines: [ln] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(ln);
    } else {
      // 键之前的注释 / 空行：挂到一个无键块上原样保留
      cur = { key: "", lines: [ln] };
      blocks.push(cur);
    }
  }
  return { blocks, open, close: lines[j], body: lines.slice(j + 1).join(eol), eol };
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // 行尾注释（YAML：` #` 起）
  return s.replace(/\s+#.*$/, "").trim();
}

/** 标量：字符串 / 布尔 / 数字 / null；块标量 `|` `>` 用后续缩进行拼接。 */
function parseScalar(block: FmBlock): unknown {
  const first = KEY_LINE.exec(block.lines[0]);
  const rest = (first ? first[2] : "").trim();
  if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
    const body = block.lines.slice(1).filter((l) => l.trim() !== "" || true);
    const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length), Infinity);
    const txt = body.map((l) => (l.trim() === "" ? "" : l.slice(indent === Infinity ? 0 : indent)));
    while (txt.length && txt[txt.length - 1] === "") txt.pop();
    return rest.startsWith(">") ? txt.join(" ").replace(/\s+/g, " ").trim() : txt.join("\n");
  }
  if (rest === "" || rest === "~" || rest === "null") {
    return rest === "" && block.lines.length > 1 ? undefined : null;
  }
  const v = unquote(rest);
  if (rest[0] !== '"' && rest[0] !== "'") {
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  }
  return v;
}

/** 流式数组 `[a, "b", 'c']` → 元素；引号内的逗号不切。 */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && q === '"') {
        cur += inner[++i] ?? "";
      } else if (ch === q) {
        q = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((s) => unquote(s)).filter((s) => s.length > 0);
}

/** 字符串数组：流式 `[…]`、块 `- x`、或单个标量（Kiro 的 `tools: "*"` / 逗号串）。返回 undefined 表示无法按数组理解。 */
function parseStringList(block: FmBlock): string[] | "*" | undefined {
  const first = KEY_LINE.exec(block.lines[0]);
  const rest = (first ? first[2] : "").trim();
  if (rest.startsWith("[")) {
    const joined = [rest, ...block.lines.slice(1)].join(" ").trim();
    const end = joined.lastIndexOf("]");
    if (end < 0) return undefined;
    return splitFlow(joined.slice(1, end));
  }
  if (rest === "" || rest === "|" || rest === ">") {
    const items: string[] = [];
    for (const ln of block.lines.slice(1)) {
      const m = /^\s*-\s+(.*)$/.exec(ln);
      if (m) {
        items.push(unquote(m[1]));
      } else if (ln.trim() !== "" && !/^\s*#/.test(ln)) {
        return undefined;
      }
    }
    return items;
  }
  const v = unquote(rest);
  if (v === "*") return "*";
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 不透明块里第一层嵌套键（`mcpServers` 的服务器名）。 */
function nestedKeys(block: FmBlock): string[] {
  const names: string[] = [];
  let indent = -1;
  for (const ln of block.lines.slice(1)) {
    const m = /^(\s+)([^\s#][^:]*?)\s*:(\s|$)/.exec(ln);
    if (!m) continue;
    if (indent < 0) indent = m[1].length;
    if (m[1].length === indent) names.push(unquote(m[2]));
  }
  return names;
}

function countListItems(block: FmBlock, marker: RegExp): number {
  return block.lines.slice(1).filter((l) => marker.test(l)).length;
}

const SCALAR_KEYS = ["name", "description", "model", "effortLevel", "welcomeMessage", "dispatchKind"] as const;
const BOOL_KEYS = ["includeMcpJson", "includePowers"] as const;
const LIST_KEYS = ["tools", "excludedTools", "resources"] as const;
const OPAQUE_KEYS = ["mcpServers", "permissions", "hooks"] as const;
const KNOWN_KEYS = new Set<string>([...SCALAR_KEYS, ...BOOL_KEYS, ...LIST_KEYS, ...OPAQUE_KEYS]);

/** YAML 标量输出：能裸写就裸写，否则 JSON 双引号（合法 YAML）。 */
export function yamlScalar(v: string): string {
  if (v === "") return '""';
  // 裸写条件：字母 / 数字 / 下划线开头，只含安全字符；`:` 允许出现（file:// 这类 URI），但不能 `: ` 或收尾（YAML 键值歧义）
  if (
    /^[A-Za-z0-9_][A-Za-z0-9_ ./@()+:*-]*$/.test(v) &&
    !/: /.test(v) &&
    !/[:\s]$/.test(v) &&
    !/ #/.test(v) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(v) &&
    !/^-?\d/.test(v)
  ) {
    return v;
  }
  return JSON.stringify(v);
}

function yamlBlockScalar(key: string, v: string, eol: string): string {
  const lines = v.split(/\r?\n/).map((l) => (l === "" ? "" : "  " + l));
  return `${key}: |${eol}${lines.join(eol)}`;
}

function yamlList(key: string, items: string[], eol: string, flow: boolean): string {
  if (items.length === 0) return `${key}: []`;
  if (flow) return `${key}: [${items.map((s) => JSON.stringify(s)).join(", ")}]`;
  return `${key}:${eol}${items.map((s) => "  - " + yamlScalar(s)).join(eol)}`;
}

// ---------------------------------------------------------------- 解析

export interface ParsedAgent {
  format: AgentFormat;
  fields: AgentFields;
  opaque: AgentOpaque;
  warnings: string[];
  /** `.md`：切好的前置元数据（写回时复用）；`.json`：原对象。 */
  fm?: FrontMatter;
  json?: Record<string, unknown>;
  jsonHadComments?: boolean;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  return out;
}

export function parseAgentMarkdown(text: string): ParsedAgent {
  const fm = splitFrontMatter(text);
  const fields: AgentFields = { prompt: fm.body.trim() };
  const opaque: AgentOpaque = { mcpServers: 0, mcpServerNames: [], permissions: 0, hooks: 0, other: [] };
  const warnings: string[] = [];
  const seen = new Set<string>();
  let anyKey = false;
  for (const b of fm.blocks) {
    if (!b.key) continue;
    anyKey = true;
    if (seen.has(b.key)) warnings.push(`重复字段 ${b.key}，以后者为准`);
    seen.add(b.key);
    if ((SCALAR_KEYS as readonly string[]).includes(b.key)) {
      const v = parseScalar(b);
      if (v !== undefined && v !== null) {
        const s = typeof v === "string" ? v : String(v);
        if (b.key === "dispatchKind") {
          if ((DISPATCH_KINDS as readonly string[]).includes(s)) fields.dispatchKind = s as DispatchKind;
          else warnings.push(`dispatchKind「${s}」不在 sub-agent / custom-agent / spec 之内，Kiro 会拒绝此文件`);
        } else {
          rec(fields)[b.key] = s;
        }
      }
    } else if ((BOOL_KEYS as readonly string[]).includes(b.key)) {
      const v = parseScalar(b);
      if (typeof v === "boolean") rec(fields)[b.key] = v;
      else if (v !== undefined && v !== null) warnings.push(`${b.key} 不是布尔值（${String(v)}），Kiro 会拒绝此文件`);
    } else if ((LIST_KEYS as readonly string[]).includes(b.key)) {
      const v = parseStringList(b);
      if (v === undefined) {
        warnings.push(`${b.key} 不是字符串数组，编辑时将原样保留`);
        opaque.other.push(b.key);
      } else if (b.key === "tools") {
        fields.tools = v;
      } else if (v !== "*") {
        rec(fields)[b.key] = v;
      }
    } else if (b.key === "mcpServers") {
      opaque.mcpServerNames = nestedKeys(b);
      opaque.mcpServers = opaque.mcpServerNames.length;
    } else if (b.key === "permissions") {
      opaque.permissions = countListItems(b, /^\s*-\s*capability\s*:/) || (b.lines.length > 1 ? 1 : 0);
    } else if (b.key === "hooks") {
      opaque.hooks = countListItems(b, /^\s*-\s*(name|command)\s*:/) || nestedKeys(b).length;
    } else {
      opaque.other.push(b.key);
    }
  }
  if (!anyKey) throw new AgentFileError("No front matter found");
  if (fields.name !== undefined && fields.name.trim() === "") warnings.push("name 为空，Kiro 会拒绝此文件");
  return { format: "md", fields, opaque, warnings, fm };
}

export function parseAgentJson(text: string): ParsedAgent {
  const stripped = stripJsonComments(text);
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch (e) {
    throw new AgentFileError(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new AgentFileError("Agent JSON must be an object");
  const o = obj as Record<string, unknown>;
  const warnings: string[] = [];
  const hadComments = stripped !== text && /\/\/|\/\*/.test(text);
  const fields: AgentFields = { prompt: typeof o.prompt === "string" ? o.prompt : "" };
  for (const k of SCALAR_KEYS) {
    const s = strOrUndef(o[k]);
    if (s === undefined) continue;
    if (k === "dispatchKind") {
      if ((DISPATCH_KINDS as readonly string[]).includes(s)) fields.dispatchKind = s as DispatchKind;
      else warnings.push(`dispatchKind「${s}」不在 sub-agent / custom-agent / spec 之内，Kiro 会拒绝此文件`);
    } else {
      rec(fields)[k] = s;
    }
  }
  for (const k of BOOL_KEYS) {
    if (typeof o[k] === "boolean") rec(fields)[k] = o[k];
    else if (o[k] !== undefined && o[k] !== null) warnings.push(`${k} 不是布尔值，Kiro 会拒绝此文件`);
  }
  if (o.tools === "*") fields.tools = "*";
  else if (Array.isArray(o.tools)) fields.tools = strList(o.tools);
  else if (o.tools !== undefined) warnings.push("tools 不是数组或 \"*\"，Kiro 会拒绝此文件");
  fields.excludedTools = strList(o.excludedTools);
  if (Array.isArray(o.resources)) {
    const strs = o.resources.filter((x): x is string => typeof x === "string");
    fields.resources = strs;
    if (strs.length !== o.resources.length) warnings.push("resources 含知识库对象条目，编辑时原样保留");
  }
  const mcp = o.mcpServers && typeof o.mcpServers === "object" && !Array.isArray(o.mcpServers) ? Object.keys(o.mcpServers as object) : [];
  const perms = o.permissions && typeof o.permissions === "object" ? (Array.isArray((o.permissions as Record<string, unknown>).rules) ? ((o.permissions as Record<string, unknown>).rules as unknown[]).length : 1) : 0;
  let hooks = 0;
  if (Array.isArray(o.hooks)) hooks = o.hooks.length;
  else if (o.hooks && typeof o.hooks === "object") hooks = Object.values(o.hooks as Record<string, unknown>).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
  const other = Object.keys(o).filter((k) => !KNOWN_KEYS.has(k) && k !== "prompt");
  const cliOnly = CLI_ONLY_FIELDS.filter((k) => o[k] !== undefined && o[k] !== null);
  if (cliOnly.length && (o.permissions === undefined || o.permissions === null)) {
    warnings.push(`含 CLI 专用字段 ${cliOnly.join(" / ")} 且无 permissions：Kiro IDE 会忽略整份文件`);
  }
  if (hadComments) warnings.push("文件含 JSON 注释，保存后注释会丢失");
  if (fields.name !== undefined && fields.name.trim() === "") warnings.push("name 为空，Kiro 会拒绝此文件");
  return {
    format: "json",
    fields,
    opaque: { mcpServers: mcp.length, mcpServerNames: mcp, permissions: perms, hooks, other },
    warnings,
    json: o,
    jsonHadComments: hadComments,
  };
}

export function parseAgentText(text: string, format: AgentFormat): ParsedAgent {
  return format === "json" ? parseAgentJson(text) : parseAgentMarkdown(text);
}

/** 粘贴导入：`{` 开头按 JSON，否则按前置元数据。 */
export function detectAgentFormat(text: string): AgentFormat {
  return /^\s*\{/.test(text.replace(/^\uFEFF/, "")) ? "json" : "md";
}

// ---------------------------------------------------------------- 序列化（已知块重写、其余逐字保留）

function normalizeFields(f: AgentFields): AgentFields {
  const out: AgentFields = { prompt: String(f.prompt ?? "").replace(/\r\n/g, "\n") };
  const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  out.name = s(f.name);
  out.description = s(f.description);
  out.model = s(f.model);
  out.effortLevel = s(f.effortLevel);
  out.welcomeMessage = s(f.welcomeMessage);
  out.dispatchKind = f.dispatchKind && (DISPATCH_KINDS as readonly string[]).includes(f.dispatchKind) ? f.dispatchKind : undefined;
  if (f.tools === "*") out.tools = "*";
  else if (Array.isArray(f.tools)) {
    const t = f.tools.map((x) => String(x).trim()).filter(Boolean);
    out.tools = t.length ? t : undefined;
  }
  const ex = Array.isArray(f.excludedTools) ? f.excludedTools.map((x) => String(x).trim()).filter(Boolean) : [];
  out.excludedTools = ex.length ? ex : undefined;
  const rs = Array.isArray(f.resources) ? f.resources.map((x) => String(x).trim()).filter(Boolean) : [];
  out.resources = rs.length ? rs : undefined;
  if (typeof f.includeMcpJson === "boolean") out.includeMcpJson = f.includeMcpJson;
  if (typeof f.includePowers === "boolean") out.includePowers = f.includePowers;
  return out;
}

function renderKnownBlock(key: string, f: AgentFields, eol: string): string | undefined {
  switch (key) {
    case "name":
    case "description":
    case "model":
    case "effortLevel":
    case "welcomeMessage":
    case "dispatchKind": {
      const v = rec(f)[key] as string | undefined;
      if (v === undefined) return undefined;
      return v.includes("\n") ? yamlBlockScalar(key, v, eol) : `${key}: ${yamlScalar(v)}`;
    }
    case "includeMcpJson":
    case "includePowers": {
      const v = rec(f)[key] as boolean | undefined;
      return v === undefined ? undefined : `${key}: ${v ? "true" : "false"}`;
    }
    case "tools":
      if (f.tools === undefined) return undefined;
      return f.tools === "*" ? 'tools: "*"' : yamlList("tools", f.tools, eol, true);
    case "excludedTools":
      return f.excludedTools ? yamlList("excludedTools", f.excludedTools, eol, true) : undefined;
    case "resources":
      return f.resources ? yamlList("resources", f.resources, eol, false) : undefined;
    default:
      return undefined;
  }
}

const CANONICAL_ORDER = ["name", "description", "model", "effortLevel", "tools", "excludedTools", "includeMcpJson", "includePowers", "mcpServers", "resources", "permissions", "welcomeMessage", "dispatchKind", "hooks"];

/**
 * 写回 `.md`：沿用原前置元数据里的块顺序，已知标量 / 数组块按新值重写（值被清空则删掉该块），
 * 不透明块与未知块逐字保留，新增的已知字段按规范顺序追加；正文换成新 prompt。
 */
export function serializeAgentMarkdown(fields: AgentFields, base?: FrontMatter, opaqueOther: string[] = []): string {
  const f = normalizeFields(fields);
  const eol = base?.eol ?? "\n";
  const out: string[] = [];
  const emitted = new Set<string>();
  const skipRewrite = new Set(opaqueOther);
  for (const b of base?.blocks ?? []) {
    if (!b.key) {
      out.push(...b.lines);
      continue;
    }
    if (KNOWN_KEYS.has(b.key) && !(OPAQUE_KEYS as readonly string[]).includes(b.key) && !skipRewrite.has(b.key)) {
      if (emitted.has(b.key)) continue;
      emitted.add(b.key);
      const r = renderKnownBlock(b.key, f, eol);
      if (r !== undefined) out.push(...r.split(eol));
      continue;
    }
    emitted.add(b.key);
    out.push(...b.lines);
  }
  for (const k of CANONICAL_ORDER) {
    if (emitted.has(k)) continue;
    const r = renderKnownBlock(k, f, eol);
    if (r !== undefined) out.push(...r.split(eol));
  }
  const open = base?.open ?? "---";
  const close = base?.close ?? "---";
  const body = f.prompt.replace(/\n/g, eol);
  return [open, ...out, close, "", body].join(eol) + eol;
}

/** JSON 是否会被 Kiro IDE 当作 CLI 专用 profile 跳过（含 allowedTools / toolsSettings 且无 permissions）。 */
export function isCliOnlyJson(o: Record<string, unknown>): boolean {
  return CLI_ONLY_FIELDS.some((k) => o[k] !== undefined && o[k] !== null) && (o.permissions === undefined || o.permissions === null);
}

/**
 * 写回 `.json`：在原对象上改已知键（清空则删键），未知键与 mcpServers / permissions / hooks 不动；2 空格缩进。
 * `addPermissions`：原文件会被 Kiro 跳过时补 `permissions: { rules: [] }` 放行（Kiro 代码里放行的唯一条件）。
 */
export function serializeAgentJson(fields: AgentFields, base?: Record<string, unknown>, opts: { addPermissions?: boolean } = {}): string {
  const f = normalizeFields(fields);
  const o: Record<string, unknown> = { ...(base ?? {}) };
  if (opts.addPermissions && isCliOnlyJson(o)) {
    o.permissions = { rules: [] };
  }
  const set = (k: string, v: unknown) => {
    if (v === undefined) delete o[k];
    else o[k] = v;
  };
  set("name", f.name);
  set("description", f.description);
  set("prompt", f.prompt === "" ? undefined : f.prompt);
  set("model", f.model);
  set("effortLevel", f.effortLevel);
  set("tools", f.tools);
  set("excludedTools", f.excludedTools);
  set("includeMcpJson", f.includeMcpJson);
  set("includePowers", f.includePowers);
  if (f.resources !== undefined || !Array.isArray(o.resources) || o.resources.every((x) => typeof x === "string")) {
    // 有知识库对象条目时不动 resources（编辑器只认字符串条目）
    set("resources", f.resources);
  }
  set("welcomeMessage", f.welcomeMessage);
  set("dispatchKind", f.dispatchKind);
  // 新建文件时给规范顺序；已有文件保持原键序（set 不改已存在键的位置）
  const ordered: Record<string, unknown> = {};
  const keys = base ? Object.keys(o) : [...CANONICAL_ORDER.slice(0, 2), "prompt", ...CANONICAL_ORDER.slice(2), ...Object.keys(o)];
  for (const k of keys) {
    if (k in o && !(k in ordered)) ordered[k] = o[k];
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

// ---------------------------------------------------------------- 目录扫描

async function walk(dir: string, base: string, seen: Set<string>): Promise<Array<{ filePath: string; rel: string }>> {
  const out: Array<{ filePath: string; rel: string }> = [];
  let real: string;
  try {
    real = await fs.promises.realpath(dir);
  } catch {
    return out;
  }
  if (seen.has(real)) return out;
  seen.add(real);
  let ents: fs.Dirent[];
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (!isDir && !isFile && e.isSymbolicLink()) {
      try {
        const st = await fs.promises.stat(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      out.push(...(await walk(p, base, seen)));
    } else if (isFile && (e.name.endsWith(".md") || e.name.endsWith(".json"))) {
      out.push({ filePath: p, rel: path.relative(base, p).split(path.sep).join("/") });
    }
  }
  return out;
}

/** `file` 是否落在某个 agents 目录之内（宿主收到 webview 路径时的边界守卫：只动两级目录里的文件）。 */
export function isInsideAgentRoots(file: string, roots: AgentRoots): boolean {
  const target = path.resolve(file);
  for (const dir of [roots.user, ...roots.workspaces]) {
    const rel = path.relative(path.resolve(dir), target);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** Kiro 的 agentId：`name` 优先，否则相对路径去扩展名。 */
export function agentIdOf(rel: string, name?: string): string {
  return name && name.trim() ? name.trim() : rel.replace(/\.(md|json)$/i, "");
}

export async function readAgentFile(filePath: string, scope: AgentScope, dir: string): Promise<AgentEntry> {
  const rel = path.relative(dir, filePath).split(path.sep).join("/");
  const format: AgentFormat = filePath.toLowerCase().endsWith(".json") ? "json" : "md";
  let size = 0;
  let mtime = 0;
  try {
    const st = await fs.promises.stat(filePath);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    /* 下面 readFile 会报 */
  }
  const empty: AgentOpaque = { mcpServers: 0, mcpServerNames: [], permissions: 0, hooks: 0, other: [] };
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    const parsed = parseAgentText(text, format);
    const id = agentIdOf(rel, parsed.fields.name);
    const warnings = [...parsed.warnings];
    if (BUILTIN_MODE_IDS.includes(id)) warnings.push(`「${id}」是 Kiro 内置模式名，Kiro 会跳过此文件`);
    return { id, scope, dir, filePath, rel, format, fields: parsed.fields, opaque: parsed.opaque, warnings, size, mtime };
  } catch (e) {
    return {
      id: agentIdOf(rel),
      scope,
      dir,
      filePath,
      rel,
      format,
      fields: { prompt: "" },
      opaque: empty,
      warnings: [],
      error: (e as Error).message || String(e),
      size,
      mtime,
    };
  }
}

/** 列出两级目录的全部 agent；目录不存在返回空。同 id 跨级 / 同级重复各记一条提示（Kiro：后加载覆盖，工作区盖用户）。 */
export async function listAgents(roots: AgentRoots): Promise<AgentEntry[]> {
  const out: AgentEntry[] = [];
  const dirs: Array<{ scope: AgentScope; dir: string }> = [{ scope: "user", dir: roots.user }, ...roots.workspaces.map((d) => ({ scope: "workspace" as AgentScope, dir: d }))];
  for (const { scope, dir } of dirs) {
    const files = await walk(dir, dir, new Set());
    for (const f of files) {
      out.push(await readAgentFile(f.filePath, scope, dir));
    }
  }
  const byId = new Map<string, AgentEntry[]>();
  for (const a of out) {
    if (a.error) continue;
    const list = byId.get(a.id) ?? [];
    list.push(a);
    byId.set(a.id, list);
  }
  for (const list of byId.values()) {
    if (list.length < 2) continue;
    const scopes = new Set(list.map((a) => a.scope));
    for (const a of list) {
      if (scopes.size > 1) {
        a.warnings.push(a.scope === "workspace" ? "与用户级同名：Kiro 以本工作区级为准" : "与工作区级同名：在该工作区里被工作区级覆盖");
      } else {
        a.warnings.push("同级目录内有同名 agent，Kiro 只保留后加载的一份");
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 写入

export interface UpsertOptions {
  scope: AgentScope;
  dir: string;
  /** 编辑已有文件时给路径；新建时省略（文件名 = slug(name) + 扩展名）。 */
  filePath?: string;
  /** 新建时的格式，默认 md。 */
  format?: AgentFormat;
  fields: AgentFields;
  /** 编辑会被 Kiro 跳过的 CLI 专用 JSON 时补空 permissions 放行。 */
  addPermissions?: boolean;
}

export interface WriteResult {
  filePath: string;
  created: boolean;
  backedUp: boolean;
}

function assertValid(fields: AgentFields, existing?: ParsedAgent): void {
  const name = (fields.name ?? "").trim();
  if (!name) throw new AgentFileError("名称不能为空");
  if (BUILTIN_MODE_IDS.includes(name)) throw new AgentFileError(`「${name}」是 Kiro 内置模式名，不能用作 agent 名`);
  if (fields.dispatchKind && !(DISPATCH_KINDS as readonly string[]).includes(fields.dispatchKind)) {
    throw new AgentFileError("dispatchKind 只能是 sub-agent / custom-agent / spec");
  }
  if (fields.tools !== undefined && fields.tools !== "*" && !Array.isArray(fields.tools)) throw new AgentFileError("tools 必须是数组或 \"*\"");
  void existing;
}

/** 新建或改写一个 agent 文件。返回落盘路径；同级目录已有同名（不同文件）时抛错。 */
export async function upsertAgent(o: UpsertOptions): Promise<WriteResult> {
  assertValid(o.fields);
  const name = o.fields.name!.trim();
  await fs.promises.mkdir(o.dir, { recursive: true });
  let filePath = o.filePath;
  let format = o.format ?? "md";
  let base: ParsedAgent | undefined;
  let created = false;
  if (filePath) {
    format = filePath.toLowerCase().endsWith(".json") ? "json" : "md";
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      base = parseAgentText(text, format);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AgentFileError(`原文件无法解析，未改动：${(e as Error).message}`);
      }
      created = true;
    }
  } else {
    filePath = path.join(o.dir, `${slugifyAgentName(name)}.${format}`);
    created = true;
    try {
      await fs.promises.access(filePath);
      throw new AgentFileError(`文件已存在：${path.basename(filePath)}`);
    } catch (e) {
      if (e instanceof AgentFileError) throw e;
    }
  }
  // 同级同名（别的文件）→ 拒绝，避免 Kiro 静默覆盖
  const siblings = await walk(o.dir, o.dir, new Set());
  for (const s of siblings) {
    if (path.resolve(s.filePath) === path.resolve(filePath)) continue;
    try {
      const t = await fs.promises.readFile(s.filePath, "utf8");
      const p = parseAgentText(t, s.filePath.toLowerCase().endsWith(".json") ? "json" : "md");
      if (agentIdOf(s.rel, p.fields.name) === name) {
        throw new AgentFileError(`同级目录已有名为「${name}」的 agent（${s.rel}）`);
      }
    } catch (e) {
      if (e instanceof AgentFileError && /同级目录已有/.test(e.message)) throw e;
    }
  }
  const text = format === "json" ? serializeAgentJson(o.fields, base?.json, { addPermissions: o.addPermissions === true }) : serializeAgentMarkdown(o.fields, base?.fm, base?.opaque.other ?? []);
  const backedUp = created ? false : await backupOnce(filePath);
  await writeAtomic(filePath, text);
  return { filePath, created, backedUp };
}

/** 删除 agent 文件（先留 `.bak`，已有则不覆盖）。文件不存在视为成功。 */
export async function deleteAgent(filePath: string): Promise<{ backedUp: boolean }> {
  const backedUp = await backupOnce(filePath);
  await fs.promises.rm(filePath, { force: true });
  return { backedUp };
}

/** 粘贴 JSON / 前置元数据文本导入到某一级目录；按 name 定文件名，格式随文本。 */
export async function importAgent(scope: AgentScope, dir: string, text: string, nameOverride?: string): Promise<WriteResult> {
  const format = detectAgentFormat(text);
  const parsed = parseAgentText(text, format);
  const name = (nameOverride ?? parsed.fields.name ?? "").trim();
  if (!name) throw new AgentFileError("导入内容缺少 name，请填一个名称");
  parsed.fields.name = name;
  const filePath = path.join(dir, `${slugifyAgentName(name)}.${format}`);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.access(filePath);
    throw new AgentFileError(`文件已存在：${path.basename(filePath)}`);
  } catch (e) {
    if (e instanceof AgentFileError) throw e;
  }
  const out = format === "json" ? serializeAgentJson(parsed.fields, parsed.json) : serializeAgentMarkdown(parsed.fields, parsed.fm, parsed.opaque.other);
  await writeAtomic(filePath, out);
  return { filePath, created: true, backedUp: false };
}

// ---------------------------------------------------------------- 监听

export interface AgentWatcher {
  dispose(): void;
}

/**
 * 监听两级 agents 目录（`fs.watch`，300 ms 防抖）；目录尚不存在时每 2 s 探测一次，出现后转正式监听并触发一次回调。
 * 只在本模块内用 Node 的 fs.watch（不依赖 vscode），便于测试。
 */
export function watchAgents(roots: AgentRoots, onChange: () => void, opts: { debounceMs?: number; pollMs?: number } = {}): AgentWatcher {
  const debounceMs = opts.debounceMs ?? 300;
  const pollMs = opts.pollMs ?? 2000;
  const dirs = [roots.user, ...roots.workspaces];
  const watchers = new Map<string, fs.FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const fire = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onChange();
    }, debounceMs);
  };
  const tryWatch = (dir: string): boolean => {
    if (watchers.has(dir)) return true;
    // Kiro 递归扫描子目录，这里也递归监听；平台不支持 recursive 时退回只看顶层（子目录改动靠下次刷新补上）
    for (const recursive of [true, false]) {
      try {
        const w = fs.watch(dir, { persistent: false, recursive }, () => fire());
        w.on("error", () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      }
    }
    return false;
  };
  for (const d of dirs) tryWatch(d);
  const poll = setInterval(() => {
    if (disposed) return;
    for (const d of dirs) {
      if (!watchers.has(d) && tryWatch(d)) fire();
    }
  }, pollMs);
  poll.unref?.();
  return {
    dispose() {
      disposed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
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

// ---------------------------------------------------------------- steering（只读列表，设置页「上下文」卡）

export type SteeringScope = "user" | "workspace" | "agentsmd";

export interface SteeringFile {
  scope: SteeringScope;
  filePath: string;
  /** 相对 steering 目录的路径（`/` 连接）；AGENTS.md 为文件名。 */
  rel: string;
  size: number;
  mtime: number;
  /** 前置元数据 `inclusion`（always / fileMatch / manual），缺省 Kiro 视为 always。 */
  inclusion?: string;
  fileMatchPattern?: string;
}

/** Kiro 的 steering 目录：`~/.kiro/steering` 与每个 workspace 的 `.kiro/steering`（递归 `.md`），另加各 workspace 根的 `AGENTS.md`。 */
export function steeringDirs(workspaceFolders: readonly string[], homeDir: string = os.homedir()): { user: string; workspaces: string[] } {
  return {
    user: path.join(homeDir, ".kiro", "steering"),
    workspaces: workspaceFolders.map((w) => path.join(w, ".kiro", "steering")),
  };
}

/** 只读前置元数据里的 inclusion / fileMatchPattern（只看文件头 4 KB，不解析别的）。 */
export function steeringFrontMatter(head: string): { inclusion?: string; fileMatchPattern?: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(head);
  if (!m) return {};
  const out: { inclusion?: string; fileMatchPattern?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(inclusion|fileMatchPattern)\s*:\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const v = kv[2].replace(/^(['"])(.*)\1$/, "$2");
    if (kv[1] === "inclusion") out.inclusion = v;
    else out.fileMatchPattern = v;
  }
  return out;
}

/** 列出全部 steering 文件（只读；上限 `maxFiles`，超出截断——Kiro 自己也有 maxSteeringScanDirectories 上限）。 */
export async function listSteeringFiles(workspaceFolders: readonly string[], homeDir: string = os.homedir(), maxFiles = 200): Promise<SteeringFile[]> {
  const dirs = steeringDirs(workspaceFolders, homeDir);
  const targets: Array<{ scope: SteeringScope; dir: string }> = [{ scope: "user", dir: dirs.user }, ...dirs.workspaces.map((d) => ({ scope: "workspace" as SteeringScope, dir: d }))];
  const out: SteeringFile[] = [];
  const push = async (scope: SteeringScope, filePath: string, rel: string) => {
    if (out.length >= maxFiles) return;
    try {
      const st = await fs.promises.stat(filePath);
      let fm: { inclusion?: string; fileMatchPattern?: string } = {};
      if (scope !== "agentsmd") {
        const fh = await fs.promises.open(filePath, "r");
        try {
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await fh.read(buf, 0, 4096, 0);
          fm = steeringFrontMatter(buf.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await fh.close();
        }
      }
      out.push({ scope, filePath, rel, size: st.size, mtime: st.mtimeMs, ...fm });
    } catch {
      /* 读不到就不列 */
    }
  };
  for (const t of targets) {
    const files = (await walk(t.dir, t.dir, new Set())).filter((f) => f.rel.toLowerCase().endsWith(".md"));
    for (const f of files) await push(t.scope, f.filePath, f.rel);
  }
  for (const w of workspaceFolders) {
    await push("agentsmd", path.join(w, "AGENTS.md"), "AGENTS.md");
  }
  return out;
}
