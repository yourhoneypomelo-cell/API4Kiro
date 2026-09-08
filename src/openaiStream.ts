import { CwEvent } from "./cwTypes";
import {
  CapturedUsage,
  StreamConverter,
  StreamError,
  buildMeteringEvents,
  contextUsagePercentFloat,
  emptyUsage,
  isTruncatedToolInput,
  resolveOutputTokens,
  splitCachedInput,
  stopReasonEvent,
  streamErrorNotice,
  toCwStopReason,
} from "./streamShared";
import {
  REASONING_SNIFF_MIN,
  SYNTHETIC_REASONING_SIGNATURE,
  classifyReasoningHead,
  squashWhitespace,
} from "./thinkingPolicy";
import type { ThoughtDedupeMode } from "./config";

/** 扣住的思考超过这么多字还没见正文：多半是一段长推敲恰好以问候开头，放行直播。 */
const THOUGHT_HOLD_CAP = 6000;
/** 判"正文是思考的复读"至少要对上这么多个非空白字（思考更短时对上整段思考即可）。 */
const THOUGHT_DEDUPE_PREFIX = 40;

interface OpenaiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenaiDelta {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
  /** DeepSeek / 多数中转站用这个字段回传思考文本。 */
  reasoning_content?: string | null;
  /** OpenRouter 等用这个字段。 */
  reasoning?: string | null;
  tool_calls?: OpenaiToolCallDelta[];
  /** 旧版 function_call（单函数），少数网关仍在用。 */
  function_call?: { name?: string; arguments?: string };
}

interface OpenaiChoice {
  index?: number;
  delta?: OpenaiDelta;
  /** 非流式回包时是 message 而不是 delta。 */
  message?: OpenaiDelta;
  finish_reason?: string | null;
}

interface OpenaiChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: OpenaiChoice[];
  usage?: Record<string, unknown> | null;
  /** 某些网关把错误塞进 200 的流里。 */
  error?: { message?: string; type?: string; code?: unknown };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  /** 已经作为 toolUseEvent 发出，避免 finish_reason 与 flush 重复发。 */
  emitted: boolean;
}

/**
 * Converts an OpenAI Chat Completions stream into Kiro's CodeWhisperer events.
 *
 * Protocol differences handled here versus the Anthropic converter:
 *  - text arrives as `choices[].delta.content` (a plain string) instead of
 *    `content_block_delta.text_delta`;
 *  - thinking arrives as the non-standard `reasoning_content` / `reasoning`
 *    field and carries no signature, so no signature event is emitted;
 *  - tool calls stream as `delta.tool_calls[]` where `function.arguments` is a
 *    string fragment keyed by `index`, and several may interleave, so fragments
 *    are accumulated per index rather than in a single slot;
 *  - the stream ends with a `data: [DONE]` sentinel;
 *  - usage appears once at the end (only when `stream_options.include_usage` is
 *    set) as `prompt_tokens` / `completion_tokens`.
 *
 * A gateway that ignores `stream: true` and answers with one non-streaming JSON
 * body is also handled: the raw text is buffered and parsed on flush.
 */
export class OpenaiStreamConverter implements StreamConverter {
  private conversationId: string;
  private modelId: string;

  private sentMetadata = false;
  private sawSseEvent = false;
  /** 攒起来的非 SSE 文本，用于兜底解析「无视 stream 参数」的整包 JSON 回复。 */
  private rawBuffer = "";

  private toolCalls = new Map<number, PendingToolCall>();
  private pendingContextPct: number | null = null;
  /** 流内 `{"error":…}` 帧；flush 时给用户一条 ❌ 文案，泵据此记失败 / 冷却凭证。 */
  public streamError: StreamError | undefined;
  /** ❌ 文案只发一次（flush 幂等）。 */
  private sentErrorNotice = false;
  /** 上游 finish_reason（stop / length / tool_calls …），flush 时翻成 Kiro 枚举发出。 */
  private finishReason: string | undefined;
  /**
   * 有工具的 arguments 没收全（非空却解析不了）。flush 以 MAX_TOKENS 收尾并给该 toolUse 标 stop:false，
   * Kiro 走原生 OutputTruncatedError（工具不执行、模型收到「拆小再试」）而不是拿 {} 去撞 schema 校验。
   */
  private truncatedTool = false;

