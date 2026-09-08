/**
 * Gemini generateContent 的 SSE 流 → Kiro CodeWhisperer 事件。
 *
 * 每帧 `data: {...}` 是一个 GenerateContentResponse 片段（Antigravity 外面多包一层 {"response":{...}}）：
 *   candidates[0].content.parts[]   {text}                         正文增量
 *                                   {text, thought:true}           思考增量
 *                                   {functionCall:{id,name,args}}  工具调用（一次给全，不分片）
 *                                   任一部件可带 thoughtSignature
 *   candidates[0].finishReason      STOP / MAX_TOKENS / SAFETY / …
 *   usageMetadata                   promptTokenCount（含缓存）/ candidatesTokenCount / thoughtsTokenCount / cachedContentTokenCount
 *   error                           {code,message,status}（流中报错）
 *
 * 签名：流里各部件上的 thoughtSignature 收齐后在 flush 时发一个 reasoningContentEvent.signature
 * （"a2k-gm:" 前缀），优先取第一个 functionCall 上的——Gemini 3 校验的就是它；Kiro 把它连同思考文本
 * 存进历史，下一轮 geminiTranslate 解出来贴回第一个 functionCall。
 *
 * 也兜底非 SSE 的整包 JSON（对象或数组）：flush 时按片段逐个处理。
 */

import { CwEvent } from "./cwTypes";
import { encodeGeminiSignature } from "./geminiTranslate";
import { CapturedUsage, StreamConverter, StreamError, contextUsagePercentFloat, emptyUsage, splitCachedInput, stopReasonEvent, streamErrorNotice, toCwStopReason } from "./streamShared";

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  inlineData?: { mimeType?: string; data?: string };
}

interface GChunk {
  candidates?: Array<{ content?: { role?: string; parts?: GPart[] }; finishReason?: string; finishMessage?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  error?: { code?: number; message?: string; status?: string };
  /** Antigravity 信封 */
  response?: GChunk;
}

export class GeminiStreamConverter implements StreamConverter {
  private conversationId: string;
  private modelId: string;

