/**
 * OpenAI Responses API 的 SSE 流 → Kiro CodeWhisperer 事件。
 *
 * Responses 的流是「类型化事件」而不是 chat 那种 choices[].delta：
 *   response.output_text.delta              {item_id, delta}          正文增量
 *   response.reasoning_summary_text.delta   {item_id, delta}          推理摘要增量（还有 reasoning_text.delta /
 *   response.reasoning_summary.delta                                   reasoning_summary.delta 两个变体，同样处理）
 *   response.reasoning_summary_part.done    {item_id}                 一段摘要结束：同 item 下一段到来前补 "\n\n"
 *   response.reasoning_summary_text.done                               （否则多段 `**标题**` 会首尾相接）
 *   response.output_item.added              {item}                    新 item 开始：function_call 在这里给 call_id/name
 *   response.function_call_arguments.delta  {item_id, delta}          参数 JSON 增量（按 item_id 累加）
 *   response.function_call_arguments.done   {item_id, arguments}      参数完整串（有则以此为准）
 *   response.output_item.done               {item}                    item 结束：function_call → 发 toolUseEvent；
 *                                                                      reasoning → 拿 encrypted_content 当签名发出
 *   response.completed / .incomplete        {response:{usage}}        结束 + 用量
 *   response.failed / error                 {response:{error}} / {message}
 *
 * 推理签名：把 encrypted_content 以 "a2k-rs:" 前缀作为 reasoningContentEvent.signature 发给 Kiro，
 * Kiro 会连同推理文本存进历史，下一轮 responsesTranslate 解出来回放成 reasoning item。
 *
 * 也兜底「无视 stream:true、整包 JSON 一次返回」的网关：把非 SSE 文本攒起来在 flush 时按
 * Response 对象解析（output[] 里的 message/function_call/reasoning + usage）。
 */

import { CwEvent } from "./cwTypes";
import { encodeReasoningSignature } from "./responsesTranslate";
import {
  CapturedUsage,
  StreamConverter,
  contextUsagePercentFloat,
  emptyUsage,
  splitCachedInput,
  stopReasonEvent,
  toCwStopReason,
} from "./streamShared";

interface RItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: Array<{ type?: string; text?: string }>;
  content?: Array<{ type?: string; text?: string }>;
  role?: string;
}

interface RUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface REvent {
  type?: string;
  item_id?: string;
  delta?: string;
  arguments?: string;
  item?: RItem;
  response?: {
    id?: string;
    status?: string;
    usage?: RUsage | null;
    output?: RItem[];
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
  /** 顶层 error 事件 */
  code?: string;
  message?: string;
  error?: { code?: string; message?: string };
}

interface PendingCall {
  callId: string;
  name: string;
  args: string;
  emitted: boolean;
}

/** 多段推理摘要之间的分隔（流式按段补发；整段 `summary[]` 也用它连接）。 */
export const SUMMARY_PART_SEPARATOR = "\n\n";

function joinSummary(summary: RItem["summary"]): string {
  return (summary || [])
    .map((s) => (typeof s.text === "string" ? s.text : ""))
    .filter(Boolean)
    .join(SUMMARY_PART_SEPARATOR);
}

export class ResponsesStreamConverter implements StreamConverter {
  private conversationId: string;
  private modelId: string;

  private sentMetadata = false;
  private sawSseEvent = false;
  private rawBuffer = "";

  /** 按 item_id 累加的函数调用。 */
  private calls = new Map<string, PendingCall>();
  private order: string[] = [];
  /** 每个 reasoning item 是否已发过任何文本（决定签名是否值得发）。 */
  private reasoningSeen = new Set<string>();
  /**
   * 已经收完一段摘要（summary_part.done / summary_text.done）的 reasoning item：同一 item 再来摘要增量时
   * 先补一个段落分隔。OpenAI 把多段摘要拆成多个 summary part，各段都是 `**标题**` 起头，不分隔会拼成
   * `**标题A****标题B**`。分隔放在下一段真正到来时才发，段末不会多出悬空换行。
   */
  private summaryPartClosed = new Set<string>();
  /** 是否收到过正文 delta；没收到时才用 output_item.done(message) 里的整段文本兜底。 */
  private sawTextDelta = false;
  private pendingContextPct: number | null = null;
  private errorText = "";
  private incompleteReason = "";

  public usage: CapturedUsage = emptyUsage();
  public sawToolUse = false;

  constructor(conversationId: string, modelId: string) {
    this.conversationId = conversationId;
    this.modelId = modelId;
  }

  processLine(line: string): CwEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    if (!trimmed.startsWith("data:")) {
      // event: 行在 Responses 里与 data.type 重复，忽略；其余当整包 JSON 候选攒着。
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
    let ev: REvent;
    try {
      ev = JSON.parse(payload) as REvent;
    } catch {
      return [];
    }
    this.sawSseEvent = true;
    return this.handleEvent(ev);
  }

