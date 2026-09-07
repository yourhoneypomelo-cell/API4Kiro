import { CwEvent } from "./cwTypes";
import { contextWindowForModel as relayContextWindow } from "./modelStore";

/** Token counts captured from an upstream response, normalized across protocols. */
export interface CapturedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyUsage(): CapturedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从上游 usage 里解出**真实输出 token**（含思考）。
 *
 * 起因（2026-09 实测本中转站 + gemini-pro-agent）：`output_tokens` 只算可见正文，
 * 思考 token 单列在 `completion_tokens_details.reasoning_tokens` 且**不含**在前者里：
 *     total 11928 = prompt 30 + completion 125 + reasoning 11773
 * 直接用 output_tokens 会把 reasoning 模型的输出少报近两个数量级，而思考 token 照常计费。
 *
 * 麻烦在于各家口径不一致：OpenAI 官方的 `completion_tokens` 是**包含** reasoning 的，
 * 若无脑相加会双计。所以优先用 `total - prompt` 反推——这个式子对两种口径都成立；
 * 拿不到 total 时退回 completion + reasoning；再退回 completion。
 *
 * 该中转站把 OpenAI 口径的账嵌在 `billing_usage.openai_usage` 里，优先读它。
 */
export function resolveOutputTokens(u: Record<string, unknown> | undefined): number {
  if (!u) {
    return 0;
  }
  const billing = u.billing_usage as Record<string, unknown> | undefined;
  const nested = billing?.openai_usage as Record<string, unknown> | undefined;
  const src = nested ?? u;

  const prompt = num(src.prompt_tokens) || num(src.input_tokens) || num(u.input_tokens);
  const completion = num(src.completion_tokens) || num(src.output_tokens) || num(u.output_tokens);
  const total = num(src.total_tokens);
  const details = src.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoning = num(details?.reasoning_tokens);

  if (total > 0 && prompt > 0 && total > prompt) {
    return Math.max(completion, total - prompt);
  }
  if (reasoning > 0) {
    return completion + reasoning;
  }
  return completion;
}

const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * Context window for the context-usage bar. Prefers the relay's /models
 * `context_window` (authoritative and identical to the model list Kiro's picker
 * shows, so one source of truth drives both). Falls back to a name heuristic
 * aligned to Kiro's official ListAvailableModels, then 200K.
 *
 * Shared by both protocol converters: the bar means the same thing whichever
 * endpoint answered, and the heuristic already covers GPT-class names.
 */
export function contextWindowForModel(modelId: string): number {
  const fromRelay = relayContextWindow(modelId);
  if (fromRelay && fromRelay > 0) {
    return fromRelay;
  }
  const m = (modelId || "").toLowerCase();
  // 1M 上下文（对齐 Kiro 官方 ListAvailableModels 与 Anthropic 模型页）：auto、Opus 5、Opus 4.8/4.7/4.6、Sonnet 4.6/5、Fable 5/5.1
  if (
    m === "auto" ||
    m.includes("opus-5") || m.includes("opus5") ||
    m.includes("opus-4-8") || m.includes("opus-4.8") ||
    m.includes("opus-4-7") || m.includes("opus-4.7") ||
    m.includes("opus-4-6") || m.includes("opus-4.6") ||
    m.includes("sonnet-4-6") || m.includes("sonnet-4.6") ||
    m.includes("sonnet-5") ||
    m.includes("fable-5") || m.includes("fable5")
  ) {
    return 1000000;
  }
  // GPT 5.6 系列（sol/terra/luna）输入窗口 272K（对齐 Kiro 官方 ListAvailableModels）
  if (m.includes("gpt")) {
    return 272000;
  }
  // 其余 Claude（Opus 4.5、Sonnet 4.5/4、Haiku 等）为 200K
  if (m.includes("opus") || m.includes("sonnet") || m.includes("haiku") || m.includes("claude")) {
    return 200000;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

export function contextUsagePercentFloat(tokens: number, modelId: string): number | null {
  if (!tokens || tokens <= 0) {
    return null;
  }
  const window = contextWindowForModel(modelId);
  if (!window || window <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, (tokens / window) * 100));
}

/** 紧凑计数：88 / 1.2k / 3.45M，避免大数字把页脚撑开。 */
function compact(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  // toFixed 必定带小数点，故去尾零的正则不会误伤整数（"100.0"→"100"）。
  const fmt = (v: number) => v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, "") + "";
  if (n < 1_000_000) {
    const s = fmt(n / 1000);
    // 999_999 会被舍成 "1000k"，让它落到 M 档显示成 "1M"。
    if (s !== "1000") {
      return s + "k";
    }
  }
  return fmt(n / 1_000_000) + "M";
}

