/**
 * key 池调度：一个 provider 有 N 把凭证时，每个请求用哪一把、失败了怎么办。
 *
 * 取自 kiro.rs（MultiTokenManager）与 kiro.qizhu（pool/scheduler.go）的交集，去掉了我们这个
 * 单用户、本机、低并发场景不需要的部分（RPM 负载均衡、集群、按模型二维冷却）：
 *
 *  - 会话粘性：同一 Kiro 会话（conversationId）固定用同一把，只有它挂了才换。Anthropic / OpenAI
 *    的 prompt cache 按账号算，无脑轮询会把面板上的缓存命中率打到接近零，成本反而涨。
 *  - 两种策略：priority（主备，默认）按 priority 最小可用者；least-used 按累计成功数最少者。
 *  - 冷却按时间不按计数（qizhu 式）：到点自动回池，不需要"全灭自愈"补丁。
 *  - 冷却是「避让」不是「封锁」：有别的凭证可用时优先用别的；当所有凭证都在冷却（包括只有一把的
 *    provider），仍然用最早解冻的那把照常发请求——成功就清冷却，失败就把真实的上游错误给用户看。
 *    绝不在本地替上游拒绝请求：用户可能刚在上游侧修好了 Key，一把 Key 被锁一小时是反人类的。
 *  - 错误分流（kiro.rs 式）：只有凭证自身的问题（401 / 402 / 403 / 额度耗尽）才切 key；
 *    429 / 5xx / 网络错误是上游抖动，短冷却后同一把重试即可，避免一阵抖动把整池打空。
 *  - 全部状态在内存里，重载窗口即清；凭证列表 / 优先级 / 启停才是配置（在 providers.ts）。
 */

import { Credential, ProviderConfig, configuredCredentials, credentialsOf, hasPool } from "./providers";
import { debug, info } from "./log";

/** 会话绑定保留时长（滑动）。qizhu 用 2h；Kiro 一次编码会话通常在此之内。 */
const STICKY_TTL_MS = 2 * 60 * 60_000;
const STICKY_SWEEP_MS = 10 * 60_000;

/** 失败分类 → 冷却时长与是否值得换 key。 */
export type FailureKind =
  | "auth" // 401：key 无效 / token 刷不回来
  | "quota" // 402 / 额度耗尽 / 余额不足
  | "forbidden" // 403：无权限 / 被封
  | "ratelimit" // 429
  | "upstream" // 5xx
  | "network" // 连接失败
  | "other";

/**
 * 冷却时长只决定「有别的凭证可用时，这把要避让多久」；不会拦住请求（见文件头）。
 * 所以不必设得很长：key 错了 / 欠费了确实不会自己好，但用户在上游侧修好后，只要别的 key 也不行、
 * 或者本来就只有这一把，下一次请求就会直接再试它。
 */
export const COOLDOWN_MS: Record<FailureKind, number> = {
  auth: 15 * 60_000,
  quota: 30 * 60_000,
  forbidden: 15 * 60_000,
  ratelimit: 60_000, // 没有 Retry-After 时的缺省
  upstream: 3_000, // 上游瞬时抖动（qizhu 实测：15s 起的退避会把整池 park 成 503 雪崩）
  network: 3_000,
  other: 15_000,
};
/** Retry-After 给得再大也只信这么久：一把 key 被限流 10 分钟，其它 key 早该顶上。 */
const RATELIMIT_COOLDOWN_CAP_MS = 10 * 60_000;

/** 哪些失败值得马上换另一把 key 重发（其余的：短冷却，让普通重试用同一把再试）。 */
export function shouldRotate(kind: FailureKind): boolean {
  return kind === "auth" || kind === "quota" || kind === "forbidden";
}

/**
 * 403 / 429 里带额度 / 余额字样即算欠费（New API 系中转用 429 / 403 表示欠费）：这两个状态码本身就说明
 * 是凭证层面的拒绝，单个词也可信。
 */
const QUOTAISH_RE = /quota|balance|insufficient|余额|额度|credit|billing|payment|exceeded your current|out of credits|extra usage/;

/**
 * 其它 4xx（主要是 400）里只认**完整的欠费 / 计费短语**：Anthropic 官方把欠费放在 400
 * （`Your credit balance is too low to access the Anthropic API`），OpenAI 兼容网关也有把
 * `insufficient_quota` / `Payment Required` 塞进 400 的；但 400 绝大多数是参数错，`quota field invalid`
 * 这种带单个词的不能当欠费——否则一次参数错会把整池 key 烧一遍（Dq2）。
 */
