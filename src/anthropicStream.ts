import { CwEvent } from "./cwTypes";
import {
  CapturedUsage,
  StreamConverter,
  buildMeteringEvents,
  contextUsagePercentFloat,
  emptyUsage,
  resolveOutputTokens,
  stopReasonEvent,
  toCwStopReason,
} from "./streamShared";

export { CapturedUsage } from "./streamShared";

interface AnthropicSseEvent {
  type: string;
  index?: number;
  // 值不全是 number：中转站会挂一层嵌套的 billing_usage。
  message?: { usage?: Record<string, unknown>; stop_reason?: string | null };
  content_block?: { type?: string; id?: string; name?: string; data?: string; text?: string; thinking?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    /** message_delta 里带的结束原因（end_turn / max_tokens / tool_use / stop_sequence）。 */
    stop_reason?: string | null;
  };
  usage?: Record<string, unknown>;
}

/**
 * Converts an Anthropic Messages streaming SSE into Kiro's CodeWhisperer event
 * objects. Usage capture is exposed for local cache-hit-rate statistics.
 *
 * 路由原则：**块类型优先于 delta 类型**。规范的流里两者一致（thinking 块只发 thinking_delta），
 * 但中转站把 DeepSeek / Gemini 的 reasoning 翻译成 Anthropic 格式时常见两类错：
 *  - 开了 `thinking` 块却在里面发 `text_delta` → 思考被当正文吐给用户，随后块尾的 signature
 *    又让 Kiro 画出一个空的「Thought complete」，看起来就是"回复了两次"；
 *  - 在 `text` 块里发 `thinking_delta`。
 * 所以按 content_block_start 记下每个 index 的块类型，delta 到了先看它属于哪种块。
 */
export class AnthropicStreamConverter implements StreamConverter {
  private conversationId: string;
  private modelId: string;

  private currentToolId = "";
  private currentToolName = "";
  private currentToolInput = "";
  private inToolUse = false;

  private inThinking = false;
  private curThinkingText = "";
  private curSignature = "";

  /** index → 块类型（text / thinking / tool_use / …）。无 index 的旧式流退回"最近打开的块"。 */
  private blockTypes = new Map<number, string>();
  private lastBlockType = "";

  private pendingContextPct: number | null = null;

  /** Latest usage seen for this response (updated on message_start/message_delta). */
  public usage: CapturedUsage = emptyUsage();
  /** 本次响应是否发起了工具调用；泵用它判断轮次是否结束。 */
  public sawToolUse = false;
  /**
   * 事件轨迹（调试用，krsServer 在流末打进日志）。每个 SSE 事件一个短记号：
   * ms=message_start, bs:<type>=content_block_start, d:<type>=content_block_delta, be=content_block_stop, md=message_delta。
   * 连续相同的 delta 折叠成 `d:text_delta×12`。开了 debug 才记（默认关，零开销）。
   */
  public trace: string[] | undefined;
  /** 上游流里发现的形态异常（text_in_thinking / thinking_in_text），不依赖 debug，流末由泵打一条 info。 */
  public anomalies = new Set<string>();
  /** 上游给的 stop_reason（message_delta.delta.stop_reason），flush 时翻成 Kiro 枚举发出。 */
  private upstreamStopReason: string | undefined;
  /** 是否已发过 metadataEvent.tokenUsage；没发过而流里又有用量时 flush 兜底补一帧。 */
  private sentTokenUsage = false;

  constructor(conversationId: string, modelId: string, opts?: { trace?: boolean }) {
    this.conversationId = conversationId;
    this.modelId = modelId;
    if (opts?.trace) {
      this.trace = [];
    }
  }

  private anomaly(tag: string): void {
    this.anomalies.add(tag);
    this.mark("!" + tag);
  }

  private mark(tag: string): void {
    const t = this.trace;
    if (!t) {
      return;
    }
    const last = t[t.length - 1];
    if (last === tag) {
      t[t.length - 1] = `${tag}×2`;
      return;
    }
    const m = last && /^(.*)×(\d+)$/.exec(last);
    if (m && m[1] === tag) {
      t[t.length - 1] = `${tag}×${Number(m[2]) + 1}`;
      return;
    }
    if (t.length < 400) {
      t.push(tag);
    }
  }

  /** 这条 delta 所属块的类型（按 index 查；没 index 就当是最近打开的那个块）。 */
  private blockTypeOf(ev: AnthropicSseEvent): string {
    if (typeof ev.index === "number" && this.blockTypes.has(ev.index)) {
      return this.blockTypes.get(ev.index) || "";
    }
    return this.lastBlockType;
  }

