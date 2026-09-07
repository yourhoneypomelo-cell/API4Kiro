import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/src/sidebar.ts';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 顶部导入 getContextBreakdownStats
const oldImport = `  getModelUsageRatios,
  getSankeyData,`;
const newImport = `  getModelUsageRatios,
  getSankeyData,
  getContextBreakdownStats,`;
text = text.replace(oldImport, newImport);

// 2. 在 postUsage() 中获取 contextBreakdown 并注入推送
const oldPostUsage = `    const sankey = getSankeyData(range);
    const recent = recentRecords(30, range).map((r) => ({
      ts: r.ts,
      providerName: r.providerName,
      model: r.model,
      upstreamModel: r.upstreamModel || "",
      tokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      latencyMs: r.latencyMs,
      firstTokenMs: r.firstTokenMs ?? null,
      ok: r.ok,
      status: r.status,
      error: r.error || "",
    }));
    this.post({
      type: "usage",
      range: this.usageRange,
      from: range.from,
      to: range.to,
      summary,
      providers,
      trend,
      seriesTrend,
      recent,
      stats,
      heatmap,
      modelRatios,
      sankey,
    });`;

const newPostUsage = `    const sankey = getSankeyData(range);
    const contextBreakdown = getContextBreakdownStats(range);
    const recent = recentRecords(30, range).map((r) => ({
      ts: r.ts,
      providerName: r.providerName,
      model: r.model,
      upstreamModel: r.upstreamModel || "",
      tokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      latencyMs: r.latencyMs,
      firstTokenMs: r.firstTokenMs ?? null,
      ok: r.ok,
      status: r.status,
      error: r.error || "",
      contextBreakdown: r.contextBreakdown,
    }));
    this.post({
      type: "usage",
      range: this.usageRange,
      from: range.from,
      to: range.to,
      summary,
      providers,
      trend,
      seriesTrend,
      recent,
      stats,
      heatmap,
      modelRatios,
      sankey,
      contextBreakdown,
    });`;
text = text.replace(oldPostUsage, newPostUsage);

// 3. 样式更新：.usankey-box min-width 调整为 1080px，增加 Cursor 风格卡片样式
const oldCssBox = `.usankey-box { min-width:880px; width:100%; position:relative; }`;
const newCssBox = `.usankey-box { min-width:1080px; width:100%; position:relative; }
  /* Cursor 风格上下文微观透视卡片样式 */
  .ctx-card {
    background: linear-gradient(135deg, rgba(30, 20, 50, 0.7) 0%, rgba(15, 10, 28, 0.85) 100%);
    border: 1px solid rgba(168, 85, 247, 0.28);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 16px rgba(168, 85, 247, 0.08);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 16px;
  }
  .ctx-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .ctx-title {
    font-size: 13px;
    font-weight: 600;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctx-subtitle {
    font-size: 11px;
    color: #94a3b8;
  }
  .ctx-bar {
    height: 12px;
    border-radius: 6px;
    display: flex;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
    margin-bottom: 12px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.4);
  }
  .ctx-seg {
    height: 100%;
    transition: width 0.3s ease, filter 0.2s;
    cursor: pointer;
  }
  .ctx-seg:hover { filter: brightness(1.25); }
  .ctx-seg.files { background: #38bdf8; }
  .ctx-seg.history { background: #818cf8; }
  .ctx-seg.tools { background: #c084fc; }
  .ctx-seg.rules { background: #f43f5e; }
  .ctx-seg.current { background: #34d399; }
  .ctx-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: #cbd5e1;
    cursor: pointer;
    padding: 2px 5px;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .ctx-item:hover { background: rgba(255,255,255,0.06); }
  .ctx-dot { width: 8px; height: 8px; border-radius: 50%; }
  .ctx-dot.files { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.6); }
  .ctx-dot.history { background: #818cf8; box-shadow: 0 0 6px rgba(129, 140, 248, 0.6); }
  .ctx-dot.tools { background: #c084fc; box-shadow: 0 0 6px rgba(192, 132, 252, 0.6); }
  .ctx-dot.rules { background: #f43f5e; box-shadow: 0 0 6px rgba(244, 63, 94, 0.6); }
  .ctx-dot.current { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
  .ctx-val { font-weight: 600; color: #f8fafc; margin-left: 2px; }
  .ctx-pct { color: #94a3b8; font-size: 10px; }
  .rrow-detail {
    font-size: 10px;
    color: #94a3b8;
    margin-top: 3px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }`;
