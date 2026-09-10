/**
 * 上游「上下文超长」判定与回给 Kiro 的异常形状（4.13.55，目标 B）。
 *
 * Kiro 1.0.437 的被动恢复性压缩只在异常被判定为「上下文溢出」时才走：
 *  - `Bfe`（错误分类）：`ValidationException` 且 `reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD"`，或 message 命中
 *    `kAr`（`input is too long` / `prompt is too long` / `input content length exceeds threshold`）→ `Dfe`
 *    （name `ContextWindowExceededError`，CLIENT_ERROR，不进 TRANSIENT 重试）；
 *  - `u4`（溢出判定）：`Dfe` 实例直接为真；其它 Error 只看 message 是否含上面三句或 `context` + `exceeded`；
 *  - `WLl`：`u4` 为真 → 截断式摘要 → 重置上下文 → 下一轮继续（`disableAutoCompaction` 时改为要求手动压缩）。
 * 4.13.54 及更早 KRS 对所有非 2xx 终态回 `InternalServerException{ message: "Upstream 400" }`——既不是
 * `ValidationException`、message 也没有关键词，Kiro 只显示错误文本，这条恢复路径从未触发。
 *
 * 本模块只做两件事，都是纯函数：判定上游错误正文像不像「上下文超长」；给出让 Kiro 认得的异常 payload。
 * 偏移与逐字摘录见 `.verify-artifacts/ctx-window-research.md` §2。
 */

/** Kiro `Bfe` 走官方溢出分支的 `reason` 值（`wc.CONTENT_LENGTH_EXCEEDS_THRESHOLD`，extension.js offset 3876931）。 */
export const CONTEXT_OVERFLOW_REASON = "CONTENT_LENGTH_EXCEEDS_THRESHOLD";

/** Kiro `kAr` / `u4` 逐字认得的关键词之一（小写比较）；放在 message 开头兼容更老 / 更新的 Kiro。 */
export const CONTEXT_OVERFLOW_MESSAGE_PREFIX = "Input is too long.";

/** 只有这些状态码下的文案才可能是「上下文超长」；401 / 402 / 403 / 404 / 429 各有确定含义，永不误判。 */
const OVERFLOW_STATUSES = new Set([400, 413, 422]);

/**
 * 强信号：出现即判定（各家原文摘录）。
 *  - Anthropic：`prompt is too long: 213412 tokens > 200000 maximum`
 *  - OpenAI / DeepSeek / 多数兼容网关：`This model's maximum context length is 128000 tokens…` / code `context_length_exceeded`
 *  - xAI：`The input token count exceeds the maximum context window`
 *  - Gemini：`The input token count (…) exceeds the maximum number of tokens allowed (…)`
 *  - Kiro 官方：`Input is too long` / `input content length exceeds threshold`
 *  - 中文网关：`上下文长度超过限制` / `输入内容过长` / `超出模型最大上下文`
 */
const STRONG_PHRASES = [
  "input is too long",
  "prompt is too long",
  "input content length exceeds threshold",
  "context length",
  "context_length",
  "context window",
  "context_window",
  "maximum context",
  "max context",
  "too many tokens",
  "input too long",
  "prompt too long",
  "input tokens too long",
  "prompt tokens too long",
  "exceeds the model's maximum",
  "exceeds the model’s maximum",
  "exceeds the maximum number of tokens",
  "input token count",
  "reduce the length",
  "reduce your prompt",
  "上下文长度",
  "上下文超",
  "超出上下文",
  "超过上下文",
  "超出最大长度",
  "超过最大长度",
  "超出模型最大",
  "输入过长",
  "输入内容过长",
  "输入太长",
  "提示词过长",
  "提示过长",
];

/**
 * 弱信号：单独出现时也常见于「max_tokens 太大」「输出上限」这类与输入无关的 400，
 * 只在文案不提输出侧参数时才算。
 */
const WEAK_PHRASES = ["token limit", "tokens limit", "token count exceeds", "exceeds the limit", "request too large", "长度超过", "超出限制", "tokens 超", "token 数超"];

const OUTPUT_SIDE_RE = /max_?tokens|max_?output_?tokens|max_?completion_?tokens|output tokens|completion tokens|输出长度|最大输出/i;

/**
 * 上游非 2xx（或流内错误折算出的状态码）+ 错误正文，像不像「上下文超长」。
 * 纯函数、可单测；不匹配时调用方保持既有 `Upstream <status>` 行为。
 */
export function looksLikeContextOverflow(status: number, text: string): boolean {
  if (!OVERFLOW_STATUSES.has(Number(status))) {
    return false;
  }
  const t = String(text || "").toLowerCase();
  if (!t) {
    return false;
  }
  if (STRONG_PHRASES.some((p) => t.includes(p))) {
    return true;
  }
  // 与 Kiro `u4` 同口径的组合：context + exceeded（如 `context_length_exceeded` 已被强信号覆盖，这里兜住 `context … exceeded` 的变体）
  if (t.includes("context") && t.includes("exceeded")) {
    return true;
  }
  if (OUTPUT_SIDE_RE.test(t)) {
    return false;
  }
  return WEAK_PHRASES.some((p) => t.includes(p));
}

/** 回给 Kiro 的异常帧内容：类型 + payload。message 首句是 `u4` 认得的关键词，`reason` 走 `Bfe` 官方分支。 */
export interface OverflowException {
  exceptionType: "ValidationException";
  payload: { message: string; reason: typeof CONTEXT_OVERFLOW_REASON };
}

export function contextOverflowException(status: number, text: string, maxUpstreamChars = 300): OverflowException {
  const excerpt = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxUpstreamChars));
  return {
    exceptionType: "ValidationException",
    payload: {
      message: `${CONTEXT_OVERFLOW_MESSAGE_PREFIX} Upstream ${status}${excerpt ? `: ${excerpt}` : ""}`,
      reason: CONTEXT_OVERFLOW_REASON,
    },
  };
}

/** ❌ 正文里给用户的一句话（与异常帧同时发出）。 */
export const CONTEXT_OVERFLOW_USER_HINT = "上下文超长：这条请求的输入超过了该模型 / 渠道的上下文窗口。Kiro 将自动压缩对话后重试；若没有自动重试，请新开会话或在侧边栏模型页把该模型的「上下文」挡位调低。";
