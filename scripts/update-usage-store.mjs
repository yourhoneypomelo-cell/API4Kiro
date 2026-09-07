import fs from 'fs';

const filePath = 'E:/AI项目/反代项目/Gemini-3.8-flash 旁路 api2kiro/api2kiro-dual/src/usageStore.ts';
let text = fs.readFileSync(filePath, 'utf-8');

// 1. 导入 ContextBreakdown
if (!text.includes('import { ContextBreakdown } from "./contextParser";')) {
  text = 'import { ContextBreakdown } from "./contextParser";\n' + text;
}

// 2. 导出 ContextBreakdown
if (!text.includes('export { ContextBreakdown };')) {
  text = text.replace('export interface UsageRecord {', 'export { ContextBreakdown };\nexport interface UsageRecord {');
}

// 3. 在 UsageRecord 增加 contextBreakdown?: ContextBreakdown;
const oldUsageRecord = `  conversationId?: string;
}`;
const newUsageRecord = `  conversationId?: string;
  contextBreakdown?: ContextBreakdown;
}`;
text = text.replace(oldUsageRecord, newUsageRecord);

// 4. 在 HourBucket 增加微观字段
const oldHourBucket = `  latencySumMs: number;
  /** 有首 token 时间的请求数与总和，求平均用。 */`;
const newHourBucket = `  latencySumMs: number;
  ctxFilesTokens?: number;
  ctxHistoryTokens?: number;
  ctxToolsTokens?: number;
  ctxRulesTokens?: number;
  ctxInputTokens?: number;
  /** 有首 token 时间的请求数与总和，求平均用。 */`;
text = text.replace(oldHourBucket, newHourBucket);

// 5. 在 addToBucket 中累加微观字段
const oldAddToBucketInit = `      cacheWriteTokens: 0,
      latencySumMs: 0,
      firstTokenCount: 0,
      firstTokenSumMs: 0,
    };`;
const newAddToBucketInit = `      cacheWriteTokens: 0,
      latencySumMs: 0,
      ctxFilesTokens: 0,
      ctxHistoryTokens: 0,
      ctxToolsTokens: 0,
      ctxRulesTokens: 0,
      ctxInputTokens: 0,
      firstTokenCount: 0,
      firstTokenSumMs: 0,
    };`;
text = text.replace(oldAddToBucketInit, newAddToBucketInit);

const oldAddToBucketUpdate = `  b.latencySumMs += r.latencyMs;`;
const newAddToBucketUpdate = `  b.latencySumMs += r.latencyMs;
  if (r.contextBreakdown) {
    b.ctxFilesTokens = (b.ctxFilesTokens || 0) + (r.contextBreakdown.filesTokens || 0);
    b.ctxHistoryTokens = (b.ctxHistoryTokens || 0) + (r.contextBreakdown.historyTokens || 0);
    b.ctxToolsTokens = (b.ctxToolsTokens || 0) + (r.contextBreakdown.toolsTokens || 0);
    b.ctxRulesTokens = (b.ctxRulesTokens || 0) + (r.contextBreakdown.rulesTokens || 0);
    b.ctxInputTokens = (b.ctxInputTokens || 0) + (r.contextBreakdown.currentInputTokens || 0);
  }`;
text = text.replace(oldAddToBucketUpdate, newAddToBucketUpdate);

// 6. 新增独立上下文统计接口 getContextBreakdownStats
const funcToAdd = `
export interface ContextBreakdownStats {
  totalInputTokens: number;
  filesTokens: number;
  historyTokens: number;
  toolsTokens: number;
  rulesTokens: number;
  currentInputTokens: number;
  filesPct: number;
  historyPct: number;
  toolsPct: number;
  rulesPct: number;
  currentPct: number;
}

export function getContextBreakdownStats(range: Range): ContextBreakdownStats {
  let filesTokens = 0;
  let historyTokens = 0;
  let toolsTokens = 0;
  let rulesTokens = 0;
  let currentInputTokens = 0;

  const filtered = records.filter((r) => r.ts >= range.from && r.ts <= range.to);
  if (filtered.length > 0) {
    for (const r of filtered) {
      if (r.contextBreakdown) {
        filesTokens += r.contextBreakdown.filesTokens || 0;
        historyTokens += r.contextBreakdown.historyTokens || 0;
        toolsTokens += r.contextBreakdown.toolsTokens || 0;
        rulesTokens += r.contextBreakdown.rulesTokens || 0;
        currentInputTokens += r.contextBreakdown.currentInputTokens || 0;
      } else if (r.inputTokens > 0) {
        // 无细分时兜底
        currentInputTokens += r.inputTokens;
      }
    }
  } else {
    for (const b of bucketsIn(range)) {
      filesTokens += b.ctxFilesTokens || 0;
      historyTokens += b.ctxHistoryTokens || 0;
      toolsTokens += b.ctxToolsTokens || 0;
      rulesTokens += b.ctxRulesTokens || 0;
      currentInputTokens += b.ctxInputTokens || (b.inputTokens || 0);
    }
  }

  const total = filesTokens + historyTokens + toolsTokens + rulesTokens + currentInputTokens;
  return {
    totalInputTokens: total,
    filesTokens,
    historyTokens,
    toolsTokens,
    rulesTokens,
    currentInputTokens,
    filesPct: total > 0 ? (filesTokens / total) * 100 : 0,
    historyPct: total > 0 ? (historyTokens / total) * 100 : 0,
    toolsPct: total > 0 ? (toolsTokens / total) * 100 : 0,
    rulesPct: total > 0 ? (rulesTokens / total) * 100 : 0,
    currentPct: total > 0 ? (currentInputTokens / total) * 100 : 0,
  };
}
`;

