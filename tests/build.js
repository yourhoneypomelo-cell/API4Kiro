#!/usr/bin/env node
/**
 * npm test 的前置构建（pretest）：顺序做三件事
 *  1. 把 src/ 预编译到 tests/.build（node --test 直接跑 JS，仓库没有 ts 运行器）；
 *  2. 写一个 vscode 宿主桩到 tests/.build/node_modules/vscode/；
 *  3. 跑一次 esbuild，产出 dist/extension.js 与 dist/uninstall.js（集成测试要 spawn 真产物）。
 *
 * 桩为什么写在 tests/.build/node_modules/ 而不是仓库根 node_modules/：Node 从
 * tests/.build/*.test.js 向上解析裸模块名 "vscode" 时先命中它，装到仓库根就会污染真实依赖。
 * 为什么不做「有构建标记就跳过」的缓存：node --test 会并行起多个测试进程，那种缓存是 TOCTOU，
 * 每次重编译的成本（本机 ~1s）换确定性更划算。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const BUILD = path.join(__dirname, ".build");

/**
 * 宿主桩：只实现单测确实会用到的 surface（env / workspace.getConfiguration / window.createOutputChannel /
 * Uri / commands / ConfigurationTarget）。settings 走 globalThis.__a2kSettings，测试可以整体替换它。
 * 其余成员一律抛错——「静默返回垃圾」会让测试假绿。
 */
const VSCODE_STUB = `"use strict";
// 单测用的 vscode 宿主桩，由 tests/build.js 生成，不要手改。
function settingsOf() {
  if (!globalThis.__a2kSettings) globalThis.__a2kSettings = {};
  return globalThis.__a2kSettings;
}
function section() {
  return {
    get(key, def) {
      const s = settingsOf();
      return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : def;
    },
    inspect() { return undefined; },
    async update(key, value) { settingsOf()[key] = value; },
  };
}
function record(kind, args) {
  if (!globalThis.__a2kUiCalls) globalThis.__a2kUiCalls = [];
  globalThis.__a2kUiCalls.push({ kind, args });
}
function message(kind) {
  return async (...args) => { record(kind, args); return undefined; };
}
module.exports = {
  env: { appRoot: process.env.A2K_APP_ROOT, appName: "Kiro", openExternal: async () => true },
  workspace: { getConfiguration: section },
  window: {
    createOutputChannel() { return { appendLine() {}, append() {}, show() {}, dispose() {} }; },
    showWarningMessage: message("warning"),
    showErrorMessage: message("error"),
    showInformationMessage: message("info"),
    // withProgress 直接跑回调、给一个永不被取消的 token；命令调用由 commands.executeCommand 记录
    withProgress: async (_opts, task) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  },
  Uri: { file: (p) => ({ fsPath: p, toString: () => String(p) }) },
  commands: {
    executeCommand: async (...args) => {
      if (!globalThis.__a2kCommands) globalThis.__a2kCommands = [];
      globalThis.__a2kCommands.push(args);
      return undefined;
    },
  },
  ConfigurationTarget: { Global: true, Workspace: false, WorkspaceFolder: false },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
};
`;

function compile() {
  execFileSync(
    path.join(REPO, "node_modules/.bin/tsc"),
    ["-p", path.join(REPO, "tsconfig.json"), "--outDir", BUILD, "--noEmit", "false", "--sourceMap", "false"],
    { stdio: "inherit" }
  );
}

function writeStub() {
  const dir = path.join(BUILD, "node_modules/vscode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vscode", version: "0.0.0", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), VSCODE_STUB);
}

function bundle() {
  // 卸载入口 / 扩展入口的真实产物：tests/uninstall.test.js 要 spawn dist/uninstall.js，
  // 而 npm test 不会自己打包。esbuild 构建自带「产物不得含 require("vscode")」断言。
  execFileSync(process.execPath, [path.join(REPO, "esbuild.js")], { cwd: REPO, stdio: "inherit" });
}

function main() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  compile();
  writeStub();
  bundle();
}

main();
