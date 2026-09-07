// 用仓内 esbuild 把 src/selectorStyle.ts 打成 CJS，`vscode` 指向本目录 stub。
// 输出：tests/selector/.build/selectorStyle.js
"use strict";
const path = require("path");
const esbuild = require("esbuild");

const here = __dirname;
const repo = path.resolve(here, "..", "..");

esbuild
  .build({
    entryPoints: [path.join(repo, "src", "selectorStyle.ts")],
    bundle: true,
    outfile: path.join(here, ".build", "selectorStyle.js"),
    platform: "node",
    target: "node18",
    format: "cjs",
    alias: { vscode: path.join(here, "vscode-stub.js") },
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  })
  .then(() => {
    console.log("[tests/selector] build complete -> .build/selectorStyle.js");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
