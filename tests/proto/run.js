/**
 * 顺序运行 tests/proto/.out/*.test.js，汇总每个套件末行的 `N passed, M failed`。
 * 退出码：任一套件失败 / 崩溃 / 用例数为 0 → 1；否则 0。
 *
 *   node tests/proto/run.js            全部
 *   node tests/proto/run.js gemini     只跑文件名含 gemini 的
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const outDir = path.join(__dirname, ".out");
const filter = process.argv.slice(2);

if (!fs.existsSync(outDir)) {
  console.error("tests/proto/.out 不存在：先 node tests/proto/build.js");
  process.exit(1);
}

const files = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => filter.length === 0 || filter.some((k) => f.includes(k)))
  .sort();

if (files.length === 0) {
  console.error("no built suites");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let crashed = 0;
const rows = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(outDir, f)], { encoding: "utf8", timeout: 120_000 });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const m = /(\d+) passed, (\d+) failed/.exec(stdout);
  const p = m ? Number(m[1]) : 0;
  const fl = m ? Number(m[2]) : 0;
  const ok = r.status === 0 && m && fl === 0 && p > 0;
  passed += p;
  failed += fl;
  if (!ok) {
    crashed += m ? 0 : 1;
  }
  rows.push(`${ok ? "PASS" : "FAIL"} ${f.replace(/\.test\.js$/, "").padEnd(14)} ${m ? `${p} passed, ${fl} failed` : `no summary (exit ${r.status})`}`);
  // 失败时把该套件输出全部打出来，方便定位
  if (!ok) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  } else {
    // 通过时只打 FAIL 行（应无）与套件标题
    const failLines = stdout.split("\n").filter((l) => l.startsWith("FAIL "));
    if (failLines.length) {
      process.stdout.write(failLines.join("\n") + "\n");
    }
  }
}

console.log("");
for (const r of rows) {
  console.log(r);
}
console.log("");
console.log(`${passed} passed, ${failed} failed${crashed ? ` (${crashed} suite(s) crashed)` : ""}`);
process.exit(failed === 0 && crashed === 0 && passed > 0 ? 0 : 1);
