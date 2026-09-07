// Bundle the extension into a single dist/extension.js (CommonJS), external "vscode".
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

// Antigravity（Google Cloud Code）登录的 client secret：不进公开源码（Google 会扫 GitHub 自动吊销 GOCSPX），
// 构建时从环境变量或本地 gitignore 的 antigravity.secret 注入；缺失则为空（从源码构建者需自备）。
function readAntigravitySecret() {
  if (process.env.A2K_ANTIGRAVITY_CLIENT_SECRET) return process.env.A2K_ANTIGRAVITY_CLIENT_SECRET;
  try {
    return fs.readFileSync(path.join(__dirname, "antigravity.secret"), "utf8").trim();
  } catch {
    return "";
  }
}

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
  define: {
    "process.env.A2K_ANTIGRAVITY_CLIENT_SECRET": JSON.stringify(readAntigravitySecret()),
  },
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