/**
 * 每轮页脚的用量项（Est. … Used: …）。
 *
 * **必须只发一个 meteringEvent。** Kiro 消费侧（kiro-agent/dist/extension.js）把
 * metering 帧收进一个**单变量**而非数组：
 *     Y.usageSummaryEntry && (E = L.additional_kwargs.usageSummaryEntry)
 * 流结束后才 emit 一次 AgentExecutionSummarizeUsage(E)。所以一个 HTTP 请求里发
 * N 个 metering，只有最后一个能活下来，其余静默丢弃。早先这里发 input+output
 * 两条，结果 output 覆盖 input，页脚只剩输出、输入永远不可见。
 *
 * 因此把分解塞进 unitPlural、总量放 usage。Kiro 的渲染模板写死为
 *     `Est. ${capitalizeFirst(unitPlural)} Used: ${usage.toLocaleString()}`
 * 于是呈现为：Est. Tokens (in 12.4k / out 1.2k) Used: 13,600。
 *
 * `unit` 保持稳定字符串：aggregateUsageSummary() 按 unit 分组累加 usage，工具循环
 * 里每次迭代是独立请求，累加后的大数字正好等于整轮总量。
 * 注意其代价——同组只保留**首个** entry 的 unitPlural，所以多轮工具循环中括号内的
 * 分解只反映第一次请求，而 Used 后的总量是全轮累计。这是 Kiro 聚合逻辑写死的，
 * 代理侧无法修正。
 *
 * 两个协议通道共用：Anthropic 侧 input 需合并 cache_read + cache_creation，OpenAI 侧
 * prompt_tokens 本身即完整输入（cached_tokens 是其子集，转换器已置零缓存字段）。
 */
export function buildMeteringEvents(usage: CapturedUsage): CwEvent[] {
  const inTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const outTotal = usage.outputTokens;
  const total = inTotal + outTotal;
  if (total <= 0) {
    return [];
  }
  return [
    {
      meteringEvent: {
        usage: total,
        unit: "token",
        unitPlural: `tokens (in ${compact(inTotal)} / out ${compact(outTotal)})`,
      },
    },
  ];
}

/**
 * Kiro 认的 stopReason（CodeWhisperer 口径）。
 *
 * 这个字段**不是可选装饰**。kiro-agent 收尾时（Vlu）的判定：
 *   有正文 && 没有工具调用 && stopReason 为空 → truncation_suspected → 自动重发一次请求续写。
 * 各家上游都给了自己的 stop 原因（Anthropic stop_reason / OpenAI finish_reason / Gemini finishReason），
 * 我们之前一个都没往 Kiro 转，于是每条纯文本回答都被 Kiro 当成"被截断"再要一遍——
 * 用户看到的就是同一个问题被回答了两遍。
 */
export type CwStopReason = "END_TURN" | "MAX_TOKENS" | "TOOL_USE" | "STOP_SEQUENCE";

/** 把各协议的结束原因归一到 Kiro 的枚举。认不出的一律 END_TURN——宁可少一次续写，也别再触发重发。 */
export function toCwStopReason(raw: string | undefined | null, sawToolUse: boolean): CwStopReason {
  const r = String(raw || "").toLowerCase();
  if (sawToolUse || r === "tool_use" || r === "tool_calls" || r === "function_call") {
    return "TOOL_USE";
  }
  if (r === "max_tokens" || r === "length" || r === "max_output_tokens") {
    return "MAX_TOKENS";
  }
  if (r === "stop_sequence") {
    return "STOP_SEQUENCE";
  }
  return "END_TURN";
}

/** 流末必发的 stopReason 帧。放在 metadataEvent 里（Kiro 从 metadataEvent.stopReason 读）。 */
export function stopReasonEvent(reason: CwStopReason): CwEvent {
  return { metadataEvent: { stopReason: reason } };
}

/**
 * 把「输入总量已含缓存」的原始用量（OpenAI prompt_tokens / Responses input_tokens / Gemini promptTokenCount，
 * cached 是其子集）拆成账本口径：未命中 = 总量 − 缓存读 − 缓存写，缓存字段夹在总量以内，
 * 保证四项之和恒等于 meteringUsage() 的总量（inputTokens + outputTokens）。
 */
export function splitCachedInput(u: CapturedUsage): CapturedUsage {
  const read = Math.min(u.cacheReadTokens, u.inputTokens);
  const write = Math.min(u.cacheCreationTokens, u.inputTokens - read);
  return { inputTokens: u.inputTokens - read - write, outputTokens: u.outputTokens, cacheReadTokens: read, cacheCreationTokens: write };
}

/** Shared surface both protocol converters implement, so the pump stays generic. */
export interface StreamConverter {
  /** Feed one raw SSE line. Returns 0+ CwEvents to forward to Kiro. */
  processLine(line: string): CwEvent[];
  /** Emit trailing events (unterminated tool call, context bar, **stopReason**). */
  flush(): CwEvent[];
  /** Latest token counts seen for this response（原始口径，缓存命中率统计用）。 */
  readonly usage: CapturedUsage;
  /**
   * 计费口径的用量，供轮次账本累加。两个协议对「输入是否已含缓存」的口径不同，
   * 各自在这里归一，泵不必知道差异。
   */
  meteringUsage(): CapturedUsage;
  /**
   * 用量账本口径（usageStore.ts）：inputTokens 只算**未命中缓存**的输入，cacheReadTokens /
   * cacheCreationTokens 单列，四项之和 = meteringUsage() 的总量。Anthropic 与 Kiro 直通天然如此；
   * OpenAI / Responses / Gemini 的输入总量已含缓存，要把缓存从 inputTokens 里扣出来——
   * 否则这三类 provider 在用量页的缓存命中率恒为 0。页脚仍用 meteringUsage()，两者互不影响。
   */
  ledgerUsage(): CapturedUsage;
  /**
   * 本次响应是否发起了工具调用。为 false 说明这一轮到此结束，泵据此决定是否
   * 结算轮次账本并上报页脚用量（见 turnLedger.ts）。
   */
  readonly sawToolUse: boolean;
}
