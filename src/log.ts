import * as vscode from "vscode";
import { isDebug } from "./config";

let channel: vscode.OutputChannel | undefined;

/** 单行日志体积上限（UTF-8 字节）：debug 下的完整请求体 / 原始 SSE 可能有几百 KB，超出部分截断并标注丢弃了多少字节。 */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * debug 打开时在输出通道里打一次的醒目提示：调试日志包含完整请求正文（对话、代码上下文、工具 schema），
 * 脱敏只覆盖已知形态的 Key / token。每个进程只提示一次（激活时已开着 → 首行；中途打开 → 第一条 debug 之前）。
 */
const DEBUG_NOTICE =
  "【注意】调试日志已开启（api2kiroDual.debug）：接下来每条上游请求的完整正文（系统提示、整段对话、编辑器代码上下文、工具 schema）与上游原始响应片段都会写进本日志；" +
  "已知形态的 API Key / token / Bearer 会自动打码，正文里的其它内容不会。排障结束请关闭该设置，并按需删除 Kiro 日志目录里的旧日志。";
let debugNoticeShown = false;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("API4Kiro");
    noticeDebugOnce();
  }
  return channel;
}

export function showLog() {
  initLog().show(true);
}

function ts(): string {
  return new Date().toISOString();
}

function noticeDebugOnce(): void {
  if (debugNoticeShown || !isDebug()) {
    return;
  }
  debugNoticeShown = true;
  initLog().appendLine(`[${ts()}] [warn] ${DEBUG_NOTICE}`);
  // eslint-disable-next-line no-console
  console.warn("[API4Kiro]", DEBUG_NOTICE);
}

/** 四个级别共用：参数逐个脱敏 → 拼成一行 → 超过 MAX_LINE_BYTES 截断 → 写输出通道；返回写出的文本供控制台镜像。 */
function emit(level: "" | "debug" | "warn" | "error", parts: unknown[]): string {
  const text = clipLine(parts.map(fmt).join(" "));
  initLog().appendLine(`[${ts()}]${level ? ` [${level}]` : ""} ${text}`);
  return text;
}

/** Always log (info-level), regardless of debug setting. */
export function info(...parts: unknown[]) {
  const text = emit("", parts);
  // 控制台镜像也走同一份已脱敏文本，不再直接吐原始对象
  // eslint-disable-next-line no-console
  console.log("[API4Kiro]", text);
}

/** Debug-only log; no-op unless api2kiroDual.debug is on. */
export function debug(...parts: unknown[]) {
  if (!isDebug()) {
    return;
  }
  noticeDebugOnce();
  emit("debug", parts);
}

/** 可恢复的异常路径（有兜底、不影响主流程），介于 info 与 error 之间。 */
export function warn(...parts: unknown[]) {
  const text = emit("warn", parts);
  // eslint-disable-next-line no-console
  console.warn("[API4Kiro]", text);
}

export function error(...parts: unknown[]) {
  const text = emit("error", parts);
  // eslint-disable-next-line no-console
  console.error("[API4Kiro]", text);
}

/**
 * 把一行文本裁到 MAX_LINE_BYTES 个 UTF-8 字节以内（不切开代理对），末尾标注 `…[truncated N bytes]`。
 * 快速路径：一个 UTF-16 码元最多 3 字节，长度 × 3 不超上限的行不用数字节。
 */
function clipLine(text: string): string {
  if (text.length * 3 <= MAX_LINE_BYTES) {
    return text;
  }
  const total = Buffer.byteLength(text, "utf8");
  if (total <= MAX_LINE_BYTES) {
    return text;
  }
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > MAX_LINE_BYTES) {
      break;
    }
    bytes += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return `${text.slice(0, i)}…[truncated ${total - bytes} bytes]`;
}

