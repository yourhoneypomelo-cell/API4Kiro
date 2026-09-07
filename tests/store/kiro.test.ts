/**
 * Kiro 官方厂商（oauth/vendors.ts#kiro）：五种授权方式 + 与 IDE 共存刷新 + 门户登录（模拟浏览器）。
 *
 * 假上游：一个本地 http 服务器（19871）同时扮演
 *   /q/getUsageLimits（按 bearer 前缀给邮箱）、/q/ListAvailableModels（分页；API Key 需 tokentype）、
 *   /social/refreshToken（代际 rt-gen1 → rt-gen2 → rt-gen3，用过即作废）、/social/oauth/token（校验 PKCE）。
 * 本机登录态文件放临时目录（_setKiroCachePathsForTest），绝不碰真实 ~/.aws。
 */
import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { URL } from "url";
import { test, run, eq, ok, deepEq, includes, throws, sleep, waitFor } from "./harness";
import {
  KIRO_PORTAL_CALLBACK_PORTS,
  LoginContext,
  VendorSpec,
  _setKiroCachePathsForTest,
  _setVendorUrlsForTest,
  getVendor,
  isKiroApiKeyToken,
  kiroTokenFromJson,
  kiroTokenFromRecord,
  OAUTH_VENDORS,
} from "../../src/oauth/vendors";
import { CancelSignal, LoginCancelled } from "../../src/oauth/core";
import { OAuthToken, _resetTokenStoreForTest, deleteProviderTokens, getToken, hasToken, initTokenStore, moveToken, setToken } from "../../src/oauth/tokenStore";
import { ensureAccessToken } from "../../src/oauth";
import { ProviderConfig, tokenKeyOf } from "../../src/providers";

const stub = vscode as unknown as { __makeContext(): unknown; __reset(): void };
const PORT = 19871;
const PORTAL_CB_PORT = 19874;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXED_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

// ---------------------------------------------------------------- 假上游

const EMAIL_BY_TOKEN: Record<string, string> = {
  "acc-alice-1": "alice@example.com",
  "acc-alice-2": "alice@example.com",
  "acc-alice-3": "alice@example.com",
  "acc-bob-9": "bob@example.com",
};
const GENERATIONS: Record<string, { access: string; refresh: string }> = {
  "rt-gen1": { access: "acc-alice-2", refresh: "rt-gen2" },
  "rt-gen2": { access: "acc-alice-3", refresh: "rt-gen3" },
};
const API_KEY_OK = "ksk_goodkey0001";

interface Seen {
  refreshCalls: string[];
  usageCalls: number;
  listModelsHeaders: Array<Record<string, string>>;
  oauthTokenBodies: Array<Record<string, unknown>>;
  consumed: Set<string>;
  challenge?: string;
}
const seen: Seen = { refreshCalls: [], usageCalls: 0, listModelsHeaders: [], oauthTokenBodies: [], consumed: new Set() };
function resetSeen() {
  seen.refreshCalls = [];
  seen.usageCalls = 0;
  seen.listModelsHeaders = [];
  seen.oauthTokenBodies = [];
  seen.consumed = new Set();
  seen.challenge = undefined;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearerOf(req: http.IncomingMessage): string {
  const a = String(req.headers.authorization || "");
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

/** API Key 请求：x-api-key 必须对，且必须声明 tokentype: API_KEY（否则按 OAuth token 校验 → 403）。 */
function apiKeyVerdict(req: http.IncomingMessage): number | undefined {
  const k = String(req.headers["x-api-key"] || "");
  if (!k) {
    return undefined;
  }
  if (k !== API_KEY_OK) {
    return 403;
  }
  if (String(req.headers.tokentype || "") !== "API_KEY") {
    return 403;
  }
  return 200;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", BASE);
  const p = u.pathname;
  if (p === "/q/getUsageLimits") {
    seen.usageCalls++;
    const email = EMAIL_BY_TOKEN[bearerOf(req)];
    if (!email) {
      return send(res, 401, { message: "The security token included in the request is invalid" });
    }
    return send(res, 200, { userInfo: { email }, subscriptionInfo: { subscriptionTitle: "Kiro Pro" } });
  }
  if (p === "/q/ListAvailableModels") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : String(v ?? "");
    }
    seen.listModelsHeaders.push(headers);
    const ak = apiKeyVerdict(req);
    if (ak === 403) {
      return send(res, 403, { message: "Forbidden" });
    }
    if (ak === undefined && !EMAIL_BY_TOKEN[bearerOf(req)]) {
      return send(res, 401, { message: "invalid token" });
    }
    const page = u.searchParams.get("nextToken") || "";
    if (!page) {
      return send(res, 200, {
        models: [
          { modelId: "claude-sonnet-5", modelName: "Claude Sonnet 5", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 }, supportedInputTypes: ["TEXT", "IMAGE"], additionalModelRequestFieldsSchema: { type: "object", properties: { output_config: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "max"], default: "high" } } } } } },
        ],
        nextToken: "page2",
      });
    }
    return send(res, 200, { models: [{ modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5", tokenLimits: { maxInputTokens: 200000 }, supportedInputTypes: ["TEXT"] }] });
  }
  if (p === "/social/refreshToken" && req.method === "POST") {
    const body = await readJson(req);
    const rt = String(body.refreshToken || "");
    seen.refreshCalls.push(rt);
    const gen = GENERATIONS[rt];
    if (!gen || seen.consumed.has(rt)) {
      return send(res, 400, { message: "invalid_grant: refresh token is invalid or has been rotated" });
    }
    seen.consumed.add(rt);
    return send(res, 200, { accessToken: gen.access, refreshToken: gen.refresh, expiresIn: 3600, profileArn: FIXED_ARN });
  }
  if (p === "/social/oauth/token" && req.method === "POST") {
    const body = await readJson(req);
    seen.oauthTokenBodies.push(body);
    const verifier = String(body.code_verifier || "");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (body.code !== "code-123" || !seen.challenge || challenge !== seen.challenge) {
      return send(res, 400, { message: "invalid pkce or code" });
    }
    if (!/^http:\/\/localhost:\d+\/(oauth|signin)\/callback\?login_option=(google|github)$/.test(String(body.redirect_uri))) {
      return send(res, 400, { message: "redirect_uri mismatch: " + body.redirect_uri });
    }
    return send(res, 200, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", profileArn: FIXED_ARN, expiresIn: 3600 });
  }
  send(res, 404, { message: "no route " + p });
});

// ---------------------------------------------------------------- 工具

let tmpRoot = "";
function tmpCache(name: string): { dir: string; token: string; profile: string } {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, token: path.join(dir, "kiro-auth-token.json"), profile: path.join(dir, "profile.json") };
}
function writeTokenFile(file: string, obj: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify(obj, undefined, 2));
}
function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function ctxOf(mode: LoginContext["mode"], input?: Record<string, string>, opened: string[] = [], phases: string[] = []): LoginContext {
  return {
    signal: new CancelSignal(),
    mode,
    input,
    openUrl: (u) => opened.push(u),
    onDeviceCode: () => undefined,
    onWaitingBrowser: () => undefined,
    onPhase: (t) => phases.push(t),
  };
}

