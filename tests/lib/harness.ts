/**
 * 套件公共助手：断言计数、PASS/FAIL 打印、假 HTTP 服务器、请求、临时目录、时钟控制。
 * 不是套件（放在 tests/lib/ 下，不会被 build.js 当入口）。
 */
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function check(label: string, cond: boolean, detail?: unknown): boolean {
  if (cond) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`FAIL ${label}${detail !== undefined ? "  ← " + safeStr(detail) : ""}`);
  }
  return cond;
}

export function eq<T>(label: string, actual: T, expected: T): boolean {
  return check(label, actual === expected, { actual, expected });
}

export function deepEq(label: string, actual: unknown, expected: unknown): boolean {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return check(label, a === b, { actual: a, expected: b });
}

export function includes(label: string, hay: string | undefined, needle: string): boolean {
  return check(label, typeof hay === "string" && hay.includes(needle), { hay, needle });
}

export function approx(label: string, actual: number, expected: number, tol: number): boolean {
  return check(label, Math.abs(actual - expected) <= tol, { actual, expected, tol });
}

export async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n## ${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    failures.push(`${name} (threw)`);
    console.log(`FAIL ${name} threw: ${(e as Error)?.stack || String(e)}`);
  }
}

export async function rejects(label: string, p: Promise<unknown>, match?: RegExp | string): Promise<boolean> {
  try {
    await p;
    return check(label, false, "resolved instead of rejecting");
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    if (match === undefined) {
      return check(label, true);
    }
    const ok = typeof match === "string" ? msg.includes(match) : match.test(msg);
    return check(label, ok, { msg, match: String(match) });
  }
}

export function throws(label: string, fn: () => unknown, match?: RegExp | string): boolean {
  try {
    fn();
    return check(label, false, "did not throw");
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    if (match === undefined) {
      return check(label, true);
    }
    const ok = typeof match === "string" ? msg.includes(match) : match.test(msg);
    return check(label, ok, { msg, match: String(match) });
  }
}

export function finish(): never {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("failures:\n  - " + failures.join("\n  - "));
  }
  process.exit(failed ? 1 : 0);
}

function safeStr(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP

export interface FakeServer {
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>;

/** 起一个本机假服务器（port=0 随机）。handler 拿到已读完的 body。 */
export function startServer(handler: Handler, port = 0): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((e) => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
          }
          res.end("handler error: " + (e as Error).message);
        });
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: p,
        url: `http://127.0.0.1:${p}`,
        close: () =>
          new Promise<void>((r) => {
            (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

export interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  buffer: Buffer;
  json(): unknown;
}

export function request(method: string, url: string, headers: Record<string, string> = {}, body?: string | Buffer, timeoutMs = 15000): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h: Record<string, string> = { ...headers };
    if (payload) {
      h["content-length"] = String(payload.length);
    }
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("utf8");
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text,
          buffer,
          json: () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export function jsonBody(buf: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** 端口是否空闲（连接被拒即空闲）。 */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ method: "GET", host: "127.0.0.1", port, path: "/", timeout: 500 }, (res) => {
      res.resume();
      resolve(false);
    });
    req.on("error", () => resolve(true));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// ---------------------------------------------------------------- FS / 时钟

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 接管 Date.now（产品代码全用它取时间）；restore 后恢复真实时钟。 */
export function fakeClock(start = Date.now()): { now(): number; set(ms: number): void; advance(ms: number): void; restore(): void } {
  const real = Date.now;
  let cur = start;
  Date.now = () => cur;
  return {
    now: () => cur,
    set: (ms) => {
      cur = ms;
    },
    advance: (ms) => {
      cur += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
}