  /** Process one raw SSE line ("data: {...}"). Returns 0+ CwEvents. */
  processLine(line: string): CwEvent[] {
    if (!line.startsWith("data:")) {
      return [];
    }
    const payload = line.slice(line.indexOf(":") + 1).trim();
    if (!payload || payload === "[DONE]") {
      return [];
    }
    try {
      return this.handleEvent(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  private handleEvent(ev: AnthropicSseEvent): CwEvent[] {
    const out: CwEvent[] = [];

    if (ev.type === "message_start") {
      this.mark("ms");
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
      const u = ev.message?.usage;
      if (u) {
        this.captureUsage(u);
        const total =
          this.usage.inputTokens + this.usage.cacheReadTokens + this.usage.cacheCreationTokens;
        this.pendingContextPct = contextUsagePercentFloat(total, this.modelId);
      }
      return out;
    }

    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      const btype = block?.type || "";
      this.mark("bs:" + (btype || "?"));
      if (typeof ev.index === "number") {
        this.blockTypes.set(ev.index, btype);
      }
      this.lastBlockType = btype;
      if (btype === "tool_use") {
        this.inToolUse = true;
        this.currentToolId = block?.id || "";
        this.currentToolName = block?.name || "";
        this.currentToolInput = "";
      } else if (btype === "thinking") {
        this.inThinking = true;
        this.curThinkingText = "";
        this.curSignature = "";
        // 非流式风格的中转会把整段思考直接放在 start 事件里
        if (block?.thinking) {
          this.curThinkingText += block.thinking;
          out.push({ reasoningContentEvent: { text: block.thinking } });
        }
      } else if (btype === "text" && block?.text) {
        out.push({ assistantResponseEvent: { content: block.text, modelId: this.modelId } });
      }
      return out;
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta;
      const dtype = d?.type || "";
      this.mark("d:" + (dtype || "?"));
      const btype = this.blockTypeOf(ev);
      // 文字类 delta 的归属：块或 delta 任一方说是 thinking，就是思考；只有 text_delta 落在
      // text 块（或没有块）里才是正文。宁可把东西收进可展开的思考折叠，也别把思考漏成正文。
      const textish = (dtype === "text_delta" && d?.text) || (dtype === "thinking_delta" && d?.thinking) || "";
      if (textish) {
        const isThought = btype === "thinking" || dtype === "thinking_delta";
        if (isThought) {
          if (dtype === "text_delta") {
            this.anomaly("text_in_thinking");
          } else if (btype === "text") {
            this.anomaly("thinking_in_text");
          }
          this.curThinkingText += textish;
          out.push({ reasoningContentEvent: { text: textish } });
        } else {
          out.push({ assistantResponseEvent: { content: textish, modelId: this.modelId } });
        }
      } else if (dtype === "signature_delta" && d?.signature) {
        this.curSignature += d.signature;
      } else if (dtype === "input_json_delta" && d?.partial_json) {
        this.currentToolInput += d.partial_json;
      }
      return out;
    }

    if (ev.type === "content_block_stop") {
      this.mark("be");
      if (typeof ev.index === "number") {
        this.blockTypes.delete(ev.index);
      }
      this.lastBlockType = "";
      if (this.inThinking) {
        if (this.curSignature) {
          out.push({ reasoningContentEvent: { signature: this.curSignature } });
        }
        this.inThinking = false;
        this.curThinkingText = "";
        this.curSignature = "";
      }
      if (this.inToolUse) {
        this.sawToolUse = true;
        out.push({
          toolUseEvent: {
            toolUseId: this.currentToolId,
            name: this.currentToolName,
            input: this.currentToolInput || "{}",
          },
        });
        this.inToolUse = false;
        this.currentToolId = "";
        this.currentToolName = "";
        this.currentToolInput = "";
      }
      return out;
    }

    if (ev.type === "message_delta") {
      this.mark("md");
      const sr = ev.delta?.stop_reason;
      if (typeof sr === "string" && sr) {
        this.upstreamStopReason = sr;
      }
    }
    if (ev.type === "message_delta" && ev.usage) {
      this.captureUsage(ev.usage);
      // 优先采用中转站透传的「后端真实上下文占用率」(contextUsagePercentage)，而非本地
      // token/窗口 估算。原生 Kiro 直连 AWS 时读的就是后端这个值；我们透传同一个值，上下文条
      // 与 Kiro 的摘要触发点就与原生逐字节对齐，无需我们复刻后端的上下文核算。
      // 实测(2026-07 直连后端对拍)：后端占用率随 token 线性增长、每个模型分母不同，且都比
      // 我们 /models 上报的窗口更大——opus-4-8 有效分母 ≈1.47M(报 1M)、sonnet-4.5 ≈454K
      // (报 200K)。因此本地按上报窗口自算会与后端不一致(opus 会“高报”约 1.47 倍)，透传后端
      // 真值可消除该偏差。
      const relayPct = (ev.usage as Record<string, number>).contextUsagePercentage;
      if (typeof relayPct === "number" && relayPct >= 0) {
        this.pendingContextPct = Math.max(0, Math.min(100, relayPct));
      }
      // 本地改动：原先这里发扁平 `metadataEvent{type,inputTokens,outputTokens}`，
      // 但 Kiro 侧读的是嵌套 `metadataEvent.tokenUsage.uncachedInputTokens`，
      // `cU(d.tokenUsage)` 取到 undefined → 整帧被丢弃（死码）。改成正确形状。
      // 注意 uncached：Kiro 分开统计未命中缓存的输入，别把 cache 部分并进去。
      // 取 captureUsage 归一后的值：outputTokens 已含思考 token，直接读 ev.usage
      // 会退回只算可见正文的口径。
      out.push(...this.tokenUsageEvent());
    }

    return out;
  }

  /** 嵌套形 tokenUsage 帧（Kiro 要求 uncachedInputTokens > 0 || outputTokens > 0 才收）。无用量时为空。 */
  private tokenUsageEvent(): CwEvent[] {
    const uncachedIn = this.usage.inputTokens;
    const outTokens = this.usage.outputTokens;
    if (uncachedIn <= 0 && outTokens <= 0) {
      return [];
    }
    this.sentTokenUsage = true;
    return [
      {
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: uncachedIn,
            outputTokens: outTokens,
            cacheReadInputTokens: this.usage.cacheReadTokens,
            cacheWriteInputTokens: this.usage.cacheCreationTokens,
          },
        },
      },
    ];
  }