/**
 * 任意一段日志参数 → 已脱敏的文本。
 *  - 字符串：按形态打码（URL 查询串 / 表单体里的 key/token/code、URL userinfo 密码、Bearer、已知 Key 前缀、JWT、
 *    header 样式的 k=v / k: v，以及敏感键名后紧跟的 ≥64 字不透明长串）；
 *  - Error：`Name: message`（JSON.stringify(Error) 是 {}，会把报错原因整个吞掉），再按字符串规则打码；
 *  - 其它：JSON 序列化，敏感字段名下的值整体打码（数组 / 对象逐层递归），嵌套 Error 展成 { name, message, stack }，
 *    其余字符串值再过一遍形态打码。
 */
function fmt(v: unknown): string {
  if (typeof v === "string") {
    return redactText(v);
  }
  if (v instanceof Error) {
    return redactText(`${v.name || "Error"}: ${v.message || String(v)}`);
  }
  try {
    const json = JSON.stringify(v, redactReplacer);
    return json === undefined ? String(v) : json;
  } catch {
    return redactText(String(v));
  }
}

/**
 * 字段名像密钥 / 令牌 / 密文 / 会话 / 授权码 / 签名的，值一律打码。
 * `x-amz-*`：只把凭证类纳入（security-token / credential / signature / SSE-C customer-key）；`x-amz-target`、`x-amz-date`、
 * `x-amz-content-sha256`、`x-amzn-*` 是操作名 / 时间 / 哈希 / 追踪 id，不是凭证，保持可读。
 */
const SENSITIVE_KEY_RE =
  /apikey|api-key|api_key|authorization|token|secret|password|passwd|cookie|verifier|credential|device[_-]?code|code[_-]?verifier|^code$|signature|private[_-]?key|assertion|x-amz-security-token|x-amz-credential|x-amz-signature|customer-key/i;
/** `authorization` / `proxy-authorization`（及 `x-authorization` 一类变体）：值按「方案名 + 凭证」处理，见 maskAuthorization。 */
const AUTHORIZATION_KEY_RE = /(?:^|[-_])authorization$/;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "key" || k === "keys" || SENSITIVE_KEY_RE.test(k);
}

/**
 * Redact anything that looks like a key/token when serializing debug objects.
 * JSON.stringify 自顶向下调用：返回的替代值会继续被遍历，所以敏感键下的数组 / 对象在这里整体打码后，
 * 其元素再进来时已经是打码文本，形态规则不会再动它们。
 */
function redactReplacer(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return errorToJson(value);
  }
  if (typeof value === "string" && AUTHORIZATION_KEY_RE.test(key.toLowerCase())) {
    return maskAuthorization(value);
  }
  if (isSensitiveKey(key)) {
    return maskDeep(value);
  }
  return typeof value === "string" ? redactText(value) : value;
}

/** 敏感键下的值：字符串打码；数组 / 普通对象逐层递归，数字、布尔与 Date（如 `tokenExpiresAt`）原样。 */
function maskDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return maskSecretForLog(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskDeep);
  }
  if (value instanceof Date) {
    return value;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskDeep(v);
    }
    return out;
  }
  return value;
}

/** `<Scheme> <credentials>` 形态：方案名字符集（RFC 9110 token）。 */
const AUTH_SCHEME_VALUE = /^(\s*)([A-Za-z][A-Za-z0-9._~+/-]*)(\s+)(\S[\s\S]*)$/;

/**
 * Authorization 值：保留方案名、打码其后全部内容——`Basic ****`、`AWS4-HMAC-SHA256 ****`、`Digest ****`、未知方案同样。
 * Bearer 例外：token 是单个不透明串，按 maskSecretForLog 保留可辨识首尾（长 token `oaut****ghij`、短 token `****`），
 * 与既有日志形态一致。没有方案名的裸值整体按 maskSecretForLog 打码。
 */
function maskAuthorization(value: string): string {
  const m = AUTH_SCHEME_VALUE.exec(value);
  if (!m) {
    return maskSecretForLog(value.trim());
  }
  const [, lead, scheme, , creds] = m;
  if (scheme.toLowerCase() === "bearer") {
    return `${lead}${scheme} ${maskSecretForLog(creds.trim())}`;
  }
  return `${lead}${scheme} ****`;
}