const BILLING_PHRASE_RE =
  /credit balance|insufficient[ _](?:balance|credits?|funds|quota|user[ _]quota)|balance (?:is )?(?:too low|insufficient|not enough|exhausted)|(?:not enough|no|out of|exhausted|ran out of) (?:credits?|balance|quota)|credits? (?:are |is |have been |has been )?(?:exhausted|depleted|used up)|quota (?:has been |is )?exceeded|exceeded your (?:current )?quota|payment[ _]required|billing (?:issue|problem|error|failed|hard limit|limit reached|details|account)|plans? (?:&|and) billing|top[ -]?up your|please recharge|余额不足|额度不足|额度已用[完尽]|欠费|请充值|余额已用[完尽]|账户余额/;

/**
 * 把上游状态码 + 错误体归到一类。
 *  - 402 → quota；403 / 429 带额度字样（QUOTAISH_RE）→ quota；
 *  - 其它 4xx 带完整欠费短语（BILLING_PHRASE_RE）→ quota；否则 other。
 */
export function classifyFailure(status: number, body: string): FailureKind {
  const b = (body || "").toLowerCase();
  const quotaish = QUOTAISH_RE.test(b);
  if (status === 0) {
    return "network";
  }
  if (status === 401) {
    return "auth";
  }
  if (status === 402) {
    return "quota";
  }
  if (status === 403) {
    return quotaish ? "quota" : "forbidden";
  }
  if (status === 429) {
    return quotaish ? "quota" : "ratelimit";
  }
  if (status >= 500) {
    return "upstream";
  }
  if (status >= 400 && BILLING_PHRASE_RE.test(b)) {
    return "quota";
  }
  return "other";
}

/** Retry-After 头：秒数或 HTTP 日期。解析不出 → undefined。 */
export function parseRetryAfter(raw: string | undefined, now = Date.now()): number | undefined {
  const s = (raw || "").trim();
  if (!s) {
    return undefined;
  }
  if (/^\d+$/.test(s)) {
    return Number(s) * 1000;
  }
  const t = Date.parse(s);
  return isFinite(t) && t > now ? t - now : undefined;
}

interface CredState {
  cooldownUntil: number;
  reason?: FailureKind;
  lastError?: string;
  successes: number;
  failures: number;
  lastUsedAt?: number;
}

interface Sticky {
  credentialId: string;
  expire: number;
}

/** 给 UI / 提示用的快照。 */
export interface CredentialRuntime {
  credentialId: string;
  cooldownUntil?: number;
  cooldownReason?: FailureKind;
  lastError?: string;
  successes: number;
  failures: number;
  lastUsedAt?: number;
}

const states = new Map<string, CredState>(); // `${providerId}/${credentialId}`
const sticky = new Map<string, Sticky>(); // `${providerId}\0${convId}`
let sweepTimer: NodeJS.Timeout | undefined;

function key(providerId: string, credentialId: string): string {
  return `${providerId}/${credentialId}`;
}

function stateOf(providerId: string, credentialId: string): CredState {
  const k = key(providerId, credentialId);
  let s = states.get(k);
  if (!s) {
    s = { cooldownUntil: 0, successes: 0, failures: 0 };
    states.set(k, s);
  }
  return s;
}

function isCooling(providerId: string, c: Credential, now: number): boolean {
  const s = states.get(key(providerId, c.id));
  return !!s && s.cooldownUntil > now;
}

function sweepSticky(): void {
  const now = Date.now();
  for (const [k, v] of sticky) {
    if (v.expire <= now) {
      sticky.delete(k);
    }
  }
}

function ensureSweeper(): void {
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepSticky, STICKY_SWEEP_MS);
    // 不阻止进程退出（扩展宿主关闭时无所谓）
    (sweepTimer as { unref?: () => void }).unref?.();
  }
}

/** 排序：priority 策略按 priority；least-used 按成功数再按 priority。稳定，同分保持配置顺序。 */
function ordered(p: ProviderConfig, list: Credential[]): Credential[] {
  const strat = p.poolStrategy || "priority";
  return [...list].sort((a, b) => {
    if (strat === "least-used") {
      const sa = states.get(key(p.id, a.id))?.successes || 0;
      const sb = states.get(key(p.id, b.id))?.successes || 0;
      if (sa !== sb) {
        return sa - sb;
      }
    }
    return a.priority - b.priority;
  });
}

export interface PickResult {
  credential: Credential;
  /** 是否来自会话绑定（日志用）。 */
  sticky: boolean;
  /** 这把其实还在冷却，只是没有别的可用了——「照常再试一次」而不是在本地拒绝。 */
  cooling: boolean;
}

export interface PickOptions {
  /**
   * 全部候选都在冷却时是否仍挑一把（最早解冻的）返回。默认 true：一次请求的首选永远不被本地拦下。
   * 同一请求内的「换 key 重发」传 false：只换到健康的 key，冷却中的不回头。
   */
  allowCooling?: boolean;
}