text = text.replace(oldCssBox, newCssBox);

// 4. 在 HTML 模板中插入方法 B：上下文微观透视卡片 (ctxBreakdownCard)
const oldHtmlSankey = `      <div class="cardhead" style="margin-bottom:8px;">
        <span class="cardtitle">分流桑基图</span>
        <span class="cardsub">渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态</span>
        <div class="useg-sk">
          <button data-sk="tokens" class="sel">Token</button>
          <button data-sk="requests">次数</button>
        </div>
      </div>
      <div class="usankey-scroll">
        <div class="usankey-box" id="uSankeySvg"></div>
      </div>`;

const newHtmlSankey = `      <div class="cardhead" style="margin-bottom:8px;">
        <span class="cardtitle">分流桑基图</span>
        <span class="cardsub">渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态 &rarr; Token &rarr; 上下文细分</span>
        <div class="useg-sk">
          <button data-sk="tokens" class="sel">Token</button>
          <button data-sk="requests">次数</button>
        </div>
      </div>
      <!-- 方法 B：Cursor 风格上下文微观透视卡片 -->
      <div class="ctx-card" id="ctxBreakdownCard">
        <div class="ctx-header">
          <div class="ctx-title">
            <span>✨ 上下文微观构成透视 (Context Composition · Cursor Style)</span>
          </div>
          <div class="ctx-subtitle" id="ctxTotalTok">输入总量: -- Tokens</div>
        </div>
        <div class="ctx-bar" id="ctxBar">
          <div class="ctx-seg files" id="ctxSegFiles" style="width: 0%;" data-k-tip="关联代码文件&#10;--"></div>
          <div class="ctx-seg history" id="ctxSegHistory" style="width: 0%;" data-k-tip="历史会话记录&#10;--"></div>
          <div class="ctx-seg tools" id="ctxSegTools" style="width: 0%;" data-k-tip="工具规格定义&#10;--"></div>
          <div class="ctx-seg rules" id="ctxSegRules" style="width: 0%;" data-k-tip="系统规则设定&#10;--"></div>
          <div class="ctx-seg current" id="ctxSegCurrent" style="width: 0%;" data-k-tip="当前用户指令&#10;--"></div>
        </div>
        <div class="ctx-legend">
          <div class="ctx-item" data-k-tip="当前打开与关联读取的代码文档">
            <span class="ctx-dot files"></span>
            <span>关联代码文件</span>
            <span class="ctx-val" id="ctxValFiles">0</span>
            <span class="ctx-pct" id="ctxPctFiles">(0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="多轮历史提问、回复与思考链路">
            <span class="ctx-dot history"></span>
            <span>历史会话记录</span>
            <span class="ctx-val" id="ctxValHistory">0</span>
            <span class="ctx-pct" id="ctxPctHistory">(0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="Kiro 声明的工具规格与 JSON Schema">
            <span class="ctx-dot tools"></span>
            <span>工具规格定义</span>
            <span class="ctx-val" id="ctxValTools">0</span>
            <span class="ctx-pct" id="ctxPctTools">(0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="系统 Prompt、MCP 规约与工作区规则">
            <span class="ctx-dot rules"></span>
            <span>系统规则设定</span>
            <span class="ctx-val" id="ctxValRules">0</span>
            <span class="ctx-pct" id="ctxPctRules">(0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="当前轮次用户提问与工具执行输出">
            <span class="ctx-dot current"></span>
            <span>当前用户指令</span>
            <span class="ctx-val" id="ctxValCurrent">0</span>
            <span class="ctx-pct" id="ctxPctCurrent">(0%)</span>
          </div>
        </div>
      </div>
      <div class="usankey-scroll">
        <div class="usankey-box" id="uSankeySvg"></div>
      </div>`;