// 7. 更新 getSankeyData 实现方法 A：延伸至 Layer 5
const oldSankeyLayer4 = `      // Layer 4: 缓存命中与 Token 细分流向 (仅当对应类别流量 > 0 时建流)
      // 1. 缓存命中读取 (极低延迟/低成本上下文复用)
      if (readTok > 0) {
        const id = "t:cache_read";
        addNode(id, "缓存命中读取 (Cache Read)", 4, "#10b981");
        addLink(sId, id, readTok, inTok === 0 ? 1 : 0.5);
      }
      // 2. 缓存创建写入 (提示词上下文驻留/首轮写入)
      if (writeTok > 0) {
        const id = "t:cache_write";
        addNode(id, "缓存创建写入 (Cache Write)", 4, "#a855f7");
        addLink(sId, id, writeTok, 0.25);
      }
      // 3. 常规输入上下文 (未命中缓存的实时输入)
      if (inTok > 0) {
        const id = "t:input";
        addNode(id, "常规输入 (Prompt Input)", 4, "#38bdf8");
        addLink(sId, id, inTok, readTok > 0 ? 0.5 : 1);
      }
      // 4. 模型生成输出 (Completion 与思维链 Reasoning)
      if (outTok > 0) {
        const id = "t:output";
        addNode(id, "模型生成 (Completion Output)", 4, "#f59e0b");
        addLink(sId, id, outTok, 1);
      }`;

const newSankeyLayer4And5 = `      // Layer 4: 缓存命中与 Token 细分流向 (仅当对应类别流量 > 0 时建流)
      if (readTok > 0) {
        const id = "t:cache_read";
        addNode(id, "缓存命中读取 (Cache Read)", 4, "#10b981");
        addLink(sId, id, readTok, inTok === 0 ? 1 : 0.5);
      }
      if (writeTok > 0) {
        const id = "t:cache_write";
        addNode(id, "缓存创建写入 (Cache Write)", 4, "#a855f7");
        addLink(sId, id, writeTok, 0.25);
      }
      if (inTok > 0) {
        const id = "t:input";
        addNode(id, "常规输入 (Prompt Input)", 4, "#38bdf8");
        addLink(sId, id, inTok, readTok > 0 ? 0.5 : 1);

        // Layer 5: 输入上下文的微观去向 (方法 A：延伸至微观分类)
        const cb = r.contextBreakdown;
        if (cb) {
          if (cb.filesTokens > 0) {
            addNode("ctx:files", "关联代码文件 (Files)", 5, "#38bdf8");
            addLink("t:input", "ctx:files", cb.filesTokens, 0.4);
          }
          if (cb.historyTokens > 0) {
            addNode("ctx:history", "历史会话记录 (History)", 5, "#818cf8");
            addLink("t:input", "ctx:history", cb.historyTokens, 0.3);
          }
          if (cb.toolsTokens > 0) {
            addNode("ctx:tools", "工具规格定义 (Tools)", 5, "#c084fc");
            addLink("t:input", "ctx:tools", cb.toolsTokens, 0.2);
          }
          if (cb.rulesTokens > 0) {
            addNode("ctx:rules", "系统规则设定 (Rules)", 5, "#f43f5e");
            addLink("t:input", "ctx:rules", cb.rulesTokens, 0.1);
          }
          if (cb.currentInputTokens > 0) {
            addNode("ctx:current", "当前用户指令 (Prompt)", 5, "#34d399");
            addLink("t:input", "ctx:current", cb.currentInputTokens, 0.5);
          }
        } else {
          // 历史记录无 breakdown 时兜底
          addNode("ctx:current", "常规指令内容", 5, "#38bdf8");
          addLink("t:input", "ctx:current", inTok, 1);
        }
      }
      // 4. 模型生成输出 (Completion 与思维链 Reasoning)
      if (outTok > 0) {
        const id = "t:output";
        addNode(id, "模型生成 (Completion Output)", 4, "#f59e0b");
        addLink(sId, id, outTok, 1);

        // Layer 5: 模型输出去向落地
        addNode("out:completion", "回答与思考生成", 5, "#f59e0b");
        addLink("t:output", "out:completion", outTok, 1);
      }`;

text = text.replace(oldSankeyLayer4, newSankeyLayer4And5);

// 在 getSankeyData 之前插入 getContextBreakdownStats
const sankeyStart = 'export function getSankeyData(';
text = text.replace(sankeyStart, funcToAdd + '\n' + sankeyStart);

fs.writeFileSync(filePath, text, 'utf-8');
console.log('usageStore.ts successfully updated with ContextBreakdown and 6-layer Sankey support!');
