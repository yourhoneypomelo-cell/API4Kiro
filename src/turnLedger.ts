/**
 * 一轮对话的用量账本。
 *
 * 为什么需要它：Kiro 的工具循环里，**每次迭代都是一个独立的 HTTP 请求**，各自带回
 * 一份 usage。如果每个请求都上报一条 metering，Kiro 的 aggregateUsageSummary() 会
 * 按 unit 把 `usage` 累加（总量正确），但 `unitPlural` **只取第一条 entry 的**，后续
 * 全部忽略。于是页脚会变成「总量是全轮累计、括号里的分解却是第一次请求的」——实测
 * 出现过 `(in 18.3k / out 248) Used: 229,665`，分解只占总量的 8%，严重误导。
 *
 * 所以改成：循环期间只记账不上报，等到轮末（响应里不再有工具调用）一次性上报累计值。
 * 这样整轮只产生一条 entry，`unitPlural` 与 `usage` 必然自洽。页脚本来就在
 * persistTurnCompletion 时才渲染，延后上报不影响显示时机。
 *
 * 轮次边界：请求里带 `toolResults` 的是工具循环的延续，不带的是新一轮的开始。用后者
 * 做重置点，即使上一轮因取消/报错泄漏了，下一轮开始也会清干净。
 */

import { CapturedUsage, emptyUsage } from "./streamShared";

interface Entry extends CapturedUsage {
  updatedAt: number;
}

/** 兜底清理：会话被关掉后账本不会有人来收，超时即弃。 */
const MAX_AGE_MS = 30 * 60_000;
const MAX_ENTRIES = 64;

const ledgers = new Map<string, Entry>();

function sweep(): void {
  const now = Date.now();
  for (const [id, e] of ledgers) {
    if (now - e.updatedAt > MAX_AGE_MS) {
      ledgers.delete(id);
    }
  }
  // 极端情况下（会话 id 一直变）防止无界增长，淘汰最旧的。
  while (ledgers.size > MAX_ENTRIES) {
    let oldestId: string | undefined;
    let oldest = Infinity;
    for (const [id, e] of ledgers) {
      if (e.updatedAt < oldest) {
        oldest = e.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId === undefined) {
      break;
    }
    ledgers.delete(oldestId);
  }
}

/** 新一轮开始（用户发了新消息，而非工具结果回填）：清空累计。 */
export function beginTurn(conversationId: string): void {
  sweep();
  ledgers.set(conversationId, { ...emptyUsage(), updatedAt: Date.now() });
}

/** 累加一次请求的用量。 */
export function addRequestUsage(conversationId: string, u: CapturedUsage): void {
  const cur = ledgers.get(conversationId) ?? { ...emptyUsage(), updatedAt: Date.now() };
  cur.inputTokens += u.inputTokens;
  cur.outputTokens += u.outputTokens;
  cur.cacheReadTokens += u.cacheReadTokens;
  cur.cacheCreationTokens += u.cacheCreationTokens;
  cur.updatedAt = Date.now();
  ledgers.set(conversationId, cur);
}

/** 取出整轮累计并结账。 */
export function takeTurnTotals(conversationId: string): CapturedUsage {
  const cur = ledgers.get(conversationId);
  ledgers.delete(conversationId);
  if (!cur) {
    return emptyUsage();
  }
  return {
    inputTokens: cur.inputTokens,
    outputTokens: cur.outputTokens,
    cacheReadTokens: cur.cacheReadTokens,
    cacheCreationTokens: cur.cacheCreationTokens,
  };
}

/** 测试用。 */
export function resetAll(): void {
  ledgers.clear();
}
