/**
 * cc-switch 只读导入（src/ccSwitchImport.ts + src/sqliteReader.ts）：用合成 SQLite 文件（rowid 表、多叶 + 内部页、溢出页链）
 * 与 v2 config.json 验证七种 app_type 的解析、去重合并、与已连接 provider 的重复标记、Key 只留扩展侧。
 * 不读用户真实的 ~/.cc-switch。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { candidateToProvider, readCcSwitchRows, scanCcSwitch, tomlSections } from "../src/ccSwitchImport";
import { ProviderConfig } from "../src/providers";
import { columnsFromCreateSql, readTable } from "../src/sqliteReader";
import { check, deepEq, eq, finish, includes, rmrf, test, throws, tmpDir } from "./lib/harness";
import { SynthValue, writeSqlite } from "./lib/sqliteSynth";

type Stub = typeof vscode & { __makeContext(): vscode.ExtensionContext };
const stub = vscode as unknown as Stub;

const CREATE_PROVIDERS = `CREATE TABLE "providers" (
  id TEXT PRIMARY KEY,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  category TEXT,
  created_at INTEGER,
  sort_index INTEGER,
  notes TEXT,
  is_current INTEGER DEFAULT 0 CHECK (is_current IN (0, 1)),
  UNIQUE (app_type, name)
)`;

const HUGE = "x".repeat(9000);

function row(id: string, app: string, name: string, settings: unknown, sort: number, extra: { notes?: string; current?: number } = {}): SynthValue[] {
  return [id, app, name, JSON.stringify(settings), null, null, 1700000000, sort, extra.notes ?? null, extra.current ?? 0];
}

const ROWS: SynthValue[][] = [
  row("a1", "claude", "Relay A", { env: { ANTHROPIC_BASE_URL: "https://relay-a.example/v1/messages", ANTHROPIC_AUTH_TOKEN: "sk-relay-a-KEY", ANTHROPIC_MODEL: "claude-sonnet-4-5[1M]", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-1" } }, 1, { current: 1 }),
  row("a2", "claude-desktop", "Relay A desktop", { env: { ANTHROPIC_BASE_URL: "https://relay-a.example/", ANTHROPIC_API_KEY: "sk-relay-a-KEY", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-max" } }, 2),
  row("a3", "claude", "Official login", { env: { ANTHROPIC_MODEL: "claude-opus-4-1" } }, 3),
  row("a4", "claude", "Template", { env: { ANTHROPIC_BASE_URL: "https://t.example", ANTHROPIC_AUTH_TOKEN: "${ANTHROPIC_KEY}" } }, 4),
  row("c1", "codex", "Codex Relay", { auth: { OPENAI_API_KEY: "sk-codex-KEY" }, config: 'model_provider = "myrelay"\nmodel = "gpt-5"\n\n[model_providers.myrelay]\nname = "relay" # comment\nbase_url = "https://relay-b.example/v1/"\nwire_api = "chat"\n', modelCatalog: { models: [{ model: "gpt-5-codex" }, { model: "gpt-5" }] } }, 5),
  row("c2", "codex", "Codex official", { auth: {}, config: 'model = "gpt-5"\n' }, 6),
  row("g1", "gemini", "Gem", { env: { GEMINI_API_KEY: "AIza-fake-gem", GOOGLE_GEMINI_BASE_URL: "https://gem.example", GEMINI_MODEL: "gemini-2.5-pro" } }, 7),
  row("o1", "opencode", "OC", { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://oc.example/v1", apiKey: "sk-oc" }, models: { m1: {}, m2: {} } }, 8),
  row("o2", "opencode", "OC bedrock", { npm: "@ai-sdk/amazon-bedrock", options: { apiKey: "x" } }, 9),
  row("h1", "hermes", "Herm", { base_url: "https://herm.example", api_key: "sk-herm", api_mode: "anthropic_messages", models: [{ id: "h1" }, "h2"] }, 10),
  row("k1", "grokbuild", "Grok official", { config: '[api]\nmodel = "grok-4"\n' }, 11),
  row("k2", "grokbuild", "Grok relay", { config: '[api]\nbase_url = "https://grok-relay.example/v1"\napi_key = "xai-fake"\n[models]\ndefault = "grok-4"\n' }, 12),
  row("z1", "claude", "Huge", { env: { ANTHROPIC_BASE_URL: "https://huge.example", ANTHROPIC_AUTH_TOKEN: "sk-huge" } }, 13, { notes: HUGE }),
  row("u1", "cursor", "Cursor thing", { anything: 1 }, 14),
  row("e1", "claude", "", {}, 15),
  row("c3", "codex", "Relay A", { auth: { OPENAI_API_KEY: "sk-relay-a-KEY" }, config: 'model_provider = "ra"\n[model_providers.ra]\nbase_url = "https://relay-a.example/v1"\nwire_api = "responses"\n' }, 16),
];

(async () => {
  initConfig(stub.__makeContext());
  const dir = tmpDir("a2kd-ccswitch-");
  const db = path.join(dir, "cc-switch.db");
  const dbSplit = path.join(dir, "cc-switch-split.db");
  writeSqlite(db, [
    { name: "providers", createSql: CREATE_PROVIDERS, rows: ROWS },
    { name: "usage_logs", createSql: "CREATE TABLE usage_logs (id INTEGER PRIMARY KEY, payload TEXT)", rows: Array.from({ length: 40 }, (_, i) => [null, `log-${i}-` + "y".repeat(500)]) },
  ]);
  const split = writeSqlite(dbSplit, [{ name: "providers", createSql: CREATE_PROVIDERS, rows: ROWS, maxRowsPerLeaf: 3 }]);

  await test("sqliteReader：读表、列名对齐、溢出页拼接、内部页遍历、类型还原", () => {
    const rows = readTable(db, "providers")!;
    eq("行数", rows.length, ROWS.length);
    eq("列名对齐：app_type", rows[0].app_type, "claude");
    eq("表名大小写不敏感", readTable(db, "PROVIDERS")!.length, ROWS.length);
    eq("不存在的表 → undefined", readTable(db, "nope"), undefined);
    const huge = rows.find((r) => r.id === "z1")!;
    eq("溢出页拼接：9000 字符完整", (huge.notes as string).length, 9000);
    eq("溢出页内容正确", huge.notes, HUGE);
    eq("整数还原", rows[0].created_at, 1700000000);
    eq("0/1 特殊 serial type", rows[0].is_current, 1);
    eq("NULL", rows[0].website_url, null);
    eq("__rowid", rows[0].__rowid, 1);
    const logs = readTable(db, "usage_logs")!;
    eq("第二张表（多叶）行数", logs.length, 40);
    eq("多叶顺序", logs[39].payload, `log-39-` + "y".repeat(500));
    check("拆叶后文件含内部页（页数更多）", split.pages > 3, split.pages);
    const rows2 = readTable(dbSplit, "providers")!;
    deepEq("内部页 + 多叶 → 行序与内容一致", rows2.map((r) => r.id), ROWS.map((r) => r[0]));
    eq("多叶下溢出页仍完整", (rows2.find((r) => r.id === "z1")!.notes as string).length, 9000);
    const junk = path.join(dir, "junk.db");
    fs.writeFileSync(junk, "not a sqlite file at all, just text padding padding padding padding padding padding padding padding padding");
    throws("非 SQLite 文件 → 明确报错", () => readTable(junk, "providers"), "不是 SQLite 数据库文件");
  });

  await test("columnsFromCreateSql / tomlSections", () => {
    deepEq("列名（跳过 UNIQUE 表约束、CHECK 里的括号不干扰）", columnsFromCreateSql(CREATE_PROVIDERS), ["id", "app_type", "name", "settings_config", "website_url", "category", "created_at", "sort_index", "notes", "is_current"]);
    deepEq("反引号 / 方括号 / 双引号标识符", columnsFromCreateSql('create table t (`a` int, [b c] text, "d" blob, e, PRIMARY KEY (a), FOREIGN KEY (e) REFERENCES x(id))'), ["a", "b c", "d", "e"]);
    deepEq("无括号 → 空", columnsFromCreateSql("CREATE TABLE x"), []);
    const t = tomlSections('top = "v" # c\n# comment\n[model_providers."my.relay"]\nbase_url = "https://x/\\"q\\""\nwire_api = \'chat\'\n[[arr]]\nk = 1\n[b]\nn = 42 # trailing\n');
    eq("顶层", t.top.top, "v");
    eq("带点引号段名归一", t.sections["model_providers.my.relay"].base_url, 'https://x/"q"');
    eq("单引号值", t.sections["model_providers.my.relay"].wire_api, "chat");
    eq("[[数组表]] 也当段", t.sections.arr.k, "1");
    eq("裸值去尾注释", t.sections.b.n, "42");
  });

  await test("scanCcSwitch：七类解析、跳过原因、同址同 Key 合并、同名不同接口加后缀、与已连接重复标记", () => {
    const existing: ProviderConfig[] = [{ id: "p9", name: "我的 Relay A", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "https://relay-a.example", apiKey: "sk-relay-a-KEY", enabled: true }];
    const r = scanCcSwitch(db, existing);
    eq("path 回传", r.path, db);
    const byName = new Map(r.candidates.map((c) => [c.name, c]));
    const relayA = byName.get("Relay A")!;
    check("Relay A 存在", !!relayA);
    eq("BASE_URL 剥掉 /v1/messages", relayA.baseUrl, "https://relay-a.example");
    eq("Anthropic 中转 → kiro 模式", relayA.anthropicMode, "kiro");
    eq("exactBase=false（走启发式）", relayA.exactBase, false);
    deepEq("claude + claude-desktop 同址同 Key 合并来源", relayA.sources, ["claude", "claude-desktop"]);
    deepEq("模型并集、去 [1M] 标记、去 -max 档位、去重", relayA.models, ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]);
    eq("与已连接 provider 同址同 Key → existsAs", relayA.existsAs, "我的 Relay A");
    eq("明文 Key 只在候选对象里（扩展侧）", relayA.apiKey, "sk-relay-a-KEY");
    const relayACodex = byName.get("Relay A (Codex)")!;
    check("同名不同接口 → 单独一条并带来源后缀", !!relayACodex && relayACodex.protocol === "openai" && relayACodex.openaiApi === "responses", relayACodex);
    eq("Codex 的同址同 Key 不与 Anthropic 那条合并", relayACodex.sources.join(","), "codex");
    const codex = byName.get("Codex Relay")!;
    check("codex：base_url 来自 model_provider 指向的段、去尾斜杠、exactBase", codex.baseUrl === "https://relay-b.example/v1" && codex.exactBase === true, codex);
    eq("codex：wire_api=chat", codex.openaiApi, "chat");
    deepEq("codex：模型 = top.model + modelCatalog", codex.models, ["gpt-5", "gpt-5-codex"]);
    eq("codex：Key", codex.apiKey, "sk-codex-KEY");
    const gem = byName.get("Gem")!;
    check("gemini：补 /v1beta、exactBase", gem.baseUrl === "https://gem.example/v1beta" && gem.protocol === "gemini" && gem.exactBase === true, gem);
    deepEq("gemini：模型", gem.models, ["gemini-2.5-pro"]);
    const oc = byName.get("OC")!;
    check("opencode：npm → openai chat，models 键为 id", oc.protocol === "openai" && oc.openaiApi === "chat" && oc.models.join(",") === "m1,m2" && oc.baseUrl === "https://oc.example/v1", oc);
    const herm = byName.get("Herm")!;
    check("hermes：api_mode anthropic → anthropic kiro；models 混合对象/字符串", herm.protocol === "anthropic" && herm.anthropicMode === "kiro" && herm.models.join(",") === "h1,h2", herm);
    const grok = byName.get("Grok relay")!;
    check("grokbuild：有 base_url+api_key → openai responses exactBase", grok.protocol === "openai" && grok.openaiApi === "responses" && grok.exactBase === true && grok.models.join(",") === "grok-4", grok);
    const huge = byName.get("Huge")!;
    check("溢出页那行也正常导入", !!huge && huge.apiKey === "sk-huge");
    check("空壳行不出现在候选也不在跳过里", !byName.has("") && !r.skipped.some((s) => s.name === "(未命名)"), r.skipped);
    const skipped = new Map(r.skipped.map((s) => [s.name, s.reason]));
    includes("官方登录 → 没有 API Key", skipped.get("Official login"), "没有 API Key");
    includes("模板占位符", skipped.get("Template"), "模板占位符");
    includes("Codex 官方登录", skipped.get("Codex official"), "官方 ChatGPT 登录");
    includes("Bedrock SDK", skipped.get("OC bedrock"), "不是填 key 即用");
    includes("Grok 官方", skipped.get("Grok official"), "xAI 账号登录");
    includes("未知类型", skipped.get("Cursor thing"), "不认识的类型 cursor");
    eq("候选总数", r.candidates.length, 8);
    eq("跳过总数", r.skipped.length, 6);
    check("idx 连续", r.candidates.every((c, i) => c.idx === i));
    check("候选按 sort_index 顺序", r.candidates[0].name === "Relay A" && r.candidates[1].name === "Codex Relay");
  });

  await test("candidateToProvider：命名去重、启用条件、模型直接进列表", () => {
    const r = scanCcSwitch(db, []);
    const names = new Set<string>(["Relay A"]);
    const p = candidateToProvider(r.candidates[0], "p1", names);
    eq("同名自动加序号", p.name, "Relay A 2");
    check("names 集合被更新", names.has("Relay A 2"));
    eq("id 按给定", p.id, "p1");
    eq("有 Key 有地址 → 启用", p.enabled, true);
    deepEq("模型清单直接进 enabledModels", p.enabledModels, r.candidates[0].models);
    eq("anthropic 模式随候选", p.anthropicMode, "kiro");
    const codex = candidateToProvider(r.candidates.find((c) => c.name === "Codex Relay")!, "p2", names);
    eq("openaiApi 随候选", codex.openaiApi, "chat");
    eq("exactBase 只在 true 时写", codex.exactBase, true);
    eq("anthropic 候选不写 openaiApi", p.openaiApi, undefined);
    eq("openai 候选不写 anthropicMode", codex.anthropicMode, undefined);
  });

  await test("v2 config.json：providers 对象/数组两种写法、current 标记、settingsConfig 驼峰键", () => {
    const json = path.join(dir, "config.json");
    fs.writeFileSync(
      json,
      JSON.stringify({
        claude: { current: "a1", providers: { a1: { id: "a1", name: "Legacy A", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://legacy.example", ANTHROPIC_AUTH_TOKEN: "sk-legacy" } } } } },
        codex: { providers: [{ id: "c9", name: "Legacy Codex", settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: "sk-lc" }, config: '[model_providers.x]\nbase_url = "https://lc.example/v1"\n' }) }] },
        meta: { version: 2 },
      })
    );
    const rows = readCcSwitchRows(json);
    eq("两行", rows.length, 2);
    eq("current 标记", rows[0].isCurrent, true);
    eq("字符串形式的 settings_config 也解", rows[1].settings.auth && (rows[1].settings.auth as { OPENAI_API_KEY: string }).OPENAI_API_KEY, "sk-lc");
    const r = scanCcSwitch(json, []);
    deepEq("两条候选", r.candidates.map((c) => c.name), ["Legacy A", "Legacy Codex"]);
    eq("codex 无 wire_api → 缺省 responses", r.candidates[1].openaiApi, "responses");
    eq("数据库没有 providers 表 → 报错", (() => {
      const other = path.join(dir, "other.db");
      writeSqlite(other, [{ name: "t", createSql: "CREATE TABLE t (a)", rows: [[1]] }]);
      try {
        readCcSwitchRows(other);
        return "no error";
      } catch (e) {
        return (e as Error).message.includes("没有 providers 表") ? "ok" : (e as Error).message;
      }
    })(), "ok");
  });

  rmrf(dir);
  finish();
})();