  private captureUsage(u: Record<string, unknown>): void {
    if (typeof u.input_tokens === "number") {
      this.usage.inputTokens = u.input_tokens;
    }
    // 思考 token 不在 output_tokens 里，必须从 billing_usage 反推，否则 reasoning
    // 模型的输出会被少报一到两个数量级。详见 resolveOutputTokens。
    const realOut = resolveOutputTokens(u);
    if (realOut > 0) {
      this.usage.outputTokens = realOut;
    } else if (typeof u.output_tokens === "number") {
      this.usage.outputTokens = u.output_tokens;
    }
    if (typeof u.cache_read_input_tokens === "number") {
      this.usage.cacheReadTokens = u.cache_read_input_tokens;
    }
    if (typeof u.cache_creation_input_tokens === "number") {
      this.usage.cacheCreationTokens = u.cache_creation_input_tokens;
    }
  }

  /** Emit any trailing events (unterminated tool call, context usage bar, metering). */
  flush(): CwEvent[] {
    const out: CwEvent[] = [];
    if (this.inToolUse) {
      this.sawToolUse = true;
      out.push({
        toolUseEvent: {
          toolUseId: this.currentToolId,
          name: this.currentToolName,
          input: this.currentToolInput || "{}",
        },
      });
      this.inToolUse = false;
    }
    if (this.pendingContextPct !== null) {
      out.push({ contextUsageEvent: { contextUsagePercentage: this.pendingContextPct } });
      this.pendingContextPct = null;
    }
    // 中转站只在 message_start 给 usage、没有 message_delta 时，tokenUsage 帧还没发过，这里补上
    if (!this.sentTokenUsage) {
      out.push(...this.tokenUsageEvent());
    }
    // 结束原因必发（见 streamShared.toCwStopReason 的说明）
    out.push(stopReasonEvent(toCwStopReason(this.upstreamStopReason, this.sawToolUse)));
    // 页脚用量不在这里发：整轮累计由 krsServer 在轮末统一结算（turnLedger.ts）。
    return out;
  }

  /**
   * 计费口径的用量。Anthropic 的 `input_tokens` 不含缓存部分，cache_read /
   * cache_creation 是并列项，三者相加才是完整输入，故原样交出。
   */
  meteringUsage(): CapturedUsage {
    return { ...this.usage };
  }

  /** 账本口径与计费口径一致：input_tokens 本就是未命中部分，缓存读/写已单列。 */
  ledgerUsage(): CapturedUsage {
    return { ...this.usage };
  }
}
