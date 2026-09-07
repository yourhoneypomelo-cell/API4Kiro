// selectorStyle 补丁可逆性断言。先 `node tests/selector/build.js`，再 `node tests/selector/run.js`。
// 只在 %TEMP% 下的临时目录里构造假 Kiro 安装树，绝不触碰真实 Kiro 安装目录。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const here = __dirname;
const repo = path.resolve(here, "..", "..");
const built = path.join(here, ".build", "selectorStyle.js");
if (!fs.existsSync(built)) {
  console.error("missing .build/selectorStyle.js — run `node tests/selector/build.js` first");
  process.exit(2);
}
const mod = require(built);
const { syncGroupHeaderStyle, triggerKiroModelRefresh, __selectorStyleInternals: I } = mod;
const P = I.patterns;
const M = I.matchers;

const FIX = path.join(here, "fixtures");
const MERMAID_BIG = "mermaid-GHXKKRXX-IUK0bIya.js";
const MERMAID_SMALL = "mermaid-mWjccvbQ.js";
const fixture = {
  css: fs.readFileSync(path.join(FIX, "style.css"), "utf8"),
  mermaid: fs.readFileSync(path.join(FIX, MERMAID_BIG), "utf8"),
  mermaidSmall: fs.readFileSync(path.join(FIX, MERMAID_SMALL), "utf8"),
  backend: fs.readFileSync(path.join(FIX, "extension.js"), "utf8"),
};
// 用户真机 Kiro 1.0.437 的只读副本（由 %TEMP% 一次性脚本从 D:\Kiro 复制；不存在则跳过对应用例）
const COPY437 = path.join(repo, ".verify-artifacts", "kiro-copy-1.0.437");
const REL_AGENT = path.join("extensions", "kiro.kiro-agent");
const REL_CHAT = path.join(REL_AGENT, "packages", "kiro-ui-agent-chat", "dist");