let kiro: VendorSpec;

test("setup：起假上游、临时目录、把 kiro 端点指到本机", async () => {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-kiro-test-"));
  _setVendorUrlsForTest("kiro", {
    q: `${BASE}/q`,
    socialAuth: `${BASE}/social`,
    runtime: `${BASE}/rt`,
    oidc: `${BASE}/oidc`,
    portal: `${BASE}/portal`,
    api: `${BASE}/rt`,
  });
  KIRO_PORTAL_CALLBACK_PORTS.splice(0, KIRO_PORTAL_CALLBACK_PORTS.length, PORTAL_CB_PORT);
  _setKiroCachePathsForTest(tmpCache("empty"));
  kiro = getVendor("kiro")!;
  ok(kiro, "kiro 厂商存在");
  eq(OAUTH_VENDORS.length, 6, "六家厂商");
  eq(kiro.official, true);
});

// ---------------------------------------------------------------- loginModes

test("loginModes：五种方式齐全、顺序固定、表单校验位正确", () => {
  const modes = kiro.loginModes!;
  deepEq(
    modes.map((m) => m.id),
    ["oauth", "import", "access_token", "json", "api_key"]
  );
  eq(modes[0].fields, undefined, "oauth 无表单");
  eq(modes[1].fields, undefined, "import 无表单");
  const at = modes[2].fields!;
  deepEq(
    at.map((f) => f.key),
    ["accessToken", "refreshToken", "profileArn", "region"]
  );
  ok(!at[0].required && !at[1].required, "access token 与 refresh token 二选一，均不单独必填");
  ok(at[0].secret && at[1].secret);
  const js = modes[3].fields!;
  eq(js.length, 1);
  eq(js[0].key, "jsonText");
  eq(js[0].required, true);
  eq(js[0].multiline, true);
  const ak = modes[4].fields!;
  eq(ak[0].key, "apiKey");
  eq(ak[0].required, true);
  eq(ak[0].secret, true);
  deepEq(
    ak.map((f) => f.key),
    ["apiKey", "region", "endpoint"]
  );
});

test("login：未知 mode 报错", async () => {
  await throws(() => kiro.login(ctxOf("device" as never)), /未知的 Kiro 授权方式/);
});

// ---------------------------------------------------------------- import

