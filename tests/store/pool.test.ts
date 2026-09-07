/** credentialPool：分类 / 切号 / 冷却 / 回池 / 粘会话 / 文案。 */
import * as vscode from "vscode";
import { test, run, eq, ok, includes, deepEq } from "./harness";
import {
  COOLDOWN_MS,
  classifyFailure,
  clearCooldown,
  credentialRuntimes,
  forgetCredential,
  markFailure,
  markSuccess,
  parseRetryAfter,
  pickCredential,
  poolExhaustedHint,
  poolStatus,
  shouldRotate,
  _resetPoolForTest,
} from "../../src/credentialPool";
import { Credential, ProviderConfig } from "../../src/providers";

const stub = vscode as unknown as { __makeContext(): unknown; __reset(): void };

function cred(id: string, priority: number, extra: Partial<Credential> = {}): Credential {
  return { id, apiKey: "sk-" + id, priority, enabled: true, ...extra };
}

function provider(creds: Credential[], strategy?: "priority" | "least-used", id = "p1"): ProviderConfig {
  return {
    id,
    name: "测试渠道",
    protocol: "openai",
    openaiApi: "chat",
    baseUrl: "https://example.invalid/v1",
    apiKey: creds[0]?.apiKey || "",
    enabled: true,
    credentials: creds,
    poolStrategy: strategy,
  };
}

function fresh(): void {
  _resetPoolForTest();
  stub.__reset();
}

// ---------------------------------------------------------------- classifyFailure / shouldRotate

test("classifyFailure：401→auth 402→quota 403→forbidden 429→ratelimit 5xx→upstream 0→network 400→other", () => {
  eq(classifyFailure(401, ""), "auth");
  eq(classifyFailure(402, ""), "quota");
  eq(classifyFailure(403, "forbidden"), "forbidden");
  eq(classifyFailure(429, "rate limit exceeded"), "ratelimit");
  eq(classifyFailure(500, ""), "upstream");
  eq(classifyFailure(502, ""), "upstream");
  eq(classifyFailure(503, ""), "upstream");
  eq(classifyFailure(0, "ECONNREFUSED"), "network");
  eq(classifyFailure(400, "invalid parameter"), "other");
  eq(classifyFailure(404, "not found"), "other");
  eq(classifyFailure(422, ""), "other");
});

test("classifyFailure：403 / 429 带额度字样归 quota（含中文）", () => {
  eq(classifyFailure(429, '{"error":{"message":"You exceeded your current quota"}}'), "quota");
  eq(classifyFailure(429, "insufficient_quota"), "quota");
  eq(classifyFailure(429, "账户余额不足"), "quota");
  eq(classifyFailure(403, "额度已用尽"), "quota");
  eq(classifyFailure(403, "Out of credits"), "quota");
  eq(classifyFailure(429, "Too Many Requests"), "ratelimit");
});

test("shouldRotate：只有凭证自身错误切号", () => {
  eq(shouldRotate("auth"), true);
  eq(shouldRotate("quota"), true);
  eq(shouldRotate("forbidden"), true);
  eq(shouldRotate("ratelimit"), false);
  eq(shouldRotate("upstream"), false);
  eq(shouldRotate("network"), false);
  eq(shouldRotate("other"), false);
});

// ---------------------------------------------------------------- parseRetryAfter

test("parseRetryAfter：秒数、HTTP 日期、非法值", () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  eq(parseRetryAfter("30", now), 30_000);
  eq(parseRetryAfter(" 7 ", now), 7_000);
  eq(parseRetryAfter("0", now), 0);
  eq(parseRetryAfter(new Date(now + 90_000).toUTCString(), now), 90_000);
  eq(parseRetryAfter(new Date(now - 10_000).toUTCString(), now), undefined, "过去的日期无意义");
  eq(parseRetryAfter("", now), undefined);
  eq(parseRetryAfter(undefined, now), undefined);
  eq(parseRetryAfter("soon", now), undefined);
  eq(parseRetryAfter("-5", now), undefined);
});

test("markFailure：429 的 Retry-After 夹到 [1s, 10min]，且不缩短既有冷却", () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a, cred("c2", 1)]);
  const t0 = Date.now();
  const r1 = markFailure(p, a, 429, "slow down", "0");
  eq(r1.kind, "ratelimit");
  eq(r1.cooldownMs, 1000, "下限 1s");
  const r2 = markFailure(p, a, 429, "slow down", "36000");
  eq(r2.cooldownMs, 10 * 60_000, "上限 10 分钟");
  const far = credentialRuntimes(p).find((x) => x.credentialId === "c1")!.cooldownUntil!;
  ok(far >= t0 + 10 * 60_000 - 50, "冷却到 10 分钟后");
  const r3 = markFailure(p, a, 429, "slow down", "5");
  eq(r3.cooldownMs, 5000);
  const after = credentialRuntimes(p).find((x) => x.credentialId === "c1")!.cooldownUntil!;
  eq(after, far, "cooldownUntil = max(旧, now+ms)，不因短 Retry-After 缩短");
});

