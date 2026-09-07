/**
 * 逐个子进程运行 tests/store/.build/*.test.js，汇总每个套件末行 `N passed, M failed`，
 * 最后打印总计 `N passed, M failed`。任一失败、或总用例数为 0 → 退出码 1。
 *
 * 用法：node tests/store/run.js [name ...]   （先跑 node tests/store/build.js）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const buildDir = path.join(__dirname, ".build");
if (!fs.existsSync(buildDir)) {
  console.error("run: tests/store/.build 不存在，请先 node tests/store/build.js");
  process.exit(1);
}
const only = process.argv.slice(2);
const files = fs
  .readdirSync(buildDir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !only.length || only.some((o) => f === o || f === o + ".test.js" || f.replace(/\.test\.js$/, "") === o))
  .sort();

let passed = 0;
let failed = 0;
let broken = 0;
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(buildDir, f)], { encoding: "utf8", timeout: 180_000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /(\d+) passed, (\d+) failed\s*$/m.exec(out);
  const name = f.replace(/\.test\.js$/, "");
  if (!m) {
    broken++;
    console.log(`=== ${name}: NO SUMMARY (exit ${r.status}, signal ${r.signal || "-"}) ===`);
    console.log(out.trim());
    continue;
  }
  const p = Number(m[1]);
  const q = Number(m[2]);
  passed += p;
  failed += q;
  console.log(`=== ${name}: ${p} passed, ${q} failed (${Date.now() - started}ms) ===`);
  if (q > 0 || process.env.A2K_TEST_VERBOSE) {
    console.log(out.trim());
  }
}
console.log(`${passed} passed, ${failed} failed${broken ? ` (${broken} suite(s) crashed)` : ""}`);
process.exit(failed > 0 || broken > 0 || passed === 0 ? 1 : 0);
