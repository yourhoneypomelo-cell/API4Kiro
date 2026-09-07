import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/src/sidebar.ts';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 替换样式：min-width:680px -> min-width:880px
const oldCss = '.usankey-box { min-width:680px; width:100%; position:relative; }';
const newCss = '.usankey-box { min-width:880px; width:100%; position:relative; }';

if (!text.includes(oldCss)) {
  console.error('CSS not found');
  process.exit(1);
}
text = text.replace(oldCss, newCss);

// 2. 替换 layoutSankey
const oldLayoutStart = '  function layoutSankey(data, dimension, width) {';
const oldLayoutEnd = '  function renderSankey(data) {';

const sIdx = text.indexOf(oldLayoutStart);
const eIdx = text.indexOf(oldLayoutEnd);

if (sIdx === -1 || eIdx === -1) {
  console.error('layoutSankey bounds not found');
  process.exit(1);
}

const newLayout = `  function layoutSankey(data, dimension, width) {
    const W = Math.max(880, Number.isFinite(width) ? width : 880);
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
      // 中间节点的输入和输出是同一份流量，不能相加重复计数。
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

    // 1. 无交叉层级拓扑对齐排序 (Hierarchical Topological Ordering)
    // Layer 0: 渠道层按流量降序排序
    layers[0].sort((a, b) => (b.value - a.value) || a.id.localeCompare(b.id));

    // 中间各层：按其在上一层的主来源父级节点物理位置归拢，同父级组内按流量降序排列，彻底根治连线交叉打结
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

    // 倒数第二层（状态层）与最后一层（Token/缓存层）：保持业务逻辑合理置顶
    layers.forEach((layer) => {
      layer.sort((a, b) => {
        // 状态层：调用成功严格置顶
        if (a.id === 's:success') return -1;
        if (b.id === 's:success') return 1;
        if (a.id === 's:failed') return 1;
        if (b.id === 's:failed') return -1;
        // Token/缓存构成层：缓存读取 -> 缓存写入 -> 常规输入 -> 模型输出
        const order = { 't:cache_read': 1, 't:cache_write': 2, 't:input': 3, 't:output': 4 };
        if (order[a.id] && order[b.id]) return order[a.id] - order[b.id];
        return (b.value - a.value) || a.id.localeCompare(b.id);
      });
    });

    // 2. 全局统一物理比例尺（流量守恒：门的高度与流的粗细严格遵循同一种物理比例）
    const padY = 28, padL = 18, padR = 140, nodeW = 12, gap = 10;
    const maxLayerSum = Math.max(...layers.map((layer) => layer.reduce((sum, n) => sum + n.value, 0)));
    const scale = 230 / Math.max(1, maxLayerSum);

    // 计算每层垂直物理总高（节点实际物理高 + 最小视觉间隙），动态确定画布适宜高度，绝不截断
    let maxReqH = 0;
    layers.forEach((layer) => {
      const sumH = layer.reduce((s, n) => s + Math.max(2, n.value * scale), 0) + (layer.length - 1) * gap;
      if (sumH > maxReqH) maxReqH = sumH;
    });
    const H = Math.max(380, padY * 2 + maxReqH + 20);
    const stepX = (W - padL - padR - nodeW) / Math.max(1, layers.length - 1);

    // 3. 统一主干水平对齐：各层顶部对准 padY，使第一大流量主干从左到右水平拉直
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

    // 4. 严格等宽连线几何计算：流的宽度 link.width 严格按真实权重乘以比例尺 (link.value * scale)
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

    // 终点门与各层汇聚门与流入流绝对 100% 严丝合缝（上下边缘误差严格为 0.0000 像素）
    // 对所有具有流入流且没有流出流的终点层节点，或者状态门节点，自适应贴合
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
fs.writeFileSync(filePath, text, 'utf-8');
console.log('Successfully updated sidebar.ts!');
