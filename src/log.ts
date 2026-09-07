import * as vscode from "vscode";
import { isDebug } from "./config";

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("API4Kiro");
  }
  return channel;
}

export function showLog() {
  initLog().show(true);
}

function ts(): string {
  return new Date().toISOString();
}

/** Always log (info-level), regardless of debug setting. */
export function info(...parts: unknown[]) {
  const text = parts.map(fmt).join(" ");
  initLog().appendLine(`[${ts()}] ${text}`);
  // 控制台镜像也走同一份已脱敏文本，不再直接吐原始对象
  // eslint-disable-next-line no-console
  console.log("[API4Kiro]", text);
}

/** Debug-only log; no-op unless api2kiroDual.debug is on. */
export function debug(...parts: unknown[]) {
  if (!isDebug()) {
    return;
  }
  initLog().appendLine(`[${ts()}] [debug] ${parts.map(fmt).join(" ")}`);
}

/** 可恢复的异常路径（有兜底、不影响主流程），介于 info 与 error 之间。 */
export function warn(...parts: unknown[]) {
  const text = parts.map(fmt).join(" ");
  initLog().appendLine(`[${ts()}] [warn] ${text}`);
  // eslint-disable-next-line no-console
  console.warn("[API4Kiro]", text);
}

export function error(...parts: unknown[]) {
  const text = parts.map(fmt).join(" ");
  initLog().appendLine(`[${ts()}] [error] ${text}`);
  // eslint-disable-next-line no-console
  console.error("[API4Kiro]", text);
}

/**
 * 任意一段日志参数 → 已脱敏的文本。
 *  - 字符串：按形态打码（URL 查询串里的 key/token、Bearer、已知 Key 前缀、JWT、header 样式的 k=v / k: v）；
 *  - Error：`Name: message`（JSON.stringify(Error) 是 {}，会把报错原因整个吞掉），再按字符串规则打码；
 *  - 其它：JSON 序列化，敏感字段名按值打码，字符串值再过一遍形态打码。
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

/** 字段名像密钥 / 令牌 / 密文 / 会话的，值一律打码。 */
const SENSITIVE_KEY_RE = /apikey|api-key|api_key|authorization|token|secret|password|passwd|cookie|verifier|credential/i;

/** Redact anything that looks like a key/token when serializing debug objects. */
function redactReplacer(key: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const k = key.toLowerCase();
  if (k === "key" || SENSITIVE_KEY_RE.test(k)) {
    return maskKey(value);
  }
  return redactText(value);
}

/** 查询参数名：值可能是密钥 / 授权码 / 令牌。 */
const QUERY_SECRET_PARAM = /([?&](?:api[_-]?key|key|token|access_token|refresh_token|id_token|client_secret|secret|code|code_verifier|password|signature|sig)=)([^&#\s"'<>]+)/gi;
/** header / kv 文本：`authorization: Bearer x` / `x-api-key=…` / `"apiKey":"…"` 之外的裸写法。 */
const HEADER_KV = /((?:authorization|x-api-key|x-goog-api-key|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)(bearer\s+)?([^\s"',;&]+)/gi;
/** 已知的 Key / 令牌形态（长度门槛避免误伤普通单词）。 */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / 中转站
  /\bksk_[A-Za-z0-9_-]{8,}/g, // Kiro 官方 API Key
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bgsk_[A-Za-z0-9_-]{16,}/g, // Groq
  /\bxai-[A-Za-z0-9_-]{16,}/g, // xAI
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/** 对一段任意文本做形态脱敏；不认识的内容原样保留。 */
export function redactText(s: string): string {
  if (!s || s.length < 6) {
    return s;
  }
  let out = s.replace(QUERY_SECRET_PARAM, (_, p: string, v: string) => p + maskKey(v));
  out = out.replace(BEARER, (_, p: string, v: string) => p + maskKey(v));
  out = out.replace(HEADER_KV, (_, p: string, bearer: string | undefined, v: string) => p + (bearer || "") + maskKey(v));
  for (const re of KEY_SHAPES) {
    out = out.replace(re, (m) => maskKey(m));
  }
  return out;
}

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
