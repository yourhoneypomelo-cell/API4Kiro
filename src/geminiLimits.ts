/**
 * Gemini 2.5 系 `thinkingConfig.thinkingBudget` 的合法范围（按子型号），geminiTranslate 发请求前据此限幅。
 * 越界值上游直接 400（"thinking_budget … out of range" / Pro 收到 0 被拒），而 Kiro 的档位是全模型统一的，
 * `max` 给 32768 只对 Pro 合法、`none` 给 0 只对 Flash / Flash-Lite 合法。
 *
 * 官方限值（两处文档交叉一致）：
 *  - Gemini API「Thinking」generateContent 版（2025-09 存档；现行页已改讲 Interactions API 的 thinking_level）：
 *    https://web.archive.org/web/20250901000000id_/https://ai.google.dev/gemini-api/docs/thinking
 *  - Vertex AI「Thinking」（现行）：https://cloud.google.com/vertex-ai/generative-ai/docs/thinking
 *
 *      型号              范围          0（关闭思考）              -1（动态）
 *      2.5 Pro           128–32768     不可（"Cannot disable"）    可
 *      2.5 Flash         0–24576       可（Vertex 写开思考下限 1）  可
 *      2.5 Flash-Lite    512–24576     可                          可
 *
 *  - models.dev（google / google-vertex 条目）的 reasoning_options 与上表一致：Pro budget_tokens{128,32768} 且无 toggle；
 *    Flash toggle + budget_tokens{0,24576}；Flash-Lite toggle + budget_tokens{512,24576}。
 *
 * 取值顺序：models.dev 目录（**精确** id 命中且带 budget 范围）→ 本表 → 都没有则视为未知型号，**不限幅**（保持原值）：
 * 宁可让上游 400 报出真实错误，也不用猜的范围去改一个我们不认识的模型的请求。
 * Gemini 3 系用 thinkingLevel 枚举，不在此表管辖（geminiFamilyOf 已分家）。
 */

import { lookupCapability, normalizeModelId } from "./modelCatalog";

export interface GeminiBudgetLimits {
  /** 开着思考时的最小预算。 */
  min: number;
  max: number;
  /** 是否允许 thinkingBudget=0 关闭思考。 */
  canDisable: boolean;
  source: "catalog" | "table";
}

interface TableRow {
  variant: "pro" | "flash" | "flash-lite";
  limits: Omit<GeminiBudgetLimits, "source">;
}

const TABLE: TableRow[] = [
  { variant: "pro", limits: { min: 128, max: 32768, canDisable: false } },
  { variant: "flash", limits: { min: 1, max: 24576, canDisable: true } },
  { variant: "flash-lite", limits: { min: 512, max: 24576, canDisable: true } },
];

/**
 * 基名：gemini-2.5-<variant> / gemini-2-5-<variant>（geminiFamilyOf 认的两种写法），前面允许 "google/" 一类前缀。
 * flash-lite 要先于 flash 试。
 */
const BASE_RE = /(?:^|\/)gemini-2[.-]5-(flash-lite|flash|pro)(?=$|-)/;
/**
 * 基名之后允许出现的尾巴：版本标记（preview / exp / latest / thinking）、日期数字（06-05 / 09-2025 / 20250520）、
 * 目录里的档位后缀（Antigravity 形态 gemini-2.5-flash-high）。带 image / tts / audio / live / computer 一类尾巴的
 * 是别的产品线，思考预算语义不明 → 不认。
 */
const TAIL_TOKEN_RE = /^(preview|exp|latest|thinking|\d+|minimal|low|medium|high|xhigh|max|none)$/;

function fromTable(model: string): GeminiBudgetLimits | undefined {
  const m = String(model || "").toLowerCase();
  const hit = BASE_RE.exec(m);
  if (!hit) {
    return undefined;
  }
  const tail = m.slice(hit.index + hit[0].length);
  if (tail && !tail.slice(1).split("-").every((t) => TAIL_TOKEN_RE.test(t))) {
    return undefined;
  }
  const row = TABLE.find((r) => r.variant === hit[1]);
  return row ? { ...row.limits, source: "table" } : undefined;
}

function fromCatalog(model: string): GeminiBudgetLimits | undefined {
  const cap = lookupCapability(model);
  if (!cap || !cap.reasoning) {
    return undefined;
  }
  // lookupCapability 查不到精确 id 时会退到 family 别名（gemini-* → 第一条 family=gemini 的模型）；
  // 那是别的模型的范围，不能拿来限幅——只认精确命中。
  if (normalizeModelId(cap.id) !== normalizeModelId(model)) {
    return undefined;
  }
  const budget = cap.reasoningOptions.find((o) => o.type === "budget");
  if (!budget || budget.type !== "budget" || typeof budget.min !== "number" || typeof budget.max !== "number") {
    return undefined;
  }
  if (!Number.isFinite(budget.min) || !Number.isFinite(budget.max) || budget.min < 0 || budget.max < Math.max(1, budget.min)) {
    return undefined;
  }
  const canDisable = budget.min === 0 || cap.reasoningOptions.some((o) => o.type === "toggle");
  return { min: Math.max(1, budget.min), max: budget.max, canDisable, source: "catalog" };
}

/** 该模型的预算范围：目录精确命中优先，再查静态表；未知返回 undefined。 */
export function geminiBudgetLimitsFor(model: string): GeminiBudgetLimits | undefined {
  return fromCatalog(model) || fromTable(model);
}

export interface GeminiBudgetClamp {
  budget: number;
  /** 值被改过（含 0 → 最小值）。 */
  clamped: boolean;
  limits?: GeminiBudgetLimits;
}

/**
 * 把档位映射出的预算钳进该型号的合法范围：
 *  - 未知型号：原值返回；
 *  - -1（动态）：三款 2.5 思考模型都支持，原样保留；
 *  - ≤0（关思考）：可关的型号归 0；不可关的（Pro）取最小值——用户选 none 要的是"尽量少想"，
 *    最小值比 -1 动态（模型自行决定、可能想很多）更贴近意图；
 *  - 其余：低于下限取下限、高于上限取上限。
 */
export function clampGeminiThinkingBudget(model: string, budget: number): GeminiBudgetClamp {
  const limits = geminiBudgetLimitsFor(model);
  if (!limits) {
    return { budget, clamped: false };
  }
  if (budget === -1) {
    return { budget, clamped: false, limits };
  }
  if (budget <= 0) {
    const to = limits.canDisable ? 0 : limits.min;
    return { budget: to, clamped: to !== budget, limits };
  }
  const to = Math.min(limits.max, Math.max(limits.min, budget));
  return { budget: to, clamped: to !== budget, limits };
}