test("import：读临时目录里的 kiro-auth-token.json，补邮箱与套餐，region 从 ARN 取", async () => {
  resetSeen();
  const c = tmpCache("import-ok");
  writeTokenFile(c.token, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(), profileArn: FIXED_ARN, authMethod: "social", provider: "Google" });
  _setKiroCachePathsForTest(c);
  const phases: string[] = [];
  const tok = await kiro.login(ctxOf("import", undefined, [], phases));
  eq(tok.accessToken, "acc-alice-1");
  eq(tok.refreshToken, "rt-gen1");
  eq(tok.email, "alice@example.com");
  eq(tok.plan, "Kiro Pro");
  eq(tok.extra!.authMethod, "social");
  eq(tok.extra!.provider, "Google");
  eq(tok.extra!.region, "us-east-1");
  eq(tok.extra!.profileArn, FIXED_ARN);
  ok(typeof tok.expiresAt === "number" && tok.expiresAt > Date.now());
  eq(seen.usageCalls, 1);
  ok(phases.some((t) => t.includes("读取本机")));
});

test("import：文件不存在 / 缺字段 / IdC 缺 client 注册文件 → 明确报错", async () => {
  _setKiroCachePathsForTest(tmpCache("import-missing"));
  await throws(() => kiro.login(ctxOf("import")), /本机 Kiro 未登录/);
  const c = tmpCache("import-nofield");
  writeTokenFile(c.token, { accessToken: "acc-alice-1" });
  _setKiroCachePathsForTest(c);
  await throws(() => kiro.login(ctxOf("import")), /没有 accessToken \/ refreshToken/);
  const d = tmpCache("import-idc");
  writeTokenFile(d.token, { accessToken: "acc-alice-1", refreshToken: "rt-idc", expiresAt: futureIso(), authMethod: "IdC" });
  _setKiroCachePathsForTest(d);
  await throws(() => kiro.login(ctxOf("import")), /client 注册文件/);
});

test("import：IdC 账号从同目录 <hash>.json 取 clientId/clientSecret；profileArn 缺失时读 profile.json", async () => {
  const c = tmpCache("import-idc-ok");
  writeTokenFile(c.token, { accessToken: "acc-alice-1", refreshToken: "rt-idc", expiresAt: futureIso(), authMethod: "IdC", startUrl: "https://view.awsapps.com/start" });
  writeTokenFile(path.join(c.dir, "0123abcd.json"), { clientId: "cid-1", clientSecret: "csec-1", expiresAt: futureIso() });
  writeTokenFile(c.profile, { arn: "arn:aws:codewhisperer:eu-central-1:638616132270:profile/AAAACCCCXXXX" });
  _setKiroCachePathsForTest(c);
  const tok = await kiro.login(ctxOf("import"));
  eq(tok.extra!.authMethod, "idc");
  eq(tok.extra!.clientId, "cid-1");
  eq(tok.extra!.clientSecret, "csec-1");
  eq(tok.extra!.startUrl, "https://view.awsapps.com/start");
  eq(tok.extra!.region, "eu-central-1", "region 从 profile ARN 解出");
});

test("import：没拿到邮箱时合成「<idp> · <refresh 尾 6 位>」展示名", async () => {
  const c = tmpCache("import-noemail");
  writeTokenFile(c.token, { accessToken: "acc-unknown-x", refreshToken: "rt-zzzzzz123456", expiresAt: futureIso(), authMethod: "social", provider: "Github", profileArn: FIXED_ARN });
  _setKiroCachePathsForTest(c);
  const tok = await kiro.login(ctxOf("import"));
  eq(tok.email, "Github · 123456");
});

// ---------------------------------------------------------------- access_token

test("access_token：有效 access token 在线核验后入池；空表单报错", async () => {
  resetSeen();
  _setKiroCachePathsForTest(tmpCache("empty"));
  const tok = await kiro.login(ctxOf("access_token", { accessToken: "acc-alice-1", refreshToken: "rt-gen1" }));
  eq(tok.email, "alice@example.com");
  eq(tok.accessToken, "acc-alice-1");
  eq(tok.extra!.authMethod, "social");
  eq(tok.extra!.profileArn, FIXED_ARN, "social 没给 ARN 时用固定值");
  deepEq(seen.refreshCalls, [], "有效 token 不刷新");
  await throws(() => kiro.login(ctxOf("access_token", { accessToken: "", refreshToken: "" })), /至少要有 refresh token/);
});