/**
 * 为一次请求选凭证。`exclude` 是本次请求已经试过的（换 key 重发时不再回头）。
 * 返回 undefined 只有两种情况：没配 / 全停用，或候选全部在 `exclude` 里（`allowCooling=false` 时再加上
 * 「其余都在冷却」）。全部在冷却而 `allowCooling` 为真 → 返回最早解冻的那把并标 `cooling: true`。
 */
export function pickCredential(p: ProviderConfig, convId: string, exclude: ReadonlySet<string> = new Set(), opts: PickOptions = {}): PickResult | undefined {
  const now = Date.now();
  const allowCooling = opts.allowCooling !== false;
  const configured = configuredCredentials(p);
  if (configured.length === 0) {
    return undefined;
  }
  const candidates = configured.filter((c) => !exclude.has(c.id));
  if (candidates.length === 0) {
    return undefined;
  }
  const usable = candidates.filter((c) => !isCooling(p.id, c, now));
  if (usable.length === 0) {
    if (!allowCooling) {
      return undefined;
    }
    // 全部在冷却：挑最早解冻的（同分按 priority）照常发。成了 markSuccess 会清冷却；败了用户看到真实上游错误。
    const soonest = [...candidates].sort((a, b) => {
      const ua = states.get(key(p.id, a.id))?.cooldownUntil || 0;
      const ub = states.get(key(p.id, b.id))?.cooldownUntil || 0;
      return ua - ub || a.priority - b.priority;
    })[0];
    return { credential: soonest, sticky: false, cooling: true };
  }
  // 单把凭证：没有调度可言，直接给
  if (configured.length === 1) {
    return { credential: usable[0], sticky: false, cooling: false };
  }
  ensureSweeper();
  const sk = `${p.id}\u0000${convId}`;
  const bound = sticky.get(sk);
  if (bound && bound.expire > now) {
    const hit = usable.find((c) => c.id === bound.credentialId);
    if (hit) {
      bound.expire = now + STICKY_TTL_MS;
      return { credential: hit, sticky: true, cooling: false };
    }
  }
  const chosen = ordered(p, usable)[0];
  if (convId) {
    sticky.set(sk, { credentialId: chosen.id, expire: now + STICKY_TTL_MS });
  }
  return { credential: chosen, sticky: false, cooling: false };
}

export function markSuccess(p: ProviderConfig, c: Credential): void {
  const s = stateOf(p.id, c.id);
  s.successes++;
  s.lastUsedAt = Date.now();
  if (s.cooldownUntil) {
    s.cooldownUntil = 0;
    s.reason = undefined;
    s.lastError = undefined;
  }
}

export interface MarkFailureResult {
  kind: FailureKind;
  cooldownMs: number;
  /** 建议换一把 key 重发（且池里还有别的 key 可用）。 */
  rotate: boolean;
}

/**
 * 记一次失败：按类型冷却该凭证；返回是否值得换 key。
 * `retryAfter` 是上游 Retry-After 头的原文（只对 429 生效）。
 */
