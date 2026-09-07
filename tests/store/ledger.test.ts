/** usageStore：溢出守恒、范围边界、防抖落盘、上下文五项之和。 */
import * as vscode from "vscode";
import { test, run, eq, ok, deepEq, sleep, waitFor } from "./harness";
import {
  UsageRecord,
  _debugState,
  _resetForTest,
  credentialTotals,
  flush,
  getContextBreakdownStats,
  getTimeSeriesTrend,
  initUsageStore,
  recentRecords,
  recordUsage,
  resolveRange,
  statsByProvider,
  summarize,
} from "../../src/usageStore";

type Ctx = { globalState: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Promise<void>; updates: number } };
const stub = vscode as unknown as { __makeContext(): Ctx; __reset(): void };

const KEY = "usage.ledger.v1";
const HOUR = 3600_000;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: Date.now(),
    providerId: "p1",
    providerName: "渠道一",
    model: "m-a",
    protocol: "openai",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    latencyMs: 500,
    status: 200,
    ok: true,
    ...over,
  };
}

function freshStore(): Ctx {
  _resetForTest();
  stub.__reset();
  const ctx = stub.__makeContext();
  initUsageStore(ctx as never);
  return ctx;
}

const ALL = { from: 0, to: Date.now() + HOUR };

// ---------------------------------------------------------------- 溢出守恒

test("recordUsage：写入 2100 条后明细裁到 2000，桶里总量仍是 2100 条的和", () => {
  freshStore();
  const now = Date.now();
  let want = { requests: 0, input: 0, output: 0, read: 0, write: 0, failures: 0 };
  for (let i = 0; i < 2100; i++) {
    const r = rec({ ts: now - (2100 - i) * 1000, inputTokens: 1 + (i % 7), outputTokens: i % 3, cacheReadTokens: i % 5, cacheWriteTokens: i % 2, ok: i % 10 !== 0 });
    recordUsage(r);
    want = {
      requests: want.requests + 1,
      input: want.input + r.inputTokens,
      output: want.output + r.outputTokens,
      read: want.read + r.cacheReadTokens,
      write: want.write + r.cacheWriteTokens,
      failures: want.failures + (r.ok ? 0 : 1),
    };
  }
  eq(_debugState().records, 2000, "明细上限 2000");
  const s = summarize(ALL);
  eq(s.requests, want.requests);
  eq(s.failures, want.failures);
  eq(s.inputTokens, want.input);
  eq(s.outputTokens, want.output);
  eq(s.cacheReadTokens, want.read);
  eq(s.cacheWriteTokens, want.write);
  eq(s.totalTokens, want.input + want.output + want.read + want.write);
  // 明细保留的是最新的 2000 条
  const newest = recentRecords(1)[0];
  eq(newest.ts, now - 1000);
  eq(recentRecords(5000).length, 2000);
});

