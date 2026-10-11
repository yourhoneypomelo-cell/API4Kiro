"use strict";
// 卸载入口（dist/uninstall.js）的端到端测试：真产物 + 临时夹具 + 逐字节还原。
// 绝不碰真实 /Applications/Kiro.app 与用户真实 settings.json：一律用临时目录 +
// A2K_KIRO_APP_ROOT / A2K_KIRO_SETTINGS / HOME 隔离，并在首尾对真实文件做哈希对照（AC-13）。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const BUILD = path.join(__dirname, ".build");
const UNINSTALL = path.join(REPO, "dist/uninstall.js");
const REAL_APP_ROOT = "/Applications/Kiro.app/Contents/Resources/app";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-uninstall-"));
fs.mkdirSync(WORK, { recursive: true });

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const read = (f) => fs.readFileSync(f, "utf8");

/** 真实环境快照（AC-13：测试前后必须一致）。 */
function realSnapshot() {
  const files = [
    path.join(REAL_APP_ROOT, "extensions/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/style.css"),
    path.join(REAL_APP_ROOT, "extensions/kiro.kiro-agent/dist/extension.js"),
    path.join(os.homedir(), "Library/Application Support/Kiro/User/settings.json"),
  ];
  const out = {};
  for (const f of files) {
    try {
      out[f] = sha(f);
    } catch {
      out[f] = "missing";
    }
  }
  return out;
}

const realBefore = realSnapshot();
test.after(() => {
  assert.deepEqual(realSnapshot(), realBefore, "测试不得改动真实 Kiro 文件或用户真实 settings.json");
});

