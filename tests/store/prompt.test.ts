/** promptStore：单选不变量、已启用不可删、历史多启用收敛、持久化。 */
import * as vscode from "vscode";
import { test, run, eq, ok, throws, deepEq } from "./harness";
import { Prompt, _resetForTest, activePromptText, deletePrompt, getActivePrompt, initPromptStore, listPrompts, savePrompt, setPromptEnabled } from "../../src/promptStore";

type Ctx = { globalState: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Promise<void> } };
const stub = vscode as unknown as { __makeContext(): Ctx; __reset(): void };
const KEY = "prompts.v1";

function fresh(): Ctx {
  _resetForTest();
  stub.__reset();
  const ctx = stub.__makeContext();
  initPromptStore(ctx as never);
  return ctx;
}

test("setPromptEnabled：启用一条自动停用其它，任意时刻 ≤ 1 条 enabled", async () => {
  fresh();
  const a = await savePrompt({ name: "A", content: "aaa" });
  const b = await savePrompt({ name: "B", content: "bbb" });
  const c = await savePrompt({ name: "C", content: "ccc" });
  eq(getActivePrompt(), undefined, "新建默认不启用");
  await setPromptEnabled(a.id, true);
  eq(getActivePrompt()!.id, a.id);
  await setPromptEnabled(b.id, true);
  eq(getActivePrompt()!.id, b.id);
  eq(listPrompts().filter((p) => p.enabled).length, 1);
  await setPromptEnabled(c.id, true);
  await setPromptEnabled(c.id, false);
  eq(getActivePrompt(), undefined);
  eq(listPrompts().filter((p) => p.enabled).length, 0);
  deepEq(
    listPrompts().map((p) => p.name),
    ["A", "B", "C"],
    "创建顺序"
  );
});

test("deletePrompt：已启用拒绝删除；停用后可删；删不存在的静默", async () => {
  fresh();
  const a = await savePrompt({ name: "A", content: "aaa" });
  await setPromptEnabled(a.id, true);
  await throws(() => deletePrompt(a.id), /无法删除已启用/);
  eq(listPrompts().length, 1);
  await setPromptEnabled(a.id, false);
  await deletePrompt(a.id);
  eq(listPrompts().length, 0);
  await deletePrompt("nope");
});

test("savePrompt：name 必填；更新不改 enabled；自定义 id 冲突时另起", async () => {
  fresh();
  await throws(() => savePrompt({ name: "  ", content: "x" }), /名称不能为空/);
  const a = await savePrompt({ id: "custom", name: "A", content: "v1" });
  eq(a.id, "custom");
  await setPromptEnabled(a.id, true);
  const a2 = await savePrompt({ id: "custom", name: "A2", description: "  d  ", content: "v2" });
  eq(a2.id, "custom");
  eq(a2.enabled, true, "更新不动 enabled");
  eq(a2.description, "d");
  eq(activePromptText(), "v2");
  const other = await savePrompt({ id: "", name: "B", content: "b" });
  ok(other.id.startsWith("prompt-"), "空 id 自动生成");
  eq(listPrompts().length, 2);
});

test("activePromptText：只 trim 首尾、保留内部换行；空白内容视为不注入", async () => {
  fresh();
  const a = await savePrompt({ name: "A", content: "\n\n  # 标题\n\n  - 缩进项\n\n" });
  await setPromptEnabled(a.id, true);
  eq(activePromptText(), "# 标题\n\n  - 缩进项");
  await savePrompt({ id: a.id, name: "A", content: "   \n\t " });
  eq(activePromptText(), undefined);
});

test("initPromptStore：历史数据多条 enabled 只保留 updatedAt 最新的一条；坏行丢弃", async () => {
  _resetForTest();
  stub.__reset();
  const ctx = stub.__makeContext();
  const now = Date.now();
  const items: Array<Partial<Prompt> | null> = [
    { id: "x", name: "X", content: "x", enabled: true, createdAt: now - 3000, updatedAt: now - 3000 },
    { id: "y", name: "Y", content: "y", enabled: true, createdAt: now - 2000, updatedAt: now - 1000 },
    { id: "z", name: "Z", content: "z", enabled: true, createdAt: now - 1000, updatedAt: now - 2000 },
    { id: "", name: "no-id", content: "", enabled: true },
    null,
  ];
  await ctx.globalState.update(KEY, { v: 1, items });
  initPromptStore(ctx as never);
  eq(listPrompts().length, 3);
  eq(getActivePrompt()!.id, "y", "最近更新的胜出");
  eq(listPrompts().filter((p) => p.enabled).length, 1);
});

test("持久化：每次改动写 globalState，重新 init 后状态一致", async () => {
  const ctx = fresh();
  const a = await savePrompt({ name: "A", content: "aaa" });
  await setPromptEnabled(a.id, true);
  const saved = ctx.globalState.get<{ v: number; items: Prompt[] }>(KEY)!;
  eq(saved.v, 1);
  eq(saved.items.length, 1);
  eq(saved.items[0].enabled, true);
  _resetForTest();
  initPromptStore(ctx as never);
  eq(getActivePrompt()!.id, a.id);
  eq(activePromptText(), "aaa");
});

run();
