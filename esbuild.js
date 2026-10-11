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

/**
 * 卸载入口（`vscode:uninstall`）的宿主桩别名：把裸模块名 `vscode` 指到 `src/hostlessVscode.ts`。
 * 这样 `selectorStyle.ts` / `log.ts` / `config.ts` 一行都不用改，还原逻辑全仓库仍然只有一份。
 */
const hostlessVscodeAlias = () => ({
  name: "hostless-vscode",
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(__dirname, "src", "hostlessVscode.ts") }));
  },
});

/** `dist/uninstall.js`：宿主外跑，所以 `external` 必须为空（任何 `require("vscode")` 都要被别名吃掉）。 */
const uninstallOptions = {
  entryPoints: ["src/uninstall.ts"],
  bundle: true,
  outfile: "dist/uninstall.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  external: [],
  sourcemap: false,
  minify: false,
  logLevel: "info",
  plugins: [hostlessVscodeAlias()],
};

/**
 * 卸载产物的两条硬断言（I9）：①不得含 `require("vscode")`；②注入 appRoot 后
 * `vscode.env.appRoot` 必须读到它——这条验的是「别名解析到的桩与入口按路径 import 的桩是同一个模块实例」，
 * 也正是「一份桩代码 + 零改动复用还原管线」能成立的前提。
 */
async function assertUninstallBundle() {
  const text = fs.readFileSync(path.join(__dirname, "dist", "uninstall.js"), "utf8");
  if (/require\(["']vscode["']\)/.test(text)) {
    throw new Error('dist/uninstall.js 里出现了 require("vscode")：卸载钩子会在宿主外崩溃');
  }
  const probeDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "a2k-hostless-probe-"));
  const probeRoot = path.join(probeDir, "fake-kiro-root");
  const probe = await esbuild.build({
    stdin: {
      contents:
        `import * as vscode from "vscode";\n` +
        `import { setHostAppRoot } from "./hostlessVscode";\n` +
        `setHostAppRoot(${JSON.stringify(probeRoot)});\n` +
        `process.stdout.write("PROBE:" + vscode.env.appRoot);\n`,
      resolveDir: path.join(__dirname, "src"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [hostlessVscodeAlias()],
  });
  const probeFile = path.join(probeDir, "probe.js");
  fs.writeFileSync(probeFile, probe.outputFiles[0].text, "utf8");
  const out = require("child_process").execFileSync(process.execPath, [probeFile], { encoding: "utf8" });
  if (out.trim() !== `PROBE:${probeRoot}`) {
    throw new Error(`宿主桩断言失败：setHostAppRoot() 之后 vscode.env.appRoot 读到 ${JSON.stringify(out)}（期望 ${probeRoot}）`);
  }
  fs.rmSync(probeDir, { recursive: true, force: true });
  console.log(`[esbuild] uninstall bundle ok (${text.length} bytes, appRoot 注入可读)`);
}

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    const uninstallCtx = await esbuild.context(uninstallOptions);
    await ctx.watch();
    await uninstallCtx.watch();
    console.log("[esbuild] watching...");
  } else {
    await esbuild.build(options);
    await esbuild.build(uninstallOptions);
    await assertUninstallBundle();
    console.log("[esbuild] build complete");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
