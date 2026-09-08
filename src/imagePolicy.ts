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
 *  - 未知模型贴图后被 4xx 且报文说的是「模型不支持图片输入」（不是这张图太大 / 格式不对 /
 *    base64 坏了）→ 剥图重发一次，用户当场拿到回复；重发成功才把它记为纯文本；
 *  - 当前这条消息里有图被剥时，在回复前提示一句，免得用户以为模型"看不见"。
 *
 * 判定用「上游返回」而非猜名字：中转站 /v1/models 没有任何能力字段，猜是不可靠的。
 * 学习结果落在 globalState，与手工配置 textOnlyModels 取并集。
 *
 * 学习分两阶段（T47）：`suspectTextOnly` 在拒图时只记嫌疑（内存、不影响 isTextOnly），
 * `confirmTextOnly` 在剥图重发拿到 2xx 后才真正学习落盘，`dismissTextOnly` 在重发仍失败时撤销。
 * 一次性的 `markTextOnly` 仍保留给尚未接线两阶段的调用方。
 */

import * as vscode from "vscode";
import { cfg } from "./config";
import { CwHistoryItem, CwRequest, CwUserInputMessage } from "./cwTypes";
import { info } from "./log";

const LEARNED_KEY = "imagePolicy.textOnlyModels";
let ctx: vscode.ExtensionContext | undefined;
let learned = new Set<string>();
/** 待确认的纯文本嫌疑（上游拒图过、剥图重发尚未成功）。只在内存，不参与 isTextOnly。 */
const suspects = new Set<string>();

export function initImagePolicy(context: vscode.ExtensionContext): void {
  ctx = context;
  const saved = context.globalState.get<string[]>(LEARNED_KEY, []);
  learned = new Set((saved || []).map((s) => s.toLowerCase()));
  suspects.clear();
}

function configured(): Set<string> {
  const list = cfg().get<string[]>("textOnlyModels", []) || [];
  return new Set(list.map((s) => String(s).toLowerCase()));
}

function normalize(modelId: string): string {
  return String(modelId || "").toLowerCase();
}

/** 该模型是否已知不接受图片（手工配置 ∪ 学习所得）。嫌疑不算。 */
export function isTextOnly(modelId: string): boolean {
  const id = normalize(modelId);
  return !!id && (learned.has(id) || configured().has(id));
}

async function learn(id: string, modelId: string): Promise<boolean> {
  suspects.delete(id);
  if (!id || learned.has(id)) {
    return false;
  }
  learned.add(id);
  await ctx?.globalState.update(LEARNED_KEY, [...learned]);
  info(`模型 ${modelId} 已记为纯文本（上游拒绝图片输入，剥图后可用），后续请求将自动剥离图片`);
  return true;
}

/**
 * 一次性记住某模型不接受图片（拒图当场学习，不等剥图重发的结果）。返回 true 表示是新学到的。
 * 新接线请用 suspectTextOnly → confirmTextOnly 两阶段：一张超大图 / 坏 base64 引起的 4xx 若走这里，
 * 会把视觉模型永久记成纯文本。
 */
export async function markTextOnly(modelId: string): Promise<boolean> {
  return learn(normalize(modelId), modelId);
}

/**
 * 两阶段学习·第一阶段：上游以「不支持图片」拒绝了带图请求，先记嫌疑。
 * 不落盘、不影响 isTextOnly；已学习的模型不再记嫌疑。返回 true 表示新记了一个嫌疑。
 */
export function suspectTextOnly(modelId: string): boolean {
  const id = normalize(modelId);
  if (!id || learned.has(id) || suspects.has(id)) {
    return false;
  }
  suspects.add(id);
  return true;
}

/**
 * 两阶段学习·第二阶段：剥图重发拿到 2xx —— 证明「去掉图片就能用」，此时才真正学习并落盘。
 * 没有在案嫌疑（没经过 suspect，或已被 dismiss）时什么都不做并返回 false，避免乱序调用误学。
 * 返回 true 表示是新学到的。
 */
export async function confirmTextOnly(modelId: string): Promise<boolean> {
  const id = normalize(modelId);
  if (!suspects.has(id)) {
    return false;
  }
  return learn(id, modelId);
}

/** 两阶段学习·撤销：剥图重发仍然失败（说明拒绝不是因为图片），抹掉嫌疑。返回是否确有嫌疑被抹掉。 */
export function dismissTextOnly(modelId: string): boolean {
  return suspects.delete(normalize(modelId));
}

export function isSuspectedTextOnly(modelId: string): boolean {
  return suspects.has(normalize(modelId));
}

export function suspectedTextOnlyModels(): string[] {
  return [...suspects].sort();
}

export function learnedTextOnlyModels(): string[] {
  return [...learned].sort();
}

export async function clearLearned(): Promise<void> {
  learned.clear();
  suspects.clear();
  await ctx?.globalState.update(LEARNED_KEY, []);
}

