/**
 * Kiro 官方直通端到端（src/krsServer.ts 的 dispatchKiro / pumpKiroPassthrough + 凭证轮换 + 阻断）：
 * 真实 KRS 于 19886，假 Kiro 上游（tests/lib/fakeKiro）。
 *  - 请求头整套镜像、只换 Authorization、逐跳头剥掉；profileArn 换成该账号的；模型 id 去 @providerId；
 *  - API Key 模式：打 q.*、tokentype: API_KEY、抹掉 profileArn；
 *  - 响应字节逐字直通，旁路解帧记账（含跨 chunk 帧、exception 帧、客户端取消）；
 *  - 401 先强刷再重发，刷不了才切号；402 冷却并切号；池干了阻断且不再打上游；无 provider 阻断。
 */
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { _resetPoolForTest, credentialRuntimes, poolStatus } from "../src/credentialPool";
import { EventStreamDecoder } from "../src/eventstream";
import { KrsProxyServer } from "../src/krsServer";
import { oauthState } from "../src/oauth";
import { OAuthToken, _resetTokenStoreForTest, getToken, initTokenStore, setToken } from "../src/oauth/tokenStore";
import { _setKiroCachePathsForTest, _setVendorUrlsForTest, getVendor } from "../src/oauth/vendors";
import { ProviderConfig, getProviders } from "../src/providers";
import { _resetForTest as resetUsage, initUsageStore, recentRecords } from "../src/usageStore";
import { FIXED_ARN, FakeKiro, startFakeKiro } from "./lib/fakeKiro";
import { Resp, check, deepEq, eq, finish, includes, request, rmrf, sleep, test, tmpDir } from "./lib/harness";

type Stub = typeof vscode & {
  __makeContext(o?: { version?: string }): vscode.ExtensionContext;
  __setConfig(key: string, value: unknown): void;
  __resetConfig(): void;
};
const stub = vscode as unknown as Stub;
const KRS_PORT = 19886;
const KRS = `http://127.0.0.1:${KRS_PORT}`;

const KIRO_UA = "aws-sdk-js/1.0.34 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#22.22.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-1.0.411-abc123def456";
const KIRO_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/vnd.amazon.eventstream",
  "user-agent": KIRO_UA,
  "x-amz-user-agent": "aws-sdk-js/1.0.34 KiroIDE-1.0.411-abc123def456",
  "x-amzn-kiro-agent-mode": "vibe",
  "x-amzn-codewhisperer-optout": "true",
  "amz-sdk-invocation-id": "11111111-2222-3333-4444-555555555555",
  "amz-sdk-request": "attempt=1; max=3",
  "x-amzn-trace-id": "Root=1-abc",
  authorization: "Bearer kiro-ide-own-token-should-be-replaced",
  "accept-encoding": "gzip, deflate, br",
  cookie: "session=should-not-leak",
  "proxy-authorization": "Basic nope",
};

function kiroBody(convId: string, modelId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationState: {
      conversationId: convId,
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "hi there, fake kiro", modelId, origin: "AI_EDITOR" } },
    },
    profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/IDE_OWN_ACCOUNT",
    ...extra,
  };
}

function post(body: Record<string, unknown>, headers: Record<string, string> = KIRO_HEADERS): Promise<Resp> {
  return request("POST", `${KRS}/generateAssistantResponse`, headers, JSON.stringify(body), 20000);
}

function decode(buf: Buffer) {
  return new EventStreamDecoder().feed(buf);
}

function textOf(buf: Buffer): string {
  return decode(buf)
    .filter((e) => e.type === "assistantResponseEvent")
    .map((e) => String((e.payload as { content?: string })?.content || ""))
    .join("");
}

