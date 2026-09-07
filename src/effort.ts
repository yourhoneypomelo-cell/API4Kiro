import * as vscode from "vscode";
import { cfg, getReasoningModeOverride } from "./config";
import { CwRequest } from "./cwTypes";
import { EFFORT_LEVELS, EffortLevel } from "./modelStore";
import { debug } from "./log";

const VALID_EFFORTS = new Set<string>(EFFORT_LEVELS as readonly string[]);

export type EffortMode = "off" | "modelVariant" | "thinkingBudget" | "auto";

export function getEffortMode(): EffortMode {
  const m = cfg().get<string>("effortMode", "auto");
  if (m === "off" || m === "modelVariant" || m === "thinkingBudget") {
    return m;
  }
  return "auto";
}

const DEFAULT_BUDGETS: Record<EffortLevel, number> = {
  // 0 = 不开思考：setThinkingBudget 见到非正数直接跳过。
  none: 0,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 24576,
};

/** Thinking token budget for an effort level (config override + sane defaults). */
export function budgetForEffort(effort: string): number {
  const e = normEffort(effort);
  if (!e) {
    return 0;
  }
  const override = cfg().get<Record<string, number>>("effortBudgets", {}) || {};
  const v = Number(override[e]);
  if (Number.isFinite(v) && v > 0) {
    return v;
  }
  return DEFAULT_BUDGETS[e];
}

export function normEffort(x: unknown): EffortLevel | undefined {
  if (typeof x !== "string") {
    return undefined;
  }
  const v = x.trim().toLowerCase();
  return VALID_EFFORTS.has(v) ? (v as EffortLevel) : undefined;
}

/** Extract the effort Kiro attached to the request (output_config.effort / reasoning.effort). */
export function effortFromRequest(req: CwRequest): EffortLevel | undefined {
  const cm = req?.conversationState?.currentMessage?.userInputMessage;
  const candidates = [
    cm?.userInputMessageContext?.additionalModelRequestFields,
    cm?.additionalModelRequestFields,
    req?.additionalModelRequestFields,
    req?.conversationState?.additionalModelRequestFields,
  ];
  for (const fields of candidates) {
    if (!fields || typeof fields !== "object") {
      continue;
    }
    const f = fields as {
      output_config?: { effort?: unknown };
      reasoning?: { effort?: unknown };
    };
    const e = normEffort(f.output_config?.effort ?? f.reasoning?.effort);
    if (e) {
      return e;
    }
  }
  return undefined;
}

/**
 * Resolve the effort level for a request: prefer the value embedded in the
 * request; fall back to Kiro's current effort-level command; finally fall back
 * to the last-known effort for this conversation.
 *
 * The per-conversation cache is important for extended "think a step, act a
 * step": tool-continuation turns may omit output_config.effort, and the
 * getEffortLevel command isn't available on every Kiro build. Without the
 * cache, thinking effort would silently drop on later turns of an agent loop.
 */
const effortCache = new Map<string, EffortLevel>();

export async function getSelectedEffort(req: CwRequest): Promise<EffortLevel | undefined> {
  const convId = req?.conversationState?.conversationId || "";

  const fromReq = effortFromRequest(req);
  if (fromReq) {
    if (convId) {
      effortCache.set(convId, fromReq);
    }
    return fromReq;
  }
  try {
    const v = await vscode.commands.executeCommand("kiro.agentModels.getEffortLevel");
    const e = normEffort(v);
    if (e) {
      debug("effort from command", e);
      if (convId) {
        effortCache.set(convId, e);
      }
      return e;
    }
  } catch {
    /* command unavailable on this Kiro build */
  }
  if (convId && effortCache.has(convId)) {
    const cached = effortCache.get(convId);
    debug("effort from conversation cache", cached);
    return cached;
  }
  return undefined;
}

// === Reasoning mode（GPT 5.6：standard / pro）===

/** 宽松归一 mode：仅去空白转小写，不硬限枚举——由中转站按模型 schema 校验兜底，前向兼容新增档位。 */
function normMode(x: unknown): string | undefined {
  if (typeof x !== "string") {
    return undefined;
  }
  const v = x.trim().toLowerCase();
  return v.length > 0 ? v : undefined;
}

/** 提取 Kiro 请求里的 reasoning 模式（additionalModelRequestFields.reasoning.mode / output_config.mode）。 */
export function modeFromRequest(req: CwRequest): string | undefined {
  const cm = req?.conversationState?.currentMessage?.userInputMessage;
  const candidates = [
    cm?.userInputMessageContext?.additionalModelRequestFields,
    cm?.additionalModelRequestFields,
    req?.additionalModelRequestFields,
    req?.conversationState?.additionalModelRequestFields,
  ];
  for (const fields of candidates) {
    if (!fields || typeof fields !== "object") {
      continue;
    }
    const f = fields as {
      reasoning?: { mode?: unknown };
      output_config?: { mode?: unknown };
    };
    const m = normMode(f.reasoning?.mode ?? f.output_config?.mode);
    if (m) {
      return m;
    }
  }
  return undefined;
}

// mode 与 effort 同理：工具续跑轮可能省略，做 per-conversation 缓存避免中途丢失。
const modeCache = new Map<string, string>();

/**
 * 解析请求的 reasoning 模式：配置覆盖（reasoningMode=standard/pro）优先；否则取请求内嵌值；
 * 再退到本会话上一次的缓存值。返回 undefined 表示不指定（中转站/上游用默认 standard）。
 */
export function getSelectedMode(req: CwRequest): string | undefined {
  const override = getReasoningModeOverride();
  if (override) {
    return override;
  }
  const convId = req?.conversationState?.conversationId || "";
  const fromReq = modeFromRequest(req);
  if (fromReq) {
    if (convId) {
      modeCache.set(convId, fromReq);
    }
    return fromReq;
  }
  if (convId && modeCache.has(convId)) {
    return modeCache.get(convId);
  }
  return undefined;
}
