import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/sankey-inspect.html';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 替换 layoutSankey 支持 requests 维度在状态层 100% 收敛
const oldLayoutStart = 'function layoutSankey(data, dimension, width) {';
const oldLayoutEnd = 'function renderSankey(data) {';

const sIdx = text.indexOf(oldLayoutStart);
const eIdx = text.indexOf(oldLayoutEnd);

const newLayoutSankey = `function layoutSankey(data, dimension, width) {
  const isReq = dimension === 'requests';
  const minW = isReq ? 720 : 1080;
  const W = Math.max(minW, Number.isFinite(width) ? width : minW);
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
    if (isReq && layer > 3) return; // 次数维度只展示到状态层 (Layer 0~3)
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
    if (!src || !tgt) return;
    if (isReq && (src.layer >= 3 || tgt.layer > 3)) return;
    const value = Number(isReq ? link.requests : link.tokens);
    if (src.layer >= tgt.layer || !Number.isFinite(value) || value <= 0) return;
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
    if (lIdx >= (isReq ? 2 : 3)) {
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

text = text.slice(0, sIdx) + newLayoutSankey + text.slice(eIdx);

// 2. 更新 renderSankey 动态适配 box.style.minWidth
const oldRenderSankeyTop = `function renderSankey(data) {
  const box = $('uSankeySvg');
  if (!box) return;
  if (kTipTarget && box.contains(kTipTarget)) hideKTip();
  const layout = layoutSankey(data, sankeyDim, box.clientWidth);`;

const newRenderSankeyTop = `function renderSankey(data) {
  const box = $('uSankeySvg');
  if (!box) return;
  if (kTipTarget && box.contains(kTipTarget)) hideKTip();
  box.style.minWidth = sankeyDim === 'tokens' ? '1080px' : '720px';
  const layout = layoutSankey(data, sankeyDim, box.clientWidth);`;

text = text.replace(oldRenderSankeyTop, newRenderSankeyTop);

fs.writeFileSync(filePath, text, 'utf-8');
console.log('sankey-inspect.html updated with requests dimension fix!');
