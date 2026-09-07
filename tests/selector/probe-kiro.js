// 只读探针：对一个真实 Kiro 安装目录（默认 D:\Kiro\resources\app）统计每个靶点字串的命中次数，
// 判断三处文件当前是出厂 / 当前补丁 / 旧版补丁孤儿。只 readFile，绝不写。
// 用法：node tests/selector/probe-kiro.js [appRoot]
"use strict";
const fs = require("fs");
const path = require("path");

const built = path.join(__dirname, ".build", "selectorStyle.js");
if (!fs.existsSync(built)) {
  console.error("missing .build/selectorStyle.js — run `node tests/selector/build.js` first");
  process.exit(2);
}
const appRoot = process.argv[2] || "D:\\Kiro\\resources\\app";
process.env.A2K_TEST_APP_ROOT = appRoot;
const { __selectorStyleInternals: I } = require(built);
const P = I.patterns;
const M = I.matchers;
const stripCarry = (js) => js.replace(M.POPOVER_CARRY_MARK_RE, "");

function count(hay, needle) {
  let n = 0;
  for (let i = 0; ; i += needle.length) {
    i = hay.indexOf(needle, i);
    if (i < 0) return n;
    n++;
  }
}
function read(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    return null;
  }
}

const cssPath = I.paths.styleFile();
const backendPath = I.paths.kiroAgentBackendFile();
const jsDir = I.paths.jsDir();
let pkgVersion = "?";
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
} catch {}
console.log(`appRoot=${appRoot} kiro=${pkgVersion}`);

const css = read(cssPath);
console.log(`\n[style.css] ${cssPath} ${css ? css.length + " chars" : "UNREADABLE"}`);
if (css) {
  console.log(`  START=${count(css, I.START)} END=${count(css, I.END)} a2k-total=${count(css, "a2k-")} a2k-outside-block=${count(css.slice(0, css.indexOf(I.START) < 0 ? css.length : css.indexOf(I.START)), "a2k-")}`);
}

let mermaids = [];
try {
  mermaids = fs.readdirSync(jsDir).filter((f) => f.startsWith("mermaid-") && f.endsWith(".js"));
} catch {}
for (const f of mermaids) {
  const js = read(path.join(jsDir, f));
  console.log(`\n[${f}] ${js ? js.length + " chars" : "UNREADABLE"}`);
  if (!js) continue;
  // 选择器三处 + 通道 B：仍是逐字靶点
  for (const k of ["ORIG_JS_PATTERN", "PATCHED_JS_CODE", "ORIG_MENU_PATTERN", "PATCHED_MENU_CODE", "ORIG_REF_PATTERN", "PATCHED_REF_CODE", "ORIG_TRIGGER_PATTERN", "PATCHED_TRIGGER_CODE"]) {
    console.log(`  ${k.padEnd(26)} ${count(js, P[k])}`);
  }
  // 弹层两处：结构定位（名字用正则捕获），补丁态看 a2k-orig 携带标记
  const fac = M.findPopoverFactory(js);
  const carry = M.POPOVER_CARRY_RE.exec(js);
  const fn = fac ? fac.names.fn : carry ? carry[1] : null;
  const useSess = M.resolveTaggedName(js, "useSessionConfig");
  const popPatched = carry ? 1 : 0;
  const popLegacy = !carry && /a2k-cu|cursor-context|cursor-legend-dot|cursor-row-left/.test(js) ? 1 : 0;
  const popRenderedOk = carry && fac === null && useSess
    ? (() => {
        const decoded = Buffer.from(carry[2], "base64").toString("utf8");
        const f0 = M.findPopoverFactory(decoded);
        return f0 ? stripCarry(carry[0]) === M.renderTemplate(P.PATCHED_POPOVER_CODE, M.POPOVER_PATCH_CANON, [f0.names.fn, f0.names.warn, useSess]) : false;
      })()
    : null;
  console.log(
    `  POPOVER  factory=${fac ? 1 : 0} fn=${fac ? fac.names.fn : "-"} warn=${fac ? fac.names.warn : "-"} local=${fac ? fac.names.local : "-"} | patched(carry)=${popPatched}${carry ? ` fn=${carry[1]}` : ""}${popRenderedOk !== null ? ` body==template:${popRenderedOk ? "yes" : "NO"}` : ""} | legacy-variant=${popLegacy} | useSessionConfig=${useSess || "-"}`
  );
  const callOrig = fn ? count(js, M.renderTemplate(P.ORIG_POPOVER_CALL_PATTERN, ["Bde"], [fn])) : 0;
  const callPatched = count(js, ",a2kUsage:n})");
  console.log(`  CALL     fn=${fn || "-"} | factory=${callOrig} | patched=${callPatched}`);
  const a2kRow = count(js, 'className:"chat-input-popup-option a2k-exclusive-model-option"');
  const selectorState =
    count(js, P.ORIG_JS_PATTERN) === 1 && a2kRow === 0
      ? "factory"
      : count(js, P.PATCHED_JS_CODE) === 1
        ? "current-patch"
        : a2kRow > 0
          ? "STALE-VARIANT (older patch; current exact restore would miss it)"
          : "unknown / no selector code in this file";
  const popoverState = fac && !carry && !popLegacy ? "factory" : carry ? (popRenderedOk ? "current-patch" : "patched (carry present, body differs from current template → will be upgraded on next toggle)") : popLegacy ? "STALE-VARIANT (legacy popover patch)" : fac === null && !carry && !popLegacy ? (count(js, "kiro-context-popover") ? "DRIFT (popover present but structure template does not match)" : "n/a (no popover code in this file)") : "unknown";
  console.log(`  state: selector=${selectorState} | popover=${popoverState}`);
}

const backend = read(backendPath);
console.log(`\n[dist/extension.js] ${backendPath} ${backend ? backend.length + " chars" : "UNREADABLE"}`);
if (backend) {
  const hook = M.findBackendHook(backend);
  const patchedRe = new RegExp(M.BACKEND_PATCHED_RE.source);
  const pm = patchedRe.exec(backend);
  console.log(`  BACKEND  hook=${hook ? `${hook.fn}/${hook.store}` : "-"} | patched=${pm ? 1 : 0}${pm ? ` fn=${pm[1]} store=${pm[2]}` : ""} | __kiroModelConfigProvider=${count(backend, "__kiroModelConfigProvider")}`);
  console.log(`  (legacy verbatim) ORIG_QPE_PATTERN=${count(backend, P.ORIG_QPE_PATTERN)} PATCHED_QPE_PATTERN=${count(backend, P.PATCHED_QPE_PATTERN)}`);
  const restoredHook = pm ? M.findBackendHook(M.restoreBackendHook(backend)) : null;
  console.log(`  state: ${hook && !pm ? "factory" : pm && restoredHook ? "current-patch (restores to " + restoredHook.fn + "/" + restoredHook.store + ")" : pm ? "patched (unknown restore target)" : "DRIFT (no unique setter/getter/getAvailableModels anchor)"}`);
}
