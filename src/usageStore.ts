/**
 * 本地用量记账 —— 用量页的数据源。
 *
 * 为什么自己记：以前用量页依赖中转站提供 kiro2cc 那套 /api/user/usage，换个站就 401，
 * 而且只能看到"那一个站"的账。可我们本身就是代理，每个请求的 token / 耗时 / 状态在
 * krsServer 流末已经拿到了（页脚就靠它），直接落账就有了跨 provider 的完整统计。
 *
 * 设计取自两份参考：
 *  - cc-switch `proxy_request_logs` + `usage_daily_rollups`：逐条请求日志保留近期明细，
 *    过期的滚成日聚合再删原始行，明细可查、总量不丢；
 *  - New API `quota_data`：按小时桶预聚合 (model, channel, hour) → (count, tokens)，
 *    看板查询不用扫日志。
 *
 * 存储只有 globalState（无 SQLite），所以：
 *  - 明细行上限 + 天数双重裁剪（默认 2000 条 / 30 天），超出的合并进小时桶后删掉；
 *  - 小时桶是永久的汇总层，键为 provider\0model\0hourStart，桶数天然有界；
 *  - 写入防抖合并（New API 也是先攒内存再批量落库），高频工具循环不会把 globalState 写爆。
 *
 * 口径：
 *  - inputTokens 是"未命中缓存的输入"，cacheRead / cacheWrite 单列，totalTokens = 四项之和；
 *    这跟 cc-switch 的 fresh-input 语义一致，命中率 = cacheRead / (input+cacheRead+cacheWrite)。
 *  - outputTokens 已含思考 token（resolveOutputTokens 归一过）。
 *  - 一次工具循环里每个 HTTP 请求各记一行，requests 数就是真实上游调用数。
 */

import * as vscode from "vscode";
import { ContextBreakdown } from "./contextParser";
import { debug } from "./log";

export { ContextBreakdown };
export interface UsageRecord {
  /** 请求结束时间戳（ms）。 */
  ts: number;
  providerId: string;
  /** 记账时的 provider 展示名；provider 被删后统计里仍能看到名字。 */
  providerName: string;
  /** key 池里用的哪一把（c1 / c2 …）；单凭证 provider 不记。 */
  credentialId?: string;
  /** Kiro 选中的模型 id（去 effort 后缀的 base）。 */
  model: string;
  /** 实际发给上游的模型 id（映射/变体后），与 model 不同时显示。 */
  upstreamModel?: string;
  protocol: "anthropic" | "openai" | "gemini" | "kiro";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 从发起到流结束。 */
  latencyMs: number;
  /** 到第一个正文/思考字节的时间；无则 undefined。 */
  firstTokenMs?: number;
  /** HTTP 状态；连接失败等非 HTTP 错误记 0。 */
  status: number;
  ok: boolean;
  error?: string;
  conversationId?: string;
  contextBreakdown?: ContextBreakdown;
}

/** 小时桶：(provider, model, hour) 维度的累计。 */
export interface HourBucket {
  hour: number; // 小时起点 ms
  providerId: string;
  providerName: string;
  model: string;
  protocol: "anthropic" | "openai" | "gemini" | "kiro";
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencySumMs: number;
  /** 有首 token 时间的请求数与总和，求平均用。 */
  firstTokenCount: number;
  firstTokenSumMs: number;
  ctxFilesTokens?: number;
  ctxHistoryTokens?: number;
  ctxToolsTokens?: number;
  ctxRulesTokens?: number;
  ctxInputTokens?: number;
}

/** 按凭证的累计（provider, credential）→ 请求数 / 失败数 / token / 最近一次。给编辑弹窗的 key 列表看。 */
export interface CredentialTotals {
  providerId: string;
  credentialId: string;
  requests: number;
  failures: number;
  tokens: number;
  lastTs: number;
}

interface Persisted {
  v: 1;
  records: UsageRecord[];
  buckets: HourBucket[];
  credentials?: CredentialTotals[];
}

const KEY = "usage.ledger.v1";
const HOUR = 3600_000;
const DAY = 86_400_000;

/** 明细保留：条数与天数取更严者。 */
const MAX_RECORDS = 2000;
const RETAIN_DAYS = 30;
/** 小时桶保留 400 天，再久的按年份没人看，且防止无界。 */
const BUCKET_RETAIN_MS = 400 * DAY;
/**
 * 多天趋势轴最多生成的天数（桶保留期的两倍）。「全部」范围的 from 取自账本最早的桶，所以一致的账本最多 ~401 天、
 * 永远碰不到这条线；能碰到的只有显式越界的 Range（如 from=0）或没被 prune 的过期桶——这时只保留最近这么多天，
 * 而不是从 1970 年起逐日补零（曾在扩展宿主同步生成 2 万个空点、卡住数秒）。
 */
const MAX_TREND_DAYS = 800;
/** 写入防抖：工具循环里连发几十次，攒 800ms 一次落盘。 */
const FLUSH_DEBOUNCE_MS = 800;

