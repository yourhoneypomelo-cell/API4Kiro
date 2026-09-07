/**
 * sqliteReader（零依赖只读解析：varint、溢出页、多层 B-tree、serial type）与 ccSwitchImport（7 种 app_type、去重、只读）。
 * 用 Node 内建 node:sqlite 造一个真实的 cc-switch 形状的库到临时目录；不碰 ~/.cc-switch。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, run, eq, ok, deepEq, includes } from "./harness";
import { columnsFromCreateSql, readTable } from "../../src/sqliteReader";
import { candidateToProvider, readCcSwitchRows, scanCcSwitch, tomlSections } from "../../src/ccSwitchImport";
import { maskKey } from "../../src/log";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlite = require("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void } };

let dir = "";
let dbPath = "";
const BIG = "X".repeat(20_000); // 远超 4096 页大小 → 溢出页链

const CODEX_TOML = `model_provider = "myrelay"
model = "gpt-5.4"
[model_providers.myrelay]
name = "My Relay"
base_url = "https://relay.example.com/v1"
wire_api = "chat"
`;

function settings(app: string, i: number): Record<string, unknown> {
  switch (app) {
    case "claude":
      return { env: { ANTHROPIC_BASE_URL: "https://claude-relay.example/v1/messages", ANTHROPIC_AUTH_TOKEN: "sk-claude-" + i, ANTHROPIC_MODEL: "claude-opus-4-8[1M]", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5" } };
    case "claude-desktop":
      return { env: { ANTHROPIC_BASE_URL: "https://claude-relay.example", ANTHROPIC_API_KEY: "sk-claude-" + i, ANTHROPIC_MODEL: "claude-sonnet-4-6" } };
    case "codex":
      return { auth: { OPENAI_API_KEY: "sk-codex-" + i }, config: CODEX_TOML, modelCatalog: { models: [{ model: "gpt-5.4" }, { model: "gpt-5.4-mini" }] } };
    case "gemini":
      return { env: { GEMINI_API_KEY: "AIza-" + i, GOOGLE_GEMINI_BASE_URL: "https://gem.example", GEMINI_MODEL: "gemini-3-pro" } };
    case "opencode":
      return { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://oc.example/v1", apiKey: "oc-" + i }, models: { "m-one": {}, "m-two": {} } };
    case "hermes":
      return { base_url: "https://hermes.example/v1", api_key: "hm-" + i, api_mode: "anthropic_messages", models: [{ id: "h-1" }, "h-2"] };
    case "grokbuild":
      return { config: `[api]\nbase_url = "https://grok-relay.example/v1"\napi_key = "gk-${i}"\n[models]\ndefault = "grok-4"\n` };
    default:
      return {};
  }
}

test("setup：用 node:sqlite 造 cc-switch 形状的库（含溢出页、多层 B-tree、各种整数）", () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-sqlite-test-"));
  dbPath = path.join(dir, "cc-switch.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    sort_index INTEGER,
    created_at INTEGER,
    score REAL,
    blob_col BLOB,
    UNIQUE(app_type, name),
    CHECK (is_current IN (0, 1))
  )`);
  db.exec(`CREATE TABLE usage_noise (id INTEGER PRIMARY KEY, payload TEXT)`);
  const ins = db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index, created_at, score, blob_col) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const apps = ["claude", "claude-desktop", "codex", "gemini", "opencode", "hermes", "grokbuild"];
  apps.forEach((app, i) => {
    ins.run(`${app}-1`, app, `${app} 主`, JSON.stringify(settings(app, 1)), i === 0 ? 1 : 0, i, 1_700_000_000_000 + i, 0.5 + i, new Uint8Array([1, 2, 3]));
  });
  // 同地址同 key 的重复条目（claude 里再来一份）→ 应合并进同一候选
  ins.run("claude-dup", "claude", "claude 重复", JSON.stringify(settings("claude", 1)), 0, 100, null, null, null);
  // 巨大的 settings（溢出页）
  ins.run("claude-big", "claude", "claude 大", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://big.example", ANTHROPIC_AUTH_TOKEN: "sk-big", NOTE: BIG } }), 0, 101, -1, -2.5, null);
  // 没 key 的（官方登录）→ skipped
  ins.run("claude-nokey", "claude", "claude 官方", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }), 0, 102, null, null, null);
  // 模板占位符 key → skipped
  ins.run("oc-tpl", "opencode", "oc 模板", JSON.stringify({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x.example", apiKey: "${KEY}" } }), 0, 103, null, null, null);
  // 未知类型 → skipped
  ins.run("weird-1", "weirdapp", "未知", JSON.stringify({ a: 1 }), 0, 104, null, null, null);
  // 很多行让 B-tree 长出内部页；用不同 app_type 的 key 撑大 rowid / varint
  const noise = db.prepare(`INSERT INTO usage_noise (id, payload) VALUES (?, ?)`);
  for (let i = 0; i < 400; i++) {
    ins.run(`gemini-n${i}`, "gemini", `gemini #${i}`, JSON.stringify({ env: { GEMINI_API_KEY: "AIza-n" + i, GOOGLE_GEMINI_BASE_URL: "https://gem.example/n" + i } }), 0, 1000 + i, 2 ** 40 + i, i / 7, null);
    noise.run(1_000_000 + i, "noise-" + i);
  }
  db.close();
  ok(fs.statSync(dbPath).size > 100_000, "库不止一页");
});

test("columnsFromCreateSql：按顶层逗号切、跳过表级约束、认引号列名", () => {
  deepEq(columnsFromCreateSql(`CREATE TABLE t (a TEXT, "b c" INTEGER, [d] REAL DEFAULT (1+2), \`e\` BLOB, PRIMARY KEY (a), UNIQUE(b c), CHECK (a IN ('x','y')), FOREIGN KEY (d) REFERENCES z(id), CONSTRAINT k UNIQUE (e))`), ["a", "b c", "d", "e"]);
  deepEq(columnsFromCreateSql("nonsense"), []);
});

test("readTable：读回全部行；INTEGER PRIMARY KEY 走 rowid；负数 / 大整数 / REAL / BLOB / NULL / 溢出页正文完整", () => {
  const rows = readTable(dbPath, "providers")!;
  ok(rows, "providers 表存在");
  eq(rows.length, 7 + 5 + 400);
  const big = rows.find((r) => r.id === "claude-big")!;
  const cfg = JSON.parse(String(big.settings_config));
  eq(cfg.env.NOTE.length, 20_000, "溢出页拼接完整");
  eq(cfg.env.NOTE, BIG);
  eq(big.created_at, -1, "负数补符号位");
  eq(big.score, -2.5);
  eq(big.blob_col, null);
  const first = rows.find((r) => r.id === "claude-1")!;
  eq(first.is_current, 1);
  eq(first.created_at, 1_700_000_000_000, "6 字节整数");
  eq(first.score, 0.5);
  ok(first.blob_col instanceof Uint8Array && (first.blob_col as Uint8Array).length === 3, "BLOB");
  const n399 = rows.find((r) => r.id === "gemini-n399")!;
  eq(n399.created_at, 2 ** 40 + 399);
  eq(n399.sort_index, 1399);
  const noise = readTable(dbPath, "usage_noise")!;
  eq(noise.length, 400);
  eq(noise[0].id, null, "INTEGER PRIMARY KEY 在记录里存 NULL");
  eq(noise[0].__rowid, 1_000_000, "真值在 rowid（3 字节 varint）");
  eq(noise[399].__rowid, 1_000_399);
  eq(readTable(dbPath, "no_such_table"), undefined);
  eq(readTable(dbPath, "PROVIDERS")!.length, rows.length, "表名忽略大小写");
});

test("readTable：不是 SQLite 文件报错；只读打开（读后文件 mtime / 内容不变）", () => {
  const junk = path.join(dir, "junk.db");
  fs.writeFileSync(junk, "hello world, not a database at all, padding padding padding padding padding padding padding padding");
  let msg = "";
  try {
    readTable(junk, "x");
  } catch (e) {
    msg = (e as Error).message;
  }
  includes(msg, "不是 SQLite");
  const before = fs.readFileSync(dbPath);
  const mtime = fs.statSync(dbPath).mtimeMs;
  readTable(dbPath, "providers");
  scanCcSwitch(dbPath, []);
  eq(fs.statSync(dbPath).mtimeMs, mtime);
  ok(before.equals(fs.readFileSync(dbPath)), "内容逐字节不变");
  deepEq(fs.readdirSync(dir).filter((f) => f !== "cc-switch.db" && f !== "junk.db"), [], "没有生成 -journal / -wal 等副产物");
});

test("readCcSwitchRows：按 sort_index 排序、settings_config 解成对象、is_current", () => {
  const rows = readCcSwitchRows(dbPath);
  eq(rows[0].id, "claude-1");
  eq(rows[0].isCurrent, true);
  eq(rows[0].appType, "claude");
  eq(typeof rows[0].settings, "object");
  eq(rows[1].appType, "claude-desktop");
  ok(rows.every((r, i) => i === 0 || rows[i - 1].sortIndex <= r.sortIndex));
});

test("tomlSections：段名、带引号段名、注释、转义引号", () => {
  const t = tomlSections(`# top\nmodel = "a" # trailing\n[model_providers."my.relay"]\nbase_url = 'https://x'\nname = "q\\"uote"\n[[arr]]\nk = v1\n`);
  eq(t.top.model, "a");
  eq(t.sections["model_providers.my.relay"].base_url, "https://x");
  eq(t.sections["model_providers.my.relay"].name, 'q"uote');
  eq(t.sections.arr.k, "v1");
});

test("scanCcSwitch：7 种 app_type 各自解析正确；同地址同 key 合并；无 key / 占位符 / 未知类型进 skipped；与已连接的标 existsAs", () => {
  const existing = [{ id: "p9", name: "已有 Gemini", protocol: "gemini" as const, baseUrl: "https://gem.example/v1beta", apiKey: "AIza-1", enabled: true }];
  const scan = scanCcSwitch(dbPath, existing);
  eq(scan.path, dbPath);
  const byName = new Map(scan.candidates.map((c) => [c.name, c]));

  const claude = byName.get("claude 主")!;
  eq(claude.protocol, "anthropic");
  eq(claude.anthropicMode, "kiro", "第三方中转 → 深度兼容");
  eq(claude.baseUrl, "https://claude-relay.example", "剥掉 /v1/messages 尾巴");
  eq(claude.apiKey, "sk-claude-1");
  deepEq(claude.models, ["claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-6"], "去 [1M] 标记；合并条目的模型取并集");
  deepEq(claude.sources.sort(), ["claude", "claude-desktop"], "claude-desktop 同地址同 key 合并进来");
  ok(!byName.has("claude 重复"), "重复条目已合并");

  const codex = byName.get("codex 主")!;
  eq(codex.protocol, "openai");
  eq(codex.openaiApi, "chat", "wire_api=chat");
  eq(codex.baseUrl, "https://relay.example.com/v1");
  eq(codex.exactBase, true);
  eq(codex.apiKey, "sk-codex-1");
  deepEq(codex.models, ["gpt-5.4", "gpt-5.4-mini"]);

  const gem = byName.get("gemini 主")!;
  eq(gem.protocol, "gemini");
  eq(gem.baseUrl, "https://gem.example/v1beta", "自动补 /v1beta");
  deepEq(gem.models, ["gemini-3-pro"]);
  eq(gem.existsAs, "已有 Gemini", "同地址同 key 的已连接 provider");

  const oc = byName.get("opencode 主")!;
  eq(oc.protocol, "openai");
  eq(oc.baseUrl, "https://oc.example/v1");
  deepEq(oc.models, ["m-one", "m-two"]);

  const hm = byName.get("hermes 主")!;
  eq(hm.protocol, "anthropic");
  deepEq(hm.models, ["h-1", "h-2"]);

  const gk = byName.get("grokbuild 主")!;
  eq(gk.protocol, "openai");
  eq(gk.openaiApi, "responses");
  eq(gk.baseUrl, "https://grok-relay.example/v1");
  eq(gk.apiKey, "gk-1");
  deepEq(gk.models, ["grok-4"]);

  const big = byName.get("claude 大")!;
  eq(big.apiKey, "sk-big");

  const skippedNames = scan.skipped.map((s) => `${s.source}:${s.name}`);
  ok(skippedNames.includes("claude:claude 官方"), "无 key");
  ok(skippedNames.includes("opencode:oc 模板"), "占位符 key");
  ok(skippedNames.includes("weirdapp:未知"), "未知类型");
  includes(scan.skipped.find((s) => s.name === "claude 官方")!.reason, "没有 API Key");
  eq(scan.candidates.length, 7 + 400, "7 家 + 400 条噪音 gemini（地址各不同）");
  eq(new Set(scan.candidates.map((c) => c.idx)).size, scan.candidates.length, "idx 唯一");
});

test("candidateToProvider：有 key 有地址即启用、模型直接进 enabledModels、同名加序号；Key 打码规则", () => {
  const scan = scanCcSwitch(dbPath, []);
  const c = scan.candidates.find((x) => x.name === "codex 主")!;
  const names = new Set(["codex 主"]);
  const p = candidateToProvider(c, "p7", names);
  eq(p.id, "p7");
  eq(p.name, "codex 主 2", "同名加序号");
  eq(p.enabled, true);
  eq(p.openaiApi, "chat");
  eq(p.exactBase, true);
  deepEq(p.enabledModels, ["gpt-5.4", "gpt-5.4-mini"]);
  ok(names.has("codex 主 2"));
  eq(maskKey("sk-codex-1"), "sk-c****ex-1");
  eq(maskKey("abcdefg"), "ab****fg");
  eq(maskKey("abc"), "****");
  eq(maskKey(""), "");
  ok(!maskKey("sk-codex-1").includes("codex"), "中段被抹");
});

test("teardown", () => {
  fs.rmSync(dir, { recursive: true, force: true });
});

run();