test("markFailure：无 Retry-After 时用类别缺省；日期格式也生效", () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a]);
  eq(markFailure(p, a, 429, "").cooldownMs, COOLDOWN_MS.ratelimit);
  const r = markFailure(p, a, 429, "", new Date(Date.now() + 120_000).toUTCString());
  ok(r.cooldownMs > 100_000 && r.cooldownMs <= 120_000, `HTTP 日期 → ${r.cooldownMs}ms`);
  eq(markFailure(p, a, 500, "").cooldownMs, COOLDOWN_MS.upstream);
  eq(markFailure(p, a, 0, "ECONNRESET").cooldownMs, COOLDOWN_MS.network);
});

// ---------------------------------------------------------------- rotate 决策

test("markFailure：400 参数错不切号且短冷却；401/402/403 有备用时切号", () => {
  fresh();
  const a = cred("c1", 0);
  const b = cred("c2", 1);
  const p = provider([a, b]);
  const bad = markFailure(p, a, 400, "invalid_request_error: max_tokens");
  eq(bad.kind, "other");
  eq(bad.rotate, false);
  eq(bad.cooldownMs, COOLDOWN_MS.other);
  clearCooldown(p.id);
  eq(markFailure(p, a, 401, "invalid api key").rotate, true);
  clearCooldown(p.id);
  eq(markFailure(p, a, 402, "").rotate, true);
  clearCooldown(p.id);
  eq(markFailure(p, a, 403, "").rotate, true);
  clearCooldown(p.id);
  eq(markFailure(p, a, 429, "").rotate, false, "429 不算凭证坏");
  clearCooldown(p.id);
  eq(markFailure(p, a, 503, "").rotate, false);
});

test("markFailure：池里没有别的可用凭证时 rotate=false（单凭证 / 其它都在冷却）", () => {
  fresh();
  const a = cred("c1", 0);
  eq(markFailure(provider([a]), a, 401, "").rotate, false, "单凭证");
  fresh();
  const b = cred("c2", 1);
  const p = provider([a, b]);
  markFailure(p, b, 402, "");
  eq(markFailure(p, a, 401, "").rotate, false, "唯一备用已冷却");
  const st = poolStatus(p);
  eq(st.configured, 2);
  eq(st.cooling, 2);
  ok(typeof st.nextFreeAt === "number");
});

// ---------------------------------------------------------------- pickCredential

test("pickCredential：priority 策略取 priority 最小；同 convId 粘住；冷却中的跳过", () => {
  fresh();
  const a = cred("c1", 5);
  const b = cred("c2", 1);
  const c = cred("c3", 3);
  const p = provider([a, b, c]);
  const first = pickCredential(p, "conv-A")!;
  eq(first.credential.id, "c2", "priority 最小者");
  eq(first.sticky, false);
  const again = pickCredential(p, "conv-A")!;
  eq(again.credential.id, "c2");
  eq(again.sticky, true, "第二次命中会话绑定");
  markFailure(p, b, 402, "quota");
  const next = pickCredential(p, "conv-A")!;
  eq(next.credential.id, "c3", "粘住的那把冷却了 → 重选下一优先级");
  eq(next.sticky, false);
  eq(pickCredential(p, "conv-A")!.credential.id, "c3", "改绑到新的一把");
  eq(pickCredential(p, "conv-B")!.credential.id, "c3", "新会话也拿当前最优可用");
});

test("pickCredential：exclude 跳过本轮已试过的；全排除返回 undefined；全部冷却仍给最早解冻的一把（冷却是避让不是封锁）", () => {
  fresh();
  const a = cred("c1", 0);
  const b = cred("c2", 1);
  const p = provider([a, b]);
  eq(pickCredential(p, "x")!.credential.id, "c1");
  eq(pickCredential(p, "x", new Set(["c1"]))!.credential.id, "c2");
  eq(pickCredential(p, "x", new Set(["c1", "c2"])), undefined);
  markFailure(p, a, 401, "");
  markFailure(p, b, 401, "");
  const probe = pickCredential(p, "y");
  eq(probe?.credential.id, "c1", "全部冷却 → 最早解冻的 c1（先失败的先解冻）");
  eq(probe?.cooling, true, "标 cooling");
  eq(pickCredential(p, "y", new Set(), { allowCooling: false }), undefined, "换 key 重发不回头碰冷却中的");
  eq(pickCredential(p, "y", new Set(["c1"]))?.credential.id, "c2", "首选已试过 → 轮到下一把冷却中的");
  markSuccess(p, a);
  eq(pickCredential(p, "y")?.cooling, false, "成功即清冷却，不再标 cooling");
});

test("单把凭证：401 后仍可被选中（不在本地拒绝）", () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a]);
  markFailure(p, a, 401, "该令牌状态不可用");
  const pick = pickCredential(p, "conv");
  eq(pick?.credential.id, "c1");
  eq(pick?.cooling, true);
});