let ctx: vscode.ExtensionContext | undefined;
let records: UsageRecord[] = [];
let buckets = new Map<string, HourBucket>();
let credTotals = new Map<string, CredentialTotals>();
let flushTimer: NodeJS.Timeout | undefined;
let dirty = false;
const listeners = new Set<() => void>();

function bucketKey(providerId: string, model: string, hour: number): string {
  return `${providerId}\u0000${model}\u0000${hour}`;
}

function credKey(providerId: string, credentialId: string): string {
  return `${providerId}\u0000${credentialId}`;
}

function hourOf(ts: number): number {
  return ts - (ts % HOUR);
}

export function initUsageStore(context: vscode.ExtensionContext): void {
  ctx = context;
  const saved = context.globalState.get<Persisted>(KEY);
  if (saved && saved.v === 1) {
    records = Array.isArray(saved.records) ? saved.records : [];
    buckets = new Map();
    for (const b of Array.isArray(saved.buckets) ? saved.buckets : []) {
      if (b && typeof b.hour === "number") {
        buckets.set(bucketKey(b.providerId, b.model, b.hour), b);
      }
    }
    credTotals = new Map();
    for (const c of Array.isArray(saved.credentials) ? saved.credentials : []) {
      if (c && typeof c.providerId === "string" && typeof c.credentialId === "string") {
        credTotals.set(credKey(c.providerId, c.credentialId), c);
      }
    }
    debug("usage store loaded", { records: records.length, buckets: buckets.size, credentials: credTotals.size });
  }
  prune();
}