  /**
   * 「思考里其实是一份完整回答」（见 thinkingPolicy.ts「三」）。流式过程中发出去的思考收不回，
   * 所以在**开头**就决定放不放：
   *   sniff   刚开始收思考，攒头几十个字看形态；
   *   live    开头是推敲（"The user…"），照常边收边发（也是 dedupe=off 的固定状态）；
   *   hold    开头像一份回答（问候 / 我是 Kiro / markdown / emoji），整段扣住，等正文来了比对；
   *   dropped 正文就是这段思考的复读（或流里只有思考、已提升为正文），思考不发。
   * 扣住期间正文也先攒几十个字再比（heldContent），比完一起放出，用户几乎感觉不到延迟。
   * 比对不上时原样补发思考（exact 模式），不丢任何文字；aggressive 模式才连"改写着再答一遍"的草稿一起丢。
   * 无论哪种模式，流结束时只有扣住的思考、没有正文 → 这段回答提升为正文，否则 Kiro 里是一个空回复。
   */
  private thoughtGate: "sniff" | "live" | "hold" | "dropped";
  private readonly dedupe: ThoughtDedupeMode;
  private heldReasoning = "";
  private heldContent = "";

  /** 流末形态检测用的全文（截 20K）：thoughtGate 放行了、但整段思考仍像回答时记 anomaly 让泵提示。 */
  private reasoningBuf = "";
  private contentBuf = "";
  public anomalies = new Set<string>();

  /**
   * 思考结束时要不要补一个合成签名。Kiro 只把**带签名**的思考留在历史里
   * （"Dropping unsigned reasoning from history"），而 GLM-5 / DeepSeek 这类家族要求下一轮把
   * reasoning_content 原样带回（见 thinkingPolicy.ts）。没有签名就没有历史，也就无从回传。
   * 其它模型不补：省得 Kiro 每轮把几 KB 思考塞进请求。
   */
  private echoReasoning: boolean;
  /** 当前是否正处在一段思考里（收到过 reasoning、还没见到正文 / 工具调用）。 */
  private reasoningOpen = false;

  public usage: CapturedUsage = emptyUsage();
  /** 本次响应是否发起了工具调用；泵用它判断轮次是否结束。 */
  public sawToolUse = false;

  constructor(
    conversationId: string,
    modelId: string,
    opts?: { echoReasoning?: boolean; thoughtDedupe?: ThoughtDedupeMode }
  ) {
    this.conversationId = conversationId;
    this.modelId = modelId;
    this.echoReasoning = !!opts?.echoReasoning;
    this.dedupe = opts?.thoughtDedupe || "exact";
    this.thoughtGate = this.dedupe === "off" ? "live" : "sniff";
  }

