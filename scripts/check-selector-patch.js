#!/usr/bin/env node
/**
 * check-selector-patch.js — Kiro 本体补丁（src/selectorStyle.ts）的靶点命中率与往返一致性断言。
 *
 * 不 import vscode：把 src/selectorStyle.ts 用 typescript 转译成 CommonJS，用桩替换 `vscode` 与 `./log`，
 * 把 `vscode.env.appRoot` 指到工作区内的一份 Kiro 副本，然后调用**真实的** syncGroupHeaderStyle(true/false)。
 *
 * 断言（任一失败退出码 1）：
 *   A. 命中率：出厂态下每个 ORIG_* 在对应文件恰好 1 次、PATCHED_* 0 次；注入态下反之
 *      （通道 B 除外：始终 ORIG 1 / PATCHED 0；PATCHED 含 ORIG 子串的按包含次数折算）。
 *      POPOVER / POPOVER_CALL / QPE 三对（4.13.44 起按结构匹配、名字用正则捕获）不数逐字：出厂态以
 *      matchers.findPopoverFactory / findPopoverCall / findBackendHook 能否唯一定位为准；注入态以 a2k-orig 携带标记 /
 *      `,a2kUsage:n})` / `__kiroModelConfigProvider=t` 为准，并断言补丁体 == 模板按实际名渲染。
 *   B. 幂等：注入两次哈希相同；还原两次哈希相同。
 *   C. 往返：注入 → 还原后所有文件哈希与出厂态逐字节相同；还原后不残留任何插件标记。
 *   D. 旧版兼容：旧版本打的选项行变体 + 标记块外的孤儿 CSS 行，sync(false) 后仍逐字节回到出厂。
 *   E. 半补丁：某个 mermaid 靶点漂移时，部分注入仍可完整还原；mermaid 全不命中时不得单独追加 CSS。
 *   F. 不留临时文件（*.api4kiro-*.tmp）。
 *   G. stripBlock 纯函数：重复块全部剥掉、无块不变。
 *
 * 用法：
 *   node scripts/check-selector-patch.js [--copy <dir>] [--work <dir>] [--json <file>]
 *   --copy  Kiro 副本目录（保留 extensions/kiro.kiro-agent/... 相对路径），默认 .verify-artifacts/kiro-copy
 *   --work  往返实验的临时目录（每次运行清空重建），默认 .verify-artifacts/roundtrip-work；必须位于本仓 .verify-artifacts/ 内
 *   --json  结果 JSON 输出路径，默认 .verify-artifacts/selector-patch-report.json
 *
 * 本脚本永不触碰 --copy 目录以外的 Kiro 安装目录；--copy / --work 若不在本仓 .verify-artifacts/ 内直接拒绝运行。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const REPO = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(REPO, ".verify-artifacts");
const SRC = path.join(REPO, "src", "selectorStyle.ts");
const REL_STYLE = path.join("extensions", "kiro.kiro-agent", "packages", "kiro-ui-agent-chat", "dist", "style.css");
const REL_ASSETS = path.join("extensions", "kiro.kiro-agent", "packages", "kiro-ui-agent-chat", "dist", "assets");
const REL_BACKEND = path.join("extensions", "kiro.kiro-agent", "dist", "extension.js");
// 只用插件专有片段；裸 "a2k" 会误命中 Kiro 出厂 mermaid 里 punycode TLD 表的 "…ga2kohama…"。
const MARKERS = ["a2k-", "a2kScrolled", "a2kUsage", "__a2k", "__A2K_", "api4kiro", "__kiroModelConfigProvider", "cursor-legend-dot", "cursor-context-", "cursor-row-left"];

// ---------- CLI ----------
function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const COPY_DIR = path.resolve(REPO, argOf("--copy", path.join(".verify-artifacts", "kiro-copy")));
const WORK_DIR = path.resolve(REPO, argOf("--work", path.join(".verify-artifacts", "roundtrip-work")));
const JSON_OUT = path.resolve(REPO, argOf("--json", path.join(".verify-artifacts", "selector-patch-report.json")));

// ---------- 结果收集 ----------
const results = [];
let failures = 0;
const fmt = (ev) => (ev === undefined ? "" : "  —  " + (typeof ev === "string" ? ev : JSON.stringify(ev)));
function check(ok, name, evidence) {
  results.push({ ok: !!ok, name, evidence });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${fmt(evidence)}`);
}
function note(name, evidence) {
  results.push({ ok: null, name, evidence });
  console.log(`INFO  ${name}${fmt(evidence)}`);
}

// ---------- 工具 ----------
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function count(hay, needle) {
  if (!needle) return 0;
  let c = 0;
  let i = 0;
  for (;;) {
    i = hay.indexOf(needle, i);
    if (i < 0) return c;
    c++;
    i += needle.length;
  }
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function listMermaid(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("mermaid-") && f.endsWith(".js")).sort();
}
function findTmp(dir) {
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.api4kiro-\d+\.tmp$/.test(ent.name)) out.push(p);
    }
  })(dir);
  return out;
}

// ---------- 加载 selectorStyle.ts（不 import vscode） ----------
function loadSelectorStyle(appRootRef) {
  const ts = require(path.join(REPO, "node_modules", "typescript"));
  const source = fs.readFileSync(SRC, "utf8");

  // 顶层常量 / 纯函数名，追加成探针导出，不依赖源文件是否自带 __selectorStyleInternals。
  const constNames = [...source.matchAll(/^(?:export\s+)?const\s+(START|END|CARD_CSS|ORIG_\w+|PATCHED_\w+)\s*=/gm)].map((m) => m[1]);
  const fnNames = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(stripBlock|writeAtomic|styleFile|jsDir|kiroAgentBackendFile)\s*\(/gm)].map((m) => m[1]);
  const probeNames = [...new Set([...constNames, ...fnNames])];

  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true, strict: false },
    fileName: SRC,
  });
  const js = out.outputText + `\nmodule.exports.__probe = { ${probeNames.join(", ")} };\n`;

  const logs = [];
  const logStub = new Proxy({}, { get: (_t, k) => (...a) => logs.push([String(k), ...a.map(String)]) });
  const vscodeStub = { env: {} };
  Object.defineProperty(vscodeStub.env, "appRoot", { get: () => appRootRef.value, enumerable: true });

  const m = new Module(SRC, null);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m.require = function (id) {
    if (id === "vscode") return vscodeStub;
    if (id === "./log" || id === "./log.js") return logStub;
    return Module.prototype.require.call(m, id);
  };
  m._compile(js, SRC);
  return { mod: m.exports, probe: m.exports.__probe, logs, probeNames, source };
}

// ---------- 主流程 ----------
(async function main() {
  console.log(`# check-selector-patch  copy=${path.relative(REPO, COPY_DIR)}  work=${path.relative(REPO, WORK_DIR)}`);

  // 安全门：副本与工作目录都必须在本仓 .verify-artifacts 内（绝不指向真实 Kiro 安装目录）。
  const inArtifacts = (p) => path.resolve(p).toLowerCase().startsWith((ARTIFACTS + path.sep).toLowerCase());
  if (!inArtifacts(WORK_DIR) || !inArtifacts(COPY_DIR)) {
    console.error(`REFUSE: --copy and --work must both be inside ${ARTIFACTS}`);
    process.exit(2);
  }
  for (const rel of [REL_STYLE, REL_BACKEND]) {
    if (!fs.existsSync(path.join(COPY_DIR, rel))) {
      console.error(`REFUSE: copy is missing ${rel}`);
      process.exit(2);
    }
  }
  const mermaidNames = listMermaid(path.join(COPY_DIR, REL_ASSETS));
  if (mermaidNames.length === 0) {
    console.error(`REFUSE: copy has no mermaid-*.js under ${REL_ASSETS}`);
    process.exit(2);
  }

  const appRootRef = { value: WORK_DIR };
  const { mod, probe, logs, probeNames } = loadSelectorStyle(appRootRef);
  check(typeof mod.syncGroupHeaderStyle === "function", "load: syncGroupHeaderStyle 可从 src/selectorStyle.ts 转译加载（vscode 已桩）", { probeNames });
  const M = mod.__selectorStyleInternals && mod.__selectorStyleInternals.matchers;
  check(M && ["templateRegex", "renderTemplate", "resolveTaggedName", "findPopoverFactory", "findPopoverCall", "findBackendHook", "POPOVER_CARRY_RE"].every((k) => k in M), "load: __selectorStyleInternals.matchers 暴露结构匹配器", M ? Object.keys(M) : null);
  const stripCarry = (t) => t.replace(M.POPOVER_CARRY_MARK_RE, "");
  const carryOf = (t) => {
    const m = M.POPOVER_CARRY_RE.exec(t);
    return m ? { fn: m[1], base64: m[2], span: m[0] } : null;
  };

  // 配对 ORIG_* ↔ PATCHED_*
  const keyOf = (n) => n.replace(/^(ORIG|PATCHED)_/, "").replace(/_(PATTERN|CODE)$/, "");
  const pairs = probeNames
    .filter((n) => n.startsWith("ORIG_"))
    .map((o) => {
      const k = keyOf(o);
      const p = probeNames.find((n) => n.startsWith("PATCHED_") && keyOf(n) === k);
      return { key: k, orig: o, patched: p, target: /QPE/.test(o) ? "backend" : "mermaid", channelB: /TRIGGER/.test(o), structural: /POPOVER|QPE/.test(o) };
    });
  check(pairs.every((p) => p.patched), "load: 每个 ORIG_* 都有配对 PATCHED_*", pairs.map((p) => `${p.orig}<->${p.patched || "?"}`));
  check(pairs.every((p) => probe[p.orig] !== probe[p.patched]), "load: ORIG 与 PATCHED 字面不同", pairs.map((p) => p.key));
  const containing = pairs.filter((p) => count(probe[p.patched], probe[p.orig]) > 0).map((p) => p.key);
  note("load: PATCHED 里包含 ORIG 子串的靶点（注入态下 ORIG 计数按包含次数折算）", containing);
  note("load: 按结构匹配（名字用正则捕获）而不数逐字的靶点", pairs.filter((p) => p.structural).map((p) => p.key));

  /**
   * 结构靶点在一份文本里的命中：orig = 出厂结构能否唯一定位（0/1），patched = 补丁标记次数。
   * 弹层函数名在出厂态来自 findPopoverFactory，在注入态来自 a2k-orig 携带标记。
   */
  function structuralHits(key, text) {
    if (key === "QPE") {
      return { orig: M.findBackendHook(text) ? 1 : 0, patched: (text.match(M.BACKEND_PATCHED_RE) || []).length };
    }
    const fac = M.findPopoverFactory(text);
    const carried = carryOf(text);
    if (key === "POPOVER") return { orig: fac ? 1 : 0, patched: count(text, "/*a2k-orig:") };
    if (key === "POPOVER_CALL") {
      const fn = fac ? fac.names.fn : carried ? carried.fn : null;
      return { orig: fn ? count(text, M.renderTemplate(probe.ORIG_POPOVER_CALL_PATTERN, ["Bde"], [fn])) : 0, patched: count(text, ",a2kUsage:n})") };
    }
    throw new Error("unknown structural key " + key);
  }

  // CSS 块里未限定到 a2k- 专属类名的选择器（= 会改 Kiro 原生元素外观的规则），供风险清单引用。
  const selectors = [...probe.CARD_CSS.matchAll(/^([^\n/][^\n{]*)\{/gm)].map((m) => m[1].trim()).filter(Boolean);
  const unscoped = selectors.filter((s) => !/a2k-/.test(s));
  note("scope: CARD_CSS 选择器总数 / 未带 a2k- 的选择器", { total: selectors.length, unscoped });

  // 工作目录：从副本重建（排除 *.tmp）
  rmrf(WORK_DIR);
  copyFile(path.join(COPY_DIR, REL_STYLE), path.join(WORK_DIR, REL_STYLE));
  copyFile(path.join(COPY_DIR, REL_BACKEND), path.join(WORK_DIR, REL_BACKEND));
  for (const f of mermaidNames) copyFile(path.join(COPY_DIR, REL_ASSETS, f), path.join(WORK_DIR, REL_ASSETS, f));

  const tmpInCopy = findTmp(COPY_DIR);
  note("copy: 副本里存在的 writeAtomic 临时文件残留", tmpInCopy.map((p) => `${path.relative(COPY_DIR, p)} (${fs.statSync(p).size} B, ${fs.statSync(p).mtime.toISOString()})`));

  const targets = () => {
    const t = { "style.css": path.join(WORK_DIR, REL_STYLE), "extension.js": path.join(WORK_DIR, REL_BACKEND) };
    for (const f of mermaidNames) t[f] = path.join(WORK_DIR, REL_ASSETS, f);
    return t;
  };
  const snapshot = () => {
    const s = {};
    for (const [k, p] of Object.entries(targets())) {
      const buf = fs.readFileSync(p);
      s[k] = { sha256: sha256(buf), size: buf.length, text: buf.toString("utf8") };
    }
    return s;
  };
  const hashesOf = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.sha256]));
  const sizesOf = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.size]));
  const sameHashes = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k].sha256 === b[k].sha256);
  const diffKeys = (a, b) => Object.keys(a).filter((k) => a[k].sha256 !== b[k].sha256);
  const write = (k, text) => fs.writeFileSync(targets()[k], text, "utf8");

  // 命中率表（结构靶点用 structuralHits；其余数逐字）
  function hitTable(snap) {
    const rows = [];
    for (const p of pairs) {
      for (const [k, v] of Object.entries(snap)) {
        if (k === "style.css") continue;
        if (p.target === "backend" && k !== "extension.js") continue;
        if (p.target === "mermaid" && k === "extension.js") continue;
        const h = p.structural ? structuralHits(p.key, v.text) : { orig: count(v.text, probe[p.orig]), patched: count(v.text, probe[p.patched]) };
        if (h.orig || h.patched) rows.push({ pattern: p.key, file: k, orig: h.orig, patched: h.patched, structural: p.structural || undefined });
      }
    }
    return rows;
  }
  function assertHits(snap, state, label) {
    const rows = hitTable(snap);
    const totals = {};
    for (const p of pairs) totals[p.key] = { orig: 0, patched: 0, files: [] };
    for (const r of rows) {
      totals[r.pattern].orig += r.orig;
      totals[r.pattern].patched += r.patched;
      totals[r.pattern].files.push(r.file);
    }
    for (const p of pairs) {
      const t = totals[p.key];
      const factoryLike = state === "factory" || p.channelB;
      const wantPatched = factoryLike ? 0 : 1;
      const wantOrig = factoryLike ? 1 : p.structural ? 0 : count(probe[p.patched], probe[p.orig]);
      check(
        t.orig === wantOrig && t.patched === wantPatched && new Set(t.files).size <= 1,
        `${label}: ${p.key} 命中 ORIG=${wantOrig} PATCHED=${wantPatched}（且只落在一个文件${p.structural ? "；结构定位" : ""}）`,
        { orig: t.orig, patched: t.patched, files: [...new Set(t.files)] }
      );
    }
    // 结构靶点的名字与渲染一致性
    const mermaidTexts = Object.entries(snap).filter(([k]) => k !== "style.css" && k !== "extension.js").map(([, v]) => v.text);
    const backendText = snap["extension.js"].text;
    if (state === "factory") {
      const facs = mermaidTexts.map((t) => M.findPopoverFactory(t)).filter(Boolean);
      const fac = facs[0];
      const text = mermaidTexts.find((t) => M.findPopoverFactory(t));
      check(facs.length === 1 && fac.text.length === probe.ORIG_POPOVER_PATTERN.length, `${label}: 弹层出厂函数按结构唯一定位，长度与模板相同`, fac && { names: fac.names, len: fac.text.length });
      check(fac && M.renderTemplate(fac.text, [fac.names.fn, fac.names.warn, fac.names.local], M.POPOVER_FACTORY_CANON) === probe.ORIG_POPOVER_PATTERN, `${label}: 出厂弹层函数与 1.0.411 模板只差三个名字`, fac && fac.names);
      check(fac && !!M.findPopoverCall(text, fac.names.fn), `${label}: 弹层调用处以实际函数名唯一命中`, fac && fac.names.fn);
      const useSess = text ? M.resolveTaggedName(text, "useSessionConfig") : null;
      check(!!useSess, `${label}: useSessionConfig 压缩名按 a(名,"useSessionConfig") 标签唯一反查`, useSess);
      const hook = M.findBackendHook(backendText);
      check(!!hook && backendText.slice(hook.start, hook.end) === M.renderTemplate(probe.ORIG_QPE_PATTERN, M.BACKEND_CANON, [hook.fn, hook.store]), `${label}: 后端 setter 钩子按结构锚点唯一定位（紧跟 getter、store.getAvailableModels() 存在）`, hook && { fn: hook.fn, store: hook.store });
      note(`${label}: 结构定位到的实际名字`, { popover: fac && fac.names, useSessionConfig: useSess, backend: hook && { fn: hook.fn, store: hook.store } });
    } else {
      const text = mermaidTexts.find((t) => carryOf(t));
      const carried = text ? carryOf(text) : null;
      const decoded = carried ? Buffer.from(carried.base64, "base64").toString("utf8") : "";
      const fac = decoded ? M.findPopoverFactory(decoded) : null;
      const useSess = text ? M.resolveTaggedName(text, "useSessionConfig") : null;
      check(!!carried && !!fac && fac.text === decoded && fac.names.fn === carried.fn, `${label}: 携带标记解码得到完整出厂函数，函数名与补丁函数一致`, carried && { fn: carried.fn, decodedLen: decoded.length, names: fac && fac.names });
      check(!!carried && !!fac && !!useSess && stripCarry(carried.span) === M.renderTemplate(probe.PATCHED_POPOVER_CODE, M.POPOVER_PATCH_CANON, [fac.names.fn, fac.names.warn, useSess]), `${label}: 弹层补丁体（剥掉携带标记）== PATCHED_POPOVER_CODE 按实际名渲染`, fac && { fn: fac.names.fn, warn: fac.names.warn, useSessionConfig: useSess });
      check(!!text && !!fac && count(text, M.renderTemplate(probe.PATCHED_POPOVER_CALL_CODE, ["Bde"], [fac.names.fn])) === 1, `${label}: 弹层调用处 == PATCHED_POPOVER_CALL_CODE 按实际函数名渲染`, fac && fac.names.fn);
      const hookRe = new RegExp(M.BACKEND_PATCHED_RE.source);
      const hm = hookRe.exec(backendText);
      check(!!hm && hm[0] === M.renderTemplate(probe.PATCHED_QPE_PATTERN, M.BACKEND_CANON, [hm[1], hm[2]]), `${label}: 后端钩子 == PATCHED_QPE_PATTERN 按实际名渲染`, hm && { fn: hm[1], store: hm[2] });
      check(!!hm && M.restoreBackendHook(backendText).slice(hm.index, hm.index + probe.ORIG_QPE_PATTERN.length) === M.renderTemplate(probe.ORIG_QPE_PATTERN, M.BACKEND_CANON, [hm[1], hm[2]]), `${label}: restoreBackendHook 把钩子还原成 function <fn>(t){<store>=t}`, hm && { fn: hm[1], store: hm[2] });
    }
    return rows;
  }
  function markerCounts(snap) {
    const out = {};
    for (const [k, v] of Object.entries(snap)) {
      const m = {};
      for (const mk of MARKERS) {
        const c = count(v.text, mk);
        if (c) m[mk] = c;
      }
      out[k] = m;
    }
    return out;
  }
  const noMarkers = (mc) => Object.values(mc).every((m) => Object.keys(m).length === 0);
  function assertCssShape(text, injected, label) {
    const S = probe.START;
    const E = probe.END;
    if (injected) {
      check(count(text, S) === 1 && count(text, E) === 1, `${label}: style.css 恰好一个标记块`, { start: count(text, S), end: count(text, E) });
      check(text.endsWith(E + "\n"), `${label}: style.css 以 END 标记 + 单个换行结尾`, JSON.stringify(text.slice(-40)));
      check(text.includes(probe.CARD_CSS), `${label}: style.css 含完整 CARD_CSS`, { cardCssLen: probe.CARD_CSS.length });
    } else {
      check(count(text, S) === 0 && count(text, E) === 0, `${label}: style.css 无标记块`, { start: count(text, S), end: count(text, E) });
    }
  }

  // ---- 0. 现状 ----
  const s0 = snapshot();
  const m0 = markerCounts(s0);
  const injectedNow = !noMarkers(m0);
  note("state: 副本（=用户 Kiro 现状）标记计数", m0);
  note("state: 副本现状判定", injectedNow ? "INJECTED（已注入）" : "FACTORY（出厂）");
  note("state: 副本现状哈希", hashesOf(s0));
  note("state: 副本现状大小", sizesOf(s0));
  const hits0 = hitTable(s0);
  note("state: 副本现状命中表", hits0);

  // ---- 1. 得到出厂态 ----
  let factory;
  if (injectedNow) {
    const r = await mod.syncGroupHeaderStyle(false);
    factory = snapshot();
    check(r && r.status === "removed", "restore-from-installed: 对已注入副本调用 sync(false) 返回 removed", r);
    const mf = markerCounts(factory);
    check(noMarkers(mf), "restore-from-installed: 还原后所有文件不残留任何插件标记", mf);
    check(diffKeys(s0, factory).length > 0, "restore-from-installed: 还原确实改动了文件", diffKeys(s0, factory));
  } else {
    const r = await mod.syncGroupHeaderStyle(false);
    factory = snapshot();
    check(r && r.status === "unchanged", "factory: 对出厂副本调用 sync(false) 返回 unchanged", r);
    check(sameHashes(s0, factory), "factory: 对出厂副本调用 sync(false) 不改动任何字节", diffKeys(s0, factory));
  }
  note("factory: 出厂态哈希", hashesOf(factory));
  note("factory: 出厂态大小", sizesOf(factory));
  note("factory: style.css 末尾字节（Vite 产物应为 \"}\\n\"）", JSON.stringify(factory["style.css"].text.slice(-12)));
  assertHits(factory, "factory", "hit@factory");
  assertCssShape(factory["style.css"].text, false, "hit@factory");
  const hitFilesMermaid = [...new Set(hitTable(factory).filter((r) => r.file !== "extension.js").map((r) => r.file))];
  const untouched = Object.keys(factory).filter((k) => k !== "style.css" && k !== "extension.js" && !hitFilesMermaid.includes(k));
  note("factory: 含 mermaid 靶点的文件 / 不含任何靶点的 mermaid 文件（后者应全程哈希不变）", { hit: hitFilesMermaid, untouched });

  // ---- 2. 注入 → A ----
  const rA = await mod.syncGroupHeaderStyle(true);
  const A = snapshot();
  check(rA && rA.status === "applied", "inject#1: sync(true) 返回 applied", rA);
  assertHits(A, "patched", "hit@injected");
  assertCssShape(A["style.css"].text, true, "hit@injected");
  check(untouched.every((k) => A[k].sha256 === factory[k].sha256), "inject#1: 无靶点的 mermaid 文件哈希不变", untouched);
  note("inject#1: 哈希 A", hashesOf(A));
  note("inject#1: 大小 A", sizesOf(A));
  if (injectedNow) {
    const d = diffKeys(s0, A);
    note(
      "version: 用户现装注入 vs 当前源码注入是否逐字节一致",
      d.length === 0 ? "一致（现装补丁 == 当前 src/selectorStyle.ts 产物）" : `不一致的文件：${d.join(", ")}（现装补丁来自旧版本常量或块外孤儿；还原以 restore-from-installed 断言为准）`
    );
  }

  // ---- 3. 再注入 → 必须等于 A ----
  const rA2 = await mod.syncGroupHeaderStyle(true);
  const A2 = snapshot();
  check(rA2 && rA2.status === "unchanged", "inject#2: 第二次 sync(true) 返回 unchanged", rA2);
  check(sameHashes(A, A2), "inject#2: 幂等——第二次注入哈希 == A", diffKeys(A, A2));

  // ---- 4. 还原 → 必须等于出厂 ----
  const rR = await mod.syncGroupHeaderStyle(false);
  const R = snapshot();
  check(rR && rR.status === "removed", "restore#1: sync(false) 返回 removed", rR);
  check(sameHashes(R, factory), "restore#1: 往返——还原后哈希 == 出厂态", { diff: diffKeys(R, factory), factory: hashesOf(factory), restored: hashesOf(R) });
  check(noMarkers(markerCounts(R)), "restore#1: 还原后无任何插件标记残留", markerCounts(R));

  // ---- 5. 再还原 → 幂等 ----
  const rR2 = await mod.syncGroupHeaderStyle(false);
  const R2 = snapshot();
  check(rR2 && rR2.status === "unchanged", "restore#2: 第二次 sync(false) 返回 unchanged", rR2);
  check(sameHashes(R2, factory), "restore#2: 幂等——第二次还原哈希 == 出厂态", diffKeys(R2, factory));

  // ---- 6. 临时文件 ----
  check(findTmp(WORK_DIR).length === 0, "tmp: 往返全程不留 *.api4kiro-*.tmp", findTmp(WORK_DIR));

  // ---- 7. 旧版兼容：旧版本选项行变体 + 块外孤儿 CSS，sync(false) 必须回到出厂 ----
  {
    const big = hitFilesMermaid.find((f) => hitTable(factory).some((r) => r.file === f && r.pattern === "JS"));
    if (big) {
      // 旧变体：去掉 4.13.30 才加的 OpenAI SVG 分支（与 2026-09-06 Kiro 1.0.411 实拍孤儿同形）。
      const legacyJs = probe.PATCHED_JS_CODE.replace(/logoHtml=p\[4\]==="openai"\?'<span class=\\"a2k-logo\\">.*?<\/svg><\/span>':/, "logoHtml=");
      check(legacyJs !== probe.PATCHED_JS_CODE && legacyJs.length < probe.PATCHED_JS_CODE.length, "legacy: 已构造旧版 PATCHED_JS_CODE 变体", { len: legacyJs.length, current: probe.PATCHED_JS_CODE.length });
      write(big, factory[big].text.replace(probe.ORIG_JS_PATTERN, legacyJs).replace(probe.ORIG_MENU_PATTERN, probe.PATCHED_MENU_CODE));
      write("style.css", factory["style.css"].text.replace(/\s+$/, "") + "\n.a2k-logo svg, .a2k-logo img { display: block !important; width: 12px !important; height: 12px !important; }\n\n" + probe.CARD_CSS.replace("width: 270px", "width: 324px") + "\n");
      const L = snapshot();
      check(!noMarkers(markerCounts(L)), "legacy: 构造后的副本带旧版标记", markerCounts(L));
      const rl = await mod.syncGroupHeaderStyle(false);
      const LR = snapshot();
      check(rl && rl.status === "removed", "legacy: sync(false) 返回 removed", rl);
      check(sameHashes(LR, factory), "legacy: 旧版变体 + 块外孤儿 CSS 还原后哈希 == 出厂态", { diff: diffKeys(LR, factory), sizes: sizesOf(LR) });
      check(noMarkers(markerCounts(LR)), "legacy: 还原后无任何插件标记残留", markerCounts(LR));
      // 旧变体直接 sync(true)：应升级为当前补丁而不是叠加
      write(big, factory[big].text.replace(probe.ORIG_JS_PATTERN, legacyJs));
      const ru = await mod.syncGroupHeaderStyle(true);
      const U = snapshot();
      check(ru && ru.status === "applied", "legacy: 旧变体上 sync(true) 返回 applied（就地升级）", ru);
      check(sameHashes(U, A), "legacy: 旧变体上 sync(true) 后哈希 == 当前注入态 A", diffKeys(U, A));
      await mod.syncGroupHeaderStyle(false);
      check(sameHashes(snapshot(), factory), "legacy: 实验后工作目录已复位出厂", diffKeys(snapshot(), factory));
    } else {
      check(false, "legacy: 找不到含 JS 靶点的 mermaid 文件", hitTable(factory));
    }
  }

  // ---- 8. 半补丁：破坏一个 mermaid 靶点（模拟 Kiro 漂移），部分注入仍须可逆 ----
  {
    const big = hitFilesMermaid.find((f) => hitTable(factory).some((r) => r.file === f && r.pattern === "POPOVER"));
    if (big) {
      const orig = factory[big].text;
      // 弹层函数体漂移（Kiro 改了标题文案）：结构模板不再命中（不只是名字变了），且函数体里没有我们的标记
      const fac = M.findPopoverFactory(orig);
      const mangled = fac ? orig.slice(0, fac.start) + fac.text.replace('"Context Usage"', '"Context Window"') + orig.slice(fac.end) : orig;
      check(mangled !== orig && M.findPopoverFactory(mangled) === null, "partial: 已构造 POPOVER 靶点漂移副本（结构匹配器不再命中）", { file: big, names: fac && fac.names });
      write(big, mangled);
      const base = snapshot();
      const rp = await mod.syncGroupHeaderStyle(true);
      const P = snapshot();
      const pm = P[big].text;
      check(rp && rp.status === "applied", "partial: 漂移下 sync(true) 仍 applied（其余靶点命中）", rp);
      check(count(pm, probe.PATCHED_JS_CODE) === 1 && count(pm, "/*a2k-orig:") === 0 && count(pm, "a2k-cu") === 0, "partial: 漂移下 JS 选项行补丁命中 1 次、POPOVER 补丁（携带标记 / a2k-cu）0 次", {
        js: count(pm, probe.PATCHED_JS_CODE),
        carry: count(pm, "/*a2k-orig:"),
        a2kcu: count(pm, "a2k-cu"),
      });
      check(count(pm, ",a2kUsage:n})") === 0 && count(pm, "a2kUsage") === 0, "partial: POPOVER 函数不命中时调用处传参也不注入（不留孤儿补丁）", {
        call: count(pm, ",a2kUsage:n})"),
        a2kUsage: count(pm, "a2kUsage"),
      });
      check(pm.includes('"Context Window"'), "partial: 漂移后的 Kiro 新函数体在 sync(true) 后原样保留", { kept: pm.includes('"Context Window"') });
      await mod.syncGroupHeaderStyle(false);
      check(sameHashes(snapshot(), base), "partial: 部分注入后 sync(false) 可完整还原到漂移前（不拿旧出厂串覆盖 Kiro 新函数体）", diffKeys(snapshot(), base));
      write(big, orig);
      check(sameHashes(snapshot(), factory), "partial: 实验后工作目录已复位出厂", diffKeys(snapshot(), factory));
    } else {
      check(false, "partial: 找不到含 POPOVER 靶点的 mermaid 文件", hitTable(factory));
    }
  }

  // ---- 9. 全不命中：mermaid 里所有靶点都消失时，不得单独追加 CSS（否则是「改了外观没功能」的半补丁） ----
  {
    // 把注释插进每个 ORIG 内部（第 1 个字符之后），让它们全部不再逐字命中。
    const drifted = (s) => s[0] + "/*DRIFT*/" + s.slice(1);
    for (const f of hitFilesMermaid) {
      let t = factory[f].text;
      for (const pr of pairs.filter((x) => x.target === "mermaid")) t = t.split(probe[pr.orig]).join(drifted(probe[pr.orig]));
      write(f, t);
    }
    check(
      pairs.filter((x) => x.target === "mermaid").every((pr) => hitFilesMermaid.every((f) => count(fs.readFileSync(targets()[f], "utf8"), probe[pr.orig]) === 0)),
      "drift: 已构造 mermaid 全部靶点不命中的副本"
    );
    const base = snapshot();
    const rd = await mod.syncGroupHeaderStyle(true);
    const D = snapshot();
    check(rd && rd.status === "unavailable", "drift: mermaid 全不命中时 sync(true) 返回 unavailable", rd);
    check(D["style.css"].sha256 === base["style.css"].sha256 && count(D["style.css"].text, probe.START) === 0, "drift: mermaid 全不命中时不追加 CSS 标记块", {
      cssChanged: D["style.css"].sha256 !== base["style.css"].sha256,
      startCount: count(D["style.css"].text, probe.START),
    });
    note("drift: mermaid 全不命中时 extension.js（QPe）是否仍被钩住", D["extension.js"].sha256 !== base["extension.js"].sha256 ? "是（backend 独立命中）" : "否");
    await mod.syncGroupHeaderStyle(false);
    check(sameHashes(snapshot(), base), "drift: sync(false) 回到漂移前状态", diffKeys(snapshot(), base));
    for (const f of hitFilesMermaid) write(f, factory[f].text);
    check(sameHashes(snapshot(), factory), "drift: 实验后工作目录已复位出厂", diffKeys(snapshot(), factory));
  }

  // ---- 10. 写失败不得报成功：把注入态的 mermaid 设为只读，sync(false) 必须返回 unavailable + detail 且文件原样 ----
  {
    const big = hitFilesMermaid[0];
    await mod.syncGroupHeaderStyle(true);
    const injected = snapshot();
    const p = targets()[big];
    fs.chmodSync(p, 0o444);
    let ro;
    try {
      ro = await mod.syncGroupHeaderStyle(false);
    } finally {
      fs.chmodSync(p, 0o666);
    }
    const after = snapshot();
    const renameBlocked = after[big].sha256 === injected[big].sha256;
    note("readonly: 只读属性是否真的阻止了 rename 覆盖（Windows 预期 EPERM）", renameBlocked ? "是" : "否（本平台只读属性不阻止 rename，跳过该断言）");
    if (renameBlocked) {
      check(ro && ro.status === "unavailable", "readonly: mermaid 只读时 sync(false) 不得报 removed，须为 unavailable", ro);
      check(ro && typeof ro.detail === "string" && ro.detail.includes(big), "readonly: unavailable 的 detail 指明写失败的文件", ro && ro.detail);
      check(ro && ro.targets && ro.targets.style === "removed" && ro.targets.backend === "removed", "readonly: 其余两个靶点仍各自完成还原", ro && ro.targets);
      check(!noMarkers(markerCounts(after)) && Object.keys(markerCounts(after)[big]).length > 0, "readonly: 只读文件维持原样（未留半补丁）", markerCounts(after)[big]);
      check(findTmp(WORK_DIR).length === 0, "readonly: 写失败后不留 *.api4kiro-*.tmp", findTmp(WORK_DIR));
    }
    const rfix = await mod.syncGroupHeaderStyle(false);
    check(rfix && rfix.status === "removed" && sameHashes(snapshot(), factory), "readonly: 解除只读后 sync(false) 完成还原并回到出厂", { status: rfix && rfix.status, diff: diffKeys(snapshot(), factory) });
  }

  // ---- 11. 过期临时文件清理：旧版本留下的 <file>.api4kiro-<pid>.tmp（非本进程、>60 s）在下一次 sync 时被清掉 ----
  {
    const p = targets()["style.css"];
    const stale = `${p}.api4kiro-60336.tmp`;
    const fresh = `${p}.api4kiro-${process.pid + 1}.tmp`;
    fs.writeFileSync(stale, "");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(fresh, "");
    const rs = await mod.syncGroupHeaderStyle(false);
    check(!fs.existsSync(stale), "sweep: 过期（10 分钟前、他进程）tmp 已被清掉", { stale: path.basename(stale), exists: fs.existsSync(stale) });
    check(fs.existsSync(fresh), "sweep: 新鲜（<60 s）的他进程 tmp 不动（可能仍在写）", { fresh: path.basename(fresh), exists: fs.existsSync(fresh) });
    fs.rmSync(fresh, { force: true });
    check(rs && rs.status === "unchanged" && sameHashes(snapshot(), factory), "sweep: 清理不改动目标文件", { status: rs && rs.status, diff: diffKeys(snapshot(), factory) });
  }

  // ---- 12. stripBlock 纯函数 ----
  if (typeof probe.stripBlock === "function") {
    const body = "body{}\n";
    const blk = `${probe.START}\n.x{}\n${probe.END}`;
    check(probe.stripBlock(body) === body, "stripBlock: 无块不变", JSON.stringify(probe.stripBlock(body)));
    const once = probe.stripBlock(`${body}\n${blk}\n${blk}\n`);
    check(count(once, probe.START) === 0 && count(once, probe.END) === 0, "stripBlock: 历史重复追加的两块全部剥掉", JSON.stringify(once));
    check(probe.stripBlock(`${body}\n${blk}\n`) === body, "stripBlock: 单块剥掉后等于原文", JSON.stringify(probe.stripBlock(`${body}\n${blk}\n`)));
    check(probe.stripBlock(factory["style.css"].text) === factory["style.css"].text, "stripBlock: 出厂 CSS 一个字节不动", factory["style.css"].size);
  } else {
    check(false, "stripBlock: 源文件缺少顶层 stripBlock 函数");
  }

  // ---- 收尾 ----
  check(findTmp(WORK_DIR).length === 0, "tmp: 全部实验结束后无 *.api4kiro-*.tmp 残留", findTmp(WORK_DIR));
  const report = {
    generatedAt: new Date().toISOString(),
    copyDir: path.relative(REPO, COPY_DIR),
    workDir: path.relative(REPO, WORK_DIR),
    sourceSha256: sha256(fs.readFileSync(SRC)),
    installedState: injectedNow ? "INJECTED" : "FACTORY",
    hashes: { asIs: hashesOf(s0), factory: hashesOf(factory), injected: hashesOf(A) },
    sizes: { asIs: sizesOf(s0), factory: sizesOf(factory), injected: sizesOf(A) },
    hitsAsIs: hits0,
    hitsFactory: hitTable(factory),
    hitsInjected: hitTable(A),
    unscopedSelectors: unscoped,
    tmpInCopy: tmpInCopy.map((p) => path.relative(COPY_DIR, p)),
    checks: results,
    failures,
    logLines: logs.length,
  };
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n# ${failures === 0 ? "ALL PASS" : failures + " FAILED"}  (${results.filter((r) => r.ok !== null).length} checks; report: ${path.relative(REPO, JSON_OUT)})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e && e.stack ? e.stack : e);
  process.exit(1);
});
