import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/src/usageStore.ts';
let text = fs.readFileSync(filePath, 'utf-8');

const oldFuncStart = 'export function getSankeyData(range: Range): SankeyData {';
const oldFuncEnd = '/** 测试/诊断。 */';

const sIdx = text.indexOf(oldFuncStart);
const eIdx = text.indexOf(oldFuncEnd);

if (sIdx === -1 || eIdx === -1) {
  console.error('Bounds not found');
  process.exit(1);
}

const newSankeyDataFunc = `export function getSankeyData(range: Range): SankeyData {
  const filteredRecords = records.filter((r) => r.ts >= range.from && r.ts <= range.to);

  const nodeMap = new Map<string, { id: string; name: string; layer: number; color?: string }>();
  const linkMap = new Map<string, { source: string; target: string; tokens: number; requests: number }>();

  const addNode = (id: string, name: string, layer: number, color?: string) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, name, layer, color });
    }
  };

  const addLink = (source: string, target: string, tokens: number, requests: number) => {
    const key = \`\${source}-->\${target}\`;
    let cur = linkMap.get(key);
    if (!cur) {
      cur = { source, target, tokens: 0, requests: 0 };
      linkMap.set(key, cur);
    }
    cur.tokens += tokens;
    cur.requests += requests;
  };

  if (filteredRecords.length > 0) {
    for (const r of filteredRecords) {
      const pId = \`p:\${r.providerId}\`;
      const pName = r.providerName || r.providerId;
      const cId = \`c:\${r.providerId}:\${r.credentialId || "main"}\`;
      const cName = r.credentialId ? (r.credentialId.length > 12 ? r.credentialId.slice(0, 10) + "…" : r.credentialId) : "默认凭证";
      const mId = \`m:\${r.model}\`;
      const mName = r.model;
      const sId = r.ok ? "s:success" : "s:failed";
      const sName = r.ok ? "调用成功 200" : "异常重试 / 失败";

      const inTok = r.inputTokens || 0;
      const outTok = r.outputTokens || 0;
      const readTok = r.cacheReadTokens || 0;
      const writeTok = r.cacheWriteTokens || 0;
      const totalTok = inTok + outTok + readTok + writeTok;

      // Layer 0 ~ 3: 渠道 -> 凭证 -> 模型 -> 状态 (请求数严格为整数 1)
      addNode(pId, pName, 0);
      addNode(cId, cName, 1);
      addNode(mId, mName, 2);
      addNode(sId, sName, 3, r.ok ? "var(--green)" : "var(--red)");

      addLink(pId, cId, totalTok, 1);
      addLink(cId, mId, totalTok, 1);
      addLink(mId, sId, totalTok, 1);

      // Layer 4: 缓存命中与 Token 细分流向 (仅承载 Token 分流，requests 设为 0，防止把 1 次请求在多个 Token 门重复计算或产出小数)
      if (readTok > 0) {
        const id = "t:cache_read";
        addNode(id, "缓存命中读取 (Cache Read)", 4, "#10b981");
        addLink(sId, id, readTok, 0);
      }
      if (writeTok > 0) {
        const id = "t:cache_write";
        addNode(id, "缓存创建写入 (Cache Write)", 4, "#a855f7");
        addLink(sId, id, writeTok, 0);
      }
      if (inTok > 0) {
        const id = "t:input";
        addNode(id, "常规输入 (Prompt Input)", 4, "#38bdf8");
        addLink(sId, id, inTok, 0);

        // Layer 5: 输入上下文的微观去向 (纯 Token 维度)
        const cb = r.contextBreakdown;
        if (cb) {
          if (cb.filesTokens > 0) {
            addNode("ctx:files", "关联代码文件 (Files)", 5, "#38bdf8");
            addLink("t:input", "ctx:files", cb.filesTokens, 0);
          }
          if (cb.historyTokens > 0) {
            addNode("ctx:history", "历史会话记录 (History)", 5, "#818cf8");
            addLink("t:input", "ctx:history", cb.historyTokens, 0);
          }
          if (cb.toolsTokens > 0) {
            addNode("ctx:tools", "工具规格定义 (Tools)", 5, "#c084fc");
            addLink("t:input", "ctx:tools", cb.toolsTokens, 0);
          }
          if (cb.rulesTokens > 0) {
            addNode("ctx:rules", "系统规则设定 (Rules)", 5, "#f43f5e");
            addLink("t:input", "ctx:rules", cb.rulesTokens, 0);
          }
          if (cb.currentInputTokens > 0) {
            addNode("ctx:current", "当前用户指令 (Prompt)", 5, "#34d399");
            addLink("t:input", "ctx:current", cb.currentInputTokens, 0);
          }
        } else {
          addNode("ctx:current", "常规指令内容", 5, "#38bdf8");
          addLink("t:input", "ctx:current", inTok, 0);
        }
      }
      if (outTok > 0) {
        const id = "t:output";
        addNode(id, "模型生成 (Completion Output)", 4, "#f59e0b");
        addLink(sId, id, outTok, 0);

        addNode("out:completion", "回答与思考生成", 5, "#f59e0b");
        addLink("t:output", "out:completion", outTok, 0);
      }
    }
  } else {
    // 降级使用 buckets
    for (const b of bucketsIn(range)) {
      const pId = \`p:\${b.providerId}\`;
      const pName = b.providerId;
      const mId = \`m:\${b.model}\`;
      const mName = b.model;
      const sOkId = "s:success";
      const sFailId = "s:failed";

      const inTok = b.inputTokens || 0;
      const outTok = b.outputTokens || 0;
      const readTok = b.cacheReadTokens || 0;
      const writeTok = b.cacheWriteTokens || 0;
      const totalTok = inTok + outTok + readTok + writeTok;
      const succReq = Math.max(0, b.requests - b.failures);
      const failReq = b.failures;

      addNode(pId, pName, 0);
      addNode(mId, mName, 1);
      if (succReq > 0) addNode(sOkId, "调用成功 200", 2, "var(--green)");
      if (failReq > 0) addNode(sFailId, "异常重试 / 失败", 2, "var(--red)");

      addLink(pId, mId, totalTok, b.requests);
      const succTok = b.requests > 0 ? Math.round((totalTok * succReq) / b.requests) : 0;
      const failTok = totalTok - succTok;
      if (succReq > 0) addLink(mId, sOkId, succTok, succReq);
      if (failReq > 0) addLink(mId, sFailId, failTok, failReq);

      const targetState = succReq > 0 ? sOkId : sFailId;
      if (readTok > 0) {
        addNode("t:cache_read", "缓存命中读取 (Cache Read)", 3, "#10b981");
        addLink(targetState, "t:cache_read", readTok, 0);
      }
      if (writeTok > 0) {
        addNode("t:cache_write", "缓存创建写入 (Cache Write)", 3, "#a855f7");
        addLink(targetState, "t:cache_write", writeTok, 0);
      }
      if (inTok > 0) {
        addNode("t:input", "常规输入 (Prompt Input)", 3, "#38bdf8");
        addLink(targetState, "t:input", inTok, 0);
      }
      if (outTok > 0) {
        addNode("t:output", "模型生成 (Completion Output)", 3, "#f59e0b");
        addLink(targetState, "t:output", outTok, 0);
      }
    }
  }

  return {
    nodes: [...nodeMap.values()],
    links: [...linkMap.values()],
  };
}

`;

text = text.slice(0, sIdx) + newSankeyDataFunc + text.slice(eIdx);
fs.writeFileSync(filePath, text, 'utf-8');
console.log('usageStore.ts getSankeyData updated: removed all fractional requests!');