text = text.replace(oldHtmlSankey, newHtmlSankey);

// 5. 更新 layoutSankey 支持 6 层拓扑以及 1080px 宽度和 Layer 5 配色
const oldLayoutStart = '  function layoutSankey(data, dimension, width) {';
const oldLayoutEnd = '  function renderSankey(data) {';

const sIdx = text.indexOf(oldLayoutStart);
const eIdx = text.indexOf(oldLayoutEnd);

const newLayout = `  function layoutSankey(data, dimension, width) {
    const W = Math.max(1080, Number.isFinite(width) ? width : 1080);
    const empty = { width: W, height: 120, nodes: [], links: [], scale: 0 };
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) return empty;
    const byId = new Map();
    const stableColor = (id) => {
      if (id === 's:success') return '#34d399';
      if (id === 's:failed') return '#fb7185';
      if (id === 't:cache_read') return '#10b981';
      if (id === 't:cache_write') return '#a855f7';
      if (id === 't:input') return '#38bdf8';
      if (id === 't:output') return '#f59e0b';
      // Layer 5 微观去向色板
      if (id === 'ctx:files') return '#38bdf8';
      if (id === 'ctx:history') return '#818cf8';
      if (id === 'ctx:tools') return '#c084fc';
      if (id === 'ctx:rules') return '#f43f5e';
      if (id === 'ctx:current') return '#34d399';
      if (id === 'out:completion') return '#f59e0b';
      let hash = 0;
      for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      return PALETTE[hash % PALETTE.length];
    };
    ((data || {}).nodes || []).forEach((node) => {
      if (!node || typeof node.id !== 'string' || byId.has(node.id)) return;
      const layer = Number(node.layer);
      if (!Number.isInteger(layer) || layer < 0) return;
      byId.set(node.id, {
        id: node.id, name: String(node.name || node.id), layer,
        value: 0, inValue: 0, outValue: 0, incoming: [], outgoing: [],
        color: node.color || stableColor(node.id),
      });
    });
    const links = [];
    ((data || {}).links || []).forEach((link) => {
      if (!link) return;
      const src = byId.get(link.source), tgt = byId.get(link.target);
      const value = Number(dimension === 'requests' ? link.requests : link.tokens);
      if (!src || !tgt || src.layer >= tgt.layer || !Number.isFinite(value) || value <= 0) return;
      const edge = { source: src.id, target: tgt.id, value, width: 0, sy: 0, ty: 0 };
      links.push(edge);
      src.outgoing.push(edge); tgt.incoming.push(edge);
      src.outValue += value; tgt.inValue += value;
    });
    if (!links.length) return empty;

    const nodes = [...byId.values()].filter((node) => node.incoming.length || node.outgoing.length);
    const layerMap = new Map();
    nodes.forEach((node) => {
      node.value = Math.max(node.inValue, node.outValue);
      if (!layerMap.has(node.layer)) layerMap.set(node.layer, []);
      layerMap.get(node.layer).push(node);
      if (node.id.startsWith('c:') && node.incoming.length) {
        const primary = node.incoming.reduce((a, b) => a.value >= b.value ? a : b);
        node.color = byId.get(primary.source).color;
      }
    });
    const layers = [...layerMap.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    if (!layers.length) return empty;

    // 1. 无交叉层级拓扑对齐排序
    layers[0].sort((a, b) => (b.value - a.value) || a.id.localeCompare(b.id));

    for (let l = 1; l < layers.length - 1; l++) {
      const prevLayer = layers[l - 1];
      layers[l].sort((a, b) => {
        const primaryA = a.incoming.reduce((m, e) => e.value > m.value ? e : m, a.incoming[0]);
        const primaryB = b.incoming.reduce((m, e) => e.value > m.value ? e : m, b.incoming[0]);
        const parentA = primaryA ? byId.get(primaryA.source) : null;
        const parentB = primaryB ? byId.get(primaryB.source) : null;
        const idxA = parentA ? prevLayer.indexOf(parentA) : 999;
        const idxB = parentB ? prevLayer.indexOf(parentB) : 999;
        if (idxA !== idxB) return idxA - idxB;
        return (b.value - a.value) || a.id.localeCompare(b.id);
      });
    }

    // 状态层、Token层、微观构成层排序
    layers.forEach((layer) => {
      layer.sort((a, b) => {
        if (a.id === 's:success') return -1;
        if (b.id === 's:success') return 1;
        if (a.id === 's:failed') return 1;
        if (b.id === 's:failed') return -1;
        const orderTok = { 't:cache_read': 1, 't:cache_write': 2, 't:input': 3, 't:output': 4 };
        if (orderTok[a.id] && orderTok[b.id]) return orderTok[a.id] - orderTok[b.id];
        const orderCtx = { 'ctx:files': 1, 'ctx:history': 2, 'ctx:tools': 3, 'ctx:rules': 4, 'ctx:current': 5, 'out:completion': 6 };
        if (orderCtx[a.id] && orderCtx[b.id]) return orderCtx[a.id] - orderCtx[b.id];
        return (b.value - a.value) || a.id.localeCompare(b.id);
      });
    });

    // 2. 全局统一物理比例尺
    const padY = 28, padL = 18, padR = 150, nodeW = 12, gap = 10;
    const maxLayerSum = Math.max(...layers.map((layer) => layer.reduce((sum, n) => sum + n.value, 0)));
    const scale = 230 / Math.max(1, maxLayerSum);

    let maxReqH = 0;
    layers.forEach((layer) => {
      const sumH = layer.reduce((s, n) => s + Math.max(2, n.value * scale), 0) + (layer.length - 1) * gap;
      if (sumH > maxReqH) maxReqH = sumH;
    });
    const H = Math.max(380, padY * 2 + maxReqH + 20);
    const stepX = (W - padL - padR - nodeW) / Math.max(1, layers.length - 1);

    // 3. 统一主干水平对齐
    layers.forEach((layer, lIdx) => {
      let y = padY;
      layer.forEach((node) => {
        node.x = padL + lIdx * stepX;
        node.y = y;
        node.w = nodeW;
        node.h = node.value * scale;
        y += node.h + gap;
      });
    });

    // 4. 严格等宽连线几何计算
    links.forEach((link) => {
      link.width = link.value * scale;
      link.color = byId.get(link.source).color;
    });

    nodes.forEach((node) => {
      node.outgoing.sort((a, b) => byId.get(a.target).y - byId.get(b.target).y || a.target.localeCompare(b.target));
      node.incoming.sort((a, b) => byId.get(a.source).y - byId.get(b.source).y || a.source.localeCompare(b.source));

      let sy = node.y;
      node.outgoing.forEach((link) => {
        link.sy = sy;
        sy += link.width;
      });

      let ty = node.y;
      node.incoming.forEach((link) => {
        link.ty = ty;
        ty += link.width;
      });
    });

    // 终点门与各层汇聚门自适应 100% 严丝合缝
    layers.forEach((layer, lIdx) => {
      if (lIdx >= 3) {
        layer.forEach((node) => {
          if (node.incoming.length > 0) {
            const minTy = Math.min(...node.incoming.map(l => l.ty));
            const maxBottom = Math.max(...node.incoming.map(l => l.ty + l.width));
            node.y = minTy;
            node.h = maxBottom - minTy;
          }
        });
      }
    });

    return {
      width: W, height: H, scale,
      nodes: nodes.map(({ incoming, outgoing, ...node }) => node),
      links,
    };
  }

`;
text = text.slice(0, sIdx) + newLayout + text.slice(eIdx);