/** 用量变化订阅（面板据此实时刷新，对齐 cc-switch 的 usage-log-recorded 事件）。 */
export function onUsageChanged(fn: () => void): { dispose(): void } {
  listeners.add(fn);
  return { dispose: () => listeners.delete(fn) };
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function addToBucket(r: UsageRecord): void {
  const hour = hourOf(r.ts);
  const key = bucketKey(r.providerId, r.model, hour);
  let b = buckets.get(key);
  if (!b) {
    b = {
      hour,
      providerId: r.providerId,
      providerName: r.providerName,
      model: r.model,
      protocol: r.protocol,
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencySumMs: 0,
      firstTokenCount: 0,
      firstTokenSumMs: 0,
    };
    buckets.set(key, b);
  }
  b.providerName = r.providerName; // 改名后统计里跟着变
  b.requests += 1;
  if (!r.ok) {
    b.failures += 1;
  }
  b.inputTokens += r.inputTokens;
  b.outputTokens += r.outputTokens;
  b.cacheReadTokens += r.cacheReadTokens;
  b.cacheWriteTokens += r.cacheWriteTokens;
  b.latencySumMs += r.latencyMs;
  if (r.contextBreakdown) {
    b.ctxFilesTokens = (b.ctxFilesTokens || 0) + (r.contextBreakdown.filesTokens || 0);
    b.ctxHistoryTokens = (b.ctxHistoryTokens || 0) + (r.contextBreakdown.historyTokens || 0);
    b.ctxToolsTokens = (b.ctxToolsTokens || 0) + (r.contextBreakdown.toolsTokens || 0);
    b.ctxRulesTokens = (b.ctxRulesTokens || 0) + (r.contextBreakdown.rulesTokens || 0);
    b.ctxInputTokens = (b.ctxInputTokens || 0) + (r.contextBreakdown.currentInputTokens || 0);
  } else if (r.inputTokens > 0) {
    // 与明细路径的兜底口径一致：无细分的输入全部归「当前输入」，桶五项之和才等于桶的 inputTokens
    b.ctxInputTokens = (b.ctxInputTokens || 0) + r.inputTokens;
  }
  if (typeof r.firstTokenMs === "number" && r.firstTokenMs >= 0) {
    b.firstTokenCount += 1;
    b.firstTokenSumMs += r.firstTokenMs;
  }
}

function addToCredential(r: UsageRecord): void {
  if (!r.credentialId) {
    return;
  }
  const k = credKey(r.providerId, r.credentialId);
  let c = credTotals.get(k);
  if (!c) {
    c = { providerId: r.providerId, credentialId: r.credentialId, requests: 0, failures: 0, tokens: 0, lastTs: 0 };
    credTotals.set(k, c);
  }
  c.requests += 1;
  if (!r.ok) {
    c.failures += 1;
  }
  c.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  c.lastTs = Math.max(c.lastTs, r.ts);
}

/** 记一笔。同步进桶，明细入队，落盘防抖。 */
export function recordUsage(r: UsageRecord): void {
  records.push(r);
  addToBucket(r);
  addToCredential(r);
  // 条数上限在写入时就守住（不只在启动时 prune）：溢出的明细已进桶，丢明细不丢总量
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
  dirty = true;
  scheduleFlush();
  emit();
}

/** 某 provider 各凭证的累计（没记过的凭证不在里面）。 */
export function credentialTotals(providerId: string): CredentialTotals[] {
  const out: CredentialTotals[] = [];
  for (const c of credTotals.values()) {
    if (c.providerId === providerId) {
      out.push(c);
    }
  }
  return out;
}

/** 删凭证 / 删 provider 时清掉对应累计。 */
export function forgetCredentialTotals(providerId: string, credentialId?: string): void {
  let changed = false;
  for (const [k, c] of credTotals) {
    if (c.providerId === providerId && (!credentialId || c.credentialId === credentialId)) {
      credTotals.delete(k);
      changed = true;
    }
  }
  if (changed) {
    dirty = true;
    scheduleFlush();
  }
}

/**
 * 裁剪：明细超过条数或天数上限的直接丢——它们的量早在 recordUsage 时就进桶了，
 * 所以丢明细不丢总量（这正是双层设计的意义）。桶只按超长期限丢。
 */
function prune(): void {
  const now = Date.now();
  const cutoff = now - RETAIN_DAYS * DAY;
  let changed = false;
  if (records.length > MAX_RECORDS) {
    records = records.slice(records.length - MAX_RECORDS);
    changed = true;
  }
  const before = records.length;
  records = records.filter((r) => r.ts >= cutoff);
  if (records.length !== before) {
    changed = true;
  }
  const bucketCutoff = now - BUCKET_RETAIN_MS;
  for (const [k, b] of buckets) {
    if (b.hour < bucketCutoff) {
      buckets.delete(k);
      changed = true;
    }
  }
  if (changed) {
    dirty = true;
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

export async function flush(): Promise<void> {
  if (!dirty || !ctx) {
    return;
  }
  dirty = false;
  const data: Persisted = { v: 1, records, buckets: [...buckets.values()], credentials: [...credTotals.values()] };
  try {
    await ctx.globalState.update(KEY, data);
  } catch (e) {
    dirty = true;
    debug("usage store flush failed:", (e as Error).message);
  }
}

/** 清空全部用量（面板「清空统计」）。 */
export async function clearUsage(): Promise<void> {
  records = [];
  buckets.clear();
  credTotals.clear();
  dirty = true;
  await flush();
  emit();
}

// ============================ 查询 ============================

export type RangePreset = "today" | "7d" | "30d" | "all";

export interface Range {
  from: number;
  to: number;
}

/** 本地时区的"今天 0 点"。 */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 账本里最早的一笔（桶起点或明细 ts 的最小值）；空账本为 undefined。 */
function earliestLedgerTs(): number | undefined {
  let min: number | undefined;
  for (const b of buckets.values()) {
    if (min === undefined || b.hour < min) {
      min = b.hour;
    }
  }
  for (const r of records) {
    if (min === undefined || r.ts < min) {
      min = r.ts;
    }
  }
  return min;
}

/**
 * 预设 → 绝对范围。「全部」不再是 from=0：它从账本最早那笔所在的本地日 0 点起（空账本则从今天 0 点起），
 * 且不晚于今天 0 点。from=0 曾让多天趋势轴从 1970 年起逐日补零、在宿主同步跑数秒；范围起点由数据决定后，
 * 桶 / 明细一个不漏（桶起点 ≥ 当天 0 点、明细 ts ≥ 桶起点），趋势轴长度只与真实数据跨度有关。
 */
export function resolveRange(preset: RangePreset, now = Date.now()): Range {
  switch (preset) {
    case "today":
      return { from: startOfLocalDay(now), to: now };
    case "7d":
      return { from: startOfLocalDay(now - 6 * DAY), to: now };
    case "30d":
      return { from: startOfLocalDay(now - 29 * DAY), to: now };
    default: {
      const today = startOfLocalDay(now);
      const earliest = earliestLedgerTs();
      return { from: earliest === undefined ? today : Math.min(startOfLocalDay(earliest), today), to: now };
    }
  }
}

export interface Summary {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 四项之和。 */
  totalTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite)，无输入时 null。 */
  cacheHitRate: number | null;
  successRate: number | null;
  avgLatencyMs: number | null;
  avgFirstTokenMs: number | null;
}

function emptySummary(): Summary {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    successRate: null,
    avgLatencyMs: null,
    avgFirstTokenMs: null,
  };
}

interface Acc {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencySumMs: number;
  firstTokenCount: number;
  firstTokenSumMs: number;
}

function newAcc(): Acc {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencySumMs: 0,
    firstTokenCount: 0,
    firstTokenSumMs: 0,
  };
}

function addBucketToAcc(a: Acc, b: HourBucket): void {
  a.requests += b.requests;
  a.failures += b.failures;
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.latencySumMs += b.latencySumMs;
  a.firstTokenCount += b.firstTokenCount;
  a.firstTokenSumMs += b.firstTokenSumMs;
}

function finish(a: Acc): Summary {
  const s = emptySummary();
  s.requests = a.requests;
  s.failures = a.failures;
  s.inputTokens = a.inputTokens;
  s.outputTokens = a.outputTokens;
  s.cacheReadTokens = a.cacheReadTokens;
  s.cacheWriteTokens = a.cacheWriteTokens;
  s.totalTokens = a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens;
  const cacheable = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens;
  s.cacheHitRate = cacheable > 0 ? a.cacheReadTokens / cacheable : null;
  s.successRate = a.requests > 0 ? (a.requests - a.failures) / a.requests : null;
  s.avgLatencyMs = a.requests > 0 ? Math.round(a.latencySumMs / a.requests) : null;
  s.avgFirstTokenMs = a.firstTokenCount > 0 ? Math.round(a.firstTokenSumMs / a.firstTokenCount) : null;
  return s;
}