test("recordUsage：credentialTotals 按凭证累加；无 credentialId 不记", () => {
  freshStore();
  recordUsage(rec({ credentialId: "c1" }));
  recordUsage(rec({ credentialId: "c1", ok: false, status: 429, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  recordUsage(rec({ credentialId: "c2" }));
  recordUsage(rec({}));
  const totals = credentialTotals("p1").sort((a, b) => a.credentialId.localeCompare(b.credentialId));
  eq(totals.length, 2);
  eq(totals[0].credentialId, "c1");
  eq(totals[0].requests, 2);
  eq(totals[0].failures, 1);
  eq(totals[0].tokens, 160);
  eq(totals[1].requests, 1);
});

test("statsByProvider：级联聚合与 provider 改名跟随", () => {
  freshStore();
  recordUsage(rec({ providerName: "旧名", model: "a" }));
  recordUsage(rec({ providerName: "新名", model: "b", inputTokens: 1000 }));
  recordUsage(rec({ providerId: "p2", providerName: "二号", model: "a" }));
  const st = statsByProvider(ALL);
  eq(st.length, 2);
  eq(st[0].providerId, "p1", "按 totalTokens 降序");
  eq(st[0].providerName, "新名");
  eq(st[0].models.length, 2);
  eq(st[0].models[0].model, "b");
  eq(st[0].requests, 2);
  eq(st[1].providerId, "p2");
});

// ---------------------------------------------------------------- resolveRange 边界

test("resolveRange：今天 00:00 进，昨天 23:59:59.999 不进；7d/30d 从本地 0 点起", () => {
  freshStore();
  const now = new Date(2026, 8, 6, 15, 30, 0).getTime();
  const r = resolveRange("today", now);
  const midnight = new Date(2026, 8, 6, 0, 0, 0, 0).getTime();
  eq(r.from, midnight);
  eq(r.to, now);
  recordUsage(rec({ ts: midnight, model: "in" }));
  recordUsage(rec({ ts: midnight - 1, model: "out" }));
  const recs = recentRecords(10, r);
  deepEq(
    recs.map((x) => x.model),
    ["in"]
  );
  // 桶维度同样：昨天 23 点的桶不算进今天
  const s = summarize(r);
  eq(s.requests, 1);
  eq(summarize({ from: midnight - 1, to: now }).requests, 2);
  const r7 = resolveRange("7d", now);
  eq(r7.from, new Date(2026, 7, 31, 0, 0, 0, 0).getTime(), "7d 含今天共 7 个自然日");
  const r30 = resolveRange("30d", now);
  eq(r30.from, new Date(2026, 7, 8, 0, 0, 0, 0).getTime());
  deepEq(resolveRange("all", now), { from: 0, to: now });
});

// ---------------------------------------------------------------- 趋势时间轴不越过现在

test("getTimeSeriesTrend：今天范围用 10 分钟细桶、只到当前槽（15:30 → 00:00..15:30 共 94 点），按真实请求 ts 落槽，不生成未来槽", () => {
  freshStore();
  const now = new Date(2026, 8, 6, 15, 30, 0).getTime();
  const r = resolveRange("today", now);
  const start = new Date(2026, 8, 6, 0, 0, 0, 0).getTime();
  const SLOT = 10 * 60_000;
  recordUsage(rec({ ts: new Date(2026, 8, 6, 15, 10, 0).getTime(), model: "m-a", inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 })); // 15:10
  recordUsage(rec({ ts: new Date(2026, 8, 6, 9, 5, 0).getTime(), model: "m-b", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })); // 09:05 → 09:00 槽
  const pts = getTimeSeriesTrend("today", r);
  eq(pts.length, 94, "00:00 到 15:30 每 10 分钟一格共 94 个，不含 15:40 及之后");
  eq(pts[0].label, "00:00");
  eq(pts[93].label, "15:30");
  eq(pts[93].ts, start + 93 * SLOT);
  const i1510 = Math.floor((new Date(2026, 8, 6, 15, 10, 0).getTime() - start) / SLOT); // 91
  eq(pts[i1510].tokens, 160, "15:10 槽按该 10 分钟内的量计");
  eq(pts[i1510].requests, 1);
  const i0900 = Math.floor((new Date(2026, 8, 6, 9, 5, 0).getTime() - start) / SLOT); // 54（09:00 槽）
  eq(pts[i0900].label, "09:00");
  eq(pts[i0900].tokens, 2);
  eq(pts[i0900].modelRequests["m-b"], 1);
  ok(pts.every((p) => p.ts <= now), "没有任何点在 now 之后");
  // 刚过 0 点：至少保留 0 点这一格，不出空图
  const early = new Date(2026, 8, 6, 0, 0, 30).getTime();
  const p0 = getTimeSeriesTrend("today", resolveRange("today", early));
  eq(p0.length, 1);
  eq(p0[0].label, "00:00");
  // 23:59 才补满全天 144 格（最后一格 23:50）
  const late = new Date(2026, 8, 6, 23, 59, 0).getTime();
  const pl = getTimeSeriesTrend("today", resolveRange("today", late));
  eq(pl.length, 144);
  eq(pl[143].label, "23:50");
  // 多天范围仍按天、不越过今天：7d 在 09-06 15:30 是 08-31..09-06 共 7 点，最后一点是今天 0 点、含两条记录之和
  const p7 = getTimeSeriesTrend("7d", resolveRange("7d", now));
  eq(p7.length, 7);
  eq(p7[6].ts, new Date(2026, 8, 6, 0, 0, 0, 0).getTime());
  eq(p7[6].tokens, 162);
});

// ---------------------------------------------------------------- flush 防抖

test("flush：多次 recordUsage 只落盘一次且包含全部；写入期间新记录不丢", async () => {
  const ctx = freshStore();
  const before = ctx.globalState.updates;
  for (let i = 0; i < 5; i++) {
    recordUsage(rec({ model: "m" + i }));
  }
  eq(ctx.globalState.updates, before, "800ms 内还没写");
  await waitFor(() => ctx.globalState.updates > before, 3000);
  eq(ctx.globalState.updates, before + 1, "只写一次");
  const saved = ctx.globalState.get<{ records: UsageRecord[]; buckets: unknown[] }>(KEY)!;
  eq(saved.records.length, 5);
  // 再记一条：再次防抖落盘，内容追加而非覆盖丢失
  recordUsage(rec({ model: "late" }));
  await waitFor(() => ctx.globalState.updates > before + 1, 3000);
  const saved2 = ctx.globalState.get<{ records: UsageRecord[] }>(KEY)!;
  eq(saved2.records.length, 6);
  eq(saved2.records[5].model, "late");
});

test("flush：globalState.update 慢写时，写入中途到来的记录会再次触发落盘", async () => {
  const ctx = freshStore();
  const origUpdate = ctx.globalState.update.bind(ctx.globalState);
  let slowOnce = true;
  ctx.globalState.update = async (k: string, v: unknown) => {
    if (slowOnce) {
      slowOnce = false;
      await sleep(150);
    }
    return origUpdate(k, v);
  };
  recordUsage(rec({ model: "first" }));
  await sleep(850); // 进入慢写
  recordUsage(rec({ model: "during" }));
  await waitFor(() => (ctx.globalState.get<{ records: UsageRecord[] }>(KEY)?.records.length || 0) >= 2, 4000);
  const saved = ctx.globalState.get<{ records: UsageRecord[] }>(KEY)!;
  deepEq(
    saved.records.map((r) => r.model),
    ["first", "during"]
  );
});

test("initUsageStore：从 globalState 恢复并按 2000 条 / 30 天裁剪，桶保留", async () => {
  freshStore();
  const ctx = stub.__makeContext();
  const now = Date.now();
  const old = rec({ ts: now - 40 * 86_400_000, model: "old" });
  const recent = rec({ ts: now - 1000, model: "recent" });
  await ctx.globalState.update(KEY, {
    v: 1,
    records: [old, recent],
    buckets: [
      { hour: old.ts - (old.ts % HOUR), providerId: "p1", providerName: "渠道一", model: "old", protocol: "openai", requests: 1, failures: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, latencySumMs: 500, firstTokenCount: 0, firstTokenSumMs: 0 },
      { hour: recent.ts - (recent.ts % HOUR), providerId: "p1", providerName: "渠道一", model: "recent", protocol: "openai", requests: 1, failures: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, latencySumMs: 500, firstTokenCount: 0, firstTokenSumMs: 0 },
    ],
  });
  _resetForTest();
  initUsageStore(ctx as never);
  eq(_debugState().records, 1, "40 天前的明细被裁");
  eq(_debugState().buckets, 2, "桶保留 400 天");
  eq(summarize({ from: 0, to: now }).requests, 2, "总量不丢");
});

// ---------------------------------------------------------------- getContextBreakdownStats

test("getContextBreakdownStats：五项之和 === totalInputTokens，且等于各记录 inputTokens 之和（含无细分兜底）", () => {
  freshStore();
  recordUsage(rec({ inputTokens: 1000, contextBreakdown: { filesTokens: 300, historyTokens: 200, toolsTokens: 250, rulesTokens: 150, currentInputTokens: 100 } }));
  recordUsage(rec({ inputTokens: 77 })); // 无细分 → 全部当前输入
  recordUsage(rec({ inputTokens: 500, contextBreakdown: { filesTokens: 0, historyTokens: 500, toolsTokens: 0, rulesTokens: 0, currentInputTokens: 0 } }));
  const s = getContextBreakdownStats(ALL);
  eq(s.filesTokens + s.historyTokens + s.toolsTokens + s.rulesTokens + s.currentInputTokens, s.totalInputTokens);
  eq(s.totalInputTokens, 1577);
  eq(s.currentInputTokens, 177);
  eq(s.historyTokens, 700);
  const pct = s.filesPct + s.historyPct + s.toolsPct + s.rulesPct + s.currentPct;
  ok(Math.abs(pct - 100) < 1e-9, `百分比之和 ${pct}`);
});

test("getContextBreakdownStats：明细被裁后走桶降级，五项之和仍等于桶的 inputTokens（ctxInputTokens 为 0 不重复计）", async () => {
  freshStore();
  const ctx = stub.__makeContext();
  const now = Date.now();
  const h = now - (now % HOUR);
  await ctx.globalState.update(KEY, {
    v: 1,
    records: [],
    buckets: [
      // 有细分且 ctxInputTokens=0（全部分给历史）：以前的 `ctxInputTokens || inputTokens` 会把 500 再叠一份
      { hour: h, providerId: "p1", providerName: "渠道一", model: "a", protocol: "openai", requests: 1, failures: 0, inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencySumMs: 1, firstTokenCount: 0, firstTokenSumMs: 0, ctxFilesTokens: 0, ctxHistoryTokens: 500, ctxToolsTokens: 0, ctxRulesTokens: 0, ctxInputTokens: 0 },
      // 老桶没有任何细分字段：inputTokens 整体当作当前输入
      { hour: h, providerId: "p1", providerName: "渠道一", model: "b", protocol: "openai", requests: 1, failures: 0, inputTokens: 80, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencySumMs: 1, firstTokenCount: 0, firstTokenSumMs: 0 },
    ],
  });
  _resetForTest();
  initUsageStore(ctx as never);
  const s = getContextBreakdownStats({ from: 0, to: now + 1 });
  eq(s.totalInputTokens, 580);
  eq(s.historyTokens, 500);
  eq(s.currentInputTokens, 80);
});

test("recordUsage：无细分的记录也把 inputTokens 计入桶的 ctxInputTokens，桶五项之和 == 桶 inputTokens", async () => {
  const ctx = freshStore();
  recordUsage(rec({ inputTokens: 40 }));
  recordUsage(rec({ inputTokens: 60, contextBreakdown: { filesTokens: 10, historyTokens: 20, toolsTokens: 5, rulesTokens: 5, currentInputTokens: 20 } }));
  await flush();
  const saved = ctx.globalState.get<{ buckets: Array<Record<string, number>> }>(KEY)!;
  const b = saved.buckets[0];
  eq(b.inputTokens, 100);
  eq((b.ctxFilesTokens || 0) + (b.ctxHistoryTokens || 0) + (b.ctxToolsTokens || 0) + (b.ctxRulesTokens || 0) + (b.ctxInputTokens || 0), 100);
  eq(b.ctxInputTokens, 60);
});

run();
