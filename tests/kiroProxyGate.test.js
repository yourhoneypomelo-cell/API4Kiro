"use strict";
// kiro-proxy 前置闸（4.13.66 起**逐文件**）：带残留的文件跳过并在结果里点名，干净文件照常打补丁；
// 全部目标文件都带残留时退化成整轮拒绝。关闭路径只删自己的段（AC-9 / AC-15）。
// 全部读写都在临时沙箱里，绝不碰真实 /Applications/Kiro.app。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-gate-"));
const APP = path.join(SANDBOX, "app");
const EXT_DIR = path.join(APP, "extensions/kiro.kiro-agent");
const PKG_DIST = path.join(EXT_DIR, "packages/kiro-ui-agent-chat/dist");
const BACKEND = path.join(EXT_DIR, "dist/extension.js");
const STYLE = path.join(PKG_DIST, "style.css");
const CHUNK = path.join(PKG_DIST, "assets/mermaid-gate.js");

// 宿主桩在 require 时读 A2K_APP_ROOT，所以必须在装载编译产物之前指到沙箱。
process.env.A2K_APP_ROOT = APP;

const S = require("./.build/selectorStyle.js");
const I = S.__selectorStyleInternals;
const M = I.matchers;
const P = I.patterns;

/** 合成 1.1.x chunk（与 dev/verify-selector-patch.js 的合成夹具同源）。 */
function syntheticChunk() {
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

/** 出厂后端文件（主钩子 + usage 工厂的最简结构）。 */
const BACKEND_FACTORY =
  "function QPe(t){Oue=t}function Zue(){return Oue}var qq=Oue.getAvailableModels();";

const CSS_FACTORY = ":root{--x:1}\nbody{margin:0}\n";

function seedSandbox() {
  fs.mkdirSync(path.dirname(BACKEND), { recursive: true });
  fs.mkdirSync(path.dirname(CHUNK), { recursive: true });
  fs.writeFileSync(BACKEND, BACKEND_FACTORY, "utf8");
  fs.writeFileSync(STYLE, CSS_FACTORY, "utf8");
  fs.writeFileSync(CHUNK, syntheticChunk(), "utf8");
}

const read = (f) => fs.readFileSync(f, "utf8");
const FILES = [CHUNK, STYLE, BACKEND];
const contents = () => FILES.map(read);
const stamps = () => FILES.map((f) => { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; });
const proxyBytes = (texts) => texts.map((t) => (t.match(/kiroproxy-[A-Za-z0-9:_-]*/g) || []).join(","));
const marksIn = (text) => I.SELECTOR_PATCH_MARKS.filter((m) => text.includes(m));
const shortName = (f) => path.relative(path.join(APP, "extensions"), f);

const CSS_RESIDUE = "\n/*kiroproxy-ctxwin-css:r1*/\n.kiroproxy-ctxwin-wrap{display:flex}\n";
const JS_RESIDUE = "/*kiroproxy-toolcard:r1*/var kiroproxyProbe=1;/*kiroproxy-toolcard:end*/";

test.beforeEach(async () => {
  seedSandbox();
  await S.syncGroupHeaderStyle(false);
});

test("①开补丁写入 a2k 段 → ②整轮带残留时逐文件跳过并点名（干净文件照常打） → ③关闭只删自己的段", async () => {
  // ①
  const s1 = await S.syncGroupHeaderStyle(true);
  assert.equal(s1.blockedBy, undefined, JSON.stringify(s1));
  const chunk1 = read(CHUNK);
  assert.ok(I.SELECTOR_PATCH_MARKS.some((m) => chunk1.includes(m)), `chunk 里应有 a2k 标记：${chunk1.slice(0, 200)}`);
  assert.ok(chunk1.includes("a2k-card-head"));
  assert.ok(read(STYLE).includes("a2k-card-head"), "CARD_CSS 应落进 style.css");
  assert.ok(read(BACKEND).includes("__kiroModelConfigProvider=t"), "后端钩子应写入");

  // ② 只把**这一个** package（chunk + style.css）换成带残留的出厂夹具 → 整轮目标文件都带残留 ⇒ 整轮拒绝
  await S.syncGroupHeaderStyle(false);
  fs.writeFileSync(CHUNK, `${syntheticChunk()}\n${JS_RESIDUE}\n`, "utf8");
  fs.writeFileSync(STYLE, `${CSS_FACTORY}${CSS_RESIDUE}`, "utf8");
  fs.writeFileSync(BACKEND, `${BACKEND_FACTORY}\n${JS_RESIDUE}\n`, "utf8");
  const before2 = contents();
  const stamps2 = stamps();
  const proxy2 = proxyBytes(before2);

  const s2 = await S.syncGroupHeaderStyle(true); // 不得抛错
  assert.equal(s2.status, "unavailable");
  assert.equal(s2.blockedBy, "kiro-proxy");
  assert.deepEqual(s2.targets, { style: "unavailable", selectorScript: "unavailable", backend: "unavailable" });
  assert.deepEqual(s2.extras, { ctxSelector: "unavailable", ctxHost: "unavailable", usageRetry: "unavailable" });
  assert.deepEqual([...s2.skippedBy].sort(), [shortName(CHUNK), shortName(STYLE), shortName(BACKEND)].sort(), JSON.stringify(s2.skippedBy));
  assert.ok(s2.detail && s2.detail.includes("kiro-proxy"), String(s2.detail));
  assert.deepEqual(contents(), before2, "全部带残留时整轮不得写任何目标文件");
  assert.deepEqual(stamps(), stamps2, "mtime 也不得变");

  // ③ 关闭路径不跑闸门（只删自己的段；本夹具本来就没有本扩展的段，所以内容不变）
  const s3 = await S.syncGroupHeaderStyle(false);
  assert.equal(s3.blockedBy, undefined, JSON.stringify(s3));
  const after = contents();
  for (let i = 0; i < FILES.length; i++) {
    assert.deepEqual(marksIn(after[i]), [], `${path.basename(FILES[i])} 仍含 a2k 标记`);
    assert.ok(!after[i].includes("/*a2k-row:"), `${path.basename(FILES[i])} 仍含 a2k-row 段`);
  }
  assert.deepEqual(proxyBytes(after), proxy2, "别人的 kiroproxy- 字节一个都不能碰");
  assert.ok(after[0].includes(JS_RESIDUE), "注入的 JS 残留仍在");
  assert.ok(after[1].includes(CSS_RESIDUE.trim()), "注入的 CSS 残留仍在");
});

test("逐文件：只有一个文件带残留 ⇒ 干净文件照常打补丁，带残留的那份一个字节都不动", async () => {
  // 出厂夹具，只把 style.css 换成带残留的版本（chunk 不变、后端不变）
  fs.writeFileSync(STYLE, `${CSS_FACTORY}${CSS_RESIDUE}`, "utf8");
  const styleBefore = read(STYLE);
  const styleStamp = stamps()[1];

  const s = await S.syncGroupHeaderStyle(true);
  assert.equal(s.blockedBy, "kiro-proxy", JSON.stringify(s));
  assert.equal(s.status, "unavailable", JSON.stringify(s));
  // 同 package 的 chunk 与 style.css 必须成对：这份 style.css 带残留 ⇒ 这一对一起跳过
  assert.deepEqual([...s.skippedBy].sort(), [shortName(CHUNK), shortName(STYLE)].sort(), JSON.stringify(s.skippedBy));
  assert.deepEqual(s.targets, { style: "unavailable", selectorScript: "unavailable", backend: "applied" }, JSON.stringify(s.targets));
  assert.ok(s.detail.includes("跳过"), String(s.detail));

  assert.equal(read(STYLE), styleBefore, "带残留的 style.css 一个字节都不许动");
  assert.equal(stamps()[1], styleStamp, "连 mtime 都不能变");
  assert.ok(read(STYLE).includes(CSS_RESIDUE.trim()), "别人的 CSS 字节不能被碰");
  assert.deepEqual(marksIn(read(CHUNK)), [], "成对的 chunk 也不能被打上（否则就是半套补丁）");
  assert.ok(read(BACKEND).includes("__kiroModelConfigProvider=t"), "干净的后端文件必须照常打上钩子");

  // 残留清掉后再开：这一对也能打上（与无闸门时一致）
  fs.writeFileSync(STYLE, CSS_FACTORY, "utf8");
  const s2 = await S.syncGroupHeaderStyle(true);
  assert.equal(s2.blockedBy, undefined, JSON.stringify(s2));
  assert.ok(read(CHUNK).includes("a2k-card-head"));
  assert.ok(read(STYLE).includes("a2k-card-head"));
});

test("提示可操作：旁边有 `.kiroproxy-bak-*` 出厂备份时结果里给出备份路径", async () => {
  fs.writeFileSync(STYLE, `${CSS_FACTORY}${CSS_RESIDUE}`, "utf8");
  const bak = `${STYLE}.kiroproxy-bak-1.2.56`;
  fs.writeFileSync(bak, CSS_FACTORY, "utf8");
  const s = await S.syncGroupHeaderStyle(true);
  assert.equal(s.blockedBy, "kiro-proxy", JSON.stringify(s));
  assert.deepEqual(s.kiroProxyBackups, [bak], JSON.stringify(s.kiroProxyBackups));
  fs.rmSync(bak, { force: true });
  // 没有备份时不编造指引
  const s2 = await S.syncGroupHeaderStyle(true);
  assert.equal(s2.kiroProxyBackups, undefined, JSON.stringify(s2.kiroProxyBackups));
});

test("AC-9：残留清掉后行为与无闸门时逐字一致", async () => {
  fs.writeFileSync(CHUNK, `${syntheticChunk()}\n${JS_RESIDUE}\n`, "utf8");
  fs.writeFileSync(STYLE, `${CSS_FACTORY}${CSS_RESIDUE}`, "utf8");
  assert.equal((await S.syncGroupHeaderStyle(true)).blockedBy, "kiro-proxy");

  // 手工清掉两处残留（模拟用户还原 kiro-proxy）
  const stripResidue = (t, residue) => t.split(residue.trim()).join("");
  fs.writeFileSync(STYLE, stripResidue(read(STYLE), CSS_RESIDUE), "utf8");
  fs.writeFileSync(CHUNK, stripResidue(read(CHUNK), JS_RESIDUE), "utf8");

  const s = await S.syncGroupHeaderStyle(true);
  assert.equal(s.blockedBy, undefined, JSON.stringify(s));
  assert.equal(s.status, "applied", JSON.stringify(s));
  assert.ok(read(CHUNK).includes("a2k-card-head"));
  assert.ok(read(STYLE).includes("a2k-card-head"));
  // 关闭后回到注入前的出厂内容
  await S.syncGroupHeaderStyle(false);
  assert.equal(read(CHUNK).split(JS_RESIDUE).length - 1, 0);
  assert.ok(read(STYLE).trim() === CSS_FACTORY.trim(), read(STYLE));
  assert.equal(read(BACKEND), BACKEND_FACTORY);
});

test("闸门把「读不到」当作「无标记」：普通 VS Code 宿主不得被报成 kiro-proxy 残留", async () => {
  // 整个 Kiro 扩展目录不存在（= 在普通 VS Code 里激活）
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  const s = await S.syncGroupHeaderStyle(true);
  assert.equal(s.blockedBy, undefined, "普通 VS Code 宿主不该被判成 kiro-proxy 残留");
  assert.ok(!String(s.detail || "").includes("kiro-proxy"), `detail 不得提 kiro-proxy：${String(s.detail)}`);
  assert.notEqual(s.status, "applied");

  // 目录在、文件缺（靶点漂移）：同样不算残留（状态沿用既有语义，这里只守「不误判」）
  seedSandbox();
  fs.rmSync(CHUNK, { force: true });
  fs.rmSync(STYLE, { force: true });
  const s2 = await S.syncGroupHeaderStyle(true);
  assert.equal(s2.blockedBy, undefined, JSON.stringify(s2));
  assert.ok(!String(s2.detail || "").includes("kiro-proxy"), `detail 不得提 kiro-proxy：${String(s2.detail)}`);
  seedSandbox();
});

test("闸门只对开启路径生效：关闭态（factory 夹具）不读残留也能还原", async () => {
  fs.appendFileSync(STYLE, CSS_RESIDUE, "utf8");
  const s = await S.syncGroupHeaderStyle(false);
  assert.equal(s.blockedBy, undefined);
  assert.notEqual(s.status, "unavailable", JSON.stringify(s));
  assert.ok(read(STYLE).includes("kiroproxy-ctxwin-wrap"), "关闭路径不碰别人的字节");
});
