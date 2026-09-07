/**
 * 译码层套件（smoke / thinking / responses / gemini / routing / robustness）的公共助手：
 * 深比较断言 + `N passed, M failed` 收尾、SSE 行、CwEvent 挑选、eventstream 解码、假上游、CwRequest 夹具。
 * 放在 tests/lib/ 下，不是套件入口。断言计数独立于 ./harness（每个套件一个进程，互不影响）。
 */

import * as http from "http";
import { CwEvent } from "../../src/cwTypes";
import { EventStreamDecoder } from "../../src/eventstream";

let passed = 0;
let failed = 0;
let xfailed = 0;
const failures: string[] = [];

/**
 * 已知缺陷（不在本套件维护者的写权限内、或已上报待修）：条件为假时打印 XFAIL 并单独计数、不算失败；
 * 条件为真说明缺陷已修，按 PASS 计并提示把 xfail 改回 check。
 */
export function xfail(name: string, cond: unknown, ticket: string): boolean {
  if (cond) {
    passed++;
    console.log(`PASS ${name}  (xfail 已解除，请改回 check；${ticket})`);
    return true;
  }
  xfailed++;
  console.log(`XFAIL ${name}  -- 已知缺陷：${ticket}`);
  return false;
}

export function check(name: string, cond: unknown, detail?: unknown): boolean {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
    return true;
  }
  failed++;
  const d = detail === undefined ? "" : "  -- " + safe(detail);
  console.log(`FAIL ${name}${d}`);
  failures.push(name + d);
  return false;
}

export function eq(name: string, actual: unknown, expected: unknown): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return check(name, a === e, `expected ${e}, got ${a}`);
}

export function includes(name: string, hay: string, needle: string): boolean {
  return check(name, typeof hay === "string" && hay.includes(needle), `"${needle}" not in ${JSON.stringify(hay).slice(0, 300)}`);
}

export function throws(name: string, fn: () => unknown): boolean {
  try {
    fn();
    return check(name, false, "did not throw");
  } catch {
    return check(name, true);
  }
}

function safe(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return String(v);
  }
}

/** 套件收尾：打印统计并按结果设退出码。 */
export function report(suite: string): never {
  console.log(`\n[${suite}] ${passed} passed, ${failed} failed${xfailed ? ` (${xfailed} known-bug xfail)` : ""}`);
  if (failed) {
    console.log("failures:\n  " + failures.join("\n  "));
  }
  process.exit(failed ? 1 : 0);
}

/** 顶层 async 套件的统一入口：未捕获异常也算失败并退出非 0。 */
export function run(suite: string, body: () => Promise<void> | void): void {
  Promise.resolve()
    .then(body)
    .then(() => report(suite))
    .catch((e) => {
      failed++;
      console.log(`FAIL [${suite}] uncaught: ${(e as Error)?.stack || String(e)}`);
      report(suite);
    });
}

// ---------------------------------------------------------------------------
// 共用工具：SSE 行、CwEvent 挑选、eventstream 解码、假上游
// ---------------------------------------------------------------------------

export function sse(obj: unknown): string {
  return "data: " + JSON.stringify(obj);
}

/** 把一组 SSE 行喂给转换器，再 flush，返回全部事件。 */
export function feedAll(conv: { processLine(l: string): CwEvent[]; flush(): CwEvent[] }, lines: string[]): CwEvent[] {
  const out: CwEvent[] = [];
  for (const l of lines) {
    out.push(...conv.processLine(l));
  }
  out.push(...conv.flush());
  return out;
}

export function texts(events: CwEvent[]): string {
  return events.map((e) => e.assistantResponseEvent?.content || "").join("");
}

export function reasonings(events: CwEvent[]): string {
  return events.map((e) => e.reasoningContentEvent?.text || "").join("");
}

export function signatures(events: CwEvent[]): string[] {
  return events.map((e) => e.reasoningContentEvent?.signature).filter((s): s is string => !!s);
}

export function toolUses(events: CwEvent[]): NonNullable<CwEvent["toolUseEvent"]>[] {
  return events.map((e) => e.toolUseEvent).filter((t): t is NonNullable<CwEvent["toolUseEvent"]> => !!t);
}

export function stopReasons(events: CwEvent[]): string[] {
  return events.map((e) => e.metadataEvent?.stopReason).filter((s): s is string => !!s);
}

export function tokenUsages(events: CwEvent[]): NonNullable<NonNullable<CwEvent["metadataEvent"]>["tokenUsage"]>[] {
  return events
    .map((e) => e.metadataEvent?.tokenUsage)
    .filter((t): t is NonNullable<NonNullable<CwEvent["metadataEvent"]>["tokenUsage"]> => !!t);
}

