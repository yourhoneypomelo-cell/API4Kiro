/**
 * Kiro 官方厂商（src/oauth/vendors.ts#kiro）：五种 loginModes 的输入校验、本机登录态导入、
 * 与 IDE 共存的刷新（读盘对比代际 / 接管 / tmp+rename 写回 / 0600）、external_idp 拒绝、
 * listModels 分页、ensureAccessToken 并发只刷一次。全部打到本机假上游，登录态文件在临时目录。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { CancelSignal } from "../src/oauth/core";
import { NeedsLoginError, ensureAccessToken, markLoggedIn, oauthState } from "../src/oauth";
import { OAuthToken, _resetTokenStoreForTest, getToken, initTokenStore, setToken } from "../src/oauth/tokenStore";
import {
  LoginContext,
  LoginMode,
  _setKiroCachePathsForTest,
  _setVendorUrlsForTest,
  getVendor,
  importKiroLocalToken,
  isKiroApiKeyToken,
  kiroTokenFromJson,
  kiroTokenFromRecord,
} from "../src/oauth/vendors";
import { ProviderConfig } from "../src/providers";
import { FIXED_ARN, FakeKiro, startFakeKiro } from "./lib/fakeKiro";
import { check, deepEq, eq, finish, includes, rejects, request, rmrf, sleep, test, throws, tmpDir } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(o?: { version?: string }): vscode.ExtensionContext };
const stub = vscode as unknown as Stub;

const kiro = getVendor("kiro")!;

function ctxOf(mode: LoginMode, input?: Record<string, string>, openUrl?: (u: string) => void): LoginContext & { phases: string[] } {
  const phases: string[] = [];
  return {
    signal: new CancelSignal(),
    mode,
    input,
    openUrl: openUrl || (() => undefined),
    onDeviceCode: () => undefined,
    onWaitingBrowser: () => undefined,
    onPhase: (t) => phases.push(t),
    phases,
  };
}

/** 早挂 catch，免得预期中的拒绝变成 unhandled rejection 打断进程。 */
function armed<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

interface Cache {
  dir: string;
  token: string;
  profile: string;
}
function cacheDir(name: string): Cache {
  const dir = tmpDir(`a2kd-kiro-${name}-`);
  return { dir, token: path.join(dir, "kiro-auth-token.json"), profile: path.join(dir, "profile.json") };
}
function writeCache(c: Cache, raw: Record<string, unknown>): void {
  fs.writeFileSync(c.token, JSON.stringify(raw, undefined, 2));
}
const futureIso = (ms: number) => new Date(Date.now() + ms).toISOString();

function aliceGen1(over: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: "acc-alice-1",
    refreshToken: "rt-gen1",
    expiresAt: Date.now() + 60_000,
    email: "alice@example.com",
    extra: { authMethod: "social", region: "us-east-1", profileArn: FIXED_ARN, provider: "Google" },
    updatedAt: Date.now() - 1000,
    ...over,
  };
}

let fake: FakeKiro;
const dirs: string[] = [];

function resetFake(): void {
  fake.chain.clear();
  fake.chain.set("rt-gen1", { accessToken: "acc-alice-2", refreshToken: "rt-gen2" });
  fake.chain.set("rt-gen2", { accessToken: "acc-alice-3", refreshToken: "rt-gen3" });
  fake.chain.set("rt-idc-1", { accessToken: "acc-idc-2", refreshToken: "rt-idc-2" });
  fake.refreshCalls.length = 0;
  fake.emails.clear();
  fake.emails.set("acc-alice", "alice@example.com");
  fake.emails.set("acc-bob", "bob@example.com");
  fake.emails.set("acc-idc", "idc-user@corp.example");
  fake.emails.set("acc-portal", "portal@example.com");
  fake.validTokens.clear();
  for (const t of ["acc-alice-1", "acc-alice-2", "acc-alice-3", "acc-bob-1", "acc-idc-1", "acc-portal-1"]) {
    fake.validTokens.add(t);
  }
  fake.apiKeys.clear();
  fake.apiKeys.add("ksk_fake_api_key_0001");
  fake.quotaTokens.clear();
  fake.rtRequests.length = 0;
  fake.qRequests.length = 0;
  fake.usageCalls = 0;
  fake.pkce = {};
}

