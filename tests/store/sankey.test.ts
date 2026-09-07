/** getSankeyData：次数整数、Token 守恒、凭证层降级、桶降级拓扑。 */
import * as vscode from "vscode";
import { test, run, eq, ok, deepEq } from "./harness";
import { SankeyData, UsageRecord, _resetForTest, getSankeyData, initUsageStore, recordUsage } from "../../src/usageStore";

const stub = vscode as unknown as { __makeContext(): { globalState: { update(k: string, v: unknown): Promise<void> } }; __reset(): void };
const KEY = "usage.ledger.v1";
const HOUR = 3600_000;
const ALL = { from: 0, to: Date.now() + HOUR };

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

function fresh() {
  _resetForTest();
  stub.__reset();
  const ctx = stub.__makeContext();
  initUsageStore(ctx as never);
  return ctx;
}

const layerOf = (d: SankeyData, id: string) => d.nodes.find((n) => n.id === id)?.layer;
const inflow = (d: SankeyData, id: string, k: "tokens" | "requests") => d.links.filter((l) => l.target === id).reduce((s, l) => s + l[k], 0);
const outflow = (d: SankeyData, id: string, k: "tokens" | "requests") => d.links.filter((l) => l.source === id).reduce((s, l) => s + l[k], 0);

/** 所有中间节点（既有入边又有出边）在给定维度上入 === 出。 */
function assertConserved(d: SankeyData, k: "tokens" | "requests", skipZeroOut = false) {
  for (const n of d.nodes) {
    const hasIn = d.links.some((l) => l.target === n.id);
    const hasOut = d.links.some((l) => l.source === n.id);
    if (!hasIn || !hasOut) {
      continue;
    }
    const i = inflow(d, n.id, k);
    const o = outflow(d, n.id, k);
    if (skipZeroOut && o === 0) {
      continue;
    }
    eq(o, i, `${k} 守恒 @ ${n.id}`);
  }
}

test("明细路径：每条记录对 Layer0–3 三条边各贡献整数 1；Layer4 边 requests=0", () => {
  fresh();
  recordUsage(rec({ credentialId: "c1" }));
  recordUsage(rec({ credentialId: "c1" }));
  recordUsage(rec({ credentialId: "c2", ok: false, status: 500 }));
  const d = getSankeyData(ALL);
  for (const l of d.links) {
    ok(Number.isInteger(l.requests), `requests 必须是整数：${l.source}→${l.target}=${l.requests}`);
    const tl = layerOf(d, l.target)!;
    if (tl <= 3) {
      ok(l.requests >= 1, `Layer${tl} 边 requests ≥ 1`);
    } else {
      eq(l.requests, 0, `Layer${tl} 边 requests 必须为 0`);
    }
  }
  eq(inflow(d, "c:p1:c1", "requests"), 2);
  eq(inflow(d, "c:p1:c2", "requests"), 1);
  eq(inflow(d, "m:m-a", "requests"), 3);
  eq(inflow(d, "s:success", "requests"), 2);
  eq(inflow(d, "s:failed", "requests"), 1);
  eq(outflow(d, "s:success", "requests"), 0);
  // 次数维在 Layer0–3 守恒
  eq(outflow(d, "p:p1", "requests"), 3);
  eq(outflow(d, "c:p1:c1", "requests"), 2);
  eq(outflow(d, "m:m-a", "requests"), 3);
});

