// Run: node scripts/check-sankey.js [--serve]
// Extract the real webview template; never maintain a second layout/renderer here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar.ts'), 'utf8');
const scriptTag = '<script nonce="${nonce}">';
const start = source.indexOf(scriptTag);
const end = source.indexOf('</script>', start);
assert.ok(start >= 0 && end > start, 'webview script missing');
// Match check-trend.js: evaluate the enclosing TS template's escaping first.
const raw = source.slice(start + scriptTag.length, end).replace(/\$\{[^}]*\}/g, 'null');
const script = vm.runInNewContext('`' + raw + '`');
const layoutStart = script.indexOf('  function layoutSankey(');
const renderStart = script.indexOf('  function renderSankey(');
const renderEnd = script.indexOf('  function renderUsage(', renderStart);
if (layoutStart < 0) {
  console.error('PENDING: check-sankey.js is ready; waiting for layoutSankey(data, dimension, width) in src/sidebar.ts.');
  process.exit(2);
}
assert.ok(renderStart > layoutStart && renderEnd > renderStart, 'Sankey function boundaries missing');
const layoutCode = script.slice(layoutStart, renderStart);
const renderer = script.slice(renderStart, renderEnd);
const declaration = (name) => {
  const line = script.split('\n').find((l) => l.startsWith('  const ' + name + ' ='));
  assert.ok(line, name + ' helper missing');
  return line;
};
const helpers = ['$', 'fmt', 'tokShort', 'esc', 'PALETTE'].map(declaration).join('\n');
const cssStart = source.indexOf('<style>');
const cssEnd = source.indexOf('</style>', cssStart);
assert.ok(cssStart >= 0 && cssEnd > cssStart, 'webview CSS missing');
const css = source.slice(cssStart + 7, cssEnd);
const tooltipStart = script.indexOf('  const kTipEl =');
const tooltipEnd = script.indexOf('  function confirmDeleteProvider(', tooltipStart);
assert.ok(tooltipStart >= 0 && tooltipEnd > tooltipStart, 'global tooltip code missing');
const tooltip = script.slice(tooltipStart, tooltipEnd);
const context = vm.createContext({});
vm.runInContext('"use strict";\n' + declaration('PALETTE') + '\n' + layoutCode, context);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

let layoutChecks = 0;
function layout(data, dimension = 'tokens', width = 960) {
  const input = structuredClone(data);
  const before = structuredClone(input);
  context.__data = freeze(input);
  context.__dimension = dimension;
  context.__width = width;
  const result = structuredClone(vm.runInContext('layoutSankey(__data, __dimension, __width)', context, { timeout: 5000 }));
  assert.deepEqual(input, before, 'pure layout must not modify its input');
  layoutChecks++;
  return result;
}

// Allow accumulated floating-point arithmetic, never pixel rounding or a visual tolerance.
const tolerance = (...values) => 128 * Number.EPSILON * Math.max(1, ...values.map(Math.abs));
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance(actual, expected), `${label}: ${actual} != ${expected}`);
}
function atMost(actual, maximum, label) {
  assert.ok(actual <= maximum + tolerance(actual, maximum), `${label}: ${actual} > ${maximum}`);
}
function finite(value, label) {
  assert.ok(Number.isFinite(value), `${label} must be finite, got ${String(value)}`);
}
function activeLinks(data, dimension) {
  const nodes = new Map((Array.isArray(data?.nodes) ? data.nodes : []).filter(Boolean).map((n) => [n.id, n]));
  return (Array.isArray(data?.links) ? data.links : []).filter((l) => l
    && Number.isFinite(l[dimension]) && l[dimension] > 0
    && nodes.has(l.source) && nodes.has(l.target)
    && nodes.get(l.target).layer > nodes.get(l.source).layer);
}
const edgeKey = (link) => JSON.stringify([link.source, link.target, link.value]);
const sortedEdges = (links) => links.map(edgeKey).sort();

