/**
 * 用仓内 esbuild 把 tests/store/*.test.ts 各自打成一个 CommonJS 文件到 tests/store/.build/。
 * `vscode` 走别名指到 vscode-stub.js（与被测 src 同一份实例，测试里改配置即时生效）。
 *
 * 用法：node tests/store/build.js [name ...]   （不带参数=全部）
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const esbuild = require(path.join(root, "node_modules", "esbuild"));

const outDir = path.join(__dirname, ".build");
fs.mkdirSync(outDir, { recursive: true });

const only = process.argv.slice(2);
const entries = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !only.length || only.some((o) => f === o || f === o + ".test.ts" || f.replace(/\.test\.ts$/, "") === o))
  .map((f) => path.join(__dirname, f));

if (!entries.length) {
  console.error("build: no *.test.ts found");
  process.exit(1);
}

esbuild
  .build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: "inline",
    logLevel: "warning",
    alias: { vscode: path.join(__dirname, "vscode-stub.js") },
    // node:sqlite 等内建模块不打包
    external: ["node:*"],
  })
  .then(() => {
    console.log(`build: ${entries.length} suite(s) -> ${path.relative(root, outDir)}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
