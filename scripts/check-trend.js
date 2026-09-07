const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar.ts'), 'utf8');
const scriptTag = '<script nonce="${nonce}">';
const start = source.indexOf(scriptTag) + scriptTag.length;
const raw = source.slice(start, source.indexOf('</script>', start)).replace(/\$\{[^}]*\}/g, 'null');
const script = vm.runInNewContext('`' + raw + '`');
const renderer = script.slice(script.indexOf('  function renderTrendCurve('), script.indexOf('  function renderDonut('));
const helpers = ['fmt', 'esc', 'tokShort', 'PALETTE'].map((name) => {
  const line = script.split('\n').find((l) => l.startsWith('  const ' + name + ' ='));
  assert.ok(line, name + ' helper missing');
  return line;
}).join('\n');
const css = source.slice(source.indexOf('<style>') + 7, source.indexOf('</style>'));
const tooltip = script.slice(script.indexOf('  const kTipEl ='), script.indexOf('  function confirmDeleteProvider('));

function fixture(single = false) {
  return Array.from({ length: 24 }, (_, hour) => {
    const a = hour === 2 ? 60000 : hour === 11 ? 120000 : hour === 14 ? 65000 : 0;
    const b = single ? 0 : hour === 11 ? 64000 : hour === 12 ? 36000 : 0;
    // 请求数与 Token 刻意不成比例：glm 每次请求小、次数多，用来证明请求维按 modelRequests 排名与画线
    const ra = a > 0 ? 1 : 0;
    const rb = b > 0 ? 3 : 0;
    return {
      ts: new Date(2026, 8, 4, hour).getTime(), label: String(hour).padStart(2, '0') + ':00',
      tokens: a + b, requests: ra + rb,
      modelTokens: single ? { 'deepseek-v4-pro': a } : { 'deepseek-v4-pro': a, 'glm-5.3-flash': b },
      modelRequests: single ? { 'deepseek-v4-pro': ra } : { 'deepseek-v4-pro': ra, 'glm-5.3-flash': rb },
    };
  });
}

function fixtureScreenshot4() {
  return [
    {
      ts: new Date(2026, 8, 3).getTime(), label: '9/3',
      tokens: 60000000, requests: 1200,
      modelTokens: {
        'gemini-3.8-flash': 50000000,
        'deepseek-v4-pro': 8000000,
        'muse-spark-1.3-contributor-free': 1500000,
        'gpt-5.6-terra': 500000,
      },
    },
    {
      ts: new Date(2026, 8, 4).getTime(), label: '9/4',
      tokens: 10000000, requests: 300,
      modelTokens: {
        'gemini-3.8-flash': 2000000,
        'deepseek-v4-pro': 7000000,
        'muse-spark-1.3-contributor-free': 800000,
        'gpt-5.6-terra': 200000,
      },
    },
  ];
}

const lastRender = { title: null, legend: [] };
function render(points, width, height = 150, rawTrend = [], dim = 'tokens') {
  const box = { innerHTML: '', clientWidth: width, clientHeight: height };
  const title = { textContent: '' };
  const legendItems = [];
  const legend = { innerHTML: '', appendChild(el) { legendItems.push(el.innerHTML); } };
  const context = vm.createContext({
    document: {
      getElementById: (id) => id === 'uCurveSvg' ? box : id === 'trendTitle' ? title : legend,
      createElement: () => ({ innerHTML: '', className: '' }),
    },
  });
  // 渲染函数读取 webview 顶层的 curveDim（'tokens' | 'requests'），这里按用例注入
  vm.runInContext('var curveDim = ' + JSON.stringify(dim) + ';\n' + helpers + '\n' + renderer, context);
  context.renderTrendCurve([], rawTrend, points, 'today');
  lastRender.title = title.textContent;
  lastRender.legend = legendItems;
  return box.innerHTML;
}

function checkLayers(svg, modelCount) {
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(svg.indexOf('class="cv-areas"') < svg.indexOf('class="cv-lines"'));
  const lines = svg.match(/<g class="cv-lines"[^>]*>([\s\S]*?)<\/g>/)[1];
  const paths = [...lines.matchAll(/<path class="([^"]+)"[^>]*>/g)];
  assert.equal(paths[0][1], 'cv-path');
  assert.equal(paths.length, modelCount + 1);
  assert.ok(paths.slice(1).every((p) => p[1] === 'cv-model-path'));
  assert.ok(!lines.includes('fill="url('));
  assert.ok(svg.indexOf('class="cv-lines"') < svg.indexOf('class="cv-col-group"'));
  return paths;
}