// ---------- helpers ----------
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function count(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}
const tmpRoots = [];
const bigNameOf = new Map(); // root → 大 mermaid 文件名（1.0.411 与 1.0.437 的 hash 后缀不同；sync 只按 mermaid-*.js 前缀扫描）
function makeTree(files, bigName = MERMAID_BIG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-selector-"));
  tmpRoots.push(root);
  bigNameOf.set(root, bigName);
  const agent = path.join(root, "extensions", "kiro.kiro-agent");
  const chat = path.join(agent, "packages", "kiro-ui-agent-chat", "dist");
  fs.mkdirSync(path.join(chat, "assets"), { recursive: true });
  fs.mkdirSync(path.join(agent, "dist"), { recursive: true });
  fs.writeFileSync(path.join(chat, "style.css"), files.css, "utf8");
  fs.writeFileSync(path.join(chat, "assets", bigName), files.mermaid, "utf8");
  fs.writeFileSync(path.join(chat, "assets", MERMAID_SMALL), files.mermaidSmall, "utf8");
  fs.writeFileSync(path.join(agent, "dist", "extension.js"), files.backend, "utf8");
  process.env.A2K_TEST_APP_ROOT = root;
  return root;
}
function treePaths(root) {
  const agent = path.join(root, "extensions", "kiro.kiro-agent");
  const chat = path.join(agent, "packages", "kiro-ui-agent-chat", "dist");
  return {
    css: path.join(chat, "style.css"),
    mermaid: path.join(chat, "assets", bigNameOf.get(root) || MERMAID_BIG),
    mermaidSmall: path.join(chat, "assets", MERMAID_SMALL),
    backend: path.join(agent, "dist", "extension.js"),
    dirs: [chat, path.join(chat, "assets"), path.join(agent, "dist")],
  };
}
function readTree(root) {
  const p = treePaths(root);
  return {
    css: fs.readFileSync(p.css, "utf8"),
    mermaid: fs.readFileSync(p.mermaid, "utf8"),
    mermaidSmall: fs.readFileSync(p.mermaidSmall, "utf8"),
    backend: fs.readFileSync(p.backend, "utf8"),
  };
}
function hashes(t) {
  return { css: sha(t.css), mermaid: sha(t.mermaid), mermaidSmall: sha(t.mermaidSmall), backend: sha(t.backend) };
}
function tmpLeftovers(root) {
  const out = [];
  for (const d of treePaths(root).dirs) {
    for (const f of fs.readdirSync(d)) if (f.endsWith(".tmp")) out.push(path.join(d, f));
  }
  return out;
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg);
}
const eqJson = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);
function eqHashes(actual, expected, label) {
  for (const k of Object.keys(expected)) eq(actual[k], expected[k], `${label}: ${k} sha256 differs`);
}
function replaceOnce(hay, needle, repl) {
  const i = hay.indexOf(needle);
  ok(i >= 0, `replaceOnce: needle not found (${needle.slice(0, 40)}...)`);
  return hay.slice(0, i) + repl + hay.slice(i + needle.length);
}
/** 剥掉补丁函数里随身携带的 a2k-orig 标记（4.13.44 起），剥后才能与 PATCHED_POPOVER_CODE 模板逐字比较。 */
const stripCarry = (js) => js.replace(M.POPOVER_CARRY_MARK_RE, "");
/** 按 JS 标识符边界统计某个名字出现的次数（不算子串命中）。 */
function identCount(hay, name) {
  return (hay.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g")) || []).length;
}
/** 按标识符边界改名（Map：旧名 → 新名），同一趟替换。 */
function renameIdents(str, map) {
  return str.replace(/(?<![\w$])[A-Za-z_$][\w$]*/g, (n) => (map.has(n) ? map.get(n) : n));
}
const POPOVER_MARKERS = ["a2k-", "a2kScrolled", "a2kUsage", "__a2k", "__A2K_", "api4kiro", "__kiroModelConfigProvider", "cursor-legend-dot", "cursor-context-", "cursor-row-left"];
function markerCounts(text) {
  const out = {};
  for (const mk of POPOVER_MARKERS) {
    const c = count(text, mk);
    if (c) out[mk] = c;
  }
  return out;
}
/** 当前补丁态的弹层函数：按携带标记定位，返回 {fn, base64, span}；找不到返回 null。 */
function carriedPopover(js) {
  const m = js.match(M.POPOVER_CARRY_RE);
  return m ? { fn: m[1], base64: m[2], span: m[0], start: m.index } : null;
}

const ORIG_MERMAID = [
  "ORIG_JS_PATTERN",
  "ORIG_MENU_PATTERN",
  "ORIG_REF_PATTERN",
  "ORIG_TRIGGER_PATTERN",
  "ORIG_POPOVER_PATTERN",
  "ORIG_POPOVER_CALL_PATTERN",
];
const PATCHED_MERMAID = [
  "PATCHED_JS_CODE",
  "PATCHED_MENU_CODE",
  "PATCHED_REF_CODE",
  "PATCHED_POPOVER_CODE",
  "PATCHED_POPOVER_CALL_CODE",
];
// 当前没有任何 ORIG 串被原样包在其 PATCHED 串里（4.13.37 前 MCP / Steering 两行曾如此）
const SUBSTRING_OF_PATCHED = new Set();
// 4.13.36 及更早的弹层局部补丁（磁盘实拍 fixture 正处于这个状态）
const LEG = I.legacy;
const POPOVER_START = "function Bde(t){";
const POPOVER_END = 'a(Bde,"ContextUsagePopover");';
function popoverSpan(js) {
  const s = js.indexOf(POPOVER_START);
  if (s < 0) return null;
  const e = js.indexOf(POPOVER_END, s);
  if (e < 0) return null;
  return { s, e: e + POPOVER_END.length };
}

// ---------- tiny runner ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 共享状态：出厂态（由 fixture 逆向推导）、补丁态（由出厂态正向打补丁）
let factory; // {css, mermaid, mermaidSmall, backend}
let factoryHash;
let patched;
let patchedHash;

// 选项行补丁区域 [a2k 起点 … 出厂兜底尾巴)，用于把「不同版本补丁」归一后比较其余字节
const OPT_START = 'className:"chat-input-popup-option a2k-exclusive-model-option"';
const OPT_TAIL = P.ORIG_JS_PATTERN.slice(P.ORIG_JS_PATTERN.indexOf('b.jsxs("div",{className:"chat-input-popup-option-content"'));
function optionRowSpan(js) {
  const s = js.indexOf(OPT_START);
  if (s < 0) return null;
  const e = js.indexOf(OPT_TAIL, s);
  if (e < 0) return null;
  return { s, e: e + OPT_TAIL.length };
}
function maskOptionRow(js) {
  const sp = optionRowSpan(js);
  return sp ? js.slice(0, sp.s) + "<<A2K_OPTION_ROW>>" + js.slice(sp.e) : js;
}
// 磁盘实拍的弹层是 4.13.36 局部补丁、调用处未传参；当前补丁是整函数替换 + 传参。比较「其余字节」时把这两块也蒙掉。
function maskVolatile(js) {
  let out = maskOptionRow(js);
  const sp = popoverSpan(out);
  if (sp) out = out.slice(0, sp.s) + "<<A2K_POPOVER>>" + out.slice(sp.e);
  out = out.split(P.PATCHED_POPOVER_CALL_CODE).join("<<A2K_POPOVER_CALL>>").split(P.ORIG_POPOVER_CALL_PATTERN).join("<<A2K_POPOVER_CALL>>");
  return out;
}
// 2026-09-06 实拍：标记块之外的孤儿 CSS 行（旧版本直接追加，无标记）
const STRAY_CSS_LINE = ".a2k-logo svg, .a2k-logo img { display: block !important; width: 12px !important; height: 12px !important; }\n";

// ---------- cases ----------
test("fixture-state: 拷自 D:\\Kiro 的三个文件当前处于补丁态；其中 mermaid 选项行是旧版补丁孤儿、CSS 标记块外有孤儿行", () => {
  eq(count(fixture.css, I.START), 1, "css START");
  eq(count(fixture.css, I.END), 1, "css END");
  const head = fixture.css.slice(0, fixture.css.indexOf(I.START));
  eq(count(head, STRAY_CSS_LINE), 1, "css stray a2k line outside marker block");
  // 选项行：a2k 类名在，但既不是当前 PATCHED_JS_CODE 也不是 ORIG —— 旧版本补丁孤儿
  eq(count(fixture.mermaid, OPT_START), 1, "mermaid a2k option row present");
  eq(count(fixture.mermaid, P.ORIG_JS_PATTERN), 0, "mermaid ORIG_JS_PATTERN");
  eq(count(fixture.mermaid, P.PATCHED_JS_CODE), 0, "mermaid current PATCHED_JS_CODE (stale variant on disk)");
  ok(optionRowSpan(fixture.mermaid), "stale option row bounded by shared tail");
  for (const k of ["PATCHED_MENU_CODE", "PATCHED_REF_CODE"]) eq(count(fixture.mermaid, P[k]), 1, `mermaid ${k}`);
  for (const k of ["ORIG_MENU_PATTERN", "ORIG_REF_PATTERN"]) eq(count(fixture.mermaid, P[k]), 0, `mermaid ${k}`);
  // 弹层：磁盘上是 4.13.36 的函数内四处局部补丁（cursor-* 类名），不是当前整函数替换；调用处还是出厂的
  eq(count(fixture.mermaid, LEG.BDE_PATCHED), 1, "mermaid legacy BDE popover patch");
  eq(count(fixture.mermaid, LEG.CONV_PATCHED), 1, "mermaid legacy conv row");
  eq(count(fixture.mermaid, LEG.MCP_PATCHED), 1, "mermaid legacy mcp row");
  eq(count(fixture.mermaid, LEG.STEERING_PATCHED), 1, "mermaid legacy steering row");
  eq(count(fixture.mermaid, P.ORIG_POPOVER_PATTERN), 0, "mermaid ORIG_POPOVER_PATTERN (patched on disk)");
  eq(count(fixture.mermaid, P.PATCHED_POPOVER_CODE), 0, "mermaid PATCHED_POPOVER_CODE (stale variant on disk)");
  eq(count(fixture.mermaid, P.ORIG_POPOVER_CALL_PATTERN), 1, "mermaid ORIG_POPOVER_CALL_PATTERN (legacy patch never touched the call site)");
  eq(count(fixture.mermaid, P.PATCHED_POPOVER_CALL_CODE), 0, "mermaid PATCHED_POPOVER_CALL_CODE");
  ok(popoverSpan(fixture.mermaid), "popover function bounded by anchors");
  eq(count(fixture.mermaid, P.ORIG_TRIGGER_PATTERN), 1, "mermaid ORIG_TRIGGER_PATTERN (通道 B 未打)");
  eq(count(fixture.mermaid, P.PATCHED_TRIGGER_CODE), 0, "mermaid PATCHED_TRIGGER_CODE");
  eq(count(fixture.backend, P.PATCHED_QPE_PATTERN), 1, "backend PATCHED_QPE_PATTERN");
  eq(count(fixture.backend, P.ORIG_QPE_PATTERN), 0, "backend ORIG_QPE_PATTERN");
});

test("derive-factory: false 逆向推导出厂态；每个 ORIG_* 恰好 1 次、无任何 a2k / api4kiro 残留、无 .tmp", async () => {
  const root = makeTree(fixture);
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "removed", "status");
  eq(r.targets.style, "removed", "targets.style");
  eq(r.targets.selectorScript, "removed", "targets.selectorScript");
  eq(r.targets.backend, "removed", "targets.backend");
  factory = readTree(root);
  factoryHash = hashes(factory);
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");

  eq(count(factory.css, I.START), 0, "css START");
  eq(count(factory.css, "api4kiro"), 0, "css api4kiro");
  eq(count(factory.css, "a2k-"), 0, "css a2k-");
  ok(factory.css.endsWith("}\n"), "css should end with '}\\n' like Kiro's other dist css");
  ok(!factory.css.endsWith("\n\n"), "css should not end with blank line");
  for (const k of ORIG_MERMAID) eq(count(factory.mermaid, P[k]), 1, `mermaid ${k} must hit exactly once`);
  for (const k of PATCHED_MERMAID) eq(count(factory.mermaid, P[k]), 0, `mermaid ${k}`);
  eq(count(factory.mermaid, "a2k-exclusive-model-option"), 0, "mermaid a2k-exclusive");
  eq(count(factory.mermaid, "a2k-model-selector-menu"), 0, "mermaid a2k-menu");
  eq(count(factory.mermaid, "a2kScrolled"), 0, "mermaid a2kScrolled");
  eq(count(factory.mermaid, "cursor-context"), 0, "mermaid cursor-context");
  eq(count(factory.mermaid, "cursor-legend-dot"), 0, "mermaid cursor-legend-dot");
  eq(count(factory.mermaid, "a2k-cu"), 0, "mermaid a2k-cu");
  eq(count(factory.mermaid, "a2kUsage"), 0, "mermaid a2kUsage");
  // 整函数回填后弹层函数逐字等于出厂串
  const sp = popoverSpan(factory.mermaid);
  eq(factory.mermaid.slice(sp.s, sp.e), P.ORIG_POPOVER_PATTERN, "popover function equals factory text");
  eq(count(factory.backend, P.ORIG_QPE_PATTERN), 1, "backend ORIG_QPE_PATTERN");
  eq(count(factory.backend, "__kiroModelConfigProvider"), 0, "backend hook residue");
  eq(sha(factory.mermaidSmall), sha(fixture.mermaidSmall), "small mermaid untouched");
  // 结构匹配器在 1.0.411 出厂态上恰好唯一命中，捕获的名字就是模板名
  const fac = M.findPopoverFactory(factory.mermaid);
  ok(fac && fac.text === P.ORIG_POPOVER_PATTERN, "findPopoverFactory hits the factory function verbatim");
  eqJson(fac.names, { fn: "Bde", warn: "Pde", local: "z" }, "findPopoverFactory names on 1.0.411");
  ok(M.findPopoverCall(factory.mermaid, "Bde"), "findPopoverCall(Bde) hits once");
  eq(M.resolveTaggedName(factory.mermaid, "useSessionConfig"), "l0", "resolveTaggedName(useSessionConfig) on 1.0.411");
  const hook = M.findBackendHook(factory.backend);
  eqJson(hook && { fn: hook.fn, store: hook.store }, { fn: "QPe", store: "Oue" }, "findBackendHook on 1.0.411");
  eq(factory.backend.slice(hook.start, hook.end), P.ORIG_QPE_PATTERN, "backend hook span equals ORIG_QPE_PATTERN");
  eq(M.findPopoverFactory(factory.mermaidSmall), null, "small mermaid has no popover factory");
  eq(M.findBackendHook(factory.mermaid), null, "mermaid has no backend hook structure");
});

