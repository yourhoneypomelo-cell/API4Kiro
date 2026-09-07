#!/usr/bin/env node
/**
 * 回归套件打包器（对齐 a2kd-smoke 配方）：
 *   node tests/build.js            → 把 tests/*.ts 每个文件打成 tests/.out/<name>.js（vscode 解析到 tests/vscode-stub.js）
 *   node tests/build.js pool-      → 只打名字以 pool- 开头的套件
 *   node tests/build.js --run      → 打完顺序运行每个套件，逐个打印 `N passed, M failed`，任一失败退出码 1
 *   node tests/build.js --run kiro-  → 只打并运行 kiro- 前缀
 *
 * 套件约定：每个 tests/*.ts 是独立入口，打印 PASS/FAIL 行并以 `N passed, M failed` 收尾，失败时 process.exit(1)。
 * tests/lib/ 下是共享助手，不是套件（不在顶层，不会被当入口）。
 */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(__dirname, ".out");
const args = process.argv.slice(2);
const run = args.includes("--run");
const filters = args.filter((a) => !a.startsWith("--"));

const all = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .sort();
const entries = filters.length
  ? all.filter((f) => filters.some((x) => f === x || f === x + ".ts" || f.startsWith(x)))
  : all;

if (entries.length === 0) {
  console.error("no suites matched:", filters.join(" "));
  process.exit(2);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: entries.map((f) => path.join(__dirname, f)),
    outdir: outDir,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: "inline",
    logLevel: "warning",
    absWorkingDir: root,
    alias: { vscode: path.join(__dirname, "vscode-stub.js") },
  });
  console.log(`[tests/build] built ${entries.length} suite(s) → ${path.relative(root, outDir)}`);
  if (!run) {
    return;
  }
  let anyFail = false;
  const summary = [];
  for (const f of entries) {
    const js = path.join(outDir, f.replace(/\.ts$/, ".js"));
    console.log(`\n=== ${f} ===`);
    const r = spawnSync(process.execPath, [js], { stdio: "inherit", cwd: root });
    const code = r.status === null ? 1 : r.status;
    summary.push(`${f}: exit ${code}`);
    if (code !== 0) {
      anyFail = true;
    }
  }
  console.log("\n=== summary ===\n" + summary.join("\n"));
  process.exit(anyFail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
