/**
 * 日志脱敏（src/log.ts）：Key / token 在所有输出路径都不得以明文出现——
 * OutputChannel 行、console 镜像、对象字段（含嵌套与请求头）、Error 对象、字符串里的 URL 查询串与 Bearer。
 * 以及 maskKey 的既有行为。
 */
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { debug, error, info, initLog, maskKey } from "../src/log";
import { check, eq, finish, test } from "./lib/harness";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext; __outputLines(): string[]; __clearOutput(): void; __setConfig(k: string, v: unknown): void };
const stub = vscode as unknown as Stub;

const SECRETS = {
  sk: "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  skAnt: "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210",
  ksk: "ksk_KIROAPIKEY1234567890abcdef",
  aiza: "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
  bearer: "oauth-access-token-0123456789abcdefghij",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU",
  refresh: "rt-REFRESHTOKEN-abcdefghijklmnopqrstuvwxyz",
  secret: "client-secret-QWERTYUIOPASDFGHJKL",
  cookie: "session=SESSIONCOOKIE1234567890",
};

const consoleLines: string[] = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...a: unknown[]) => consoleLines.push(a.map(String).join(" "));
console.error = (...a: unknown[]) => consoleLines.push(a.map(String).join(" "));

function allOutput(): string {
  return stub.__outputLines().join("\n") + "\n" + consoleLines.join("\n");
}
function leaks(): string[] {
  const out = allOutput();
  return Object.entries(SECRETS)
    .filter(([, v]) => out.includes(v))
    .map(([k]) => k);
}
function reset(): void {
  stub.__clearOutput();
  consoleLines.length = 0;
}

(async () => {
  initConfig(stub.__makeContext());
  stub.__setConfig("debug", true);
  initLog();

  await test("maskKey：既有行为不变", () => {
    eq("空 → 空", maskKey(""), "");
    eq("≤4 → ****", maskKey("abcd"), "****");
    eq("≤8 → 2+****+2", maskKey("abcdefgh"), "ab****gh");
    eq(">8 → 4+****+4", maskKey("sk-1234567890"), "sk-1****7890");
  });

  await test("对象字段：apiKey / Authorization / x-api-key / token 系 / secret / cookie（含嵌套与数组）", () => {
    reset();
    info("upstream request", {
      apiKey: SECRETS.sk,
      headers: { Authorization: "Bearer " + SECRETS.bearer, "x-api-key": SECRETS.skAnt, "x-goog-api-key": SECRETS.aiza, cookie: SECRETS.cookie, tokentype: "API_KEY" },
      nested: { refresh_token: SECRETS.refresh, client_secret: SECRETS.secret, list: [{ accessToken: SECRETS.jwt }] },
      model: "claude-sonnet-5",
    });
    const out = allOutput();
    eq("无明文泄露", leaks().join(","), "");
    check("apiKey 打码形态", out.includes(`"apiKey":"${maskKey(SECRETS.sk)}"`), out);
    check("非敏感字段原样", out.includes('"model":"claude-sonnet-5"'), out);
    const mirrored = consoleLines.filter((l) => l.startsWith("[API4Kiro]"));
    check("console 镜像恰一行、同样打码", mirrored.length === 1 && !mirrored[0].includes(SECRETS.sk) && mirrored[0].includes(maskKey(SECRETS.sk)), mirrored);
  });

  await test("Error 对象：message 保留、内含密钥打码，而不是 {}", () => {
    reset();
    error("upstream fetch failed:", new Error(`connect to https://relay.example/v1/models?api_key=${SECRETS.sk} refused`));
    const out = allOutput();
    check("Error 的 message 进日志（不是 {}）", out.includes("connect to https://relay.example/v1/models?api_key=") && !out.includes("{}"), out);
    check("Error 名字保留", out.includes("Error:"), out);
    eq("URL 查询串里的 key 打码", leaks().join(","), "");
  });

  await test("字符串参数：URL 查询串（key/token/api_key/client_secret/code）、Bearer、已知 Key 形态、JWT", () => {
    reset();
    info(`GET https://generativelanguage.googleapis.com/v1beta/models?key=${SECRETS.aiza}&pageSize=50`);
    info(`refresh → https://auth.example/token?grant_type=refresh_token&refresh_token=${SECRETS.refresh}&client_secret=${SECRETS.secret}`);
    info(`headers: authorization=Bearer ${SECRETS.bearer}; x-api-key=${SECRETS.skAnt}`);
    error("upstream 401:", `{"error":{"message":"Invalid API key provided: ${SECRETS.sk}. Check ${SECRETS.ksk} too"}}`);
    debug("jwt seen", SECRETS.jwt);
    const out = allOutput();
    eq("五类字符串均无明文", leaks().join(","), "");
    check("查询串其它参数保留", out.includes("pageSize=50") && out.includes("grant_type=refresh_token"), out);
    check("Bearer 字样保留、值打码", /Bearer\s+oaut\*{4}ghij/.test(out), out);
    check("错误体里的 Key 打码但上下文保留", out.includes("Invalid API key provided: sk-l****6789"), out);
  });

  await test("不过度脱敏：普通词、模型 id、无密钥的 URL、短值", () => {
    reset();
    info("model=gpt-5 conv=abc token usage in=120 out=7 key=short", { model: "deepseek-v4-pro", key: "ab", tokenCount: 12, url: "https://api.x.ai/v1/models" });
    const out = allOutput();
    check("模型 id 原样", out.includes("model=gpt-5") && out.includes('"model":"deepseek-v4-pro"'), out);
    check("token usage 字样不动", out.includes("token usage in=120 out=7"), out);
    check("无密钥 URL 原样", out.includes("https://api.x.ai/v1/models"), out);
    check("数字字段不动", out.includes('"tokenCount":12'), out);
    check("URL 之外的裸 key=… 不当密钥（避免把 sticky key=c1 之类遮掉）", out.includes("key=short"), out);
    check("对象里 key:ab 打码为 ****", out.includes('"key":"****"'), out);
  });

  await test("debug 关闭时不输出；开启时输出且打码", () => {
    reset();
    stub.__setConfig("debug", false);
    debug("should not appear", { apiKey: SECRETS.sk });
    eq("关闭 → 无输出", stub.__outputLines().length, 0);
    stub.__setConfig("debug", true);
    debug("appears", { apiKey: SECRETS.sk });
    eq("开启 → 一行", stub.__outputLines().length, 1);
    eq("开启 → 打码", leaks().join(","), "");
  });

  console.log = origLog;
  console.error = origErr;
  finish();
})();