test("pickCredential：停用 / 没 key 的凭证不参与；单凭证直给", () => {
  fresh();
  const a = cred("c1", 0, { enabled: false });
  const b = cred("c2", 1, { apiKey: undefined });
  const c = cred("c3", 2);
  const p = provider([a, b, c]);
  eq(pickCredential(p, "z")!.credential.id, "c3");
  eq(poolStatus(p).total, 3);
  eq(poolStatus(p).configured, 1);
  fresh();
  eq(pickCredential(provider([cred("c1", 0)]), "")!.credential.id, "c1");
  eq(pickCredential(provider([]), ""), undefined, "没配任何凭证（合成的 c1 也没 key）");
});

test("pickCredential：least-used 按累计成功数最少，平局按 priority", () => {
  fresh();
  const a = cred("c1", 0);
  const b = cred("c2", 1);
  const p = provider([a, b], "least-used");
  markSuccess(p, a);
  markSuccess(p, a);
  eq(pickCredential(p, "s1")!.credential.id, "c2", "c1 用过 2 次，c2 0 次");
  markSuccess(p, b);
  markSuccess(p, b);
  eq(pickCredential(p, "s2")!.credential.id, "c1", "平局按 priority");
});

// ---------------------------------------------------------------- markSuccess / 回池

test("markSuccess：清零冷却与错误，成功数累加", () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a, cred("c2", 1)]);
  markFailure(p, a, 401, "bad key");
  let rt = credentialRuntimes(p)[0];
  ok(rt.cooldownUntil! > Date.now());
  eq(rt.cooldownReason, "auth");
  eq(rt.lastError, "bad key");
  eq(rt.failures, 1);
  markSuccess(p, a);
  rt = credentialRuntimes(p)[0];
  eq(rt.cooldownUntil, undefined);
  eq(rt.cooldownReason, undefined);
  eq(rt.lastError, undefined);
  eq(rt.successes, 1);
  eq(rt.failures, 1, "失败计数保留");
});

test("冷却到期自动回池（用极短的 upstream 冷却验证）", async () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a, cred("c2", 1)]);
  markFailure(p, a, 503, "");
  eq(pickCredential(p, "r")!.credential.id, "c2", "冷却中先用 c2");
  // 直接把冷却时间拨回去，等价于"时间到了"
  const rt = credentialRuntimes(p)[0];
  ok(rt.cooldownUntil! - Date.now() <= COOLDOWN_MS.upstream + 20);
  clearCooldown(p.id, "c1");
  eq(pickCredential(p, "r2")!.credential.id, "c1", "回池后重新按 priority 选到 c1");
  eq(credentialRuntimes(p)[0].failures, 1, "clearCooldown 不清计数");
});

test("forgetCredential：删凭证清状态与会话绑定；删 provider 全清", () => {
  fresh();
  const a = cred("c1", 0);
  const b = cred("c2", 1);
  const p = provider([a, b]);
  pickCredential(p, "conv");
  markFailure(p, a, 401, "");
  forgetCredential(p.id, "c1");
  eq(credentialRuntimes(p)[0].failures, 0);
  eq(credentialRuntimes(p)[0].cooldownUntil, undefined);
  markFailure(p, b, 402, "");
  forgetCredential(p.id);
  deepEq(
    credentialRuntimes(p).map((r) => r.failures),
    [0, 0]
  );
});

// ---------------------------------------------------------------- poolExhaustedHint

test("poolExhaustedHint：文案含 provider 名、凭证数、各凭证原因、不拦请求的说明与最早回到轮转的时间", () => {
  fresh();
  const a = cred("c1", 0, { label: "主 Key" });
  const b = cred("c2", 1);
  const p = provider([a, b]);
  markFailure(p, a, 401, "Incorrect API key provided");
  markFailure(p, b, 429, "rate limited", "90");
  const hint = poolExhaustedHint(p);
  includes(hint, "「测试渠道」的 2 把凭证最近都失败过");
  includes(hint, "不会拦住请求");
  includes(hint, "2 分钟后回到正常轮转", "最早解冻的是 90s 的限流，向上取整为 2 分钟");
  ok(!/后恢复/.test(hint), "不再写「后恢复」——冷却不是封锁");
  includes(hint, "主 Key：鉴权失败（Key 无效或登录失效）（Incorrect API key provided）");
  includes(hint, "凭证 2：被限流（rate limited）");
  includes(hint, "「提供商」页");
});

test("poolExhaustedHint：秒级时间用「秒」；lastError 截 80 字", () => {
  fresh();
  const a = cred("c1", 0);
  const p = provider([a]);
  markFailure(p, a, 429, "x".repeat(300), "30");
  const hint = poolExhaustedHint(p);
  includes(hint, "30 秒后回到正常轮转");
  ok(!hint.includes("x".repeat(81)), "错误摘要截断");
  includes(hint, "1 把凭证最近都失败过");
});

run();