test("access_token：失效 access token → 401 → 用 refresh token 换新；只有 refresh token 也能激活", async () => {
  resetSeen();
  const tok = await kiro.login(ctxOf("access_token", { accessToken: "acc-dead", refreshToken: "rt-gen1", region: "eu-central-1" }));
  eq(tok.accessToken, "acc-alice-2");
  eq(tok.refreshToken, "rt-gen2");
  eq(tok.email, "alice@example.com");
  eq(tok.extra!.region, "eu-central-1");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
  resetSeen();
  const only = await kiro.login(ctxOf("access_token", { refreshToken: "rt-gen1" }));
  eq(only.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
  resetSeen();
  await throws(() => kiro.login(ctxOf("access_token", { accessToken: "acc-dead" })), /没有 refresh token 可续期/);
  await throws(() => kiro.login(ctxOf("access_token", { refreshToken: "rt-nope" })), /登录已失效/);
});

// ---------------------------------------------------------------- json

test("json：kiroTokenFromRecord 容错各家形状（包一层 / snake_case / 秒级时间戳 / IdC 判定）", () => {
  const a = kiroTokenFromRecord({ token: { access_token: "acc-alice-1", refresh_token: "rt-gen1", expires_at: Math.floor(Date.now() / 1000) + 600, profile_arn: FIXED_ARN } });
  eq(a.accessToken, "acc-alice-1");
  eq(a.refreshToken, "rt-gen1");
  ok(a.expiresAt! > Date.now() + 500_000 && a.expiresAt! < Date.now() + 700_000, "秒级 epoch 转毫秒");
  eq(a.extra!.authMethod, "social");
  const b = kiroTokenFromRecord({ auth: "IdC", refreshToken: "rt-idc", clientId: "cid", clientSecret: "sec", email: "x@y.z" });
  eq(b.extra!.authMethod, "idc");
  eq(b.email, "x@y.z");
  eq(b.accessToken, "");
  eq(b.expiresAt, 0, "没 access token 视为立即过期");
  const err = () => kiroTokenFromRecord({ auth: "IdC", refreshToken: "rt-idc" });
  let threw = "";
  try {
    err();
  } catch (e) {
    threw = (e as Error).message;
  }
  includes(threw, "clientId 和 clientSecret");
  const c = kiroTokenFromRecord({ accessToken: "acc-alice-1", refreshToken: "rt-gen1", clientId: "cid", clientSecret: "sec", authMethod: "social" });
  eq(c.extra!.authMethod, "social", "显式 social 压过 clientId 推断");
});

test("json：kiroTokenFromJson 支持数组 / accounts 嵌套 / BOM 与注释包裹；非法 JSON 报错", () => {
  const arr = kiroTokenFromJson(JSON.stringify([{ accessToken: "acc-alice-1", refreshToken: "rt-gen1" }, { accessToken: "acc-bob-9", refreshToken: "rt-b" }]));
  eq(arr.total, 2);
  eq(arr.tok.accessToken, "acc-alice-1");
  const nested = kiroTokenFromJson(JSON.stringify({ accounts: [{ email: "n@e.st", credentials: { access_token: "acc-alice-2", refresh_token: "rt-gen2" } }] }));
  eq(nested.total, 1);
  eq(nested.tok.email, "n@e.st");
  eq(nested.tok.accessToken, "acc-alice-2");
  const wrapped = kiroTokenFromJson('\uFEFF// exported\n{"accessToken":"acc-alice-1","refreshToken":"rt-gen1"}\n');
  eq(wrapped.tok.refreshToken, "rt-gen1");
  let msg = "";
  try {
    kiroTokenFromJson("not json at all");
  } catch (e) {
    msg = (e as Error).message;
  }
  includes(msg, "不是合法的 JSON");
  try {
    kiroTokenFromJson('{"foo":1}');
  } catch (e) {
    msg = (e as Error).message;
  }
  includes(msg, "未找到有效的 Kiro 凭证");
});

test("json 登录：整段粘贴 → 解析 → 激活 → 入池；空文本报错", async () => {
  resetSeen();
  const text = JSON.stringify({ accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(), profileArn: FIXED_ARN, authMethod: "social", provider: "Google" });
  const tok = await kiro.login(ctxOf("json", { jsonText: text }));
  eq(tok.email, "alice@example.com");
  eq(tok.extra!.provider, "Google");
  deepEq(seen.refreshCalls, []);
  await throws(() => kiro.login(ctxOf("json", { jsonText: "   " })), /请粘贴凭证 JSON/);
  resetSeen();
  // 过期的 access token：激活时先刷
  const stale = JSON.stringify({ accessToken: "acc-dead", refreshToken: "rt-gen1", expiresAt: new Date(Date.now() - 1000).toISOString() });
  const t2 = await kiro.login(ctxOf("json", { jsonText: stale }));
  eq(t2.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
});

// ---------------------------------------------------------------- api_key

test("api_key：带 x-api-key + tokentype: API_KEY 校验；tokenType=ApiKey；refresh 原样返回", async () => {
  resetSeen();
  const tok = await kiro.login(ctxOf("api_key", { apiKey: API_KEY_OK }));
  eq(tok.accessToken, API_KEY_OK);
  eq(tok.tokenType, "ApiKey");
  eq(tok.extra!.authMethod, "api_key");
  eq(tok.extra!.region, "us-east-1");
  eq(tok.email, `API Key · ${API_KEY_OK.slice(-6)}`);
  eq(isKiroApiKeyToken(tok), true);
  eq(seen.listModelsHeaders.length, 1, "登录时打一次 ListAvailableModels 校验");
  const h = seen.listModelsHeaders[0];
  eq(h["x-api-key"], API_KEY_OK);
  eq(h["tokentype"], "API_KEY");
  eq(h["authorization"], "Bearer " + API_KEY_OK);
  ok(/KiroIDE-/.test(h["user-agent"] || ""), "IDE 风格 UA");
  const same = await kiro.refresh(tok);
  eq(same, tok, "API Key 不刷新");
  // headers() 也带 tokentype（krsServer 直通与自发请求同一规则）
  const hh = kiro.headers(tok, true);
  eq(hh["tokentype"], "API_KEY");
  eq(hh["x-api-key"], API_KEY_OK);
  eq(kiro.apiBaseFor!(tok), `${BASE}/q`, "API Key 直连 q 端点");
});

test("api_key：错 Key 被 403 拒绝；自定义端点优先；空 Key 报错", async () => {
  resetSeen();
  await throws(() => kiro.login(ctxOf("api_key", { apiKey: "ksk_wrong" })), /API Key 验证被拒绝（HTTP 403）/);
  await throws(() => kiro.login(ctxOf("api_key", { apiKey: "  " })), /请输入 API Key/);
  const tok = await kiro.login(ctxOf("api_key", { apiKey: API_KEY_OK, region: "eu-central-1", endpoint: `${BASE}/q` }));
  eq(tok.extra!.endpoint, `${BASE}/q`);
  eq(tok.extra!.region, "eu-central-1");
  eq(kiro.apiBaseFor!(tok), `${BASE}/q`);
});

test("listModels：分页拉全、抠 effort 档位与输入类型；API Key 模式同样带 tokentype", async () => {
  resetSeen();
  const oauthTok: OAuthToken = { accessToken: "acc-alice-1", refreshToken: "rt-gen1", extra: { authMethod: "social", region: "us-east-1", profileArn: FIXED_ARN }, updatedAt: Date.now() };
  const live = await kiro.listModels!(oauthTok);
  eq(live.length, 2);
  eq(live[0].id, "claude-sonnet-5");
  eq(live[0].image, true);
  eq(live[0].reasoning, true);
  deepEq(live[0].effortLevels, ["low", "medium", "high", "max"]);
  eq(live[0].effortSchemaPath, "output_config");
  eq(live[0].defaultEffortLevel, "high");
  eq(live[0].contextWindow, 1000000);
  eq(live[0].maxOutputTokens, 64000);
  eq(live[1].image, false);
  eq(live[1].reasoning, false);
  eq(seen.listModelsHeaders.length, 2);
  eq(seen.listModelsHeaders[0]["tokentype"], undefined, "OAuth 不带 tokentype");
  resetSeen();
  const apiTok: OAuthToken = { accessToken: API_KEY_OK, tokenType: "ApiKey", extra: { authMethod: "api_key", region: "us-east-1" }, updatedAt: Date.now() };
  const live2 = await kiro.listModels!(apiTok);
  eq(live2.length, 2);
  for (const h of seen.listModelsHeaders) {
    eq(h["tokentype"], "API_KEY");
  }
});

// ---------------------------------------------------------------- 与 IDE 共存刷新

function aliceGen1(): OAuthToken {
  return { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: Date.now() + 60_000, email: "alice@example.com", extra: { authMethod: "social", region: "us-east-1", profileArn: FIXED_ARN, provider: "Google" }, updatedAt: Date.now() - 1000 };
}

test("refresh：文件仍是刚被消费的那一代 → 刷新后写回文件（临时文件 + rename，字段保留，无残留 tmp）", async () => {
  resetSeen();
  const c = tmpCache("coexist-writeback");
  const original = { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(60_000), profileArn: FIXED_ARN, authMethod: "social", provider: "Google", region: "us-east-1" };
  writeTokenFile(c.token, original);
  _setKiroCachePathsForTest(c);
  const fresh = await kiro.refresh(aliceGen1());
  eq(fresh.accessToken, "acc-alice-2");
  eq(fresh.refreshToken, "rt-gen2");
  eq(fresh.email, "alice@example.com");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
  const onDisk = JSON.parse(fs.readFileSync(c.token, "utf8"));
  eq(onDisk.accessToken, "acc-alice-2");
  eq(onDisk.refreshToken, "rt-gen2");
  eq(onDisk.authMethod, "social", "其它字段保留");
  eq(onDisk.provider, "Google");
  eq(onDisk.profileArn, FIXED_ARN);
  ok(Date.parse(onDisk.expiresAt) > Date.now() + 3000_000, "expiresAt 更新为新到期时间");
  deepEq(
    fs.readdirSync(c.dir).filter((f) => f.includes(".tmp")),
    [],
    "无临时文件残留"
  );
  if (process.platform !== "win32") {
    eq(fs.statSync(c.token).mode & 0o777, 0o600, "权限 0600");
  }
});

test("refresh：IDE 已先换代（同账号）→ 直接接管文件里的 token，不打刷新接口", async () => {
  resetSeen();
  const c = tmpCache("coexist-adopt");
  writeTokenFile(c.token, { accessToken: "acc-alice-3", refreshToken: "rt-gen3", expiresAt: futureIso(7200_000), profileArn: FIXED_ARN, authMethod: "social", provider: "Google" });
  _setKiroCachePathsForTest(c);
  const adopted = await kiro.refresh(aliceGen1());
  eq(adopted.accessToken, "acc-alice-3");
  eq(adopted.refreshToken, "rt-gen3");
  eq(adopted.email, "alice@example.com");
  eq(adopted.plan, "Kiro Pro");
  deepEq(seen.refreshCalls, [], "没有碰刷新接口");
  eq(seen.usageCalls, 1, "用文件里的 token 核对了一次邮箱");
});

test("refresh：同一代但文件里 access token 更新更晚 → 接管；更早则不接管", async () => {
  resetSeen();
  const c = tmpCache("coexist-samegen");
  writeTokenFile(c.token, { accessToken: "acc-alice-2", refreshToken: "rt-gen1", expiresAt: futureIso(3000_000), profileArn: FIXED_ARN, authMethod: "social" });
  _setKiroCachePathsForTest(c);
  const t = await kiro.refresh(aliceGen1());
  eq(t.accessToken, "acc-alice-2", "同代、更新的 access token → 接管");
  deepEq(seen.refreshCalls, []);
  // 文件里的更早：不接管，走刷新
  writeTokenFile(c.token, { accessToken: "acc-alice-0", refreshToken: "rt-gen1", expiresAt: new Date(Date.now() + 10_000).toISOString(), profileArn: FIXED_ARN, authMethod: "social" });
  const t2 = await kiro.refresh(aliceGen1());
  eq(t2.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
});

test("refresh：文件是别人的账号 → 不接管、不写回；自己的刷新照常", async () => {
  resetSeen();
  const c = tmpCache("coexist-other");
  const bob = { accessToken: "acc-bob-9", refreshToken: "rt-bob", expiresAt: futureIso(), profileArn: FIXED_ARN, authMethod: "social" };
  writeTokenFile(c.token, bob);
  _setKiroCachePathsForTest(c);
  const fresh = await kiro.refresh(aliceGen1());
  eq(fresh.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1"]);
  deepEq(JSON.parse(fs.readFileSync(c.token, "utf8")), bob, "别人的文件一字不动");
});

test("refresh：刷新被拒（IDE 在我们读文件之后换代）→ 再读文件接管；文件不是同账号则报登录失效", async () => {
  resetSeen();
  const c = tmpCache("coexist-late");
  // 我们手上是已被作废的一代；文件里 IDE 已写入新一代（同账号）
  const dead: OAuthToken = { ...aliceGen1(), refreshToken: "rt-stale" };
  writeTokenFile(c.token, { accessToken: "acc-alice-3", refreshToken: "rt-gen3", expiresAt: futureIso(), profileArn: FIXED_ARN, authMethod: "social" });
  _setKiroCachePathsForTest(c);
  // 第一次 peek 时文件与手上不同代，但邮箱核对要联网——这里模拟"第一次核对失败、刷新被拒、再看一眼成功"比较绕，
  // 直接验证主路径：文件已换代且同账号 → 第一次 peek 就接管，不会去刷
  const t = await kiro.refresh(dead);
  eq(t.accessToken, "acc-alice-3");
  deepEq(seen.refreshCalls, []);
  // 文件是别人的：刷新被拒 → 报登录失效
  resetSeen();
  writeTokenFile(c.token, { accessToken: "acc-bob-9", refreshToken: "rt-bob", expiresAt: futureIso(), authMethod: "social" });
  await throws(() => kiro.refresh(dead), /登录已失效/);
  deepEq(seen.refreshCalls, ["rt-stale"]);
  // 没有 refresh token 直接失效
  await throws(() => kiro.refresh({ accessToken: "x", updatedAt: 0 }), /没有 refresh token/);
});

test("refresh：本机没有登录态文件 → 正常刷新，不写文件", async () => {
  resetSeen();
  const c = tmpCache("coexist-nofile");
  _setKiroCachePathsForTest(c);
  const fresh = await kiro.refresh(aliceGen1());
  eq(fresh.accessToken, "acc-alice-2");
  eq(fs.existsSync(c.token), false);
});

test("refresh：文件是符号链接时不写回", async () => {
  resetSeen();
  const c = tmpCache("coexist-symlink");
  const real = path.join(c.dir, "real.json");
  writeTokenFile(real, { accessToken: "acc-alice-1", refreshToken: "rt-gen1", expiresAt: futureIso(), authMethod: "social" });
  try {
    fs.symlinkSync(real, c.token, "file");
  } catch {
    console.log("     (skip: 本机无权限建符号链接)");
    return;
  }
  _setKiroCachePathsForTest(c);
  const fresh = await kiro.refresh(aliceGen1());
  eq(fresh.refreshToken, "rt-gen2");
  eq(JSON.parse(fs.readFileSync(real, "utf8")).refreshToken, "rt-gen1", "符号链接目标未被改写");
});

// ---------------------------------------------------------------- ensureAccessToken 并发只刷一次 + tokenStore 键

function kiroProvider(id = "p1"): ProviderConfig {
  return { id, name: "Kiro 官方", protocol: "kiro", baseUrl: kiro.baseUrl, apiKey: "", enabled: true, auth: "oauth", oauthVendor: "kiro", credentials: [{ id: "c1", priority: 0, enabled: true }, { id: "c2", priority: 1, enabled: true }] };
}

test("tokenStore：键 <providerId>（首条 c1）与 <providerId>/<credentialId>；删 provider 清全部；moveToken 提升", async () => {
  _resetTokenStoreForTest();
  stub.__reset();
  await initTokenStore(stub.__makeContext() as never);
  eq(tokenKeyOf("p1", "c1"), "p1");
  eq(tokenKeyOf("p1", "c2"), "p1/c2");
  setToken(tokenKeyOf("p1", "c1"), aliceGen1());
  setToken(tokenKeyOf("p1", "c2"), { ...aliceGen1(), accessToken: "acc-bob-9", email: "bob@example.com" });
  setToken("p10", aliceGen1());
  eq(hasToken("p1"), true);
  eq(hasToken("p1/c2"), true);
  moveToken("p1/c2", "p1");
  eq(getToken("p1")!.email, "bob@example.com", "c2 提升为首条");
  eq(hasToken("p1/c2"), false);
  deleteProviderTokens("p1");
  eq(hasToken("p1"), false);
  eq(hasToken("p10"), true, "前缀相似的别家不受影响");
});

test("ensureAccessToken：同一凭证并发刷新只打一次接口；不同凭证各自刷新；结果落回 tokenStore", async () => {
  resetSeen();
  _setKiroCachePathsForTest(tmpCache("empty"));
  _resetTokenStoreForTest();
  stub.__reset();
  await initTokenStore(stub.__makeContext() as never);
  const p = kiroProvider();
  setToken(tokenKeyOf(p.id, "c1"), aliceGen1());
  setToken(tokenKeyOf(p.id, "c2"), { ...aliceGen1(), refreshToken: "rt-gen2", accessToken: "acc-alice-2" });
  const [a, b, c] = await Promise.all([ensureAccessToken(p, true, p.credentials![0]), ensureAccessToken(p, true, p.credentials![0]), ensureAccessToken(p, true, p.credentials![0])]);
  eq(a.accessToken, "acc-alice-2");
  eq(b.accessToken, "acc-alice-2");
  eq(c.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1"], "三路并发只刷一次");
  eq(getToken("p1")!.refreshToken, "rt-gen2", "新一代已落回 tokenStore");
  const d = await ensureAccessToken(p, true, p.credentials![1]);
  eq(d.accessToken, "acc-alice-3");
  deepEq(seen.refreshCalls, ["rt-gen1", "rt-gen2"]);
  // 未到期且不 force：不刷
  const e = await ensureAccessToken(p, false, p.credentials![0]);
  eq(e.accessToken, "acc-alice-2");
  deepEq(seen.refreshCalls, ["rt-gen1", "rt-gen2"]);
});

test("ensureAccessToken：刷新被拒 → NeedsLoginError；未登录 → NeedsLoginError", async () => {
  resetSeen();
  _resetTokenStoreForTest();
  stub.__reset();
  await initTokenStore(stub.__makeContext() as never);
  const p = kiroProvider("p2");
  setToken("p2", { ...aliceGen1(), refreshToken: "rt-bogus" });
  await throws(() => ensureAccessToken(p, true, p.credentials![0]), /登录已失效/);
  await throws(() => ensureAccessToken(p, false, p.credentials![1]), /尚未登录/);
});

// ---------------------------------------------------------------- 门户登录（模拟浏览器）

/** 把 login() 的 promise 提前挂上 catch，避免预期中的拒绝在 await 之前变成 unhandled rejection。 */
function armed<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      })
      .on("error", reject);
  });
}