const alice = (over: Partial<OAuthToken> = {}): OAuthToken => ({
  accessToken: "acc-alice-1",
  refreshToken: "rt-gen1",
  expiresAt: Date.now() + 3600_000,
  email: "alice@example.com",
  extra: { authMethod: "social", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/ALICE" },
  updatedAt: Date.now(),
  ...over,
});
const bob = (): OAuthToken => ({
  accessToken: "acc-bob-1",
  refreshToken: "rt-bob-1",
  expiresAt: Date.now() + 3600_000,
  email: "bob@example.com",
  extra: { authMethod: "social", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/BOB" },
  updatedAt: Date.now(),
});

let fake: FakeKiro;
let krs: KrsProxyServer;

const POOL_PROVIDER = (baseUrl: string): ProviderConfig => ({
  id: "pk",
  name: "Kiro 官方",
  protocol: "kiro",
  baseUrl,
  apiKey: "",
  enabled: true,
  auth: "oauth",
  oauthVendor: "kiro",
  credentials: [
    { id: "c1", label: "alice", priority: 0, enabled: true },
    { id: "c2", label: "bob", priority: 1, enabled: true },
  ],
  enabledModels: ["claude-sonnet-5"],
});

function resetFake(): void {
  fake.chain.clear();
  fake.chain.set("rt-gen1", { accessToken: "acc-alice-2", refreshToken: "rt-gen2" });
  fake.refreshCalls.length = 0;
  fake.emails.clear();
  fake.emails.set("acc-alice", "alice@example.com");
  fake.emails.set("acc-bob", "bob@example.com");
  fake.validTokens.clear();
  for (const t of ["acc-alice-1", "acc-alice-2", "acc-bob-1", "acc-exc"]) {
    fake.validTokens.add(t);
  }
  fake.apiKeys.clear();
  fake.apiKeys.add("ksk_fake_api_key_0001");
  fake.quotaTokens.clear();
  fake.exceptionTokens.clear();
  fake.exceptionTokens.add("acc-exc");
  fake.rtRequests.length = 0;
  fake.qRequests.length = 0;
  fake.splitFrames = false;
  fake.holdTailMs = 30;
  fake.abortedStreams = 0;
}

function resetPoolAndTokens(): void {
  _resetPoolForTest();
  _resetTokenStoreForTest();
  setToken("pk", alice());
  setToken("pk/c2", bob());
  resetUsage();
}

(async () => {
  const ctx = stub.__makeContext();
  initConfig(ctx);
  await initTokenStore(ctx);
  initUsageStore(ctx);
  fake = await startFakeKiro();
  _setVendorUrlsForTest("kiro", { runtime: `${fake.url}/rt`, q: `${fake.url}/q`, socialAuth: `${fake.url}/social`, oidc: `${fake.url}/oidc`, api: `${fake.url}/rt` });
  const empty = tmpDir("a2kd-kiro-pt-");
  _setKiroCachePathsForTest({ dir: empty, token: `${empty}/kiro-auth-token.json`, profile: `${empty}/profile.json` });
  stub.__resetConfig();
  stub.__setConfig("enabled", true);
  stub.__setConfig("providers", [POOL_PROVIDER(`${fake.url}/rt`)]);
  krs = new KrsProxyServer(ctx, KRS_PORT);
  await krs.start();
  eq("KRS 成为 19886 的 OWNER", krs.isOwner(), true);
  eq("配置里 provider 可读", getProviders().length, 1);

  await test("直通：头镜像、只换 Authorization、逐跳头剥掉、profileArn 换账号、模型去限定；字节逐字直通 + 记账", async () => {
    resetFake();
    resetPoolAndTokens();
    const r = await post(kiroBody("conv-1", "claude-sonnet-5@pk"));
    eq("Kiro 侧 200", r.status, 200);
    eq("content-type 是 eventstream", String(r.headers["content-type"]), "application/vnd.amazon.eventstream");
    eq("上游收到一次", fake.rtRequests.length, 1);
    const up = fake.rtRequests[0];
    eq("打到 runtime 域的 generateAssistantResponse", up.url, "/rt/generateAssistantResponse");
    eq("Authorization 换成账号 token", String(up.headers.authorization), "Bearer acc-alice-1");
    eq("user-agent 逐字镜像", String(up.headers["user-agent"]), KIRO_UA);
    eq("x-amz-user-agent 镜像", String(up.headers["x-amz-user-agent"]), KIRO_HEADERS["x-amz-user-agent"]);
    eq("x-amzn-kiro-agent-mode 镜像", String(up.headers["x-amzn-kiro-agent-mode"]), "vibe");
    eq("x-amzn-codewhisperer-optout 镜像", String(up.headers["x-amzn-codewhisperer-optout"]), "true");
    eq("amz-sdk-invocation-id 镜像", String(up.headers["amz-sdk-invocation-id"]), KIRO_HEADERS["amz-sdk-invocation-id"]);
    eq("amz-sdk-request 镜像", String(up.headers["amz-sdk-request"]), "attempt=1; max=3");
    eq("x-amzn-trace-id 镜像", String(up.headers["x-amzn-trace-id"]), "Root=1-abc");
    eq("accept 镜像为 eventstream", String(up.headers.accept), "application/vnd.amazon.eventstream");
    eq("accept-encoding 被剥掉（不替 Kiro 协商压缩）", up.headers["accept-encoding"], undefined);
    eq("cookie 被剥掉", up.headers.cookie, undefined);
    eq("proxy-authorization 被剥掉", up.headers["proxy-authorization"], undefined);
    eq("OAuth 账号不带 tokentype", up.headers.tokentype, undefined);
    eq("host 是上游而不是 Kiro 发来的", String(up.headers.host), `127.0.0.1:${fake.port}`);
    eq("content-length 与实际 body 一致", Number(up.headers["content-length"]), Buffer.byteLength(up.raw));
    eq("body.profileArn 换成账号自己的", up.body.profileArn, "arn:aws:codewhisperer:us-east-1:699475941385:profile/ALICE");
    const cs = up.body.conversationState as { currentMessage: { userInputMessage: { modelId: string } } };
    eq("模型 id 去掉 @pk 限定", cs.currentMessage.userInputMessage.modelId, "claude-sonnet-5");
    check("响应字节与上游写出的逐字节相同", r.buffer.equals(fake.lastStreamBytes), { got: r.buffer.length, want: fake.lastStreamBytes.length });
    deepEq("帧序列原样", decode(r.buffer).map((e) => e.type), ["messageMetadataEvent", "assistantResponseEvent", "assistantResponseEvent", "metadataEvent"]);
    eq("正文拼接", textOf(r.buffer), "Hello from fake Kiro");
    await sleep(50);
    const rec = recentRecords(1)[0];
    eq("记账 protocol=kiro", rec?.protocol, "kiro");
    eq("记账 inputTokens=uncached 120", rec?.inputTokens, 120);
    eq("记账 cacheRead 30", rec?.cacheReadTokens, 30);
    eq("记账 cacheWrite 5", rec?.cacheWriteTokens, 5);
    eq("记账 outputTokens 7", rec?.outputTokens, 7);
    eq("记账 ok", rec?.ok, true);
    eq("记账 credentialId c1（池）", rec?.credentialId, "c1");
    eq("记账 model 去限定", rec?.model, "claude-sonnet-5");
    eq("记账 conversationId", rec?.conversationId, "conv-1");
    check("记账 firstTokenMs 已测得", typeof rec?.firstTokenMs === "number" && rec!.firstTokenMs! >= 0, rec?.firstTokenMs);
    // Kiro 的客户端标识头已被记住，供我们自己发起的官方接口复用
    const h = getVendor("kiro")!.headers(alice(), true);
    eq("rememberKiroClientHeaders：UA 复用", h["user-agent"], KIRO_UA);
    eq("rememberKiroClientHeaders：agent-mode 复用", h["x-amzn-kiro-agent-mode"], "vibe");
  });

  await test("直通：历史消息 modelId 也去限定；非 KiroIDE UA 不被记住", async () => {
    resetFake();
    resetPoolAndTokens();
    const body = kiroBody("conv-2", "claude-sonnet-5@pk", {
      conversationState: {
        conversationId: "conv-2",
        history: [{ userInputMessage: { content: "earlier", modelId: "claude-sonnet-5@pk" } }, { assistantResponseMessage: { content: "ok" } }],
        currentMessage: { userInputMessage: { content: "now", modelId: "claude-sonnet-5@pk", origin: "AI_EDITOR" } },
      },
    });
    const r = await post(body, { ...KIRO_HEADERS, "user-agent": "curl/8.0 (not kiro)" });
    eq("200", r.status, 200);
    const hist = (fake.rtRequests[0].body.conversationState as { history: Array<{ userInputMessage?: { modelId: string } }> }).history;
    eq("历史 modelId 去限定", hist[0].userInputMessage?.modelId, "claude-sonnet-5");
    eq("curl UA 也照样镜像给这次请求", String(fake.rtRequests[0].headers["user-agent"]), "curl/8.0 (not kiro)");
    eq("但不被记成 Kiro 客户端头", getVendor("kiro")!.headers(alice(), true)["user-agent"], KIRO_UA);
  });

  await test("解帧记账：帧跨 chunk 切开仍能凑齐 metadataEvent；exception 帧记为失败", async () => {
    resetFake();
    resetPoolAndTokens();
    fake.splitFrames = true;
    const r = await post(kiroBody("conv-3", "claude-sonnet-5"));
    eq("200", r.status, 200);
    check("跨 chunk 仍逐字节一致", r.buffer.equals(fake.lastStreamBytes));
    await sleep(50);
    let rec = recentRecords(1)[0];
    eq("跨 chunk 仍抠到 inputTokens", rec?.inputTokens, 120);
    eq("跨 chunk 仍抠到 outputTokens", rec?.outputTokens, 7);
    fake.splitFrames = false;
    setToken("pk", alice({ accessToken: "acc-exc" }));
    const r2 = await post(kiroBody("conv-4", "claude-sonnet-5"));
    eq("exception 帧仍是 200 直通", r2.status, 200);
    const types = decode(r2.buffer).map((e) => e.messageType + ":" + e.type);
    deepEq("exception 帧原样透传", types, ["event:messageMetadataEvent", "exception:ThrottlingException"]);
    await sleep(50);
    rec = recentRecords(1)[0];
    eq("记账 ok=false", rec?.ok, false);
    includes("记账 error 含异常类型", rec?.error, "ThrottlingException");
    includes("记账 error 含异常文案", rec?.error, "Too many requests");
  });

  await test("客户端中途取消：上游连接被销毁，记账 error=客户端取消", async () => {
    resetFake();
    resetPoolAndTokens();
    fake.splitFrames = true;
    fake.holdTailMs = 1500;
    const before = recentRecords(1)[0]?.ts || 0;
    await new Promise<void>((resolve) => {
      const http = require("http") as typeof import("http");
      const payload = JSON.stringify(kiroBody("conv-5", "claude-sonnet-5"));
      const req = http.request({ method: "POST", host: "127.0.0.1", port: KRS_PORT, path: "/generateAssistantResponse", headers: { ...KIRO_HEADERS, "content-length": String(Buffer.byteLength(payload)) } }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => resolve());
      req.end(payload);
    });
    await sleep(300);
    const rec = recentRecords(1)[0];
    check("有新记录", (rec?.ts || 0) > before);
    eq("记账 ok=false", rec?.ok, false);
    eq("记账 error=客户端取消", rec?.error, "客户端取消");
    await sleep(1600);
    eq("上游侧观察到流被中断（body.destroy 生效）", fake.abortedStreams, 1);
  });

  await test("401 → 当前凭证先强刷再重发（不切号）", async () => {
    resetFake();
    resetPoolAndTokens();
    setToken("pk", alice({ accessToken: "acc-alice-stale" }));
    const r = await post(kiroBody("conv-6", "claude-sonnet-5"));
    eq("最终 200", r.status, 200);
    eq("上游收到 2 次", fake.rtRequests.length, 2);
    eq("第一次带过期 token", String(fake.rtRequests[0].headers.authorization), "Bearer acc-alice-stale");
    eq("第二次带刷新后的 token", String(fake.rtRequests[1].headers.authorization), "Bearer acc-alice-2");
    eq("刷新接口调用一次", fake.refreshCalls.length, 1);
    eq("tokenStore 已落新代", getToken("pk")?.refreshToken, "rt-gen2");
    eq("正文正常", textOf(r.buffer), "Hello from fake Kiro");
    const p = getProviders()[0];
    eq("c1 未进冷却", credentialRuntimes(p)[0].cooldownUntil, undefined);
    await sleep(50);
    eq("记账仍是 c1", recentRecords(1)[0]?.credentialId, "c1");
  });

  await test("401 → 刷新失败 → 标 auth 冷却并切到 c2", async () => {
    resetFake();
    resetPoolAndTokens();
    setToken("pk", alice({ accessToken: "acc-alice-stale", refreshToken: "rt-dead" }));
    const r = await post(kiroBody("conv-7", "claude-sonnet-5"));
    eq("最终 200", r.status, 200);
    eq("上游收到 2 次", fake.rtRequests.length, 2);
    eq("第二次换成 bob 的 token", String(fake.rtRequests[1].headers.authorization), "Bearer acc-bob-1");
    eq("第二次 body.profileArn 也换成 bob 的", fake.rtRequests[1].body.profileArn, "arn:aws:codewhisperer:us-east-1:699475941385:profile/BOB");
    const p = getProviders()[0];
    const rt = credentialRuntimes(p);
    eq("c1 冷却原因 auth", rt[0].cooldownReason, "auth");
    eq("c2 未冷却", rt[1].cooldownUntil, undefined);
    eq("c1 登录态标为 expired", oauthState(p, "c1").state, "expired");
    await sleep(50);
    eq("记账落在 c2", recentRecords(1)[0]?.credentialId, "c2");
    // 同会话下一次直接用 c2（c1 冷却中）
    await post(kiroBody("conv-7", "claude-sonnet-5"));
    eq("后续请求直接走 bob", String(fake.rtRequests[2].headers.authorization), "Bearer acc-bob-1");
    eq("没有再碰上游 401", fake.rtRequests.length, 3);
  });

  await test("402 → quota 冷却 30 分钟并切号；全部冷却后仍照常再试最早失败的一把，不在本地拒绝", async () => {
    resetFake();
    resetPoolAndTokens();
    fake.quotaTokens.add("acc-alice-1");
    const r = await post(kiroBody("conv-8", "claude-sonnet-5"));
    eq("切号后 200", r.status, 200);
    eq("上游 2 次（402 → bob）", fake.rtRequests.length, 2);
    const p = getProviders()[0];
    const c1 = credentialRuntimes(p)[0];
    eq("c1 冷却原因 quota", c1.cooldownReason, "quota");
    const left = (c1.cooldownUntil || 0) - Date.now();
    check("c1 冷却约 30 分钟（避让期，不拦请求）", left > 1_700_000 && left <= 1_800_000, c1.cooldownUntil);
    includes("lastError 记下上游文案", c1.lastError, "MONTHLY_REQUEST_COUNT");
    // bob 也用完额度
    fake.quotaTokens.add("acc-bob-1");
    const r2 = await post(kiroBody("conv-9", "claude-sonnet-5"));
    eq("全部 402 仍回 200 事件流（错误进正文）", r2.status, 200);
    const text2 = textOf(r2.buffer);
    includes("正文说明上游 402", text2, "上游返回 402");
    includes("正文带 Kiro 官方额度提示", text2, "本月额度已用完");
    includes("正文带池提示：都失败过", text2, "2 把凭证最近都失败过");
    includes("正文说明不会拦住请求", text2, "不会拦住请求");
    check("正文不再写「后恢复」", !/后恢复/.test(text2), text2.slice(0, 300));
    const frames2 = decode(r2.buffer);
    check("末尾有 stopReason 与 exception 帧", frames2.some((f) => f.type === "metadataEvent") && frames2.some((f) => f.messageType === "exception"), frames2.map((f) => f.type));
    eq("池状态 cooling=2", poolStatus(p).cooling, 2);
    // 全部冷却：下一次请求不在本地拒绝，用最早失败的那把（alice）照常再试一次；上游仍 402 → 真实错误回给用户
    const seen = fake.rtRequests.length;
    const r3 = await post(kiroBody("conv-10", "claude-sonnet-5"));
    eq("全部冷却仍回 200 事件流", r3.status, 200);
    eq("上游又收到 1 次（只试最早失败的那把，不再在冷却中的 key 之间轮换）", fake.rtRequests.length, seen + 1);
    eq("再试的是最早失败的 alice", String(fake.rtRequests[seen].headers.authorization), "Bearer acc-alice-1");
    const text3 = textOf(r3.buffer);
    includes("正文是真实的上游 402", text3, "上游返回 402");
    includes("正文附池提示", text3, "「Kiro 官方」的 2 把凭证最近都失败过");
    check("仍带 END_TURN（否则 Kiro 会静默重发）", decode(r3.buffer).some((f) => f.type === "metadataEvent" && (f.payload as { stopReason?: string })?.stopReason === "END_TURN"));
    // alice 再次 402 后冷却被刷新到更晚 → 下一次「最早解冻」轮到 bob：探测在多把 key 之间自然轮转，不死盯一把。
    // 用户在上游侧修好了 bob：下一次请求直接成功，冷却随之清零，不必等 30 分钟。
    fake.quotaTokens.delete("acc-bob-1");
    const seen2 = fake.rtRequests.length;
    const r4 = await post(kiroBody("conv-11b", "claude-sonnet-5"));
    eq("修好后立刻可用", r4.status, 200);
    eq("上游收到 1 次", fake.rtRequests.length, seen2 + 1);
    eq("这次试的是 bob（alice 刚失败过、解冻更晚）", String(fake.rtRequests[seen2].headers.authorization), "Bearer acc-bob-1");
    check("正文是上游正常回复而非错误", !/上游返回 402/.test(textOf(r4.buffer)), textOf(r4.buffer).slice(0, 120));
    eq("成功即清 bob 的冷却，只剩 alice 在冷却", poolStatus(p).cooling, 1);
    eq("bob 运行态不再显示冷却", credentialRuntimes(p)[1].cooldownUntil, undefined);
  });

  await test("阻断：没有可用 provider 时不发任何上游请求", async () => {
    resetFake();
    resetPoolAndTokens();
    stub.__setConfig("providers", [{ ...POOL_PROVIDER(`${fake.url}/rt`), enabled: false }]);
    const r = await post(kiroBody("conv-11", "claude-sonnet-5"));
    eq("200 事件流", r.status, 200);
    includes("提示尚无可用 provider", textOf(r.buffer), "尚无可用的 provider");
    includes("列出该 provider 已停用", textOf(r.buffer), "Kiro 官方：已停用");
    eq("上游 0 次", fake.rtRequests.length, 0);
    stub.__setConfig("providers", []);
    const r2 = await post(kiroBody("conv-12", "claude-sonnet-5"));
    includes("空注册表也阻断", textOf(r2.buffer), "当前没有任何 provider");
    eq("上游仍 0 次", fake.rtRequests.length, 0);
    stub.__setConfig("providers", [POOL_PROVIDER(`${fake.url}/rt`)]);
  });

  await test("API Key 模式：打 q.*、tokentype: API_KEY、x-api-key、抹掉 profileArn", async () => {
    resetFake();
    _resetPoolForTest();
    _resetTokenStoreForTest();
    resetUsage();
    const apiProvider: ProviderConfig = {
      id: "pak",
      name: "Kiro API Key",
      protocol: "kiro",
      baseUrl: `${fake.url}/rt`,
      apiKey: "",
      enabled: true,
      auth: "oauth",
      oauthVendor: "kiro",
      enabledModels: ["claude-sonnet-5"],
    };
    stub.__setConfig("providers", [apiProvider]);
    setToken("pak", { accessToken: "ksk_fake_api_key_0001", tokenType: "ApiKey", extra: { authMethod: "api_key", region: "us-east-1" }, email: "API Key · y_0001", updatedAt: Date.now() });
    const r = await post(kiroBody("conv-13", "claude-sonnet-5"));
    eq("200", r.status, 200);
    eq("上游 1 次", fake.rtRequests.length, 1);
    const up = fake.rtRequests[0];
    eq("打到 q.* 域", up.url, "/q/generateAssistantResponse");
    eq("tokentype: API_KEY", String(up.headers.tokentype), "API_KEY");
    eq("x-api-key = Key", String(up.headers["x-api-key"]), "ksk_fake_api_key_0001");
    eq("Authorization Bearer = Key", String(up.headers.authorization), "Bearer ksk_fake_api_key_0001");
    eq("Kiro 自己账号的 profileArn 被抹掉", up.body.profileArn, undefined);
    eq("Kiro 的 UA 仍镜像", String(up.headers["user-agent"]), KIRO_UA);
    check("字节直通", r.buffer.equals(fake.lastStreamBytes));
    await sleep(50);
    const rec = recentRecords(1)[0];
    eq("单凭证 provider 记账不带 credentialId", rec?.credentialId, undefined);
    eq("记账 provider", rec?.providerId, "pak");
    stub.__setConfig("providers", [POOL_PROVIDER(`${fake.url}/rt`)]);
  });

  await krs.stop();
  await fake.close();
  _setKiroCachePathsForTest(undefined);
  rmrf(empty);
  finish();
})();
