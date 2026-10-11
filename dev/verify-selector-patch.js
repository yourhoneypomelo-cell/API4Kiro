#!/usr/bin/env node
/**
 * API4Kiro 选择器补丁：结构锚定验证脚本（4.13.59 起；4.13.64 起覆盖两代模型选择器）
 *
 * 背景：Kiro 1.1.14 把 webview bundle 整体重新压缩，1.0.411 / 1.0.437 压缩名写死的锚点全数失配，
 * 选择器补丁静默不生效（控制面板报 "model selector target not found in mermaid-*.js"）。
 * 修复方式：靶点定位改成「非标识符逐字 + 标识符各自通配」的结构匹配（见 src/selectorStyle.ts）。
 * Kiro 1.2.56 又把模型选择器整个重写成模型面板（ModelPanel / ModelOptionRow）：脚本按代判定，
 * 1.1.x（v1：选项行 / 菜单 / ref）与 1.2.x（v2：模型面板行 + writeModel 守卫）各跑各的断言；
 * P23 用合成的 1.1.x 夹具守住 v1 全链路（本机没有 1.1.x 安装时也能跑）。
 *
 * 本脚本把编译产物跑在**真机 Kiro 的只读副本**上，验证：
 *   P1 跨压缩名等价   P2 唯一命中   P3 映射守卫   P4 不误伤
 *   P5 幂等           P6 往返复原   P7 历史变体   P8/P9/P10 端到端
 *
 * 用法：
 *   node dev/verify-selector-patch.js            # 用真机 Kiro 安装目录做只读副本
 *   node dev/verify-selector-patch.js <appRoot>  # 指定 Kiro appRoot
 *
 * 绝不改动真机文件：所有读写都在 /tmp 下的副本里。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "src");
/** `--synthetic`：没有真实 Kiro 安装也能跑（CI 用）。真机段落打 SKIP 并计入跳过数。 */
const SYNTHETIC = process.argv.includes("--synthetic");
/** 第一个位置参数 = Kiro appRoot（可选；`--synthetic` 之类的开关不算）。 */
const REAL_ROOT = process.argv.slice(2).find((a) => !a.startsWith("--")) || "/Applications/Kiro.app/Contents/Resources/app";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-verify-"));
const BUILD = path.join(WORK, "build");
const ROOT = path.join(WORK, "root");

/** 夹具里被归一掉的 kiro-proxy 残留处数（CSS 剥离）与 JS 备份替换数，最后打印一行。 */
const fixtureStats = { cssStripped: 0, cssFiles: 0, jsFromBackup: 0, jsClean: 0 };
/** `--synthetic` 模式下跳过的真机段落数（不与 AC-3 的 176 混用）。 */
let skippedSections = 0;

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `\n        ${extra}`}`);
  }
};
const section = (t) => console.log(`\n== ${t}`);

// ---------------------------------------------------------------- build + fixture
function build() {
  execFileSync(path.join(REPO, "node_modules/.bin/tsc"), ["-p", path.join(REPO, "tsconfig.json"), "--outDir", BUILD, "--noEmit", "false", "--sourceMap", "false"], { stdio: "pipe" });
  const stubDir = path.join(BUILD, "node_modules/vscode");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "vscode", version: "0.0.0", main: "index.js" }));
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `module.exports={env:{appRoot:process.env.A2K_APP_ROOT,appName:"Kiro"},` +
      `workspace:{getConfiguration:()=>({get:()=>undefined})},` +
      `window:{createOutputChannel:()=>({appendLine(){},append(){},show(){},dispose(){}})},` +
      `Uri:{file:(p)=>({fsPath:p,toString:()=>String(p)})},commands:{executeCommand:async()=>undefined}};\n`
  );
  fs.writeFileSync(
    path.join(BUILD, "log.js"),
    `module.exports={info(...a){const t=a.map((x)=>typeof x==="string"?x:JSON.stringify(x)).join(" ");` +
      `(globalThis.__a2kInfo||(globalThis.__a2kInfo=[])).push(t);},debug(){},warn(){},error(){},showLog(){},initLog(){return{appendLine(){},dispose(){}}},` +
      `redactText:(s)=>s,maskSecretForLog:(s)=>s,maskKey:(s)=>s,MAX_LINE_BYTES:65536};\n`
  );
}

/**
 * 把真机上**所有**承载模型选择器 chunk 的 package 都复制进沙箱。
 *
 * Kiro 1.1.14 起聊天界面被拆到 `kiro-ui-session-details`，同一个 chunk（同名 base、不同 hash）
 * 在各 package 下各有一份、各自独立压缩。只复制 kiro-ui-agent-chat 会漏掉用户真正看到的那个视图
 * （2026-09-15 实拍：卡片样式打在 agent-chat，界面却由 session-details 的工厂 chunk 渲染，
 * 于是每行模型名下面直接显示 `__A2K_MDL__|…` 微格式）。
 */
/**
 * 删除 CSS 里 kiro-proxy 的补丁残留：`/*kiroproxy-…*​/` 注释 + 含 `kiroproxy-` 的顶层规则。
 *
 * 为什么手工扫描不用正则：600 KB 压缩 CSS 里有超长 base64 字体段，正则（哪怕非回溯写法）在这种
 * 单行超长文本上代价不可控。写法照抄 `src/selectorStyle.ts` 的 `stripStrayA2kRules`，只把关键字换掉。
 * 夹具必须是**出厂原文**：本机真实 Kiro 上带着上一版 kiro-proxy 的注入，不归一的话
 * 产品侧新增的「检测到 kiro-proxy 残留就不写任何文件」前置闸会让整个真机段落全红。
 */
function stripKiroProxyCss(css) {
  let out = css;
  let removed = 0;
  // 先删注释形态（`/*kiroproxy-ctxwin-css:r1*​/`）：它不在选择器位置，规则扫描认不出
  for (let guard = 0; guard < 64; guard++) {
    const i = out.indexOf("/*kiroproxy-");
    if (i < 0) break;
    const close = out.indexOf("*/", i);
    if (close < 0) break;
    out = out.slice(0, i) + out.slice(close + 2);
    removed++;
  }
  // 再删含 kiroproxy- 的顶层规则（连同其后一个换行）
  let from = 0;
  for (let guard = 0; guard < 64; guard++) {
    const i = out.indexOf("kiroproxy-", from);
    if (i < 0) break;
    const start = Math.max(out.lastIndexOf("}", i), out.lastIndexOf("\n", i)) + 1;
    const open = out.indexOf("{", i);
    const close = open < 0 ? -1 : out.indexOf("}", open);
    const selector = out.slice(start, i);
    const inSelectorPosition = open >= 0 && close >= 0 && !selector.includes("{") && !out.slice(i, open).includes("}");
    if (!inSelectorPosition) {
      from = i + 10;
      continue;
    }
    let end = close + 1;
    while (end < out.length && (out[end] === " " || out[end] === "\t")) end++;
    if (out[end] === "\r") end++;
    if (out[end] === "\n") end++;
    out = out.slice(0, start) + out.slice(end);
    removed++;
    from = start;
  }
  return { text: out, removed };
}

/** 同名 `.kiroproxy-bak-*` 备份：那份是该 Kiro 构建的出厂原文，比现行文件少 1580 / 13277 字节。 */
function kiroProxyBackup(srcFile) {
  const dir = path.dirname(srcFile);
  const base = path.basename(srcFile);
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(base + ".kiroproxy-bak-"));
  return hit ? path.join(dir, hit) : null;
}

/**
 * JS 夹具归一：优先取同名 `.kiroproxy-bak-*` 备份，**不做文本清洗**——
 * agent-chat 的 chunk 里有一处行内 `/*kiroproxy-ctxwin-ui:r2*​/…` 没有配对 `:end`，
 * 按定界段剥离会漏掉它或误吞后续代码。备份也没有、残留又还在时只能明确报错（夹具不能带残留）。
 */
function normalizedJsText(srcFile, label) {
  const backup = kiroProxyBackup(srcFile);
  if (backup) {
    const text = fs.readFileSync(backup, "utf8");
    if (text.includes("kiroproxy-")) {
      throw new Error(`备份 ${backup} 仍含 kiroproxy- 残留，夹具无法归一`);
    }
    fixtureStats.jsFromBackup++;
    console.log(`      · ${label}：已用备份替换（${path.basename(backup)}）`);
    return text;
  }
  const text = fs.readFileSync(srcFile, "utf8");
  if (text.includes("kiroproxy-")) {
    throw new Error(
      `${srcFile} 带 kiro-proxy 残留且没有同名 .kiroproxy-bak-* 备份：JS 不能文本清洗（有未配对的行内标记），` +
        `请先恢复该 Kiro 构建的出厂文件再跑本脚本`
    );
  }
  fixtureStats.jsClean++;
  return text;
}