function check(data, dimension = 'tokens', width = 960) {
  const result = layout(data, dimension, width);
  for (const key of ['width', 'height', 'scale']) finite(result[key], 'layout.' + key);
  assert.ok(result.width >= 680, 'minimum viewport width is 680');
  assert.ok(result.height >= 0 && result.scale >= 0, 'nonnegative height and scale');
  if (Number.isFinite(width) && width > 0) assert.equal(result.width, Math.max(680, width), 'honor actual box width');
  assert.ok(Array.isArray(result.nodes) && Array.isArray(result.links), 'nodes/links must be arrays');
  const expectedLinks = activeLinks(data, dimension);
  const expectedIds = new Set(expectedLinks.flatMap((l) => [l.source, l.target]));
  assert.deepEqual(sortedEdges(result.links), sortedEdges(expectedLinks.map((l) => ({ ...l, value: l[dimension] }))), 'retain every active link, and only the selected dimension');
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), [...expectedIds].sort(), 'retain all active endpoints without cutoffs');
  if (!expectedLinks.length) {
    assert.equal(result.nodes.length, 0, 'zero/invalid input must not leave phantom nodes');
    assert.equal(result.links.length, 0);
    return result;
  }
  assert.ok(result.scale > 0, 'active flow needs positive scale');
  const inputs = new Map(data.nodes.filter(Boolean).map((n) => [n.id, n]));
  const nodes = new Map(result.nodes.map((n) => [n.id, n]));
  assert.equal(nodes.size, result.nodes.length, 'node IDs must remain unique');
  const layers = new Map();
  for (const node of result.nodes) {
    assert.equal(typeof node.id, 'string');
    assert.equal(node.name, inputs.get(node.id).name, 'preserve complete names');
    assert.equal(node.layer, inputs.get(node.id).layer, 'preserve sparse layer IDs');
    assert.equal(typeof node.color, 'string');
    assert.ok(node.color.length > 0);
    for (const key of ['layer', 'x', 'y', 'w', 'h', 'value', 'inValue', 'outValue', 'slotY', 'slotH']) finite(node[key], node.id + '.' + key);
    assert.ok(node.w > 0 && node.h > 0, 'positive node width and height');
    // 门高就是真实用量：不允许任何最小高度把门抬得比它的流量带高（那正是「门和流没对上」）。
    near(node.h, node.value * result.scale, 'gate height equals scaled flow, no minimum-height floor');
    // 标签与悬停感应区占一个 ≥14px 的槽位（11px 标签 + 余量）；门居中放在槽位里，槽位不改变门的几何。
    atMost(14, node.slotH, 'label/hit slot is at least 14px');
    atMost(node.slotY, node.y, 'gate starts inside its slot');
    atMost(node.y + node.h, node.slotY + node.slotH, 'gate ends inside its slot');
    // Compare sums of coordinates (not their tiny differences) so the tolerance scales with the geometry.
    near(2 * node.y + node.h, 2 * node.slotY + node.slotH, 'gate is vertically centered in its slot');
    atMost(0, node.x, 'node left edge');
    atMost(node.x + node.w, result.width, 'node right edge');
    atMost(24, node.slotY, '24px top padding');
    atMost(node.slotY + node.slotH, result.height - 24, '24px bottom padding');
    const incoming = expectedLinks.filter((l) => l.target === node.id).reduce((sum, l) => sum + l[dimension], 0);
    const outgoing = expectedLinks.filter((l) => l.source === node.id).reduce((sum, l) => sum + l[dimension], 0);
    near(node.inValue, incoming, 'incoming value');
    near(node.outValue, outgoing, 'outgoing value');
    near(node.value, Math.max(incoming, outgoing), 'node value must be max(in,out), never in+out');
    atMost(node.value * result.scale, node.h, 'scaled node flow fits');
    if (!layers.has(node.layer)) layers.set(node.layer, []);
    layers.get(node.layer).push(node);
  }
  const columns = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  columns.forEach(([, column], index) => {
    column.sort((a, b) => a.y - b.y);
    column.forEach((node, i) => {
      near(node.x, column[0].x, 'same layer x');
      // Row pitch contract: slot ≥14 + gap 8 (was 16 + 12; user asked for tighter vertical spacing).
      if (i) atMost(column[i - 1].slotY + column[i - 1].slotH + 8, node.slotY, '8px slot gap');
      if (i) atMost(column[i - 1].y + column[i - 1].h + 8, node.y, '8px node gap');
      if (i) atMost(node.slotY, column[i - 1].slotY + column[i - 1].slotH + 8, 'slots stack with exactly the 8px gap, no extra air');
    });
    if (index) atMost(columns[index - 1][1][0].x + columns[index - 1][1][0].w, column[0].x, 'layers progress horizontally');
  });
  for (const link of result.links) {
    assert.equal(typeof link.source, 'string');
    assert.equal(typeof link.target, 'string');
    assert.equal(typeof link.color, 'string');
    assert.ok(link.color.length > 0);
    for (const key of ['value', 'width', 'sy', 'ty']) finite(link[key], 'link.' + key);
    assert.ok(link.value > 0 && link.width > 0, 'no zero-flow or minimum-width fabricated ribbons');
    // Deliberately exact: the layout contract returns full-precision widths.
    assert.equal(link.width, link.value * result.scale, 'one global scale; no rounding/clamps');
    const from = nodes.get(link.source);
    const to = nodes.get(link.target);
    assert.ok(from && to && to.layer > from.layer, 'valid forward endpoints');
    atMost(from.x + from.w, to.x, 'ribbon horizontal bounds');
    // sy/ty are TOP edges, not centerlines. The same width applies at both ends.
    for (const [node, top] of [[from, link.sy], [to, link.ty]]) {
      atMost(node.y, top, 'band starts inside endpoint');
      atMost(top + link.width, node.y + node.h, 'band ends inside endpoint');
      atMost(0, top, 'ribbon top fits viewport');
      atMost(top + link.width, result.height, 'ribbon bottom fits viewport');
    }
  }
  for (const node of result.nodes) {
    // Incoming and outgoing occupy independent sides; do not combine their totals.
    for (const [endpoint, offset] of [['source', 'sy'], ['target', 'ty']]) {
      const bands = result.links.filter((l) => l[endpoint] === node.id).sort((a, b) => a[offset] - b[offset]);
      bands.forEach((band, i) => {
        // Bands on one side tile the gate edge contiguously: no overlap, and no gap either.
        if (i) near(bands[i - 1][offset] + bands[i - 1].width, band[offset], endpoint + ' bands must abut exactly (no gap, no overlap)');
      });
      const sideValue = node[endpoint === 'source' ? 'outValue' : 'inValue'];
      const totalWidth = bands.reduce((sum, l) => sum + l.width, 0);
      atMost(totalWidth, node.h, endpoint + ' bands never exceed the gate');
      near(totalWidth, sideValue * result.scale, endpoint + ' total width');
      if (bands.length) {
        // 门和流严丝合缝：第一条流的顶边就是门的顶边。
        near(bands[0][offset], node.y, endpoint + ' first band flush with gate top');
        // 门取 in/out 中的较大侧；较大侧最后一条流的底边就是门的底边。数据不守恒时较小侧允许短于门。
        if (Math.abs(sideValue - node.value) <= tolerance(sideValue, node.value)) {
          near(bands[bands.length - 1][offset] + bands[bands.length - 1].width, node.y + node.h, endpoint + ' last band flush with gate bottom');
        }
      }
    }
  }
  return result;
}