for (const width of [160, 240, 480, 880]) {
  const single = render(fixture(true), width);
  const paths = checkLayers(single, 1);
  assert.equal(paths[0][0].match(/ d="([^"]*)"/)[1], paths[1][0].match(/ d="([^"]*)"/)[1]);
  assert.equal(paths[1][0].match(/ stroke="([^"]*)"/)[1], '#10b981');
  const singleGroups = [...single.matchAll(/<g class="cv-col-group">([\s\S]*?)<\/g>/g)];
  assert.equal(singleGroups.length, 24);
  assert.ok(singleGroups[2][1].includes('class="cv-dot-model"'));
  assert.ok(!singleGroups[2][1].includes('class="cv-dot-main"'));
  assert.ok(singleGroups[2][1].includes('data-k-tip='));
  const multi = render(fixture(), width);
  checkLayers(multi, 2);
  const multiGroups = [...multi.matchAll(/<g class="cv-col-group">([\s\S]*?)<\/g>/g)];
  assert.ok(multiGroups[11][1].indexOf('class="cv-dot-main"') < multiGroups[11][1].indexOf('class="cv-dot-model"'));
  assert.ok(!multiGroups[14][1].includes('class="cv-dot-main"'));
  assert.ok(single.includes('viewBox="0 0 ' + width + ' 150"'));
  console.log('PASS: ' + width + 'px single/multiple models, paint order, coincident points, hover markup');
}
checkLayers(render(fixture(true).slice(2, 3), 480), 1);
assert.ok(render([], 240).includes('暂无趋势数据'));
checkLayers(render([], 480, 150, [{ day: 0, tokens: 100, requests: 1 }]), 0);
assert.ok(css.includes('vector-effect:non-scaling-stroke'));
assert.match(css, /\.cv-path \{ stroke-width:1\.2px; stroke-opacity:\.75; \}/);
assert.match(css, /\.cv-model-path \{ stroke-width:1\.4px; \}/);
assert.ok(!css.includes('.cv-path:hover'));
assert.match(css, /\.cv-col-group \{ opacity: 0;/);
assert.match(css, /\.cv-col-group:hover, \.cv-col-group.active \{ opacity: 1;/);
console.log('PASS: empty/fallback/single point, thin non-scaling lines, default-hidden hover markers');

// 用户要求「窗口被挤压折叠时优先显示最新日期」：横轴标签以最新点为锚等距取样，
// 最新标签必须在，任意两枚标签的点位间距都等于步长（旧写法在 24/30 点、步长 2 时会让末两枚相邻贴合）。
function xAxisIndices(svg, labels) {
  const shown = [...svg.matchAll(/<text class="cv-axis-txt" x="[^"]+" y="[^"]+" text-anchor="middle"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  return shown.map((text) => labels.indexOf(text));
}
function daysFixture(count) {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(2026, 7, 8 + i).getTime(), label: (new Date(2026, 7, 8 + i).getMonth() + 1) + '/' + new Date(2026, 7, 8 + i).getDate(),
    tokens: (i * 7919) % 90000, requests: i % 5, modelTokens: {},
  }));
}
for (const points of [fixture(), daysFixture(30), daysFixture(7)]) {
  const labels = points.map((p) => p.label);
  for (const width of [160, 200, 240, 320, 480, 650, 880, 1000, 1360]) {
    const idx = xAxisIndices(render(points, width), labels);
    assert.ok(idx.length >= 2, width + 'px: at least two axis labels');
    assert.ok(idx.every((i) => i >= 0), width + 'px: every axis label maps to a data point');
    assert.equal(idx[idx.length - 1], points.length - 1, width + 'px: latest point label must be shown');
    const gaps = idx.slice(1).map((v, i) => v - idx[i]);
    assert.ok(gaps.every((g) => g === gaps[0]), width + 'px: axis labels evenly spaced, none crowding the latest one: ' + JSON.stringify(idx));
    assert.ok(gaps[0] >= 1 && (points.length <= 7 || gaps[0] * idx.length >= points.length - gaps[0]), width + 'px: stride covers the series');
  }
}
console.log('PASS: x-axis labels anchored on the latest point for 24/30/7-point series across 9 widths');

// 纵轴刻度文字必须完整落在画布内：以文字右端 x 减去按字宽估算的宽度 ≥ 0（截图里「6988 万」曾被裁掉首位）。
function yAxisFits(svg, fontSize) {
  const ticks = [...svg.matchAll(/<text class="cv-axis-txt" x="([^"]+)" y="[^"]+" text-anchor="end"[^>]*>([^<]*)<\/text>/g)];
  assert.ok(ticks.length >= 3, 'y-axis ticks present');
  for (const [, x, text] of ticks) {
    let width = 0;
    for (const ch of text) width += ch.codePointAt(0) > 255 ? fontSize : (ch === ' ' ? fontSize * 0.3 : fontSize * 0.6);
    assert.ok(Number(x) - width >= 0, 'y-axis label "' + text + '" overflows left edge at x=' + x);
  }
  return ticks.map((t) => t[2]);
}
const bigDays = daysFixture(30).map((p, i) => ({ ...p, tokens: i === 25 ? 69880000 : p.tokens }));
for (const width of [160, 240, 480, 880]) yAxisFits(render(bigDays, width), width < 180 ? 8.5 : 10);
yAxisFits(render(fixture(), 480), 10);
assert.ok(yAxisFits(render(bigDays, 480), 10).some((t) => t.includes('万')), 'tick labels use the 万 scale for the big fixture');
console.log('PASS: y-axis tick labels fit inside the left padding for 万-scale values');