test("apply: 出厂态 → true；三处补丁各恰好 1 次；mermaid / extension.js 与磁盘实拍逐字节相同（独立 oracle）", async () => {
  const root = makeTree(factory);
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "applied", "status");
  eq(r.targets.style, "applied", "targets.style");
  eq(r.targets.selectorScript, "applied", "targets.selectorScript");
  eq(r.targets.backend, "applied", "targets.backend");
  patched = readTree(root);
  patchedHash = hashes(patched);
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");

  eq(count(patched.css, I.START), 1, "css START");
  eq(count(patched.css, I.END), 1, "css END");
  eq(count(patched.css, I.CARD_CSS), 1, "css CARD_CSS verbatim");
  // 弹层函数 4.13.44 起随身携带 a2k-orig 标记：剥掉标记后才与模板逐字相等；1.0.411 下名字就是模板名，无需渲染
  for (const k of PATCHED_MERMAID) eq(count(stripCarry(patched.mermaid), P[k]), 1, `mermaid ${k} (carry stripped)`);
  eq(count(patched.mermaid, P.PATCHED_POPOVER_CODE), 0, "verbatim PATCHED_POPOVER_CODE must NOT appear (carry marker sits inside the function)");
  const carried = carriedPopover(patched.mermaid);
  ok(carried, "patched popover carries a2k-orig marker");
  eq(carried.fn, "Bde", "carry: function name captured");
  eq(count(patched.mermaid, "/*a2k-orig:"), 1, "carry: exactly one marker in the file");
  eq(Buffer.from(carried.base64, "base64").toString("utf8"), P.ORIG_POPOVER_PATTERN, "carry: decodes to the factory function verbatim");
  eq(stripCarry(carried.span), P.PATCHED_POPOVER_CODE, "carry: patched function == template once the marker is stripped");
  eq(M.findPopoverFactory(patched.mermaid), null, "structural matcher no longer finds a factory function in the patched file");
  for (const k of ORIG_MERMAID) {
    if (k === "ORIG_TRIGGER_PATTERN") continue;
    eq(count(patched.mermaid, P[k]), SUBSTRING_OF_PATCHED.has(k) ? 1 : 0, `mermaid ${k} must be gone`);
  }
  eq(count(patched.mermaid, "cursor-legend-dot"), 0, "current patch no longer uses legacy cursor-* markup");
  eq(count(patched.backend, P.PATCHED_QPE_PATTERN), 1, "backend PATCHED_QPE_PATTERN");
  eq(count(patched.backend, P.ORIG_QPE_PATTERN), 0, "backend ORIG_QPE_PATTERN");
  // oracle：真机上打出的补丁文件。extension.js 逐字节相同；mermaid 除选项行与弹层（磁盘上都是旧版变体）外逐字节相同
  eq(patchedHash.backend, sha(fixture.backend), "extension.js equals on-disk patched copy");
  eq(sha(maskVolatile(patched.mermaid)), sha(maskVolatile(fixture.mermaid)), "mermaid equals on-disk copy outside the option row and popover");
  ok(optionRowSpan(patched.mermaid) && optionRowSpan(fixture.mermaid), "both have bounded option row");
  ok(popoverSpan(patched.mermaid) && popoverSpan(fixture.mermaid), "both have bounded popover function");
  eq(patchedHash.mermaidSmall, factoryHash.mermaidSmall, "small mermaid untouched");
});

test("stale-variants: 旧版本补丁孤儿（磁盘实拍选项行 + 孤儿 CSS 行 + 其他处的假想变体）→ false 逐字还原出厂；true 升级为当前补丁", async () => {
  const sp = optionRowSpan(fixture.mermaid);
  const staleOptionRow = fixture.mermaid.slice(sp.s, sp.e);
  ok(staleOptionRow !== P.PATCHED_JS_CODE, "on-disk option row is indeed a different variant");
  let mermaid = replaceOnce(factory.mermaid, P.ORIG_JS_PATTERN, staleOptionRow);
  mermaid = replaceOnce(mermaid, P.ORIG_MENU_PATTERN, P.PATCHED_MENU_CODE.replace("a2k-model-selector-menu", "a2k-model-selector-menu a2k-v1"));
  mermaid = replaceOnce(mermaid, P.ORIG_REF_PATTERN, P.PATCHED_REF_CODE.replace("},10);", "},50);"));
  // 弹层旧变体：4.13.36 的函数内局部补丁（再改一处类名模拟更早版本）
  mermaid = replaceOnce(mermaid, LEG.BDE_ORIG, LEG.BDE_PATCHED.replace("seg-conv", "seg-conversation"));
  mermaid = replaceOnce(mermaid, LEG.CONV_ORIG, LEG.CONV_PATCHED.replace("dot-conv", "dot-conversation"));
  mermaid = replaceOnce(mermaid, LEG.MCP_ORIG, LEG.MCP_PATCHED);
  mermaid = replaceOnce(mermaid, P.ORIG_TRIGGER_PATTERN, P.PATCHED_TRIGGER_CODE.replace(">2000)", ">1500)"));
  const backend = replaceOnce(factory.backend, P.ORIG_QPE_PATTERN, "function QPe(t){Oue=t;try{globalThis.__kiroModelConfigProvider=t;globalThis.__a2kProbe=1}catch(_){}}");
  const css = factory.css + STRAY_CSS_LINE + I.START + "\n.a2k-old { color: red; }\n" + I.END + "\n";
  const stale = { ...factory, mermaid, backend, css };

  let root = makeTree(stale);
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "removed", "status");
  eqHashes(hashes(readTree(root)), factoryHash, "stale → false → factory");
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");

  root = makeTree(stale);
  const r2 = await syncGroupHeaderStyle(true);
  eq(r2.status, "applied", "status true");
  eqHashes(hashes(readTree(root)), patchedHash, "stale → true → canonical patched");
});

test("popover-variants: 整函数补丁的未来变体（类名 / 传参名不同）→ false 逐字回填出厂；Kiro 升级后无标记的新函数体绝不被覆盖", async () => {
  // 1. 假想的下一版整函数补丁：类名与 tokens 文案不同，但仍带 a2k-cu 标记
  let mermaid = replaceOnce(factory.mermaid, P.ORIG_POPOVER_PATTERN, P.PATCHED_POPOVER_CODE.replace(/a2k-cu-sw/g, "a2k-cu-swatch").replace("Tokens`", "tok`"));
  mermaid = replaceOnce(mermaid, P.ORIG_POPOVER_CALL_PATTERN, P.PATCHED_POPOVER_CALL_CODE);
  let root = makeTree({ ...factory, mermaid });
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "removed", "future variant → removed");
  eqHashes(hashes(readTree(root)), factoryHash, "future variant → factory");

  // 1b. 带携带标记的未来变体（4.13.44+ 的下一版：类名不同、a2k-cu 标记甚至被改掉）→ 只靠 a2k-orig 解码回填，逐字回到出厂
  const nextBody = P.PATCHED_POPOVER_CODE.replace(/a2k-cu/g, "a2k-ctx").replace("tokens est.", "tok est.");
  ok(!/a2k-cu/.test(nextBody), "constructed a future body without the a2k-cu marker");
  const nextFn = "function Bde(t){" + M.carryMarker(P.ORIG_POPOVER_PATTERN) + nextBody.slice("function Bde(t){".length);
  mermaid = replaceOnce(factory.mermaid, P.ORIG_POPOVER_PATTERN, nextFn);
  mermaid = replaceOnce(mermaid, P.ORIG_POPOVER_CALL_PATTERN, P.PATCHED_POPOVER_CALL_CODE);
  root = makeTree({ ...factory, mermaid });
  const r1b = await syncGroupHeaderStyle(false);
  eq(r1b.status, "removed", "carried future variant → removed");
  eqHashes(hashes(readTree(root)), factoryHash, "carried future variant → factory (decoded from a2k-orig)");
  // 1c. 携带标记被破坏（base64 解码不是函数）→ 守卫不过、标记式路径不动；旧路径按 a2k 标记回填仍能还原
  const badCarry = nextFn.replace(/a2k-orig:[A-Za-z0-9+/=]+/, "a2k-orig:" + Buffer.from("not a function", "utf8").toString("base64")).replace(/a2k-ctx/g, "a2k-cu");
  mermaid = replaceOnce(factory.mermaid, P.ORIG_POPOVER_PATTERN, badCarry);
  eq(M.restoreCarriedPopover(mermaid), mermaid, "restoreCarriedPopover leaves an invalid carry alone");
  root = makeTree({ ...factory, mermaid });
  await syncGroupHeaderStyle(false);
  eqHashes(hashes(readTree(root)), factoryHash, "invalid carry but a2k-cu marker → legacy anchored path restores factory");

  // 2. Kiro 升级：Bde 函数体变了（没有任何 a2k / cursor 标记）、调用处也变了 → sync(false) 必须一个字节都不动
  const upgraded = factory.mermaid
    .replace(P.ORIG_POPOVER_PATTERN, P.ORIG_POPOVER_PATTERN.replace('"Context Usage"', '"Context Window"'))
    .replace(P.ORIG_POPOVER_CALL_PATTERN, P.ORIG_POPOVER_CALL_PATTERN.replace("summarizationThreshold:o", "summarizationThreshold:o,truncation:l"));
  ok(upgraded !== factory.mermaid && count(upgraded, P.ORIG_POPOVER_PATTERN) === 0, "constructed an upgraded Kiro without our markers");
  root = makeTree({ ...factory, mermaid: upgraded });
  const r2 = await syncGroupHeaderStyle(false);
  eq(r2.status, "unchanged", "upgraded factory → unchanged");
  eq(sha(readTree(root).mermaid), sha(upgraded), "upgraded Kiro popover untouched by restore");
  // 3. 同一升级树上 sync(true)：弹层两处不命中 → 只打选择器三处，弹层一字不动（全有或全无）
  const r3 = await syncGroupHeaderStyle(true);
  eq(r3.status, "applied", "selector patches still apply");
  const after = readTree(root).mermaid;
  eq(count(after, P.PATCHED_POPOVER_CODE), 0, "no popover function patch on drifted Kiro");
  eq(count(after, "a2kUsage"), 0, "no call-site patch on drifted Kiro");
  eq(count(after, P.PATCHED_JS_CODE), 1, "selector option row still patched");
});

test("live-fixture-cycle: 磁盘实拍（含孤儿）→ true 升级为当前补丁 → false 回到出厂", async () => {
  const root = makeTree(fixture);
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "applied", "true on live fixture must rewrite stale parts");
  eqHashes(hashes(readTree(root)), patchedHash, "live → true");
  await syncGroupHeaderStyle(false);
  eqHashes(hashes(readTree(root)), factoryHash, "live → true → false");
});