let seq = 0;
/** 造一个沙箱：appRoot（含 chunk/style/backend）+ settings.json。 */
function makeSandbox(opts = {}) {
  const dir = path.join(WORK, `case-${++seq}`);
  const appRoot = path.join(dir, "app");
  const ext = path.join(appRoot, "extensions/kiro.kiro-agent");
  const dist = path.join(ext, "packages/kiro-ui-agent-chat/dist");
  const assets = path.join(dist, "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(path.join(ext, "dist"), { recursive: true });

  const backend = path.join(ext, "dist/extension.js");
  const style = path.join(dist, "style.css");
  const chunk = path.join(assets, "mermaid-uninstall.js");
  const settingsDir = path.join(dir, "Kiro/User");
  fs.mkdirSync(settingsDir, { recursive: true });
  const settings = path.join(settingsDir, "settings.json");

  fs.writeFileSync(backend, opts.backend ?? BACKEND_FACTORY, "utf8");
  fs.writeFileSync(style, opts.style ?? ":root{--x:1}\nbody{margin:0}\n", "utf8");
  fs.writeFileSync(chunk, opts.chunk ?? syntheticChunk(), "utf8");
  if (opts.settings !== null) {
    fs.writeFileSync(settings, opts.settings ?? defaultSettings(), "utf8");
  }
  return { dir, appRoot, ext, backend, style, chunk, settings, settingsDir, files: [chunk, style, backend] };
}

const BACKEND_FACTORY = "function QPe(t){Oue=t}function Zue(){return Oue}var qq=Oue.getAvailableModels();";

/**
 * 剥掉 CSS 里的 kiro-proxy 残留（注释 + 含 `kiroproxy-` 的顶层规则）。
 * 与 `dev/verify-selector-patch.js` 的同名工具同一套手工扫描写法（不用正则：600 KB 压缩 CSS 里有超长 base64 段）。
 * 只有 CSS 能这样清洗；JS 里有一处没有配对 `:end` 的行内标记，只能取 `.kiroproxy-bak-*` 备份。
 */
function stripKiroProxyCss(css) {
  let out = css;
  for (let guard = 0; guard < 64; guard++) {
    const i = out.indexOf("/*kiroproxy-");
    if (i < 0) break;
    const close = out.indexOf("*/", i);
    if (close < 0) break;
    out = out.slice(0, i) + out.slice(close + 2);
  }
  let from = 0;
  for (let guard = 0; guard < 64; guard++) {
    const i = out.indexOf("kiroproxy-", from);
    if (i < 0) break;
    const start = Math.max(out.lastIndexOf("}", i), out.lastIndexOf("\n", i)) + 1;
    const open = out.indexOf("{", i);
    const close = open < 0 ? -1 : out.indexOf("}", open);
    const selector = out.slice(start, i);
    if (!(open >= 0 && close >= 0) || selector.includes("{") || out.slice(i, open).includes("}")) {
      from = i + 10;
      continue;
    }
    let end = close + 1;
    while (end < out.length && (out[end] === " " || out[end] === "\t")) end++;
    if (out[end] === "\r") end++;
    if (out[end] === "\n") end++;
    out = out.slice(0, start) + out.slice(end);
    from = start;
  }
  return out;
}

/** 合成 1.1.x chunk（与 dev/verify-selector-patch.js 的合成夹具同源）。 */
function syntheticChunk() {
  const S = require(path.join(BUILD, "selectorStyle.js"));
  const I = S.__selectorStyleInternals;
  const M = I.matchers;
  const P = I.patterns;
  const RN = ["E", "R", "O"];
  const RA = ["w", "I", "N"];
  return [
    M.renderTemplate(P.ORIG_MENU_PATTERN, RN, RA),
    M.renderTemplate(P.ORIG_REF_PATTERN, RN, RA),
    M.renderTemplate(P.ORIG_JS_PATTERN, RN, RA),
    M.renderTemplate(
      P.ORIG_POPOVER_PATTERN,
      ["Bde", "re", "Pde", "E", "R", "O", "I", "B", "z"],
      ["n2e", "ne", "t2e", "w", "I", "N", "R", "$", "H"]
    ),
    M.renderTemplate(P.ORIG_POPOVER_CALL_PATTERN, ["Bde", "Y"], ["n2e", "q"]),
    'b.jsx(x2e,{disabled:K});a(E0,"useSessionConfig");a(x2e,"EffortSelector");',
    'x("chat-input-popup-option");',
  ].join(";");
}

const OURS = (port) => JSON.stringify([{ region: "us-east-1", endpoint: `http://127.0.0.1:${port}` }]);

function defaultSettings(extra = {}) {
  return `{\n  // 用户自己的设置\n  "editor.fontSize": 14,\n  "codewhisperer.config.endpoints": ${OURS(19810)},\n  "codewhisperer.config.krsEndpoints": ${OURS(19810)},\n  "codewhisperer.config.cpsEndpoints": ${OURS(19811)},\n  "api2kiroDual.port": 19810,\n  "api2kiroDual.cpsPort": 19811,\n}\n`;
}

/**
 * 用**子进程**打补丁：宿主桩在 require 时读 `A2K_APP_ROOT`，同一进程里只能指向一个 appRoot，
 * 而本文件要造多个沙箱。顺带这也更贴近真实（补丁由扩展宿主写、卸载由另一个进程做）。
 */
function patch(appRoot, enabled) {
  const code = `
    process.env.A2K_APP_ROOT = ${JSON.stringify(appRoot)};
    const S = require(${JSON.stringify(path.join(BUILD, "selectorStyle.js"))});
    S.syncGroupHeaderStyle(${enabled}).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const out = execFileSync(process.execPath, ["-e", code], { encoding: "utf8", cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.slice(out.indexOf("{")));
}

/** 跑真产物 dist/uninstall.js（退出码、stdout 都拿回来断言）。 */
function runUninstall(sandbox, env = {}) {
  const home = path.join(sandbox.dir, "home");
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [UNINSTALL], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      A2K_KIRO_APP_ROOT: sandbox.appRoot,
      A2K_KIRO_SETTINGS: sandbox.settings,
      ...env,
    },
  });
}

test("真产物可加载：dist/uninstall.js 存在、不含 require(\"vscode\")、package.json 挂钩正确", () => {
  assert.ok(fs.existsSync(UNINSTALL), "先跑 npm run bundle / tests/build.js");
  assert.ok(!/require\(["']vscode["']\)/.test(read(UNINSTALL)), "卸载产物不得 require(\"vscode\")");
  const scripts = JSON.parse(read(path.join(REPO, "package.json"))).scripts;
  assert.equal(scripts["vscode:uninstall"], "node ./dist/uninstall.js");
  assert.match(scripts["vscode:uninstall"], /^node \.\/\S+$/);
});

test("AC-7/AC-8/AC-16：合成夹具 打补丁 → 卸载 → 逐字节一致 + 端点已清 + exit 0", () => {
  const sb = makeSandbox();
  const factory = sb.files.map((f) => read(f));
  const r1 = patch(sb.appRoot, true);
  assert.equal(r1.blockedBy, undefined, JSON.stringify(r1));
  assert.notDeepEqual(sb.files.map(read), factory, "夹具前提：补丁确实改写了文件");

  const res = runUninstall(sb);
  assert.equal(res.status, 0, `退出码必须 0：${res.stderr}`);
  assert.ok(res.stdout.includes("API4Kiro 卸载"), res.stdout);
  assert.deepEqual(sb.files.map(read), factory, "还原后必须与打补丁前逐字节一致");
  // SHA 比对（同一件事的第二种说法，便于报告引用）
  const after = sb.files.map((f) => sha(f));
  const want = factory.map((t) => crypto.createHash("sha256").update(t).digest("hex"));
  assert.deepEqual(after, want);

  const settings = JSON.parse(read(sb.settings).replace(/^\s*\/\/.*$/gm, "").replace(/,\s*}/g, "}"));
  assert.equal(settings["codewhisperer.config.endpoints"], undefined);
  assert.equal(settings["codewhisperer.config.krsEndpoints"], undefined);
  assert.equal(settings["codewhisperer.config.cpsEndpoints"], undefined);
  assert.equal(settings["editor.fontSize"], 14, "别人的设置必须留住");
  assert.equal(settings["api2kiroDual.port"], 19810, "本扩展自己的设置项不动");
  assert.ok(read(sb.settings).includes("// 用户自己的设置"), "注释必须留住");
});

test("AC-11：第二次运行内容与 mtime 均不变", () => {
  const sb = makeSandbox();
  patch(sb.appRoot, true);
  runUninstall(sb);
  const before = sb.files.map((f) => ({ text: read(f), stamp: `${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` }));
  const settingsBefore = read(sb.settings);
  const settingsStamp = fs.statSync(sb.settings).mtimeMs;

  const res = runUninstall(sb);
  assert.equal(res.status, 0);
  assert.deepEqual(
    sb.files.map((f) => ({ text: read(f), stamp: `${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` })),
    before,
    "第二次运行不得改写任何文件"
  );
  // 端点已经清掉 ⇒ settings 不再变更（连 mtime 都不变）
  assert.equal(read(sb.settings), settingsBefore);
  assert.equal(fs.statSync(sb.settings).mtimeMs, settingsStamp);
});

test("AC-9：夹具带 kiroproxy- 残留 ⇒ 卸载后等于「打补丁前的带残留状态」，残留字节不变", () => {
  const cssResidue = "/*kiroproxy-ctxwin-css:r1*/\n.kiroproxy-ctxwin-wrap{display:flex}\n";
  const jsResidue = "/*kiroproxy-toolcard:r1*/var kiroproxyProbe=1;/*kiroproxy-toolcard:end*/";
  const sb = makeSandbox({ style: `:root{--x:1}\n${cssResidue}`, backend: `${BACKEND_FACTORY}\n${jsResidue}\n` });
  const before = sb.files.map(read);
  // 开补丁时被前置闸挡住 ⇒ 文件一字不动
  const r = patch(sb.appRoot, true);
  assert.equal(r.blockedBy, "kiro-proxy", JSON.stringify(r));
  assert.deepEqual(sb.files.map(read), before);

  const res = runUninstall(sb);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(sb.files.map(read), before, "卸载后必须等于打补丁前的带残留状态");
  assert.ok(read(sb.style).includes(cssResidue.trim()), "别人的 CSS 字节不能碰");
  assert.ok(read(sb.backend).includes(jsResidue), "别人的 JS 字节不能碰");
  assert.ok(res.stdout.includes("kiro-proxy"), `摘要里要点出残留：${res.stdout}`);
});

test("JSONC 边界：最后一个成员的「前一个值带逗号块注释」⇒ 端点仍被清除，且不误报「解析失败」", () => {
  // 端点键是最后一个成员、前一个成员的值后面跟着含逗号的块注释：
  // 4.13.65 的 `indexOf(",")` 会命中注释里的逗号 → 自校验失败 → 整份清理静默跳过（日志还误报成解析失败）。
  const sb = makeSandbox({
    settings: `{\n  "editor.fontSize": 14 /* x, y */,\n  "codewhisperer.config.endpoints": ${OURS(19810)}\n}\n`,
  });
  const res = runUninstall(sb);
  assert.equal(res.status, 0, res.stderr);
  const after = read(sb.settings);
  assert.ok(!after.includes("codewhisperer.config.endpoints"), `端点必须被清掉：${after}`);
  assert.ok(after.includes("editor.fontSize") && after.includes("/* x, y */"), `别人的设置与注释要留住：${after}`);
  assert.ok(res.stdout.includes("已清理 1 个端点键"), res.stdout);
  assert.ok(!res.stdout.includes("解析失败"), `合法 JSONC 不得被报成解析失败：${res.stdout}`);
});

test("端点清理的两种结果分开报：「自校验失败」≠「整份解析失败」", () => {
  const U = require(path.join(BUILD, "uninstall.js"));
  const dir = fs.mkdtempSync(path.join(WORK, "cleanup-"));
  const ok = path.join(dir, "ok.json");
  fs.writeFileSync(ok, `{\n  "codewhisperer.config.endpoints": ${OURS(19810)},\n  "a": 1\n}\n`, "utf8");
  const rOk = U.cleanupEndpoints(ok);
  assert.deepEqual(rOk.removed, ["codewhisperer.config.endpoints"], JSON.stringify(rOk));
  assert.equal(rOk.parseFailed, false);
  assert.deepEqual(rOk.selfCheckFailed, [], "正常删除不该记自校验失败");

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "[1,2,3]\n", "utf8");
  const rBad = U.cleanupEndpoints(bad);
  assert.equal(rBad.parseFailed, true, "顶层不是对象 = 整份解析失败");
  assert.deepEqual(rBad.selfCheckFailed, [], "解析失败不记进自校验失败（两种原因两种文案）");
  assert.equal(read(bad), "[1,2,3]\n", "解析失败必须原样保留");
});

test("AC-12：settings 解析失败 / 目录只读 / 文件缺失 ⇒ exit 0 且其它项照常完成", () => {
  // ① 解析失败（顶层不是对象）：原样保留
  const bad = makeSandbox({ settings: "[1,2,3]\n" });
  const badFactory = bad.files.map(read);
  patch(bad.appRoot, true);
  let res = runUninstall(bad);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(read(bad.settings), "[1,2,3]\n", "解析失败必须原样保留");
  assert.deepEqual(bad.files.map(read), badFactory, "文件还原照常完成");

  // ② 设置目录只读 ⇒ 写不进去，原文件保持不变，仍然 exit 0、文件照常还原
  const ro = makeSandbox();
  const roSettingsBefore = read(ro.settings);
  const roFactory = ro.files.map(read);
  patch(ro.appRoot, true);
  fs.chmodSync(ro.settingsDir, 0o555);
  try {
    res = runUninstall(ro);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(ro.settings), roSettingsBefore, "写不进去时不得留下半成品");
    assert.deepEqual(ro.files.map(read), roFactory, "settings 失败不该影响文件还原");
  } finally {
    fs.chmodSync(ro.settingsDir, 0o755);
  }

  // ③ settings 不存在 ⇒ 跳过端点清理、文件照常还原
  const none = makeSandbox({ settings: null });
  const noneFactory = none.files.map(read);
  patch(none.appRoot, true);
  res = runUninstall(none);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(none.files.map(read), noneFactory);
  assert.ok(res.stdout.includes("跳过端点清理"), res.stdout);

  // ④ 整个 Kiro 目录不存在 ⇒ exit 0
  const orphan = makeSandbox();
  fs.rmSync(orphan.appRoot, { recursive: true, force: true });
  res = runUninstall(orphan);
  assert.equal(res.status, 0, res.stderr);
});

test("AC-13 / D3：环境变量覆盖非法时跳过该项、exit 0，且不对覆盖值写任何东西", () => {
  const sb = makeSandbox();
  // ① 存在但不是 Kiro 目录
  const notKiro = path.join(sb.dir, "not-kiro");
  fs.mkdirSync(notKiro, { recursive: true });
  const probe = path.join(notKiro, "settings.json");
  fs.writeFileSync(probe, "{}\n", "utf8");
  let res = runUninstall(sb, { A2K_KIRO_APP_ROOT: notKiro, A2K_KIRO_SETTINGS: probe });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes("不是 Kiro 安装"), res.stdout);
  assert.equal(read(probe), "{}\n", "覆盖值指向的目录不得被写任何东西");

  // ② settings 是目录
  let res2 = runUninstall(sb, { A2K_KIRO_SETTINGS: sb.settingsDir });
  assert.equal(res2.status, 0, res2.stderr);
  assert.ok(res2.stdout.includes("不是文件"), res2.stdout);

  // ③ 相对路径
  let res3 = runUninstall(sb, { A2K_KIRO_APP_ROOT: "relative/app", A2K_KIRO_SETTINGS: "relative/settings.json" });
  assert.equal(res3.status, 0, res3.stderr);
  assert.ok(res3.stdout.includes("不是绝对路径"), res3.stdout);
});

test("AC-10：settings 形态矩阵——混有别人的端点 / 别的端口 / https 中转一律保留", () => {
  const other = JSON.stringify([{ region: "us-east-1", endpoint: "http://127.0.0.1:19800" }]);
  const mixed = JSON.stringify([
    { region: "us-east-1", endpoint: "http://127.0.0.1:19810" },
    { region: "us-east-2", endpoint: "http://127.0.0.1:19800" },
  ]);
  const cases = [
    ["混项（本插件 + 别的端口）", mixed, "codewhisperer.config.endpoints"],
    ["别的端口", other, "codewhisperer.config.endpoints"],
    ["https 中转", JSON.stringify([{ region: "us-east-1", endpoint: "https://relay.example.com" }]), "codewhisperer.config.endpoints"],
    ["裸字符串", '"http://127.0.0.1:19810"', "codewhisperer.config.endpoints"],
    ["空数组", "[]", "codewhisperer.config.endpoints"],
  ];
  for (const [label, value, key] of cases) {
    const sb = makeSandbox({
      settings: `{\n  "${key}": ${value},\n  "codewhisperer.config.cpsEndpoints": ${OURS(19811)},\n}\n`,
    });
    const res = runUninstall(sb);
    assert.equal(res.status, 0, `${label}: ${res.stderr}`);
    const after = read(sb.settings);
    assert.ok(after.includes(value), `${label}：不属于本插件的值必须逐字保留（${after}）`);
    assert.ok(!after.includes(`"${key}": ${OURS(19811)}`), label);
    assert.ok(!after.includes("cpsEndpoints"), `${label}：本插件的 cpsEndpoints 应被清掉（${after}）`);
  }
  // 块注释 / 尾逗号 / CRLF / 自定义端口的形态
  const sb = makeSandbox({
    settings: `{\r\n  /* 块注释 */\r\n  "codewhisperer.config.krsEndpoints": ${OURS(19810)},\r\n  "api2kiroDual.port": 19899,\r\n  "api2kiroDual.cpsPort": 19898,\r\n  "codewhisperer.config.cpsEndpoints": ${OURS(19898)},\r\n}\r\n`,
  });
  const res = runUninstall(sb);
  assert.equal(res.status, 0, res.stderr);
  const after = read(sb.settings);
  assert.ok(!after.includes("krsEndpoints"), after);
  assert.ok(!after.includes("cpsEndpoints"), `自定义端口的 cps 端点也要清掉：${after}`);
  assert.ok(after.includes("/* 块注释 */"), "块注释必须留住");
  assert.ok(after.includes("api2kiroDual.port"), "本扩展自己的设置项不动");

  // 文件开头就是一行注释（首个非空白字符不是 `{`）：jsoncEdit 容忍它，清理必须照常进行
  const lead = makeSandbox({
    settings: `// 我的注释\n{\n  "codewhisperer.config.krsEndpoints": ${OURS(19810)},\n  "editor.fontSize": 13,\n}\n`,
  });
  const leadRes = runUninstall(lead);
  assert.equal(leadRes.status, 0, leadRes.stderr);
  const leadAfter = read(lead.settings);
  assert.ok(!leadAfter.includes("krsEndpoints"), `开头有行注释时也必须清掉端点：${leadAfter}`);
  assert.ok(leadAfter.includes("// 我的注释") && leadAfter.includes("editor.fontSize"), leadAfter);
});

test("真机只读副本（1.2.56 形态，若本机有）→ 打补丁 → 卸载 → 逐字节一致", () => {
  const realExt = path.join(REAL_APP_ROOT, "extensions/kiro.kiro-agent");
  if (!fs.existsSync(path.join(realExt, "packages/kiro-ui-agent-chat/dist/style.css"))) {
    return; // 本机没有真机 Kiro：跳过（不依赖真机的夹具已由前面的合成用例覆盖）
  }
  const sb = makeSandbox({
    chunk: 'x("chat-input-popup-option");', // 占位，稍后被真机 chunk 覆盖
  });
  const pickBackup = (f) => {
    const dir = path.dirname(f);
    const hit = fs.readdirSync(dir).find((n) => n.startsWith(path.basename(f) + ".kiroproxy-bak-"));
    return hit ? path.join(dir, hit) : f;
  };
  const srcStyle = path.join(realExt, "packages/kiro-ui-agent-chat/dist/style.css");
  const srcBackend = pickBackup(path.join(realExt, "dist/extension.js"));
  let srcChunk;
  const assets = path.join(realExt, "packages/kiro-ui-agent-chat/dist/assets");
  for (const f of fs.readdirSync(assets)) {
    if (f.startsWith("mermaid-") && f.endsWith(".js") && read(path.join(assets, f)).includes("chat-input-popup-option")) {
      srcChunk = pickBackup(path.join(assets, f));
      break;
    }
  }
  assert.ok(srcChunk, "真机夹具里应有承载模型选择器的 chunk");
  // 真机文件可能正带着上一版扩展的注入（本机 style.css 实测 a2k- 有 70 处），
  // 所以复制的三份都要先归一为出厂原文——用产品自己的还原函数，不另写清洗逻辑。
  const S = require(path.join(BUILD, "selectorStyle.js"));
  const M = S.__selectorStyleInternals.matchers;
  // 末尾统一成 planStyleSheet 的规范形（`…}\n`）：打补丁那一步本来就会把尾部空白收敛掉，
  // 所以只有从规范形出发，「打补丁 → 还原」才是逐字节恒等的（这不是卸载脚本引入的差异）。
  fs.writeFileSync(sb.style, stripKiroProxyCss(M.stripBlock(read(srcStyle))).replace(/\s+$/, "") + "\n", "utf8");
  fs.writeFileSync(sb.backend, M.restoreUsageHook(M.restoreCtxHostHook(M.restoreBackendHook(read(srcBackend)))), "utf8");
  fs.writeFileSync(sb.chunk, M.restoreSelectorScript(read(srcChunk)), "utf8");
  // 夹具必须是无残留的出厂原文（有残留时前置闸会挡住，那属于 AC-9 的用例）
  assert.ok(!read(sb.style).includes("kiroproxy-"), "真机 style.css 需要先归一（见 dev/verify-selector-patch.js）");

  const factory = sb.files.map(read);
  const r = patch(sb.appRoot, true);
  assert.equal(r.blockedBy, undefined, JSON.stringify(r));
  assert.notDeepEqual(sb.files.map(read), factory, "夹具前提：补丁确实改写了文件");
  const res = runUninstall(sb);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(sb.files.map(read), factory, "1.2.56 形态也必须逐字节还原");
});
