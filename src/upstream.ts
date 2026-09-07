import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface UpstreamResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

function agentFor(url: URL): typeof http | typeof https {
  return url.protocol === "http:" ? http : https;
}

/**
 * Issue a request to the upstream relay and resolve as soon as response headers
 * arrive (the body stream is returned for incremental reading). Rejects on
 * network error or timeout.
 */
export function requestUpstream(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string | Buffer,
  timeoutMs = 1_800_000
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(new Error("Invalid upstream URL: " + urlStr));
      return;
    }

    const lib = agentFor(url);
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const finalHeaders: Record<string, string> = { ...headers };
    if (payload) {
      finalHeaders["Content-Length"] = String(payload.length);
    }

    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        headers: finalHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: res,
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy(new Error("upstream request timeout"));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/** Read an entire response body into a string. */
export function readBody(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

/** Convenience: GET a JSON document with a bearer/x-api-key style auth header. */
export async function getJson(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs = 15000
): Promise<unknown> {
  // 竞速定时器随结果一起清掉（对齐 providerProbe.withTimeout）：否则每次拉 /models 都留一个活定时器到期才释放
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<UpstreamResponse>((_, reject) => {
    timer = setTimeout(() => reject(new Error("request timeout")), timeoutMs);
  });
  const res = await Promise.race([
    requestUpstream("GET", urlStr, { Accept: "application/json", ...headers }, undefined, timeoutMs),
    guard,
  ]).finally(() => clearTimeout(timer));
  const text = await readBody(res.body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}