// 「全部」范围宿主会给出从纪元起逐日补零的长序列；渲染只保留首个有数据的点起的尾段，无数据时保留最新 31 点。
function groupCount(svg) { return [...svg.matchAll(/<g class="cv-col-group">/g)].length; }
const epochSeries = Array.from({ length: 400 }, (_, i) => ({ ts: i, label: 'd' + i, tokens: i >= 380 ? 1000 : 0, requests: i >= 380 ? 1 : 0, modelTokens: {} }));
assert.equal(groupCount(render(epochSeries, 480)), 20, 'leading all-zero history trimmed to the active span');
assert.ok(render(epochSeries, 480).includes('>d399<'), 'latest point kept after trimming');
assert.equal(groupCount(render(epochSeries.map((p) => ({ ...p, tokens: 0, requests: 0 })), 480)), 31, 'all-zero long series keeps the latest 31 points');
assert.equal(groupCount(render(daysFixture(30), 480)), 30, '30-day series is never trimmed');
assert.equal(groupCount(render(epochSeries.slice(0, 31), 480)), 31, '31-point series is never trimmed');
console.log('PASS: long epoch-padded series trimmed to the active span, latest point retained');

// 针对用户反馈「总用量和单独模型的颜色重复这是个错误」的专项校验
const fourModelSvg = render(fixtureScreenshot4(), 480);
const fourPaths = checkLayers(fourModelSvg, 4);
const totalColor = fourPaths[0][0].match(/ stroke="([^"]*)"/)[1].toLowerCase();
const modelColors = fourPaths.slice(1).map((p) => p[0].match(/ stroke="([^"]*)"/)[1].toLowerCase());

assert.equal(totalColor, '#a66cff', '总用量主曲线应保持主题荧光紫');
assert.ok(!modelColors.includes(totalColor), '没有任何单独模型的曲线颜色与总用量重复');
assert.ok(!modelColors.includes('#8b5cf6'), '单独模型颜色中不可再包含与总用量雷同的紫色系');
assert.equal(new Set([totalColor, ...modelColors]).size, 5, '总用量与所有 4 个单独模型的曲线颜色必须全不相同');
assert.deepEqual(modelColors, ['#10b981', '#3b82f6', '#f43f5e', '#f59e0b'], '4 个模型分别使用翠绿、亮蓝、玫瑰红、琥珀橙，色相截然不同');
console.log('PASS: 4-model screenshot fixture: total and all model colors are strictly distinct, zero purple collision');

