/**
 * Kiro 请求上下文成分解析器。
 * 按 Kiro Context Usage 弹层六桶（Your prompts / Kiro responses / Session files /
 * Built-in tools / MCP tools / Steering files）提取字符权重，再按账单 inputTokens 无损分配。
 */

import { CwRequest, CwToolSpec, CwUserInputMessage } from "./cwTypes";
import { activePromptText } from "./promptStore";

export interface RawContextBreakdown {
  userPromptsChars: number;
  kiroResponsesChars: number;
  sessionFilesChars: number;
  builtinToolsChars: number;
  mcpToolsChars: number;
  steeringChars: number;
}

export interface ContextBreakdown {
  userPromptsTokens: number;
  kiroResponsesTokens: number;
  sessionFilesTokens: number;
  builtinToolsTokens: number;
  mcpToolsTokens: number;
  steeringTokens: number;
}

/** 4.13.57 之前落账的五字段形状。 */
export interface LegacyContextBreakdown {
  filesTokens: number;
  historyTokens: number;
  toolsTokens: number;
  rulesTokens: number;
  currentInputTokens: number;
}

export interface NormalizedBreakdown {
  userPromptsTokens: number;
  kiroResponsesTokens: number;
  sessionFilesTokens: number;
  builtinToolsTokens: number;
  mcpToolsTokens: number;
  steeringTokens: number;
  legacyTokens: number;
}

export type AnyContextBreakdown = ContextBreakdown | LegacyContextBreakdown;

const SIX_KEYS = [
  "userPromptsTokens",
  "kiroResponsesTokens",
  "sessionFilesTokens",
  "builtinToolsTokens",
  "mcpToolsTokens",
  "steeringTokens",
] as const;

function toolSpecName(t: CwToolSpec): string {
  return String(t.toolSpecification?.name || t.name || "").toLowerCase();
}

export function isMcpToolName(name: string): boolean {
  return name.toLowerCase().startsWith("mcp_");
}

function addToolResultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content != null) return JSON.stringify(content).length;
  return 0;
}

function addAdditionalContextChars(ctx: CwUserInputMessage["userInputMessageContext"]): number {
  let n = 0;
  if (!ctx || !Array.isArray(ctx.additionalContext)) return 0;
  for (const ac of ctx.additionalContext) {
    if (ac.innerContext) n += ac.innerContext.length;
    if (ac.description) n += ac.description.length;
  }
  return n;
}

function addSessionFileChars(ctx: CwUserInputMessage["userInputMessageContext"]): number {
  let n = 0;
  if (!ctx?.editorState) return 0;
  if (ctx.editorState.document?.text) n += ctx.editorState.document.text.length;
  if (Array.isArray(ctx.editorState.relevantDocuments)) {
    for (const doc of ctx.editorState.relevantDocuments) {
      if (doc?.text) n += doc.text.length;
    }
  }
  return n;
}

function addToolResultListChars(ctx: CwUserInputMessage["userInputMessageContext"]): number {
  let n = 0;
  if (!ctx || !Array.isArray(ctx.toolResults)) return 0;
  for (const tr of ctx.toolResults) n += addToolResultChars(tr.content);
  return n;
}

/**
 * 从原始 CwRequest 中提取各上下文模块的纯字符数。
 * Built-in / MCP 按 toolSpecification.name 是否以 mcp_ 开头判定（与 Kiro 弹层口径一致）。
 */
export function extractRawContextBreakdown(req: CwRequest): RawContextBreakdown {
  const raw: RawContextBreakdown = {
    userPromptsChars: 0,
    kiroResponsesChars: 0,
    sessionFilesChars: 0,
    builtinToolsChars: 0,
    mcpToolsChars: 0,
    steeringChars: 0,
  };

  try {
    const state = req?.conversationState;
    if (!state) return raw;

    const activePrompt = activePromptText();
    if (activePrompt) raw.steeringChars += activePrompt.length;

    for (const h of state.history || []) {
      if (h.userInputMessage) {
        const msg = h.userInputMessage;
        if (msg.content) raw.userPromptsChars += msg.content.length;
        raw.sessionFilesChars += addSessionFileChars(msg.userInputMessageContext);
        raw.steeringChars += addAdditionalContextChars(msg.userInputMessageContext);
        raw.kiroResponsesChars += addToolResultListChars(msg.userInputMessageContext);
      }
      if (h.assistantResponseMessage) {
        const arm = h.assistantResponseMessage;
        if (arm.content) raw.kiroResponsesChars += arm.content.length;
        if (arm.reasoningContent) {
          if (typeof arm.reasoningContent === "string") {
            raw.kiroResponsesChars += arm.reasoningContent.length;
          } else if (arm.reasoningContent.reasoningText?.text) {
            raw.kiroResponsesChars += arm.reasoningContent.reasoningText.text.length;
          }
        }
        if (arm.toolUses) {
          for (const tu of arm.toolUses) {
            raw.kiroResponsesChars += (tu.name || "").length;
            if (tu.input) raw.kiroResponsesChars += JSON.stringify(tu.input).length;
          }
        }
      }
    }

    const currMsg = state.currentMessage?.userInputMessage;
    if (currMsg) {
      if (currMsg.content) raw.userPromptsChars += currMsg.content.length;
      const ctx = currMsg.userInputMessageContext;
      if (ctx) {
        raw.sessionFilesChars += addSessionFileChars(ctx);
        raw.steeringChars += addAdditionalContextChars(ctx);
        if (Array.isArray(ctx.tools)) {
          for (const t of ctx.tools) {
            const n = JSON.stringify(t).length;
            if (isMcpToolName(toolSpecName(t))) raw.mcpToolsChars += n;
            else raw.builtinToolsChars += n;
          }
        }
        raw.kiroResponsesChars += addToolResultListChars(ctx);
      }
    }
  } catch {
    // 忽略解析偶发异常，兜底返回零
  }

  return raw;
}

