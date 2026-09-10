// Bundle the extension into a single dist/extension.js (CommonJS), external "vscode".
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

// Antigravity（Google Cloud Code）登录的 client secret：不进公开源码（Google 会扫 GitHub 自动吊销 GOCSPX）。
// 默认 `npm run package` 不读 antigravity.secret，公开 Release / CI 必须得到空串。
// 本机自用包才允许注入：环境变量 A2K_ANTIGRAVITY_CLIENT_SECRET，或
// A2K_EMBED_ANTIGRAVITY_SECRET=1 时读本地 gitignore 的 antigravity.secret。
// 带密钥的包禁止 `gh release upload`、禁止推进公开仓。缺失则为空（登录按现有代码不可用）。
function readAntigravitySecret() {
  if (process.env.A2K_ANTIGRAVITY_CLIENT_SECRET) return process.env.A2K_ANTIGRAVITY_CLIENT_SECRET;
  if (process.env.A2K_EMBED_ANTIGRAVITY_SECRET === "1") {
    try {
      return fs.readFileSync(path.join(__dirname, "antigravity.secret"), "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
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