// 趋势卡维度切换：Token / 请求（用户 2026-09-07：「近 7 日 / 近 30 日无意义，应该改成 token / 请求，标题对应『每日 Token 趋势图』『每日 请求 趋势图』」）
{
  const tplStart = source.indexOf('id="trendCard"');
  const tpl = source.slice(tplStart, source.indexOf('</div>', source.indexOf('useg-curve', tplStart)));
  assert.ok(tpl.includes('<h3 id="trendTitle">每日 Token 趋势图</h3>'), 'default title');
  assert.ok(tpl.includes('data-cv="tokens" class="sel">Token<'), 'Token button selected by default');
  assert.ok(tpl.includes('data-cv="requests">请求<'), '请求 button');
  assert.ok(!/近 7 日|近 30 日|data-cv="7d"|data-cv="30d"/.test(tpl), 'dead range buttons removed');

  const tok = render(fixture(), 480);
  assert.equal(lastRender.title, '每日 Token 趋势图');
  assert.ok(lastRender.legend[0].includes('总用量'), 'token legend head');
  const tokTicks = yAxisFits(tok, 10);
  assert.ok(tokTicks.some((t) => /万|\d/.test(t)));

  const req = render(fixture(), 480, 150, [], 'requests');
  assert.equal(lastRender.title, '每日 请求 趋势图');
  assert.ok(lastRender.legend[0].includes('总请求'), 'request legend head');
  // fixture：deepseek 3 次（60k+120k+65k 各 1 次）、glm 6 次（11 点与 12 点各 3 次）→ 请求维 glm 排第一，Token 维 deepseek 排第一
  assert.deepEqual(lastRender.legend.slice(1).map((h) => h.replace(/<[^>]+>/g, '')), ['glm-5.3-flash', 'deepseek-v4-pro'], 'model ranking follows request counts');
  assert.deepEqual(render(fixture(), 480).length && lastRender.legend.slice(1).map((h) => h.replace(/<[^>]+>/g, '')), ['deepseek-v4-pro', 'glm-5.3-flash'], 'token ranking unchanged');
  const reqTicks = yAxisFits(req, 10);
  assert.ok(reqTicks.every((t) => /^\d[\d,]*$/.test(t)), 'request axis ticks are integers: ' + JSON.stringify(reqTicks));
  assert.equal(reqTicks[reqTicks.length - 1], '0');
  // 请求维最大值 = 11 点的 1+3=4 → 抬到 gridSteps(3) 的倍数 6 → 刻度 6 / 4 / 2 / 0
  assert.deepEqual(reqTicks, ['6', '4', '2', '0'], 'integer ticks on a multiple of gridSteps');
  // 主曲线 y 按 requests 取值：11 点（4 次）在顶、2 点（1 次）低；Token 维 2 点（60k）不是最低有效点
  const mainY = (svg) => [...svg.matchAll(/<circle class="cv-dot-main" cx="([^"]+)" cy="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const reqDots = mainY(req);
  assert.ok(reqDots.length >= 1, 'request main dots');
  const tipReq = [...req.matchAll(/data-k-tip="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(tipReq.some((t) => t.includes('总请求') && t.includes('4 次') && t.includes('tokens')), 'request tooltip: 总请求 4 次 with token side value');
  assert.ok(!tipReq.some((t) => t.includes('总用量')), 'request tooltip has no 总用量 row');
  const tipTok = [...tok.matchAll(/data-k-tip="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(tipTok.some((t) => t.includes('总用量') && t.includes('次请求')), 'token tooltip keeps 总用量 + 次请求');
  // 请求维缺 modelRequests 的旧数据点不崩：无模型分线，只有主线
  checkLayers(render(fixture().map((p) => ({ ...p, modelRequests: undefined })), 480, 150, [], 'requests'), 0);
  // 全零请求：轴上限仍为 gridSteps 的倍数且 > 0
  const zero = render(fixture().map((p) => ({ ...p, requests: 0, modelRequests: {} })), 480, 150, [], 'requests');
  assert.deepEqual(yAxisFits(zero, 10), ['3', '2', '1', '0']);
  console.log('PASS: trend card Token / 请求 dimension toggle: titles, legend head, request-ranked models, integer ticks, tooltips, legacy points');
}

if (process.argv.includes('--serve')) {
  const http = require('node:http');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>趋势图分层回归预览</title><style>
${css}
:root { --vscode-editor-background:#211e26; --vscode-sideBar-background:#27232d; --vscode-foreground:#edeaf1; --vscode-descriptionForeground:#b7b2bf; --vscode-widget-border:#443b50; --vscode-input-background:#24202b; --vscode-font-family:'Segoe UI',sans-serif; }
body { margin:0; } .fixture-tools { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; } .fixture-tools button { padding:6px 12px; background:#403151; color:#fff; border:1px solid #7c679a; border-radius:5px; cursor:pointer; }
.fixture-note { color:#b7b2bf; font-size:12px; margin:12px 0; } #fixtureCard { max-width:900px; } #fixtureCard.narrow { width:240px; } #fixtureCard .ucurve-box { height:220px; }
</style></head><body><h2>趋势图分层回归预览</h2><div class="fixture-tools"><button id="single">单模型完全重合</button><button id="multi">多模型局部重合</button><button id="empty">空数据</button><button id="narrow">切换窄宽卡片</button></div><p class="fixture-note">仅使用模拟数据，加载当前源码的绘制函数及样式；重合处应显示模型颜色，圆点仅在悬停时出现。</p>
<div class="card ucard-trend" id="fixtureCard"><div class="cardhead"><h3>每日 Token 趋势图</h3></div><div class="ucurve-legend" id="uCurveLegend"></div><div class="ucurve-box" id="uCurveSvg"></div></div><div id="kTip"></div><script>
${helpers}
${renderer}
${tooltip}
let data = ${JSON.stringify(fixture())};
const datasets = { single:${JSON.stringify(fixture(true))}, multi:${JSON.stringify(fixture())}, empty:[] };
const redraw = () => renderTrendCurve([], [], data, 'today');
for (const id of ['single','multi','empty']) document.getElementById(id).onclick = () => { data = datasets[id]; redraw(); };
document.getElementById('narrow').onclick = () => document.getElementById('fixtureCard').classList.toggle('narrow');
new ResizeObserver(redraw).observe(document.getElementById('uCurveSvg'));
redraw();
</script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  server.listen(0, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:' + server.address().port + '/'));
}
