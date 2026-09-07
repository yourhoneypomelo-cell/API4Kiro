import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/sankey-inspect.html';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 样式调整：.usankey-box min-width 调整为 1080px（容纳 6 层从容排版）
text = text.replace('.usankey-box { min-width: 880px;', '.usankey-box { min-width: 1080px;');

// 2. 增加 Cursor 风格的上下文微观透视卡片样式
const cursorCardStyle = `
  /* Cursor 风格上下文微观透视卡片样式 */
  .ctx-card {
    background: linear-gradient(135deg, rgba(30, 20, 50, 0.7) 0%, rgba(15, 10, 28, 0.85) 100%);
    border: 1px solid rgba(168, 85, 247, 0.28);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 16px rgba(168, 85, 247, 0.08);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 20px;
  }
  .ctx-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
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
  /* 多段彩色堆叠条 */
  .ctx-bar {
    height: 12px;
    border-radius: 6px;
    display: flex;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
    margin-bottom: 14px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.4);
  }
  .ctx-seg {
    height: 100%;
    transition: width 0.3s ease, filter 0.2s;
    cursor: pointer;
  }
  .ctx-seg:hover {
    filter: brightness(1.25);
  }
  .ctx-seg.files { background: #38bdf8; }
  .ctx-seg.history { background: #818cf8; }
  .ctx-seg.tools { background: #c084fc; }
  .ctx-seg.rules { background: #f43f5e; }
  .ctx-seg.current { background: #34d399; }

  .ctx-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 18px;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #cbd5e1;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .ctx-item:hover {
    background: rgba(255,255,255,0.06);
  }
  .ctx-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .ctx-dot.files { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.6); }
  .ctx-dot.history { background: #818cf8; box-shadow: 0 0 6px rgba(129, 140, 248, 0.6); }
  .ctx-dot.tools { background: #c084fc; box-shadow: 0 0 6px rgba(192, 132, 252, 0.6); }
  .ctx-dot.rules { background: #f43f5e; box-shadow: 0 0 6px rgba(244, 63, 94, 0.6); }
  .ctx-dot.current { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
  .ctx-val {
    font-weight: 600;
    color: #f8fafc;
    margin-left: 2px;
  }
  .ctx-pct {
    color: #94a3b8;
    font-size: 10px;
  }
`;

text = text.replace('/* 容器与响应式 */', cursorCardStyle + '\n  /* 容器与响应式 */');

// 3. 在 HTML 界面中插入 Cursor 风格卡片容器
const cardHtml = `
      <!-- 方法 B：Cursor 风格上下文微观透视卡片 -->
      <div class="ctx-card" id="ctxBreakdownCard">
        <div class="ctx-header">
          <div class="ctx-title">
            <span>✨ 上下文微观构成透视 (Context Composition · Cursor Style)</span>
          </div>
          <div class="ctx-subtitle" id="ctxTotalTok">输入总量: 1,420,500 Tokens</div>
        </div>
        <div class="ctx-bar" id="ctxBar">
          <div class="ctx-seg files" style="width: 42%;" data-k-tip="关联代码文件&#10;596,610 tokens (42.0%)"></div>
          <div class="ctx-seg history" style="width: 28%;" data-k-tip="历史会话记录&#10;397,740 tokens (28.0%)"></div>
          <div class="ctx-seg tools" style="width: 15%;" data-k-tip="工具规格定义&#10;213,075 tokens (15.0%)"></div>
          <div class="ctx-seg rules" style="width: 9%;" data-k-tip="系统规则设定&#10;127,845 tokens (9.0%)"></div>
          <div class="ctx-seg current" style="width: 6%;" data-k-tip="当前用户指令&#10;85,230 tokens (6.0%)"></div>
        </div>
        <div class="ctx-legend">
          <div class="ctx-item" data-k-tip="当前打开与关联读取的代码文档">
            <span class="ctx-dot files"></span>
            <span>关联代码文件</span>
            <span class="ctx-val">59.7 万</span>
            <span class="ctx-pct">(42.0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="多轮历史提问、回复与思考链路">
            <span class="ctx-dot history"></span>
            <span>历史会话记录</span>
            <span class="ctx-val">39.8 万</span>
            <span class="ctx-pct">(28.0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="Kiro 声明的工具规格与 JSON Schema">
            <span class="ctx-dot tools"></span>
            <span>工具规格定义</span>
            <span class="ctx-val">21.3 万</span>
            <span class="ctx-pct">(15.0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="系统 Prompt、MCP 规约与工作区规则">
            <span class="ctx-dot rules"></span>
            <span>系统规则设定</span>
            <span class="ctx-val">12.8 万</span>
            <span class="ctx-pct">(9.0%)</span>
          </div>
          <div class="ctx-item" data-k-tip="当前轮次用户提问与工具执行输出">
            <span class="ctx-dot current"></span>
            <span>当前用户指令</span>
            <span class="ctx-val">8.5 万</span>
            <span class="ctx-pct">(6.0%)</span>
          </div>
        </div>
      </div>
`;