  private sentMetadata = false;
  private sawSseEvent = false;
  private rawBuffer = "";
  private sawReasoningText = false;
  private callSeq = 0;
  /** 收到的签名：functionCall 上的优先 */
  private callSignature = "";
  private anySignature = "";
  private finishReason = "";
  /** 流内 `{"error":…}` 帧；flush 时给用户一条 ❌ 文案，泵据此记失败 / 冷却凭证。 */
  public streamError: StreamError | undefined;
  /** promptFeedback.blockReason 的提示（内容策略拦截，不是凭证的错，只提示不记失败）。 */
  private blockedText = "";
  /** ❌ 文案只发一次（flush 幂等）。 */
  private sentErrorNotice = false;
  private pendingContextPct: number | null = null;

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
      if (!trimmed.startsWith(":") && !/^(event|id|retry):/i.test(trimmed) && this.rawBuffer.length < 4_000_000) {
        this.rawBuffer += trimmed;
      }
      return [];
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return [];
    }
    let chunk: GChunk;
    try {
      chunk = JSON.parse(payload) as GChunk;
    } catch {
      return [];
    }
    this.sawSseEvent = true;
    return this.handleChunk(chunk);
  }

  private meta(out: CwEvent[]): void {
    if (!this.sentMetadata) {
      this.sentMetadata = true;
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
    }
  }

  private handleChunk(raw: GChunk): CwEvent[] {
    const out: CwEvent[] = [];
    const chunk = raw.response && typeof raw.response === "object" ? raw.response : raw;
    if (chunk.error) {
      const e = chunk.error;
      this.streamError = {
        message: [e.code ? String(e.code) : "", e.status || "", e.message || ""].filter(Boolean).join(" ") || "upstream error",
        type: e.status || undefined,
        status: typeof e.code === "number" ? e.code : undefined,
      };
      return out;
    }
    this.meta(out);
    if (chunk.promptFeedback?.blockReason) {
      this.blockedText = `prompt blocked: ${chunk.promptFeedback.blockReason}${chunk.promptFeedback.blockReasonMessage ? " - " + chunk.promptFeedback.blockReasonMessage : ""}`;
    }
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      const sig = typeof part.thoughtSignature === "string" ? part.thoughtSignature : typeof part.thought_signature === "string" ? part.thought_signature : "";
      if (part.functionCall && part.functionCall.name) {
        if (sig && !this.callSignature) {
          this.callSignature = sig;
        }
        this.sawToolUse = true;
        const id = part.functionCall.id || `${part.functionCall.name}-${Date.now().toString(36)}-${++this.callSeq}`;
        out.push({ toolUseEvent: { toolUseId: id, name: part.functionCall.name, input: stringifyArgs(part.functionCall.args) } });
        continue;
      }
      if (sig && !this.anySignature) {
        this.anySignature = sig;
      }
      if (typeof part.text === "string" && part.text) {
        if (part.thought) {
          this.sawReasoningText = true;
          out.push({ reasoningContentEvent: { text: part.text } });
        } else {
          out.push({ assistantResponseEvent: { content: part.text, modelId: this.modelId } });
        }
      }
    }
    if (cand?.finishReason) {
      this.finishReason = cand.finishReason;
    }
    if (chunk.usageMetadata) {
      this.captureUsage(chunk.usageMetadata);
    }
    return out;
  }

  private captureUsage(u: NonNullable<GChunk["usageMetadata"]>): void {
    const prompt = num(u.promptTokenCount);
    const cached = num(u.cachedContentTokenCount);
    const out = num(u.candidatesTokenCount) + num(u.thoughtsTokenCount);
    if (prompt > 0) {
      this.usage.inputTokens = prompt;
      this.pendingContextPct = contextUsagePercentFloat(prompt, this.modelId);
    }
    if (cached > 0) {
      this.usage.cacheReadTokens = cached;
    }
    if (out > 0) {
      this.usage.outputTokens = out;
    }
  }

  flush(): CwEvent[] {
    const out: CwEvent[] = [];
    // 兜底：非 SSE 的整包 JSON（单对象或片段数组）
    if (!this.sawSseEvent && this.rawBuffer.trim()) {
      try {
        const parsed = JSON.parse(this.rawBuffer.trim()) as GChunk | GChunk[];
        for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
          if (c && typeof c === "object") {
            out.push(...this.handleChunk(c));
          }
        }
      } catch {
        /* 不是完整 JSON */
      }
    }
    this.rawBuffer = "";
    this.meta(out);

    const sig = this.callSignature || this.anySignature;
    if (sig) {
      // Kiro 只保留带签名且 text 非空的推理；没有思考文本时给个占位空格保住签名
      if (!this.sawReasoningText) {
        out.push({ reasoningContentEvent: { text: " " } });
      }
      out.push({ reasoningContentEvent: { signature: encodeGeminiSignature(sig) } });
    }

    if (this.streamError && !this.sentErrorNotice) {
      this.sentErrorNotice = true;
      out.push(streamErrorNotice(this.streamError, this.modelId));
    } else if (this.blockedText) {
      out.push({ assistantResponseEvent: { content: `\n\n❌ 上游在流中返回错误：${this.blockedText.slice(0, 800)}`, modelId: this.modelId } });
      this.blockedText = "";
    } else if (this.finishReason === "MAX_TOKENS") {
      out.push({ assistantResponseEvent: { content: "\n\n⚠️ 输出达到 maxOutputTokens 上限被截断。", modelId: this.modelId } });
    } else if (this.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(this.finishReason) && !this.sawToolUse) {
      out.push({ assistantResponseEvent: { content: `\n\n⚠️ 上游提前结束：${this.finishReason}`, modelId: this.modelId } });
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
    // 结束原因必发（见 streamShared.toCwStopReason 的说明）。Gemini 的 MAX_TOKENS 与 Kiro 同名；其余归 END_TURN
    out.push(stopReasonEvent(toCwStopReason(this.finishReason === "MAX_TOKENS" ? "max_tokens" : "stop", this.sawToolUse)));
    return out;
  }

  /** 计费口径：promptTokenCount 已含缓存命中，缓存字段清零避免重复计（同 chat / responses）。 */
  meteringUsage(): CapturedUsage {
    return { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }

  /** 账本口径：promptTokenCount 减去 cachedContentTokenCount 才是未命中输入。 */
  ledgerUsage(): CapturedUsage {
    return splitCachedInput(this.usage);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function stringifyArgs(args: unknown): string {
  if (args && typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return "{}";
    }
  }
  if (typeof args === "string") {
    try {
      const v = JSON.parse(args);
      return v && typeof v === "object" ? args : "{}";
    } catch {
      return "{}";
    }
  }
  return "{}";
}