test("renamed-kiro: 合成 Kiro 重新压缩改名版（弹层 Bde→qde / Pde→Ude / z→j、调用处 qde、后端 QPe→XPe / Oue→Fue）→ true 按结构打上并携带出厂原文；false 逐字回到改名版出厂；幂等", async () => {
  // --- 合成：只在弹层函数 span 内按标识符边界改名；调用处换函数名；后端全文按标识符边界改名 ---
  const fac = M.findPopoverFactory(factory.mermaid);
  ok(fac, "factory popover located");
  const renamedFn = renameIdents(fac.text, new Map([["Bde", "qde"], ["Pde", "Ude"], ["z", "j"]]));
  ok(renamedFn !== fac.text && renamedFn.length === fac.text.length, "renamed function differs only in names (same length)");
  eq(count(renamedFn, 'a(qde,"ContextUsagePopover");'), 1, "renamed tag");
  eq(count(renamedFn, "Ude(l)"), 1, "renamed warning fn call");
  eq(identCount(renamedFn, "j"), identCount(fac.text, "z"), "local z → j count preserved");
  let mermaid = factory.mermaid.slice(0, fac.start) + renamedFn + factory.mermaid.slice(fac.end);
  mermaid = replaceOnce(mermaid, P.ORIG_POPOVER_CALL_PATTERN, M.renderTemplate(P.ORIG_POPOVER_CALL_PATTERN, ["Bde"], ["qde"]));
  eq(identCount(mermaid, "Bde"), 0, "no standalone Bde left anywhere in the renamed mermaid");
  eq(count(mermaid, "b.jsx(qde,{livePercentage:i"), 1, "renamed call site");
  const backend = factory.backend.replace(/(?<![\w$])QPe(?![\w$])/g, "XPe").replace(/(?<![\w$])Oue(?![\w$])/g, "Fue");
  eq(count(backend, "function XPe(t){Fue=t}function"), 1, "renamed backend setter followed by getter");
  eq(count(backend, P.ORIG_QPE_PATTERN), 0, "old QPe/Oue gone");
  const renamed = { ...factory, mermaid, backend };
  const renamedHash = hashes(renamed);
  // 结构匹配器在改名版上恰好命中，且名字被正确捕获
  const fac2 = M.findPopoverFactory(mermaid);
  eqJson(fac2 && fac2.names, { fn: "qde", warn: "Ude", local: "j" }, "findPopoverFactory on renamed → qde/Ude/j");
  eq(fac2.text, renamedFn, "findPopoverFactory span equals the renamed function verbatim");
  ok(M.findPopoverCall(mermaid, "qde"), "findPopoverCall(qde) hits once");
  eq(M.findPopoverCall(mermaid, "Bde"), null, "findPopoverCall(Bde) misses on renamed");
  const hook2 = M.findBackendHook(backend);
  eqJson(hook2 && { fn: hook2.fn, store: hook2.store }, { fn: "XPe", store: "Fue" }, "findBackendHook on renamed → XPe/Fue");

  // --- true：全部打上 ---
  const root = makeTree(renamed);
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "applied", "status");
  eqJson(r.targets, { style: "applied", selectorScript: "applied", backend: "applied" }, "all three targets applied on renamed Kiro");
  const t = readTree(root);
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");
  for (const k of ["PATCHED_JS_CODE", "PATCHED_MENU_CODE", "PATCHED_REF_CODE"]) eq(count(t.mermaid, P[k]), 1, `mermaid ${k}`);
  const carried = carriedPopover(t.mermaid);
  ok(carried, "patched popover carries a2k-orig marker");
  eq(carried.fn, "qde", "carry: patched function keeps Kiro's new name");
  eq(count(t.mermaid, "/*a2k-orig:"), 1, "carry: exactly one marker");
  eq(Buffer.from(carried.base64, "base64").toString("utf8"), renamedFn, "carry: decodes to the renamed factory function verbatim");
  eq(stripCarry(carried.span), M.renderTemplate(P.PATCHED_POPOVER_CODE, M.POPOVER_PATCH_CANON, ["qde", "Ude", "l0"]), "carry: patched body == template rendered with qde/Ude/l0");
  eq(count(carried.span, "[a2kCfg]=l0()"), 1, "patched body calls useSessionConfig (l0)");
  eq(count(carried.span, 'a(qde,"ContextUsagePopover");'), 1, "patched body keeps the qde tag");
  eq(count(carried.span, "Ude(l)"), 1, "patched body calls the renamed warning fn");
  eq(identCount(carried.span, "Bde") + identCount(carried.span, "Pde"), 0, "no template names leak into the patched body");
  eq(identCount(t.mermaid, "Bde"), 0, "no Bde anywhere after patch");
  eq(count(t.mermaid, M.renderTemplate(P.PATCHED_POPOVER_CALL_CODE, ["Bde"], ["qde"])), 1, "call site: b.jsx(qde,{…,a2kUsage:n})");
  eq(count(t.mermaid, P.PATCHED_POPOVER_CALL_CODE), 0, "call site: no Bde-rendered variant");
  eq(count(t.mermaid, ",a2kUsage:n})"), 1, "call site: a2kUsage passed exactly once");
  eq(count(t.mermaid, "a2kUsage"), 2, "a2kUsage: call-site prop + destructure in the patched body");
  eq(count(t.backend, "function XPe(t){Fue=t;try{globalThis.__kiroModelConfigProvider=t}catch(_){}}"), 1, "backend hook rendered with XPe/Fue");
  eq(count(t.backend, "__kiroModelConfigProvider"), 1, "backend hook exactly once");
  eq(count(t.backend, P.PATCHED_QPE_PATTERN), 0, "backend: no QPe/Oue-rendered hook");
  eq(count(t.css, I.CARD_CSS), 1, "css CARD_CSS");
  const patchedRenamedHash = hashes(t);
  eq(patchedRenamedHash.mermaidSmall, renamedHash.mermaidSmall, "small mermaid untouched");

  // --- 幂等：再 true 一次 unchanged、哈希不变 ---
  const r2 = await syncGroupHeaderStyle(true);
  eq(r2.status, "unchanged", "second true is unchanged");
  eqJson(r2.targets, { style: "unchanged", selectorScript: "unchanged", backend: "unchanged" }, "second true: all unchanged");
  eqHashes(hashes(readTree(root)), patchedRenamedHash, "true→true hashes");

  // --- false：逐字回到改名版出厂 ---
  const r3 = await syncGroupHeaderStyle(false);
  eq(r3.status, "removed", "restore status");
  eqJson(r3.targets, { style: "removed", selectorScript: "removed", backend: "removed" }, "restore: all removed");
  eqHashes(hashes(readTree(root)), renamedHash, "renamed → true → false == renamed factory (sha256)");
  eq(tmpLeftovers(root).length, 0, "tmp leftovers after restore");
});