// 6. 在 renderUsage 中添加 renderContextBreakdownCard(m.contextBreakdown) 与最近请求下钻
const oldRenderUsageEnd = `    // 5. 桑基分流数图
    renderSankey(m.sankey || { nodes: [], links: [] });`;

const newRenderUsageEnd = `    // 5. 桑基分流数图
    renderSankey(m.sankey || { nodes: [], links: [] });

    // 5.1 Cursor 风格上下文微观透视卡片
    renderContextBreakdownCard(m.contextBreakdown);`;
text = text.replace(oldRenderUsageEnd, newRenderUsageEnd);

// 添加 renderContextBreakdownCard 实现函数
const cardRenderFunc = `
  function renderContextBreakdownCard(cb) {
    if (!cb) return;
    const total = cb.totalInputTokens || 0;
    $('ctxTotalTok').textContent = '输入总量: ' + fmt(total) + ' Tokens';

    const setSeg = (id, valId, pctId, tokens, pct, name) => {
      const el = $(id);
      const valEl = $(valId);
      const pctEl = $(pctId);
      if (el) {
        el.style.width = pct.toFixed(1) + '%';
        el.dataset.kTip = name + '&#10;' + fmt(tokens) + ' tokens (' + pct.toFixed(1) + '%)';
      }
      if (valEl) valEl.textContent = tokShort(tokens);
      if (pctEl) pctEl.textContent = '(' + pct.toFixed(1) + '%)';
    };

    setSeg('ctxSegFiles', 'ctxValFiles', 'ctxPctFiles', cb.filesTokens || 0, cb.filesPct || 0, '关联代码文件');
    setSeg('ctxSegHistory', 'ctxValHistory', 'ctxPctHistory', cb.historyTokens || 0, cb.historyPct || 0, '历史会话记录');
    setSeg('ctxSegTools', 'ctxValTools', 'ctxPctTools', cb.toolsTokens || 0, cb.toolsPct || 0, '工具规格定义');
    setSeg('ctxSegRules', 'ctxValRules', 'ctxPctRules', cb.rulesTokens || 0, cb.rulesPct || 0, '系统规则设定');
    setSeg('ctxSegCurrent', 'ctxValCurrent', 'ctxPctCurrent', cb.currentInputTokens || 0, cb.currentPct || 0, '当前用户指令');
  }
`;