const modelNames = ['deepseek-v4-pro', 'glm-5.3-flash', 'gemini-3.8-flash', 'claude-sonnet', 'gpt-fixture', 'qwen-coder', 'kimi-fixture', 'deepseek-chat', 'gemini-pro', 'glm-air', 'qwen-plus', 'claude-haiku', 'local-model-a', 'local-model-b'];
const makeNode = (id, name, layer) => ({ id, name, layer });
const makeLink = (source, target, tokens, requests) => ({ source, target, tokens, requests });
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const values = weights.map((w) => Math.floor(total * w / sum));
  values[values.length - 1] += total - values.reduce((a, b) => a + b, 0);
  return values;
}

// Screenshot-shaped, entirely synthetic: 9 providers, 9 matching credential labels,
// 14 models, 2 statuses; the dominant provider carries exactly 99% of tokens.
function screenshotFixture() {
  const nodes = [];
  for (let p = 0; p < 9; p++) {
    nodes.push(makeNode('provider-' + p, '模拟渠道 ' + (p + 1), 0));
    nodes.push(makeNode('credential-' + p, '模拟凭证 ' + (p + 1), 1));
  }
  modelNames.forEach((name, m) => nodes.push(makeNode('model-' + m, name, 2)));
  nodes.push(makeNode('status-ok', '成功', 3), makeNode('status-error', '失败', 3));
  const links = [];
  const totals = modelNames.map(() => ({ tokens: 0, requests: 0 }));
  const weights = [520, 170, 100, 60, 40, 30, 20, 15, 12, 10, 8, 6, 5, 4];
  for (let p = 0; p < 9; p++) {
    const tokens = p === 0 ? 99000000 : 125000;
    const requests = (p + 1) * 140;
    links.push(makeLink('provider-' + p, 'credential-' + p, tokens, requests));
    const tokenParts = split(tokens, weights);
    const requestParts = split(requests, weights.map((_, m) => 1 + (m + p) % 5));
    modelNames.forEach((_, m) => {
      links.push(makeLink('credential-' + p, 'model-' + m, tokenParts[m], requestParts[m]));
      totals[m].tokens += tokenParts[m];
      totals[m].requests += requestParts[m];
    });
  }
  totals.forEach((total, m) => {
    const badTokens = Math.max(1, Math.floor(total.tokens / 100));
    const badRequests = Math.max(1, Math.floor(total.requests / 17));
    links.push(makeLink('model-' + m, 'status-ok', total.tokens - badTokens, total.requests - badRequests));
    links.push(makeLink('model-' + m, 'status-error', badTokens, badRequests));
  });
  return { nodes, links };
}

function manyFixture(count = 241, skew = false) {
  const nodes = [];
  const links = [];
  const totals = Array.from({ length: 9 }, () => ({ tokens: 0, requests: 0 }));
  for (let p = 0; p < 9; p++) {
    nodes.push(makeNode('provider-' + p, '模拟渠道 ' + (p + 1), 0));
    nodes.push(makeNode('credential-' + p, '模拟凭证 ' + (p + 1), 1));
  }
  for (let m = 0; m < count; m++) {
    const p = m % 9;
    const tokens = skew ? (m === 0 ? 1e12 : 1 + m % 3) : 100 + (m * 37) % 1000;
    const requests = 2 + m % 13;
    nodes.push(makeNode('model-' + m, 'fixture-model-' + String(m + 1).padStart(3, '0'), 2));
    links.push(makeLink('credential-' + p, 'model-' + m, tokens, requests));
    links.push(makeLink('model-' + m, 'status-ok', tokens * 0.9, requests - 1));
    links.push(makeLink('model-' + m, 'status-error', tokens * 0.1, 1));
    totals[p].tokens += tokens;
    totals[p].requests += requests;
  }
  totals.forEach((total, p) => links.push(makeLink('provider-' + p, 'credential-' + p, total.tokens, total.requests)));
  nodes.push(makeNode('status-ok', '成功', 3), makeNode('status-error', '失败', 3));
  return { nodes, links };
}

function threeLayerFixture() {
  return {
    nodes: [makeNode('p-a', '渠道 A', 0), makeNode('p-b', '渠道 B', 0), makeNode('m-a', '模型 A', 1), makeNode('m-b', '模型 B', 1), makeNode('ok', '成功', 2), makeNode('bad', '失败', 2)],
    links: [makeLink('p-a', 'm-a', 9, 3), makeLink('p-b', 'm-a', 1, 7), makeLink('p-a', 'm-b', 0.3, 2), makeLink('m-a', 'ok', 6, 6), makeLink('m-a', 'bad', 1, 8), makeLink('m-b', 'ok', 0.1, 1), makeLink('m-b', 'ok', 0.2, 1)],
  };
}