export function meterings(events: CwEvent[]): NonNullable<CwEvent["meteringEvent"]>[] {
  return events.map((e) => e.meteringEvent).filter((m): m is NonNullable<CwEvent["meteringEvent"]> => !!m);
}

export function contextUsages(events: CwEvent[]): number[] {
  return events.map((e) => e.contextUsageEvent?.contextUsagePercentage).filter((n): n is number => typeof n === "number");
}

/** 流末最后一个「实质」事件必须是 metadataEvent.stopReason（metering 允许排在它后面，由泵在轮末补）。 */
export function lastIsStopReason(events: CwEvent[]): boolean {
  const last = events[events.length - 1];
  return !!last?.metadataEvent?.stopReason;
}

// ---- eventstream 解码（KRS 二进制响应 → CwEvent 形状）----

export interface DecodedFrame {
  messageType: string;
  type: string;
  payload: unknown;
}

export function decodeEventStream(buf: Buffer): DecodedFrame[] {
  const dec = new EventStreamDecoder();
  return dec.feed(buf) as DecodedFrame[];
}

/** 把解码出的帧还原成 CwEvent[]（只保留 event 帧）。 */
export function framesToCwEvents(frames: DecodedFrame[]): CwEvent[] {
  const out: CwEvent[] = [];
  for (const f of frames) {
    if (f.messageType !== "event") {
      continue;
    }
    const ev: CwEvent = {};
    (ev as Record<string, unknown>)[f.type] = f.payload;
    out.push(ev);
  }
  return out;
}

// ---- 假上游 ----

export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json?: unknown;
}

export type FakeHandler = (req: CapturedRequest, res: http.ServerResponse) => void | Promise<void>;

export interface FakeUpstream {
  server: http.Server;
  port: number;
  base: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** 起一个本地假上游（127.0.0.1 随机端口），把每个请求记进 requests 再交给 handler。 */
export function startFakeUpstream(handler: FakeHandler): Promise<FakeUpstream> {
  return new Promise((resolve, reject) => {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = body ? JSON.parse(body) : undefined;
        } catch {
          json = undefined;
        }
        const cap: CapturedRequest = { method: req.method || "GET", url: req.url || "/", headers: req.headers, body, json };
        requests.push(cap);
        Promise.resolve(handler(cap, res)).catch((e) => {
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end(String((e as Error).message));
        });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 写一段 SSE（每个对象一个 data: 行 + 空行）。 */
export function writeSse(res: http.ServerResponse, events: unknown[], opts?: { end?: boolean }): void {
  if (!res.headersSent) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  }
  for (const e of events) {
    res.write("data: " + JSON.stringify(e) + "\n\n");
  }
  if (opts?.end !== false) {
    res.end();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 向本地服务器发 POST，整包读回（二进制 Buffer + 状态码 + 头）。 */
export function postRaw(
  url: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 找一个 19871–19898 之间可绑定的端口（历史套件的约定区间）。 */
export async function pickPort(from = 19871, to = 19898): Promise<number> {
  const net = await import("net");
  for (let p = from; p <= to; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) {
      return p;
    }
  }
  throw new Error(`no free port in ${from}-${to}`);
}

// ---- CwRequest 夹具 ----

export function cwRequest(opts: {
  convId?: string;
  modelId: string;
  content?: string;
  history?: unknown[];
  tools?: unknown[];
  toolResults?: unknown[];
  images?: Array<{ format: string; bytes: string }>;
  effort?: string;
}): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (opts.tools) {
    ctx.tools = opts.tools;
  }
  if (opts.toolResults) {
    ctx.toolResults = opts.toolResults;
  }
  if (opts.effort) {
    ctx.additionalModelRequestFields = { output_config: { effort: opts.effort } };
  }
  const uim: Record<string, unknown> = {
    content: opts.content ?? "hello",
    modelId: opts.modelId,
    origin: "IDE",
    userInputMessageContext: ctx,
  };
  if (opts.images) {
    uim.images = opts.images.map((i) => ({ format: i.format, source: { bytes: i.bytes } }));
  }
  return {
    conversationState: {
      conversationId: opts.convId || "conv-test",
      chatTriggerType: "MANUAL",
      history: opts.history || [],
      currentMessage: { userInputMessage: uim },
    },
  };
}

export function toolSpec(name: string, schema?: Record<string, unknown>, description?: string): unknown {
  const ts: Record<string, unknown> = { name };
  if (description) {
    ts.description = description;
  }
  if (schema) {
    ts.inputSchema = { json: schema };
  }
  return { toolSpecification: ts };
}
