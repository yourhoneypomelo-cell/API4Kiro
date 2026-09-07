import { CwEvent, CwRequest } from "./cwTypes";

// Markers Kiro embeds in its built-in intent-classifier prompt.
const SIGN_A = "You are an intent classifier for a language model";
const SIGN_B = "(chat, do, spec)";

function allUserContents(req: CwRequest): string[] {
  const state = req.conversationState;
  const out: string[] = [];
  for (const item of state?.history || []) {
    const c = item?.userInputMessage?.content;
    if (typeof c === "string" && c) {
      out.push(c);
    }
  }
  const cur = state?.currentMessage?.userInputMessage?.content;
  if (typeof cur === "string" && cur) {
    out.push(cur);
  }
  return out;
}

function findClassifierContent(req: CwRequest): string {
  for (const c of allUserContents(req)) {
    if (c.includes(SIGN_A) && c.includes(SIGN_B)) {
      return c;
    }
  }
  return "";
}

export function isIntentClassifierRequest(req: CwRequest): boolean {
  return findClassifierContent(req) !== "";
}

/** Heuristic classification into {chat, do, spec} probabilities. */
function classifyIntent(prompt: string): { chat: number; do: number; spec: number } {
  const marker = "Here is the last user message:";
  let tail = prompt;
  const idx = prompt.lastIndexOf(marker);
  if (idx >= 0) {
    tail = prompt.slice(idx + marker.length);
  }
  const lower = tail.toLowerCase();
  const specHints = [
    "create a spec",
    "create spec",
    "specification",
    "formal spec",
    "spec for",
    "spec document",
    "execute task",
    "start task",
    "next task",
    "实现规范",
    "创建规范",
    "生成规范",
    "需求文档",
  ];
  if (specHints.some((h) => lower.includes(h))) {
    return { chat: 0, do: 0.1, spec: 0.9 };
  }
  return { chat: 0, do: 0.95, spec: 0.05 };
}

/** Build the local event-stream response for an intercepted classifier request. */
export function buildIntentClassifierResponse(
  req: CwRequest,
  conversationId: string,
  modelId: string
): CwEvent[] {
  const content = findClassifierContent(req);
  const probs = classifyIntent(content);
  return [
    { messageMetadataEvent: { conversationId } },
    { assistantResponseEvent: { content: JSON.stringify(probs), modelId } },
    // 缺 stopReason 的纯文本会被 Kiro 判为截断并重发（见 streamShared.toCwStopReason）
    { metadataEvent: { stopReason: "END_TURN" } },
  ];
}