/**
 * 范围内的桶。桶按小时起点归属：起点落在 [from, to] 内即计入。
 * "今天"从本地 0 点起，桶按 UTC 小时切——0 点一定是某个整点，所以不会把昨天的桶算进来。
 */
function bucketsIn(range: Range): HourBucket[] {
  const out: HourBucket[] = [];
  for (const b of buckets.values()) {
    if (b.hour >= hourOf(range.from) && b.hour <= range.to) {
      out.push(b);
    }
  }
  return out;
}

export function summarize(range: Range, filter?: { providerId?: string; model?: string }): Summary {
  const acc = newAcc();
  for (const b of bucketsIn(range)) {
    if (filter?.providerId && b.providerId !== filter.providerId) {
      continue;
    }
    if (filter?.model && b.model !== filter.model) {
      continue;
    }
    addBucketToAcc(acc, b);
  }
  return finish(acc);
}

export interface ProviderStat extends Summary {
  providerId: string;
  providerName: string;
  protocol: "anthropic" | "openai" | "gemini" | "kiro";
  models: ModelStat[];
}

export interface ModelStat extends Summary {
  model: string;
}

/** 按 provider 分组，每组内再按模型分组（级联，对齐 cc-switch Provider/Model 两张表）。 */
export function statsByProvider(range: Range): ProviderStat[] {
  const byProv = new Map<string, { name: string; protocol: "anthropic" | "openai" | "gemini" | "kiro"; acc: Acc; models: Map<string, Acc> }>();
  for (const b of bucketsIn(range)) {
    let p = byProv.get(b.providerId);
    if (!p) {
      p = { name: b.providerName, protocol: b.protocol, acc: newAcc(), models: new Map() };
      byProv.set(b.providerId, p);
    }
    p.name = b.providerName;
    addBucketToAcc(p.acc, b);
    let m = p.models.get(b.model);
    if (!m) {
      m = newAcc();
      p.models.set(b.model, m);
    }
    addBucketToAcc(m, b);
  }
  const out: ProviderStat[] = [];
  for (const [providerId, p] of byProv) {
    const models: ModelStat[] = [];
    for (const [model, acc] of p.models) {
      models.push({ model, ...finish(acc) });
    }
    models.sort((a, b) => b.totalTokens - a.totalTokens);
    out.push({ providerId, providerName: p.name, protocol: p.protocol, models, ...finish(p.acc) });
  }
  out.sort((a, b) => b.totalTokens - a.totalTokens);
  return out;
}

/** 最近 N 条明细，新的在前。 */
export function recentRecords(limit = 50, range?: Range): UsageRecord[] {
  const src = range ? records.filter((r) => r.ts >= range.from && r.ts <= range.to) : records;
  return src.slice(-limit).reverse();
}

/** 按天的 token 趋势（Hero 下面那条小趋势用），天起点为本地 0 点。 */

export interface TimeSeriesPoint {
  ts: number;
  label: string;
  tokens: number;
  requests: number;
  modelTokens: Record<string, number>;
  /** 每模型请求数：趋势卡「请求」维度画模型分线用。 */
  modelRequests: Record<string, number>;
}

/**
 * 连续时间轴使用趋势（对齐 cc-switch UsageTrendChart）：
 * 当 range 为 today 时，按 10 分钟一个桶连续补全，从 0 点到 range.to（通常是现在）所在的 10 分钟槽为止；
 * 用每小时一格太粗，一天的用量只画成几个圆包、看不到每次消耗的尖峰（用户 2026-09-07 18:11）——改用原始明细
 * （records，按 ts 落 10 分钟槽）细分。records 上限 2000 条只会裁掉很旧的历史，「今天」的记录是最近的、
 * 几乎不会被裁。不生成尚未到来的槽——否则曲线会贴零线拖到当天末尾。
 * 当 range 为 7d/14d/30d 时，按每天（0点~今天，共7/14/30个自然日）连续补全，同样不越过 range.to；
 * 彻底解决当天或数据稀疏时只有单个孤立点、没有连线与渐变面积的问题。
 * 当 range 为 all 时，轴从首个有数据的日子起到今天（`resolveRange("all")` 的 from 已是账本最早一笔所在日），
 * 不生成前导空桶，且总天数不超过 MAX_TREND_DAYS。
 */
const TREND_SLOT_MS = 10 * 60_000;