if (fs.existsSync(COPY437)) {
  test("real-copy-1.0.437: 用户真机只读副本（选择器已打 / 弹层未打 / CSS 带标记块）→ false 归一出厂并按结构定位 qde/Ude/j 与 XPe/Fue → true 全部打上 → false 逐字回到出厂；幂等", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(COPY437, "MANIFEST.json"), "utf8"));
    const assetsDir = path.join(COPY437, REL_CHAT, "assets");
    const names = fs.readdirSync(assetsDir).filter((f) => /^mermaid-.*\.js$/.test(f));
    const bigName = names.map((f) => ({ f, size: fs.statSync(path.join(assetsDir, f)).size })).sort((a, b) => b.size - a.size)[0].f;
    ok(bigName !== MERMAID_BIG, `copy is a different Kiro build (big mermaid ${bigName})`);
    const live = {
      css: fs.readFileSync(path.join(COPY437, REL_CHAT, "style.css"), "utf8"),
      mermaid: fs.readFileSync(path.join(assetsDir, bigName), "utf8"),
      mermaidSmall: names.includes(MERMAID_SMALL) ? fs.readFileSync(path.join(assetsDir, MERMAID_SMALL), "utf8") : fixture.mermaidSmall,
      backend: fs.readFileSync(path.join(COPY437, REL_AGENT, "dist", "extension.js"), "utf8"),
    };
    // 现状：4.13.43 在 1.0.437 上只打上了选择器三处（弹层 / 后端因逐字靶点失配被放行），CSS 标记块已落下
    eq(count(live.mermaid, P.PATCHED_JS_CODE), 1, "live: selector option row patched (current variant)");
    eq(count(live.mermaid, P.ORIG_POPOVER_PATTERN) + count(live.mermaid, "a2k-cu") + count(live.mermaid, "a2kUsage"), 0, "live: popover not patched and Bde template absent");
    eq(count(live.backend, "__kiroModelConfigProvider"), 0, "live: backend not hooked");
    eq(count(live.css, I.START), 1, "live: css marker block present");

    // --- 归一到出厂 ---
    const root = makeTree(live, bigName);
    const r0 = await syncGroupHeaderStyle(false);
    ok(r0.status === "removed" || r0.status === "unchanged", `normalize status ${r0.status}`);
    const fac0 = readTree(root);
    const facHash0 = hashes(fac0);
    for (const [k, v] of Object.entries(fac0)) eqJson(markerCounts(v), {}, `normalized ${k} carries no plugin markers`);
    ok(fac0.css.endsWith("}\n"), "normalized css ends like a Vite build");
    const fac = M.findPopoverFactory(fac0.mermaid);
    ok(fac, "findPopoverFactory hits once on the normalized 1.0.437 mermaid");
    if (manifest.expect && manifest.expect.popover) eqJson(fac.names, manifest.expect.popover, "popover names match MANIFEST expect");
    ok(fac.names.fn !== "Bde" && fac.names.warn !== "Pde", `names really drifted (${JSON.stringify(fac.names)})`);
    eq(fac.text.length, P.ORIG_POPOVER_PATTERN.length, "factory span has the template length");
    eq(M.renderTemplate(fac.text, [fac.names.fn, fac.names.warn, fac.names.local], M.POPOVER_FACTORY_CANON), P.ORIG_POPOVER_PATTERN, "1.0.437 factory function differs from the 1.0.411 template only by the three names");
    ok(M.findPopoverCall(fac0.mermaid, fac.names.fn), "findPopoverCall hits once with the drifted name");
    const useSess = M.resolveTaggedName(fac0.mermaid, "useSessionConfig");
    ok(useSess, "useSessionConfig tag resolved");
    if (manifest.expect && manifest.expect.useSessionConfig) eq(useSess, manifest.expect.useSessionConfig, "useSessionConfig name matches MANIFEST expect");
    const hook = M.findBackendHook(fac0.backend);
    ok(hook, "findBackendHook hits once on 1.0.437 backend");
    if (manifest.expect && manifest.expect.backend) eqJson({ fn: hook.fn, store: hook.store }, manifest.expect.backend, "backend names match MANIFEST expect");
    ok(hook.fn !== "QPe" && hook.store !== "Oue", `backend names really drifted (${hook.fn}/${hook.store})`);
    eq(fac0.backend.slice(hook.start, hook.end), M.renderTemplate(P.ORIG_QPE_PATTERN, M.BACKEND_CANON, [hook.fn, hook.store]), "backend hook span == ORIG_QPE_PATTERN rendered with drifted names");
    console.log(`      1.0.437 names: popover fn=${fac.names.fn} warn=${fac.names.warn} local=${fac.names.local} | useSessionConfig=${useSess} | backend ${hook.fn}/${hook.store}`);

    // --- true：全部打上 ---
    const r1 = await syncGroupHeaderStyle(true);
    eq(r1.status, "applied", "apply status");
    eqJson(r1.targets, { style: "applied", selectorScript: "applied", backend: "applied" }, "all three targets applied on real 1.0.437 copy");
    const t = readTree(root);
    eq(tmpLeftovers(root).length, 0, "tmp leftovers");
    for (const k of ["PATCHED_JS_CODE", "PATCHED_MENU_CODE", "PATCHED_REF_CODE"]) eq(count(t.mermaid, P[k]), 1, `mermaid ${k}`);
    const carried = carriedPopover(t.mermaid);
    ok(carried, "popover patched with carry marker");
    eq(carried.fn, fac.names.fn, "patched popover keeps Kiro's name");
    eq(Buffer.from(carried.base64, "base64").toString("utf8"), fac.text, "carry decodes to the 1.0.437 factory function");
    eq(stripCarry(carried.span), M.renderTemplate(P.PATCHED_POPOVER_CODE, M.POPOVER_PATCH_CANON, [fac.names.fn, fac.names.warn, useSess]), "patched body == template rendered with real names");
    eq(count(t.mermaid, M.renderTemplate(P.PATCHED_POPOVER_CALL_CODE, ["Bde"], [fac.names.fn])), 1, "call site patched with real name");
    eq(count(t.mermaid, ",a2kUsage:n})"), 1, "a2kUsage passed once at the call site");
    eq(count(t.mermaid, "a2kUsage"), 2, "a2kUsage: call-site prop + destructure in the patched body");
    eq(count(t.backend, M.renderTemplate(P.PATCHED_QPE_PATTERN, M.BACKEND_CANON, [hook.fn, hook.store])), 1, "backend hooked with real names");
    eq(count(t.backend, "__kiroModelConfigProvider"), 1, "backend hook once");
    eq(count(t.css, I.CARD_CSS), 1, "css CARD_CSS");
    eq(sha(t.mermaidSmall), facHash0.mermaidSmall, "small mermaid untouched");
    const patchedHash437 = hashes(t);

    // --- 幂等 ---
    const r2 = await syncGroupHeaderStyle(true);
    eq(r2.status, "unchanged", "second true unchanged");
    eqHashes(hashes(readTree(root)), patchedHash437, "true→true hashes");

    // --- false：逐字回到归一后的出厂 ---
    const r3 = await syncGroupHeaderStyle(false);
    eq(r3.status, "removed", "restore status");
    eqHashes(hashes(readTree(root)), facHash0, "1.0.437 → true → false == normalized factory (sha256)");
    eq(tmpLeftovers(root).length, 0, "tmp leftovers after restore");
  });
} else {
  console.log(`SKIP  real-copy-1.0.437: ${path.relative(repo, COPY437)} not present`);
}

test("restore-roundtrip: 补丁态 → false；三个文件 SHA-256 与出厂完全相等", async () => {
  const root = makeTree(patched);
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "removed", "status");
  eqHashes(hashes(readTree(root)), factoryHash, "after restore");
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");
});

test("idempotent true→true: 第二次 unchanged，文件不变", async () => {
  const root = makeTree(factory);
  await syncGroupHeaderStyle(true);
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "unchanged", "status");
  eq(r.targets.style, "unchanged", "targets.style");
  eq(r.targets.selectorScript, "unchanged", "targets.selectorScript");
  eq(r.targets.backend, "unchanged", "targets.backend");
  eqHashes(hashes(readTree(root)), patchedHash, "after true→true");
});

test("idempotent false→false: 出厂态上 false 为 unchanged，且不写文件", async () => {
  const root = makeTree(factory);
  const p = treePaths(root);
  const before = { css: fs.statSync(p.css).mtimeMs, mermaid: fs.statSync(p.mermaid).mtimeMs, backend: fs.statSync(p.backend).mtimeMs };
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "unchanged", "status");
  eqHashes(hashes(readTree(root)), factoryHash, "after false→false");
  eq(fs.statSync(p.css).mtimeMs, before.css, "css mtime");
  eq(fs.statSync(p.mermaid).mtimeMs, before.mermaid, "mermaid mtime");
  eq(fs.statSync(p.backend).mtimeMs, before.backend, "backend mtime");
});

test("drift-mermaid: 选项行靶点改一个字符 → true 不写 mermaid、不追加 CSS、返回 unavailable；false 回到漂移前", async () => {
  const drifted = {
    ...factory,
    mermaid: replaceOnce(factory.mermaid, P.ORIG_JS_PATTERN, P.ORIG_JS_PATTERN.replace("tabIndex:S?0:-1", "tabIndex:S?0:-2")),
  };
  const driftedHash = hashes(drifted);
  const root = makeTree(drifted);
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "unavailable", "status");
  eq(r.targets.selectorScript, "unavailable", "targets.selectorScript");
  eq(r.targets.style, "unchanged", "targets.style (CSS 不能单独落下)");
  ok(typeof r.detail === "string" && r.detail.length > 0, "detail present");
  const t = readTree(root);
  eq(sha(t.mermaid), driftedHash.mermaid, "mermaid untouched");
  eq(sha(t.css), driftedHash.css, "css untouched");
  eq(count(t.mermaid, "a2k-"), 0, "no partial a2k patch");
  eq(tmpLeftovers(root).length, 0, "tmp leftovers");
  const r2 = await syncGroupHeaderStyle(false);
  ok(r2.status === "removed" || r2.status === "unchanged", "restore status");
  eqHashes(hashes(readTree(root)), driftedHash, "after false");
});

test("drift-backend: QPe 靶点改一个字符 → extension.js 不写、targets.backend=unavailable；其余仍可逆", async () => {
  const drifted = { ...factory, backend: replaceOnce(factory.backend, P.ORIG_QPE_PATTERN, "function QPe(t){Oue=t;}") };
  const driftedHash = hashes(drifted);
  const root = makeTree(drifted);
  const r = await syncGroupHeaderStyle(true);
  eq(r.targets.backend, "unavailable", "targets.backend");
  eq(r.targets.selectorScript, "applied", "targets.selectorScript");
  eq(r.targets.style, "applied", "targets.style");
  eq(sha(readTree(root).backend), driftedHash.backend, "backend untouched");
  await syncGroupHeaderStyle(false);
  eqHashes(hashes(readTree(root)), driftedHash, "after false");
});

test("channel-b-residue: 旧通道 B 补丁残留 → false 无条件还原到出厂；true 也顺手还原且其余补丁正常", async () => {
  const residue = { ...factory, mermaid: replaceOnce(factory.mermaid, P.ORIG_TRIGGER_PATTERN, P.PATCHED_TRIGGER_CODE) };
  eq(count(residue.mermaid, P.PATCHED_TRIGGER_CODE), 1, "residue constructed");
  let root = makeTree(residue);
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "removed", "status");
  eqHashes(hashes(readTree(root)), factoryHash, "false → factory");

  root = makeTree(residue);
  await syncGroupHeaderStyle(true);
  const t = readTree(root);
  eq(count(t.mermaid, P.PATCHED_TRIGGER_CODE), 0, "trigger residue gone after true");
  eq(count(t.mermaid, P.ORIG_TRIGGER_PATTERN), 1, "trigger original back");
  eqHashes(hashes(t), patchedHash, "true → canonical patched");
});