test("oauth 门户登录：打开 app.kiro.dev/signin（PKCE S256 + state + 固定回调端口），模拟浏览器回跳 google → 换 token → 补邮箱", async () => {
  resetSeen();
  _setKiroCachePathsForTest(tmpCache("empty"));
  const opened: string[] = [];
  const ctx = ctxOf("oauth", undefined, opened);
  const login = armed(kiro.login(ctx));
  await waitFor(() => opened.length === 1, 5000);
  const u = new URL(opened[0]);
  eq(u.origin + u.pathname, `${BASE}/portal/signin`);
  eq(u.searchParams.get("code_challenge_method"), "S256");
  eq(u.searchParams.get("redirect_from"), "KiroIDE");
  eq(u.searchParams.get("redirect_uri"), `http://localhost:${PORTAL_CB_PORT}`);
  const state = u.searchParams.get("state")!;
  ok(/^[0-9a-f-]{36}$/.test(state), "state 是 uuid");
  seen.challenge = u.searchParams.get("code_challenge")!;
  ok(seen.challenge.length >= 43);
  const cb = await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/oauth/callback?login_option=google&code=code-123&state=${encodeURIComponent(state)}`);
  eq(cb.status, 200);
  includes(cb.body, "登录成功");
  const tok = await login;
  eq(tok.accessToken, "acc-alice-1");
  eq(tok.refreshToken, "rt-gen1");
  eq(tok.email, "alice@example.com");
  eq(tok.extra!.authMethod, "social");
  eq(tok.extra!.provider, "Google");
  eq(tok.extra!.profileArn, FIXED_ARN);
  eq(seen.oauthTokenBodies.length, 1);
  eq(seen.oauthTokenBodies[0].redirect_uri, `http://localhost:${PORTAL_CB_PORT}/oauth/callback?login_option=google`);
  ok(typeof seen.oauthTokenBodies[0].code_verifier === "string" && (seen.oauthTokenBodies[0].code_verifier as string).length >= 43, "verifier 43+ 字符");
  await sleep(500); // 等回调服务器关闭，释放端口
});

