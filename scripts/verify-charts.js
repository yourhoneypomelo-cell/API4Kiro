const fs = require('fs');
const path = require('path');

const sidebarPath = path.resolve(__dirname, '../src/sidebar.ts');
const src = fs.readFileSync(sidebarPath, 'utf8');

const cssMatch = src.match(/<style>([\s\S]*?)<\/style>/);
const css = cssMatch ? cssMatch[1] : '';

const palMatch = src.match(/const PALETTE = (\[[\s\S]*?\]);/);
const paletteStr = palMatch ? palMatch[1] : '[]';

const layoutMatch = src.match(/function layoutSankey[\s\S]*?\n  function renderSankey/);
const layoutCode = layoutMatch ? layoutMatch[0].replace(/\n  function renderSankey/, '') : '';

const renderMatch = src.match(/function renderSankey[\s\S]*?\n  function renderUsage/);
const renderCode = renderMatch ? renderMatch[0].replace(/\n  function renderUsage/, '') : '';

const fixtures = {
  standard: {
    nodes: [
      { id: 'p:antigravity', name: 'Antigravity (主力)', layer: 0 },
      { id: 'p:anthropic', name: 'Anthropic Direct', layer: 0 },
      { id: 'p:kimi', name: 'Kimi Moonshot', layer: 0 },
      { id: 'p:deepseek', name: 'DeepSeek 官方', layer: 0 },
      
      { id: 'c:anti-acc1', name: 'Anti 主账号 (sk-pro-***)', layer: 1 },
      { id: 'c:anti-acc2', name: 'Anti 备用号 (sk-ent-***)', layer: 1 },
      { id: 'c:anthro-key', name: 'Claude Pro Key (sk-ant-***)', layer: 1 },
      { id: 'c:kimi-pool', name: 'Kimi 会员凭证池 (4把Key)', layer: 1 },
      { id: 'c:ds-main', name: 'DeepSeek 平台 Key (sk-ds-***)', layer: 1 },

      { id: 'm:gemini-3.8-flash', name: 'gemini-3.8-flash', layer: 2 },
      { id: 'm:claude-3-7-sonnet', name: 'claude-3-7-sonnet', layer: 2 },
      { id: 'm:deepseek-v4-pro', name: 'deepseek-v4-pro', layer: 2 },
      { id: 'm:kimi-k1.5', name: 'kimi-k1.5-preview', layer: 2 },
      { id: 'm:gpt-5.6-terra', name: 'gpt-5.6-terra', layer: 2 },

      { id: 's:success', name: '调用成功 200 OK', layer: 3 },
      { id: 's:failed', name: '异常重试 / 失败', layer: 3 }
    ],
    links: [
      { source: 'p:antigravity', target: 'c:anti-acc1', tokens: 12500000, requests: 1240 },
      { source: 'p:antigravity', target: 'c:anti-acc2', tokens: 4800000, requests: 430 },
      { source: 'p:anthropic', target: 'c:anthro-key', tokens: 8900000, requests: 860 },
      { source: 'p:kimi', target: 'c:kimi-pool', tokens: 6200000, requests: 950 },
      { source: 'p:deepseek', target: 'c:ds-main', tokens: 18400000, requests: 2100 },

      { source: 'c:anti-acc1', target: 'm:gemini-3.8-flash', tokens: 9500000, requests: 980 },
      { source: 'c:anti-acc1', target: 'm:gpt-5.6-terra', tokens: 3000000, requests: 260 },
      { source: 'c:anti-acc2', target: 'm:gemini-3.8-flash', tokens: 4800000, requests: 430 },
      { source: 'c:anthro-key', target: 'm:claude-3-7-sonnet', tokens: 8900000, requests: 860 },
      { source: 'c:kimi-pool', target: 'm:kimi-k1.5', tokens: 6200000, requests: 950 },
      { source: 'c:ds-main', target: 'm:deepseek-v4-pro', tokens: 18400000, requests: 2100 },

      { source: 'm:gemini-3.8-flash', target: 's:success', tokens: 14100000, requests: 1390 },
      { source: 'm:gemini-3.8-flash', target: 's:failed', tokens: 200000, requests: 20 },
      { source: 'm:claude-3-7-sonnet', target: 's:success', tokens: 8700000, requests: 840 },
      { source: 'm:claude-3-7-sonnet', target: 's:failed', tokens: 200000, requests: 20 },
      { source: 'm:deepseek-v4-pro', target: 's:success', tokens: 18100000, requests: 2060 },
      { source: 'm:deepseek-v4-pro', target: 's:failed', tokens: 300000, requests: 40 },
      { source: 'm:kimi-k1.5', target: 's:success', tokens: 6100000, requests: 935 },
      { source: 'm:kimi-k1.5', target: 's:failed', tokens: 100000, requests: 15 },
      { source: 'm:gpt-5.6-terra', target: 's:success', tokens: 2950000, requests: 255 },
      { source: 'm:gpt-5.6-terra', target: 's:failed', tokens: 50000, requests: 5 }
    ]
  },
  skewed: {
    nodes: [
      { id: 'p:main', name: '主要提供商 (巨量)', layer: 0 },
      { id: 'p:backup', name: '极小备用渠道', layer: 0 },
      { id: 'c:main-key', name: '主要凭证', layer: 1 },
      { id: 'c:bak-key', name: '备用凭证', layer: 1 },
      { id: 'm:heavy-model', name: 'heavy-model-4k', layer: 2 },
      { id: 'm:tiny-model', name: 'tiny-model-test', layer: 2 },
      { id: 's:success', name: '成功', layer: 3 }
    ],
    links: [
      { source: 'p:main', target: 'c:main-key', tokens: 99990000, requests: 9990 },
      { source: 'p:backup', target: 'c:bak-key', tokens: 10000, requests: 10 },
      { source: 'c:main-key', target: 'm:heavy-model', tokens: 99990000, requests: 9990 },
      { source: 'c:bak-key', target: 'm:tiny-model', tokens: 10000, requests: 10 },
      { source: 'm:heavy-model', target: 's:success', tokens: 99990000, requests: 9990 },
      { source: 'm:tiny-model', target: 's:success', tokens: 10000, requests: 10 }
    ]
  }
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>分流桑基图视觉审查</title>
<style>
:root {
  --vscode-editor-background: #141118;
  --vscode-sideBar-background: #191520;
  --vscode-foreground: #edeaf1;
  --vscode-descriptionForeground: #a39cae;
  --vscode-widget-border: #383044;
  --vscode-input-background: #1e1926;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --accent-rgb: 166, 108, 255;
  --accent-edge: 216, 180, 254;
  --accent: #a66cff;
  --accent-fg: #ffffff;
  --border: rgba(255, 255, 255, 0.12);
  --card: #1f1a29;
  --card2: #272134;
  --muted: #a39cae;
  --fg: #edeaf1;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
}
body {
  background: var(--vscode-sideBar-background);
  color: var(--fg);
  font-family: var(--vscode-font-family);
  margin: 0;
  padding: 24px;
}
.header-panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.header-panel h1 {
  margin: 0;
  font-size: 16px;
  color: rgb(var(--accent-edge));
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.5);
}
.tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
button.tool-btn {
  background: var(--card2);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
button.tool-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
button.tool-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.4);
}
.preview-container {
  margin: 0 auto;
  width: 100%;
  transition: width 0.3s ease;
}
.preview-container.narrow {
  width: 380px;
}
.preview-container.medium {
  width: 640px;
}
.preview-container.wide {
  width: 1000px;
}