text = text.replace('<div class="usankey-box" id="uSankeySvg"></div>', cardHtml + '\n      <div class="usankey-box" id="uSankeySvg"></div>');

// 4. 更新 layoutSankey 支持 6 层拓扑以及 1080px 宽度与新色板
const oldLayoutStart = 'function layoutSankey(data, dimension, width) {';
const oldLayoutEnd = 'function renderSankey(data) {';

const sIdx = text.indexOf(oldLayoutStart);
const eIdx = text.indexOf(oldLayoutEnd);

const newLayout = `function layoutSankey(data, dimension, width) {
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
    // Layer 5: 微观成分色板
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

  // 状态层与 Token 层与上下文层排序
  layers.forEach((layer) => {
    layer.sort((a, b) => {
      // 状态层
      if (a.id === 's:success') return -1;
      if (b.id === 's:success') return 1;
      if (a.id === 's:failed') return 1;
      if (b.id === 's:failed') return -1;
      // Token 分类层
      const orderTok = { 't:cache_read': 1, 't:cache_write': 2, 't:input': 3, 't:output': 4 };
      if (orderTok[a.id] && orderTok[b.id]) return orderTok[a.id] - orderTok[b.id];
      // 上下文成分层
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

  // 自适应贴合所有汇聚门与终点门
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

// 5. 更新 fixtures，增加 Layer 5 节点与连线
const oldStd = `      { id: "s:success", name: "调用成功 200 OK", layer: 3 },
      { id: "s:failed", name: "异常重试 / 失败", layer: 3 }
    ,
      {"id":"t:cache_read","name":"缓存命中读取 (Cache Read)","layer":4,"color":"#10b981"},
      {"id":"t:cache_write","name":"缓存创建写入 (Cache Write)","layer":4,"color":"#a855f7"},
      {"id":"t:input","name":"常规输入 (Prompt Input)","layer":4,"color":"#38bdf8"},
      {"id":"t:output","name":"模型生成 (Completion Output)","layer":4,"color":"#f59e0b"}
    ],
    links: [
      { source: "p:antigravity", target: "c:anti-acc1", tokens: 820000, requests: 62 },
      { source: "p:antigravity", target: "c:anti-acc2", tokens: 280000, requests: 18 },
      { source: "p:anthropic", target: "c:anthro-key", tokens: 450000, requests: 35 },
      { source: "p:kimi", target: "c:kimi-pool", tokens: 210000, requests: 22 },
      { source: "p:deepseek", target: "c:ds-main", tokens: 190000, requests: 28 },

      { source: "c:anti-acc1", target: "m:gemini-3.8-flash", tokens: 590000, requests: 46 },
      { source: "c:anti-acc1", target: "m:gpt-5.6-terra", tokens: 230000, requests: 16 },
      { source: "c:anti-acc2", target: "m:gemini-3.8-flash", tokens: 280000, requests: 18 },
      { source: "c:anthro-key", target: "m:claude-3-7-sonnet", tokens: 450000, requests: 35 },
      { source: "c:kimi-pool", target: "m:kimi-k1.5", tokens: 210000, requests: 22 },
      { source: "c:ds-main", target: "m:deepseek-v4-pro", tokens: 190000, requests: 28 },

      { source: "m:gemini-3.8-flash", target: "s:success", tokens: 850000, requests: 62 },
      { source: "m:gemini-3.8-flash", target: "s:failed", tokens: 20000, requests: 2 },
      { source: "m:claude-3-7-sonnet", target: "s:success", tokens: 440000, requests: 34 },
      { source: "m:claude-3-7-sonnet", target: "s:failed", tokens: 10000, requests: 1 },
      { source: "m:gpt-5.6-terra", target: "s:success", tokens: 225000, requests: 15 },
      { source: "m:gpt-5.6-terra", target: "s:failed", tokens: 5000, requests: 1 },
      { source: "m:kimi-k1.5", target: "s:success", tokens: 205000, requests: 21 },
      { source: "m:kimi-k1.5", target: "s:failed", tokens: 5000, requests: 1 },
      { source: "m:deepseek-v4-pro", target: "s:success", tokens: 185000, requests: 27 },
      { source: "m:deepseek-v4-pro", target: "s:failed", tokens: 5000, requests: 1 }
    ,
      {"source":"s:success","target":"t:cache_read","tokens":762000,"requests":57},
      {"source":"s:success","target":"t:cache_write","tokens":285750,"requests":28},
      {"source":"s:success","target":"t:input","tokens":571500,"requests":57},
      {"source":"s:success","target":"t:output","tokens":285750,"requests":114},
      {"source":"s:failed","target":"t:input","tokens":31500,"requests":5},
      {"source":"s:failed","target":"t:output","tokens":13500,"requests":5}
    ]`;

const newStd = `      { id: "s:success", name: "调用成功 200 OK", layer: 3 },
      { id: "s:failed", name: "异常重试 / 失败", layer: 3 },
      {"id":"t:cache_read","name":"缓存命中读取 (Cache Read)","layer":4,"color":"#10b981"},
      {"id":"t:cache_write","name":"缓存创建写入 (Cache Write)","layer":4,"color":"#a855f7"},
      {"id":"t:input","name":"常规输入 (Prompt Input)","layer":4,"color":"#38bdf8"},
      {"id":"t:output","name":"模型生成 (Completion Output)","layer":4,"color":"#f59e0b"},
      // Layer 5: 上下文微观成分
      {"id":"ctx:files","name":"关联代码文件 (Files)","layer":5,"color":"#38bdf8"},
      {"id":"ctx:history","name":"历史会话记录 (History)","layer":5,"color":"#818cf8"},
      {"id":"ctx:tools","name":"工具规格定义 (Tools)","layer":5,"color":"#c084fc"},
      {"id":"ctx:rules","name":"系统规则设定 (Rules)","layer":5,"color":"#f43f5e"},
      {"id":"ctx:current","name":"当前用户指令 (Prompt)","layer":5,"color":"#34d399"},
      {"id":"out:completion","name":"回答与思考生成","layer":5,"color":"#f59e0b"}
    ],
    links: [
      { source: "p:antigravity", target: "c:anti-acc1", tokens: 820000, requests: 62 },
      { source: "p:antigravity", target: "c:anti-acc2", tokens: 280000, requests: 18 },
      { source: "p:anthropic", target: "c:anthro-key", tokens: 450000, requests: 35 },
      { source: "p:kimi", target: "c:kimi-pool", tokens: 210000, requests: 22 },
      { source: "p:deepseek", target: "c:ds-main", tokens: 190000, requests: 28 },

      { source: "c:anti-acc1", target: "m:gemini-3.8-flash", tokens: 590000, requests: 46 },
      { source: "c:anti-acc1", target: "m:gpt-5.6-terra", tokens: 230000, requests: 16 },
      { source: "c:anti-acc2", target: "m:gemini-3.8-flash", tokens: 280000, requests: 18 },
      { source: "c:anthro-key", target: "m:claude-3-7-sonnet", tokens: 450000, requests: 35 },
      { source: "c:kimi-pool", target: "m:kimi-k1.5", tokens: 210000, requests: 22 },
      { source: "c:ds-main", target: "m:deepseek-v4-pro", tokens: 190000, requests: 28 },

      { source: "m:gemini-3.8-flash", target: "s:success", tokens: 850000, requests: 62 },
      { source: "m:gemini-3.8-flash", target: "s:failed", tokens: 20000, requests: 2 },
      { source: "m:claude-3-7-sonnet", target: "s:success", tokens: 440000, requests: 34 },
      { source: "m:claude-3-7-sonnet", target: "s:failed", tokens: 10000, requests: 1 },
      { source: "m:gpt-5.6-terra", target: "s:success", tokens: 225000, requests: 15 },
      { source: "m:gpt-5.6-terra", target: "s:failed", tokens: 5000, requests: 1 },
      { source: "m:kimi-k1.5", target: "s:success", tokens: 205000, requests: 21 },
      { source: "m:kimi-k1.5", target: "s:failed", tokens: 5000, requests: 1 },
      { source: "m:deepseek-v4-pro", target: "s:success", tokens: 185000, requests: 27 },
      { source: "m:deepseek-v4-pro", target: "s:failed", tokens: 5000, requests: 1 }
    ,
      {"source":"s:success","target":"t:cache_read","tokens":762000,"requests":57},
      {"source":"s:success","target":"t:cache_write","tokens":285750,"requests":28},
      {"source":"s:success","target":"t:input","tokens":571500,"requests":57},
      {"source":"s:success","target":"t:output","tokens":285750,"requests":114},
      {"source":"s:failed","target":"t:input","tokens":31500,"requests":5},
      {"source":"s:failed","target":"t:output","tokens":13500,"requests":5},
      // Layer 5 连线 (守恒分配 t:input 与 t:output)
      {"source":"t:input","target":"ctx:files","tokens":253260,"requests":26},
      {"source":"t:input","target":"ctx:history","tokens":168840,"requests":17},
      {"source":"t:input","target":"ctx:tools","tokens":90450,"requests":9},
      {"source":"t:input","target":"ctx:rules","tokens":54270,"requests":6},
      {"source":"t:input","target":"ctx:current","tokens":36180,"requests":4},
      {"source":"t:output","target":"out:completion","tokens":299250,"requests":119}
    ]`;

text = text.replace(oldStd, newStd);

fs.writeFileSync(filePath, text, 'utf-8');
console.log('sankey-inspect.html updated with 6-layer topology & Cursor context breakdown card!');