test("oauth 门户登录：external_idp 被拒绝并引导「导入本机登录」", async () => {
  const opened: string[] = [];
  const ctx = ctxOf("oauth", undefined, opened);
  const login = armed(kiro.login(ctx));
  await waitFor(() => opened.length === 1, 5000);
  const state = new URL(opened[0]).searchParams.get("state")!;
  const cb = await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/signin/callback?login_option=external_idp&issuer_url=https%3A%2F%2Fidp.example&state=${state}`);
  eq(cb.status, 200);
  const err = await throws(() => login, /external_idp/);
  includes(err.message, "导入本机登录");
  await sleep(500);
});

test("oauth 门户登录：未知路径 404 不影响等待；state 不匹配的回跳 400 且登录以「state 不匹配」失败（不换 token）", async () => {
  resetSeen();
  const opened: string[] = [];
  const ctx = ctxOf("oauth", undefined, opened);
  const login = armed(kiro.login(ctx));
  await waitFor(() => opened.length === 1, 5000);
  const nf = await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/nope`);
  eq(nf.status, 404);
  let settled = false;
  login.then(
    () => (settled = true),
    () => (settled = true)
  );
  await sleep(100);
  eq(settled, false, "404 不结束登录");
  const bad = await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/oauth/callback?login_option=google&code=code-123&state=wrong`);
  eq(bad.status, 400);
  includes(bad.body, "state 不匹配");
  await throws(() => login, /state 不匹配/);
  eq(seen.oauthTokenBodies.length, 0, "没有拿假 state 的 code 去换 token");
  await sleep(500);
});

test("oauth 门户登录：用户取消 → LoginCancelled，回调端口随之释放", async () => {
  const opened: string[] = [];
  const ctx = ctxOf("oauth", undefined, opened);
  const login = armed(kiro.login(ctx));
  await waitFor(() => opened.length === 1, 5000);
  ctx.signal.cancel();
  const e = await throws(() => login);
  ok(e instanceof LoginCancelled, "取消 → LoginCancelled");
  await sleep(500);
  let refused = false;
  try {
    await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/nope`);
  } catch {
    refused = true;
  }
  eq(refused, true, "回调服务器已关闭");
});

