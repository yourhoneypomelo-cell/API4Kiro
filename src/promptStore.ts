/**
 * 用户侧系统提示词（提示词管理）—— 「提示词」页的数据源，也是翻译层注入 system 的来源。
 *
 * 借鉴 cc-switch 的 Prompt 管理（services/prompt.rs）：
 *  - 一条提示词 = {id, name, description?, content, enabled, createdAt, updatedAt}；
 *  - **同一时间只能启用一个**：启用 A 会自动停用其它（enable_prompt 里 for … enabled=false）；
 *  - 已启用的不能删，得先停用（delete_prompt 的 "无法删除已启用的提示词"）。
 *
 * 但注入方式和 cc-switch 根本不同：cc-switch 是把内容写进目标应用的 CLAUDE.md / AGENTS.md，
 * 靠应用自己读文件；Kiro 没有这种用户级提示词文件——它的系统提示词在 AWS 服务端拼，
 * 请求体里根本没有 system 字段（见 translate.ts / openaiTranslate.ts，两边都只发
 * user/assistant/tool 消息）。所以我们在代理层做：把启用的那条作为 `system`（Anthropic）
 * 或 `role:"system"` 首条消息（OpenAI）随每次请求发给上游。这也意味着：
 *  - 对第三方 provider 来说，这里注入的就是模型看到的**全部** system；
 *  - 改动即时生效（下一次请求就带上），不用重载窗口。
 *
 * 存储在 globalState（内容可能几十 KB，放 settings.json 里不合适）。
 */

import * as vscode from "vscode";
import { debug } from "./log";

export interface Prompt {
  id: string;
  name: string;
  description?: string;
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Persisted {
  v: 1;
  items: Prompt[];
}

const KEY = "prompts.v1";

let ctx: vscode.ExtensionContext | undefined;
let items: Prompt[] = [];
const listeners = new Set<() => void>();

function normalize(raw: unknown): Prompt | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!id || !name) {
    return undefined;
  }
  const now = Date.now();
  return {
    id,
    name,
    description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined,
    content: typeof o.content === "string" ? o.content : "",
    enabled: o.enabled === true,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : now,
  };
}

/** 单选不变量：最多一条 enabled。历史数据若有多条，保留最近更新的那条。 */
function enforceSingleEnabled(list: Prompt[]): void {
  const on = list.filter((p) => p.enabled);
  if (on.length <= 1) {
    return;
  }
  const keep = on.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  for (const p of on) {
    if (p !== keep) {
      p.enabled = false;
    }
  }
}

export function initPromptStore(context: vscode.ExtensionContext): void {
  ctx = context;
  const saved = context.globalState.get<Persisted>(KEY);
  items = [];
  if (saved && saved.v === 1 && Array.isArray(saved.items)) {
    for (const raw of saved.items) {
      const p = normalize(raw);
      if (p) {
        items.push(p);
      }
    }
  }
  enforceSingleEnabled(items);
  debug("prompt store loaded", { count: items.length, active: getActivePrompt()?.name });
}

export function onPromptsChanged(fn: () => void): { dispose(): void } {
  listeners.add(fn);
  return { dispose: () => listeners.delete(fn) };
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

async function persist(): Promise<void> {
  if (!ctx) {
    return;
  }
  const data: Persisted = { v: 1, items };
  await ctx.globalState.update(KEY, data);
}

/** 全部提示词，按创建顺序（与 cc-switch 的 IndexMap 插入序一致）。返回副本。 */
export function listPrompts(): Prompt[] {
  return items.map((p) => ({ ...p }));
}

export function getPrompt(id: string): Prompt | undefined {
  const p = items.find((x) => x.id === id);
  return p ? { ...p } : undefined;
}

export function getActivePrompt(): Prompt | undefined {
  const p = items.find((x) => x.enabled);
  return p ? { ...p } : undefined;
}

/**
 * 翻译层用：当前应注入的 system 文本。没有启用的、或启用的内容为空白 → undefined（不注入）。
 * 只 trim 首尾，内部换行/缩进原样保留（Markdown 提示词靠它们）。
 */
export function activePromptText(): string | undefined {
  const p = items.find((x) => x.enabled);
  const t = p?.content?.trim();
  return t ? t : undefined;
}

export function newPromptId(): string {
  let id = `prompt-${Date.now()}`;
  let n = 2;
  while (items.some((p) => p.id === id)) {
    id = `prompt-${Date.now()}-${n++}`;
  }
  return id;
}

export interface PromptInput {
  id?: string;
  name: string;
  description?: string;
  content: string;
}

/** 新建或更新。name 必填；enabled 状态不在这里改（走 setPromptEnabled）。 */
export async function savePrompt(input: PromptInput): Promise<Prompt> {
  const name = (input.name || "").trim();
  if (!name) {
    throw new Error("名称不能为空");
  }
  const description = (input.description || "").trim() || undefined;
  const content = typeof input.content === "string" ? input.content : "";
  const now = Date.now();
  const existing = input.id ? items.find((p) => p.id === input.id) : undefined;
  let out: Prompt;
  if (existing) {
    existing.name = name;
    existing.description = description;
    existing.content = content;
    existing.updatedAt = now;
    out = existing;
  } else {
    out = {
      id: input.id && input.id.trim() && !items.some((p) => p.id === input.id) ? input.id.trim() : newPromptId(),
      name,
      description,
      content,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    };
    items.push(out);
  }
  await persist();
  emit();
  return { ...out };
}

/** 删除。已启用的拒绝删除（对齐 cc-switch），调用方应先停用。 */
export async function deletePrompt(id: string): Promise<void> {
  const p = items.find((x) => x.id === id);
  if (!p) {
    return;
  }
  if (p.enabled) {
    throw new Error("无法删除已启用的提示词，请先停用");
  }
  items = items.filter((x) => x.id !== id);
  await persist();
  emit();
}

/** 启用/停用。启用一条时其它全部停用（单选）。 */
export async function setPromptEnabled(id: string, enabled: boolean): Promise<void> {
  const p = items.find((x) => x.id === id);
  if (!p) {
    throw new Error(`提示词 ${id} 不存在`);
  }
  const now = Date.now();
  if (enabled) {
    for (const x of items) {
      if (x.enabled && x !== p) {
        x.enabled = false;
        x.updatedAt = now;
      }
    }
  }
  p.enabled = enabled;
  p.updatedAt = now;
  await persist();
  emit();
}

export function _resetForTest(): void {
  items = [];
}

export function _debugState(): { count: number; active?: string } {
  return { count: items.length, active: getActivePrompt()?.id };
}