function dimensionFixture() {
  return {
    nodes: [makeNode('p', '渠道', 0), makeNode('tokens-only', '仅 Token', 1), makeNode('requests-only', '仅次数', 1), makeNode('both', '两种维度', 1), makeNode('end', '状态', 2), makeNode('unused', '孤立节点', 1)],
    links: [makeLink('p', 'tokens-only', 100, 0), makeLink('tokens-only', 'end', 100, 0), makeLink('p', 'requests-only', 0, 12), makeLink('requests-only', 'end', 0, 12), makeLink('p', 'both', 2, 8), makeLink('both', 'end', 2, 8), makeLink('p', 'unused', 0, 0)],
  };
}

const screenshot = screenshotFixture();
const many = manyFixture();
const skew = manyFixture(161, true);
const zero = { nodes: screenshot.nodes, links: screenshot.links.map((l) => ({ ...l, tokens: 0, requests: 0 })) };
const groups = [];
let totalGroups = 0;
function test(name, run) {
  totalGroups++;
  try {
    run();
    groups.push(name);
    console.log('PASS: ' + name);
  } catch (error) {
    console.error('FAIL: ' + name + '\n' + (error.stack || error));
    process.exitCode = 1;
  }
}

function verticalSignature(result) {
  return {
    height: result.height, scale: result.scale,
    nodes: result.nodes.map(({ x, ...n }) => n).sort((a, b) => a.id.localeCompare(b.id)),
    links: result.links.slice().sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

test('screenshot shape: 9 providers / 9 labels / 14 models / 2 statuses, 99% dominant flow', () => {
  assert.deepEqual([0, 1, 2, 3].map((l) => screenshot.nodes.filter((n) => n.layer === l).length), [9, 9, 14, 2]);
  const providers = screenshot.links.filter((l) => l.source.startsWith('provider-'));
  assert.equal(providers[0].tokens / providers.reduce((sum, l) => sum + l.tokens, 0), 0.99);
  for (const dimension of ['tokens', 'requests']) {
    const result = check(screenshot, dimension);
    assert.equal(result.nodes.length, 34);
    assert.deepEqual(result, layout(screenshot, dimension), 'repeated layout is deterministic');
    check({ nodes: screenshot.nodes.slice().reverse(), links: screenshot.links.slice().reverse() }, dimension);
  }
});

test('narrow/wide widths change horizontal layout only, not height or flow geometry', () => {
  for (const data of [screenshot, skew, many]) {
    for (const dimension of ['tokens', 'requests']) {
      const narrow = check(data, dimension, 340);
      for (const width of [680, 960, 1360]) {
        const wide = check(data, dimension, width);
        assert.deepEqual(verticalSignature(wide), verticalSignature(narrow), 'vertical layout must be independent of container width');
      }
    }
  }
});

test('dimension switching excludes zero weights and ignores the other dimension', () => {
  const data = dimensionFixture();
  const tokens = check(data, 'tokens');
  const requests = check(data, 'requests');
  assert.ok(!tokens.nodes.some((n) => n.id === 'requests-only'));
  assert.ok(!requests.nodes.some((n) => n.id === 'tokens-only'));
  assert.equal(tokens.nodes.find((n) => n.id === 'p').value, 102);
  assert.equal(requests.nodes.find((n) => n.id === 'p').value, 20);
  for (const dimension of ['tokens', 'requests']) {
    const other = dimension === 'tokens' ? 'requests' : 'tokens';
    const changed = { nodes: data.nodes, links: data.links.map((l, i) => ({ ...l, [other]: i % 2 ? Infinity : 1e15 })) };
    assert.deepEqual(check(changed, dimension), layout(data, dimension), 'unselected dimension must have no influence');
  }
});

test('three-layer fallback, duplicate endpoint links, fractional and unbalanced flows', () => {
  for (const dimension of ['tokens', 'requests']) check(threeLayerFixture(), dimension);
  const data = threeLayerFixture();
  data.links = data.links.map((l, i) => ({ ...l, tokens: l.tokens / (7 + i), requests: l.requests / (3 + i) }));
  for (const dimension of ['tokens', 'requests']) check(data, dimension);
});

test('sparse layers and skipped-layer edges retain valid geometry', () => {
  const layerIds = [0, 3, 11, 27];
  const data = { nodes: screenshot.nodes.map((n) => ({ ...n, layer: layerIds[n.layer] })), links: screenshot.links.slice() };
  data.links.push(makeLink('provider-0', 'model-0', 3, 2), makeLink('credential-2', 'status-ok', 7, 1));
  for (const dimension of ['tokens', 'requests']) check(data, dimension, 680);
  const noZeroLayer = { nodes: data.nodes.map((n) => ({ ...n, layer: n.layer + 4 })), links: data.links };
  check(noZeroLayer);
});

test('empty/all-zero/invalid data and widths return finite, empty layouts', () => {
  for (const data of [undefined, null, {}, [], { nodes: [], links: [] }, { nodes: null, links: null }, { nodes: {}, links: [] }, { nodes: screenshot.nodes, links: 'invalid' }, { nodes: screenshot.nodes, links: [] }, zero]) {
    for (const dimension of ['tokens', 'requests']) check(data, dimension);
  }
  const nodes = [makeNode('a', 'A', 0), makeNode('peer', 'Peer', 0), makeNode('b', 'B', 2)];
  const invalid = [0, -1, NaN, Infinity, -Infinity, undefined, null];
  const links = invalid.map((value) => makeLink('a', 'b', value, value));
  links.push(makeLink('missing', 'b', 5, 5), makeLink('a', 'missing', 6, 6), makeLink('b', 'a', 7, 7), makeLink('a', 'a', 8, 8), makeLink('a', 'peer', 9, 9), null, {});
  for (const dimension of ['tokens', 'requests']) {
    check({ nodes, links }, dimension);
    check({ nodes, links: links.concat(makeLink('a', 'b', 0.125, 3)) }, dimension);
  }
  for (const width of [undefined, 0, -100, NaN, Infinity, -Infinity]) {
    check(zero, 'tokens', width);
    check(threeLayerFixture(), 'tokens', width);
  }
});

test('extreme skew preserves tiny ribbons; 241-model fixture has no cutoffs', () => {
  for (const dimension of ['tokens', 'requests']) {
    const result = check(skew, dimension);
    assert.equal(result.nodes.length, skew.nodes.length);
    if (dimension === 'tokens') assert.ok(result.links.some((l) => l.width > 0 && l.width < 1e-6), 'tiny positive flow must survive without clamping');
    const large = check(many, dimension);
    assert.equal(large.nodes.length, 261);
    assert.equal(large.links.length, many.links.length);
    atMost(48 + 241 * 14 + 240 * 8, large.height, 'height accommodates all nodes and gaps');
    assert.ok(large.height > check(screenshot, dimension).height, 'node count, not viewport width, drives height');
  }
});

const hostile = threeLayerFixture();
const hostileIds = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'id" ><&', '</script><img src=x onerror=alert(1)>'];
const idMap = new Map(hostile.nodes.map((n, i) => [n.id, hostileIds[i]]));
hostile.nodes = hostile.nodes.map((n, i) => ({ ...n, id: idMap.get(n.id), name: (i % 2 ? '<svg onload=alert(1)>" & ' : '</script><img src=x onerror=alert(1)> ') + '很长的模拟模型名称-'.repeat(30) }));
hostile.links = hostile.links.map((l) => ({ ...l, source: idMap.get(l.source), target: idMap.get(l.target) }));
test('hostile string IDs and long Unicode/HTML names are preserved safely', () => {
  for (const dimension of ['tokens', 'requests']) check(hostile, dimension);
});

// Real-ledger shape that exposed the ordering regression: provider A (42 req) splits across two
// credentials (39 + 3) while provider B (40 req) has one. Sorting the credential layer by value
// put B's credential above A's main credential and crossed the ribbons between layers 0 and 1.
function splitCredentialFixture() {
  return {
    nodes: [
      makeNode('p:a', '渠道 A', 0), makeNode('p:b', '渠道 B', 0), makeNode('p:c', '渠道 C', 0),
      makeNode('c:a:main', '默认凭证', 1), makeNode('c:a:c1', 'c1', 1), makeNode('c:b:main', '默认凭证', 1), makeNode('c:c:main', '默认凭证', 1),
      makeNode('m:x', '模型 X', 2), makeNode('m:y', '模型 Y', 2), makeNode('m:z', '模型 Z', 2),
      makeNode('s:failed', '异常重试 / 失败', 3), makeNode('s:success', '调用成功 200', 3),
      makeNode('t:output', '模型生成', 4), makeNode('t:input', '常规输入', 4), makeNode('t:cache_write', '缓存写', 4), makeNode('t:cache_read', '缓存读', 4),
    ],
    links: [
      makeLink('p:a', 'c:a:main', 3900, 39), makeLink('p:a', 'c:a:c1', 300, 3), makeLink('p:b', 'c:b:main', 4000, 40), makeLink('p:c', 'c:c:main', 500, 5),
      makeLink('c:a:main', 'm:x', 3900, 39), makeLink('c:a:c1', 'm:y', 300, 3), makeLink('c:b:main', 'm:y', 4000, 40), makeLink('c:c:main', 'm:z', 500, 5),
      makeLink('m:x', 's:success', 3800, 38), makeLink('m:x', 's:failed', 100, 1), makeLink('m:y', 's:success', 4300, 43), makeLink('m:z', 's:success', 400, 4), makeLink('m:z', 's:failed', 100, 1),
      makeLink('s:success', 't:cache_read', 4000, 0), makeLink('s:success', 't:cache_write', 1000, 0), makeLink('s:success', 't:input', 3000, 0), makeLink('s:success', 't:output', 500, 0),
      makeLink('s:failed', 't:input', 200, 0),
    ],
  };
}

function ribbonCrossings(result, fromLayer, toLayer) {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const band = result.links.filter((l) => byId.get(l.source).layer === fromLayer && byId.get(l.target).layer === toLayer);
  let crossings = 0;
  for (let i = 0; i < band.length; i++) for (let j = i + 1; j < band.length; j++) {
    if ((band[i].sy - band[j].sy) * (band[i].ty - band[j].ty) < 0) crossings++;
  }
  return crossings;
}

test('layer ordering: credentials follow their provider, no 1:1 crossings, semantic layers keep fixed order', () => {
  for (const dimension of ['tokens', 'requests']) {
    const result = check(splitCredentialFixture(), dimension);
    const column = (layer) => result.nodes.filter((n) => n.layer === layer).sort((a, b) => a.y - b.y).map((n) => n.id);
    assert.deepEqual(column(0), ['p:a', 'p:b', 'p:c'], 'first layer sorts by flow (42 > 40 > 5)');
    const providers = column(0);
    const credentials = column(1);
    // Every credential has exactly one provider, so grouping by provider position removes all crossings.
    assert.equal(ribbonCrossings(result, 0, 1), 0, 'provider → credential ribbons must not cross');
    assert.deepEqual(credentials, providers.flatMap((p) => credentials.filter((c) => c.startsWith('c:' + p.slice(2) + ':'))), 'credentials grouped under their provider in provider order');
    assert.ok(credentials.indexOf('c:a:main') < credentials.indexOf('c:a:c1'), 'within one provider larger credential first');
    assert.deepEqual(column(3), ['s:success', 's:failed'], 'success gate on top, failed gate at bottom');
    if (dimension === 'tokens') assert.deepEqual(column(4), ['t:cache_read', 't:cache_write', 't:input', 't:output'], 'token gates keep fixed semantic order');
    // Screenshot-shaped fixture: model layer groups under its dominant credential, which the value-only sort violated.
    const shot = check(screenshot, dimension);
    const byId = new Map(shot.nodes.map((n) => [n.id, n]));
    const models = shot.nodes.filter((n) => n.layer === 2).sort((a, b) => a.y - b.y);
    const primaryOf = (node) => {
      const incoming = shot.links.filter((l) => l.target === node.id);
      return byId.get(incoming.reduce((m, l) => l.value > m.value ? l : m, incoming[0]).source);
    };
    for (let i = 1; i < models.length; i++) {
      assert.ok(primaryOf(models[i - 1]).y <= primaryOf(models[i]).y, 'models ordered by dominant credential position');
    }
  }
});

// Small DOM surface used only by the actual renderer and the extracted tooltip code.
function renderHarness(width) {
  const listeners = new Map();
  const element = () => ({
    innerHTML: '', style: { setProperty(name, value) { this[name] = value; } },
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; },
  });
  const child = element();
  const box = Object.assign(element(), {
    clientWidth: width, clientHeight: 0, firstElementChild: child, firstChild: child, children: [child],
    contains(target) { return target === box || target === child; },
    querySelector(selector) { return selector === 'svg' && box.innerHTML.includes('<svg') ? child : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width, height: 0, left: 0, top: 0 }; },
  });
  const tip = element();
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => id === 'uSankeySvg' ? box : id === 'kTip' ? tip : null,
      addEventListener(name, listener) { listeners.set(name, listener); },
    },
    window: { innerWidth: width, innerHeight: 1000 },
    setTimeout, clearTimeout,
  });
  vm.runInContext('"use strict";\n' + helpers + '\nlet sankeyDim = "tokens";\n' + layoutCode + '\n' + renderer + '\n' + tooltip, ctx);
  return (data, dimension) => {
    ctx.__data = freeze(structuredClone(data));
    ctx.__dimension = dimension;
    vm.runInContext('sankeyDim = __dimension; renderSankey(__data);', ctx, { timeout: 5000 });
    return box.innerHTML;
  };
}