export function getTimeSeriesTrend(rangePreset: RangePreset, range: Range): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];

  if (rangePreset === "today") {
    // 10 分钟细粒度槽：0 点起，到 range.to 所在的槽为止；0 点这一格总在，避免空图
    const start = range.from; // 今天 0 点
    const todays = records.filter((r) => r.ts >= range.from && r.ts <= range.to);
    for (let i = 0; i < 24 * 6; i++) {
      const slotTs = start + i * TREND_SLOT_MS;
      if (slotTs > range.to && i > 0) break;
      const d = new Date(slotTs);
      const label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      let tokens = 0;
      let requests = 0;
      const modelTokens: Record<string, number> = {};
      const modelRequests: Record<string, number> = {};
      for (const r of todays) {
        if (r.ts >= slotTs && r.ts < slotTs + TREND_SLOT_MS) {
          const t = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
          tokens += t;
          requests += 1;
          modelTokens[r.model] = (modelTokens[r.model] || 0) + t;
          modelRequests[r.model] = (modelRequests[r.model] || 0) + 1;
        }
      }
      points.push({ ts: slotTs, label, tokens, requests, modelTokens, modelRequests });
    }
    return points;
  }

  // 多天连续自然日时间轴。每个桶的本地日只算一次（此前是 天数 × 桶数 次 Date 构造：「全部」from=0 时 2 万天 × 两千桶 ≈ 6 秒）。
  const byDay = new Map<number, HourBucket[]>();
  let firstDataDay: number | undefined;
  for (const b of bucketsIn(range)) {
    const day = startOfLocalDay(b.hour);
    const list = byDay.get(day);
    if (list) {
      list.push(b);
    } else {
      byDay.set(day, [b]);
    }
    if (firstDataDay === undefined || day < firstDataDay) {
      firstDataDay = day;
    }
  }

  let startDay = startOfLocalDay(range.from);
  let numDays: number;
  if (rangePreset === "7d" || rangePreset === "30d") {
    numDays = rangePreset === "7d" ? 7 : 30;
  } else {
    // 「全部」：轴从范围起点与首个有数据的日子中较晚者开始（不生成前导空桶），至多 MAX_TREND_DAYS 天、只保留最近的
    const endDay = startOfLocalDay(range.to);
    if (firstDataDay !== undefined && firstDataDay > startDay) {
      startDay = firstDataDay;
    }
    if (startDay > endDay) {
      startDay = endDay;
    }
    numDays = Math.max(1, Math.round((endDay - startDay) / DAY) + 1);
    if (numDays > MAX_TREND_DAYS) {
      startDay = endDay - (MAX_TREND_DAYS - 1) * DAY;
      numDays = MAX_TREND_DAYS;
    }
  }

  for (let d = 0; d < numDays; d++) {
    const curDayTs = startDay + d * DAY;
    if (curDayTs > range.to && d > 0) break;
    const dObj = new Date(curDayTs);
    const label = `${dObj.getMonth() + 1}/${dObj.getDate()}`;
    let tokens = 0;
    let requests = 0;
    const modelTokens: Record<string, number> = {};
    const modelRequests: Record<string, number> = {};

    for (const b of byDay.get(curDayTs) || []) {
      const t = b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
      tokens += t;
      requests += b.requests;
      modelTokens[b.model] = (modelTokens[b.model] || 0) + t;
      modelRequests[b.model] = (modelRequests[b.model] || 0) + b.requests;
    }
    points.push({ ts: curDayTs, label, tokens, requests, modelTokens, modelRequests });
  }

  return points;
}

export function dailyTrend(range: Range): Array<{ day: number; tokens: number; requests: number }> {
  const byDay = new Map<number, { tokens: number; requests: number }>();
  for (const b of bucketsIn(range)) {
    const day = startOfLocalDay(b.hour);
    let d = byDay.get(day);
    if (!d) {
      d = { tokens: 0, requests: 0 };
      byDay.set(day, d);
    }
    d.tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    d.requests += b.requests;
  }
  return [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day - b.day);
}

export interface ActivityHeatmapDay {
  date: string;       // YYYY-MM-DD
  dayTs: number;      // 00:00 本地时间戳
  tokens: number;
  requests: number;
  level: number;      // 0..4
}

