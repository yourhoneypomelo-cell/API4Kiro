/**
 * 凭证池状态机（src/credentialPool.ts）：分类 / 是否切号 / Retry-After / 选号 / 记账 / 冷却回池 / 提示文案。
 * 纯内存，不起网络。时钟用 fakeClock 接管 Date.now。
 */
import {
  COOLDOWN_MS,
  _resetPoolForTest,
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
  reasonText,
  shouldRotate,
} from "../src/credentialPool";
import { Credential, ProviderConfig } from "../src/providers";
import { check, deepEq, eq, fakeClock, finish, includes, test } from "./lib/harness";

function cred(id: string, priority: number, extra: Partial<Credential> = {}): Credential {
  return { id, apiKey: `sk-${id}-secret`, priority, enabled: true, ...extra };
}

function provider(creds: Credential[], strategy?: "priority" | "least-used"): ProviderConfig {
  return {
    id: "pX",
    name: "测试池",
    protocol: "openai",
    openaiApi: "chat",
    baseUrl: "https://relay.example/v1",
    apiKey: creds[0]?.apiKey || "",
    enabled: true,
    credentials: creds,
    poolStrategy: strategy,
  };
}

(async () => {
  await test("classifyFailure：状态码 + 错误体归类", () => {
    eq("0 → network", classifyFailure(0, ""), "network");
    eq("401 → auth", classifyFailure(401, "invalid api key"), "auth");
    eq("402 → quota", classifyFailure(402, ""), "quota");
    eq("403 纯 → forbidden", classifyFailure(403, "forbidden"), "forbidden");
    eq("403 + insufficient balance → quota", classifyFailure(403, "Insufficient balance"), "quota");
    eq("429 纯 → ratelimit", classifyFailure(429, "rate limit exceeded"), "ratelimit");
    eq("429 + quota → quota（New API 欠费）", classifyFailure(429, '{"error":{"message":"quota exceeded"}}'), "quota");
    eq("429 + 余额不足 → quota", classifyFailure(429, "余额不足"), "quota");
    eq("429 + extra usage → quota", classifyFailure(429, "You need extra usage"), "quota");
    eq("500 → upstream", classifyFailure(500, ""), "upstream");
    eq("503 → upstream", classifyFailure(503, "overloaded"), "upstream");
    eq("400 → other", classifyFailure(400, "bad request"), "other");
    eq("404 → other", classifyFailure(404, "model not found"), "other");
    eq("400 + quota 字样仍 other（参数错不是凭证错）", classifyFailure(400, "quota field invalid"), "other");
  });

  await test("shouldRotate：只有凭证自身问题才切号", () => {
    eq("auth 切", shouldRotate("auth"), true);
    eq("quota 切", shouldRotate("quota"), true);
    eq("forbidden 切", shouldRotate("forbidden"), true);
    eq("ratelimit 不切", shouldRotate("ratelimit"), false);
    eq("upstream 不切", shouldRotate("upstream"), false);
    eq("network 不切", shouldRotate("network"), false);
    eq("other 不切", shouldRotate("other"), false);
  });

  await test("parseRetryAfter：秒数 / HTTP 日期 / 垃圾", () => {
    const now = Date.UTC(2026, 8, 6, 12, 0, 0);
    eq("'30' → 30000", parseRetryAfter("30", now), 30000);
    eq("' 5 ' → 5000（trim）", parseRetryAfter(" 5 ", now), 5000);
    eq("'0' → 0", parseRetryAfter("0", now), 0);
    eq("未来 HTTP 日期 → 差值", parseRetryAfter(new Date(now + 90_000).toUTCString(), now), 90_000);
    eq("过去 HTTP 日期 → undefined", parseRetryAfter(new Date(now - 90_000).toUTCString(), now), undefined);
    eq("垃圾 → undefined", parseRetryAfter("soon", now), undefined);
    eq("空串 → undefined", parseRetryAfter("", now), undefined);
    eq("undefined → undefined", parseRetryAfter(undefined, now), undefined);
    eq("负数不是纯数字 → 按日期解析失败 → undefined", parseRetryAfter("-5", now), undefined);
  });

  await test("markFailure：429 按 Retry-After（下限 1s，上限 10min），不切号", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    const r0 = markFailure(p, p.credentials![0], 429, "slow down");
    eq("无 Retry-After → 缺省 60s", r0.cooldownMs, COOLDOWN_MS.ratelimit);
    eq("缺省即 60000", COOLDOWN_MS.ratelimit, 60_000);
    eq("429 rotate=false", r0.rotate, false);
    eq("kind=ratelimit", r0.kind, "ratelimit");
    _resetPoolForTest();
    eq("Retry-After 5 → 5000", markFailure(p, p.credentials![0], 429, "", "5").cooldownMs, 5000);
    _resetPoolForTest();
    eq("Retry-After 0 → 下限 1000", markFailure(p, p.credentials![0], 429, "", "0").cooldownMs, 1000);
    _resetPoolForTest();
    eq("Retry-After 3600 → 上限 600000", markFailure(p, p.credentials![0], 429, "", "3600").cooldownMs, 600_000);
    _resetPoolForTest();
    const date = new Date(Date.now() + 120_000).toUTCString();
    const rd = markFailure(p, p.credentials![0], 429, "", date).cooldownMs;
    check("Retry-After HTTP 日期 → ≈120s", rd >= 119_000 && rd <= 120_000, rd);
    _resetPoolForTest();
    eq("Retry-After 只对 429 生效：401 带 Retry-After 仍按 auth 冷却", markFailure(p, p.credentials![0], 401, "", "5").cooldownMs, COOLDOWN_MS.auth);
    eq("auth 冷却 15 分钟（只是避让期，不拦请求）", COOLDOWN_MS.auth, 15 * 60_000);
    eq("quota 冷却 30 分钟", COOLDOWN_MS.quota, 30 * 60_000);
    eq("forbidden 冷却 15 分钟", COOLDOWN_MS.forbidden, 15 * 60_000);
  });

  await test("markFailure：401/402/403 切号；400/5xx/网络不切", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    const [c1, c2] = p.credentials!;
    const a = markFailure(p, c1, 401, "unauthorized");
    eq("401 kind=auth", a.kind, "auth");
    eq("401 冷却 15 分钟", a.cooldownMs, 15 * 60_000);
    eq("401 且另一把可用 → rotate", a.rotate, true);
    const q = markFailure(p, c2, 402, "payment required");
    eq("402 kind=quota", q.kind, "quota");
    eq("402 但另一把在冷却 → 不 rotate", q.rotate, false);
    _resetPoolForTest();
    eq("403 rotate", markFailure(p, c1, 403, "forbidden").rotate, true);
    _resetPoolForTest();
    const o = markFailure(p, c1, 400, "invalid schema");
    eq("400 kind=other", o.kind, "other");
    eq("400 不 rotate", o.rotate, false);
    eq("400 冷却 15s", o.cooldownMs, 15_000);
    _resetPoolForTest();
    const u = markFailure(p, c1, 503, "overloaded");
    eq("503 不 rotate", u.rotate, false);
    eq("503 冷却 3s", u.cooldownMs, 3_000);
    _resetPoolForTest();
    const n = markFailure(p, c1, 0, "ECONNRESET");
    eq("网络 kind=network", n.kind, "network");
    eq("网络不 rotate", n.rotate, false);
    _resetPoolForTest();
    const single = provider([cred("c1", 0)]);
    eq("单把凭证 401 → 无处可切 rotate=false", markFailure(single, single.credentials![0], 401, "").rotate, false);
  });

  await test("markFailure：lastError 归一化与截断", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    markFailure(p, p.credentials![0], 500, "  line1\n\n  line2\t\tx  ");
    eq("空白折叠", credentialRuntimes(p)[0].lastError, "line1 line2 x");
    _resetPoolForTest();
    markFailure(p, p.credentials![0], 500, "");
    eq("空体 → HTTP 500", credentialRuntimes(p)[0].lastError, "HTTP 500");
    _resetPoolForTest();
    markFailure(p, p.credentials![0], 500, "x".repeat(500));
    eq("截到 200", credentialRuntimes(p)[0].lastError?.length, 200);
  });

  await test("冷却单调：短冷却不缩短已有长冷却；面板原因跟着最长的那次", () => {
    _resetPoolForTest();
    const clock = fakeClock(1_000_000);
    try {
      const p = provider([cred("c1", 0), cred("c2", 1)]);
      const c1 = p.credentials![0];
      markFailure(p, c1, 401, "bad key");
      const until1 = credentialRuntimes(p)[0].cooldownUntil;
      eq("401 后 cooldownUntil = now+15min", until1, 1_000_000 + 15 * 60_000);
      clock.advance(10_000);
      markFailure(p, c1, 503, "blip");
      const rt = credentialRuntimes(p)[0];
      eq("503 不缩短冷却", rt.cooldownUntil, until1);
      eq("冷却原因保持 auth（最长那次）", rt.cooldownReason, "auth");
      eq("failures 累计 2", rt.failures, 2);
    } finally {
      clock.restore();
    }
  });

  await test("pickCredential：priority 策略、会话粘性、排除集", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 5), cred("c2", 1), cred("c3", 3)]);
    const first = pickCredential(p, "conv-A");
    eq("priority 最小者 c2", first?.credential.id, "c2");
    eq("首次不是 sticky", first?.sticky, false);
    const again = pickCredential(p, "conv-A");
    eq("同会话粘住 c2", again?.credential.id, "c2");
    eq("标记 sticky", again?.sticky, true);
    const other = pickCredential(p, "conv-B", new Set(["c2"]));
    eq("排除 c2 后取 c3", other?.credential.id, "c3");
    const none = pickCredential(p, "conv-C", new Set(["c1", "c2", "c3"]));
    eq("全排除 → undefined", none, undefined);
    const disabled = provider([cred("c1", 0, { enabled: false }), cred("c2", 1)]);
    eq("停用的不参与", pickCredential(disabled, "x")?.credential.id, "c2");
    const nokey = provider([cred("c1", 0, { apiKey: undefined }), cred("c2", 1)]);
    eq("没 key 的不参与", pickCredential(nokey, "x")?.credential.id, "c2");
    eq("全部未配置 → undefined", pickCredential(provider([cred("c1", 0, { apiKey: undefined })]), "x"), undefined);
  });

  await test("pickCredential：粘性优先于优先级——c1 回池后同会话仍用 c2", () => {
    _resetPoolForTest();
    const clock = fakeClock(2_000_000);
    try {
      const p = provider([cred("c1", 0), cred("c2", 1)]);
      const [c1] = p.credentials!;
      markFailure(p, c1, 429, "", "5");
      eq("c1 冷却中 → conv 选 c2", pickCredential(p, "conv")?.credential.id, "c2");
      clock.advance(6_000);
      eq("c1 已回池但同会话仍粘 c2", pickCredential(p, "conv")?.credential.id, "c2");
      eq("新会话按优先级回到 c1", pickCredential(p, "conv2")?.credential.id, "c1");
      clock.advance(2 * 60 * 60_000 + 1);
      eq("粘性 2h 过期后按优先级重选 c1", pickCredential(p, "conv")?.credential.id, "c1");
    } finally {
      clock.restore();
    }
  });

  await test("pickCredential：单把凭证直接给、空 convId 不建绑定", () => {
    _resetPoolForTest();
    const one = provider([cred("c1", 0)]);
    const r = pickCredential(one, "conv");
    eq("单把直接给 c1", r?.credential.id, "c1");
    eq("单把 sticky=false", r?.sticky, false);
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    pickCredential(p, "");
    eq("空 convId 第二次也不算 sticky", pickCredential(p, "")?.sticky, false);
  });

  await test("least-used：按累计成功数，平局按 priority；同会话仍粘", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1), cred("c3", 2)], "least-used");
    const [c1, c2, c3] = p.credentials!;
    eq("全 0 → 平局按 priority c1", pickCredential(p, "s1")?.credential.id, "c1");
    markSuccess(p, c1);
    markSuccess(p, c1);
    markSuccess(p, c2);
    eq("c3 成功数 0 最少", pickCredential(p, "s2")?.credential.id, "c3");
    markSuccess(p, c3);
    markSuccess(p, c3);
    eq("c2(1) 最少", pickCredential(p, "s3")?.credential.id, "c2");
    eq("s1 会话仍粘 c1", pickCredential(p, "s1")?.credential.id, "c1");
  });

  await test("markSuccess：清零冷却与错误、累计 successes", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    const c1 = p.credentials![0];
    markFailure(p, c1, 401, "bad");
    check("冷却中", !!credentialRuntimes(p)[0].cooldownUntil);
    markSuccess(p, c1);
    const rt = credentialRuntimes(p)[0];
    eq("cooldownUntil 清", rt.cooldownUntil, undefined);
    eq("reason 清", rt.cooldownReason, undefined);
    eq("lastError 清", rt.lastError, undefined);
    eq("successes=1", rt.successes, 1);
    eq("failures 保留=1", rt.failures, 1);
    eq("成功后可再被选中", pickCredential(p, "n")?.credential.id, "c1");
  });

  await test("冷却到期自动回池；poolStatus / nextFreeAt / 耗尽提示", () => {
    _resetPoolForTest();
    const clock = fakeClock(3_000_000);
    try {
      const p = provider([cred("c1", 0, { label: "主号" }), cred("c2", 1)]);
      const [c1, c2] = p.credentials!;
      markFailure(p, c1, 429, "too many", "30");
      markFailure(p, c2, 402, "insufficient quota");
      const st = poolStatus(p);
      eq("total=2", st.total, 2);
      eq("configured=2", st.configured, 2);
      eq("cooling=2", st.cooling, 2);
      eq("nextFreeAt = c1 的 30s", st.nextFreeAt, 3_000_000 + 30_000);
      // 冷却是避让不是封锁：全部在冷却时仍给最早解冻的那把，并标 cooling
      const probe = pickCredential(p, "z");
      eq("全冷却 pick → 最早解冻的 c1", probe?.credential.id, "c1");
      eq("并标 cooling=true", probe?.cooling, true);
      eq("换 key 重发（allowCooling=false）时全冷却 → undefined，不回头碰冷却中的", pickCredential(p, "z", new Set(), { allowCooling: false }), undefined);
      eq("全冷却 + c1 已试过 → 轮到 c2", pickCredential(p, "z", new Set(["c1"]))?.credential.id, "c2");
      const hint = poolExhaustedHint(p);
      includes("提示含 provider 名", hint, "「测试池」");
      includes("提示含把数", hint, "2 把凭证最近都失败过");
      includes("提示说明不拦请求", hint, "不会拦住请求");
      includes("提示含最早回到轮转的秒数", hint, "30 秒后回到正常轮转");
      check("提示不再写「后恢复」（不是封锁）", !/后恢复/.test(hint), hint);
      includes("提示列出主号被限流", hint, "主号：被限流");
      includes("提示列出凭证 2 额度不足", hint, "凭证 2：额度 / 余额不足");
      includes("提示带 lastError", hint, "（insufficient quota）");
      clock.advance(30_001);
      const back = pickCredential(p, "z");
      eq("30s 后 c1 回池", back?.credential.id, "c1");
      eq("回池后 cooling=false", back?.cooling, false);
      eq("cooling 变 1", poolStatus(p).cooling, 1);
      eq("c1 运行态不再显示冷却", credentialRuntimes(p)[0].cooldownUntil, undefined);
      eq("c2 仍显示 quota", credentialRuntimes(p)[1].cooldownReason, "quota");
      clock.advance(3_600_000);
      eq("1h 后 c2 也回池", poolStatus(p).cooling, 0);
      const hint2 = poolExhaustedHint(p);
      check("无冷却时提示不带回到轮转时间", !/回到正常轮转/.test(hint2), hint2);
    } finally {
      clock.restore();
    }
  });

  await test("单把凭证：冷却从不拦请求；成功一次即清冷却", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0)]);
    const c1 = p.credentials![0];
    markFailure(p, c1, 401, "该令牌状态不可用");
    eq("401 后确在冷却", poolStatus(p).cooling, 1);
    const pick = pickCredential(p, "conv-single");
    eq("唯一凭证冷却中仍被选中", pick?.credential.id, "c1");
    eq("并标 cooling", pick?.cooling, true);
    includes("分钟级文案", poolExhaustedHint(p), "15 分钟后回到正常轮转");
    markSuccess(p, c1);
    eq("成功即清冷却", poolStatus(p).cooling, 0);
    eq("再选不再标 cooling", pickCredential(p, "conv-single")?.cooling, false);
  });

  await test("clearCooldown / forgetCredential", () => {
    _resetPoolForTest();
    const p = provider([cred("c1", 0), cred("c2", 1)]);
    const [c1, c2] = p.credentials!;
    markFailure(p, c1, 401, "");
    markFailure(p, c2, 401, "");
    clearCooldown(p.id, "c1");
    eq("只清 c1", credentialRuntimes(p)[0].cooldownUntil, undefined);
    check("c2 仍冷却", !!credentialRuntimes(p)[1].cooldownUntil);
    clearCooldown(p.id);
    eq("清全部", poolStatus(p).cooling, 0);
    pickCredential(p, "conv");
    markSuccess(p, c1);
    forgetCredential(p.id, "c1");
    eq("forget 后 successes 归零", credentialRuntimes(p)[0].successes, 0);
    eq("forget 后会话绑定解除 → 按优先级仍 c1", pickCredential(p, "conv")?.credential.id, "c1");
    markFailure(p, c1, 401, "");
    eq("conv 现在拿 c2", pickCredential(p, "conv")?.credential.id, "c2");
    forgetCredential(p.id);
    eq("forget 整个 provider → 状态全清", poolStatus(p).cooling, 0);
  });

  await test("reasonText 覆盖全部 FailureKind", () => {
    deepEq(
      "七类文案",
      (["auth", "quota", "forbidden", "ratelimit", "upstream", "network", "other"] as const).map(reasonText),
      ["鉴权失败（Key 无效或登录失效）", "额度 / 余额不足", "无权限", "被限流", "上游错误", "连接失败", "请求失败"]
    );
  });

  finish();
})();
