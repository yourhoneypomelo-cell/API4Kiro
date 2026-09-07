/**
 * 造 CwRequest / ProviderConfig 的小工具（形态见 Claude 记忆 test-harness-a2kd-smoke）。
 */

import { CwHistoryItem, CwRequest, CwToolSpec, CwToolUse, CwToolResult, CwImage } from "../../src/cwTypes";
import { ProviderConfig } from "../../src/providers";

export function user(content: string, extra: Partial<NonNullable<CwHistoryItem["userInputMessage"]>> = {}): CwHistoryItem {
  return { userInputMessage: { content, modelId: extra.modelId, ...extra } };
}

export function assistant(content: string, extra: Partial<NonNullable<CwHistoryItem["assistantResponseMessage"]>> = {}): CwHistoryItem {
  return { assistantResponseMessage: { content, ...extra } };
}

export function toolUse(id: string, name: string, input: unknown): CwToolUse {
  return { toolUseId: id, name, input };
}

export function toolResult(id: string, text: string): CwToolResult {
  return { toolUseId: id, content: [{ text }], status: "success" };
}

export function image(format = "png"): CwImage {
  return { format, source: { bytes: "AAAA" } };
}

export interface ReqOpts {
  convId?: string;
  modelId?: string;
  history?: CwHistoryItem[];
  tools?: CwToolSpec[];
  toolResults?: CwToolResult[];
  images?: CwImage[];
  effort?: string;
}

export function cwRequest(content: string, o: ReqOpts = {}): CwRequest {
  const modelId = o.modelId || "test-model";
  const ctx: NonNullable<NonNullable<CwHistoryItem["userInputMessage"]>["userInputMessageContext"]> = {};
  if (o.tools) {
    ctx.tools = o.tools;
  }
  if (o.toolResults) {
    ctx.toolResults = o.toolResults;
  }
  if (o.effort) {
    ctx.additionalModelRequestFields = { output_config: { effort: o.effort } };
  }
  return {
    conversationState: {
      conversationId: o.convId || "conv-test",
      chatTriggerType: "MANUAL",
      history: o.history || [],
      currentMessage: {
        userInputMessage: {
          content,
          modelId,
          origin: "AI_EDITOR",
          userInputMessageContext: ctx,
          images: o.images,
        },
      },
    },
  };
}

export function toolSpec(name: string, schema: Record<string, unknown>, description = "test tool"): CwToolSpec {
  return { toolSpecification: { name, description, inputSchema: { json: schema } } };
}

export function provider(partial: Partial<ProviderConfig> & { protocol: ProviderConfig["protocol"] }): ProviderConfig {
  return {
    id: "p1",
    name: "Test Provider",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-test",
    enabled: true,
    ...partial,
  };
}