test('gate/flow flush: no minimum gate height; tiny gates keep a 14px label slot; flush holds for every gate', () => {
  for (const [data, dimension] of [[skew, 'tokens'], [screenshot, 'tokens'], [screenshot, 'requests'], [many, 'tokens'], [threeLayerFixture(), 'tokens']]) {
    const result = check(data, dimension);
    const tiny = result.nodes.filter((n) => n.h < 1);
    if (data === skew) {
      assert.ok(tiny.length > 100, 'skewed fixture must produce sub-pixel gates instead of minimum-height floors');
      tiny.forEach((n) => near(n.slotH, 14, 'sub-pixel gate still owns a 14px slot'));
      // Row pitch for a column of tiny gates is exactly slot + gap = 22px.
      const column = tiny.filter((n) => n.layer === tiny[0].layer).sort((a, b) => a.slotY - b.slotY);
      for (let i = 1; i < column.length; i++) near(column[i].slotY - column[i - 1].slotY, 22, 'tiny-gate row pitch is 22px');
    }
    // Every gate: the dominant side's band stack covers [y, y+h] exactly.
    for (const node of result.nodes) {
      const side = node.inValue >= node.outValue ? 'target' : 'source';
      const offset = side === 'target' ? 'ty' : 'sy';
      const bands = result.links.filter((l) => l[side] === node.id).sort((a, b) => a[offset] - b[offset]);
      if (!bands.length) continue;
      near(bands[0][offset], node.y, node.id + ' top flush');
      near(bands[bands.length - 1][offset] + bands[bands.length - 1].width, node.y + node.h, node.id + ' bottom flush');
    }
  }
  // Non-conserving input (m-a: in 10, out 7) takes the larger side; the smaller side may fall short but never overhang.
  const three = check(threeLayerFixture(), 'tokens');
  const ma = three.nodes.find((n) => n.id === 'm-a');
  near(ma.h, 10 * three.scale, 'gate takes the larger side');
  const out = three.links.filter((l) => l.source === 'm-a').reduce((s, l) => s + l.width, 0);
  near(out, 7 * three.scale, 'smaller side keeps its true width');
});

