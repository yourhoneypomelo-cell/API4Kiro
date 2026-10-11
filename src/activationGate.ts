/**
 * 激活闸（早绑端口用）。
 *
 * kiro-agent 在激活期就会打 CPS 的 usage 接口，所以端口要在 `activate()` 最前面绑；但 KRS 的全部路由与 CPS 的模型列表
 * 依赖后面才初始化的 tokenStore / usageStore / promptStore / 目录等。闸在「激活还没跑完」期间扣住这些请求：
 * 激活成功 → 放行；激活失败或等待超时 → 回 503（Retry-After），绝不派发进半初始化状态。
 *
 * 默认开（`state === "open"`）：没人调用 beginActivationGate 的路径（开关代理、测试）与之前行为一致。
 */
import type * as http from "http";
import { warn } from "./log";

type GateState = "open" | "pending" | "failed";

let state: GateState = "open";
let settle: ((ok: boolean) => void) | undefined;
let settled: Promise<boolean> = Promise.resolve(true);
let earlyWarned = false;

export function beginActivationGate(): void {
  state = "pending";
  settled = new Promise<boolean>((r) => (settle = r));
}

export function settleActivationGate(ok: boolean): void {
  state = ok ? "open" : "failed";
  settle?.(ok);
  settle = undefined;
}

export function isActivationReady(): boolean {
  return state === "open";
}

/** true = 激活完成可以派发；false = 激活失败或等待超时。 */
export function whenActivationReady(timeoutMs = 10_000): Promise<boolean> {
  if (state !== "pending") {
    return Promise.resolve(state === "open");
  }
  return Promise.race([
    settled,
    new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), timeoutMs);
      t.unref?.();
      void settled.then(() => clearTimeout(t));
    }),
  ]);
}

/** 闸开着就直接派发；否则等闸，放行才派发，失败 / 超时回 503，客户端已走则什么都不做。 */
export function holdUntilReady(req: http.IncomingMessage, res: http.ServerResponse, dispatch: () => void): void {
  if (isActivationReady()) {
    dispatch();
    return;
  }
  void whenActivationReady().then((ok) => {
    if (res.destroyed || res.writableEnded || req.socket.destroyed) {
      return;
    }
    if (!ok) {
      if (!earlyWarned) {
        earlyWarned = true;
        warn("request arrived before activation finished; answered 503");
      }
      req.resume();
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
      res.end(JSON.stringify({ message: "API4Kiro is still initializing" }));
      return;
    }
    dispatch();
  });
}