function fixture() {
  const ext = path.join(REAL_ROOT, "extensions/kiro.kiro-agent");
  const chat = path.join(ext, "packages/kiro-ui-agent-chat/dist");
  if (!fs.existsSync(chat)) throw new Error(`not a Kiro appRoot: ${REAL_ROOT}`);
  const pkgsDir = path.join(ROOT, "extensions/kiro.kiro-agent/packages");
  const packages = [];
  for (const pkg of fs.readdirSync(path.join(ext, "packages"))) {
    const dist = path.join(ext, "packages", pkg, "dist");
    const assetsSrc = path.join(dist, "assets");
    if (!fs.existsSync(assetsSrc) || !fs.existsSync(path.join(dist, "style.css"))) continue;
    const chunks = fs.readdirSync(assetsSrc).filter((f) => f.startsWith("mermaid-") && f.endsWith(".js"));
    const carries = chunks.find((f) => fs.readFileSync(path.join(assetsSrc, f), "utf8").includes("chat-input-popup-option"));
    if (!carries) continue;
    const assetsDst = path.join(pkgsDir, pkg, "dist/assets");
    fs.mkdirSync(assetsDst, { recursive: true });
    // style.css 没有备份（真机上也只对 JS 留了备份），只能剥离；JS 一律优先取备份
    const cssSrc = path.join(dist, "style.css");
    const stripped = stripKiroProxyCss(fs.readFileSync(cssSrc, "utf8"));
    fixtureStats.cssStripped += stripped.removed;
    fixtureStats.cssFiles++;
    fs.writeFileSync(path.join(pkgsDir, pkg, "dist/style.css"), stripped.text, "utf8");
    for (const f of chunks) {
      const text = normalizedJsText(path.join(assetsSrc, f), `${pkg}/${f}`);
      fs.writeFileSync(path.join(assetsDst, f), text, "utf8");
    }
    packages.push({ pkg, assets: assetsDst, chunk: path.join(assetsDst, carries), style: path.join(pkgsDir, pkg, "dist/style.css") });
  }
  fs.mkdirSync(path.join(ROOT, "extensions/kiro.kiro-agent/dist"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "extensions/kiro.kiro-agent/dist/extension.js"),
    normalizedJsText(path.join(ext, "dist/extension.js"), "dist/extension.js"),
    "utf8"
  );
  const chatPkg = packages.find((p) => p.pkg === "kiro-ui-agent-chat") || packages[0];
  return { packages, assets: chatPkg.assets, style: chatPkg.style, real: true };
}