  processLine(line: string): CwEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    if (!trimmed.startsWith("data:")) {
      // SSE 注释行（": ping"）与 event:/id: 字段忽略；其余当作可能的整包 JSON 收集。
      if (!trimmed.startsWith(":") && !/^(event|id|retry):/i.test(trimmed)) {
        if (this.rawBuffer.length < 2_000_000) {
          this.rawBuffer += trimmed;
        }
      }
      return [];
    }
    const payload = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!payload || payload === "[DONE]") {
      return [];
    }
    let chunk: OpenaiChunk;
    try {
      chunk = JSON.parse(payload) as OpenaiChunk;
    } catch {
      return [];
    }
    this.sawSseEvent = true;
    return this.handleChunk(chunk);
  }

  private handleChunk(chunk: OpenaiChunk): CwEvent[] {
    const out: CwEvent[] = [];

    if (chunk.error) {
      const msg = chunk.error.message || JSON.stringify(chunk.error);
      // code 可能是数字（429 / 500）也可能是串（insufficient_quota / rate_limit_exceeded）：数字当状态码，串并入分类文本。
      const code = chunk.error.code;
      const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : undefined;
      const typeText = [chunk.error.type, typeof code === "string" && !/^\d{3}$/.test(code) ? code : ""].filter(Boolean).join(" ");
      this.streamError = { message: String(msg), type: typeText || undefined, status: numeric };
      return out;
    }

    if (!this.sentMetadata) {
      this.sentMetadata = true;
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
    }

    if (chunk.usage) {
      this.captureUsage(chunk.usage);
    }

    for (const choice of chunk.choices || []) {
      // 流式是 delta；非流式(或某些网关的最后一帧)是 message。两者字段同构。
      const d = choice.delta || choice.message;
      if (d) {
        out.push(...this.handleDelta(d));
      }
      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason;
        out.push(...this.emitToolCalls());
      }
    }

    return out;
  }

  private handleDelta(d: OpenaiDelta): CwEvent[] {
    const out: CwEvent[] = [];

    // 思考文本：OpenAI 协议没有统一字段，reasoning_content(DeepSeek 系) 与
    // reasoning(OpenRouter 系) 都收。先处理思考再处理正文——同一个 delta 里两者并存时
    // （个别网关的收尾帧），思考在逻辑上先于正文。
    const reasoning =
      typeof d.reasoning_content === "string" && d.reasoning_content
        ? d.reasoning_content
        : typeof d.reasoning === "string" && d.reasoning
        ? d.reasoning
        : "";
    if (reasoning) {
      if (this.reasoningBuf.length < 20000) {
        this.reasoningBuf += reasoning;
      }
      this.reasoningOpen = true;
      out.push(...this.gateReasoning(reasoning));
    }

    const text = normalizeContent(d.content);
    const hasToolDelta = (d.tool_calls && d.tool_calls.length > 0) || !!d.function_call;
    if (text && this.contentBuf.length < 20000) {
      this.contentBuf += text;
    }
    if ((text || hasToolDelta) && this.heldReasoning) {
      // 思考正被扣着，正文 / 工具调用一到就该定夺。工具调用没有正文可比，扣住的思考原样放行。
      this.heldContent += text;
      const verdict = hasToolDelta ? "release" : this.judgeHeld();
      if (verdict === "wait") {
        return out;
      }
      out.push(...this.settleHeld(verdict));
    } else {
      // 正文或工具调用一到，这段思考就算结束了（对应 Anthropic 的 content_block_stop）。
      if ((text || hasToolDelta) && this.reasoningOpen) {
        out.push(...this.closeReasoning());
      }
      if (text) {
        out.push({ assistantResponseEvent: { content: text, modelId: this.modelId } });
      }
    }

    for (const tc of d.tool_calls || []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let pending = this.toolCalls.get(idx);
      if (!pending) {
        pending = { id: "", name: "", args: "", emitted: false };
        this.toolCalls.set(idx, pending);
      }
      if (tc.id) {
        pending.id = tc.id;
      }
      if (tc.function?.name) {
        // 名字通常一次给全，但个别网关也分片，故用累加而非赋值。
        pending.name += tc.function.name;
      }
      if (typeof tc.function?.arguments === "string") {
        pending.args += tc.function.arguments;
      }
    }

    // 旧式 function_call（单函数，无 index）：映射到 index 0。
    if (d.function_call) {
      let pending = this.toolCalls.get(0);
      if (!pending) {
        pending = { id: "", name: "", args: "", emitted: false };
        this.toolCalls.set(0, pending);
      }
      if (d.function_call.name) {
        pending.name += d.function_call.name;
      }
      if (typeof d.function_call.arguments === "string") {
        pending.args += d.function_call.arguments;
      }
    }

    return out;
  }

  /** 一段新到的思考文本：直播、攒着看开头、或整段扣住（见 thoughtGate 的说明）。 */
  private gateReasoning(text: string): CwEvent[] {
    if (this.thoughtGate === "live" || this.thoughtGate === "dropped") {
      return [{ reasoningContentEvent: { text } }];
    }
    this.heldReasoning += text;
    if (this.thoughtGate === "sniff") {
      const kind = classifyReasoningHead(this.heldReasoning);
      if (kind === "deliberation") {
        this.thoughtGate = "live";
        return this.releaseHeld();
      }
      if (kind === "answer") {
        this.thoughtGate = "hold";
      } else if (this.heldReasoning.length >= REASONING_SNIFF_MIN * 4) {
        // 攒了很多仍两边都不像：别再拖着了，按推敲放行
        this.thoughtGate = "live";
        return this.releaseHeld();
      }
    }
    if (this.thoughtGate === "hold" && this.heldReasoning.length > THOUGHT_HOLD_CAP) {
      this.thoughtGate = "live";
      return this.releaseHeld();
    }
    return [];
  }

  /** 把扣住的思考原样发出去（不收束——调用方决定何时 closeReasoning）。 */
  private releaseHeld(): CwEvent[] {
    const text = this.heldReasoning;
    this.heldReasoning = "";
    return text ? [{ reasoningContentEvent: { text } }] : [];
  }

  /**
   * 正文来了，扣住的思考怎么办：
   *   drop    正文开头就是思考开头（去空白后对上 THOUGHT_DEDUPE_PREFIX 个字，思考更短则对上整段）——模型把
   *           回答先写进了思考通道又抄了一遍，思考丢掉；
   *   wait    正文还太短、目前为止仍对得上，再攒；
   *   release 对不上：exact 模式原样补发思考；aggressive 模式下开头像回答的思考照样丢（草稿改写着再答）。
   */
  private judgeHeld(): "drop" | "wait" | "release" {
    const r = squashWhitespace(this.heldReasoning);
    const c = squashWhitespace(this.heldContent);
    if (!c) {
      return "wait";
    }
    const need = Math.min(THOUGHT_DEDUPE_PREFIX, r.length);
    if (c.length < need) {
      return r.startsWith(c) ? "wait" : this.releaseOrDrop();
    }
    return r.startsWith(c.slice(0, need)) ? "drop" : this.releaseOrDrop();
  }

  private releaseOrDrop(): "drop" | "release" {
    // 只有确认过"开头像回答"（hold）的才允许 aggressive 丢；还在 sniff 的短思考一律放行。
    return this.dedupe === "aggressive" && this.thoughtGate === "hold" ? "drop" : "release";
  }

  /**
   * 执行定夺并把攒着的正文一并放出。promote = 流结束了只有思考没正文，且这段像回答：
   * 提升为正文（模型把答案写在 think 里没再答一遍；不提升 Kiro 里就是个空回复）。
   */
  private settleHeld(verdict: "drop" | "release" | "promote"): CwEvent[] {
    const out: CwEvent[] = [];
    const reasoning = this.heldReasoning;
    const content = this.heldContent;
    this.heldReasoning = "";
    this.heldContent = "";
    if (verdict === "release") {
      this.thoughtGate = "live";
      out.push({ reasoningContentEvent: { text: reasoning } });
      out.push(...this.closeReasoning());
    } else {
      // 思考一个字都没发过，也就不补签名（孤零零一个签名帧 Kiro 存不出有意义的历史）
      this.thoughtGate = "dropped";
      this.reasoningOpen = false;
      if (verdict === "promote") {
        this.anomalies.add("thought_promoted_to_content");
        out.push({ assistantResponseEvent: { content: reasoning, modelId: this.modelId } });
      } else {
        this.anomalies.add("duplicate_thought_dropped");
      }
    }
    if (content) {
      out.push({ assistantResponseEvent: { content, modelId: this.modelId } });
    }
    return out;
  }

  /**
   * 收束一段思考。要回传的家族补一个合成签名帧（与 Anthropic 转换器在 content_block_stop 时发
   * signature 的形状一致），Kiro 据此把这段思考连同签名存进历史；下一轮 openaiTranslate 认出
   * 合成签名后把原文放回 assistant.reasoning_content。
   */
  private closeReasoning(): CwEvent[] {
    this.reasoningOpen = false;
    if (!this.echoReasoning) {
      return [];
    }
    return [{ reasoningContentEvent: { signature: SYNTHETIC_REASONING_SIGNATURE } }];
  }

  /**
   * Emit every accumulated tool call exactly once.
   * 参数没收全的调用照常发出（Kiro 历史里要有这次调用的痕迹，模型才拿得到 OutputTruncatedError 的拆分指导），
   * 但标 stop:false 并记 truncatedTool → flush 发 MAX_TOKENS；input 仍降级为 {}（即便 Kiro 侧防线失效也过不了 schema）。
   */
  private emitToolCalls(): CwEvent[] {
    const out: CwEvent[] = [];
    const indices = [...this.toolCalls.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const tc = this.toolCalls.get(idx)!;
      if (tc.emitted || !tc.name) {
        continue;
      }
      tc.emitted = true;
      this.sawToolUse = true;
      const truncated = isTruncatedToolInput(tc.args);
      if (truncated) {
        this.truncatedTool = true;
      }
      out.push({
        toolUseEvent: {
          toolUseId: tc.id || `call_${this.conversationId}_${idx}`,
          name: tc.name,
          input: validJsonOrEmpty(tc.args),
          ...(truncated ? { stop: false } : {}),
        },
      });
    }
    return out;
  }

  private captureUsage(u: Record<string, unknown>): void {
    const prompt = num(u.prompt_tokens ?? u.input_tokens);
    const completion = num(u.completion_tokens ?? u.output_tokens);
    if (prompt > 0) {
      // prompt_tokens 已含被缓存命中的部分（cached_tokens 是它的子集），因此
      // inputTokens 直接取 prompt_tokens，cacheRead 只作为「其中多少命中缓存」
      // 单独记录，不再累加进输入总量，避免页脚重复计数。
      this.usage.inputTokens = prompt;
      this.pendingContextPct = contextUsagePercentFloat(prompt, this.modelId);
    }
    // reasoning 模型的思考 token 可能不计入 completion_tokens（本中转站即如此），
    // 用 total-prompt 反推才拿得到真实输出。详见 resolveOutputTokens。
    const realOut = resolveOutputTokens(u);
    if (realOut > 0) {
      this.usage.outputTokens = realOut;
    } else if (completion > 0) {
      this.usage.outputTokens = completion;
    }
    const details = u.prompt_tokens_details;
    if (details && typeof details === "object") {
      const cached = num((details as Record<string, unknown>).cached_tokens);
      if (cached > 0) {
        this.usage.cacheReadTokens = cached;
      }
    }
    // 部分中转站直接透出 Anthropic 口径的缓存字段。
    const altRead = num(u.cache_read_input_tokens);
    if (altRead > 0) {
      this.usage.cacheReadTokens = altRead;
    }
    const altWrite = num(u.cache_creation_input_tokens);
    if (altWrite > 0) {
      this.usage.cacheCreationTokens = altWrite;
    }
  }

  flush(): CwEvent[] {
    const out: CwEvent[] = [];

    // 兜底：网关无视 stream:true，整包 JSON 一次返回（没有任何 SSE 帧）。
    if (!this.sawSseEvent && this.rawBuffer.trim()) {
      try {
        const chunk = JSON.parse(this.rawBuffer.trim()) as OpenaiChunk;
        if (chunk && (chunk.choices || chunk.usage || chunk.error)) {
          this.sawSseEvent = true;
          out.push(...this.handleChunk(chunk));
        }
      } catch {
        /* 不是完整 JSON，忽略 */
      }
    }
    this.rawBuffer = "";

    if (!this.sentMetadata) {
      this.sentMetadata = true;
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
    }

    // 流结束了思考还扣着。有正文：按正文定夺（正文比 40 字还短就只在整段对上时才算复读）；
    // 没正文：开头像回答的提升为正文，否则按思考放行。
    if (this.heldReasoning) {
      let verdict: "drop" | "release" | "promote";
      if (this.heldContent) {
        const j = this.judgeHeld();
        // 正文是思考的一个短前缀：finish=length 说明是正文被截了、思考里才是全文，放行；正常结束则正文就是最终答案，思考丢
        verdict =
          j === "wait"
            ? this.finishReason !== "length" && squashWhitespace(this.heldContent).length >= 8
              ? "drop"
              : "release"
            : j;
      } else if (this.thoughtGate === "hold" || classifyReasoningHead(this.heldReasoning) === "answer") {
        verdict = "promote";
      } else {
        verdict = "release";
      }
      out.push(...this.settleHeld(verdict));
    }

    // 只思考没正文就结束的流（被截断、或模型只想不答）：思考段也要收束。
    if (this.reasoningOpen) {
      out.push(...this.closeReasoning());
    }

    out.push(...this.emitToolCalls());

    if (this.streamError && !this.sentErrorNotice) {
      this.sentErrorNotice = true;
      out.push(streamErrorNotice(this.streamError, this.modelId));
    }

    if (this.pendingContextPct !== null) {
      out.push({ contextUsageEvent: { contextUsagePercentage: this.pendingContextPct } });
      this.pendingContextPct = null;
    }

    // metadataEvent 需要「未命中缓存的输入」，OpenAI 侧 = prompt_tokens - cached_tokens。
    const uncachedIn = Math.max(0, this.usage.inputTokens - this.usage.cacheReadTokens);
    if (uncachedIn > 0 || this.usage.outputTokens > 0) {
      out.push({
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: uncachedIn,
            outputTokens: this.usage.outputTokens,
            cacheReadInputTokens: this.usage.cacheReadTokens,
            cacheWriteInputTokens: this.usage.cacheCreationTokens,
          },
        },
      });
    }
    // 结束原因必发（见 streamShared.toCwStopReason 的说明）。有工具参数没收全 → 视同 finish_reason=length 截断。
    out.push(stopReasonEvent(toCwStopReason(this.truncatedTool ? "length" : this.finishReason, this.sawToolUse)));

    // 闸门已经处理掉的（丢了复读 / 提升成正文）不再当异常提示；放行了但整段仍像回答的才提示
    if (
      !this.anomalies.has("duplicate_thought_dropped") &&
      !this.anomalies.has("thought_promoted_to_content") &&
      reasoningLooksLikeAnswer(this.reasoningBuf, this.contentBuf)
    ) {
      this.anomalies.add("answer_in_reasoning");
    }
    this.reasoningBuf = "";
    this.contentBuf = "";

    // 页脚用量不在这里发：整轮累计由 krsServer 在轮末统一结算（turnLedger.ts）。
    return out;
  }

  /**
   * 计费口径的用量。OpenAI 的 `prompt_tokens` 本身就是完整输入（cached_tokens 是
   * 它的子集），所以缓存字段置零后再交出去，否则会把命中缓存的部分重复加一遍。
   * `usage` 本身保持原样，缓存命中率统计还要用。
   */
  meteringUsage(): CapturedUsage {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  /** 账本口径：prompt_tokens 减去缓存命中（cached_tokens / 中转透出的 cache_* 字段）才是未命中输入。 */
  ledgerUsage(): CapturedUsage {
    return splitCachedInput(this.usage);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 思考段是不是一份写给用户看的回答（GLM 在 vLLM/SGLang 上的误路由：think 结束标记被吃掉，
 * 模型的正式回答整段留在 reasoning_content 里，然后又在 content 里答一遍）。
 *
 * 文本相似度走不通：模型两次生成的措辞差异很大（实测同一案例 8 字滑窗重合只有 13%），和真思考
 * 与正文的重合度（5%）拉不开。改用**形态**特征——真正的思考是写给自己的草稿，不会排版；回答是
 * 写给人看的，会排版：
 *   - markdown 列表项 / 粗体 / 标题（`- **xx**：`、`1. `、`## `）
 *   - emoji（👋 😄 ✅）
 *   - 结尾向用户提问或给行动建议（"？" / "吗" / "告诉我" / "随时"）
 *   - 而且正文也不短（模型确实又答了一遍；如果 content 为空那是另一种毛病）
 * 三项排版特征命中 ≥ 2 项且思考长度 ≥ 120 有效字，即判定。真思考里偶有一个列表或一个问号，
 * 但很少同时排版 + 表情 + 对话式收尾。
 */
export function reasoningLooksLikeAnswer(reasoning: string, content: string): boolean {
  const r = reasoning || "";
  const c = content || "";
  if (r.replace(/\s+/g, "").length < 120 || c.replace(/\s+/g, "").length < 40) {
    return false;
  }
  let score = 0;
  // 1) markdown 排版：≥ 2 个列表项 / 粗体 / 标题
  const mdMarks = (r.match(/(^|\n)\s*(?:[-*•]\s|\d+[.、)]\s|#{1,3}\s)/g) || []).length + (r.match(/\*\*[^*\n]{1,40}\*\*/g) || []).length;
  if (mdMarks >= 2) {
    score++;
  }
  // 2) emoji（Extended_Pictographic 覆盖绝大多数表情，排除 © ® 之类符号）
  if (/\p{Extended_Pictographic}/u.test(r)) {
    score++;
  }
  // 3) 对话式收尾：最后 120 字里向用户提问 / 给行动建议
  const tail = r.slice(-120);
  if (/[?？]\s*$|吗[？?]?\s*$|告诉我|随时|欢迎|请(先|打开|告诉)|feel free|let me know|just ask/i.test(tail)) {
    score++;
  }
  // 4) 第二人称开场：真思考多以 "The user…" / "用户…" 开头，回答以 "你好" / "Hi" 开头
  const head = r.trimStart().slice(0, 30);
  if (/^(你好|您好|嗨|哈喽|hi\b|hello\b|hey\b|好的|当然|没问题|看来)/i.test(head)) {
    score++;
  }
  return score >= 2;
}

/** `delta.content` is normally a string, but a few gateways send content parts. */
function normalizeContent(c: OpenaiDelta["content"]): string {
  if (typeof c === "string") {
    return c;
  }
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * Kiro expects tool input as a JSON object string. Streamed `arguments`
 * fragments can end up empty or truncated when a gateway cuts the stream, so an
 * unparseable payload degrades to `{}` rather than propagating broken JSON into
 * the agent loop. 截断本身另由 isTruncatedToolInput 判定并以 stop:false + MAX_TOKENS 告知 Kiro
 * （工具不执行）；这里的 {} 只是第二道保险——万一 Kiro 侧仍去执行，空对象过不了必填字段的 schema 校验。
 */
function validJsonOrEmpty(args: string): string {
  const s = (args || "").trim();
  if (!s) {
    return "{}";
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") {
      return s;
    }
    return "{}";
  } catch {
    return "{}";
  }
}