${css}
</style>
</head>
<body>
<div class="header-panel">
  <div>
    <h1>分流桑基图高精视觉审查面板</h1>
    <div style="font-size:12px; color:var(--muted); margin-top:4px;">环境：纯原生 SVG 贝塞尔曲线，暗色夜幕渐变主题，Kiro 级微光气泡提示</div>
  </div>
  <div class="tools">
    <span style="font-size:12px; color:var(--muted);">容器宽度:</span>
    <button class="tool-btn" id="btnNarrow" onclick="setWidth('narrow')">窄栏 380px</button>
    <button class="tool-btn" id="btnMedium" onclick="setWidth('medium')">中栏 640px</button>
    <button class="tool-btn active" id="btnWide" onclick="setWidth('wide')">宽屏 1000px</button>
    <span style="font-size:12px; color:var(--muted); margin-left:10px;">数据集:</span>
    <button class="tool-btn active" id="btnDsStd" onclick="setFixture('standard')">多模型标准</button>
    <button class="tool-btn" id="btnDsSkew" onclick="setFixture('skewed')">99%极端倾斜</button>
  </div>
</div>
<div class="preview-container wide" id="container">
  <div class="card ucard-sankey">
    <div class="cardhead">
      <div>
        <h3>分流桑基图</h3>
        <div class="muted" style="font-size:10.5px;margin-top:2px;">渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态</div>
      </div>
      <div class="seg useg-sk" role="tablist">
        <button data-sk="tokens" class="sel" onclick="setDim('tokens', this)">Token</button>
        <button data-sk="requests" onclick="setDim('requests', this)">次数</button>
      </div>
    </div>
    <div class="usankey-scroll">
      <div class="usankey-box" id="uSankeySvg"></div>
    </div>
  </div>
