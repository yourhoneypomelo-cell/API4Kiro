/**
 * 极简测试骨架：`test(name, fn)` 登记，`run()` 顺序执行，每条打印 PASS/FAIL，末行打印 `N passed, M failed`。
 * 零依赖；断言失败抛 Error 即算失败。run.js 靠末行汇总。
 */

type TestFn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: TestFn;
  timeoutMs: number;
}

const cases: Case[] = [];
const DEFAULT_TIMEOUT_MS = 20_000;

// 被测代码的 info/error 会同时打到 console（前缀 [API4Kiro]）；非 verbose 时压掉，保持输出只剩 PASS/FAIL
if (!process.env.A2K_TEST_LOG) {
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => {
      if (args[0] === "[API4Kiro]") {
        return;
      }
      orig(...args);
    };
  }
}

export function test(name: string, fn: TestFn, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  cases.push({ name, fn, timeoutMs });
}

export class AssertionError extends Error {}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(v);
  }
}

export function ok(cond: unknown, msg?: string): void {
  if (!cond) {
    throw new AssertionError(msg || `expected truthy, got ${show(cond)}`);
  }
}

export function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${msg ? msg + ": " : ""}expected ${show(expected)}, got ${show(actual)}`);
  }
}

export function deepEq(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
  }
}

export function near(actual: number, expected: number, tol: number, msg?: string): void {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new AssertionError(`${msg ? msg + ": " : ""}expected ${expected}±${tol}, got ${actual}`);
  }
}

export function includes(hay: string, needle: string, msg?: string): void {
  if (!hay.includes(needle)) {
    throw new AssertionError(`${msg ? msg + ": " : ""}expected to contain ${show(needle)}, got ${show(hay)}`);
  }
}

export async function throws(fn: () => unknown | Promise<unknown>, re?: RegExp, msg?: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error;
    if (re && !re.test(err.message || String(e))) {
      throw new AssertionError(`${msg ? msg + ": " : ""}error message ${show(err.message)} does not match ${re}`);
    }
    return err;
  }
  throw new AssertionError(`${msg ? msg + ": " : ""}expected to throw`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等到条件成立或超时。 */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new AssertionError(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await sleep(stepMs);
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`test timed out after ${ms}ms`)), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const started = Date.now();
    try {
      await withTimeout(Promise.resolve().then(() => c.fn()), c.timeoutMs);
      passed++;
      const ms = Date.now() - started;
      console.log(`PASS ${c.name}${ms >= 1000 ? ` (${ms}ms)` : ""}`);
    } catch (e) {
      failed++;
      const err = e as Error;
      console.log(`FAIL ${c.name}\n     ${(err && (err.stack || err.message)) || String(e)}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
}