function emptyBreakdown(): ContextBreakdown {
  return {
    userPromptsTokens: 0,
    kiroResponsesTokens: 0,
    sessionFilesTokens: 0,
    builtinToolsTokens: 0,
    mcpToolsTokens: 0,
    steeringTokens: 0,
  };
}

/**
 * 按照实际账单 inputTokens 严格无损分配到六桶（各项之和严格等于 inputTokens）。
 * 余数归用户提示；总字符 0 → 全部归用户提示。
 */
export function allocateContextTokens(raw: RawContextBreakdown, inputTokens: number): ContextBreakdown {
  if (inputTokens <= 0) return emptyBreakdown();

  const weights = [
    raw.userPromptsChars,
    raw.kiroResponsesChars,
    raw.sessionFilesChars,
    raw.builtinToolsChars,
    raw.mcpToolsChars,
    raw.steeringChars,
  ];
  const totalChars = weights.reduce((a, b) => a + b, 0);
  if (totalChars <= 0) {
    return { ...emptyBreakdown(), userPromptsTokens: inputTokens };
  }

  const floors = weights.map((w) => Math.floor((w / totalChars) * inputTokens));
  const allocated = floors.reduce((a, b) => a + b, 0);
  floors[0] += Math.max(0, inputTokens - allocated);

  return {
    userPromptsTokens: floors[0],
    kiroResponsesTokens: floors[1],
    sessionFilesTokens: floors[2],
    builtinToolsTokens: floors[3],
    mcpToolsTokens: floors[4],
    steeringTokens: floors[5],
  };
}

export function isLegacyBreakdown(cb: unknown): cb is LegacyContextBreakdown {
  if (!cb || typeof cb !== "object") return false;
  const o = cb as Record<string, unknown>;
  return typeof o.filesTokens === "number" && typeof o.userPromptsTokens !== "number";
}

export function isSixBreakdown(cb: unknown): cb is ContextBreakdown {
  if (!cb || typeof cb !== "object") return false;
  const o = cb as Record<string, unknown>;
  return typeof o.userPromptsTokens === "number";
}

export function emptyNormalized(): NormalizedBreakdown {
  return {
    userPromptsTokens: 0,
    kiroResponsesTokens: 0,
    sessionFilesTokens: 0,
    builtinToolsTokens: 0,
    mcpToolsTokens: 0,
    steeringTokens: 0,
    legacyTokens: 0,
  };
}

/** 旧五字段：files→sessionFiles、rules→steering，其余进 legacy（拆不开）。 */
export function normalizeBreakdown(cb: unknown): NormalizedBreakdown {
  const z = emptyNormalized();
  if (!cb || typeof cb !== "object") return z;
  if (isSixBreakdown(cb)) {
    z.userPromptsTokens = cb.userPromptsTokens || 0;
    z.kiroResponsesTokens = cb.kiroResponsesTokens || 0;
    z.sessionFilesTokens = cb.sessionFilesTokens || 0;
    z.builtinToolsTokens = cb.builtinToolsTokens || 0;
    z.mcpToolsTokens = cb.mcpToolsTokens || 0;
    z.steeringTokens = cb.steeringTokens || 0;
    const extra = (cb as { legacyTokens?: number }).legacyTokens;
    z.legacyTokens = typeof extra === "number" ? extra : 0;
    return z;
  }
  if (isLegacyBreakdown(cb)) {
    z.sessionFilesTokens = cb.filesTokens || 0;
    z.steeringTokens = cb.rulesTokens || 0;
    z.legacyTokens = (cb.historyTokens || 0) + (cb.toolsTokens || 0) + (cb.currentInputTokens || 0);
    return z;
  }
  return z;
}

export function breakdownSum(n: NormalizedBreakdown): number {
  return (
    n.userPromptsTokens +
    n.kiroResponsesTokens +
    n.sessionFilesTokens +
    n.builtinToolsTokens +
    n.mcpToolsTokens +
    n.steeringTokens +
    n.legacyTokens
  );
}

export { SIX_KEYS };