/** `--synthetic` 夹具：用仓库内已有的合成 1.1.x 模板 + 合成 style.css 造一个 appRoot，不碰真机。 */
function syntheticFixture(M, P) {
  const pkg = "kiro-ui-agent-chat";
  const dist = path.join(ROOT, "extensions/kiro.kiro-agent/packages", pkg, "dist");
  const assets = path.join(dist, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const style = path.join(dist, "style.css");
  fs.writeFileSync(style, ":root{--x:1}\nbody{margin:0}\n", "utf8");
  const chunk = path.join(assets, "mermaid-synthetic.js");
  fs.writeFileSync(chunk, buildSyntheticV1Chunk(M, P) + ';x("chat-input-popup-option");', "utf8");
  fs.mkdirSync(path.join(ROOT, "extensions/kiro.kiro-agent/dist"), { recursive: true });
  // 最小的后端主钩子形态（`findBackendHook` 的结构锚点）：`function QPe(t){Oue=t}` + 一次 setter 读取。
  fs.writeFileSync(
    path.join(ROOT, "extensions/kiro.kiro-agent/dist/extension.js"),
    "function QPe(t){Oue=t}function Zue(){return Oue}var qq=Oue.getAvailableModels();",
    "utf8"
  );
  return { packages: [{ pkg, assets, chunk, style }], assets, style, real: false };
}

/**
 * 合成的 1.1.x（v1）chunk：选项行 / 菜单容器 / ref / 弹层 / 调用处 / 标签，全部由产品侧的模板渲染而来
 * （与真机结构同形），供 `--synthetic` 夹具与 P23 共用。
 */
function buildSyntheticV1Chunk(M, P) {
  const RN = ["E", "R", "O"];
  const RA = ["w", "I", "N"];
  const row = M.renderTemplate(P.ORIG_JS_PATTERN, RN, RA);
  const menu = M.renderTemplate(P.ORIG_MENU_PATTERN, RN, RA);
  const ref = M.renderTemplate(P.ORIG_REF_PATTERN, RN, RA);
  const popover = M.renderTemplate(
    P.ORIG_POPOVER_PATTERN,
    ["Bde", "re", "Pde", "E", "R", "O", "I", "B", "z"],
    ["n2e", "ne", "t2e", "w", "I", "N", "R", "$", "H"]
  );
  const call = M.renderTemplate(P.ORIG_POPOVER_CALL_PATTERN, ["Bde", "Y"], ["n2e", "q"]);
  // 调用处不能紧贴在 EffortSelector 标签后面：applyCtxSelector 在标签末尾插函数、在调用处做替换，
  // 两段起点相同时会互相踩（真机 bundle 里两者相隔很远，不会出现）。这里把调用处放在标签前。
  const tags = 'b.jsx(x2e,{disabled:K});a(E0,"useSessionConfig");a(x2e,"EffortSelector");';
  return `${menu},${ref},${row};${popover};${call};${tags}`;
}

// ---------------------------------------------------------------- checks
function main() {
  build();
  // 先装载编译产物：合成夹具要用产品侧的模板渲染，所以 fixture() 必须在 require 之后调用。
  process.env.A2K_APP_ROOT = ROOT;
  const S = require(path.join(BUILD, "selectorStyle.js"));
  const I = S.__selectorStyleInternals;
  const M = I.matchers;
  const P = I.patterns;
  const read = (p) => fs.readFileSync(p, "utf8");
  let fx;
  if (SYNTHETIC) {
    // 强制走合成夹具：CI 里没有 Kiro 安装，本机上也让这一模式可复现（真机段落一律 SKIP）。
    console.log("\n== 夹具：--synthetic（不读真机安装，只用合成 1.1.x 夹具）");
    fx = syntheticFixture(M, P);
  } else {
    fx = fixture();
  }
  if (fx.real) {
    console.log(
      `夹具已归一：${fixtureStats.cssStripped} 处 kiro-proxy 残留已移除（CSS 剥离 ${fixtureStats.cssFiles} 份），` +
        `JS 用备份替换 ${fixtureStats.jsFromBackup} 份 / 本来就干净 ${fixtureStats.jsClean} 份；跳过 0 项`
    );
  } else {
    console.log("夹具：合成 1.1.x（无真机 Kiro 安装）；--synthetic 的项数单独记录，不与 AC-3 的 176 混用");
  }
  // 真机可能正运行着上一版 API4Kiro，先只在 /tmp 副本中剥掉注入，得到稳定的出厂 fixture。
  // 这样验证脚本不会把“真机当前是否已打补丁”误当成产品行为。每个 package 的 chunk 都归一。
  for (const pk of fx.packages) {
    pk.factoryChunk = M.restoreSelectorScript(read(pk.chunk));
    fs.writeFileSync(pk.chunk, pk.factoryChunk, "utf8");
    // style.css 同样要归一：真机上可能正带着上一版注入的 CARD_CSS（agent-chat 实测 a2k- 有 70 处）
    fs.writeFileSync(pk.style, M.stripBlock(read(pk.style)), "utf8");
    pk.factoryStyle = read(pk.style);
  }
  const chatPkg = fx.packages.find((p) => p.pkg === "kiro-ui-agent-chat") || fx.packages[0];
  const mermaidFile = chatPkg.chunk;
  const factoryMermaid = chatPkg.factoryChunk;
  const factoryStyle = chatPkg.factoryStyle;
  /** 模型选择器的代：v1 = 1.1 代选项行 / 菜单 / ref；v2 = 1.2 代模型面板（ModelOptionRow）。 */
  const gen = (t) => (M.matchMasked(t, P.ORIG_JS_PATTERN) ? "v1" : M.findModelPanelRow(t) ? "v2" : "none");
  /** 选择器补丁已在位（任一代）。 */
  const isPatched = (t) => t.includes("a2k-model-name-box") || t.includes(M.ROW_FIX_FN);
  for (const pk of fx.packages) console.log(`      · ${pk.pkg} 模型选择器代：${gen(pk.factoryChunk)}`);

  // 真机段落（P1–P3）依赖真实 Kiro bundle 的压缩名与结构，`--synthetic` 模式下整段跳过。
  if (!fx.real) {
    console.log("\n== 真机段落 P1–P22 SKIP（--synthetic 模式没有真实 Kiro 安装）");
    skippedSections++;
  } else {
  section("P1 跨压缩名等价：靶点全部结构命中（真机 factory 文本）");
  check("fixture 已归一为未打补丁的 factory 文本", !factoryMermaid.includes("a2k-"), "restore 后 mermaid 仍含 a2k-");
  const pairs = [["弹层调用处", P.ORIG_POPOVER_CALL_PATTERN]];
  if (gen(factoryMermaid) === "v1") pairs.unshift(["选项行", P.ORIG_JS_PATTERN], ["菜单容器", P.ORIG_MENU_PATTERN]);
  else check("v2 模型面板行三处插入点命中", !!M.findModelPanelRow(factoryMermaid), "findModelPanelRow 返回 null");
  for (const [label, canon] of pairs) {
    const hits = M.scanMasked(factoryMermaid, canon);
    check(`${label} 结构命中 1 次`, hits.length === 1, `实际 ${hits.length} 次`);
  }
  const fac = M.findPopoverFactory(factoryMermaid);
  check("弹层函数命中", !!fac, "null");
  if (fac) console.log(`      · 弹层真机名：${JSON.stringify(fac.names)} tagger=${fac.tagger}`);
  const eff = M.findEffortSelector(factoryMermaid);
  const effCall = eff ? M.findEffortSelectorCall(factoryMermaid, eff.fn) : null;
  check("EffortSelector/ModelSelector 调用处命中", !!effCall, eff ? `fn=${eff.fn}` : "tag not found");

  section("P1b 每个承载模型选择器的 package 都必须能结构命中（它们各自独立压缩）");
  for (const pk of fx.packages) {
    if (gen(pk.factoryChunk) === "v1") {
      const cur = M.scanMasked(pk.factoryChunk, P.ORIG_JS_PATTERN);
      check(`${pk.pkg} 选项行结构命中 1 次`, cur.length === 1, `实际 ${cur.length} 次`);
      check(`${pk.pkg} 菜单容器命中`, !!M.matchMasked(pk.factoryChunk, P.ORIG_MENU_PATTERN), "null");
    } else {
      check(`${pk.pkg} 模型面板行（v2）命中`, !!M.findModelPanelRow(pk.factoryChunk), "两代锚点都不中");
    }
  }
  // 选项行 + 菜单容器是「模型列表不再直接显示 __A2K_ 微格式」的充分条件，每个 package 都必须命中（上面）。
  // 弹层是可选组，按「宁可不打」处理结构差异：session-details 这一版把它重构成了
  // `children:[header,breakdown]` 两个记忆化元素（与压缩名无关的真结构差异），因此跳过，
  // 该视图的 Context Usage 保持 Kiro 原生外观。这里只要求至少一个 package 能命中，并把实际命中面打出来。
  const popoverPkgs = fx.packages.filter((pk) => M.findPopoverFactory(pk.factoryChunk)).map((pk) => pk.pkg);
  check("P1b 至少一个 package 的弹层函数可命中", popoverPkgs.length > 0, "全部失配");
  console.log(`      · 弹层命中：${popoverPkgs.join(", ") || "无"}${popoverPkgs.length < fx.packages.length ? `；未命中（结构不同，跳过）：${fx.packages.map((p) => p.pkg).filter((n) => !popoverPkgs.includes(n)).join(", ")}` : ""}`);

  section("P2 唯一命中：通用形态不得被当成靶点");
  check("ORIG_REF_PATTERN 全文出现多处（>1）", M.scanMasked(factoryMermaid, P.ORIG_REF_PATTERN).length > 1, "应当是多处通用形态");
  check("matchMasked 对多命中返回 null", M.matchMasked(factoryMermaid, P.ORIG_REF_PATTERN) === null);

  section("P3 映射守卫：不一致改名必须被拒");
  {
    const canon = "function Bde(t){return t.a+t.b}";
    const tampered = "function n2e(t){return t.a+T.b}"; // 同一个 `t` 被写成两个不同名字
    const fake = factoryMermaid + tampered;
    const hits = M.scanMasked(fake, canon);
    check("不一致改名不产生命中", hits.length === 0, `实际 ${hits.length} 次`);
  }

  } // ← P1–P3（真机段落）到此结束

  section("P4/P8 开启：三靶点 applied 且 a2k- 只来自补丁常量");
  let result;
  (async () => {
    // P4 起的段落同样只对真机 bundle 成立（压缩名、package 结构都来自真机夹具）
    if (fx.real) {
    result = await S.syncGroupHeaderStyle(true);
    const patched = read(mermaidFile);
    check("P8 status=applied", result.status === "applied", JSON.stringify(result));
    check("P8 selectorScript/style 均 applied", result.targets.selectorScript === "applied" && result.targets.style === "applied", JSON.stringify(result.targets));
    check("P8 无 detail", !result.detail, result.detail);
    check("P8 补齐条件达成（selectorScript 不是 unavailable）", result.targets.selectorScript !== "unavailable");
    check("P4 mermaid 已改写", patched !== factoryMermaid);
    check("P4 模板插值未退化成 v2{...} 字面量", !/v2\{[^}]+\}/.test(patched), (patched.match(/v2\{[^}]+\}/g) || []).join(" "));
    // 不误伤：把补丁写入的每个 a2k- token 都必须在我们的常量集合里
    // a2k-orig 来自弹层的「随身携带出厂原文」标记；a2k-ctx 来自上下文挡位补丁的定界注释
    const consts = [
      I.patterns.PATCHED_JS_CODE,
      I.patterns.PATCHED_MENU_CODE,
      I.patterns.PATCHED_REF_CODE,
      I.patterns.PATCHED_POPOVER_CODE,
      I.patterns.PATCHED_POPOVER_CALL_CODE,
      I.patterns.CTX_SEL_FN_TEMPLATE,
      I.patterns.CTX_CALL_PATCHED_TEMPLATE,
      I.patterns.CTX_HOST_HOOK_TEMPLATE,
      I.patterns.ROW_FIX_TEMPLATE,
      M.ROW_START,
      M.ROW_END,
      M.modelPanelGuardText("g"),
      "/*a2k-orig:*/",
    ].join("\n");
    const known = new Set([...consts.matchAll(/a2k-[A-Za-z0-9_-]+/g)].map((m) => m[0]));
    const seen = new Set([...patched.matchAll(/a2k-[A-Za-z0-9_-]+/g)].map((m) => m[0]));
    const unknown = [...seen].filter((t) => !known.has(t));
    check("P4 所有 a2k- 均来自补丁常量", unknown.length === 0, `未知: ${unknown.join(" ")}`);

    section("P13 多 package：每一份 chunk 与它自己那份 style.css 都要覆盖到");
    for (const pk of fx.packages) {
      check(`P13 ${pk.pkg} chunk 已打补丁`, isPatched(read(pk.chunk)), "仍是工厂态（该视图会直接显示 __A2K_ 微格式）");
      check(`P13 ${pk.pkg} style.css 上了 CARD_CSS`, read(pk.style).includes("a2k-model-row"), "该 package 的 style.css 没有 a2k CSS");
      // 拼接式注入（函数插在标签后、调用处替换、弹层整函数替换）出错时整个 webview 会加载失败，
      // 而上面两条 `includes` 断言照样 PASS。用 node --check 解析一次打补丁后的 chunk。
      const syntaxTmp = path.join(WORK, `syntax-${pk.pkg}.mjs`);
      fs.writeFileSync(syntaxTmp, read(pk.chunk), "utf8");
      let parses = true;
      try {
        execFileSync(process.execPath, ["--check", syntaxTmp], { stdio: "pipe" });
      } catch {
        parses = false;
      }
      check(`P13 ${pk.pkg} 打过补丁的 chunk 仍是合法 JS`, parses, "拼接错位会让整个 webview 加载失败");
    }

    section("P14 落地守卫：模板里的单参调用 (X) 不是参数声明");
    {
      // 规范名 k 在真机被压成 T；真机里 b 又正好压成 k。
      // 旧判据 [(,]NAME[,)] 会把模板里的单参调用 q(T) 当成「模板声明了 T」，
      // 于是丢掉 k->T 这条改名；k 因此落进 namesCollide 的 others，与 b->k 撞车 → 整条补丁被拒。
      const canonical = "function A(b,k){return q(T)}";
      const content = "function A(k,T){return q(m)}";
      const template = "function A(b){return q(T)+k.x}";
      const span = M.matchMasked(content, canonical);
      check("P14 单参调用不得导致整条改名被拒", !!span && M.renderMatched(template, canonical, span) !== null, "守卫仍把 (X) 误判成参数声明");
    }
    for (const pk of fx.packages) {
      if (gen(pk.factoryChunk) === "v1") {
        const span = M.matchMasked(pk.factoryChunk, P.ORIG_JS_PATTERN);
        check(
          `P14 ${pk.pkg} 选项行补丁可渲染`,
          !!span && M.renderMatched(P.PATCHED_JS_CODE, P.ORIG_JS_PATTERN, span) !== null,
          "该视图会直接显示 __A2K_ 微格式"
        );
      } else {
        check(`P14 ${pk.pkg} 模型面板行补丁（v2）可渲染`, M.applyModelPanelRow(pk.factoryChunk) !== null, "该视图会直接显示 __A2K_ 微格式");
      }
    }

    section("P15 每个承载模型选择器的 package 都必须能注入聊天框「上下文」下拉，且注入段能真的渲染");
    {
      // 2026-09-23 实机事故：`resolveTaggedName` 把名字助手写死成 `a(`，而 session-details 那份
      // 是 `o(C1,"useSessionConfig")` → useSessionConfig 恒判「未命中」→ 该视图整体不注入 Ctx 下拉
      // （用户看到的现象：选不了上下文容量）。修完又暴露第二层：模板自己的局部短名（`const k`）
      // 与真机 jsx 运行时名（session-details 是 `k`）撞名，被 namesCollide 拒。
      // 因此这里两件事都要守：**每个 package 都能注入**，且注入段**跑得起来**（桩 jsx + 桩 useSessionConfig）。
      const jsxStub = { jsx: (type, props, key) => ({ type, props: props || {}, key }), Fragment: Symbol("Fragment") };
      jsxStub.jsxs = jsxStub.jsx;
      const findCls = (node, cls) => {
        if (!node || typeof node !== "object") return null;
        if (node.props && node.props.className === cls) return node;
        const kids = node.props && node.props.children;
        for (const k of Array.isArray(kids) ? kids : kids === undefined || kids === null ? [] : [kids]) {
          const hit = findCls(k, cls);
          if (hit) return hit;
        }
        return null;
      };
      const collectOptions = (node, out = []) => {
        if (!node || typeof node !== "object") return out;
        if (node.type === "option") out.push(node.props.value);
        const kids = node.props && node.props.children;
        for (const k of Array.isArray(kids) ? kids : kids === undefined || kids === null ? [] : [kids]) collectOptions(k, out);
        return out;
      };
      /** 选项显示文案与 optgroup 标签：文案回归（a2kFmt）与「有没有 auto 组」都靠它断言。 */
      const collectLabels = (node, out = { options: [], groups: [] }) => {
        if (!node || typeof node !== "object") return out;
        if (node.type === "option") out.options.push(String(node.props.children));
        if (node.type === "optgroup") out.groups.push(String(node.props.label));
        const kids = node.props && node.props.children;
        for (const k of Array.isArray(kids) ? kids : kids === undefined || kids === null ? [] : [kids]) collectLabels(k, out);
        return out;
      };
      const render = (segment, jsxName, uscName, options, calls) => {
        const fn = new Function(jsxName, uscName, `${segment}\nreturn a2kCtxSel;`);
        return fn(jsxStub, () => [options, (id, v) => calls.push([id, v])]);
      };
      // 与 CPS 真实广播同形：6 段（末位是末行标记）
      const micro = "__A2K_MDL__|1|1|272000|32768,65536,131072,200000,262144,272000~codex~1~272000~codex|0";
      const cfgOf = (description) => [
        {
          category: "model",
          type: "select",
          currentValue: "gpt-5.6-terra",
          options: [{ value: "gpt-5.6-terra", name: "gpt-5.6-terra", ...(description === undefined ? {} : { description }) }],
        },
      ];
      for (const pk of fx.packages) {
        const factory = pk.factoryChunk;
        const applied = M.applyCtxSelector(factory);
        check(`P15 ${pk.pkg} 能注入 Ctx 下拉`, !!applied, "该视图的「上下文」下拉会整体消失（用户选不了上下文容量）");
        check(`P15 ${pk.pkg} 注入段带定界标记`, !!applied && applied.includes(M.CTX_START) && applied.includes(M.CTX_END));
        if (!applied) continue;
        // 定界段：用导出常量切，别在这儿再写一遍标记字面量（两处会漂）
        const segStart = applied.indexOf(M.CTX_START);
        const segEnd = applied.indexOf(M.CTX_END, segStart + M.CTX_START.length);
        const segInner = segStart >= 0 && segEnd > segStart ? applied.slice(segStart + M.CTX_START.length, segEnd) : null;
        check(`P15 ${pk.pkg} 定界段可取`, !!segInner);
        if (!segInner) continue;
        // 光有函数体不够：真正让下拉出现在聊天框里的是**调用处接线**（Fragment 包一层，全文只引用一次 a2kCtxSel）。
        // 只查函数体的话，把调用处扔掉照样全绿（实测），而用户看到的正是「没有下拉」。
        const wired = M.applySelectorScript(factory);
        const wireSites = (wired.match(/a2kCtxSel,/g) || []).length;
        check(`P15 ${pk.pkg} 调用处已接线（a2kCtxSel 被引用 1 次）`, wireSites === 1, `引用次数 ${wireSites}`);
        // 真机实际名：jsx 运行时来自 EffortSelector 调用处，useSessionConfig 来自标签反查
        const eff = M.findEffortSelector(factory);
        const effCall = eff ? M.findEffortSelectorCall(factory, eff.fn) : null;
        const jsxName = effCall ? effCall.jsx : null;
        const uscName = M.resolveTaggedName(factory, "useSessionConfig");
        check(
          `P15 ${pk.pkg} 能反查 jsx=${jsxName} / useSessionConfig=${uscName}`,
          !!effCall && !!jsxName && !!uscName,
          `effCall=${!!effCall} jsx=${jsxName} usc=${uscName}`
        );
        if (!effCall || !jsxName || !uscName) continue;
        const calls = [];
        const tree = render(segInner, jsxName, uscName, cfgOf(micro), calls)({});
        const sel = findCls(tree, "a2k-ctx-select");
        check(`P15 ${pk.pkg} 渲染出 <select class="a2k-ctx-select">`, !!sel);
        if (!sel) continue;
        check(`P15 ${pk.pkg} defaultValue = 生效窗口 272000`, sel.props.defaultValue === "272000", String(sel.props.defaultValue));
        check(`P15 ${pk.pkg} disabled 透传（未禁用时为 false）`, sel.props.disabled === false, String(sel.props.disabled));
        const optValues = collectOptions(sel);
        check(
          `P15 ${pk.pkg} 挡位候选 = 6 档（含 32768 / 272000）`,
          optValues.length === 6 && optValues.includes("32768") && optValues.includes("272000"),
          JSON.stringify(optValues)
        );
        // 文案与分组也要断言：a2kFmt 正是当年撞 `const k` 的那段代码，只查 value 对它的回归完全不敏感。
        const optLabels = collectLabels(sel);
        check(
          `P15 ${pk.pkg} 挡位文案按 1024 / 1000 进制（272000→272K、131072→128K）`,
          optLabels.options.includes("272K") && optLabels.options.includes("128K"),
          JSON.stringify(optLabels.options)
        );
        check(
          `P15 ${pk.pkg} 有 auto 组时分组为 auto+manual`,
          optLabels.groups.length === 2 && optLabels.groups[0].startsWith("auto ("),
          JSON.stringify(optLabels.groups)
        );
        // 解析值不在候选里（微格式第 4 位缺失 / 越界）→ 没有 auto 组：给用户的是纯挡位表
        const noAuto = render(
          segInner,
          jsxName,
          uscName,
          cfgOf("__A2K_MDL__|1|1|272000|32768,65536~codex~1~999999~codex|0"),
          []
        )({});
        check(`P15 ${pk.pkg} 解析值不在候选里时不出现 auto 组`, collectLabels(noAuto).groups.length === 0, JSON.stringify(collectLabels(noAuto).groups));
        sel.props.onChange({ target: { value: "200000" } });
        check(
          `P15 ${pk.pkg} 选择后发出 a2k:ctx 覆盖`,
          calls.length === 1 && calls[0][0] === "a2k:ctx" && calls[0][1] === "gpt-5.6-terra|200000",
          JSON.stringify(calls)
        );
        check(`P15 ${pk.pkg} disabled=true 时下拉禁用`, findCls(render(segInner, jsxName, uscName, cfgOf(micro), [])({ disabled: true }), "a2k-ctx-select")?.props.disabled === true);
        check(`P15 ${pk.pkg} 非本扩展列表（无微格式）不渲染`, render(segInner, jsxName, uscName, cfgOf(undefined), [])({}) === null);
        check(`P15 ${pk.pkg} 微格式不足 6 段不渲染`, render(segInner, jsxName, uscName, cfgOf("__A2K_MDL__|1|1|272000"), [])({}) === null);
      }
    }

    section("P16 Context Usage 弹层：该注入的必须真的注入，该跳过的必须说清为什么");
    {
      // 弹层是可选组，两种跳过都算设计内：① 结构不同（1.1.14 的 session-details 把 body 重构成
      // children:[header,breakdown]）；② 命中工厂但真机 jsx 运行时名不是 `b`（applyPopover 的守卫，
      // 防写出指向不存在标识符的 `b.jsx(...)`）。缺的是第三种：「命中且守卫放行却静默没注入」。
      const applied = read(mermaidFile);
      const fac = M.findPopoverFactory(factoryMermaid);
      const jsxOk = !!fac && fac.span.map.get("b") === "b";
      check("P16 agent-chat 命中弹层工厂", !!fac);
      check("P16 agent-chat jsx 运行时名是 b（守卫放行）", jsxOk);
      check(
        "P16 agent-chat 弹层已注入（a2k-cu-head + a2kUsage 传参）",
        applied.includes("a2k-cu-head") && /,a2kUsage:(?:typeof [A-Za-z_$][\w$]*==="undefined"\?void 0:)?[A-Za-z_$][\w$]*\}\)/.test(applied),
        "弹层补丁没落地（视图会退回原生三项百分比）"
      );
      // 回归（`re.c is not a function`）：补丁里的 React Compiler 运行时必须沿用出厂弹层函数用的名字，
      // 不能把模板规范名 `re` 原样落地（1.2.56 里顶层 `re` 是另一个函数）。
      {
        const rt = fac ? fac.span.map.get("re") : undefined;
        const outFn = fac ? new RegExp(`function ${fac.names.fn}\\(t\\)\\{(?:/\\*a2k-orig:[A-Za-z0-9+/=]+\\*/)?const e=([A-Za-z_$][\\w$]*)\\.c\\(30\\)`).exec(applied) : null;
        check("P16 弹层补丁的 .c(30) 运行时名 = 出厂弹层函数用的名字", !!rt && !!outFn && outFn[1] === rt, `factory=${rt} patched=${outFn && outFn[1]}`);
      }
      for (const pk of fx.packages) {
        const f = M.findPopoverFactory(pk.factoryChunk);
        const expectInject = !!f && f.span.map.get("b") === "b";
        const injected = M.applySelectorScript(pk.factoryChunk).includes("a2k-cu-head");
        check(
          `P16 ${pk.pkg} 工厂命中=${!!f} / jsx 名=${f ? f.span.map.get("b") : "n/a"} ⇒ 注入=${injected}`,
          injected === expectInject,
          expectInject ? "命中且守卫放行却没注入" : "该跳过的却注入了"
        );
      }
      // 合成用例：只把命中段里的 jsx 用法改名（= 守卫要拦的形态），断言弹层跳过、其余三处选择器补丁照常
      const jsxRenamed =
        factoryMermaid.slice(0, fac.start) +
        fac.text.replace(/\bb\.jsxs/g, "k.jsxs").replace(/\bb\.jsx(?!s)/g, "k.jsx") +
        factoryMermaid.slice(fac.end);
      const renamedOut = M.applySelectorScript(jsxRenamed);
      check("P16 工厂命中但 jsx≠b ⇒ 弹层跳过（不得写出 b.jsx 悬空引用）", !renamedOut.includes("a2k-cu-head"));
      check("P16 弹层跳过不影响三处选择器补丁", isPatched(renamedOut));
    }

    section("P17 名字判定守卫的边界：字面量不算撞名、标签反查必须唯一且非成员调用");
    {
      // namesCollide：字符串（含模板串）里的词不算「模板里的名字」。旧判据用裸 IDENT_RE，
      // 把 CTX_SEL_FN_TEMPLATE 里 `+"M")` 这类字面量也算进去 → 真机把 jsx 压成 M 时无谓拒绝整条补丁。
      check(
        "P17 namesCollide 不把字符串里的词当成撞名",
        M.namesCollide('function f(b){return b.jsx("option",{children:"M"})}', ["b"], ["M"]) === false
      );
      check("P17 namesCollide 仍拦代码标识符撞名", M.namesCollide("function f(b,k){return k}", ["b"], ["k"]) === true);
      check(
        "P17 namesCollide 仍拦属性名撞名",
        M.namesCollide('function f(b){return b.jsx("span",{disabled:b})}', ["b"], ["disabled"]) === true
      );
      // resolveTaggedName：放宽助手名，但唯一性与「独立调用」不放宽
      check("P17 窄形态唯一命中", M.resolveTaggedName('a(X,"useSessionConfig");', "useSessionConfig") === "X");
      check("P17 宽形态唯一命中", M.resolveTaggedName('o(C1,"useSessionConfig");', "useSessionConfig") === "C1");
      check("P17 窄形态多命中 ⇒ null", M.resolveTaggedName('a(X,"useSessionConfig");a(Y,"useSessionConfig");', "useSessionConfig") === null);
      check("P17 宽形态多命中 ⇒ null", M.resolveTaggedName('o(X,"useSessionConfig");p(Y,"useSessionConfig");', "useSessionConfig") === null);
      check(
        "P17 窄宽混用 ⇒ null（不得静默挑窄的那个）",
        M.resolveTaggedName('a(X,"useSessionConfig");o(Y,"useSessionConfig");', "useSessionConfig") === null
      );
      check("P17 成员调用不算标签", M.resolveTaggedName('ns.a(C1,"useSessionConfig");', "useSessionConfig") === null);
      check("P17 未命中 ⇒ null", M.resolveTaggedName("function f(){return 1}", "useSessionConfig") === null);
      // 已知边界：判定不扫字面量（不给每个多兆 chunk 多跑一次分词），所以字符串里的同形文本也参与计数。
      // 后果是安全侧：多一处就唯一性失败 → null → 宁可不打，绝不挑错名字。
      // 实测 1.1.14 两份 chunk 里 "useSessionConfig" 各只出现 1 次，当前无影响。
      check(
        "P17 字符串里的同形文本只让唯一性失败（安全侧跳过）",
        M.resolveTaggedName('var s=\'a(X,"useSessionConfig");\';a(Y,"useSessionConfig");', "useSessionConfig") === null
      );
    }

    section("P18 chunk 改名回退：承载 chunk 不再叫 mermaid-* 时仍要被找到（本次新增的回退分支）");
    {
      // 真机 fixture 的 assets 里只有 mermaid-*（承载文件恰好也叫 mermaid-*），所以回退分支默认不可达。
      // 把承载 chunk 改成非 mermaid 名再同步一次：回退生效 ⇒ 仍认得出（unchanged，因为已打补丁）；
      // 回退失效 ⇒ 该 package 一张 mermaid-* 都不带标记 → 状态报 unavailable（正是我们要拦的）。
      const renamed = [];
      for (const pk of fx.packages) {
        const target = path.join(path.dirname(pk.chunk), "index-A2KFALLBACK.js");
        fs.renameSync(pk.chunk, target);
        renamed.push({ pk, target });
      }
      try {
        const st = await S.syncGroupHeaderStyle(true);
        check("P18 改名后仍认得出承载 chunk（不是 unavailable）", st.targets.selectorScript === "unchanged", JSON.stringify(st.targets));
        for (const { pk, target } of renamed) {
          check(
            `P18 ${pk.pkg} 改名后的 chunk 仍带补丁`,
            isPatched(read(target)),
            "回退分支漏掉了整个视图（会显示 __A2K_ 微格式、也没有 Ctx 下拉）"
          );
        }
      } finally {
        for (const { pk, target } of renamed) {
          if (fs.existsSync(target)) fs.renameSync(target, pk.chunk);
        }
        await S.syncGroupHeaderStyle(true);
      }
    }

    section("P19 宿主转发钩子：a2k:ctx 得能进到 kiro-agent 的 setSessionConfigOption（点下拉没反应就是这里漂了）");
    {
      const hostFile = path.join(ROOT, "extensions/kiro.kiro-agent/dist/extension.js");
      const hostFactory = M.restoreCtxHostHook(read(hostFile));
      const hooked = M.applyCtxHostHook(hostFactory);
      check("P19 宿主钩子可注入（__a2kSessionConfigOption 转发）", hooked !== hostFactory && hooked.includes("__a2kSessionConfigOption"));
      check("P19 宿主钩子幂等（再打一次不变）", M.applyCtxHostHook(hooked) === hooked);
      check("P19 宿主钩子可复原", M.restoreCtxHostHook(hooked) === hostFactory);
      // 从出厂态同步一次：extras.ctxHost 必须如实报 applied（不是 unavailable / 空）
      fs.writeFileSync(hostFile, hostFactory, "utf8");
      const st = await S.syncGroupHeaderStyle(true);
      check("P19 extras.ctxHost 如实上报 applied", st.extras.ctxHost === "applied", JSON.stringify(st.extras));
      check("P19 真机文件里钩子已落地", read(hostFile).includes("__a2kSessionConfigOption"));
    }

    section("P20 A/B/C 收口：逐 package 记账、真机助手名、store 名 typeof 兜底");
    {
      // C：调用处写 typeof 兜底形态（store 名被压缩器改掉时退回原生三项视图，而不是抛 ReferenceError）
      const appliedAll = read(mermaidFile);
      check("P20 调用处用 typeof 兜底写 store", appliedAll.includes(',a2kUsage:typeof n==="undefined"?void 0:n}'), "写入形态不是 typeof 兜底");
      const legacyForm = appliedAll.replace(/,a2kUsage:typeof [A-Za-z_$][\w$]*==="undefined"\?void 0:[A-Za-z_$][\w$]*\}\)/, ",a2kUsage:n})");
      check(
        "P20 旧形态（a2kUsage:n）仍能还原为出厂",
        M.restoreSelectorScript(legacyForm) === factoryMermaid,
        "真机上已经打过的旧补丁还原不了（下次激活会留下孤儿）"
      );

      // B：写入的 displayName 标签用真机助手名，不是模板里的规范名 `a`
      const fac = M.findPopoverFactory(factoryMermaid);
      check("P20 命中段读出了真机助手名", !!fac && typeof fac.tagger === "string" && fac.tagger.length > 0);
      const appliedPopover = M.applySelectorScript(factoryMermaid);
      check(
        `P20 写入的标签用真机助手名 ${fac ? fac.tagger : "?"}`,
        !!fac && appliedPopover.includes(`${fac.tagger}(${fac.names.fn},"ContextUsagePopover");`)
      );
      // B 合成用例：把真机助手名换成 `o`（= 1.1.14 的 session-details 那份的形态）。旧实现拿规范名 `a`
      // 逐字比对，这里会整条不再注入；新实现必须仍注入，且能逐字还原回「改名后的出厂」。
      const taggerRenamed = fac
        ? factoryMermaid.replace(`${fac.tagger}(${fac.names.fn},"ContextUsagePopover");`, `o(${fac.names.fn},"ContextUsagePopover");`)
        : factoryMermaid;
      const renamedFac = M.findPopoverFactory(taggerRenamed);
      check("P20 助手名改成 o 后仍能命中弹层工厂", !!renamedFac && renamedFac.tagger === "o");
      const renamedApplied = M.applySelectorScript(taggerRenamed);
      check("P20 助手名改成 o 后仍会注入", renamedApplied.includes("a2k-cu-head"));
      check(
        "P20 写入的标签跟着用 o",
        !!renamedFac && renamedApplied.includes(`o(${renamedFac.names.fn},"ContextUsagePopover");`)
      );
      check(
        "P20 改名后的补丁能逐字还原回改名后的出厂",
        M.restoreSelectorScript(renamedApplied) === taggerRenamed,
        "还原侧仍写死 `a`，会把标签写错"
      );

      // A（chunk 级）：一个 package 的靶点不命中 ⇒ 不许整体报 applied，detail 要点名，CSS 逐份隔离
      {
        const missedPkg = fx.packages[fx.packages.length - 1];
        const keptPkg = fx.packages[0];
        const broken =
          gen(missedPkg.factoryChunk) === "v1"
            ? missedPkg.factoryChunk.replace('className:"chat-input-popup-option"', 'className:"chat-input-popup-optionX"')
            : missedPkg.factoryChunk.replace('"ModelOptionRow"', '"ModelOptionRowX"');
        check("P20 前置：破坏靶点后确实打不上", !isPatched(M.applySelectorScript(broken)));
        fs.writeFileSync(missedPkg.chunk, broken, "utf8");
        try {
          const st = await S.syncGroupHeaderStyle(true);
          check("P20 chunk 级半套：状态不得是 applied", st.status !== "applied", JSON.stringify({ status: st.status, detail: st.detail }));
          check("P20 chunk 级半套：detail 点名漏掉的那份", !!st.detail && st.detail.includes(missedPkg.pkg), String(st.detail));
          check("P20 chunk 级半套：detail 点名落地的那份", !!st.detail && st.detail.includes(keptPkg.pkg), String(st.detail));
          check("P20 落地那份仍带补丁", isPatched(read(keptPkg.chunk)));
          check("P20 落地那份保留 CARD_CSS", read(keptPkg.style).includes("a2k-model-row"));
          check("P20 漏掉那份不落 CARD_CSS（不留半套外观）", !read(missedPkg.style).includes("a2k-model-row"));
        } finally {
          fs.writeFileSync(missedPkg.chunk, missedPkg.factoryChunk, "utf8");
          await S.syncGroupHeaderStyle(true);
        }
      }

      // A（可选组级）：一个 package 拿不到 Ctx 注入 ⇒ extras 不得报 applied（本次事故正是这形态被报成成功）
      {
        const missedPkg = fx.packages[fx.packages.length - 1];
        const broken = missedPkg.factoryChunk
          .replace('"EffortSelector"', '"EffortSelectorRenamed"')
          .replace('"ModelSelector"', '"ModelSelectorRenamed"');
        check("P20 前置：改名后该 package 注入不了 Ctx", !M.applyCtxSelector(broken));
        fs.writeFileSync(missedPkg.chunk, broken, "utf8");
        try {
          const st = await S.syncGroupHeaderStyle(true);
          check("P20 Ctx 半套注入：extras.ctxSelector 不得报 applied", st.extras.ctxSelector !== "applied", JSON.stringify(st.extras));
          check("P20 Ctx 半套注入：其余三处靶点仍算落地", isPatched(read(fx.packages[0].chunk)));
        } finally {
          fs.writeFileSync(missedPkg.chunk, missedPkg.factoryChunk, "utf8");
          await S.syncGroupHeaderStyle(true);
        }
      }
    }

    section("P11 重复同步（等同重载窗口后再激活）：不得误报 unavailable、不得把 CSS 剥掉");
    {
      // 第二次开启时磁盘上已是「渲染过的补丁」（标识符是真机压缩名），不是规范模板。
      // 状态判定必须认出补丁已在位，否则会被当成「靶点不命中」，进而让 styleEnabled=false 把 CARD_CSS 剥掉。
      const st = read(fx.style);
      const mm = read(mermaidFile);
      check("P11 前置：style.css 带 a2k CSS", st.includes("a2k-model-row"), "第一次开启后 CSS 就不在");
      check("P11 前置：mermaid 带补丁", isPatched(mm));
      const second = await S.syncGroupHeaderStyle(true);
      check("P11 第二次开启不报 unavailable", second.targets.selectorScript !== "unavailable", JSON.stringify(second.targets));
      check("P11 第二次开启后 style.css 仍有 a2k CSS", read(fx.style).includes("a2k-model-row"), "CSS 被剥掉了（模型卡片失去样式）");
      check("P11 第二次开启后 mermaid 仍有补丁", isPatched(read(mermaidFile)), "JS 补丁被抹掉了");
    }

    section("P9 关闭：还原到与 factory 逐字一致");
    const off = await S.syncGroupHeaderStyle(false);
    check("P9 status=removed", off.status === "removed", JSON.stringify(off));
    check("P9 mermaid 与 factory 逐字一致", read(mermaidFile) === factoryMermaid);
    check("P9 style 与 factory 逐字一致", read(fx.style) === factoryStyle);
    for (const pk of fx.packages) {
      check(`P9 ${pk.pkg} chunk 还原为 factory`, read(pk.chunk) === pk.factoryChunk);
      check(`P9 ${pk.pkg} style.css 还原为 factory`, read(pk.style) === pk.factoryStyle);
    }

    section("P5/P6 幂等与往返");
    const before = read(mermaidFile);
    await S.syncGroupHeaderStyle(false);
    check("P5 restore 幂等（再次关闭不改动文件）", read(mermaidFile) === before);
    const onceRestored = read(mermaidFile);
    await S.syncGroupHeaderStyle(true);
    const p1 = read(mermaidFile);
    await S.syncGroupHeaderStyle(false);
    check("P6 restore(apply(factory)) === factory", read(mermaidFile) === factoryMermaid && onceRestored === factoryMermaid);
    await S.syncGroupHeaderStyle(true);
    await S.syncGroupHeaderStyle(true);
    check("P5 apply 幂等（连开两次不再变更）", read(mermaidFile) === p1);
    await S.syncGroupHeaderStyle(false);

    section("P10 factory 态空转");
    const idle = await S.syncGroupHeaderStyle(false);
    check("P10 status=unchanged", idle.status === "unchanged", JSON.stringify(idle));

    section("P7 历史变体：1.0.411 形态的孤儿补丁仍能清掉");
    {
      const legacyRef = 'ref:a(O=>{m.current[x]=O;if(O&&C&&!O.dataset.a2kScrolled){O.dataset.a2kScrolled="1";setTimeout(()=>{O.scrollIntoView({block:"center",behavior:"instant"});},10);}},"ref")';
      const legacyMenu = 'className:"chat-input-popup-menu a2k-model-selector-menu"';
      let txt = factoryMermaid.replace(P.ORIG_REF_PATTERN, legacyRef).replace('className:"chat-input-popup-menu"', legacyMenu);
      const restored = I.matchers.restoreSelectorScript(txt);
      check("P7 旧版 ref 孤儿被清掉", !restored.includes("a2kScrolled"));
      check("P7 旧版菜单类被清掉", !restored.includes("a2k-model-selector-menu"));
    }

    section("P12 判定诚实：靶点不命中而剥掉 CSS 时，日志不得声称 applied");
    {
      globalThis.__a2kInfo = [];
      await S.syncGroupHeaderStyle(true);
      check("P12 前置：CSS 在位", read(fx.style).includes("a2k-model-row"), "前置状态不对");
      // 构造「出厂结构被改写、靶点确实不该打」的真机形态：先归一出厂，再改掉选项行的结构锚。
      // 每个 package 都要破坏——只要还有一份带补丁，patchedPresent 就为真，整体会被判成 unchanged。
      for (const pk of fx.packages) {
        // 两代锚点都要破坏：v1 认 "chat-input-popup-option" 选项行，v2 认 "ModelOptionRow" 标签
        const broken = I.matchers
          .restoreSelectorScript(read(pk.chunk))
          .split('"chat-input-popup-option"')
          .join('"chat-input-popup-option-broken"')
          .split('"ModelOptionRow"')
          .join('"ModelOptionRow-broken"');
        fs.writeFileSync(pk.chunk, broken, "utf8");
      }
      globalThis.__a2kInfo = [];
      const res = await S.syncGroupHeaderStyle(true);
      const styleLines = (globalThis.__a2kInfo || []).filter((l) => String(l).includes("style.css"));
      const styleLine = styleLines.join(" | ");
      check("P12 靶点不命中 → selectorScript unavailable", res.targets.selectorScript === "unavailable", JSON.stringify(res.targets));
      check("P12 CSS 确被剥掉", !read(fx.style).includes("a2k-model-row"), "CSS 还在，场景没构造成功");
      check("P12 日志不得声称 applied card model selector style", !styleLines.some((l) => String(l).includes("applied card model selector style")), styleLine);
      check("P12 日志应记为 restored original Kiro style", styleLines.some((l) => String(l).includes("restored original Kiro style")), styleLine);
      // 复原现场
      for (const pk of fx.packages) fs.writeFileSync(pk.chunk, pk.factoryChunk, "utf8");
      await S.syncGroupHeaderStyle(false);
    }

    section("P21 v2 行 props 改写（a2kRowFix）：普通行原样、分组标题不可交互且转义、徽章节点正确");
    {
      const jsxStub = { jsx: (type, props, key) => ({ type, props: props || {}, key }), Fragment: Symbol("Fragment") };
      jsxStub.jsxs = jsxStub.jsx;
      const v2Pkgs = fx.packages.filter((pk) => gen(pk.factoryChunk) === "v2");
      if (v2Pkgs.length === 0) console.log("      · 本 fixture 没有 v2 package，跳过");
      for (const pk of v2Pkgs) {
        const hit = M.findModelPanelRow(pk.factoryChunk);
        const applied = M.applyModelPanelRow(pk.factoryChunk);
        const head = M.ROW_START + "function a2kRowFix(";
        const at = applied ? applied.indexOf(head) : -1;
        const end = at >= 0 ? applied.indexOf(M.ROW_END, at) : -1;
        check(`P21 ${pk.pkg} 定界段可取`, at >= 0 && end > at);
        if (!(at >= 0 && end > at)) continue;
        const seg = applied.slice(at + M.ROW_START.length, end);
        const fix = new Function(hit.jsx, `${seg}\nreturn a2kRowFix;`)(jsxStub);
        const mk = (description) => ({ item: { option: { value: "m", name: "m", ...(description === undefined ? {} : { description }) }, matches: [] }, rowId: "r", isSelected: true, isActive: true, itemProps: { onClick() {} } });
        const plainEmpty = mk("");
        const plainNone = mk(undefined);
        const plainText = mk("Kiro official model");
        check(`P21 ${pk.pkg} 普通行（description 空串）原样返回同一对象`, fix(plainEmpty) === plainEmpty);
        check(`P21 ${pk.pkg} 普通行（无 description）原样返回同一对象`, fix(plainNone) === plainNone);
        check(`P21 ${pk.pkg} 普通行（官方描述）原样返回同一对象`, fix(plainText) === plainText);
        const grp = fix(mk("__A2K_GRP__|<img onerror=x>|3|O|openai|"));
        check(`P21 ${pk.pkg} 分组标题 aria-disabled`, grp.itemProps && grp.itemProps["aria-disabled"] === "true", JSON.stringify(grp.itemProps));
        check(`P21 ${pk.pkg} 分组标题 data-a2k-grp`, grp.itemProps && grp.itemProps["data-a2k-grp"] === "1");
        check(`P21 ${pk.pkg} 分组标题不显示选中 / 高亮`, grp.isSelected === false && grp.isActive === false);
        const grpNode = grp.item.option.description;
        check(`P21 ${pk.pkg} 分组标题 description 是 a2k-card-head 节点`, !!grpNode && grpNode.props.className === "a2k-card-head");
        const html = grpNode && grpNode.props.dangerouslySetInnerHTML ? grpNode.props.dangerouslySetInnerHTML.__html : "";
        check(`P21 ${pk.pkg} 分组名 HTML 已转义`, html.includes("&lt;img") && !html.includes("<img onerror"), html.slice(0, 200));
        check(`P21 ${pk.pkg} openai 图标走内置 SVG`, html.includes('<span class="a2k-logo"><svg'));
        const calls = [];
        grp.itemProps.onClick({ preventDefault: () => calls.push("pd"), stopPropagation: () => calls.push("sp") });
        check(`P21 ${pk.pkg} 分组标题点击被阻断`, calls.includes("pd") && calls.includes("sp"), JSON.stringify(calls));
        const mdl = fix(mk("__A2K_MDL__|1|0|272000|32768~codex~1~272000~codex|0"));
        const mdlNode = mdl.item.option.description;
        check(`P21 ${pk.pkg} 推理模型 description 是 a2k-caps-box 节点`, !!mdlNode && mdlNode.props.className === "a2k-caps-box");
        const capsHtml = mdlNode ? mdlNode.props.dangerouslySetInnerHTML.__html : "";
        check(`P21 ${pk.pkg} 徽章含推理、不含图片`, capsHtml.includes("a2k-cap-reason") && !capsHtml.includes("a2k-cap-vision"));
        check(
          `P21 ${pk.pkg} 模型行保留原 itemProps / 选中态（可选中）`,
          typeof mdl.itemProps.onClick === "function" && mdl.itemProps["aria-disabled"] === undefined && mdl.isSelected === true
        );
        const bare = fix(mk("__A2K_MDL__|0|0|272000|32768~codex~1~272000~codex|0"));
        check(`P21 ${pk.pkg} 无徽章模型 description 为 undefined（不显示微格式）`, bare.item.option.description === undefined);
      }
    }

    section("P22 v2 writeModel 守卫：分组标题的 modelId 写不进会话");
    {
      for (const pk of fx.packages.filter((p) => gen(p.factoryChunk) === "v2")) {
        const hit = M.findModelPanelRow(pk.factoryChunk);
        const applied = M.applyModelPanelRow(pk.factoryChunk) || "";
        const g = hit.guardParam;
        const want = `${g}=>{${M.modelPanelGuardText(g)}${g}!==`;
        const i = applied.indexOf(want);
        const w = applied.indexOf('},"writeModel")');
        check(`P22 ${pk.pkg} 守卫紧贴 writeModel 回调头（${g}）`, i >= 0 && w > i && w - i < 600, `i=${i} w=${w}`);
        check(`P22 ${pk.pkg} 往返还原逐字一致`, M.restoreModelPanelRow(applied) === pk.factoryChunk);
        // 守卫语义：插入段本身可执行，分组 id 直接 return，模型 id 放行
        const guardFn = new Function(g, `${M.modelPanelGuardText(g)}return "pass";`);
        check(`P22 ${pk.pkg} 分组 id 被拦下`, guardFn("a2k-group:p1") === undefined);
        check(`P22 ${pk.pkg} 普通模型 id 放行`, guardFn("gpt-5.6-terra") === "pass");
      }
    }
    } // ← P4–P22（真机段落）到此结束

    section("P24 kiro-proxy 前置闸（4.13.66 逐文件）：带残留的文件跳过并点名、干净文件照常打补丁；全部带残留才整轮拒绝");
    {
      const backendFile = I.paths.kiroAgentBackendFile();
      const N = require(path.join(BUILD, "kiroProxyNotice.js"));
      const targetFiles = [...fx.packages.flatMap((p) => [p.chunk, p.style]), backendFile];
      const contents = () => targetFiles.map((f) => read(f));
      const stamp = (f) => {
        const s = fs.statSync(f);
        return `${s.size}:${s.mtimeMs}`;
      };
      const stamps = () => targetFiles.map(stamp);
      const kiroproxyBytes = (texts) => texts.map((t) => (t.match(/kiroproxy-[A-Za-z0-9:_-]*/g) || []).join(","));
      const short = (f) => path.relative(path.join(ROOT, "extensions"), f);
      const sameList = (a, b) => [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

      // 归零到出厂态：关闭路径**不跑**前置闸，只删自己的标记段。
      await S.syncGroupHeaderStyle(false);
      const factoryContents = contents();

      // ① 干净夹具 → 开 → a2k 段必须真的写进去（否则后面「干净文件照常打」的断言是空转）
      const s1 = await S.syncGroupHeaderStyle(true);
      check("P24① 开补丁未被挡住（blockedBy 为空）", s1.blockedBy === undefined, JSON.stringify(s1));
      const after1 = contents();
      const marksAll = I.SELECTOR_PATCH_MARKS;
      let missing = [];
      for (const pk of fx.packages) {
        const chunk = read(pk.chunk);
        const style = read(pk.style);
        if (!marksAll.some((m) => chunk.includes(m))) missing.push(`${pk.pkg} chunk 无 a2k 标记`);
        if (!chunk.includes("a2k-card-head")) missing.push(`${pk.pkg} chunk 无 a2k-card-head`);
        if (!style.includes("a2k-card-head")) missing.push(`${pk.pkg} style.css 无 CARD_CSS`);
        if (gen(pk.factoryChunk) === "v2" && !chunk.includes(M.ROW_FIX_FN)) missing.push(`${pk.pkg} v2 无 a2kRowFix`);
      }
      check("P24① 每个 package 的 a2k 段均已写入", missing.length === 0, missing.join("; "));
      check("P24① 后端钩子已写入", read(backendFile).includes("__kiroModelConfigProvider=t"), read(backendFile).slice(0, 200));
      // 回到出厂态再进 ②（逐文件判定要能从「还没打过补丁」的干净态出发观察）
      targetFiles.forEach((f, i) => fs.writeFileSync(f, factoryContents[i], "utf8"));

      // ② 只给第 0 个 package 的 chunk + style.css 注入 kiroproxy- 残留 ⇒ 这一对跳过，其余干净文件照常打
      const p0 = fx.packages[0];
      const cssResidue = "\n/*kiroproxy-ctxwin-css:r1*/\n.kiroproxy-ctxwin-wrap{display:flex}\n";
      const jsResidue = "/*kiroproxy-toolcard:r1*/var kiroproxyProbe=1;/*kiroproxy-toolcard:end*/";
      fs.appendFileSync(p0.style, cssResidue, "utf8");
      fs.appendFileSync(p0.chunk, jsResidue, "utf8");
      const p0ChunkText = read(p0.chunk);
      const p0StyleText = read(p0.style);
      const p0ChunkStamp = stamp(p0.chunk);
      const p0StyleStamp = stamp(p0.style);
      const proxy2 = kiroproxyBytes(contents());
      const s2 = await S.syncGroupHeaderStyle(true);
      check(
        "P24② blockedBy=kiro-proxy 且 status=unavailable（这一轮有文件被跳过）",
        s2.blockedBy === "kiro-proxy" && s2.status === "unavailable",
        JSON.stringify(s2)
      );
      // 回归（4.13.66 修复）：部分跳过时三个靶点字段也全是 unavailable，所以「是否全部跳过」
      // 只能是显式字段，不能再从 targets 反推。
      check("P24② 部分跳过 ⇒ allSkipped=false（不得由三个 unavailable 反推成整轮拒绝）", s2.allSkipped === false, JSON.stringify(s2));
      {
        const notice = N.buildKiroProxyNotice(s2);
        const text = notice.head + notice.why + notice.hint;
        check("P24② 部分跳过文案不说「未写入任何」且点名被跳过的文件", !text.includes("未写入任何") && text.includes(short(p0.chunk)) && text.includes(short(p0.style)), text);
        check("P24② 部分跳过文案说明其余干净文件已照常打补丁", notice.head.includes("其余干净文件已照常打补丁"), notice.head);
      }
      check(
        "P24② 跳过清单点名带残留的那一对文件（chunk + 同 package 的 style.css）",
        sameList(s2.skippedBy || [], [short(p0.chunk), short(p0.style)]),
        JSON.stringify(s2.skippedBy)
      );
      check("P24② 带残留的 chunk bytes 逐字不变", read(p0.chunk) === p0ChunkText, "带残留的 chunk 被改写了");
      check("P24② 带残留的 style.css bytes 逐字不变", read(p0.style) === p0StyleText, "带残留的 style.css 被改写了");
      check("P24② 带残留的两个文件 mtime 也不变", stamp(p0.chunk) === p0ChunkStamp && stamp(p0.style) === p0StyleStamp, `${stamp(p0.chunk)} / ${stamp(p0.style)} vs ${p0ChunkStamp} / ${p0StyleStamp}`);
      check(
        "P24② 被跳过的两个靶点报 unavailable、干净的后端报 applied",
        s2.targets.style === "unavailable" && s2.targets.selectorScript === "unavailable" && s2.targets.backend === "applied",
        JSON.stringify(s2.targets)
      );
      check("P24② 干净的 backend 照常打上钩子", read(backendFile).includes("__kiroModelConfigProvider=t"), read(backendFile).slice(0, 200));
      const cleanMissing = [];
      for (const pk of fx.packages.slice(1)) {
        if (!marksAll.some((m) => read(pk.chunk).includes(m))) cleanMissing.push(`${pk.pkg} chunk 无 a2k 标记`);
        if (!read(pk.style).includes("a2k-card-head")) cleanMissing.push(`${pk.pkg} style.css 无 CARD_CSS`);
      }
      check("P24② 其它 package（干净）照常打上 a2k 段", cleanMissing.length === 0, cleanMissing.join("; "));
      check("P24② 别人的 kiroproxy- 字节一个都没动", kiroproxyBytes(contents()).every((v, i) => v === proxy2[i]), `${kiroproxyBytes(contents()).join(" | ")} vs ${proxy2.join(" | ")}`);

      // ②b 给**剩下每一个干净文件**也注入残留 ⇒ 全部目标文件都带残留 ⇒ 退回整轮拒绝语义
      for (const f of targetFiles) {
        if (!read(f).includes("kiroproxy-")) {
          fs.appendFileSync(f, `\n/*kiroproxy-toolcard:r1*/var kiroproxyProbe2=1;/*kiroproxy-toolcard:end*/\n`, "utf8");
        }
      }
      const before2b = contents();
      const stamps2b = stamps();
      const s2b = await S.syncGroupHeaderStyle(true);
      check(
        "P24②b 全部带残留 ⇒ status 与三个靶点全 unavailable",
        s2b.status === "unavailable" &&
          s2b.blockedBy === "kiro-proxy" &&
          s2b.targets.style === "unavailable" &&
          s2b.targets.selectorScript === "unavailable" &&
          s2b.targets.backend === "unavailable",
        JSON.stringify(s2b)
      );
      check("P24②b 全部带残留 ⇒ bytes 逐字一致", contents().every((t, i) => t === before2b[i]), "有文件被改写了");
      check("P24②b 全部带残留 ⇒ mtime 逐字一致", stamps().every((t, i) => t === stamps2b[i]), `${stamps().join(" ")} vs ${stamps2b.join(" ")}`);
      check("P24②b 跳过清单覆盖全部目标文件", sameList(s2b.skippedBy || [], targetFiles.map(short)), JSON.stringify(s2b.skippedBy));
      check("P24②b 全部带残留 ⇒ allSkipped=true", s2b.allSkipped === true, JSON.stringify(s2b));
      check("P24②b 有中文 detail 且提到跳过", !!s2b.detail && s2b.detail.includes("跳过"), String(s2b.detail));
      {
        const notice = N.buildKiroProxyNotice(s2b);
        const text = notice.head + notice.why + notice.hint;
        check("P24②b 全部带残留 ⇒ 文案说「本次未写入任何 Kiro 文件」", text.includes("本次未写入任何 Kiro 文件"), text);
      }

      // ③ 关闭：只删自己的段，kiroproxy- 的字节一个都不碰
      const proxy3Before = kiroproxyBytes(contents());
      const s3 = await S.syncGroupHeaderStyle(false);
      const after3 = contents();
      const leftovers = [];
      for (let i = 0; i < targetFiles.length; i++) {
        const t = after3[i];
        for (const m of marksAll) {
          if (t.includes(m)) leftovers.push(`${path.basename(targetFiles[i])}:${m}`);
        }
        if (t.includes("/*a2k-row:")) leftovers.push(`${path.basename(targetFiles[i])}:/*a2k-row:`);
      }
      check("P24③ SELECTOR_PATCH_MARKS 与 /*a2k-row: 全部消失", leftovers.length === 0, leftovers.join(", "));
      check("P24③ kiroproxy- 的字节与第 ③ 步前逐字一致", kiroproxyBytes(after3).every((v, i) => v === proxy3Before[i]), `${kiroproxyBytes(after3).join(" | ")} vs ${proxy3Before.join(" | ")}`);
      check("P24③ 注入的两段残留原文仍在（别人的字节一个都不碰）", after3[0].includes(jsResidue) && after3[1].includes(cssResidue.trim()), "注入段被误删");
      check("P24③ 关闭路径不报 blockedBy", s3.blockedBy === undefined, JSON.stringify(s3));
      // 收尾：把夹具写回出厂态（P24 是最后一个依赖夹具的段落，留着残留会让人工排查误以为脚本写过东西）
      targetFiles.forEach((f, i) => fs.writeFileSync(f, factoryContents[i], "utf8"));
    }

    section("P23 合成 1.1.x 夹具：v1 全链路（选项行 / 菜单 / ref / 弹层 / Ctx）仍能打上并逐字往返");
    {
      const syn = buildSyntheticV1Chunk(M, P);
      check("P23 合成夹具判为 v1", gen(syn) === "v1", gen(syn));
      const applied = M.applySelectorScript(syn);
      for (const mark of ["a2k-model-name-box", "a2k-model-selector-menu", "a2kScrolled", "a2k-cu-head", "a2kCtxSel"]) {
        check(`P23 v1 补丁含 ${mark}`, applied.includes(mark));
      }
      check("P23 v1 夹具不打 v2（无 a2kRowFix）", !applied.includes(M.ROW_FIX_FN));
      const restored = M.restoreSelectorScript(applied);
      check("P23 restore(apply(syn)) === syn", restored === syn);
      check("P23 apply(restore(apply(syn))) === apply(syn)", M.applySelectorScript(restored) === applied);

      // 1.2.56 回归：局部 `c`/`u` 对调、`ne.c(30)` 的 `.c` 是属性（D6：属性名不参与改名）
      const v12 = M.renderTemplate(P.ORIG_POPOVER_PATTERN, ["Bde", "re", "Pde", "u", "c"], ["Ake", "ne", "Cke", "c", "u"]);
      check("P23 1.2.56 形态：属性 .c 不被改名、局部 style:u", v12.includes("ne.c(30)") && v12.includes("style:u,"), v12.slice(0, 260));
      const f12 = M.findPopoverFactory(`${v12};`);
      check("P23 1.2.56 形态弹层函数可命中（fn=Ake）", !!f12 && f12.names.fn === "Ake", f12 ? JSON.stringify(f12.names) : "null");
    }

    console.log(
      `\n${pass} passed, ${fail} failed, ${skippedSections} section(s) skipped  (workdir ${WORK})` +
        (fx.real ? "" : "  [--synthetic：项数单独记录，不与 AC-3 的 176 混用]")
    );
    process.exitCode = fail ? 1 : 0;
  })().catch((e) => {
    console.error("\nverification crashed:", e);
    process.exitCode = 1;
  });
}

main();
