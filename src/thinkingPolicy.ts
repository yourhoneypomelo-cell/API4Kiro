/**
 * OpenAI 兼容通路上各家「思考」方言的差异，集中放这里，别散在翻译器和转换器里。
 *
 * 一、强制思考（关不掉）的家族
 *   GLM-5.3 / GLM-5.3-Flash / GLM-5.3-highspeed。Z.ai 文档原话："thinking.type only supports
 *   enabled; thinking cannot be disabled"；chat template 无条件在 prompt 末尾注入 <think>。
 *   `enable_thinking:false` / `thinking:{type:"disabled"}` 对它们要么被忽略、要么被严格网关 400。
 *   唯一的旋钮是 `reasoning_effort ∈ {low, high, max}`：默认 max，**不认识的值（含 medium、xhigh）
 *   一律按 max 解析**（zai-org/GLM-5 README）。所以给它们发 Kiro 的五档必须先折到这三档。
 *
 *   SiliconFlow 实测（2026-09-03，zai-org/GLM-5.3-Flash 流式）：`enable_thinking:false`、
 *   `thinking:{type:"disabled"}`、`reasoning_effort:"medium"` 三者都是 HTTP 400
 *   `{"code":20015,"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}`——
 *   medium 在这里不是"按 max 解析"而是硬拒。`reasoning_effort:"low"` 对闲聊直接 reasoning_tokens=0；
 *   `thinking_budget` 返回 200 但被忽略。因此这一家族的档位**不能信目录**（models.dev 里
 *   digitalocean/crof/requesty 等条目声明了 medium/xhigh/none），选择器和请求都钉死在三档。
 *
 * 二、要把上一轮思考原样带回历史的家族（Preserved / Interleaved Thinking）
 *   - GLM-4.7+ / GLM-5.x：`clear_thinking` 在 5.3 的模板里默认 false，Z.ai 要求客户端把
 *     `reasoning_content` "complete, unmodified" 地放回每条 assistant 消息，否则多轮 / 工具循环里
 *     模型丢推理状态，会退化甚至死循环（oh-my-pi#517、opencode#18415、goose#7363）。
 *   - DeepSeek V3.2+ / V4：思考模式带工具调用时，同一轮内的 reasoning_content 要回传。
 *   - Kimi K2/K3 thinking：工具循环里必须回传 reasoning_content。
 *   OpenAI 官方等严格网关不认 assistant.reasoning_content（400），所以只对这些家族回传，
 *   并留一个总开关（api2kiroDual.openaiReasoningEcho）。
 *
 *   回传的前提是 Kiro 得先把思考留在历史里。Kiro 只保留**带签名**的 reasoning
 *   （"Dropping unsigned reasoning from history"），OpenAI 协议没有签名，所以转换器在思考结束时
 *   补一个合成签名占位；Anthropic 侧回传历史时要认出它并跳过（见 translate.extractThinkingBlock），
 *   否则用户中途把模型切到 Claude 会撞上 "Invalid signature" 400。
 *
 * 三、把回答写进思考通道的习惯
 *   GLM-5.3 系（模板无条件注入 <think>）在闲聊 / 问候式问题上常常不推敲，直接在 think 里把最终回答
 *   写完，</think> 之后再逐字（或改写着）答一遍。Kiro 里表现为「Thought complete」折叠里是完整回答、
 *   下面又一份。2026-09-03 用户截图：思考与正文 291 字逐字相同，completion_tokens=328 ≈ 两份——
 *   是模型生成了两遍，不是解析器把一份复制到两个字段（直连 SiliconFlow 12 次都是英文推敲 + 中文正文，
 *   触发条件依赖 Kiro 那 14k 的真实指令）。
 *   真正的推敲开头有极强的形态特征（"The user is asking…" / "用户…" / "Let me…"），回答开头也有
 *   （问候语 / "我是 Kiro" / markdown 结构 / emoji），classifyReasoningHead 据此在收到头几十个字时
 *   判断该直播还是先扣住等正文比对（openaiStream.ts thoughtGate）。
 */

import { lookupCapability } from "./modelCatalog";
import { EffortLevel } from "./modelStore";

/** 合成签名：OpenAI 通路上"没有签名"的占位，让 Kiro 把思考留在历史里。 */
export const SYNTHETIC_REASONING_SIGNATURE = "api4kiro:unsigned-reasoning";

export function isSyntheticSignature(sig: string | undefined | null): boolean {
  return typeof sig === "string" && sig.startsWith("api4kiro:");
}

