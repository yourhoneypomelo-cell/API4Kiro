#!/usr/bin/env node
/**
 * 离屏渲染侧边栏控制面板（提供商 / 模型 / 设置 + 全部弹窗），用于视觉审查。
 *
 * 从 src/sidebar.ts 抽出 Webview 模板（CSS/HTML/JS 原样），把 vscode API 换成 stub，
 * 注入 VS Code Dark Modern 主题变量与接近真实形状的 mock 状态，写出自包含 HTML，
 * 再用 Python playwright（本机已装）+ Chromium 无头截图。
 *
 * 用法：
 *   node scripts/render-panel.js --tab providers|models|settings --width 300 [--modal <kind>] [--fold]
 *   node scripts/render-panel.js --all            # 五档宽度 × 三页 + 每种弹窗一档
 *   node scripts/render-panel.js --html-only ...  # 只写 HTML 不截图
 *
 * 参数：
 *   --tab      providers | models | settings                （默认 providers）
 *   --width    220 | 250 | 300 | 380 | 460 | 600 | 900 …      （默认 380）
 *   --height   视口高度                                        （默认 720）
 *   --modal    select | connect | connect-preset | edit | edit-oauth | addmodel |
 *              oauth | oauth-kiro | prompt | prompt-edit | confirm | allprov | ccimport
 *   --fold     折叠态：模型页渠道卡全部折叠；select 弹窗分类卡保持折叠（默认展开以便看行）
 *   --search   在弹窗搜索框（或设置页提示词搜索框）里预填关键字，文件名加 -q
 *   --toast    ok | error   截图前弹一条底部提示条（截图不做 full_page 时才在视口内）
 *   --reduced-motion   emulate prefers-reduced-motion: reduce
 *   --scale    截图 deviceScaleFactor                        （默认 2）
 *   --theme    dark | light                                    （默认 dark）
 *   --out      输出目录                                        （默认 .verify-artifacts）
 *   --port     本地静态服务端口（图标 mask-image 受 CORS 约束，file:// 加载会被拒） （默认 18987）
 *
 * 输出：<out>/panel-<tab>-<width>[-<modal>][-fold][-rm].png 与同名 .html；
 *       每张图附带一份 DOM 量测 JSON（<同名>.probe.json）辅助核对，但结论以看图为准。
 *       要在浏览器里手动打开 HTML：先在仓库根 `python -m http.server 18987`，再访问
 *       http://127.0.0.1:18987/.verify-artifacts/<name>.html
 *
 * 依赖：Node ≥ 18；Python 3 + `pip install playwright` + `python -m playwright install chromium`。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "sidebar.ts");

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { tab: "providers", width: 380, height: 720, modal: "", fold: false, reducedMotion: false, scale: 2, theme: "dark", out: ".verify-artifacts", all: false, htmlOnly: false, port: 18987 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--tab") { a.tab = v; i++; }
    else if (k === "--width") { a.width = Number(v); i++; }
    else if (k === "--height") { a.height = Number(v); i++; }
    else if (k === "--modal") { a.modal = v; i++; }
    else if (k === "--fold") a.fold = true;
    else if (k === "--reduced-motion") a.reducedMotion = true;
    else if (k === "--scale") { a.scale = Number(v); i++; }
    else if (k === "--theme") { a.theme = v; i++; }
    else if (k === "--out") { a.out = v; i++; }
    else if (k === "--port") { a.port = Number(v); i++; }
    else if (k === "--search") { a.search = v; i++; }
    else if (k === "--toast") { a.toast = v; i++; }
    else if (k === "--all") a.all = true;
    else if (k === "--html-only") a.htmlOnly = true;
    else if (k === "-h" || k === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
    else { console.error("未知参数:", k); process.exit(2); }
  }
  return a;
}

// ---------------------------------------------------------------- template extraction
function extractTemplate(src) {
  // ICONS：从 `const svg = (body` 到 ICONS 对象结束的 `\n};`
  const svgStart = src.indexOf("const svg = (body");
  const iconsStart = src.indexOf("const ICONS = {", svgStart);
  const iconsEnd = src.indexOf("\n};", iconsStart);
  if (svgStart < 0 || iconsStart < 0 || iconsEnd < 0) throw new Error("找不到 ICONS 定义");
  // 只有 `(body: string, strokeWidth = 2)` 这一处 TS 类型标注，去掉即为合法 JS
  const iconsSrc = src.slice(svgStart, iconsEnd + 3).replace("(body: string, strokeWidth = 2)", "(body, strokeWidth = 2)");
  const ICONS = new Function(iconsSrc + "\nreturn ICONS;")();

  // html()：`return \`<!DOCTYPE html>` … `</html>\`;`
  const fnStart = src.indexOf("private html(webview");
  const tplStart = src.indexOf("return `<!DOCTYPE html>", fnStart);
  const tplEnd = src.indexOf("</html>`;", tplStart);
  if (fnStart < 0 || tplStart < 0 || tplEnd < 0) throw new Error("找不到 html() 模板");
  const tplBody = src.slice(tplStart + "return `".length, tplEnd + "</html>".length);
  if (tplBody.includes("`")) throw new Error("模板内出现反引号，抽取方式需要调整");
  const tplLine = src.slice(0, tplStart).split("\n").length;
  return { ICONS, tplBody, tplLine };
}

function iconFilesOf(dir, exts) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+)\.([a-z0-9]+)$/i.exec(f);
    if (!m || !exts.includes(m[2].toLowerCase())) continue;
    const id = m[1], ext = m[2].toLowerCase();
    if (!out[id] || exts.indexOf(ext) < exts.indexOf(out[id])) out[id] = ext;
  }
  return out;
}

const GLYPH_ORDER = [
  "rings-2", "rings-3", "trefoil", "chain-8", "diamond-dot", "helix", "cycle",
  "triskele", "sonar", "turbine", "eclipse", "swirl", "arcs-cross", "portal",
  "hex-nest", "hex-cube", "mesh", "tri-nest", "tri-3", "diamond-4", "star-8", "star-5", "octa-cross", "infinity-tri",
  "cube-iso", "layers-iso", "stack-3", "prism", "grid-4",
  "node-3", "node-4", "molecule", "constellation", "lattice",
  "waves-3", "flow", "pulse-ring", "bars-ring", "signal", "ripple",
  "orbit-3", "orbit-dot", "target", "halo", "eye", "shield",
  "burst-8", "star-6", "spark-3", "bolt-ring", "flame", "chevrons-3", "plus-ring",
];

function renderTemplate({ ICONS, tplBody }, assetOrigin) {
  // mask-image 走 CORS，file:// 会被 Chromium 拒绝；资源一律走本地 http 服务（Python 侧起，根目录 = 仓库根）
  const assets = path.join(ROOT, "assets");
  const iconBase = assetOrigin + "/assets/providers";
  const glyphBase = assetOrigin + "/assets/glyphs";
  const ccLogo = assetOrigin + "/assets/ccswitch.png";
  const iconFiles = JSON.stringify(iconFilesOf(path.join(assets, "providers"), ["svg", "png"]));
  const have = new Set(Object.keys(iconFilesOf(path.join(assets, "glyphs"), ["svg"])));
  const glyphIds = JSON.stringify(GLYPH_ORDER.filter((g) => have.has(g)));
  const nonce = "RENDERPANELNONCE0000000";
  // 离屏渲染的 CSP：图标来自本地 http；脚本仍只跑模板自己的 nonce 脚本
  const csp = "default-src 'none'; img-src " + assetOrigin + " data:; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "';";
  // version / ghSvg / GITHUB_URL 是 html() 里的本地常量与导入（关于卡片用），离屏渲染用 stub 值即可
  const ghSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="8" cy="8" r="7"/></svg>';
  const GITHUB_URL = "https://github.com/yourhoneypomelo-cell/API4Kiro";
  const fn = new Function("ICONS", "csp", "nonce", "iconBase", "iconFiles", "glyphBase", "ccLogo", "glyphIds", "RECOMMENDED_COUNT", "version", "ghSvg", "GITHUB_URL", "return `" + tplBody + "`;");
  return { html: fn(ICONS, csp, nonce, iconBase, iconFiles, glyphBase, ccLogo, glyphIds, 10, "4.13.51", ghSvg, GITHUB_URL), nonce };
}

// ---------------------------------------------------------------- theme
const THEMES = {
  // VS Code Dark Modern（Kiro 默认深色主题的近似；真实 Kiro 变量值未导出，见汇报边界说明）
  dark: {
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-sideBar-background": "#181818",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif',
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
  },
  light: {
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#717171",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-editor-background": "#ffffff",
    "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-border": "#cecece",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif',
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
  },
};
function themeCss(name) {
  const t = THEMES[name] || THEMES.dark;
  const vars = Object.entries(t).map(([k, v]) => `${k}: ${v};`).join(" ");
  // VS Code webview 默认注入：body 透明、字体 / 字色跟主题；侧栏底色由宿主给。这里把宿主底色画在 html 上。
  return `<style id="host-theme">:root { ${vars} } html { background: var(--vscode-sideBar-background); color-scheme: ${name}; } body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; }</style>`;
}

// ---------------------------------------------------------------- mock state
function mockState() {
  const now = Date.now();
  const cred = (o) => Object.assign({
    id: "c1", label: "", customLabel: "", priority: 0, enabled: true, configured: true, maskedKey: "", account: "", plan: "",
    loginState: "", cooldownUntil: 0, cooldownReason: "", lastError: "", requests: 0, failures: 0, tokens: 0, lastTs: 0,
  }, o);
  const prov = (o) => Object.assign({
    id: "", name: "", protocol: "openai", anthropicMode: "kiro", openaiApi: "chat", format: "chat", baseUrl: "", hasKey: true, maskedKey: "sk-••••",
    enabled: true, usable: true, credentials: [], poolStrategy: "priority", poolSize: 1, poolCooling: 0, defaultModel: "", presetId: "",
    iconId: "", icon: "", autoIconId: "", auth: "key", oauthVendor: "", vendorName: "", account: "", plan: "", loginState: "", loginError: "",
  }, o);

  const providers = [
    prov({
      id: "p-kiro", name: "Kiro 官方", protocol: "kiro", format: "kiro", baseUrl: "https://q.us-east-1.amazonaws.com", presetId: "oauth-kiro",
      iconId: "kiro", autoIconId: "kiro", auth: "oauth", oauthVendor: "kiro", vendorName: "Kiro 官方", account: "yourh@gmail.com", plan: "Pro", loginState: "ok",
      poolSize: 2, credentials: [
        cred({ id: "c1", label: "yourh@gmail.com", account: "yourh@gmail.com", plan: "Pro", loginState: "ok", requests: 1284, failures: 3, tokens: 48_213_907, lastTs: now - 120_000 }),
        cred({ id: "c2", label: "work", customLabel: "公司号", account: "yourh.work@company-with-a-rather-long-domain.example.com", plan: "Pro+", loginState: "ok", priority: 1, requests: 96, tokens: 3_201_115, lastTs: now - 86_400_000 * 2 }),
      ],
    }),
    prov({
      id: "p-codex", name: "Codex (OpenAI)", protocol: "openai", openaiApi: "responses", format: "responses", baseUrl: "https://chatgpt.com/backend-api/codex", presetId: "oauth-codex",
      iconId: "openai", autoIconId: "openai", auth: "oauth", oauthVendor: "codex", vendorName: "Codex (OpenAI)", account: "yourh@outlook.com", plan: "plus",
      loginState: "expired", loginError: "刷新令牌被拒：invalid_grant — refresh_token 已在别处使用后失效，请重新登录", usable: true,
      credentials: [cred({ id: "c1", label: "yourh@outlook.com", account: "yourh@outlook.com", plan: "plus", loginState: "expired", lastError: "401 invalid_grant", requests: 412, failures: 41, tokens: 9_812_003, lastTs: now - 3_600_000 })],
    }),
    prov({
      id: "p-kimi", name: "Kimi", protocol: "anthropic", format: "anthropic", baseUrl: "https://api.kimi.com/coding", presetId: "oauth-kimi",
      iconId: "kimi-for-coding", autoIconId: "kimi-for-coding", auth: "oauth", oauthVendor: "kimi", vendorName: "Kimi", loginState: "ok",
      credentials: [cred({ id: "c1", label: "账号 1", loginState: "ok", requests: 77, tokens: 1_250_400, lastTs: now - 600_000 })],
    }),
    prov({
      id: "p-openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", presetId: "openrouter", iconId: "openrouter", autoIconId: "openrouter",
      maskedKey: "sk-or-v1-••••e3f2", poolStrategy: "least-used", poolSize: 3, poolCooling: 1, credentials: [
        cred({ id: "c1", label: "sk-or-v1-••••e3f2", maskedKey: "sk-or-v1-••••e3f2", requests: 2310, failures: 12, tokens: 91_002_331, lastTs: now - 30_000 }),
        cred({ id: "c2", label: "备用", customLabel: "备用", maskedKey: "sk-or-v1-••••9a10", priority: 1, requests: 88, tokens: 2_003_112, lastTs: now - 7_200_000,
          cooldownUntil: now + 43 * 60_000, cooldownReason: "402 余额不足", lastError: "402 Insufficient credits: This request requires more credits, or fewer max_tokens." }),
        cred({ id: "c3", label: "sk-or-v1-••••77c0", maskedKey: "sk-or-v1-••••77c0", priority: 2, enabled: false }),
      ],
    }),
    prov({
      id: "p-volc", name: "火山-Agent-plan-doubaoseed2.0-code", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", presetId: "", iconId: "volcengine", autoIconId: "volcengine",
      maskedKey: "3f9a••••-••••-b2c1", credentials: [cred({ id: "c1", label: "3f9a••••-••••-b2c1", maskedKey: "3f9a••••-••••-b2c1", requests: 534, tokens: 22_310_090, lastTs: now - 5_000 })],
    }),
    prov({
      id: "p-ccs", name: "AnyRouter", baseUrl: "https://anyrouter.top/v1", presetId: "", iconId: "", autoIconId: "",
      maskedKey: "sk-••••Qm3k", credentials: [cred({ id: "c1", label: "sk-••••Qm3k", maskedKey: "sk-••••Qm3k", requests: 12, tokens: 210_000, lastTs: now - 86_400_000 * 5 })],
    }),
    prov({
      id: "p-anthropic", name: "Anthropic 官方", protocol: "anthropic", anthropicMode: "official", format: "anthropic", baseUrl: "https://api.anthropic.com", presetId: "official-anthropic",
      iconId: "anthropic", autoIconId: "anthropic", maskedKey: "sk-ant-••••Kz9Q", credentials: [cred({ id: "c1", label: "sk-ant-••••Kz9Q", maskedKey: "sk-ant-••••Kz9Q", requests: 41, tokens: 5_120_000, lastTs: now - 1_800_000 })],
    }),
    prov({
      id: "p-deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", presetId: "deepseek", iconId: "deepseek", autoIconId: "deepseek",
      maskedKey: "sk-••••d51e", credentials: [cred({ id: "c1", label: "sk-••••d51e", maskedKey: "sk-••••d51e", requests: 9, tokens: 88_000, lastTs: now - 86_400_000 * 11 })],
    }),
    prov({
      id: "p-antigravity", name: "Antigravity (Google)", protocol: "gemini", format: "gemini", baseUrl: "https://cloudcode-pa.googleapis.com", presetId: "oauth-antigravity",
      iconId: "google", autoIconId: "google", auth: "oauth", oauthVendor: "antigravity", vendorName: "Antigravity (Google)", loginState: "missing", hasKey: false, usable: false,
      credentials: [cred({ id: "c1", label: "账号 1", configured: false, loginState: "missing" })],
    }),
    prov({
      id: "p-silicon", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", presetId: "md:siliconflow", iconId: "siliconflow", autoIconId: "siliconflow", enabled: false,
      maskedKey: "sk-••••uu81", credentials: [cred({ id: "c1", label: "sk-••••uu81", maskedKey: "sk-••••uu81" })],
    }),
  ];

  const presetBuiltin = [
    { id: "openrouter", name: "OpenRouter", blurb: "一个 Key 聚合上百家模型", protocol: "openai", format: "chat", anthropicMode: "", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-...", docsUrl: "https://openrouter.ai/keys", popular: true, source: "builtin", modelCount: 412, iconId: "openrouter" },
    { id: "deepseek", name: "DeepSeek", blurb: "DeepSeek 官方 API", protocol: "openai", format: "chat", anthropicMode: "", baseUrl: "https://api.deepseek.com/v1", keyHint: "sk-...", docsUrl: "https://platform.deepseek.com/api_keys", popular: true, source: "builtin", modelCount: 2, iconId: "deepseek" },
    { id: "official-openai", name: "OpenAI 官方", blurb: "OpenAI 官方直连（自带 key）", protocol: "openai", format: "chat", anthropicMode: "", baseUrl: "https://api.openai.com/v1", keyHint: "sk-...", docsUrl: "https://platform.openai.com/api-keys", popular: true, source: "builtin", modelCount: 58, iconId: "openai" },
    { id: "official-anthropic", name: "Anthropic 官方", blurb: "Anthropic 官方直连（自带 key，纯 /v1/messages）", protocol: "anthropic", format: "anthropic", anthropicMode: "official", baseUrl: "https://api.anthropic.com", keyHint: "sk-ant-...", docsUrl: "https://console.anthropic.com/settings/keys", popular: true, source: "builtin", modelCount: 14, iconId: "anthropic" },
    { id: "official-gemini", name: "Google Gemini 官方", blurb: "Google AI Studio 的 Gemini API（自带 key，generateContent）", protocol: "gemini", format: "gemini", anthropicMode: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyHint: "AIza...", docsUrl: "https://aistudio.google.com/apikey", popular: true, source: "builtin", modelCount: 31, iconId: "google" },
  ];
  const md = (id, name, env, n, popular, proto = "openai", base = "https://api.example.com/v1", iconId) => ({
    id: "md:" + id, name, blurb: (proto === "anthropic" ? "Anthropic" : proto === "gemini" ? "Gemini" : "Chat") + " · " + env, protocol: proto,
    format: proto === "anthropic" ? "anthropic" : proto === "gemini" ? "gemini" : "chat", anthropicMode: proto === "anthropic" ? "official" : "", baseUrl: base,
    keyHint: env, docsUrl: "https://example.com/docs", popular, source: "models.dev", modelCount: n, iconId: iconId === undefined ? id : iconId,
  });
  const presets = presetBuiltin.concat([
    md("kimi-for-coding", "Kimi For Coding", "KIMI_API_KEY", 3, true, "anthropic", "https://api.kimi.com/coding"),
    md("zhipuai", "Zhipu AI", "ZHIPU_API_KEY", 18, true, "openai", "https://open.bigmodel.cn/api/paas/v4"),
    md("alibaba-cn", "Alibaba (China)", "DASHSCOPE_API_KEY", 61, true, "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    md("minimax", "MiniMax", "MINIMAX_API_KEY", 6, true),
    md("siliconflow", "SiliconFlow", "SILICONFLOW_API_KEY", 92, true),
    md("moonshotai", "Moonshot AI", "MOONSHOT_API_KEY", 7, true),
    md("volcengine", "Volcengine", "VOLCENGINE_API_KEY", 40, true),
    md("xai", "xAI", "XAI_API_KEY", 9, true),
    md("groq", "Groq", "GROQ_API_KEY", 22, true),
    md("mistral", "Mistral", "MISTRAL_API_KEY", 27, true),
    md("togetherai", "Together AI", "TOGETHER_API_KEY", 130, true),
    md("fireworks-ai", "Fireworks AI", "FIREWORKS_API_KEY", 44, true),
    md("aihubmix", "AIHubMix", "AIHUBMIX_API_KEY", 380, true),
    md("302ai", "302.AI", "AI302_API_KEY", 210, true),
    md("cerebras", "Cerebras", "CEREBRAS_API_KEY", 5, false),
    md("nvidia", "NVIDIA", "NVIDIA_API_KEY", 88, false),
    md("huggingface", "Hugging Face", "HF_TOKEN", 300, false),
    md("perplexity", "Perplexity", "PERPLEXITY_API_KEY", 4, false),
    md("cohere", "Cohere", "COHERE_API_KEY", 11, false),
    md("venice", "Venice AI", "VENICE_API_KEY", 19, false),
    md("nebius", "Nebius Token Factory", "NEBIUS_API_KEY", 36, false),
    md("scaleway", "Scaleway Generative APIs", "SCALEWAY_API_KEY", 12, false),
    md("novita-ai", "Novita AI", "NOVITA_API_KEY", 60, false),
    md("upstage", "Upstage", "UPSTAGE_API_KEY", 3, false),
    md("zenmux", "ZenMux", "ZENMUX_API_KEY", 150, false),
    md("chutes", "Chutes", "CHUTES_API_KEY", 70, false),           // PNG 剪影
    md("abliteration-ai", "Abliteration AI", "ABLITERATION_API_KEY", 4, false),  // PNG 剪影
    md("some-unknown-cloud", "Some Unknown Cloud (no logo)", "SUC_API_KEY", 2, false, "openai", "https://api.suc.example/v1", "nonexistent-icon-id"),
  ]);

  const oauthVendors = [
    { id: "kimi", name: "Kimi", blurb: "Kimi Code 订阅（设备授权登录）· K2.7 Code / K3 等", flow: "device", loginModes: [], official: false, callbackPort: 0, signupUrl: "https://www.kimi.com/code", signupLabel: "", modelCount: 3, iconId: "kimi-for-coding" },
    { id: "codex", name: "Codex (OpenAI)", blurb: "ChatGPT Plus / Pro / Team 订阅（浏览器授权登录）· GPT-5 系", flow: "pkce", loginModes: [], official: false, callbackPort: 1455, signupUrl: "https://chatgpt.com/#pricing", signupLabel: "", modelCount: 6, iconId: "openai" },
    { id: "xai", name: "xAI (Grok)", blurb: "Grok CLI 账号（设备授权登录）· Grok 4 系", flow: "device", loginModes: [], official: false, callbackPort: 0, signupUrl: "https://x.ai/grok", signupLabel: "", modelCount: 4, iconId: "xai" },
    { id: "antigravity", name: "Antigravity (Google)", blurb: "Google 账号登录（浏览器授权）· Gemini 3 系 / Claude 4.6 / GPT-OSS", flow: "pkce", loginModes: [], official: false, callbackPort: 51121, signupUrl: "https://antigravity.google/", signupLabel: "", modelCount: 9, iconId: "google" },
    { id: "anthropic", name: "Anthropic (Claude)", blurb: "Claude Pro / Max 账号登录（浏览器授权）· Claude 5 / Opus 4.8 系 · 用量计入「额外用量」，需开启并充值；Free 账户不可用", flow: "pkce", loginModes: [], official: false, callbackPort: 54545, signupUrl: "https://claude.ai/settings/usage", signupLabel: "开启额外用量", modelCount: 8, iconId: "anthropic" },
    { id: "kiro", name: "Kiro 官方", blurb: "官方 Claude 系模型直通 · 导入本机 Kiro 的登录账号，或用浏览器再登一个（Google / GitHub / Builder ID），多账号成池", flow: "import", official: true, callbackPort: 0, signupUrl: "https://kiro.dev", signupLabel: "打开 kiro.dev", modelCount: 7, iconId: "kiro",
      loginModes: [
        { id: "oauth", label: "OAuth 授权", hint: "打开 Kiro 官方统一登录门户（app.kiro.dev），用 Google / GitHub / Builder ID 账号登录并授权。" },
        { id: "import", label: "本地导入", hint: "直接读取本机 Kiro 当前登录的账号（~/.aws/sso/cache/kiro-auth-token.json），不用再登录；token 到期由 Kiro 和本插件协同刷新。" },
        { id: "access_token", label: "Kiro Access Token", hint: "填入 Access Token，可选附带 Refresh Token、Profile ARN、Region，由插件在线激活并加入账号池。",
          fields: [
            { key: "accessToken", label: "Access Token", placeholder: "Bearer 访问令牌（若填了 refresh token 可留空）", secret: true },
            { key: "refreshToken", label: "Refresh Token", placeholder: "刷新令牌（长期使用建议提供）", secret: true },
            { key: "profileArn", label: "Profile ARN", placeholder: "可选，留空自动检测或使用官方默认" },
            { key: "region", label: "AWS Region", placeholder: "默认 us-east-1" },
          ] },
        { id: "json", label: "JSON 登录", hint: "整段粘贴 kiro-auth-token.json 内容或第三方工具导出的凭据 JSON。", fields: [{ key: "jsonText", label: "凭据 JSON 内容", placeholder: "粘贴包含 accessToken/refreshToken 的 JSON 对象或数组", multiline: true, required: true }] },
        { id: "api_key", label: "API Key 登录", hint: "填入 Kiro / Bedrock 官方 API Key，请求直连 q.{region}.amazonaws.com。", fields: [
          { key: "apiKey", label: "API Key", placeholder: "填入官方 API Key", secret: true, required: true },
          { key: "region", label: "AWS Region", placeholder: "默认 us-east-1" },
          { key: "endpoint", label: "自定义端点", placeholder: "可选，留空使用官方 q.{region}.amazonaws.com" },
        ] },
      ] },
  ];

  const state = { type: "state", enabled: true, providers, presets, oauthVendors, catalogSize: 2233, krsPort: 19810, cpsPort: 19811, selectedModel: "claude-fable-5-1" };

  // ---- models（4 个可用渠道 + 过期的 Codex 也带清单）
  const row = (id, o) => Object.assign({ id, kiroId: id, name: id, enabled: false, image: null, reasoning: null, autoImage: null, autoReasoning: null, imageSource: "none", reasoningSource: "none", override: null }, o);
  const R = { reasoning: true, autoReasoning: true, reasoningSource: "vendor" };
  const I = { image: true, autoImage: true, imageSource: "catalog" };
  const modelsByProvider = {
    "p-kiro": [
      row("claude-fable-5-1", { enabled: true, ...R, ...I }),
      row("claude-opus-4-8", { enabled: true, ...R, ...I }),
      row("claude-sonnet-4-6", { enabled: true, ...R, ...I }),
      row("claude-haiku-4-5", { enabled: true, ...I }),
      row("claude-opus-4-7", { ...R, ...I }),
      row("claude-sonnet-4-5", { ...I }),
      row("amazon-nova-pro-v1", {}),
    ],
    "p-openrouter": [
      row("anthropic/claude-opus-4.8", { enabled: true, kiroId: "anthropic/claude-opus-4.8", ...R, ...I }),
      row("openai/gpt-5.2-codex", { enabled: true, ...R }),
      row("google/gemini-3.8-flash-preview-09-2026-high-thinking-1m-context-experimental", { enabled: true, ...R, ...I, name: "google/gemini-3.8-flash-preview-09-2026-high-thinking-1m-context-experimental" }),
      row("deepseek/deepseek-v4-terminus", { enabled: true, kiroId: "deepseek/deepseek-v4-terminus@p-openrouter", ...R }),
      row("x-ai/grok-4.2", { enabled: true, ...R, ...I }),
      row("meta-llama/llama-4-maverick", { ...I }),
      row("mistralai/mistral-large-2607", {}),
      row("qwen/qwen3.5-397b-a17b-thinking", { ...R }),
      row("moonshotai/kimi-k3", { ...R }),
      row("nousresearch/hermes-4-405b", {}),
      row("z-ai/glm-5.3", { ...R, override: { reasoning: false }, reasoning: false }),
    ],
    "p-volc": [
      row("doubao-seed-2.0-code-preview-250901", { enabled: true, ...R, ...I }),
      row("doubao-seed-1.8-thinking-251015", { enabled: true, ...R }),
      row("doubao-seed-1.8-vision-251015", { ...I }),
      row("deepseek-v4-250801", { ...R }),
      row("kimi-k3-250901", { ...R }),
    ],
    "p-anthropic": [
      row("claude-opus-4-8-20260901", { enabled: true, ...R, ...I }),
      row("claude-sonnet-4-6-20260415", { ...R, ...I }),
      row("claude-haiku-4-5-20251001", { ...I }),
    ],
    "p-deepseek": [
      row("deepseek-chat", { enabled: true }),
      row("deepseek-reasoner", { enabled: true, ...R }),
    ],
    "p-kimi": [
      row("kimi-k3", { enabled: true, ...R }),
      row("kimi-k2.7-code", { ...R }),
    ],
    "p-ccs": [
      row("claude-opus-4-8", { enabled: true, kiroId: "claude-opus-4-8@p-ccs", ...R, ...I }),
      row("gpt-5.2", { ...R }),
    ],
    "p-codex": [
      row("gpt-5.2-codex", { enabled: true, ...R }),
      row("gpt-5.2", { enabled: true, ...R, ...I }),
    ],
  };
  const counts = {};
  for (const [pid, rows] of Object.entries(modelsByProvider)) counts[pid] = { total: rows.length, enabled: rows.filter((r) => r.enabled).length };
  counts["p-antigravity"] = null;
  const models = { type: "models", counts, modelsByProvider };

  const prompts = {
    type: "prompts", activeId: "pr1",
    prompts: [
      { id: "pr1", name: "严格中文工程助手", description: "全程简体中文；先结论后证据；不用激励套话", content: "你是一名严谨的软件工程助手……", enabled: true, updatedAt: now - 3_600_000, chars: 1842 },
      { id: "pr2", name: "Rust 重构专家（长名字测试：这个名字故意写得很长很长看看会不会被截断）", description: "", content: "x".repeat(12_345), enabled: false, updatedAt: now - 86_400_000, chars: 12_345 },
      { id: "pr3", name: "空内容草稿", description: "", content: "", enabled: false, updatedAt: now, chars: 0 },
    ],
  };

  const ccswitchResult = {
    type: "ccswitchResult", path: "C:\\Users\\YourH\\.cc-switch\\cc-switch.db",
    items: [
      { idx: 0, name: "AnyRouter", sources: ["claude"], format: "anthropic", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "https://anyrouter.top", maskedKey: "sk-••••Qm3k", models: ["claude-opus-4-8"], existsAs: "AnyRouter" },
      { idx: 1, name: "PackyCode", sources: ["claude", "codex"], format: "anthropic", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "https://api.packycode.com/v1/very/long/path/that/keeps/going", maskedKey: "sk-••••Zz01", models: ["claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.2-codex"] },
      { idx: 2, name: "Gemini CLI 直连", sources: ["gemini"], format: "gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", maskedKey: "AIza••••8H1q", models: [] },
    ],
    skipped: [{ name: "OpenCode Zen", source: "opencode", reason: "走账号登录，没有 Key" }],
  };

  return { state, models, prompts, ccswitchResult };
}

// ---------------------------------------------------------------- driver script injected into page
function driverScript(nonce, opts, mock) {
  return `<script nonce="${nonce}">
(function(){
  const M = ${JSON.stringify(mock)};
  const OPTS = ${JSON.stringify(opts)};
  window.__mock = M; // 供外部探针改状态后重发（如 XSS / 极端文本实验）
  const send = (m) => window.dispatchEvent(new MessageEvent('message', { data: m }));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const click = (el) => { if (!el) throw new Error('driver: 找不到要点击的元素'); el.click(); return el; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  send(M.state); send(M.models); send(M.prompts);
  window.__panelReady = (async () => {
    await sleep(20);
    click(q('.tab[data-tab="' + OPTS.tab + '"]'));
    await sleep(20);
    if (OPTS.tab === 'models' && OPTS.fold) {
      for (const h of qa('#selectedList .mgrouphead.fold')) { h.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerType: 'mouse', clientY: 100, bubbles: true })); window.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerType: 'mouse', clientY: 100, bubbles: true })); }
    }
    const modal = OPTS.modal;
    const expandSel = async () => { await sleep(10); if (!OPTS.fold) for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); };
    if (modal === 'select') { click(q('#showAdd')); await expandSel(); }
    else if (modal === 'allprov') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(q('.selmore')); }
    else if (modal === 'connect') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(qa('.selrow').find((r) => r.textContent.includes('自定义 Provider'))); await sleep(10); const n = q('.mName'); if (n) { n.value = '我的中转站'; n.dispatchEvent(new Event('input')); } const u = q('.mUrl'); if (u) u.value = 'https://relay.example.com/v1'; }
    else if (modal === 'connect-preset') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(qa('.selrow').find((r) => r.textContent.includes('OpenAI 官方'))); }
    else if (modal === 'edit') { click(q('.lrow[data-id="p-openrouter"] .rowact')); }
    else if (modal === 'edit-oauth') { click(q('.lrow[data-id="p-kiro"] .rowact')); }
    else if (modal === 'edit-expired') { click(q('.lrow[data-id="p-codex"] .rowact')); }
    else if (modal === 'addmodel') { click(q('#showAddModel')); await sleep(10); if (!OPTS.fold) for (const h of qa('.modal .mgrouphead.fold')) h.click(); }
    else if (modal === 'oauth') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(qa('.selrow').find((r) => r.textContent.includes('Codex'))); }
    else if (modal === 'oauth-kiro') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(qa('.selrow').find((r) => r.textContent.includes('Kiro Access Token'))); }
    else if (modal === 'oauth-device') { click(q('#showAdd')); await sleep(10); for (const h of qa('.selcardhead')) if (!h.parentElement.classList.contains('open')) h.click(); click(qa('.selrow').find((r) => r.textContent.includes('Kimi'))); await sleep(10); click(q('.oStart')); await sleep(10); send({ type: 'oauthSession', vendor: 'kimi', sessionId: 's1' }); send({ type: 'oauthStatus', vendor: 'kimi', sessionId: 's1', phase: 'device', userCode: 'HKQP-7ZR2', verificationUri: 'https://auth.kimi.com/device', text: '等待你在浏览器里确认授权…' }); }
    else if (modal === 'prompt') { click(q('#showAddPrompt')); }
    else if (modal === 'prompt-edit') { click(qa('#prompts .prow .iconbtn')[0]); }
    else if (modal === 'confirm') { click(q('.lrow[data-id="p-volc"] .rowact.del')); }
    else if (modal === 'ccimport') { click(q('#ccImport')); await sleep(10); send(M.ccswitchResult); }
    else if (modal) { throw new Error('driver: 未知 modal ' + modal); }
    if (OPTS.search) { const sq = q('.modal .sq') || q('#promptQ'); if (sq) { sq.value = OPTS.search; sq.dispatchEvent(new Event('input', { bubbles: true })); } }
    if (OPTS.toast) send({ type: 'toast', level: OPTS.toast === 'error' ? 'error' : 'ok', message: OPTS.toast === 'error' ? '已本地保存并生效；但未写入 Kiro 设置:EPERM: operation not permitted' : '已连接 OpenRouter，5 个模型进入 Kiro 列表' });
    await sleep(120);
    return true;
  })();
})();
</script>`;
}

// ---------------------------------------------------------------- python playwright shot driver
const PY_DRIVER = `import json, sys, threading, os, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

jobs = json.load(open(sys.argv[1], encoding="utf-8"))
root = sys.argv[2]
port = int(sys.argv[3])

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

srv = ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
PROBE = r"""
() => {
  const out = { width: innerWidth, height: innerHeight, docWidth: document.documentElement.scrollWidth, hOverflow: document.documentElement.scrollWidth > innerWidth };
  const tabs = document.querySelector('.tabs'); out.tabsClass = tabs ? tabs.className : null;
  const prov = document.getElementById('providers'); out.providersClass = prov ? prov.className : null;
  const lt = document.querySelector('#providers .lrow .ltext'); out.ltextWidth = lt ? lt.clientWidth : null;
  const ff = document.querySelector('#providers .fmt-full'); out.fmtFullDisplay = ff ? getComputedStyle(ff).display : null;
  const fa = document.querySelector('#providers .fmt-abbr'); out.fmtAbbrDisplay = fa ? getComputedStyle(fa).display : null;
  const tt = document.querySelector('.hdr .title-text'); out.titleDisplay = tt ? getComputedStyle(tt).display : null;
  const sl = document.querySelector('.switch-lbl'); out.switchLblDisplay = sl ? getComputedStyle(sl).display : null;
  const bl = document.querySelector('.badge .bi .lbl'); out.badgeLblDisplay = bl ? getComputedStyle(bl).display : null;
  const ov = document.querySelector('.overlay'); const md = document.querySelector('.modal');
  if (md) { const r = md.getBoundingClientRect(); out.modal = { top: r.top, left: r.left, width: r.width, height: r.height, bottomGap: innerHeight - r.bottom, centeredX: Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 2, centeredY: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < 2, handles: md.querySelectorAll('.rz').length, kind: md.className }; }
  const sel = document.querySelector('.mline.selected'); out.selectedAnim = sel ? getComputedStyle(sel).animationName : null;
  const dot = document.querySelector('.defpill .dot'); out.defpillDotAfterAnim = dot ? getComputedStyle(dot, '::after').animationName : null;
  const spin = document.querySelector('.spin'); out.spinAnim = spin ? getComputedStyle(spin).animationName : null;
  const toast = document.getElementById('toast'); out.toastOpacityShow = toast ? (toast.classList.add('show'), getComputedStyle(toast).opacity) : null; if (toast) toast.classList.remove('show');
  // 文字压到控件 / 溢出：找 nowrap+hidden 且 scrollWidth>clientWidth 的元素
  const trunc = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length && !el.matches('.ln,.nm,.mid,.pid,.ls,.tab .lbl,.btn .lbl,.gn,.csel-label,.ipick-lbl,.kname .mono,.kname .nm,.ksub')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || !el.offsetParent) continue;
    if (el.scrollWidth > el.clientWidth + 1) trunc.push({ sel: el.className || el.tagName, text: (el.textContent || '').trim().slice(0, 48), ellipsis: cs.textOverflow === 'ellipsis', over: el.scrollWidth - el.clientWidth });
  }
  out.truncated = trunc.slice(0, 40);
  // 按钮尺寸（同一容器内的高度是否一致）
  out.buttons = Array.from(document.querySelectorAll('.mfootbtns .btn, .btnrow .btn, .editbar .btn')).filter((b) => b.offsetParent).map((b) => ({ cls: b.className, w: Math.round(b.offsetWidth), h: Math.round(b.offsetHeight), fs: getComputedStyle(b).fontSize }));
  out.picons = Array.from(document.querySelectorAll('.picon')).filter((p) => p.offsetParent).slice(0, 60).map((p) => p.className);
  out.posted = (window.__posted || []).map((m) => m.type);
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch()
    for j in jobs:
        ctx = b.new_context(viewport={"width": j["width"], "height": j["height"]}, device_scale_factor=j.get("scale", 2), color_scheme=j.get("theme", "dark"), reduced_motion=("reduce" if j.get("reducedMotion") else "no-preference"))
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append("console." + m.type + ": " + m.text) if m.type in ("error", "warning") else None)
        rel = os.path.relpath(j["html"], root).replace("\\\\", "/")
        pg.goto("http://127.0.0.1:%d/%s" % (port, rel))
        try:
            pg.wait_for_function("() => window.__panelReady && window.__panelReady.then", timeout=5000)
            pg.evaluate("() => window.__panelReady")
        except Exception as e:
            errors.append("driver: " + str(e))
        pg.wait_for_timeout(250)
        probe = pg.evaluate(PROBE)
        probe["errors"] = errors
        pg.screenshot(path=j["png"], full_page=not j.get("modal"))
        with open(j["probe"], "w", encoding="utf-8") as f:
            json.dump(probe, f, ensure_ascii=False, indent=1)
        print("OK", j["png"], "errors=" + str(len(errors)), "hOverflow=" + str(probe.get("hOverflow")))
        ctx.close()
    b.close()
srv.shutdown()
`;

// ---------------------------------------------------------------- main
function buildJob(a, tpl, mock, outDir) {
  const base = `panel-${a.tab}-${a.width}${a.modal ? "-" + a.modal : ""}${a.fold ? "-fold" : ""}${a.search ? "-q" : ""}${a.toast ? "-toast-" + a.toast : ""}${a.reducedMotion ? "-rm" : ""}${a.theme !== "dark" ? "-" + a.theme : ""}`;
  const { html, nonce } = renderTemplate(tpl, "http://127.0.0.1:" + a.port);
  const stub = `<script nonce="${nonce}">window.__posted = []; window.__vsState = {}; window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState() { return window.__vsState; }, setState(s) { window.__vsState = s; } });</script>`;
  let out = html.replace("</head>", themeCss(a.theme) + "\n" + stub + "\n</head>");
  out = out.replace("</body>", driverScript(nonce, { tab: a.tab, modal: a.modal, fold: a.fold, search: a.search || "", toast: a.toast || "" }, mock) + "\n</body>");
  const htmlPath = path.join(outDir, base + ".html");
  fs.writeFileSync(htmlPath, out, "utf8");
  return { html: htmlPath, png: path.join(outDir, base + ".png"), probe: path.join(outDir, base + ".probe.json"), width: a.width, height: a.height, scale: a.scale, theme: a.theme, reducedMotion: a.reducedMotion, modal: !!a.modal || !!a.toast, name: base };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, a.out);
  fs.mkdirSync(outDir, { recursive: true });
  const src = fs.readFileSync(SRC, "utf8");
  const tpl = extractTemplate(src);
  console.log(`模板：src/sidebar.ts 第 ${tpl.tplLine} 行起，${tpl.tplBody.length} 字符；ICONS ${Object.keys(tpl.ICONS).length} 枚`);
  const mock = mockState();

  const jobs = [];
  if (a.all) {
    for (const tab of ["providers", "models", "settings"]) for (const w of [220, 300, 380, 460, 600]) jobs.push(buildJob({ ...a, tab, width: w, modal: "", fold: false }, tpl, mock, outDir));
    jobs.push(buildJob({ ...a, tab: "models", width: 300, modal: "", fold: true }, tpl, mock, outDir));
    jobs.push(buildJob({ ...a, tab: "models", width: 380, modal: "", fold: false, reducedMotion: true }, tpl, mock, outDir));
    for (const [tab, modal] of [["providers", "select"], ["providers", "connect"], ["providers", "connect-preset"], ["providers", "edit"], ["providers", "edit-oauth"], ["providers", "edit-expired"], ["models", "addmodel"], ["providers", "oauth"], ["providers", "oauth-kiro"], ["providers", "oauth-device"], ["settings", "prompt"], ["settings", "prompt-edit"], ["providers", "confirm"], ["providers", "allprov"], ["providers", "ccimport"]]) {
      jobs.push(buildJob({ ...a, tab, width: 380, modal, fold: false }, tpl, mock, outDir));
    }
    jobs.push(buildJob({ ...a, tab: "providers", width: 300, modal: "select", fold: true }, tpl, mock, outDir));
    jobs.push(buildJob({ ...a, tab: "providers", width: 220, modal: "edit", fold: false }, tpl, mock, outDir));
  } else {
    jobs.push(buildJob(a, tpl, mock, outDir));
  }
  for (const j of jobs) console.log("HTML", path.relative(ROOT, j.html));
  if (a.htmlOnly) return;

  const pyPath = path.join(outDir, "_shot.py");
  fs.writeFileSync(pyPath, PY_DRIVER, "utf8");
  const jobsPath = path.join(outDir, "_jobs.json");
  fs.writeFileSync(jobsPath, JSON.stringify(jobs), "utf8");
  const r = spawnSync("python", [pyPath, jobsPath, ROOT, String(a.port)], { stdio: "inherit", cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  if (r.error) { console.error("启动 python 失败：", r.error.message, "\n请安装：pip install playwright && python -m playwright install chromium"); process.exit(3); }
  if (r.status !== 0) { console.error("截图失败，退出码", r.status, "\n若缺依赖：pip install playwright && python -m playwright install chromium"); process.exit(r.status || 3); }
  for (const j of jobs) console.log("PNG ", path.relative(ROOT, j.png));
}

main();