/** 嵌套在对象里的 Error：JSON.stringify 会得到 {}，改成 { name, message, stack? }；三个字段随后由 replacer 按字符串规则打码。 */
function errorToJson(e: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: e.name || "Error", message: e.message || String(e) };
  if (typeof e.stack === "string" && e.stack) {
    out.stack = e.stack;
  }
  return out;
}

/**
 * 查询串 / 表单体参数名：值可能是密钥 / 授权码 / 令牌。`(?:^|[?&])` 让表单体首参数（`code=…&client_id=…`）也命中；
 * 不放宽到空格前缀，避免把 `sticky key=c1` 一类普通文本当密钥。
 */
const QUERY_SECRET_PARAM =
  /((?:^|[?&])(?:api[_-]?key|key|token|access_token|refresh_token|id_token|client_secret|secret|code|code_verifier|device_code|password|signature|sig|assertion|x-amz-signature|x-amz-credential|x-amz-security-token)=)([^&#\s"'<>]+)/gi;
/**
 * `authorization` / `proxy-authorization` 头的文本形态（`k: v` / `k=v` / `"k":"v"`），值分五种写法，按序尝试：
 *  1. `Bearer <token>`：token 字符集内整段 → 保留 `Bearer` + maskSecretForLog(token)（与既有形态一致）；
 *  2. `"<Scheme> <凭证>"` / 3. `'<Scheme> <凭证>'`：引号内整段 → `"<Scheme> ****"`，闭引号保留，后面的 JSON 不受影响；
 *  4. 未加引号的 `<Scheme> <凭证>`：吃到行尾；`;` 只有在后面紧跟空白时才算分隔（`; x-api-key=…`），
 *     SigV4 `SignedHeaders=host;x-amz-date` 里的 `;` 不截断——覆盖 Basic / Digest（含内嵌引号）/ AWS4-HMAC-SHA256 / 任意未知方案；
 *  5. 没有方案名的裸值 → 整体 maskSecretForLog。
 */
const AUTH_HEADER =
  /((?:proxy-)?authorization["']?\s*[:=]\s*)(?:(["']?)(bearer)\s+([A-Za-z0-9._~+/=-]+)|"([A-Za-z][A-Za-z0-9._~+/-]*)\s+[^"\r\n]+"|'([A-Za-z][A-Za-z0-9._~+/-]*)\s+[^'\r\n]+'|([A-Za-z][A-Za-z0-9._~+/-]*)[ \t]+(?:[^\r\n;]|;(?!\s))+|(["']?)([^\s"',;&]+))/gi;
/** header / kv 文本：`x-api-key=…` / `client_secret: …` 之类的裸写法（authorization 走 AUTH_HEADER）。 */
const HEADER_KV = /((?:x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)(bearer\s+)?([^\s"',;&]+)/gi;
/** 已知的 Key / 令牌形态（长度门槛避免误伤普通单词）。都以固定前缀起头，匹配代价与文本长度线性。 */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / 中转站
  /\bksk_[A-Za-z0-9_-]{8,}/g, // Kiro 官方 API Key
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bgsk_[A-Za-z0-9_-]{16,}/g, // Groq
  /\bxai-[A-Za-z0-9_-]{16,}/g, // xAI
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google OAuth client secret
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access token
  /\b1\/\/0[A-Za-z0-9_-]{20,}/g, // Google OAuth refresh token
  /\bpplx-[A-Za-z0-9]{20,}/g, // Perplexity
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bcsk-[A-Za-z0-9_-]{16,}/g, // Cerebras
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;
/**
 * 兜底：没有固定前缀的不透明长串（Kiro social token、智谱 / Azure / Together 等无前缀 Key、base64url 签名）。
 * 边界：只打码「敏感键名 + 可选引号 + `:` 或 `=` + 可选引号」之后紧跟的 ≥64 字 `[A-Za-z0-9_.-]` 连续串。
 * 独立出现的 sha256 十六进制、URL 路径段、data: URL 里的 base64 图片正文、模型 id 都不带这种键名前缀，不会被碰；
 * `token_count:` / `tokenizer:` 一类键名与 `:` 之间隔着别的字符，也不命中。
 */
const OPAQUE_AFTER_KEY =
  /((?:token|key|secret|passw(?:or)?d|authorization|credential|signature|assertion|verifier|cookie|session|code)["']?\s*[:=]\s*["']?)([A-Za-z0-9_.-]{64,})/gi;
/** URL userinfo：`scheme://user:password@host` 里的密码（用户把口令写进 baseUrl 时会随 "Invalid upstream URL" 一类报错进日志）。 */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/@:]{1,128}:)([^\s/@]{1,512})(@)/gi;

/** 对一段任意文本做形态脱敏；不认识的内容原样保留。 */
export function redactText(s: string): string {
  if (!s || s.length < 6) {
    return s;
  }
  let out = s.replace(QUERY_SECRET_PARAM, (_, p: string, v: string) => p + maskSecretForLog(v));
  out = out.replace(URL_USERINFO, (_, p: string, pw: string, at: string) => p + maskSecretForLog(pw) + at);
  out = out.replace(AUTH_HEADER, replaceAuthHeader);
  out = out.replace(BEARER, (_, p: string, v: string) => p + maskSecretForLog(v));
  out = out.replace(HEADER_KV, (_, p: string, bearer: string | undefined, v: string) => p + (bearer || "") + maskSecretForLog(v));
  for (const re of KEY_SHAPES) {
    out = out.replace(re, (m) => maskSecretForLog(m));
  }
  out = out.replace(OPAQUE_AFTER_KEY, (_, p: string, v: string) => p + maskSecretForLog(v));
  return out;
}

/** AUTH_HEADER 的替换：捕获组编号见其注释里的五种写法。 */
function replaceAuthHeader(
  _m: string,
  prefix: string,
  bearerQuote: string | undefined,
  bearer: string | undefined,
  bearerToken: string | undefined,
  dqScheme: string | undefined,
  sqScheme: string | undefined,
  bareScheme: string | undefined,
  rawQuote: string | undefined,
  raw: string | undefined,
): string {
  if (bearer !== undefined) {
    return `${prefix}${bearerQuote || ""}${bearer} ${maskSecretForLog(bearerToken || "")}`;
  }
  if (dqScheme !== undefined) {
    return `${prefix}"${dqScheme} ****"`;
  }
  if (sqScheme !== undefined) {
    return `${prefix}'${sqScheme} ****'`;
  }
  if (bareScheme !== undefined) {
    return `${prefix}${bareScheme} ****`;
  }
  return `${prefix}${rawQuote || ""}${maskSecretForLog(raw || "")}`;
}

/**
 * 日志专用掩码：短则全掩、长则保留可辨识片段。< 16 字一律 `****`（OAuth code、code_verifier 片段、口令、短 token 的首尾
 * 字符已占明文相当比例，不能露）；16–31 字留前 2 后 2；≥ 32 字留前 4 后 4（沿用既有 maskKey 的长串规则）。
 * 面板的 Key 尾号显示用的是 maskKey（不改），日志路径全部走这里。
 * 幂等：已经是 `xx****yy` 形态的值原样返回——同一个值常被两条规则先后命中（`?api_key=` 与 `api_key=` kv、
 * maskDeep 的结果再被 JSON.stringify 回访），否则会被二次折叠成 `****`。
 */
const ALREADY_MASKED = /^[^*]{0,4}\*{4}[^*]{0,4}$/;

export function maskSecretForLog(secret: string): string {
  if (!secret) {
    return "";
  }
  if (ALREADY_MASKED.test(secret)) {
    return secret;
  }
  if (secret.length < 16) {
    return "****";
  }
  if (secret.length < 32) {
    return secret.slice(0, 2) + "****" + secret.slice(-2);
  }
  return secret.slice(0, 4) + "****" + secret.slice(-4);
}

/** 面板用的掩码（`sidebar.ts` 的 maskedKey / Key 尾号显示）：规则冻结，日志请用 maskSecretForLog。 */
export function maskKey(key: string): string {
  if (!key) {
    return "";
  }
  if (key.length <= 4) {
    return "****";
  }
  if (key.length <= 8) {
    return key.slice(0, 2) + "****" + key.slice(-2);
  }
  return key.slice(0, 4) + "****" + key.slice(-4);
}