export interface UsageAnalyticsStats {
  totalTokens: number;
  peakTokens: number;
  longestDurationMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

export interface SankeyData {
  nodes: Array<{ id: string; name: string; layer: number; color?: string }>;
  links: Array<{ source: string; target: string; tokens: number; requests: number }>;
  /** 范围内的明细已被裁掉一部分，图改由小时桶聚合（少凭证层）；UI 可据此提示，本字段只增不改既有结构。 */
  detailTruncated: boolean;
}

export interface ModelUsageRatio {
  model: string;
  tokens: number;
  requests: number;
  percent: number;
}

/**
 * 提取全时间轴的使用连续天数、单日峰值及最长请求耗时等统计
 */
export function getUsageAnalyticsStats(): UsageAnalyticsStats {
  const allRange: Range = { from: 0, to: Date.now() };
  const days = dailyTrend(allRange);
  let totalTokens = 0;
  let peakTokens = 0;
  for (const d of days) {
    totalTokens += d.tokens;
    if (d.tokens > peakTokens) {
      peakTokens = d.tokens;
    }
  }

  let longestDurationMs = 0;
  for (const r of records) {
    if (r.latencyMs > longestDurationMs) {
      longestDurationMs = r.latencyMs;
    }
  }

  // 连续天数计算
  const activeDaysSet = new Set<number>();
  for (const d of days) {
    if (d.requests > 0 || d.tokens > 0) {
      activeDaysSet.add(d.day);
    }
  }

  const today = startOfLocalDay(Date.now());
  let currentStreakDays = 0;
  let cursor = today;
  if (!activeDaysSet.has(cursor)) {
    // 如果今天还没有请求，看昨天是否连续
    cursor -= DAY;
  }
  while (activeDaysSet.has(cursor)) {
    currentStreakDays++;
    cursor -= DAY;
  }

  // 最长连续天数
  const sortedDays = [...activeDaysSet].sort((a, b) => a - b);
  let longestStreakDays = 0;
  let curStreak = 0;
  let lastDay = 0;
  for (const d of sortedDays) {
    if (!lastDay || d === lastDay + DAY) {
      curStreak++;
    } else {
      curStreak = 1;
    }
    if (curStreak > longestStreakDays) {
      longestStreakDays = curStreak;
    }
    lastDay = d;
  }

  return {
    totalTokens,
    peakTokens,
    longestDurationMs,
    currentStreakDays,
    longestStreakDays,
  };
}

/**
 * 获取 Token 活动热力图（对齐 GitHub / newapi，近 52 周，共 52*7=364 天网格）
 */
export function getActivityHeatmap(): ActivityHeatmapDay[] {
  const now = Date.now();
  const today = startOfLocalDay(now);
  const dObj = new Date(today);
  const dayOfWeek = dObj.getDay(); // 0(周日)..6(周六)
  // 让网格末尾对齐本周六，往前推 52 周
  const endSaturday = today + (6 - dayOfWeek) * DAY;
  const totalDays = 52 * 7;
  const startDay = endSaturday - (totalDays - 1) * DAY;

  // 聚合每日用量
  const dayMap = new Map<number, { tokens: number; requests: number }>();
  for (const b of buckets.values()) {
    const day = startOfLocalDay(b.hour);
    if (day >= startDay && day <= endSaturday) {
      let cur = dayMap.get(day);
      if (!cur) {
        cur = { tokens: 0, requests: 0 };
        dayMap.set(day, cur);
      }
      cur.tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
      cur.requests += b.requests;
    }
  }

  // 计算最大值以划分 4 档 level (1..4)
  let maxTokens = 0;
  for (const v of dayMap.values()) {
    if (v.tokens > maxTokens) maxTokens = v.tokens;
  }
  const q1 = maxTokens * 0.15;
  const q2 = maxTokens * 0.4;
  const q3 = maxTokens * 0.7;

  const result: ActivityHeatmapDay[] = [];
  for (let t = startDay; t <= endSaturday; t += DAY) {
    const v = dayMap.get(t) || { tokens: 0, requests: 0 };
    const dateObj = new Date(t);
    const mStr = String(dateObj.getMonth() + 1).padStart(2, "0");
    const dStr = String(dateObj.getDate()).padStart(2, "0");
    const dateStr = `${dateObj.getFullYear()}-${mStr}-${dStr}`;

    let level = 0;
    if (v.tokens > 0 || v.requests > 0) {
      if (maxTokens <= 0 || v.tokens <= q1) level = 1;
      else if (v.tokens <= q2) level = 2;
      else if (v.tokens <= q3) level = 3;
      else level = 4;
    }

    result.push({
      date: dateStr,
      dayTs: t,
      tokens: v.tokens,
      requests: v.requests,
      level,
    });
  }

  return result;
}

/**
 * 模型用量占比（Donut 环形图数据）
 */
export function getModelUsageRatios(range: Range): ModelUsageRatio[] {
  const map = new Map<string, { tokens: number; requests: number }>();
  for (const b of bucketsIn(range)) {
    let cur = map.get(b.model);
    if (!cur) {
      cur = { tokens: 0, requests: 0 };
      map.set(b.model, cur);
    }
    cur.tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    cur.requests += b.requests;
  }

  const list = [...map.entries()].map(([model, v]) => ({ model, ...v }));
  list.sort((a, b) => b.tokens - a.tokens);
  const sumTokens = list.reduce((acc, x) => acc + x.tokens, 0);

  return list.map((item) => ({
    model: item.model,
    tokens: item.tokens,
    requests: item.requests,
    percent: sumTokens > 0 ? Number(((item.tokens / sumTokens) * 100).toFixed(1)) : 0,
  }));
}

/**
 * 桑基分流图数据结构计算：
 * 拓扑：渠道 (Provider) -> 凭证 (Credential/Key) -> 模型 (Model) -> 结果状态 (Success / Fail) -> 缓存与Token构成 (Cache & Token Flow)
 */

export interface ContextBreakdownStats {
  totalInputTokens: number;
  filesTokens: number;
  historyTokens: number;
  toolsTokens: number;
  rulesTokens: number;
  currentInputTokens: number;
  filesPct: number;
  historyPct: number;
  toolsPct: number;
  rulesPct: number;
  currentPct: number;
  /** 范围内的明细已被 2000 条 / 30 天上限裁掉一部分，本结果改由小时桶聚合而来（UI 可据此提示）。 */
  detailTruncated: boolean;
}

/**
 * 范围内的明细是否完整：桶里的请求数是记账时同步累加的，只有明细会被裁（条数 / 天数上限），
 * 所以「桶请求数 > 范围内明细条数」就是明细缺了。桑基与上下文卡以前「有明细就只用明细」，
 * 明细被裁后 30d / 全部 范围静默少报（探针：3000 条 / 45 天账本 30d 少 16.9%、全部少 33.2%），
 * 与走桶的总览卡对不上；现在明细不完整时整段改走桶（与总览卡同源，四项之和逐字相等）。
 * 不做「明细段 + 桶段」拼接：桶没有凭证维度，拼接会让凭证层与渠道层的流量不守恒。
 */
function detailTruncatedIn(range: Range, detailCount: number): boolean {
  let bucketRequests = 0;
  for (const b of bucketsIn(range)) {
    bucketRequests += b.requests;
  }
  return bucketRequests > detailCount;
}

export function getContextBreakdownStats(range: Range): ContextBreakdownStats {
  let filesTokens = 0;
  let historyTokens = 0;
  let toolsTokens = 0;
  let rulesTokens = 0;
  let currentInputTokens = 0;

  const filtered = records.filter((r) => r.ts >= range.from && r.ts <= range.to);
  const detailTruncated = detailTruncatedIn(range, filtered.length);
  if (filtered.length > 0 && !detailTruncated) {
    for (const r of filtered) {
      if (r.contextBreakdown) {
        filesTokens += r.contextBreakdown.filesTokens || 0;
        historyTokens += r.contextBreakdown.historyTokens || 0;
        toolsTokens += r.contextBreakdown.toolsTokens || 0;
        rulesTokens += r.contextBreakdown.rulesTokens || 0;
        currentInputTokens += r.contextBreakdown.currentInputTokens || 0;
      } else if (r.inputTokens > 0) {
        // 无细分时兜底
        currentInputTokens += r.inputTokens;
      }
    }
  } else {
    for (const b of bucketsIn(range)) {
      const hasCtx =
        b.ctxFilesTokens !== undefined ||
        b.ctxHistoryTokens !== undefined ||
        b.ctxToolsTokens !== undefined ||
        b.ctxRulesTokens !== undefined ||
        b.ctxInputTokens !== undefined;
      filesTokens += b.ctxFilesTokens || 0;
      historyTokens += b.ctxHistoryTokens || 0;
      toolsTokens += b.ctxToolsTokens || 0;
      rulesTokens += b.ctxRulesTokens || 0;
      // 只有完全没有细分字段的老桶才把 inputTokens 整体当「当前输入」；有细分但 ctxInputTokens 为 0 时不能再叠一份
      currentInputTokens += hasCtx ? b.ctxInputTokens || 0 : b.inputTokens || 0;
    }
  }

  const total = filesTokens + historyTokens + toolsTokens + rulesTokens + currentInputTokens;
  return {
    totalInputTokens: total,
    filesTokens,
    historyTokens,
    toolsTokens,
    rulesTokens,
    currentInputTokens,
    filesPct: total > 0 ? (filesTokens / total) * 100 : 0,
    historyPct: total > 0 ? (historyTokens / total) * 100 : 0,
    toolsPct: total > 0 ? (toolsTokens / total) * 100 : 0,
    rulesPct: total > 0 ? (rulesTokens / total) * 100 : 0,
    currentPct: total > 0 ? (currentInputTokens / total) * 100 : 0,
    detailTruncated,
  };
}

export function getSankeyData(range: Range): SankeyData {
  const filteredRecords = records.filter((r) => r.ts >= range.from && r.ts <= range.to);
  const detailTruncated = detailTruncatedIn(range, filteredRecords.length);

  const nodeMap = new Map<string, { id: string; name: string; layer: number; color?: string }>();
  const linkMap = new Map<string, { source: string; target: string; tokens: number; requests: number }>();

  const addNode = (id: string, name: string, layer: number, color?: string) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, name, layer, color });
    }
  };

  const addLink = (source: string, target: string, tokens: number, requests: number) => {
    const key = `${source}-->${target}`;
    let cur = linkMap.get(key);
    if (!cur) {
      cur = { source, target, tokens: 0, requests: 0 };
      linkMap.set(key, cur);
    }
    cur.tokens += tokens;
    cur.requests += requests;
  };

  if (filteredRecords.length > 0 && !detailTruncated) {
    for (const r of filteredRecords) {
      const pId = `p:${r.providerId}`;
      const pName = r.providerName || r.providerId;
      const cId = `c:${r.providerId}:${r.credentialId || "main"}`;
      const cName = r.credentialId ? (r.credentialId.length > 12 ? r.credentialId.slice(0, 10) + "…" : r.credentialId) : "默认凭证";
      const mId = `m:${r.model}`;
      const mName = r.model;
      const sId = r.ok ? "s:success" : "s:failed";
      const sName = r.ok ? "调用成功 200" : "异常重试 / 失败";

      const inTok = r.inputTokens || 0;
      const outTok = r.outputTokens || 0;
      const readTok = r.cacheReadTokens || 0;
      const writeTok = r.cacheWriteTokens || 0;
      const totalTok = inTok + outTok + readTok + writeTok;

      // Layer 0 ~ 3: 渠道 -> 凭证 -> 模型 -> 状态 (请求数严格为整数 1)
      addNode(pId, pName, 0);
      addNode(cId, cName, 1);
      addNode(mId, mName, 2);
      addNode(sId, sName, 3, r.ok ? "var(--green)" : "var(--red)");

      addLink(pId, cId, totalTok, 1);
      addLink(cId, mId, totalTok, 1);
      addLink(mId, sId, totalTok, 1);

      // Layer 4: 缓存命中与 Token 细分流向 (仅承载 Token 分流，requests 设为 0，防止把 1 次请求在多个 Token 门重复计算或产出小数)
      if (readTok > 0) {
        const id = "t:cache_read";
        addNode(id, "缓存命中读取 (Cache Read)", 4, "#10b981");
        addLink(sId, id, readTok, 0);
      }
      if (writeTok > 0) {
        const id = "t:cache_write";
        addNode(id, "缓存创建写入 (Cache Write)", 4, "#a855f7");
        addLink(sId, id, writeTok, 0);
      }
      if (inTok > 0) {
        const id = "t:input";
        addNode(id, "常规输入 (Prompt Input)", 4, "#38bdf8");
        addLink(sId, id, inTok, 0);

      }
      if (outTok > 0) {
        const id = "t:output";
        addNode(id, "模型生成 (Completion Output)", 4, "#f59e0b");
        addLink(sId, id, outTok, 0);
      }
    }
  } else {
    // 降级使用 buckets（范围内明细为空或被裁掉一部分时）：拓扑少凭证层——渠道 → 模型 → 状态 → Token 门；
    // 与总览卡同一组桶，Token 门之和 === summarize(range).totalTokens
    for (const b of bucketsIn(range)) {
      const pId = `p:${b.providerId}`;
      const pName = b.providerName || b.providerId;
      const mId = `m:${b.model}`;
      const mName = b.model;
      const sOkId = "s:success";
      const sFailId = "s:failed";

      const inTok = b.inputTokens || 0;
      const outTok = b.outputTokens || 0;
      const readTok = b.cacheReadTokens || 0;
      const writeTok = b.cacheWriteTokens || 0;
      const totalTok = inTok + outTok + readTok + writeTok;
      const succReq = Math.max(0, b.requests - b.failures);
      const failReq = Math.max(0, b.requests - succReq);
      if (b.requests <= 0 && totalTok <= 0) {
        continue;
      }

      addNode(pId, pName, 0);
      addNode(mId, mName, 1);
      if (succReq > 0) addNode(sOkId, "调用成功 200", 2, "var(--green)");
      if (failReq > 0) addNode(sFailId, "异常重试 / 失败", 2, "var(--red)");

      addLink(pId, mId, totalTok, b.requests);

      // 桶里成功与失败混在一起时，把每类 Token 按成功占比切给成功态、其余给失败态；
      // 状态节点的入流定义为「它分到的四类之和」，这样每个状态的入流 === 出流，与明细路径一样守恒。
      const shareOk = (v: number) => (succReq > 0 ? (failReq > 0 ? Math.round((v * succReq) / b.requests) : v) : 0);
      const parts: Array<[string, string, string, number]> = [
        ["t:cache_read", "缓存命中读取 (Cache Read)", "#10b981", readTok],
        ["t:cache_write", "缓存创建写入 (Cache Write)", "#a855f7", writeTok],
        ["t:input", "常规输入 (Prompt Input)", "#38bdf8", inTok],
        ["t:output", "模型生成 (Completion Output)", "#f59e0b", outTok],
      ];
      let okIn = 0;
      let failIn = 0;
      for (const [id, name, color, v] of parts) {
        if (v <= 0) {
          continue;
        }
        const ok = succReq > 0 ? shareOk(v) : 0;
        const fail = failReq > 0 ? v - ok : 0;
        addNode(id, name, 3, color);
        if (ok > 0) {
          addLink(sOkId, id, ok, 0);
          okIn += ok;
        }
        if (fail > 0) {
          addLink(sFailId, id, fail, 0);
          failIn += fail;
        }
      }
      // 没有失败请求时全部 Token 归成功态（反之亦然），四类之和恒等于 totalTok
      if (succReq > 0) addLink(mId, sOkId, failReq > 0 ? okIn : totalTok, succReq);
      if (failReq > 0) addLink(mId, sFailId, succReq > 0 ? failIn : totalTok, failReq);
    }
  }

  return {
    nodes: [...nodeMap.values()],
    links: [...linkMap.values()],
    detailTruncated,
  };
}

/** 测试/诊断。 */
export function _debugState(): { records: number; buckets: number } {
  return { records: records.length, buckets: buckets.size };
}

export function _resetForTest(): void {
  records = [];
  buckets.clear();
  credTotals.clear();
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}
