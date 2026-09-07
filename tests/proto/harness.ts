/**
 * 极简断言 / 用例收集器。每个套件在文件末尾调用 `run()`；输出格式固定为逐行 `PASS ...` / `FAIL ...`
 * 加末行 `N passed, M failed`，供 run.js 汇总。
 */

import { CwEvent } from "../../src/cwTypes";
import { StreamConverter } from "../../src/streamShared";

type Fn = () => void | Promise<void>;

const cases: Array<{ name: string; fn: Fn }> = [];

export function test(name: string, fn: Fn): void {
  cases.push({ name, fn });
}

export class AssertionError extends Error {}

export function ok(cond: unknown, msg: string): void {
  if (!cond) {
    throw new AssertionError(msg);
  }
}

export function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new AssertionError(`${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

export function includes(hay: string, needle: string, msg: string): void {
  if (!hay.includes(needle)) {
    throw new AssertionError(`${msg}\n    expected to contain: ${JSON.stringify(needle)}\n    in: ${JSON.stringify(hay.slice(0, 400))}`);
  }
}

export function notIncludes(hay: string, needle: string, msg: string): void {
  if (hay.includes(needle)) {
    throw new AssertionError(`${msg}\n    expected NOT to contain: ${JSON.stringify(needle)}`);
  }
}

export async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`PASS ${c.name}`);
    } catch (e) {
      failed++;
      const err = e as Error;
      console.log(`FAIL ${c.name}\n    ${(err && err.stack ? err.stack : String(err)).split("\n").slice(0, 6).join("\n    ")}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  // 有些 src 模块会留下 setTimeout（usageStore 防抖落盘等），显式退出
  process.exit(failed === 0 && passed > 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------------------
// 流转换器辅助
// ----------------------------------------------------------------------------------------

/** 把若干 SSE 数据对象依次喂给转换器（每个对象一行 `data: {...}`），再 flush，返回全部事件。 */
export function feedSse(conv: StreamConverter, payloads: unknown[], opts: { flush?: boolean } = {}): CwEvent[] {
  const out: CwEvent[] = [];
  for (const p of payloads) {
    const line = typeof p === "string" ? p : "data: " + JSON.stringify(p);
    out.push(...conv.processLine(line));
  }
  if (opts.flush !== false) {
    out.push(...conv.flush());
  }
  return out;
}

export const STOP_REASONS = ["END_TURN", "MAX_TOKENS", "TOOL_USE", "STOP_SEQUENCE"];

/** 流末最后一帧必须是合法 stopReason 的 metadataEvent。返回该 stopReason。 */
export function assertTrailingStopReason(events: CwEvent[], label: string): string {
  ok(events.length > 0, `${label}: no events at all`);
  const last = events[events.length - 1];
  const sr = last.metadataEvent?.stopReason;
  ok(typeof sr === "string" && STOP_REASONS.includes(sr), `${label}: last event must be metadataEvent.stopReason ∈ ${STOP_REASONS.join("|")}, got ${JSON.stringify(last)}`);
  const all = events.filter((e) => typeof e.metadataEvent?.stopReason === "string");
  eq(all.length, 1, `${label}: exactly one stopReason frame`);
  return sr as string;
}

/** 找出 tokenUsage 帧并校验嵌套形。 */
export function tokenUsageFrames(events: CwEvent[]): Array<NonNullable<NonNullable<CwEvent["metadataEvent"]>["tokenUsage"]>> {
  const out = [];
  for (const e of events) {
    const tu = e.metadataEvent?.tokenUsage;
    if (tu) {
      for (const k of ["uncachedInputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"]) {
        ok(typeof (tu as Record<string, unknown>)[k] === "number", `tokenUsage.${k} must be number`);
      }
      out.push(tu);
    }
  }
  return out;
}

export function textOf(events: CwEvent[]): string {
  return events.map((e) => e.assistantResponseEvent?.content || "").join("");
}

export function reasoningOf(events: CwEvent[]): string {
  return events.map((e) => e.reasoningContentEvent?.text || "").join("");
}

export function signaturesOf(events: CwEvent[]): string[] {
  return events.map((e) => e.reasoningContentEvent?.signature).filter((s): s is string => typeof s === "string");
}

export function toolUsesOf(events: CwEvent[]): Array<{ toolUseId: string; name: string; input: string }> {
  return events.map((e) => e.toolUseEvent).filter((t): t is NonNullable<CwEvent["toolUseEvent"]> => !!t);
}