  private meta(out: CwEvent[]): void {
    if (!this.sentMetadata) {
      this.sentMetadata = true;
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
    }
  }

  private handleEvent(ev: REvent): CwEvent[] {
    const out: CwEvent[] = [];
    const t = ev.type || "";

    if (t === "error" || t === "response.failed") {
      const err = ev.error || ev.response?.error;
      const msg = ev.message || err?.message || "";
      const code = ev.code || err?.code || "";
      this.errorText = msg && code ? `${code}: ${msg}` : msg || code || "response failed";
      return out;
    }

    this.meta(out);

    if (t === "response.output_text.delta") {
      if (ev.delta) {
        this.sawTextDelta = true;
        out.push({ assistantResponseEvent: { content: ev.delta, modelId: this.modelId } });
      }
      return out;
    }

    if (
      t === "response.reasoning_summary_text.delta" ||
      t === "response.reasoning_text.delta" ||
      t === "response.reasoning_summary.delta"
    ) {
      if (ev.delta) {
        const key = ev.item_id || "";
        if (this.summaryPartClosed.delete(key)) {
          out.push({ reasoningContentEvent: { text: SUMMARY_PART_SEPARATOR } });
        }
        this.reasoningSeen.add(key);
        out.push({ reasoningContentEvent: { text: ev.delta } });
      }
      return out;
    }

    if (t === "response.reasoning_summary_part.done" || t === "response.reasoning_summary_text.done") {
      // 一段摘要收完；只有这个 item 确实发过文本时才记，免得给"没有正文只有签名"的 item 凭空补分隔
      const key = ev.item_id || "";
      if (this.reasoningSeen.has(key)) {
        this.summaryPartClosed.add(key);
      }
      return out;
    }

    if (t === "response.output_item.added") {
      const item = ev.item;
      if (item?.type === "function_call" && item.id) {
        this.startCall(item.id, item.call_id || "", item.name || "", item.arguments || "");
      }
      return out;
    }

    if (t === "response.function_call_arguments.delta") {
      if (ev.item_id && ev.delta) {
        const c = this.calls.get(ev.item_id) || this.startCall(ev.item_id, "", "", "");
        c.args += ev.delta;
      }
      return out;
    }

    if (t === "response.function_call_arguments.done") {
      if (ev.item_id && typeof ev.arguments === "string") {
        const c = this.calls.get(ev.item_id) || this.startCall(ev.item_id, "", "", "");
        c.args = ev.arguments;
      }
      return out;
    }

    if (t === "response.output_item.done") {
      const item = ev.item;
      if (!item) {
        return out;
      }
      if (item.type === "function_call") {
        const key = item.id || item.call_id || `fc_${this.order.length}`;
        const c = this.calls.get(key) || this.startCall(key, "", "", "");
        if (item.call_id) {
          c.callId = item.call_id;
        }
        if (item.name) {
          c.name = item.name;
        }
        if (typeof item.arguments === "string" && item.arguments) {
          c.args = item.arguments;
        }
        out.push(...this.emitCall(key));
      } else if (item.type === "reasoning") {
        // 摘要文本若没走 delta（部分网关只在 done 里给 summary），这里补发一次。
        if (item.id && !this.reasoningSeen.has(item.id)) {
          const text = joinSummary(item.summary);
          if (text) {
            this.reasoningSeen.add(item.id);
            out.push({ reasoningContentEvent: { text } });
          }
        }
        if (typeof item.encrypted_content === "string" && item.encrypted_content) {
          // 没有任何文本也要发签名：Kiro 存历史要求 text 非空，空文本的签名会被丢，
          // 给一个占位空格保住 encrypted_content 的回放能力。
          if (!item.id || !this.reasoningSeen.has(item.id)) {
            out.push({ reasoningContentEvent: { text: " " } });
          }
          out.push({ reasoningContentEvent: { signature: encodeReasoningSignature(item.encrypted_content) } });
        }
      } else if (item.type === "message" && Array.isArray(item.content) && !this.sawTextDelta) {
        // 只在从未收到过 text.delta 时才用 done 里的整段文本（有的网关不发 delta）。
        const text = item.content.map((c) => (typeof c.text === "string" ? c.text : "")).join("");
        if (text) {
          out.push({ assistantResponseEvent: { content: text, modelId: this.modelId } });
        }
      }
      return out;
    }

    if (t === "response.completed" || t === "response.incomplete") {
      if (ev.response?.usage) {
        this.captureUsage(ev.response.usage);
      }
      if (t === "response.incomplete") {
        this.incompleteReason = ev.response?.incomplete_details?.reason || "incomplete";
      }
      // 收尾：所有还没发的函数调用都发出去。
      for (const key of this.order) {
        out.push(...this.emitCall(key));
      }
      return out;
    }

    return out;
  }

