/** contextParser：五项之和严格等于 inputTokens；字符提取分类；promptStore 注入计入「规则」。 */
import * as vscode from "vscode";
import { test, run, eq, ok } from "./harness";
import { RawContextBreakdown, allocateContextTokens, extractRawContextBreakdown } from "../../src/contextParser";
import { _resetForTest as resetPrompts, initPromptStore, savePrompt, setPromptEnabled } from "../../src/promptStore";
import type { CwRequest } from "../../src/cwTypes";

const stub = vscode as unknown as { __makeContext(): unknown; __reset(): void };

function sum(b: ReturnType<typeof allocateContextTokens>): number {
  return b.filesTokens + b.historyTokens + b.toolsTokens + b.rulesTokens + b.currentInputTokens;
}

// 确定性伪随机（求准任务不引入真随机）
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("allocateContextTokens：1000 组随机权重下五项之和 === inputTokens，且各项非负整数", () => {
  const rnd = lcg(20260906);
  for (let i = 0; i < 1000; i++) {
    const raw: RawContextBreakdown = {
      filesChars: Math.floor(rnd() * 50_000),
      historyChars: Math.floor(rnd() * 200_000),
      toolsChars: Math.floor(rnd() * 30_000),
      rulesChars: Math.floor(rnd() * 8_000),
      currentChars: Math.floor(rnd() * 3_000),
    };
    const input = 1 + Math.floor(rnd() * 400_000);
    const b = allocateContextTokens(raw, input);
    eq(sum(b), input, `case ${i}: ${JSON.stringify(raw)} / ${input}`);
    for (const v of Object.values(b)) {
      ok(Number.isInteger(v) && v >= 0, `非负整数 ${JSON.stringify(b)}`);
    }
  }
});

test("allocateContextTokens：四舍五入余数归位（1/3 三等分、极小 inputTokens、单项独占）", () => {
  const thirds: RawContextBreakdown = { filesChars: 1, historyChars: 1, toolsChars: 1, rulesChars: 0, currentChars: 0 };
  const b = allocateContextTokens(thirds, 100);
  eq(sum(b), 100);
  eq(b.filesTokens, 33);
  eq(b.historyTokens, 33);
  eq(b.toolsTokens, 33);
  eq(b.currentInputTokens, 1, "余数落到当前输入");
  const tiny = allocateContextTokens({ filesChars: 5000, historyChars: 5000, toolsChars: 5000, rulesChars: 5000, currentChars: 5000 }, 1);
  eq(sum(tiny), 1);
  eq(tiny.currentInputTokens, 1);
  const only = allocateContextTokens({ filesChars: 0, historyChars: 0, toolsChars: 0, rulesChars: 4242, currentChars: 0 }, 999);
  eq(only.rulesTokens, 999);
  eq(sum(only), 999);
  const huge = allocateContextTokens({ filesChars: 1, historyChars: 1e9, toolsChars: 1, rulesChars: 1, currentChars: 1 }, 1_000_000);
  eq(sum(huge), 1_000_000);
});

test("allocateContextTokens：五类字符全 0 → 全部归当前输入；inputTokens ≤ 0 → 全 0", () => {
  const zero: RawContextBreakdown = { filesChars: 0, historyChars: 0, toolsChars: 0, rulesChars: 0, currentChars: 0 };
  const b = allocateContextTokens(zero, 1234);
  eq(b.currentInputTokens, 1234);
  eq(sum(b), 1234);
  eq(sum(allocateContextTokens({ ...zero, filesChars: 10 }, 0)), 0);
  eq(sum(allocateContextTokens({ ...zero, filesChars: 10 }, -5)), 0);
});

function req(over: Partial<CwRequest["conversationState"]> = {}): CwRequest {
  return {
    conversationState: {
      conversationId: "conv-1",
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "当前输入", modelId: "m" } },
      ...over,
    },
  } as CwRequest;
}

test("extractRawContextBreakdown：五类字符分别落到对应桶", () => {
  resetPrompts();
  const r = req({
    history: [
      { userInputMessage: { content: "历史用户", userInputMessageContext: { toolResults: [{ toolUseId: "t", status: "success", content: [{ text: "结果123" }] }] } } },
      { assistantResponseMessage: { content: "历史助手", toolUses: [{ toolUseId: "t", name: "read", input: { path: "/a" } }] } },
    ],
    currentMessage: {
      userInputMessage: {
        content: "当前输入",
        modelId: "m",
        userInputMessageContext: {
          editorState: { document: { text: "文件内容文件内容" }, relevantDocuments: [{ text: "相关文档" }] },
          additionalContext: [{ name: "rule", description: "描述", innerContext: "规则正文" }],
          tools: [{ toolSpecification: { name: "read", description: "读文件", inputSchema: { json: { type: "object" } } } }],
          toolResults: [{ toolUseId: "x", status: "success", content: "tool-out" }],
        },
      },
    },
  } as never);
  const raw = extractRawContextBreakdown(r);
  eq(raw.filesChars, "文件内容文件内容".length + "相关文档".length);
  eq(raw.rulesChars, "规则正文".length + "描述".length);
  eq(raw.toolsChars, JSON.stringify({ toolSpecification: { name: "read", description: "读文件", inputSchema: { json: { type: "object" } } } }).length);
  eq(raw.currentChars, "当前输入".length + "tool-out".length);
  const expectHistory = "历史用户".length + JSON.stringify([{ text: "结果123" }]).length + "历史助手".length + "read".length + JSON.stringify({ path: "/a" }).length;
  eq(raw.historyChars, expectHistory);
});

test("extractRawContextBreakdown：promptStore 已启用的提示词计入「规则」；未启用不计；空请求全 0", async () => {
  resetPrompts();
  stub.__reset();
  initPromptStore(stub.__makeContext() as never);
  const bare = extractRawContextBreakdown(req());
  eq(bare.rulesChars, 0);
  eq(bare.currentChars, "当前输入".length);
  const p = await savePrompt({ name: "系统规则", content: "  你是一个严谨的助手。\n第二行  " });
  eq(extractRawContextBreakdown(req()).rulesChars, 0, "保存但未启用不注入");
  await setPromptEnabled(p.id, true);
  eq(extractRawContextBreakdown(req()).rulesChars, "你是一个严谨的助手。\n第二行".length, "首尾 trim 后的长度");
  await setPromptEnabled(p.id, false);
  eq(extractRawContextBreakdown(req()).rulesChars, 0);
  const empty = extractRawContextBreakdown({} as CwRequest);
  eq(empty.filesChars + empty.historyChars + empty.toolsChars + empty.rulesChars + empty.currentChars, 0);
});

run();