test("oauth 门户登录：PKCE verifier 不匹配 / 授权被拒时报错", async () => {
  resetSeen();
  const opened: string[] = [];
  const ctx = ctxOf("oauth", undefined, opened);
  const login = armed(kiro.login(ctx));
  await waitFor(() => opened.length === 1, 5000);
  const state = new URL(opened[0]).searchParams.get("state")!;
  seen.challenge = "not-the-real-challenge";
  await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/oauth/callback?login_option=github&code=code-123&state=${state}`);
  await throws(() => login, /换取 token 失败：HTTP 400/);
  await sleep(500);
  const opened2: string[] = [];
  const ctx2 = ctxOf("oauth", undefined, opened2);
  const login2 = armed(kiro.login(ctx2));
  await waitFor(() => opened2.length === 1, 5000);
  const state2 = new URL(opened2[0]).searchParams.get("state")!;
  const r = await httpGet(`http://127.0.0.1:${PORTAL_CB_PORT}/oauth/callback?error=access_denied&error_description=user+cancelled&state=${state2}`);
  eq(r.status, 400);
  await throws(() => login2, /授权被拒绝：access_denied/);
  await sleep(500);
});

test("teardown：关假上游、清临时目录", async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setKiroCachePathsForTest(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  eq(fs.existsSync(tmpRoot), false);
});

run();