test("legacy-css-blocks: 历史多块 / 内容不同的标记块 → false 剥干净等于出厂；true 只留当前一块", async () => {
  const legacy =
    factory.css +
    "\n" + I.START + "\n.old-a2k-rule { color: red; }\n" + I.END + "\n\n" +
    I.START + "\n.older-a2k-rule { color: blue; }\n" + I.END + "\n";
  let root = makeTree({ ...factory, css: legacy });
  await syncGroupHeaderStyle(false);
  eq(sha(readTree(root).css), factoryHash.css, "false → factory css");
  root = makeTree({ ...factory, css: legacy });
  await syncGroupHeaderStyle(true);
  const t = readTree(root);
  eq(count(t.css, I.START), 1, "single START");
  eq(count(t.css, ".old-a2k-rule"), 0, "legacy content gone");
  eq(sha(t.css), patchedHash.css, "true → canonical patched css");
});

test("css-scope: CARD_CSS 每条选择器都带 a2k- 专属类，或属于 R22 的 .kiro-context-popover* / .cursor-* 允许集；无 [role=listbox]、无裸 .chat-input-popup-menu、无 :empty", () => {
  const body = I.CARD_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = body.split("}");
  const offenders = [];
  let rules = 0;
  for (const b of blocks) {
    const i = b.indexOf("{");
    if (i < 0) continue;
    const selectors = b.slice(0, i).split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of selectors) {
      rules++;
      const allowed = /a2k-/.test(s) || /^\.kiro-context-popover(\b|-)/.test(s) || /^\.cursor-/.test(s);
      if (!allowed) offenders.push(s);
    }
  }
  ok(rules > 20, `expected many rules, got ${rules}`);
  eq(offenders.length, 0, `unscoped selectors: ${offenders.join(" | ")}`);
  eq(count(I.CARD_CSS, '[role="listbox"]'), 0, "[role=listbox] must not be used");
  eq(count(I.CARD_CSS, ":empty"), 0, ":empty shared selector must not be used");
  ok(!/\.chat-input-popup-menu\s*[,{]/.test(body), "bare .chat-input-popup-menu selector");
  ok(!/\.chat-input-popup-option\s*[,{]/.test(body), "bare .chat-input-popup-option selector");
});

test("replacement-safety: 所有 replace 替换串不含 String.replace 特殊模式（$& $' $` $$ $n）", () => {
  const bad = /\$(\$|&|`|'|\d|<)/;
  for (const [k, v] of Object.entries(P)) ok(!bad.test(v), `${k} contains replace special pattern`);
});

test("readonly-style: style.css 只读 → true 返回 unavailable、文件不变、无 .tmp；恢复可写后 false 幂等", async () => {
  const root = makeTree(factory);
  const p = treePaths(root);
  fs.chmodSync(p.css, 0o444);
  try {
    const r = await syncGroupHeaderStyle(true);
    eq(r.status, "unavailable", "status");
    eq(r.targets.style, "unavailable", "targets.style");
    eq(sha(readTree(root).css), factoryHash.css, "css unchanged");
    eq(tmpLeftovers(root).length, 0, "tmp leftovers");
  } finally {
    fs.chmodSync(p.css, 0o644);
  }
  await syncGroupHeaderStyle(false);
  eqHashes(hashes(readTree(root)), factoryHash, "after restore");
});

test("readonly-mermaid: mermaid 只读 → true 不留半补丁（mermaid 不变、CSS 不落下）、无 .tmp；false 还原", async () => {
  const root = makeTree(factory);
  const p = treePaths(root);
  fs.chmodSync(p.mermaid, 0o444);
  try {
    const r = await syncGroupHeaderStyle(true);
    eq(r.targets.selectorScript, "unavailable", "targets.selectorScript");
    eq(r.status, "unavailable", "status");
    const t = readTree(root);
    eq(sha(t.mermaid), factoryHash.mermaid, "mermaid unchanged");
    eq(sha(t.css), factoryHash.css, "css not applied without selector patch");
    eq(tmpLeftovers(root).length, 0, "tmp leftovers");
  } finally {
    fs.chmodSync(p.mermaid, 0o644);
  }
  await syncGroupHeaderStyle(false);
  eqHashes(hashes(readTree(root)), factoryHash, "after restore");
});

test("readonly-restore: 补丁态下 mermaid 只读 → false 必须报 unavailable + detail（不能谎报 removed）；解锁后 false 回到出厂", async () => {
  const root = makeTree(patched);
  const p = treePaths(root);
  fs.chmodSync(p.mermaid, 0o444);
  try {
    const r = await syncGroupHeaderStyle(false);
    eq(r.status, "unavailable", "status");
    eq(r.targets.selectorScript, "unavailable", "targets.selectorScript");
    ok(typeof r.detail === "string" && /EPERM|EACCES|EBUSY/.test(r.detail), `detail should carry fs error, got ${r.detail}`);
    const t = readTree(root);
    eq(sha(t.mermaid), patchedHash.mermaid, "mermaid still patched (write failed)");
    eq(sha(t.css), factoryHash.css, "css restored independently");
    eq(sha(t.backend), factoryHash.backend, "backend restored independently");
    eq(tmpLeftovers(root).length, 0, "tmp leftovers");
  } finally {
    fs.chmodSync(p.mermaid, 0o644);
  }
  const r2 = await syncGroupHeaderStyle(false);
  eq(r2.status, "removed", "status after unlock");
  eqHashes(hashes(readTree(root)), factoryHash, "after unlock");
});

test("stale-tmp-sweep: 旧进程留下的过期 *.api4kiro-<pid>.tmp（含 0 字节）被清掉；新鲜的与非本插件命名的文件不动", async () => {
  const root = makeTree(factory);
  const p = treePaths(root);
  const assets = path.dirname(p.mermaid);
  const staleOwn = path.join(assets, `${MERMAID_BIG}.api4kiro-60336.tmp`);
  const freshOwn = path.join(assets, `${MERMAID_BIG}.api4kiro-1.tmp`);
  const foreign = path.join(assets, "something-else.tmp");
  const staleCss = `${p.css}.api4kiro-777.tmp`;
  fs.writeFileSync(staleOwn, "");
  fs.writeFileSync(freshOwn, "x");
  fs.writeFileSync(foreign, "y");
  fs.writeFileSync(staleCss, "z");
  const old = (Date.now() - 5 * 60_000) / 1000;
  fs.utimesSync(staleOwn, old, old);
  fs.utimesSync(staleCss, old, old);
  fs.utimesSync(foreign, old, old);
  const r = await syncGroupHeaderStyle(false);
  eq(r.status, "unchanged", "factory + false is unchanged");
  eq(fs.existsSync(staleOwn), false, "stale own tmp removed");
  eq(fs.existsSync(staleCss), false, "stale own css tmp removed");
  eq(fs.existsSync(freshOwn), true, "fresh own tmp kept (may belong to a live process)");
  eq(fs.existsSync(foreign), true, "foreign tmp untouched");
  eqHashes(hashes(readTree(root)), factoryHash, "files untouched");
  fs.unlinkSync(freshOwn);
  fs.unlinkSync(foreign);
});

test("missing-root: appRoot 指向不存在目录 → 不抛错，全部 unavailable", async () => {
  process.env.A2K_TEST_APP_ROOT = path.join(os.tmpdir(), "a2k-selector-does-not-exist-" + Date.now());
  const r = await syncGroupHeaderStyle(true);
  eq(r.status, "unavailable", "status");
  eq(r.targets.style, "unavailable", "style");
  eq(r.targets.selectorScript, "unavailable", "selectorScript");
  eq(r.targets.backend, "unavailable", "backend");
  const r2 = await syncGroupHeaderStyle(false);
  eq(r2.status, "unavailable", "status false");
});

test("concurrent: true/false 并发调用被串行化，终态等于最后一次调用；不出现半补丁", async () => {
  let root = makeTree(factory);
  const [a, b] = await Promise.all([syncGroupHeaderStyle(true), syncGroupHeaderStyle(false)]);
  eq(a.status, "applied", "first applied");
  eq(b.status, "removed", "second removed");
  eqHashes(hashes(readTree(root)), factoryHash, "true,false → factory");
  root = makeTree(factory);
  const [c, d] = await Promise.all([syncGroupHeaderStyle(false), syncGroupHeaderStyle(true)]);
  eq(c.status, "unchanged", "first unchanged");
  eq(d.status, "applied", "second applied");
  eqHashes(hashes(readTree(root)), patchedHash, "false,true → patched");
});

test("host-shutdown-keeps-all: 宿主关闭不碰 Kiro 文件——补丁树原样留到下一个宿主（kiro-agent 先于本扩展激活，加载磁盘上的补丁版）；下一次 sync(true) 三处 unchanged、不写盘、不再提示重载；只有显式 sync(false) 三处全还原", async () => {
  const root = makeTree(factory);
  const a = await syncGroupHeaderStyle(true);
  eq(a.status, "applied", "apply");
  eq(a.targets.style, "applied"); eq(a.targets.selectorScript, "applied"); eq(a.targets.backend, "applied");
  eqHashes(hashes(readTree(root)), patchedHash, "patched tree");
  // 宿主关闭（deactivate）：extension.ts 不再调用 syncGroupHeaderStyle，磁盘上三份文件就是补丁态
  const before = hashes(readTree(root));
  const src = fs.readFileSync(path.join(repo, "src", "extension.ts"), "utf8");
  const deact = src.match(/export async function deactivate\(\)[\s\S]*?\r?\n\}\r?\n/);
  ok(deact, "deactivate found");
  const deactCode = deact[0].replace(/^\s*\/\/.*$/gm, ""); // 只看代码，注释里可以解释为什么不还原
  ok(!/syncGroupHeaderStyle\(/.test(deactCode), "deactivate must not call syncGroupHeaderStyle (would hand factory files to the next host's kiro-agent)");
  ok(!/restoreAll\(/.test(deactCode), "deactivate must not restore endpoints/files either");
  ok(/untouched on host shutdown/.test(deactCode), "deactivate logs that patches were left in place");
  eqHashes(hashes(readTree(root)), before, "tree untouched across host shutdown");
  let t = readTree(root);
  ok(/__kiroModelConfigProvider=t/.test(t.backend), "hook line on disk for the next host's kiro-agent");
  ok(t.css.includes(I.START) && /a2k-cu-bar/.test(t.css), "patched CSS on disk for the next host's webview");
  ok(/a2k-orig:/.test(t.mermaid) && /a2k-model-selector-menu/.test(t.mermaid), "patched mermaid on disk for the next host's webview");
  // 下一个宿主激活：三处 unchanged → afterStyleSync 不提示重载，且一个字节不写
  const c = await syncGroupHeaderStyle(true);
  eq(c.status, "unchanged", "re-apply on already patched tree");
  eq(c.targets.style, "unchanged"); eq(c.targets.selectorScript, "unchanged"); eq(c.targets.backend, "unchanged");
  eqHashes(hashes(readTree(root)), patchedHash, "patched tree again");
  eq(tmpLeftovers(root).length, 0, "no tmp leftovers");
  // 关闭代理 / 关闭样式开关：显式 sync(false) → 三处全还原（可逆性只走用户动作）
  const d = await syncGroupHeaderStyle(false);
  eq(d.status, "removed", "full restore status");
  eq(d.targets.style, "removed"); eq(d.targets.selectorScript, "removed"); eq(d.targets.backend, "removed");
  eqHashes(hashes(readTree(root)), factoryHash, "factory after explicit off");
  // 单参数签名：不再有 keepBackend 之类的半还原选项
  ok(syncGroupHeaderStyle.length === 1, "syncGroupHeaderStyle takes only `enabled`");
  ok(!/keepBackend|StyleSyncOptions/.test(fs.readFileSync(path.join(repo, "src", "selectorStyle.ts"), "utf8")), "no partial-restore option left in selectorStyle.ts");
});

test("trigger-refresh: 通道 A 优先 refreshWithOutcome({force:true,trigger:explicit}) 并按 kind 判定；无该方法退回 refresh({force:true})；抛错 / failed / 无钩子返回 false 并写日志；连续两次变更各触发一次", async () => {
  // info / warn 都镜像到 console；抓 console 输出核对日志文案与 kind
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(["log", a.join(" ")]);
  console.warn = (...a) => logs.push(["warn", a.join(" ")]);
  const outcomeCalls = [];
  const refreshCalls = [];
  try {
    // 1. 两个方法都有：只调 refreshWithOutcome，传 force:true + trigger:"explicit"；kind=updated → true，日志含 kind 与 models 数
    globalThis.__kiroModelConfigProvider = {
      refreshWithOutcome: async (o) => { outcomeCalls.push(o); return { kind: "updated", models: [1, 2, 3] }; },
      refresh: async (o) => { refreshCalls.push(o); },
    };
    eq(await triggerKiroModelRefresh(), true, "updated → true");
    eq(outcomeCalls.length, 1, "refreshWithOutcome called once");
    eq(refreshCalls.length, 0, "legacy refresh not called when refreshWithOutcome exists");
    eq(outcomeCalls[0] && outcomeCalls[0].force, true, "force:true");
    eq(outcomeCalls[0] && outcomeCalls[0].trigger, "explicit", 'trigger:"explicit"');
    ok(logs.some(([lvl, t]) => lvl === "log" && /Channel A/.test(t) && /kind=updated/.test(t) && /models=3/.test(t)), `info log with kind/models: ${JSON.stringify(logs.slice(-1))}`);
    // 2. kind=cached / served-empty → true（缓存命中或空列表都不是失败）
    globalThis.__kiroModelConfigProvider = { refreshWithOutcome: async () => ({ kind: "cached" }) };
    eq(await triggerKiroModelRefresh(), true, "cached → true");
    globalThis.__kiroModelConfigProvider = { refreshWithOutcome: async () => ({ kind: "served-empty", models: [] }) };
    eq(await triggerKiroModelRefresh(), true, "served-empty → true");
    ok(logs.some(([, t]) => /kind=served-empty/.test(t) && /models=0/.test(t)), "served-empty logged with models=0");
    // 3. kind=failed → warn + false；aborted 同样
    logs.length = 0;
    globalThis.__kiroModelConfigProvider = { refreshWithOutcome: async () => ({ kind: "failed" }) };
    eq(await triggerKiroModelRefresh(), false, "failed → false");
    ok(logs.some(([lvl, t]) => lvl === "warn" && /kind=failed/.test(t)), "failed logged as warn");
    globalThis.__kiroModelConfigProvider = { refreshWithOutcome: async () => ({ kind: "aborted" }) };
    eq(await triggerKiroModelRefresh(), false, "aborted → false");
    // 4. 只有旧 refresh：退回 refresh({force:true}) → true
    refreshCalls.length = 0;
    globalThis.__kiroModelConfigProvider = { refresh: async (o) => { refreshCalls.push(o); } };
    eq(await triggerKiroModelRefresh(), true, "legacy refresh → true");
    eq(refreshCalls.length, 1, "refresh called once");
    eq(refreshCalls[0] && refreshCalls[0].force, true, "legacy force:true");
    // 5. 抛错 → false（warn）
    logs.length = 0;
    globalThis.__kiroModelConfigProvider = { refreshWithOutcome: async () => { throw new Error("boom"); } };
    eq(await triggerKiroModelRefresh(), false, "refreshWithOutcome throws → false");
    ok(logs.some(([lvl, t]) => lvl === "warn" && /boom/.test(t)), "throw logged as warn");
    globalThis.__kiroModelConfigProvider = { refresh: async () => { throw new Error("boom2"); } };
    eq(await triggerKiroModelRefresh(), false, "refresh throws → false");
    // 6. 钩子在但没有任何 refresh 方法 / 钩子不在 → false，info 日志说明不可达
    logs.length = 0;
    globalThis.__kiroModelConfigProvider = { notRefresh: 1 };
    eq(await triggerKiroModelRefresh(), false, "no refresh fn → false");
    delete globalThis.__kiroModelConfigProvider;
    eq(await triggerKiroModelRefresh(), false, "absent → false");
    ok(logs.filter(([lvl, t]) => lvl === "log" && /通道 A 钩子不可达/.test(t)).length === 2, "unreachable hook logged (info) for both cases");
    // 7. 连续两次变更：每次都真的打到 Kiro（不存在「第一次成功后不再刷」的闩锁），且每次都带 force:true
    outcomeCalls.length = 0;
    let n = 0;
    globalThis.__kiroModelConfigProvider = {
      refreshWithOutcome: async (o) => { outcomeCalls.push(o); n++; return { kind: "updated", models: new Array(48 - n).fill(0) }; },
    };
    eq(await triggerKiroModelRefresh(), true, "first change → true");
    eq(await triggerKiroModelRefresh(), true, "second change → true");
    eq(outcomeCalls.length, 2, "refreshWithOutcome called once per change (2)");
    ok(outcomeCalls.every((o) => o && o.force === true && o.trigger === "explicit"), "both calls force:true + explicit");
    ok(logs.some(([, t]) => /kind=updated models=47/.test(t)) && logs.some(([, t]) => /kind=updated models=46/.test(t)), "both refreshes logged with their own model counts");
  } finally {
    delete globalThis.__kiroModelConfigProvider;
    console.log = origLog;
    console.warn = origWarn;
  }
});

test("extension-wiring: package.json 声明 extensionDependencies kiro.kiroAgent（与 kiro-agent 同宿主）；refreshActiveSession 调用 triggerKiroModelRefresh 并返回 boolean；providers 变化只在通道 A 失败时才 promptReload 且不阻塞回调链；sidebar.persist 每次都新建通道 A promise；deactivate 保留后端钩子；钩子新写盘时主动提示重载", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  ok(Array.isArray(pkg.extensionDependencies) && pkg.extensionDependencies.some((d) => String(d).toLowerCase() === "kiro.kiroagent"), `extensionDependencies must contain kiro.kiroAgent, got ${JSON.stringify(pkg.extensionDependencies)}`);
  ok(!("extensionKind" in pkg), "extensionKind must stay unset (would fight the affinity grouping)");
  ok(Array.isArray(pkg.activationEvents) && pkg.activationEvents.length > 0, "activationEvents present");

  const src = fs.readFileSync(path.join(repo, "src", "extension.ts"), "utf8");
  const i = src.indexOf('registerCommand("api2kiroDual.refreshActiveSession"');
  ok(i >= 0, "command registration not found");
  const body = src.slice(i, i + 900);
  ok(body.includes("triggerKiroModelRefresh("), "handler does not call triggerKiroModelRefresh");
  ok(/Promise<boolean>\s*=>/.test(body) && /return refreshed;/.test(body), "handler must return the boolean result");
  // providers 变化分支：promptReload("已更新 provider") 必须处于通道 A 失败条件之内，且不 await（不阻塞配置回调链）（静态断言）
  const branch = src.match(/const listAffecting = e\.affectsConfiguration\(`\$\{CONFIG_NS\}\.providers`\);[\s\S]{0,700}?updateStatusBar\(\);/);
  ok(branch, "providers branch not found");
  ok(/const pending = sidebar\?\.channelAResult\(\) \?\? triggerKiroModelRefresh\(\);/.test(branch[0]), "providers branch must take the sidebar's recorded result, else trigger its own refresh");
  ok(/void pending\.then\(\(refreshed\) => \{\s*if \(!refreshed\) \{\s*promptReload\("已更新 provider"\);\s*\}\s*\}\);/.test(branch[0]), 'promptReload("已更新 provider") must sit inside the channel-A-failed condition, settled asynchronously');
  ok(!/await (pending|selfWrite|triggerKiroModelRefresh)/.test(branch[0]), "providers branch must not await channel A (would stall the config chain past the self-write window)");
  eq((branch[0].match(/promptReload\(/g) || []).length, 1, "exactly one promptReload in the providers branch");
  // 其余两处重载提示保持不变
  ok(src.includes('promptReload("已关闭代理", "IDE 恢复官方原生外观")'), "disable-branch prompt unchanged");
  ok(src.includes('promptReload("代理已启用")'), "enable-branch prompt unchanged");
  // sidebar.persist：每次 persist 都在写 settings 前新建 promise（不是一次性闩锁），refreshActiveSession 的结果结算它；channelAResult 只在自写窗口内返回
  const side = fs.readFileSync(path.join(repo, "src", "sidebar.ts"), "utf8");
  const persistBody = side.match(/private async persist\(list: ProviderConfig\[\][\s\S]{0,3000}?\n  \}\n/);
  ok(persistBody, "sidebar.persist not found");
  ok(/this\.channelA = new Promise<boolean>[\s\S]{0,200}?await saveProviders\(list\)/.test(persistBody[0]), "persist must create a fresh channel-A promise (per call) before writing settings");
  ok(/executeCommand<boolean>\("api2kiroDual\.refreshActiveSession"\)\s*\.then\(\(ok\) => settleChannelA\(ok === true\), \(\) => settleChannelA\(false\)\)/.test(persistBody[0]), "persist must settle the promise from the command result");
  ok(/channelAResult\(\): Promise<boolean> \| undefined \{\s*return this\.isSelfWrite\(\) \? this\.channelA : undefined;/.test(side), "channelAResult gated by isSelfWrite");
  // 还原路径：deactivate 不碰 Kiro 文件（三处补丁跨 Reload 留在磁盘，先激活的 kiro-agent 才能加载到补丁版）；
  // 只有 enabled=false 分支与「代理关闭状态下激活」才三处全还原
  const deact = src.match(/export async function deactivate\(\)[\s\S]*?\r?\n\}\r?\n/);
  ok(deact, "deactivate found");
  const deactCode = deact[0].replace(/^\s*\/\/.*$/gm, "");
  ok(!/syncGroupHeaderStyle\(|restoreAll\(/.test(deactCode), "deactivate must leave all three Kiro files untouched");
  ok(/untouched on host shutdown/.test(deactCode), "deactivate logs that patches were left in place");
  ok(!/keepBackend/.test(src), "no partial-restore option in extension.ts");
  ok(/await stopServers\(\);[\s\S]{0,200}await syncGroupHeaderStyle\(false\)\)/.test(src), "enabled=false branch must await a full restore");
  ok(/await restoreAll\(\);\s*void syncGroupHeaderStyle\(false\)/.test(src), "activate-while-disabled must fully restore");
  // 三处任一这一次才写进磁盘（applied）→ 当前宿主的 kiro-agent 已用出厂文件启动 → 主动提示重载一次；激活与样式开关两条路径都走 afterStyleSync
  ok(/function afterStyleSync\(result: StyleSyncResult\): void \{[\s\S]{0,500}?t\.style === "applied" \|\| t\.selectorScript === "applied" \|\| t\.backend === "applied"[\s\S]{0,200}?promptReload\("已写入 Kiro 外观补丁与模型刷新钩子"/.test(src), "afterStyleSync must prompt reload when any of the three files was just written");
  ok(/await startAndOverride\(context, false\);\s*void syncGroupHeaderStyle\(getGroupHeaderStyle\(\)\)\.then\(afterStyleSync\)/.test(src), "activation path must use afterStyleSync");
  ok(/void syncGroupHeaderStyle\(isEnabled\(\) && getGroupHeaderStyle\(\)\)\.then\(afterStyleSync\)/.test(src), "groupHeaderStyle branch must use afterStyleSync");
  ok(/await startAndOverride\(context, true\);\s*void syncGroupHeaderStyle\(getGroupHeaderStyle\(\)\)\.then\(notifyStyleSync\)/.test(src), "enable-toggle branch keeps notifyStyleSync (its own 「代理已启用」 prompt already asks for a reload)");
});

test("cps-contract: cpsServer 组标题条目 modelName 为空串且 description 以 __A2K_GRP__| 开头，与 mermaid 补丁的判定一致", () => {
  const src = fs.readFileSync(path.join(repo, "src", "cpsServer.ts"), "utf8");
  ok(/modelName:\s*""/.test(src), 'cpsServer groupHeaderRow modelName must be ""');
  ok(src.includes("description: `__A2K_GRP__|"), "group header description prefix");
  ok(src.includes("m.description = `__A2K_MDL__|"), "model description prefix");
  ok(P.PATCHED_JS_CODE.includes('k.startsWith("__A2K_GRP__|")'), "patched JS checks __A2K_GRP__");
  ok(P.PATCHED_JS_CODE.includes('k.startsWith("__A2K_MDL__|")'), "patched JS checks __A2K_MDL__");
  ok(P.PATCHED_JS_CODE.includes("||!E||"), "patched JS treats empty name as non-selectable");
  ok(P.PATCHED_JS_CODE.includes('T?.startsWith?.("a2k-group:")'), "patched JS checks a2k-group: id prefix");
});

// ---------- run ----------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`PASS  ${t.name}  (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${t.name}\n      ${(e && e.stack) || e}`);
    }
  }
  if (factory) {
    console.log("\n靶点命中表（出厂态=fixture 逆向推导；补丁态=D:\\Kiro 实拍 fixture）");
    const rows = [];
    for (const k of ORIG_MERMAID) rows.push([k, MERMAID_BIG, count(factory.mermaid, P[k]), count(fixture.mermaid, P[k])]);
    rows.push(["ORIG_QPE_PATTERN", "dist/extension.js", count(factory.backend, P.ORIG_QPE_PATTERN), count(fixture.backend, P.ORIG_QPE_PATTERN)]);
    for (const k of PATCHED_MERMAID) rows.push([k + (k === "PATCHED_POPOVER_CODE" ? "(carry stripped)" : ""), MERMAID_BIG, count(stripCarry(factory.mermaid), P[k]), count(stripCarry(fixture.mermaid), P[k])]);
    if (patched) rows.push(["a2k-orig carry marker", MERMAID_BIG, count(factory.mermaid, "/*a2k-orig:"), count(patched.mermaid, "/*a2k-orig:") + " (canonical patched)"]);
    rows.push(["PATCHED_TRIGGER_CODE", MERMAID_BIG, count(factory.mermaid, P.PATCHED_TRIGGER_CODE), count(fixture.mermaid, P.PATCHED_TRIGGER_CODE)]);
    rows.push(["PATCHED_QPE_PATTERN", "dist/extension.js", count(factory.backend, P.PATCHED_QPE_PATTERN), count(fixture.backend, P.PATCHED_QPE_PATTERN)]);
    rows.push(["START/END 标记", "style.css", count(factory.css, I.START) + "/" + count(factory.css, I.END), count(fixture.css, I.START) + "/" + count(fixture.css, I.END)]);
    console.log("PATTERN | 文件 | 出厂态命中 | 补丁态命中");
    for (const r of rows) console.log(r.join(" | "));
    console.log("\n出厂态 SHA-256（推导）:", factoryHash);
  }
  const leftover = [];
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      leftover.push(r);
    }
    if (fs.existsSync(r)) leftover.push(r);
  }
  if (leftover.length) console.log(`warn: ${leftover.length} temp tree(s) could not be removed under ${os.tmpdir()} (a2k-selector-*); delete manually`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 && passed > 0 ? 0 : 1);
})();