text = text.replace('function renderUsage(m) {', cardRenderFunc + '\n  function renderUsage(m) {');

// 7. 在最近请求列表中渲染微观 breakdown 下钻
const oldRecentRow = `      row.querySelector('.t').textContent = tokShort(r.tokens);
      row.querySelector('.t').title = 'in ' + fmt(r.inputTokens) + ' · out ' + fmt(r.outputTokens) + (r.cacheReadTokens ? ' · cache读 ' + fmt(r.cacheReadTokens) : '');
      row.querySelector('.l').textContent = ms(r.latencyMs) + (r.firstTokenMs != null ? ' · 首' + ms(r.firstTokenMs) : '');
      rw.appendChild(row);`;

const newRecentRow = `      row.querySelector('.t').textContent = tokShort(r.tokens);
      let tTip = 'in ' + fmt(r.inputTokens) + ' · out ' + fmt(r.outputTokens) + (r.cacheReadTokens ? ' · cache读 ' + fmt(r.cacheReadTokens) : '');
      if (r.contextBreakdown) {
        const cb = r.contextBreakdown;
        tTip += '&#10;📂 文件: ' + fmt(cb.filesTokens) + ' · 💬 历史: ' + fmt(cb.historyTokens) + ' · 🛠️ 工具: ' + fmt(cb.toolsTokens);
      }
      row.querySelector('.t').title = tTip;
      row.querySelector('.t').dataset.kTip = tTip;
      row.querySelector('.l').textContent = ms(r.latencyMs) + (r.firstTokenMs != null ? ' · 首' + ms(r.firstTokenMs) : '');
      if (r.contextBreakdown) {
        const cb = r.contextBreakdown;
        const subRow = document.createElement('div');
        subRow.className = 'rrow-detail';
        subRow.innerHTML = '<span>📂 ' + tokShort(cb.filesTokens) + '</span><span>💬 ' + tokShort(cb.historyTokens) + '</span><span>🛠️ ' + tokShort(cb.toolsTokens) + '</span>';
        row.querySelector('.rmain').appendChild(subRow);
      }
      rw.appendChild(row);`;
text = text.replace(oldRecentRow, newRecentRow);

fs.writeFileSync(filePath, text, 'utf-8');
console.log('sidebar.ts updated successfully with 6-layer Sankey, Cursor context breakdown card & drilldown details!');