test('actual renderer: viewport, all nodes/ribbons, dimension/empty transitions, escaping', () => {
  for (const width of [340, 680, 1280]) {
    const render = renderHarness(width);
    for (const data of [screenshot, skew, many, hostile, dimensionFixture()]) {
      for (const dimension of ['tokens', 'requests']) {
        const svg = render(data, dimension);
        const expected = layout(data, dimension, width);
        assert.ok(!/NaN|Infinity/.test(svg), 'SVG must contain only finite geometry');
        const viewport = svg.match(/<svg\b[^>]*viewBox="([^"]+)"/);
        assert.ok(viewport, 'SVG viewBox missing');
        const numbers = viewport[1].trim().split(/\s+/).map(Number);
        assert.deepEqual(numbers, [0, 0, expected.width, expected.height]);
        const tagged = (tag, className) => [...svg.matchAll(new RegExp('<' + tag + '\\b[^>]*class="([^"]*)"[^>]*>', 'g'))]
          .filter((match) => match[1].split(/\s+/).includes(className));
        assert.equal(tagged('rect', 'sk-node').length, expected.nodes.length, 'renderer cannot truncate nodes');
        assert.equal(tagged('path', 'sk-link').length, expected.links.length, 'renderer cannot truncate ribbons');
        assert.ok(svg.includes('data-k-tip='), 'actual hover markup missing');
        // Seam-free contract: one translucent group for all ribbons (no per-path alpha), gates drawn after it.
        assert.ok(/<g class="sk-links" opacity="0\.42">/.test(svg), 'ribbons must share one <g opacity> so abutting bands cannot form dark seams');
        assert.ok(svg.indexOf('</g>', svg.lastIndexOf('class="sk-link"')) < svg.indexOf('<rect class="sk-node"'), 'gates must be painted after the ribbon group');
        const byId = new Map(expected.nodes.map((n) => [n.id, n]));
        const rightEdges = new Set(expected.nodes.map((n) => n.x + n.w));
        const leftEdges = new Set(expected.nodes.map((n) => n.x));
        const ribbons = [...svg.matchAll(/<path class="sk-link" d="M ([-\d.e]+) ([-\d.e]+) C [^"]*?, ([-\d.e]+) ([-\d.e]+) L \3 ([-\d.e]+) C [^"]*?, \1 ([-\d.e]+) Z"/g)];
        assert.equal(ribbons.length, expected.links.length, 'every ribbon path must be a closed band with vertical end cuts');
        // Anti-aliasing seam pad: a band's bottom edge may extend by min(0.6, 40% of the next band below) on each side, never on the last band of a side.
        const padFor = (id, side, key, band) => {
          const bands = expected.links.filter((l) => l[side] === id).sort((a, b) => a[key] - b[key]);
          const i = bands.indexOf(band);
          return i + 1 < bands.length ? Math.min(0.6, bands[i + 1].width * 0.4) : 0;
        };
        for (const [, x0, sy, x1, ty, tyBottom, syBottom] of ribbons) {
          // Ends extend 2px into the gates (hidden under the opaque gate) so the junction has no anti-aliasing seam.
          assert.ok([...rightEdges].some((edge) => Math.abs(Number(x0) + 2 - edge) < 1e-6), 'ribbon start sits 2px inside a source gate');
          assert.ok([...leftEdges].some((edge) => Math.abs(Number(x1) - 2 - edge) < 1e-6), 'ribbon end sits 2px inside a target gate');
          // (sy, ty) alone is not unique across layers (e.g. a pass-through node with one in and one out band), so match on the gates too.
          const match = expected.links.find((l) => {
            const s = byId.get(l.source), t = byId.get(l.target);
            return Math.abs(Number(x0) + 2 - (s.x + s.w)) < 1e-6 && Math.abs(Number(x1) - 2 - t.x) < 1e-6
              && Math.abs(l.sy - Number(sy)) < 1e-6 && Math.abs(l.ty - Number(ty)) < 1e-6;
          });
          assert.ok(match, 'rendered band must start at its layout sy/ty inside its own gates');
          const e0 = padFor(match.source, 'source', 'sy', match), e1 = padFor(match.target, 'target', 'ty', match);
          atMost(e0, 0.6, 'seam pad bounded'); atMost(e1, 0.6, 'seam pad bounded');
          // Bottom edges = top edge + layout width + seam pad, on each end (compare sums so tolerance scales with the coordinates).
          near(Number(syBottom) + 0, Number(sy) + match.width + e0, 'source end: band width equals layout width (+seam pad only when a band sits below)');
          near(Number(tyBottom) + 0, Number(ty) + match.width + e1, 'target end: band width equals layout width (+seam pad only when a band sits below)');
        }
        for (const rect of [...svg.matchAll(/<rect class="sk-node"[^>]*>/g)]) {
          assert.ok(!/\brx=|\bry=/.test(rect[0]), 'gate rect must be square-cornered');
        }
        assert.ok(!/<(?:script|img)\b|<svg\s+onload=/i.test(svg), 'hostile names/IDs must not become elements');
        if (data === hostile) assert.ok(svg.includes('&lt;'), 'HTML names must be escaped');
      }
    }
    for (const data of [zero, { nodes: [], links: [] }, null]) {
      const html = render(data, 'tokens');
      assert.ok(html.includes('暂无'), 'empty state missing');
      assert.ok(!/<(?:path|rect)\b/.test(html), 'empty render must clear prior flow');
    }
    assert.ok(render(screenshot, 'requests').includes('<svg'), 'can recover after an empty render');
  }
  // CSS side of the seam-free contract.
  const rule = (selector) => {
    const m = css.match(new RegExp('(?:^|[\\s}])' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, selector + ' rule missing');
    return m[1];
  };
  assert.ok(!/\brx\s*:|\bry\s*:/.test(rule('.sk-node')), '.sk-node must not round its corners (rounded corners leave notches where bands meet the gate)');
  assert.ok(!/fill-opacity/.test(rule('.sk-node')), '.sk-node must be opaque so it hides the ribbon ends underneath');
  assert.ok(/stroke\s*:\s*none/.test(rule('.sk-node')), '.sk-node must have no stroke');
  assert.ok(/stroke\s*:\s*none/.test(rule('.sk-link')), '.sk-link must have no stroke');
  assert.ok(!/fill-opacity/.test(rule('.sk-link')), '.sk-link must not carry its own alpha (group opacity only)');
  assert.ok(/stroke\s*:\s*transparent/.test(rule('.sk-link-hit')), 'hit path must stay invisible');
});