  private startCall(key: string, callId: string, name: string, args: string): PendingCall {
    const c: PendingCall = { callId, name, args, emitted: false };
    this.calls.set(key, c);
    this.order.push(key);
    return c;
  }

  private emitCall(key: string): CwEvent[] {
    const c = this.calls.get(key);
    if (!c || c.emitted || !c.name) {
      return [];
    }
    c.emitted = true;
    this.sawToolUse = true;
    return [
      {
        toolUseEvent: {
          toolUseId: c.callId || key,
          name: c.name,
          input: validJsonOrEmpty(c.args),
        },
      },
    ];
  }

  private captureUsage(u: RUsage): void {
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    if (input > 0) {
      // Responses 的 input_tokens 已含缓存命中部分（cached_tokens 是子集），与 chat 同口径。
      this.usage.inputTokens = input;
      this.pendingContextPct = contextUsagePercentFloat(input, this.modelId);
    }
    // output_tokens 在 Responses 里已含 reasoning_tokens（官方文档），不用再反推。
    if (output > 0) {
      this.usage.outputTokens = output;
    }
    const cached = num(u.input_tokens_details?.cached_tokens);
    if (cached > 0) {
      this.usage.cacheReadTokens = cached;
    }
  }

  flush(): CwEvent[] {
    const out: CwEvent[] = [];

    // 兜底：网关无视 stream:true，整包 Response 对象一次返回。
    if (!this.sawSseEvent && this.rawBuffer.trim()) {
      try {
        const resp = JSON.parse(this.rawBuffer.trim()) as NonNullable<REvent["response"]> & { object?: string };
        if (resp && (Array.isArray(resp.output) || resp.usage || resp.error)) {
          this.sawSseEvent = true;
          this.meta(out);
          if (resp.error) {
            this.errorText = resp.error.message || resp.error.code || "response failed";
          }
          for (const item of resp.output || []) {
            if (item.type === "message") {
              const text = (item.content || []).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
              if (text) {
                out.push({ assistantResponseEvent: { content: text, modelId: this.modelId } });
              }
            } else if (item.type === "function_call") {
              const key = item.id || item.call_id || `fc_${this.order.length}`;
              this.startCall(key, item.call_id || "", item.name || "", item.arguments || "");
              out.push(...this.emitCall(key));
            } else if (item.type === "reasoning") {
              const text = joinSummary(item.summary);
              if (text || item.encrypted_content) {
                out.push({ reasoningContentEvent: { text: text || " " } });
              }
              if (typeof item.encrypted_content === "string" && item.encrypted_content) {
                out.push({ reasoningContentEvent: { signature: encodeReasoningSignature(item.encrypted_content) } });
              }
            }
          }
          if (resp.usage) {
            this.captureUsage(resp.usage);
          }
        }
      } catch {
        /* 不是完整 JSON，忽略 */
      }
    }
    this.rawBuffer = "";

    this.meta(out);
    for (const key of this.order) {
      out.push(...this.emitCall(key));
    }

    if (this.errorText) {
      out.push({
        assistantResponseEvent: {
          content: `\n\n❌ 上游在流中返回错误：${this.errorText.slice(0, 800)}`,
          modelId: this.modelId,
        },
      });
      this.errorText = "";
    }
    const truncated = this.incompleteReason === "max_output_tokens";
    if (truncated) {
      out.push({
        assistantResponseEvent: { content: "\n\n⚠️ 输出达到 max_output_tokens 上限被截断。", modelId: this.modelId },
      });
      this.incompleteReason = "";
    }

    if (this.pendingContextPct !== null) {
      out.push({ contextUsageEvent: { contextUsagePercentage: this.pendingContextPct } });
      this.pendingContextPct = null;
    }

    const uncachedIn = Math.max(0, this.usage.inputTokens - this.usage.cacheReadTokens);
    if (uncachedIn > 0 || this.usage.outputTokens > 0) {
      out.push({
        metadataEvent: {
          tokenUsage: {
            uncachedInputTokens: uncachedIn,
            outputTokens: this.usage.outputTokens,
            cacheReadInputTokens: this.usage.cacheReadTokens,
            cacheWriteInputTokens: 0,
          },
        },
      });
    }
    // 结束原因必发（见 streamShared.toCwStopReason 的说明）
    out.push(stopReasonEvent(toCwStopReason(truncated ? "max_tokens" : "stop", this.sawToolUse)));
    return out;
  }

  /** 计费口径：input_tokens 已含缓存命中，缓存字段清零避免重复计（同 chat）。 */
  meteringUsage(): CapturedUsage {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  /** 账本口径：input_tokens 减去 input_tokens_details.cached_tokens 才是未命中输入。 */
  ledgerUsage(): CapturedUsage {
    return splitCachedInput(this.usage);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function validJsonOrEmpty(args: string): string {
  const s = (args || "").trim();
  if (!s) {
    return "{}";
  }
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? s : "{}";
  } catch {
    return "{}";
  }
}
