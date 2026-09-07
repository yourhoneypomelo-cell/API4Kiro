/**
 * 本地代理的身份握手。
 *
 * 多窗口共享模型下，后启动的窗口探测端口，发现是「自己人」就待机。原先只比对
 * 名字，于是**升级后旧实例会一直霸占端口**：新窗口探到 `api2kiro-dual` 就以为
 * 是自己的另一个窗口，安静地进入待机，用户重载多少次都还是旧代码在应答，且没有
 * 任何提示。实测踩过一次（2.0.0 占着 19810，2.0.1 全程待机）。
 *
 * 所以身份里带上版本，并加一个让位动作：新版本请求旧版本释放端口，旧版本让出后
 * 新版本接管。同版本仍按原来的多窗口共享逻辑走（先到先得）。
 *
 * 常量集中在本文件，krsServer / cpsServer / portBinder 都从这里取，避免以前
 * 「三处各存一份、要一起改」的隐患。
 */

import * as http from "http";
import { getExtensionVersion } from "./config";

/** **必须**与原版 API2Kiro 不同，否则两个扩展会互相误判为自己人而一起待机。 */
export const PROXY_ID_PATH = "/__api2kiro_dual_identity";
export const PROXY_ID_TOKEN = "api2kiro-dual";

export interface ProxyIdentity {
  proxy: string;
  role: string;
  version: string;
  pid: number;
  yielding?: boolean;
}

/** 只比较数字段，忽略预发布后缀。正数表示 a 比 b 新。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) {
      return d > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** role -> 释放端口的动作。由 PortHolder 注册。 */
const yielders = new Map<string, () => void>();

export function registerYielder(role: string, release: () => void): void {
  yielders.set(role, release);
}

/**
 * 应答身份探测。返回 true 表示本次请求已处理完毕。
 *
 * `?yieldTo=<version>`：调用方声明自己的版本，比本实例新时本实例让出端口。
 * 仅监听 127.0.0.1，且只会让出本扩展自己占的端口。
 */
export function serveIdentity(url: string, res: http.ServerResponse, role: string): boolean {
  const [path, query] = url.split("?");
  if (path !== PROXY_ID_PATH) {
    return false;
  }

  const mine = getExtensionVersion();
  const yieldTo = new URLSearchParams(query || "").get("yieldTo");
  const yielding = !!yieldTo && compareVersions(yieldTo, mine) > 0;

  const body: ProxyIdentity = {
    proxy: PROXY_ID_TOKEN,
    role,
    version: mine,
    pid: process.pid,
    yielding,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));

  if (yielding) {
    // 先让响应写出去再关服务器，否则对端可能收到 RST 而判定探测失败。
    setTimeout(() => yielders.get(role)?.(), 50);
  }
  return true;
}

/**
 * 探测端口上是谁。返回 null 表示无应答、应答不可解析，或不是本扩展
 * （即被外部进程占用，无法共享）。
 */
export function probeIdentity(port: number, yieldTo?: string): Promise<ProxyIdentity | null> {
  const path = yieldTo
    ? `${PROXY_ID_PATH}?yieldTo=${encodeURIComponent(yieldTo)}`
    : PROXY_ID_PATH;
  return new Promise((resolve) => {
    const req = http.request(
      { method: "GET", host: "127.0.0.1", port, path, timeout: 1500 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json && json.proxy === PROXY_ID_TOKEN ? (json as ProxyIdentity) : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