test("明细路径：Token 边四项之和 == 状态层入流；全图中间节点守恒", () => {
  fresh();
  recordUsage(rec({ credentialId: "c1", inputTokens: 111, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 4 }));
  recordUsage(rec({ credentialId: "c1", inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  recordUsage(rec({ credentialId: "c2", ok: false, inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1, model: "m-b" }));
  const d = getSankeyData(ALL);
  const okIn = inflow(d, "s:success", "tokens");
  eq(okIn, 111 + 22 + 33 + 4 + 5);
  eq(outflow(d, "s:success", "tokens"), okIn, "四项之和 == 入流");
  eq(inflow(d, "s:failed", "tokens"), 10);
  eq(outflow(d, "s:failed", "tokens"), 10);
  assertConserved(d, "tokens");
  // 每个 Token 门的值
  eq(inflow(d, "t:input", "tokens"), 111 + 5 + 9);
  eq(inflow(d, "t:output", "tokens"), 22);
  eq(inflow(d, "t:cache_read", "tokens"), 33);
  eq(inflow(d, "t:cache_write", "tokens"), 5);
  deepEq(
    ["t:input", "t:output", "t:cache_read", "t:cache_write"].map((id) => layerOf(d, id)),
    [4, 4, 4, 4]
  );
});

test("明细路径：无 credentialId 的记录落到 c:<provider>:main「默认凭证」，拓扑仍是 5 层", () => {
  fresh();
  recordUsage(rec({}));
  const d = getSankeyData(ALL);
  const c = d.nodes.find((n) => n.id === "c:p1:main")!;
  ok(c, "默认凭证节点");
  eq(c.name, "默认凭证");
  eq(c.layer, 1);
  eq(layerOf(d, "p:p1"), 0);
  eq(layerOf(d, "m:m-a"), 2);
  eq(layerOf(d, "s:success"), 3);
  eq(inflow(d, "c:p1:main", "requests"), 1);
  assertConserved(d, "tokens");
});

test("明细路径：零 Token 的失败记录也计一次，不产生 Token 门边", () => {
  fresh();
  recordUsage(rec({ ok: false, status: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const d = getSankeyData(ALL);
  eq(inflow(d, "s:failed", "requests"), 1);
  eq(inflow(d, "s:failed", "tokens"), 0);
  eq(d.nodes.filter((n) => n.id.startsWith("t:")).length, 0);
});

test("桶降级路径：明细为空时按桶画 4 层（无凭证层），次数为整数且 Token 守恒（含成功失败混桶）", async () => {
  fresh();
  const ctx = stub.__makeContext();
  const now = Date.now();
  const h = now - (now % HOUR);
  await ctx.globalState.update(KEY, {
    v: 1,
    records: [],
    buckets: [
      // 3 成功 1 失败混在一桶：以前四类 Token 全挂在成功态，成功态入 != 出
      { hour: h, providerId: "p1", providerName: "渠道一", model: "a", protocol: "openai", requests: 4, failures: 1, inputTokens: 1001, outputTokens: 203, cacheReadTokens: 57, cacheWriteTokens: 9, latencySumMs: 1, firstTokenCount: 0, firstTokenSumMs: 0 },
      // 全成功
      { hour: h - HOUR, providerId: "p1", providerName: "渠道一", model: "b", protocol: "openai", requests: 2, failures: 0, inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, latencySumMs: 1, firstTokenCount: 0, firstTokenSumMs: 0 },
      // 全失败
      { hour: h - HOUR, providerId: "p2", providerName: "二号", model: "a", protocol: "anthropic", requests: 1, failures: 1, inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencySumMs: 1, firstTokenCount: 0, firstTokenSumMs: 0 },
    ],
  });
  _resetForTest();
  initUsageStore(ctx as never);
  const d = getSankeyData({ from: 0, to: now + 1 });
  ok(!d.nodes.some((n) => n.id.startsWith("c:")), "降级无凭证层");
  eq(layerOf(d, "p:p1"), 0);
  eq(layerOf(d, "m:a"), 1);
  eq(layerOf(d, "s:success"), 2);
  eq(layerOf(d, "s:failed"), 2);
  eq(layerOf(d, "t:input"), 3);
  eq(d.nodes.find((n) => n.id === "p:p1")!.name, "渠道一", "用 providerName 不是 id");
  for (const l of d.links) {
    ok(Number.isInteger(l.requests), `整数次数 ${l.source}→${l.target}=${l.requests}`);
    if (l.target.startsWith("t:")) {
      eq(l.requests, 0);
    }
  }
  eq(inflow(d, "s:success", "requests"), 5);
  eq(inflow(d, "s:failed", "requests"), 2);
  eq(outflow(d, "p:p1", "requests"), 6);
  eq(outflow(d, "p:p2", "requests"), 1);
  assertConserved(d, "tokens");
  assertConserved(d, "requests", true);
  // 总 Token 守恒：所有 Token 门入流之和 == 全部桶四项之和
  const gates = d.nodes.filter((n) => n.id.startsWith("t:")).reduce((s, n) => s + inflow(d, n.id, "tokens"), 0);
  eq(gates, 1001 + 203 + 57 + 9 + 300 + 40 + 12);
  eq(inflow(d, "t:input", "tokens"), 1001 + 300 + 12);
});

test("范围过滤：range 外的记录不进图", () => {
  fresh();
  const now = Date.now();
  recordUsage(rec({ ts: now - 3 * HOUR, model: "old" }));
  recordUsage(rec({ ts: now, model: "new" }));
  const d = getSankeyData({ from: now - HOUR, to: now + 1 });
  ok(d.nodes.some((n) => n.id === "m:new"));
  ok(!d.nodes.some((n) => n.id === "m:old"));
});

run();