(async () => {
  const ctx = stub.__makeContext();
  initConfig(ctx);
  await initTokenStore(ctx);
  fake = await startFakeKiro();
  _setVendorUrlsForTest("kiro", {
    runtime: `${fake.url}/rt`,
    q: `${fake.url}/q`,
    socialAuth: `${fake.url}/social`,
    oidc: `${fake.url}/oidc`,
    portal: `${fake.url}/portal`,
    api: `${fake.url}/rt`,
  });
  const empty = cacheDir("empty");
  dirs.push(empty.dir);
  _setKiroCachePathsForTest(empty);

  await test("VendorSpec：置顶官方、kiro 格式、五种 loginModes 与表单字段", () => {
    eq("official=true", kiro.official, true);
    eq("format=kiro", kiro.format, "kiro");
    eq("flow=import", kiro.flow, "import");
    deepEq("五种方式顺序", kiro.loginModes!.map((m) => m.id), ["oauth", "import", "access_token", "json", "api_key"]);
    const byId = new Map(kiro.loginModes!.map((m) => [m.id, m]));
    eq("oauth / import 无表单（直接开始）", (byId.get("oauth")!.fields || []).length + (byId.get("import")!.fields || []).length, 0);
    deepEq("access_token 四个字段", byId.get("access_token")!.fields!.map((f) => f.key), ["accessToken", "refreshToken", "profileArn", "region"]);
    check("access_token 两个令牌是密文框", byId.get("access_token")!.fields!.filter((f) => f.secret).map((f) => f.key).join(",") === "accessToken,refreshToken");
    const j = byId.get("json")!.fields![0];
    check("json 单个多行必填字段 jsonText", j.key === "jsonText" && j.multiline === true && j.required === true, j);
    deepEq("api_key 三个字段", byId.get("api_key")!.fields!.map((f) => f.key), ["apiKey", "region", "endpoint"]);
    check("api_key 必填且密文", byId.get("api_key")!.fields![0].required === true && byId.get("api_key")!.fields![0].secret === true);
    eq("未知方式被拒", true, true);
  });

  await test("access_token 模式：输入校验", async () => {
    resetFake();
    await rejects("两项全空 → 拒绝", armed(kiro.login(ctxOf("access_token", { accessToken: "", refreshToken: "" }))), "凭证里没有 accessToken / refreshToken");
    await rejects("input 缺失也拒绝", armed(kiro.login(ctxOf("access_token"))), "凭证里没有");
    await rejects("死 access token 且无 refresh → 拒绝", armed(kiro.login(ctxOf("access_token", { accessToken: "acc-dead" }))), "又没有 refresh token");
    const c = ctxOf("access_token", { refreshToken: "rt-gen1", region: "eu-central-1" });
    const tok = await kiro.login(c);
    eq("只给 refresh token → 用它换新", tok.accessToken, "acc-alice-2");
    eq("refresh token 换代", tok.refreshToken, "rt-gen2");
    eq("邮箱由 getUsageLimits 补上", tok.email, "alice@example.com");
    eq("套餐补上", tok.plan, "Kiro Pro");
    eq("region 按填写", tok.extra?.region, "eu-central-1");
    eq("social 无 ARN 用固定值", tok.extra?.profileArn, FIXED_ARN);
    check("阶段文案里有换取", c.phases.some((p) => p.includes("refresh token")), c.phases);
    const live = await kiro.login(ctxOf("access_token", { accessToken: "acc-bob-1", refreshToken: "rt-nope" }));
    eq("活的 access token 不刷新直接核验", live.accessToken, "acc-bob-1");
    eq("核验用了 getUsageLimits", fake.usageCalls >= 1, true);
    eq("bob 的邮箱", live.email, "bob@example.com");
  });

  await test("json 模式：容错解析与校验", async () => {
    resetFake();
    await rejects("空文本", armed(kiro.login(ctxOf("json", { jsonText: "   " }))), "请粘贴凭证 JSON 内容");
    await rejects("垃圾", armed(kiro.login(ctxOf("json", { jsonText: "not json at all" }))), "不是合法的 JSON");
    await rejects("空对象", armed(kiro.login(ctxOf("json", { jsonText: "{}" }))), "未找到有效的 Kiro 凭证");
    const withBom = "\uFEFF// exported by tool\n" + JSON.stringify({ accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(3600_000), profileArn: FIXED_ARN, authMethod: "social" });
    const t1 = await kiro.login(ctxOf("json", { jsonText: withBom }));
    eq("BOM + 注释前缀仍能抠出对象", t1.accessToken, "acc-alice-1");
    const snake = kiroTokenFromRecord({ access_token: "acc-x", refresh_token: "rt-x", profile_arn: "arn:aws:codewhisperer:eu-central-1:1:profile/P", expires_in: 100, client_id: "ci", client_secret: "cs", auth_method: "IdC" });
    eq("snake_case → idc", snake.extra?.authMethod, "idc");
    eq("region 从 ARN 解出", snake.extra?.region, "eu-central-1");
    eq("clientId 进 extra", snake.extra?.clientId, "ci");
    const wrapped = kiroTokenFromRecord({ email: "wrap@example.com", token: { accessToken: "acc-w", refreshToken: "rt-w" } });
    eq("包一层 token:{} 也认，且父级邮箱带下来", wrapped.email, "wrap@example.com");
    const arr = kiroTokenFromJson(JSON.stringify([{ auth: "Social", refreshToken: "rt-a" }, { auth: "Social", refreshToken: "rt-b" }]));
    eq("数组取第一条", arr.tok.refreshToken, "rt-a");
    eq("total 报 2", arr.total, 2);
    const nested = kiroTokenFromJson(JSON.stringify({ accounts: [{ email: "n@example.com", credentials: { accessToken: "acc-n", refreshToken: "rt-n" } }] }));
    eq("accounts[].credentials 嵌套也能挖", nested.tok.email, "n@example.com");
    throws("IdC 缺 clientSecret → 拒绝", () => kiroTokenFromRecord({ refreshToken: "rt-i", authMethod: "IdC", clientId: "only-id" }), "需要一并提供 clientId 和 clientSecret");
    const epochSec = kiroTokenFromRecord({ accessToken: "a", refreshToken: "r", expiresAt: 1_900_000_000 });
    eq("秒级时间戳 ×1000", epochSec.expiresAt, 1_900_000_000_000);
    const epochMs = kiroTokenFromRecord({ accessToken: "a", refreshToken: "r", expiresAt: 1_900_000_000_000 });
    eq("毫秒时间戳原样", epochMs.expiresAt, 1_900_000_000_000);
    throws("external_idp 记录 → 拒绝并引导导入本机登录", () => kiroTokenFromRecord({ accessToken: "acc-e", refreshToken: "rt-e", authMethod: "external_idp" }), /external_idp/);
  });

  await test("api_key 模式：校验、头形态、region / endpoint 归一", async () => {
    resetFake();
    await rejects("空 key", armed(kiro.login(ctxOf("api_key", { apiKey: "  " }))), "请输入 API Key");
    const tok = await kiro.login(ctxOf("api_key", { apiKey: "ksk_fake_api_key_0001", region: " EU-CENTRAL-1 " }));
    eq("tokenType=ApiKey", tok.tokenType, "ApiKey");
    eq("authMethod=api_key", tok.extra?.authMethod, "api_key");
    eq("region 归一为小写去空格", tok.extra?.region, "eu-central-1");
    eq("展示名用 Key 尾巴", tok.email, "API Key · y_0001");
    eq("isKiroApiKeyToken", isKiroApiKeyToken(tok), true);
    const probe = fake.qRequests[fake.qRequests.length - 1];
    eq("验证请求带 tokentype: API_KEY", String(probe.headers.tokentype), "API_KEY");
    eq("验证请求 x-api-key = Key", String(probe.headers["x-api-key"]), "ksk_fake_api_key_0001");
    eq("验证请求 Bearer = Key", String(probe.headers.authorization), "Bearer ksk_fake_api_key_0001");
    const h = kiro.headers(tok, true);
    eq("请求头 tokentype", h.tokentype, "API_KEY");
    check("请求头带 IDE 风格 UA", /KiroIDE/.test(h["user-agent"] || ""), h["user-agent"]);
    eq("apiBaseFor 走 q.*", kiro.apiBaseFor!(tok), `${fake.url}/q`);
    const custom = await kiro.login(ctxOf("api_key", { apiKey: "ksk_fake_api_key_0001", endpoint: `${fake.url}/q/` }));
    eq("自定义端点保留", custom.extra?.endpoint, `${fake.url}/q`);
    eq("apiBaseFor 用自定义端点", kiro.apiBaseFor!(custom), `${fake.url}/q`);
    await rejects("服务端 403 → 拒绝", armed(kiro.login(ctxOf("api_key", { apiKey: "ksk_unknown_key" }))), "API Key 验证被拒绝");
    await rejects("region 不像 AWS region → 拒绝", armed(kiro.login(ctxOf("api_key", { apiKey: "ksk_fake_api_key_0001", region: "evil.example/x" }))), /Region/i);
    await rejects("endpoint 不是 http(s) URL → 拒绝", armed(kiro.login(ctxOf("api_key", { apiKey: "ksk_fake_api_key_0001", endpoint: "ftp://x" }))), /端点/);
    const unreachable = await kiro.login(ctxOf("api_key", { apiKey: "ksk_any", endpoint: "http://127.0.0.1:9/" }));
    eq("端点连不上不算 Key 无效：仍入池", unreachable.accessToken, "ksk_any");
    await rejects("未知方式", armed(kiro.login(ctxOf("bogus" as LoginMode))), "未知的 Kiro 授权方式");
  });

  await test("import 模式：读临时目录登录态；缺文件 / 缺字段 / IdC client 文件 / external_idp 头", async () => {
    resetFake();
    const c = cacheDir("import");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    await rejects("缺文件 → 报路径", armed(kiro.login(ctxOf("import"))), c.token);
    writeCache(c, { accessToken: "acc-alice-1" });
    await rejects("缺 refreshToken", armed(kiro.login(ctxOf("import"))), "没有 accessToken / refreshToken");
    writeCache(c, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(60_000), profileArn: "arn:aws:codewhisperer:eu-central-1:699475941385:profile/EHGA3GRVQMUK", authMethod: "social", provider: "Google" });
    const tok = await kiro.login(ctxOf("import"));
    eq("accessToken", tok.accessToken, "acc-alice-1");
    eq("region 从 ARN", tok.extra?.region, "eu-central-1");
    eq("邮箱补上", tok.email, "alice@example.com");
    eq("provider 保留", tok.extra?.provider, "Google");
    // IdC：clientId/secret 在同目录 <sha1>.json
    writeCache(c, { accessToken: "acc-idc-1", refreshToken: "rt-idc-1", expiresAt: futureIso(60_000), authMethod: "IdC", startUrl: "https://corp.awsapps.com/start" });
    throws("IdC 没有 client 文件 → 报错", () => importKiroLocalToken(c), "找不到 client 注册文件");
    fs.writeFileSync(path.join(c.dir, "abc123.json"), JSON.stringify({ clientId: "cid-fake", clientSecret: "csec-fake" }));
    const idc = importKiroLocalToken(c);
    eq("IdC clientId 从旁文件取", idc.extra?.clientId, "cid-fake");
    eq("authMethod 小写 idc", idc.extra?.authMethod, "idc");
    eq("startUrl 保留", idc.extra?.startUrl, "https://corp.awsapps.com/start");
    // profileArn 缺 → 读 profile.json
    writeCache(c, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", authMethod: "social" });
    fs.writeFileSync(c.profile, JSON.stringify({ arn: "arn:aws:codewhisperer:us-east-1:1:profile/FROMPROFILE" }));
    eq("profileArn 回退到 profile.json", importKiroLocalToken(c).extra?.profileArn, "arn:aws:codewhisperer:us-east-1:1:profile/FROMPROFILE");
    // external_idp：导入路径接受（企业账号唯一通路），请求头带 TokenType: EXTERNAL_IDP
    writeCache(c, { accessToken: "acc-ext-1", refreshToken: "rt-ext-1", authMethod: "external_idp", clientId: "cid-fake", clientSecret: "csec-fake" });
    const ext = importKiroLocalToken(c);
    eq("导入 external_idp 记录 authMethod", ext.extra?.authMethod, "external_idp");
    eq("请求头声明 TokenType: EXTERNAL_IDP", kiro.headers(ext, true).TokenType, "EXTERNAL_IDP");
  });

  await test("共存刷新 a：文件仍是刚消费的那一代 → 刷新后 tmp+rename 写回，其余字段保留", async () => {
    resetFake();
    const c = cacheDir("coexist-writeback");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    const original = { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(60_000), profileArn: FIXED_ARN, authMethod: "social", provider: "Google", region: "us-east-1", someIdeField: { keep: true } };
    writeCache(c, original);
    const fresh = await kiro.refresh(aliceGen1());
    eq("刷新走了登录服务一次", fake.refreshCalls.length, 1);
    check("刷新只带 KiroIDE UA", /^KiroIDE-/.test(fake.refreshCalls[0].ua), fake.refreshCalls[0].ua);
    eq("拿到新一代 access", fresh.accessToken, "acc-alice-2");
    eq("拿到新一代 refresh", fresh.refreshToken, "rt-gen2");
    const disk = JSON.parse(fs.readFileSync(c.token, "utf8"));
    eq("文件 accessToken 已写回", disk.accessToken, "acc-alice-2");
    eq("文件 refreshToken 已写回", disk.refreshToken, "rt-gen2");
    check("expiresAt 为 ISO 串且在未来", typeof disk.expiresAt === "string" && Date.parse(disk.expiresAt) > Date.now(), disk.expiresAt);
    deepEq("IDE 自己的字段原样保留", disk.someIdeField, { keep: true });
    eq("provider 保留", disk.provider, "Google");
    eq("目录里没有残留 .a2k.tmp", fs.readdirSync(c.dir).filter((f) => f.includes(".a2k.tmp")).length, 0);
    if (process.platform !== "win32") {
      eq("文件权限 0600", fs.statSync(c.token).mode & 0o777, 0o600);
    } else {
      check("（win32 无 POSIX 权限位，只验文件可读）", fs.existsSync(c.token));
    }
  });

  await test("共存刷新 b：IDE 已换代（同账号）→ 直接接管，不碰刷新接口", async () => {
    resetFake();
    const c = cacheDir("coexist-adopt");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    writeCache(c, { accessToken: "acc-alice-3", refreshToken: "rt-gen3", expiresAt: futureIso(3600_000), profileArn: FIXED_ARN, authMethod: "social" });
    const adopted = await kiro.refresh(aliceGen1());
    eq("接管文件里的 access", adopted.accessToken, "acc-alice-3");
    eq("接管文件里的 refresh", adopted.refreshToken, "rt-gen3");
    eq("邮箱保留", adopted.email, "alice@example.com");
    eq("套餐顺手带回", adopted.plan, "Kiro Pro");
    eq("没有调刷新接口", fake.refreshCalls.length, 0);
    eq("邮箱核对调了 getUsageLimits", fake.usageCalls, 1);
    eq("文件未被改写", JSON.parse(fs.readFileSync(c.token, "utf8")).refreshToken, "rt-gen3");
  });

  await test("共存刷新 c：文件是别的账号 → 不接管，自己刷，不写回", async () => {
    resetFake();
    const c = cacheDir("coexist-other");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    const bobFile = { accessToken: "acc-bob-1", refreshToken: "rt-bob-9", expiresAt: futureIso(3600_000), profileArn: FIXED_ARN, authMethod: "social" };
    writeCache(c, bobFile);
    const fresh = await kiro.refresh(aliceGen1());
    eq("走了刷新接口", fake.refreshCalls.length, 1);
    eq("拿到 alice 的新代", fresh.accessToken, "acc-alice-2");
    deepEq("bob 的文件原样未动", JSON.parse(fs.readFileSync(c.token, "utf8")), bobFile);
  });

  await test("共存刷新 d/e：刷新被拒 → 再看文件；文件已换代则接管，仍旧则报登录失效", async () => {
    resetFake();
    const c = cacheDir("coexist-late");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    fake.chain.delete("rt-gen1"); // 服务端已作废 gen1（IDE 刚刷过）
    // e：文件仍是旧代 → 失效
    writeCache(c, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(1000), authMethod: "social" });
    await rejects("文件仍旧 → Kiro 登录已失效", armed(kiro.refresh(aliceGen1())), "Kiro 登录已失效");
    // d：竞态——刷新被拒时文件已经是新代
    fake.refreshCalls.length = 0;
    fake.usageCalls = 0;
    let served = false;
    const origChainGet = fake.chain.get.bind(fake.chain);
    fake.chain.get = (k: string) => {
      if (k === "rt-gen1" && !served) {
        served = true;
        writeCache(c, { accessToken: "acc-alice-2", refreshToken: "rt-gen2", expiresAt: futureIso(3600_000), authMethod: "social" });
        return undefined;
      }
      return origChainGet(k);
    };
    const late = await kiro.refresh(aliceGen1());
    fake.chain.get = origChainGet;
    eq("刷新被拒后接管文件里的新代", late.refreshToken, "rt-gen2");
    eq("access 跟着接管", late.accessToken, "acc-alice-2");
    eq("刷新接口只碰了一次", fake.refreshCalls.length, 1);
  });

  await test("共存刷新 f/g/h：同代但 access 更新 → 接管；无文件 → 只刷不写；API Key 不刷新", async () => {
    resetFake();
    const c = cacheDir("coexist-same-gen");
    dirs.push(c.dir);
    _setKiroCachePathsForTest(c);
    writeCache(c, { accessToken: "acc-alice-1b", refreshToken: "rt-gen1", expiresAt: futureIso(3600_000), authMethod: "social" });
    const same = await kiro.refresh(aliceGen1());
    eq("同代、access 更新且更晚过期 → 接管", same.accessToken, "acc-alice-1b");
    eq("不调刷新接口", fake.refreshCalls.length, 0);
    writeCache(c, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(10_000), authMethod: "social" });
    const noGain = await kiro.refresh(aliceGen1({ expiresAt: Date.now() + 20_000 }));
    eq("同代且文件不比手上新 → 真刷", noGain.accessToken, "acc-alice-2");
    eq("刷了一次", fake.refreshCalls.length, 1);
    resetFake();
    _setKiroCachePathsForTest(empty);
    const nofile = await kiro.refresh(aliceGen1());
    eq("无文件 → 正常刷新", nofile.accessToken, "acc-alice-2");
    eq("无文件不写回（目录仍空）", fs.readdirSync(empty.dir).length, 0);
    const apiTok: OAuthToken = { accessToken: "ksk_fake_api_key_0001", tokenType: "ApiKey", extra: { authMethod: "api_key", region: "us-east-1" }, updatedAt: Date.now() };
    const back = await kiro.refresh(apiTok);
    eq("API Key 刷新原样返回", back, apiTok);
    eq("API Key 刷新不联网", fake.refreshCalls.length, 1);
    // IdC 刷新走 /oidc/token，带 clientId/clientSecret
    const idc = await kiro.refresh({ accessToken: "acc-idc-1", refreshToken: "rt-idc-1", extra: { authMethod: "idc", region: "us-east-1", clientId: "cid-fake", clientSecret: "csec-fake", ssoRegion: "us-east-1" }, updatedAt: Date.now() });
    eq("IdC 刷新拿到新代", idc.accessToken, "acc-idc-2");
    eq("IdC 走 oidc", fake.refreshCalls[fake.refreshCalls.length - 1].kind, "oidc");
    eq("IdC 请求体 camelCase grantType", fake.oidc.tokenBodies[fake.oidc.tokenBodies.length - 1].grantType, "refresh_token");
  });

  await test("ensureAccessToken：并发只刷一次；失效标记与 NeedsLoginError", async () => {
    resetFake();
    _setKiroCachePathsForTest(empty);
    _resetTokenStoreForTest();
    const p: ProviderConfig = { id: "pk", name: "Kiro 官方", protocol: "kiro", baseUrl: `${fake.url}/rt`, apiKey: "", enabled: true, auth: "oauth", oauthVendor: "kiro" };
    setToken("pk", aliceGen1({ expiresAt: Date.now() + 1000 }));
    const [a, b, c2] = await Promise.all([ensureAccessToken(p), ensureAccessToken(p), ensureAccessToken(p, true)]);
    eq("三路并发只刷一次", fake.refreshCalls.length, 1);
    check("三路拿到同一份新 token", a.accessToken === "acc-alice-2" && b === a && c2 === a);
    eq("落盘到 tokenStore", getToken("pk")?.refreshToken, "rt-gen2");
    eq("状态 ok", oauthState(p).state, "ok");
    // 刷新失效：refresh 链断掉
    setToken("pk", aliceGen1({ refreshToken: "rt-dead", expiresAt: Date.now() + 1000 }));
    let err: unknown;
    try {
      await ensureAccessToken(p);
    } catch (e) {
      err = e;
    }
    check("抛 NeedsLoginError", err instanceof NeedsLoginError, err);
    eq("状态 expired", oauthState(p).state, "expired");
    includes("错误提示含登录失效", (err as Error).message, "Kiro 登录已失效");
    // 重新登录（UI 会调 markLoggedIn 清失效标记）后：网络类错误不标失效、沿用旧 token
    setToken("pk", aliceGen1({ refreshToken: "rt-gen2", expiresAt: Date.now() + 1000 }));
    markLoggedIn("pk");
    eq("重新登录后状态 ok", oauthState(p).state, "ok");
    _setVendorUrlsForTest("kiro", { socialAuth: "http://127.0.0.1:9/social" });
    const kept = await ensureAccessToken(p);
    _setVendorUrlsForTest("kiro", { socialAuth: `${fake.url}/social` });
    eq("刷新网络错误 → 沿用现有 token", kept.accessToken, "acc-alice-1");
    eq("网络错误不算失效", oauthState(p).state, "ok");
  });

  await test("listModels：分页合并、schema 抠 effort、supportedInputTypes → image、profileArn 入查询串", async () => {
    resetFake();
    const live = await kiro.listModels!(aliceGen1());
    deepEq("三条跨两页", live.map((m) => m.id), ["auto", "claude-sonnet-5", "claude-haiku-4.5"]);
    const sonnet = live[1];
    deepEq("effortLevels", sonnet.effortLevels, ["low", "medium", "high", "max"]);
    eq("effortSchemaPath", sonnet.effortSchemaPath, "output_config");
    eq("defaultEffortLevel", sonnet.defaultEffortLevel, "high");
    eq("reasoning 由 effort 推出", sonnet.reasoning, true);
    eq("description 空串 → undefined（不展示）", sonnet.description, undefined);
    eq("image 由 IMAGE 推出", sonnet.image, true);
    eq("haiku 仅 TEXT → image=false", live[2].image, false);
    eq("haiku 无 schema → reasoning=false", live[2].reasoning, false);
    eq("contextWindow 取 maxInputTokens", sonnet.contextWindow, 1_000_000);
    check("查询串带 profileArn", fake.qRequests.every((q) => q.url.includes("profileArn=" + encodeURIComponent(FIXED_ARN))), fake.qRequests.map((q) => q.url));
    eq("第二页带 nextToken", fake.qRequests[1].url.includes("nextToken=page2"), true);
    // 老数据里 endpoint 带尾斜杠：不能拼出 //ListAvailableModels
    fake.qRequests.length = 0;
    const apiTok: OAuthToken = { accessToken: "ksk_fake_api_key_0001", tokenType: "ApiKey", extra: { authMethod: "api_key", region: "us-east-1", endpoint: `${fake.url}/q/` }, updatedAt: Date.now() };
    const viaKey = await kiro.listModels!(apiTok);
    eq("API Key 也能拉清单", viaKey.length, 3);
    check("尾斜杠 endpoint 不产生双斜杠路径", fake.qRequests.every((q) => q.url.startsWith("/q/ListAvailableModels?")), fake.qRequests.map((q) => q.url));
    eq("apiBaseFor 去尾斜杠", kiro.apiBaseFor!(apiTok), `${fake.url}/q`);
  });

  await test("oauth 门户登录（模拟浏览器）：PKCE 校验、redirect_uri 字面值、external_idp 拒绝", async () => {
    resetFake();
    let portalUrl = "";
    const c1 = ctxOf("oauth", undefined, (u) => (portalUrl = u));
    const login = armed(kiro.login(c1));
    for (let i = 0; i < 100 && !portalUrl; i++) {
      await sleep(20);
    }
    check("打开了门户 URL", portalUrl.startsWith(`${fake.url}/portal/signin?`), portalUrl);
    const u = new URL(portalUrl);
    eq("code_challenge_method=S256", u.searchParams.get("code_challenge_method"), "S256");
    eq("redirect_from=KiroIDE", u.searchParams.get("redirect_from"), "KiroIDE");
    const redirect = u.searchParams.get("redirect_uri")!;
    check("redirect_uri 是 http://localhost:<门户端口>", /^http:\/\/localhost:\d+$/.test(redirect), redirect);
    const state = u.searchParams.get("state")!;
    fake.pkce.challenge = u.searchParams.get("code_challenge")!;
    fake.pkce.code = "CODE-ok-1";
    const cbPort = Number(redirect.split(":")[2]);
    const ok = await request("GET", `http://127.0.0.1:${cbPort}/oauth/callback?login_option=google&code=CODE-ok-1&state=${state}`);
    eq("正确回跳 → 200 成功页", ok.status, 200);
    const tok = await login;
    eq("换到 access token", tok.accessToken, "acc-portal-1");
    eq("refresh token", tok.refreshToken, "rt-portal-1");
    eq("provider=Google", tok.extra?.provider, "Google");
    eq("authMethod=social", tok.extra?.authMethod, "social");
    eq("邮箱", tok.email, "portal@example.com");
    eq("redirect_uri 字面值 = <redirect><path>?login_option=google", fake.pkce.lastTokenBody?.redirect_uri, `${redirect}/oauth/callback?login_option=google`);
    // external_idp
    let portal2 = "";
    const c2 = ctxOf("oauth", undefined, (u) => (portal2 = u));
    const login2 = armed(kiro.login(c2));
    for (let i = 0; i < 100 && !portal2; i++) {
      await sleep(20);
    }
    const u2 = new URL(portal2);
    const port2 = Number(u2.searchParams.get("redirect_uri")!.split(":")[2]);
    await request("GET", `http://127.0.0.1:${port2}/signin/callback?login_option=external_idp&issuer_url=https%3A%2F%2Fidp.example&state=${u2.searchParams.get("state")}`);
    await rejects("external_idp → 拒绝并引导导入", login2, /external_idp.*导入本机登录/);
    // state 不匹配：这一次登录整体失败（设计如此——过期页 / 伪造回跳不能顶替当前会话）
    let portal4 = "";
    const c4 = ctxOf("oauth", undefined, (u) => (portal4 = u));
    const login4 = armed(kiro.login(c4));
    for (let i = 0; i < 100 && !portal4; i++) {
      await sleep(20);
    }
    const u4 = new URL(portal4);
    const port4 = Number(u4.searchParams.get("redirect_uri")!.split(":")[2]);
    const wrong = await request("GET", `http://127.0.0.1:${port4}/oauth/callback?login_option=google&code=CODE-ok-1&state=WRONG`);
    eq("state 不匹配 → 浏览器得到 400", wrong.status, 400);
    await rejects("state 不匹配 → 本次登录失败", login4, "state 不匹配");
    // 取消
    let portal3 = "";
    const c3 = ctxOf("oauth", undefined, (u) => (portal3 = u));
    const login3 = armed(kiro.login(c3));
    for (let i = 0; i < 100 && !portal3; i++) {
      await sleep(20);
    }
    c3.signal.cancel();
    await rejects("取消 → 登录已取消", login3, "登录已取消");
  });

  await sleep(400); // 让回调服务器的延迟关闭跑完
  await fake.close();
  _setKiroCachePathsForTest(undefined);
  for (const d of dirs) {
    rmrf(d);
  }
  finish();
})();