/**
 * 上游这条 4xx 是否在说「这个模型不接受图片输入」——只认能力缺失语义，不认「这张图有问题」
 * （尺寸超限 / 格式不支持 / base64 损坏 / 张数超限：那是用户换张图就能好的事，模型本身能看图，
 * 学成纯文本会把视觉模型永久剥图）。只在请求确实带图时调用。
 *
 * 文案来源（四条通路的真实错误 + 中转站常见写法）：
 *  - OpenAI 兼容：`Invalid content type. image_url is only supported by certain models.`（官方非视觉模型）、
 *    `This model does not support image input`（vLLM 系）、`content must be a string` / `content 仅接受字符串`
 *    （只收字符串 content 的网关——本仓 OpenAI 通路只在带图时才发数组 content，所以这类错误等价于拒图）、
 *    `messages[0].content: invalid type: sequence, expected a string`（DeepSeek 422，serde 写法）、
 *    `this model is missing data required for image input`（Ollama）；
 *  - Anthropic 协议中转：`image input is not supported for this model` / `不支持多模态输入`；
 *  - Gemini：`Image input modality is not enabled for models/gemma-…`；
 *  - 415 `unsupported content type` / `unsupported message type`（中转站对 content 数组的拒收）。
 */
// 「图片 / 多模态输入」这个主语的明确写法：image input / image_url / input_image / vision / multimodal input…
const IMG_STRICT = "image[_\\s-]*(?:input|content|url|part|message|modalit)(?:s|y|ies)?|input_image\\b|vision\\b|visual\\s+input|multi-?modal(?:ity)?(?:[\\s-]*(?:input|content|data|message|request))?s?\\b";
// 裸 image(s)：后面若紧跟 format / size / type / larger / with… 就是在说某张图（或某类图）而不是能力，不算。
const IMG_BARE =
  "images?\\b(?![\\s_-]*(?:format|size|type|data|file|dimension|resolution|url|byte|pixel|width|height|count|limit|quality|detail|larger|bigger|greater|smaller|over|above|exceed|more|beyond|of\\s+type|encoded|that|which|with|in\\s+\\w+\\s+format))";
const IMG_SUBJECT = `\\b(?:${IMG_STRICT}|${IMG_BARE})`;
// 主语前若是具体格式 / 大小 / 数量的定语（gif images are not supported），说的也是某类图而不是能力。
const IMG_SUBJECT_GUARD = "(?<!\\b(?:gif|bmp|tiff?|webp|svg|heic|heif|avif|jpe?g|png|animated|large|big|multiple|\\d+)\\s)";
const NOT_SUPPORTED = "(?:supported|available|enabled|allowed|accepted|permitted)";
const IMAGE_REJECT_PATTERNS: string[] = [
  // 主语 → 否定：image input (is) not supported / images aren't allowed / image input modality is not enabled
  `${IMG_SUBJECT_GUARD}${IMG_SUBJECT}(?:\\s+modality)?(?:(?:\\s+(?:is|are|was|were))?\\s+not\\s+(?:yet\\s+|currently\\s+)?${NOT_SUPPORTED}|(?:\\s+(?:is|are|was|were))?\\s+un(?:supported|available)|\\s+(?:is|are|was|were)n'?t\\s+${NOT_SUPPORTED})`,
  // 否定 → 主语：does not support image input / doesn't accept images / no support for vision
  `(?:does\\s*not|doesn'?t|do\\s*not|don'?t|cannot|can'?t|unable\\s+to|no)\\s+(?:support|accept)(?:s|ed|ing)?(?:\\s+(?:for|of))?(?:\\s+\\w+){0,2}?\\s+${IMG_SUBJECT}`,
  // 形容词式否定 → 明确主语：unsupported image input / unsupported multimodal content（裸 image 不算：You uploaded an unsupported image 是格式错）
  `\\bun(?:supported|available)\\s+(?:${IMG_STRICT})`,
  // 能力缺失：does not have vision capabilities / no image support / lacks vision
  "(?:does\\s*not|doesn'?t|no|without|lacks?)\\s+(?:have\\s+)?(?:vision|image|multi-?modal)\\s+(?:capabilit|support|abilit)",
  // OpenAI 官方：image_url is only supported by certain models
  `${IMG_SUBJECT}\\s+(?:is|are)\\s+only\\s+(?:supported|available)\\s+(?:by|for|on|with)`,
  // 厂商 / 模型类别专用写法
  "missing\\s+data\\s+required\\s+for\\s+image\\s+input",
  "not\\s+a\\s+(?:vision|multi-?modal)\\s+model",
  "\\btext[\\s-]*only\\s+model",
  "(?:only\\s+(?:supports?|accepts?)|(?:supports?|accepts?)\\s+only)\\s+text",
  // 只收字符串 content（等价于不接受图片，见上）
  "content\\s+(?:must|should|has\\s+to|needs?\\s+to)\\s+be\\s+(?:a\\s+|of\\s+type\\s+)?string",
  "content\\s*(?:仅|只)?\\s*(?:接受|支持)\\s*字符串",
  "content[^\\n]{0,40}?expected\\s+a\\s+string",
  "unsupported\\s+(?:content|message)\\s+type",
  "invalid\\s+content\\s+type",
  // 中文（「不支持图片格式 / 大小」说的是某张图，不算）
  "不支持(?:图片|图像|视觉|多模态|图文)(?!格式|大小|尺寸|类型|编码|分辨率)",
  "(?:图片|图像|多模态|视觉)(?:输入|内容)?(?:不受支持|不被支持|暂不支持|尚不支持|未启用|不可用)",
  "(?:不接受|无法接受|不能接受)(?:图片|图像)",
  "(?:仅|只)支持(?:纯)?文本",
];
const IMAGE_REJECT_RE = new RegExp(IMAGE_REJECT_PATTERNS.join("|"), "i");

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