export function markFailure(p: ProviderConfig, c: Credential, status: number, body: string, retryAfter?: string): MarkFailureResult {
  const kind = classifyFailure(status, body);
  const now = Date.now();
  let cooldownMs = COOLDOWN_MS[kind];
  if (kind === "ratelimit") {
    const ra = parseRetryAfter(retryAfter, now);
    if (ra !== undefined) {
      cooldownMs = Math.min(Math.max(ra, 1000), RATELIMIT_COOLDOWN_CAP_MS);
    }
  }
  const s = stateOf(p.id, c.id);
  s.failures++;
  s.lastUsedAt = now;
  // 不缩短已有的更长冷却；冷却原因 / 错误摘要跟着「决定当前冷却期」的那次失败走——
  // 否则 401 冷却 1h 期间再撞一次 503，面板会显示「上游错误」却挂着 1 小时倒计时。
  const until = now + cooldownMs;
  if (until >= s.cooldownUntil || !s.reason) {
    s.reason = kind;
    s.lastError = (body || "").replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${status}`;
  }
  s.cooldownUntil = Math.max(s.cooldownUntil, until);
  // 冷却期间粘住这把的会话下次自然会重选，不用主动解绑
  const others = configuredCredentials(p).some((o) => o.id !== c.id && !isCooling(p.id, o, now));
  const rotate = shouldRotate(kind) && others;
  debug("credential failure", { provider: p.id, credential: c.id, status, kind, cooldownMs, rotate });
  if (hasPool(p)) {
    info(`[${p.name}] 凭证 ${c.label || c.id} ${kind === "ratelimit" ? "被限流" : kind === "quota" ? "额度不足" : kind === "auth" ? "鉴权失败" : `失败(${status || "网络"})`}，冷却 ${Math.round(cooldownMs / 1000)}s${rotate ? "，切换到其它凭证" : ""}`);
  }
  return { kind, cooldownMs, rotate };
}

/** 手动清掉某把凭证的冷却（用户在面板里改了 key / 重新登录后）。 */
export function clearCooldown(providerId: string, credentialId?: string): void {
  for (const [k, s] of states) {
    if (credentialId ? k === key(providerId, credentialId) : k.startsWith(providerId + "/")) {
      s.cooldownUntil = 0;
      s.reason = undefined;
      s.lastError = undefined;
    }
  }
}

/** 删 provider / 删凭证时把它的状态与绑定一起清掉。 */
export function forgetCredential(providerId: string, credentialId?: string): void {
  for (const k of Array.from(states.keys())) {
    if (credentialId ? k === key(providerId, credentialId) : k.startsWith(providerId + "/")) {
      states.delete(k);
    }
  }
  for (const [k, v] of Array.from(sticky)) {
    if (k.startsWith(providerId + "\u0000") && (!credentialId || v.credentialId === credentialId)) {
      sticky.delete(k);
    }
  }
}

/** 面板用：每把凭证的运行态。 */
export function credentialRuntimes(p: ProviderConfig): CredentialRuntime[] {
  const now = Date.now();
  return credentialsOf(p).map((c) => {
    const s = states.get(key(p.id, c.id));
    const cooling = !!s && s.cooldownUntil > now;
    return {
      credentialId: c.id,
      cooldownUntil: cooling ? s!.cooldownUntil : undefined,
      cooldownReason: cooling ? s!.reason : undefined,
      lastError: cooling ? s!.lastError : undefined,
      successes: s?.successes || 0,
      failures: s?.failures || 0,
      lastUsedAt: s?.lastUsedAt,
    };
  });
}

export interface PoolStatus {
  total: number;
  configured: number;
  cooling: number;
  /** 最早解冻的时刻（全部冷却时给用户一个"多久后再试"）。 */
  nextFreeAt?: number;
}

export function poolStatus(p: ProviderConfig): PoolStatus {
  const now = Date.now();
  const all = credentialsOf(p);
  const configured = configuredCredentials(p);
  let cooling = 0;
  let nextFreeAt: number | undefined;
  for (const c of configured) {
    const s = states.get(key(p.id, c.id));
    if (s && s.cooldownUntil > now) {
      cooling++;
      nextFreeAt = nextFreeAt === undefined ? s.cooldownUntil : Math.min(nextFreeAt, s.cooldownUntil);
    }
  }
  return { total: all.length, configured: configured.length, cooling, nextFreeAt };
}

/**
 * 池里所有凭证都失败过（都在冷却）时，附在真实上游错误后面的说明。
 * 不再写「N 分钟后恢复」——冷却不拦请求，下一次会自动用最早失败的那把再试。
 */
export function poolExhaustedHint(p: ProviderConfig): string {
  const st = poolStatus(p);
  const wait = st.nextFreeAt ? Math.max(1, Math.ceil((st.nextFreeAt - Date.now()) / 1000)) : 0;
  const reasons = credentialRuntimes(p)
    .filter((r) => r.cooldownReason)
    .map((r) => `${credentialName(p, r.credentialId)}：${reasonText(r.cooldownReason!)}${r.lastError ? "（" + r.lastError.slice(0, 80) + "）" : ""}`);
  return (
    `「${p.name}」的 ${st.configured} 把凭证最近都失败过。` +
    (reasons.length ? "\n" + reasons.join("\n") : "") +
    "\n\n冷却只用于在多把凭证之间避让，不会拦住请求：下一次会自动用最早失败的那把再试" +
    (wait ? `（它 ${wait >= 60 ? Math.ceil(wait / 60) + " 分钟" : wait + " 秒"}后回到正常轮转）` : "") +
    "；修好 Key 或在「提供商」页补充新 Key 后直接重发即可。"
  );
}

function credentialName(p: ProviderConfig, credentialId: string): string {
  const list = credentialsOf(p);
  const i = list.findIndex((c) => c.id === credentialId);
  const c = list[i];
  return c?.label || (i === 0 ? "主凭证" : `凭证 ${i + 1}`);
}

export function reasonText(kind: FailureKind): string {
  switch (kind) {
    case "auth":
      return "鉴权失败（Key 无效或登录失效）";
    case "quota":
      return "额度 / 余额不足";
    case "forbidden":
      return "无权限";
    case "ratelimit":
      return "被限流";
    case "upstream":
      return "上游错误";
    case "network":
      return "连接失败";
    default:
      return "请求失败";
  }
}

/** 仅测试用。 */
export function _resetPoolForTest(): void {
  states.clear();
  sticky.clear();
}