</div>
<div id="kTip"></div>
<script>
const $ = (id) => document.getElementById(id);
const PALETTE = ${paletteStr};
let sankeyDim = "tokens";
const fixtures = ${JSON.stringify(fixtures)};
let currentData = fixtures.standard;
let kTipTarget = null;
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
const tipEl = $('kTip');
function showKTip(target, html) {
  kTipTarget = target;
  tipEl.innerHTML = html.replace(/\\n/g, "<br/>");
  tipEl.classList.add("show");
  positionKTip(target);
}
function hideKTip() {
  kTipTarget = null;
  tipEl.classList.remove("show");
}
function positionKTip(target) {
  const rect = target.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  let left = rect.left + (rect.width - tipRect.width) / 2;
  let top = rect.top - tipRect.height - 8;
  if (left < 10) left = 10;
  if (left + tipRect.width > window.innerWidth - 10) left = window.innerWidth - tipRect.width - 10;
  if (top < 10) top = rect.bottom + 8;
  tipEl.style.left = left + "px";
  tipEl.style.top = top + "px";
}
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-k-tip]");
  if (target) showKTip(target, target.getAttribute("data-k-tip"));
});
document.addEventListener("mouseout", (e) => {
  const target = e.target.closest("[data-k-tip]");
  if (target && target === kTipTarget) hideKTip();
});

${layoutCode}
${renderCode}

function setWidth(mode) {
  document.querySelectorAll(".tools button[id^=btnN], .tools button[id^=btnM], .tools button[id^=btnW]").forEach(b => b.classList.remove("active"));
  const c = $('container');
  c.className = "preview-container " + mode;
  if (mode === "narrow") $('btnNarrow').classList.add("active");
  if (mode === "medium") $('btnMedium').classList.add("active");
  if (mode === "wide") $('btnWide').classList.add("active");
  setTimeout(() => renderSankey(currentData), 60);
}
function setFixture(f) {
  document.querySelectorAll("#btnDsStd, #btnDsSkew").forEach(b => b.classList.remove("active"));
  currentData = fixtures[f];
  if (f === "standard") $('btnDsStd').classList.add("active");
  if (f === "skewed") $('btnDsSkew').classList.add("active");
  renderSankey(currentData);
}
function setDim(dim, btn) {
  document.querySelectorAll(".useg-sk button").forEach(b => b.classList.remove("sel"));
  btn.classList.add("sel");
  sankeyDim = dim;
  renderSankey(currentData);
}
renderSankey(currentData);
window.addEventListener("resize", () => renderSankey(currentData));
</script>
</body>
</html>`;

const outPath = path.resolve(__dirname, '../sankey-inspect.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('HTML written to:', outPath);
