/**
 * 纯文本模型的图片处理策略。
 *
 * 背景：Kiro 的附件按钮**不按模型能力禁用**（宿主里 `.supportedInputTypes` 零引用，
 * listAvailableModels 的映射直接把该字段丢了），所以用户随时可能给一个不支持图片的
 * 模型贴图。更糟的是 Kiro 每轮都重放完整历史，一张图进了历史，这个对话对该模型就
 * 永久 400 ——实测 glm-5.2 贴图后连发纯文本"你好"都失败。
 *
 * 既然 UI 拦不住，就在代理层兜：
 *  - 已知纯文本模型 → 发送前把所有图片剥掉，换成文字占位，对话立刻恢复可用；
 *  - 未知模型贴图后被 400 且报文提到图片/多模态 → 记住它是纯文本，并把这次请求
 *    剥图重发一次，用户当场拿到回复；
 *  - 当前这条消息里有图被剥时，在回复前提示一句，免得用户以为模型"看不见"。
 *
 * 判定用「上游返回」而非猜名字：中转站 /v1/models 没有任何能力字段，猜是不可靠的。
 * 学习结果落在 globalState，与手工配置 textOnlyModels 取并集。
 */

import * as vscode from "vscode";
import { cfg } from "./config";
import { CwHistoryItem, CwRequest, CwUserInputMessage } from "./cwTypes";
import { info } from "./log";

const LEARNED_KEY = "imagePolicy.textOnlyModels";
let ctx: vscode.ExtensionContext | undefined;
let learned = new Set<string>();

export function initImagePolicy(context: vscode.ExtensionContext): void {
  ctx = context;
  const saved = context.globalState.get<string[]>(LEARNED_KEY, []);
  learned = new Set((saved || []).map((s) => s.toLowerCase()));
}

function configured(): Set<string> {
  const list = cfg().get<string[]>("textOnlyModels", []) || [];
  return new Set(list.map((s) => String(s).toLowerCase()));
}

/** 该模型是否已知不接受图片（手工配置 ∪ 学习所得）。 */
export function isTextOnly(modelId: string): boolean {
  const id = String(modelId || "").toLowerCase();
  return !!id && (learned.has(id) || configured().has(id));
}

/** 记住某模型不接受图片。返回 true 表示是新学到的。 */
export async function markTextOnly(modelId: string): Promise<boolean> {
  const id = String(modelId || "").toLowerCase();
  if (!id || learned.has(id)) {
    return false;
  }
  learned.add(id);
  await ctx?.globalState.update(LEARNED_KEY, [...learned]);
  info(`模型 ${modelId} 已记为纯文本（上游拒绝图片输入），后续请求将自动剥离图片`);
  return true;
}

export function learnedTextOnlyModels(): string[] {
  return [...learned].sort();
}

export async function clearLearned(): Promise<void> {
  learned.clear();
  await ctx?.globalState.update(LEARNED_KEY, []);
}

/**
 * 上游这条 4xx 是否在抱怨图片/多模态输入。
 * 只在请求确实带图时调用，否则一条恰好含 "image" 字样的无关 400 会误伤模型。
 */
const IMAGE_REJECT_RE =
  /图片|图像|多模态|multi-?modal|\bimages?\b|\bvision\b|content\s*(?:仅|只)?接受字符串|content must be a string|unsupported (?:content|message) type/i;

export function looksLikeImageRejection(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 415 && status !== 422) {
    return false;
  }
  return IMAGE_REJECT_RE.test(bodyText || "");
}

export interface ImageCount {
  total: number;
  /** 其中来自当前这条用户消息（而非历史）的张数。 */
  inCurrent: number;
}

export function countImages(req: CwRequest): ImageCount {
  const state = req.conversationState;
  let total = 0;
  for (const h of state.history || []) {
    total += h.userInputMessage?.images?.length || 0;
  }
  const inCurrent = state.currentMessage?.userInputMessage?.images?.length || 0;
  return { total: total + inCurrent, inCurrent };
}

const PLACEHOLDER = "[图片已省略：当前模型不支持图片输入]";

function stripFromMessage(uim: CwUserInputMessage): CwUserInputMessage {
  const n = uim.images?.length || 0;
  if (n === 0) {
    return uim;
  }
  const marker = n === 1 ? PLACEHOLDER : `[${n} 张图片已省略：当前模型不支持图片输入]`;
  const { images: _dropped, ...rest } = uim;
  void _dropped;
  // 纯图消息剥掉图后 content 会是空串，Anthropic 会拒收空内容，所以占位符必须落进 content。
  return { ...rest, content: rest.content ? `${rest.content}\n\n${marker}` : marker };
}

function stripFromItem(item: CwHistoryItem): CwHistoryItem {
  if (!item.userInputMessage?.images?.length) {
    return item;
  }
  return { ...item, userInputMessage: stripFromMessage(item.userInputMessage) };
}

/** 返回一份剥掉所有图片的请求副本（不改动原对象）。 */
export function stripImages(req: CwRequest): CwRequest {
  const state = req.conversationState;
  return {
    ...req,
    conversationState: {
      ...state,
      history: (state.history || []).map(stripFromItem),
      currentMessage: state.currentMessage ? stripFromItem(state.currentMessage) : state.currentMessage,
    },
  };
}

/** 给用户看的提示：只在当前消息里有图被剥时显示，历史里的静默处理。 */
export function strippedNotice(modelId: string, count: ImageCount): string | undefined {
  if (count.inCurrent <= 0) {
    return undefined;
  }
  return `⚠️ 模型 \`${modelId}\` 不支持图片输入，本次已忽略 ${count.inCurrent} 张图片，仅按文字内容作答。\n\n`;
}
