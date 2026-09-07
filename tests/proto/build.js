/**
 * 用仓内 esbuild 把 tests/proto/*.test.ts 各自打成 tests/proto/.out/<name>.js（CommonJS，node18）。
 * `vscode` 模块别名到 tests/proto/vscode-stub.js，其余（含 src/）全部内联进包。
 *
 *   node tests/proto/build.js            全部套件
 *   node tests/proto/build.js gemini     只打文件名含 gemini 的套件
 */
"use strict";

const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const here = __dirname;
const outDir = path.join(here, ".out");
const filter = process.argv.slice(2);

const suites = fs
  .readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => filter.length === 0 || filter.some((k) => f.includes(k)))
  .sort();

if (suites.length === 0) {
  console.error("no *.test.ts found in", here);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

(async () => {
  for (const f of suites) {
    const out = path.join(outDir, f.replace(/\.ts$/, ".js"));
    await esbuild.build({
      entryPoints: [path.join(here, f)],
      bundle: true,
      outfile: out,
      platform: "node",
      target: "node18",
      format: "cjs",
      alias: { vscode: path.join(here, "vscode-stub.js") },
      sourcemap: "inline",
      logLevel: "warning",
    });
    console.log(`[build] ${f} -> ${path.relative(process.cwd(), out)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
