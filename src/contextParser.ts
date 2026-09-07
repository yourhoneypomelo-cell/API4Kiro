/**
 * Kiro 请求上下文成分解析器。
 * 从 CwRequest 中提取并分类统计各微观模块的字符权重，
 * 供后续按真实上游 inputTokens 进行无损物理分配。
 */

import { CwRequest, CwUserInputMessage } from "./cwTypes";
import { activePromptText } from "./promptStore";

export interface RawContextBreakdown {
  filesChars: number;      // 关联工作区与当前打开的文件
  historyChars: number;    // 多轮历史对话 (User, Assistant, Reasoning, ToolResults)
  toolsChars: number;      // 工具定义 Schema
  rulesChars: number;      // 系统指令、规则与提示词
  currentChars: number;    // 当前轮用户输入
}

export interface ContextBreakdown {
  filesTokens: number;
  historyTokens: number;
  toolsTokens: number;
  rulesTokens: number;
  currentInputTokens: number;
}

/**
 * 从原始 CwRequest 中提取各上下文模块的纯字符数
 */
export function extractRawContextBreakdown(req: CwRequest): RawContextBreakdown {
  let filesChars = 0;
  let historyChars = 0;
  let toolsChars = 0;
  let rulesChars = 0;
  let currentChars = 0;

  try {
    const state = req?.conversationState;
    if (!state) {
      return { filesChars: 0, historyChars: 0, toolsChars: 0, rulesChars: 0, currentChars: 0 };
    }

    // 1. 系统规则与提示词库
    const activePrompt = activePromptText();
    if (activePrompt) {
      rulesChars += activePrompt.length;
    }

    // 2. 多轮历史记录
    for (const h of state.history || []) {
      if (h.userInputMessage) {
        historyChars += countUserMessageChars(h.userInputMessage);
      }
      if (h.assistantResponseMessage) {
        const arm = h.assistantResponseMessage;
        if (arm.content) historyChars += arm.content.length;
        if (arm.reasoningContent) {
          if (typeof arm.reasoningContent === "string") {
            historyChars += arm.reasoningContent.length;
          } else if (arm.reasoningContent.reasoningText?.text) {
            historyChars += arm.reasoningContent.reasoningText.text.length;
          }
        }
        if (arm.toolUses) {
          for (const tu of arm.toolUses) {
            historyChars += (tu.name || "").length;
            if (tu.input) historyChars += JSON.stringify(tu.input).length;
          }
        }
      }
    }

    // 3. 当前轮消息
    const currMsg = state.currentMessage?.userInputMessage;
    if (currMsg) {
      // 当前用户输入文本
      if (currMsg.content) {
        currentChars += currMsg.content.length;
      }

      const ctx = currMsg.userInputMessageContext;
      if (ctx) {
        // 工作区文件
        if (ctx.editorState) {
          if (ctx.editorState.document?.text) {
            filesChars += ctx.editorState.document.text.length;
          }
          if (Array.isArray(ctx.editorState.relevantDocuments)) {
            for (const doc of ctx.editorState.relevantDocuments) {
              if (doc?.text) filesChars += doc.text.length;
            }
          }
        }

        // 规则与扩展上下文
        if (Array.isArray(ctx.additionalContext)) {
          for (const ac of ctx.additionalContext) {
            if (ac.innerContext) rulesChars += ac.innerContext.length;
            if (ac.description) rulesChars += ac.description.length;
          }
        }

        // 工具定义
        if (Array.isArray(ctx.tools)) {
          for (const t of ctx.tools) {
            toolsChars += JSON.stringify(t).length;
          }
        }

        // 当前轮如果是工具返回继续执行
        if (Array.isArray(ctx.toolResults)) {
          for (const tr of ctx.toolResults) {
            if (typeof tr.content === "string") {
              currentChars += tr.content.length;
            } else if (tr.content != null) {
              currentChars += JSON.stringify(tr.content).length;
            }
          }
        }
      }
    }
  } catch {
    // 忽略解析偶发异常，兜底返回零
  }

  return { filesChars, historyChars, toolsChars, rulesChars, currentChars };
}

function countUserMessageChars(msg: CwUserInputMessage): number {
  let chars = 0;
  if (msg.content) chars += msg.content.length;
  const ctx = msg.userInputMessageContext;
  if (ctx) {
    if (ctx.editorState?.document?.text) chars += ctx.editorState.document.text.length;
    if (Array.isArray(ctx.editorState?.relevantDocuments)) {
      for (const d of ctx.editorState.relevantDocuments) if (d?.text) chars += d.text.length;
    }
    if (Array.isArray(ctx.additionalContext)) {
      for (const ac of ctx.additionalContext) {
        if (ac.innerContext) chars += ac.innerContext.length;
      }
    }
    if (Array.isArray(ctx.toolResults)) {
      for (const tr of ctx.toolResults) {
        if (typeof tr.content === "string") chars += tr.content.length;
        else if (tr.content) chars += JSON.stringify(tr.content).length;
      }
    }
  }
  return chars;
}

/**
 * 按照实际账单 inputTokens 严格无损分配到各微观类别（保证各项之和严格等于 inputTokens）
 */
export function allocateContextTokens(raw: RawContextBreakdown, inputTokens: number): ContextBreakdown {
  if (inputTokens <= 0) {
    return { filesTokens: 0, historyTokens: 0, toolsTokens: 0, rulesTokens: 0, currentInputTokens: 0 };
  }

  const totalChars = raw.filesChars + raw.historyChars + raw.toolsChars + raw.rulesChars + raw.currentChars;
  if (totalChars <= 0) {
    // 若未能提取到具体字段，默认全部归为当前输入
    return { filesTokens: 0, historyTokens: 0, toolsTokens: 0, rulesTokens: 0, currentInputTokens: inputTokens };
  }

  // 比例分配，向下取整
  const filesTokens = Math.floor((raw.filesChars / totalChars) * inputTokens);
  const historyTokens = Math.floor((raw.historyChars / totalChars) * inputTokens);
  const toolsTokens = Math.floor((raw.toolsChars / totalChars) * inputTokens);
  const rulesTokens = Math.floor((raw.rulesChars / totalChars) * inputTokens);

  // 余数归入最大一项或当前输入，确保各项之和 === inputTokens (物理绝对守恒)
  const allocated = filesTokens + historyTokens + toolsTokens + rulesTokens;
  const currentInputTokens = Math.max(0, inputTokens - allocated);

  return { filesTokens, historyTokens, toolsTokens, rulesTokens, currentInputTokens };
}