if (totalGroups < 9 || layoutChecks === 0) process.exitCode = 1;
console.log(`${process.exitCode ? 'FAILED' : 'PASS'}: ${groups.length}/${totalGroups} Sankey test groups; ${layoutChecks} actual-template layout checks.`);

if (process.argv.includes('--serve') && !process.exitCode) {
  const http = require('node:http');
  // Escape script delimiters even though the preview fixtures contain no secrets.
  const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sankey 布局回归预览</title><style>
${css}
:root { --vscode-editor-background:#211e26; --vscode-sideBar-background:#27232d; --vscode-foreground:#edeaf1; --vscode-descriptionForeground:#b7b2bf; --vscode-widget-border:#443b50; --vscode-input-background:#24202b; --vscode-font-family:'Segoe UI',sans-serif; }
body { margin:0; padding:20px; } .fixture-tools { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; } .fixture-tools button { padding:6px 12px; background:#403151; color:#fff; border:1px solid #7c679a; border-radius:5px; cursor:pointer; } .fixture-tools button[aria-pressed="true"] { background:#7449a5; border-color:#b88cee; } .fixture-note { color:#b7b2bf; font-size:12px; line-height:1.6; } #fixtureCard { box-sizing:border-box; width:100%; } #fixtureCard.narrow { width:340px; }
</style></head><body><h2>Sankey 布局回归预览</h2><p class="fixture-note">仅模拟数据，无真实凭证。默认 9 个渠道 / 9 个凭证标签 / 14 个模型 / 2 个状态，主渠道占 99% Token。窄卡片为 340px；图表按源码保留最小宽度并横向滚动，节点高度与窗口宽度无关。</p>
<div class="fixture-tools" aria-label="模拟数据"><button data-fixture="screenshot" aria-pressed="true">截图结构 · 99%</button><button data-fixture="skew" aria-pressed="false">极端偏斜 · 161 模型</button><button data-fixture="many" aria-pressed="false">大量节点 · 241 模型</button><button data-fixture="zero" aria-pressed="false">全零</button><button id="fixtureWidth" aria-pressed="false">切换窄 / 宽</button></div>
<div class="card ucard-sankey" id="fixtureCard"><div class="cardhead"><div><h3>分流桑基图</h3><div class="muted" style="font-size:10.5px;margin-top:2px;">渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态</div></div><div class="seg useg-sk" role="tablist"><button data-sk="tokens" class="sel" role="tab" aria-selected="true">Token</button><button data-sk="requests" role="tab" aria-selected="false">次数</button></div></div><div class="usankey-scroll"><div class="usankey-box" id="uSankeySvg"></div></div></div><div id="kTip"></div><script>
${helpers}
let sankeyDim = 'tokens';
${layoutCode}
${renderer}
${tooltip}
const datasets = ${json({ screenshot, skew, many, zero })};
let data = datasets.screenshot;
const redraw = () => renderSankey(data);
document.querySelectorAll('[data-fixture]').forEach((button) => button.addEventListener('click', () => {
  data = datasets[button.dataset.fixture];
  document.querySelectorAll('[data-fixture]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  redraw();
}));
document.querySelectorAll('[data-sk]').forEach((button) => button.addEventListener('click', () => {
  sankeyDim = button.dataset.sk;
  document.querySelectorAll('[data-sk]').forEach((b) => { b.classList.toggle('sel', b === button); b.setAttribute('aria-selected', String(b === button)); });
  redraw();
}));
$('fixtureWidth').addEventListener('click', () => {
  const narrow = $('fixtureCard').classList.toggle('narrow');
  $('fixtureWidth').setAttribute('aria-pressed', String(narrow));
  redraw();
});
let lastWidth = -1;
new ResizeObserver(() => {
  const width = $('uSankeySvg').clientWidth;
  if (width !== lastWidth) { lastWidth = width; redraw(); }
}).observe($('uSankeySvg'));
redraw();
</script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  server.listen(0, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:' + server.address().port + '/ (synthetic fixtures only; Ctrl+C to stop)'));
}