function bare(modelId: string): string {
  const s = String(modelId || "").toLowerCase();
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** GLM-5.3 系（含 -flash / -highspeed 及各家加的后缀）：思考不可关闭。 */
export function isForcedThinkingModel(modelId: string): boolean {
  return /glm[-_.]?5\.3/.test(bare(modelId));
}

/** 强制思考家族上游唯一认的三档；Kiro 选择器对这一家族只广播这三个，目录声明再多也不用。 */
export const FORCED_THINKING_EFFORTS: readonly ["low", "high", "max"] = ["low", "high", "max"];

/** 思考结束后要把 reasoning_content 带回历史的家族。 */
export function wantsReasoningEcho(modelId: string): boolean {
  const m = bare(modelId);
  if (/glm[-_.]?(4\.[7-9]|5)/.test(m)) {
    return true;
  }
  if (/deepseek[-_.]?(v3\.[2-9]|v4|chat|reasoner)/.test(m)) {
    return true;
  }
  if (/kimi[-_]?k[23]/.test(m)) {
    return true;
  }
  return false;
}

export type ReasoningHeadKind = "deliberation" | "answer" | "undecided";

/** 至少攒够这么多字（或见到换行）再下"推敲"的默认判定；命中明确特征时不等。 */
export const REASONING_SNIFF_MIN = 24;

const DELIBERATION_HEAD =
  /^(the user|user:|users? (is|are|asked|wants|said|sent)|let me|let's|okay|ok[,.]|hmm|i need|i should|i'll|i will|i think|we need|we should|first[, ]|so,? the|this is a|looking at|analy[sz]|thinking about|the question|the request|用户|首先|让我|我需要|我先|我来看|我得|这个问题|这是一个|先看|看一下|考虑|分析一下|需要)/i;
const ANSWER_HEAD =
  /^(你好|您好|嗨|哈喽|哈啰|hi\b|hello\b|hey\b|我是\s|i'?m kiro|i am kiro|#{1,6}\s|[-*•]\s+\S|\d+[.、)]\s|\*\*|>\s|```)/i;

/**
 * 思考开头是推敲还是回答（见文件头「三」）。只看形态：推敲是写给自己的、以描述用户 / 计划开头；
 * 回答是写给人的、以问候 / 自我介绍 / markdown 结构开头，或很快出现 emoji。
 * 两边都不像且字数还没到 REASONING_SNIFF_MIN → undecided（再攒）；攒够了仍不像回答 → 默认推敲（放行）。
 * 判定顺序推敲优先：模型复述用户带 emoji 的原话时不会被误判成回答。
 */
export function classifyReasoningHead(text: string): ReasoningHeadKind {
  const head = String(text || "").replace(/^[\s"'“”「」『』*_]+/, "");
  if (!head) {
    return "undecided";
  }
  if (DELIBERATION_HEAD.test(head)) {
    return "deliberation";
  }
  if (ANSWER_HEAD.test(head) || /\p{Extended_Pictographic}/u.test(head.slice(0, 200))) {
    return "answer";
  }
  if (head.length < REASONING_SNIFF_MIN && !/\n/.test(head)) {
    return "undecided";
  }
  return "deliberation";
}

/** 去掉全部空白后的文本，用于"正文是不是思考的复读"这类比对（两边的换行 / 空格排版不一致）。 */
export function squashWhitespace(s: string): string {
  return String(s || "").replace(/\s+/g, "");
}

/**
 * Kiro 五档 → GLM-5.3 三档。medium 落 high 而不是 low：GLM 的 low 是"几乎不想"，
 * 用户选 medium 多半是想要"正常思考"。xhigh 与 max 同归 max。
 */
export function forcedThinkingEffort(effort: EffortLevel | string): "low" | "high" | "max" {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    default:
      return "max";
  }
}

/**
 * 目录（models.dev）给该模型声明的 effort 取值。Kiro 选择器展示的档位就来自这里
 * （cpsServer.catalogEfforts），所以用户选中的值在这个列表里时原样透传才对得上选择器。
 * 目录没声明 → undefined，调用方回退到通用三档折叠。
 */
export function declaredEffortValues(modelId: string): string[] | undefined {
  const cap = lookupCapability(modelId);
  if (!cap || !cap.reasoning) {
    return undefined;
  }
  for (const opt of cap.reasoningOptions) {
    if (opt.type === "effort" && opt.values.length > 0) {
      return opt.values;
    }
  }
  return undefined;
}
