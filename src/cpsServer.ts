import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { PortHolder, OwnershipListener } from "./portBinder";
import { getModelListStyle, isEnabled } from "./config";
import { getActiveProviders, getProvider, kiroModelIds, providerIconId } from "./providers";
import { debug, error, info } from "./log";
import { serveIdentity } from "./proxyIdentity";
import { applyGuard } from "./requestGuard";
import {
  fetchRelayModels,
  groupModelsByEffort,
  looksReasoningModel,
  lookupCapability,
  resolveModelImage,
  resolveModelReasoning,
  EFFORT_LEVELS,
  BUDGET_EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  GROUP_HEADER_PREFIX,
} from "./modelStore";
import { getEffortMode } from "./effort";
import type { ModelCapability } from "./modelCatalog";
import { FORCED_THINKING_EFFORTS, isForcedThinkingModel } from "./thinkingPolicy";
import { getContextWindowOverride } from "./config";
import { ContextWindowInfo, formatContextTable, resolveContextWindow } from "./contextWindow";

/**
 * models.dev 目录的 reasoning_options → Kiro 选择器要展示的档位列表。
 *  - effort：直接用它声明的 values（deepseek 的 none/max 就在这里）；
 *  - toggle：两档 none / high 表达开关（LongCat 的 thinking on/off）；
 *  - budget：high / max 两档（Claude 的 budget_tokens）。
 * 无 reasoning 或目录未命中 → 返回 undefined，交给调用方走后缀推断兜底。
 */
function catalogEfforts(cap: ModelCapability | undefined): string[] | undefined {
  if (!cap || !cap.reasoning || cap.reasoningOptions.length === 0) {
    return undefined;
  }
  for (const opt of cap.reasoningOptions) {
    if (opt.type === "effort" && opt.values.length > 0) {
      return opt.values;
    }
  }
  if (cap.reasoningOptions.some((o) => o.type === "budget")) {
    return ["high", "max"];
  }
  if (cap.reasoningOptions.some((o) => o.type === "toggle")) {
    return ["none", "high"];
  }
  return undefined;
}

interface CpsModel {
  modelId: string;
  modelName: string;
  description: string;
  promptCaching: {
    maximumCacheCheckpointsPerRequest: number;
    minimumTokensPerCacheCheckpoint: number;
    supportsPromptCaching: boolean;
  };
  rateUnit: string;
  supportedInputTypes: string[];
  tokenLimits: { maxInputTokens: number; maxOutputTokens: number };
  additionalModelRequestFieldsSchema?: unknown;
  defaultEffortLevel?: string;
}

/**
 * 渠道分组标题行。Kiro 的选择器（ModelSelector）是一张扁平的 option 列表，只认 name / description /
 * rateMultiplier，没有分组、也没有禁用单项的能力——控制面返回的 modelProvider 字段在 kiro-agent 映射给
 * UI 时就被丢掉了。所以「分组标题」只能是一条假模型；真被选中时 krsServer 拦下来提示用户选具体模型
 * （见 modelStore.isGroupHeaderId）。
 *
 * 长相：选择器把 name 渲染成粗体主行，把 description 渲染成 0.9 倍字号、0.8 透明度的副标题行
 * （.chat-input-popup-option-name / -description）。标题行反过来用：渠道名放 description，name 给空串——
 * React 对 "" 不生成文本节点，name 那个 span 是空盒子、高度为 0——整行就只剩一行小号淡色的渠道名，
 * 正是原生菜单里分节标题的样子；模型行保持粗体原名，粗/淡、大/小两级对比把层级拉开。
 * name 必须是 ""（而非空格）：selectorStyle.ts 注入的填充/光晕样式靠 `.chat-input-popup-option-name:empty`
 * 认出标题行，Chromium 的 :empty 不容忍空白文本节点。kiro-agent 侧是 `modelName ?? modelId` 兜底，"" 会原样保留。
 */
function getProviderIconInline(iconId: string): string {
  if (!iconId) return "";
  try {
    const assetDir = path.join(__dirname, "..", "assets");
    if (iconId.startsWith("glyph:")) {
      const name = iconId.slice(6);
      const p = path.join(assetDir, "glyphs", name + ".svg");
      if (fs.existsSync(p)) {
        let s = fs.readFileSync(p, "utf8");
        s = s.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
        s = s.replace(/width="[^"]*"/, "").replace(/height="[^"]*"/, "");
        if (!s.includes("viewBox=")) s = s.replace("<svg", '<svg viewBox="0 0 24 24"');
        s = s.replace("<svg", '<svg width="13" height="13" fill="currentColor"');
        return s.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim();
      }
    } else {
      const sp = path.join(assetDir, "providers", iconId + ".svg");
      if (fs.existsSync(sp)) {
        let s = fs.readFileSync(sp, "utf8");
        s = s.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
        s = s.replace(/width="[^"]*"/, "").replace(/height="[^"]*"/, "");
        s = s.replace("<svg", '<svg width="13" height="13" fill="currentColor"');
        return s.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim();
      }
      const pp = path.join(assetDir, "providers", iconId + ".png");
      if (fs.existsSync(pp)) {
        const b64 = fs.readFileSync(pp).toString("base64");
        return `<img src='data:image/png;base64,${b64}' style='width:13px;height:13px;display:block;object-fit:contain;' />`;
      }
    }
  } catch (e) {}
  return "";
}

function groupHeaderRow(providerId: string, providerName: string, count: number = 1, iconId: string = ""): CpsModel {
  const iconLetter = (providerName || "P").trim().charAt(0).toUpperCase();
  const rawSvg = getProviderIconInline(iconId);
  const iconB64 = rawSvg ? Buffer.from(rawSvg, "utf8").toString("base64") : "";
  return {
    modelId: GROUP_HEADER_PREFIX + providerId,
    modelName: "",
    description: `__A2K_GRP__|${providerName}|${count}|${iconLetter}|${iconId}|${iconB64}`,
    promptCaching: { maximumCacheCheckpointsPerRequest: 0, minimumTokensPerCacheCheckpoint: 0, supportsPromptCaching: false },
    rateUnit: "Credit",
    supportedInputTypes: ["TEXT"],
    tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
  };
}

export class CpsProxyServer {
  private holder: PortHolder;
  private port: number;

  constructor(port: number, onOwnershipChange?: OwnershipListener) {
    this.port = port;
    this.holder = new PortHolder(
      port,
      "CPS",
      () => http.createServer((req, res) => this.handleRequest(req, res)),
      onOwnershipChange
    );
  }

  async start(): Promise<void> {
    await this.holder.start();
  }

  async stop(): Promise<void> {
    await this.holder.stop();
  }

  isOwner(): boolean {
    return this.holder.isOwner();
  }

  hadForeignConflict(): boolean {
    return this.holder.hadForeignConflict();
  }

  getPort(): number {
    return this.port;
  }

  private async buildModelList(): Promise<{ models: CpsModel[]; defaultModel?: { modelId: string } }> {
    const relay = await fetchRelayModels(false);
    const groups = groupModelsByEffort(relay);
    const mode = getEffortMode();

    // 多渠道时怎么区分来源，由 modelListStyle 决定：
    //  grouped（默认）：模型按渠道分组（fetchAllModels 按 provider 顺序合并，同渠道天然相邻），
    //    每组前插一条小号淡色的渠道名标题行（见 groupHeaderRow），模型名保持原样；
    //  suffix：老做法，模型名后缀「(渠道名)」；plain：什么都不加。
    // 只有一个渠道时不需要区分，三种都退化成纯模型名。
    const activeProviders = getActiveProviders();
    const activeCount = activeProviders.length;
    const style = activeCount > 1 ? getModelListStyle() : "plain";
    const label = style === "suffix";
    // 稳定地按 provider 注册顺序排，保证同渠道的模型相邻（分组标题行只插在渠道切换处）
    const order = new Map(activeProviders.map((p, i) => [p.id, i] as const));
    groups.sort((a, b) => (order.get(a.providerId) ?? 1e9) - (order.get(b.providerId) ?? 1e9));
    // 同名模型在多个渠道都勾了：第一个渠道用原 id，其余带 @providerId（名字不变）
    const kiroIds = kiroModelIds(groups.map((g) => ({ id: g.baseId, providerId: g.providerId })));

    // 每条模型的上下文挡位信息（4.13.55，R24）：与 models 同下标，供 description 第 5 位与 contextWindowsOf() 复用
    const ctxInfos: ContextWindowInfo[] = [];
    const models: CpsModel[] = groups.map((g, gi) => {
      const provider = getProvider(g.providerId);
      const official = provider?.anthropicMode === "official";
      const openai = g.protocol === "openai";
      // 目录能力：图片模态、思考档位形态的权威来源。
      const cap = lookupCapability(g.baseId);
      // 图片支持：用户覆盖 > 目录 > 保守认为支持（不误伤）。
      const imgDecided = resolveModelImage(g.baseId, g.providerId);
      const supportsImage = typeof imgDecided === "boolean" ? imgDecided : true;
      // 上下文窗口：渠道字段 → 厂商目录 → models.dev（只认精确条目）→ 默认 200000；用户覆盖（键 = Kiro 里的模型 id）优先。
      // Kiro 按 maxInputTokens 算百分比与 80% / 95% 阈值——这里报多少，Kiro 就在多少处压缩。
      const ctx = resolveContextWindow(
        { upstream: g.upstreamContextWindow, vendor: g.vendorContextWindow, catalog: cap?.contextWindow },
        getContextWindowOverride(kiroIds[gi])
      );
      ctxInfos.push(ctx);

      const model: CpsModel = {
        modelId: kiroIds[gi],
        modelName: (g.name || g.baseId) + (label && provider ? ` (${provider.name})` : ""),
        // 不透传上游的模型简介：OpenRouter 之类给的是整段营销文案，会在 Kiro 选择器里每个模型下面
        // 撑出三四行，把列表挤得没法扫；留空，选择器就只显示名字。
        description: "",
        promptCaching: {
          maximumCacheCheckpointsPerRequest: 4,
          minimumTokensPerCacheCheckpoint: 1024,
          supportsPromptCaching: true,
        },
        rateUnit: "Credit",
        supportedInputTypes: supportsImage ? ["TEXT", "IMAGE"] : ["TEXT"],
        tokenLimits: {
          maxInputTokens: ctx.effective,
          maxOutputTokens: g.maxOutputTokens || cap?.maxOutputTokens || 64000,
        },
      };

      // 决定该模型对外暴露哪些 effort 档位。
      //
      // Kiro 的档位选择器**完全由这里广播的 schema 驱动**（listAvailableModels 从
      // additionalModelRequestFieldsSchema 的 output_config.effort / reasoning.effort
      // 里取 enum），不广播就不显示。所以「显示哪些档」这件事的正确性全在本函数。
      //
      // 证据优先级（宁可不给也不臆造）：
      // 1) models.dev 目录的 reasoning_options —— 最权威，且区分 effort/toggle/budget 三态；
      // 2) 中转站透出的官方 nativeEffortLevels；
      // 3) 中转站模型列表里真实存在的 `<base>-<effort>` 变体；
      // 4) 都没有 → 不广播（thinkingBudget 模式例外）。
      let efforts: string[] = [];
      let schemaPath = "output_config";

      // 1) 目录 reasoning_options → 档位。
      const catEfforts = catalogEfforts(cap);
      if (official) {
        // 官方 Anthropic 直通：交给上游默认，不广播 Kiro 档位。
      } else if (g.protocol === "kiro") {
        // Kiro 官方：请求体是原样转发的，档位 schema 也原样用官方 ListAvailableModels 给的那份
        // （Kiro 自己按它组 additionalModelRequestFields）；没拉到官方清单就不广播，别拿 models.dev 的 Claude 条目去猜
        if (g.requestFieldsSchema) {
          model.additionalModelRequestFieldsSchema = g.requestFieldsSchema;
          if (g.defaultEffortLevel) {
            model.defaultEffortLevel = g.defaultEffortLevel;
          }
        }
        efforts = [];
      } else if (isForcedThinkingModel(g.baseId)) {
        // GLM-5.3 系：上游只认 low/high/max（medium 直接 400），目录里谁先到不能决定这一家的档位。
        efforts = [...FORCED_THINKING_EFFORTS];
      } else if (catEfforts) {
        efforts = catEfforts;
      } else if (openai) {
        if (g.nativeEffortLevels && g.nativeEffortLevels.length > 0) {
          efforts = g.nativeEffortLevels;
        } else if (looksReasoningModel(g.baseId, g.providerId)) {
          efforts = ["low", "medium", "high"];
        }
      } else if (g.nativeEffortLevels && g.nativeEffortLevels.length > 0) {
        efforts = g.nativeEffortLevels;
        if (g.effortSchemaPath) {
          schemaPath = g.effortSchemaPath;
        }
      } else if (mode === "modelVariant" || mode === "auto") {
        efforts = EFFORT_LEVELS.filter((e) => g.efforts.has(e));
      } else if (mode === "thinkingBudget") {
        efforts = [...BUDGET_EFFORT_LEVELS];
      }

      if (efforts.length > 0) {
        const defaultEffort =
          g.defaultEffortLevel && efforts.includes(g.defaultEffortLevel)
            ? g.defaultEffortLevel
            : efforts.includes(DEFAULT_EFFORT_LEVEL)
            ? DEFAULT_EFFORT_LEVEL
            : efforts[0];

        if (schemaPath === "reasoning") {
          // GPT 5.6：reasoning.{mode?, effort}，additionalProperties:false（逐字对齐上游真实 schema，
          // 让 Kiro 选择器识别 standard/pro 思考模式）。mode 仅当中转站透出 reasoningModes 时出现。
          const reasoningProps: Record<string, unknown> = {};
          if (g.reasoningModes && g.reasoningModes.length > 0) {
            const defMode =
              g.defaultReasoningMode && g.reasoningModes.includes(g.defaultReasoningMode)
                ? g.defaultReasoningMode
                : g.reasoningModes[0];
            reasoningProps.mode = { type: "string", enum: g.reasoningModes, default: defMode };
          }
          reasoningProps.effort = { type: "string", enum: efforts, default: defaultEffort };
          model.additionalModelRequestFieldsSchema = {
            type: "object",
            properties: { reasoning: { type: "object", properties: reasoningProps } },
            additionalProperties: false,
          };
        } else {
          model.additionalModelRequestFieldsSchema = {
            type: "object",
            properties: {
              [schemaPath]: {
                type: "object",
                properties: {
                  effort: { type: "string", enum: efforts },
                },
              },
            },
          };
        }
        model.defaultEffortLevel = defaultEffort;
      }

      return model;
    });

    // 默认模型先定下来（第一个真模型），再插标题行——标题行绝不能成为默认。
    const result: { models: CpsModel[]; defaultModel?: { modelId: string } } = { models };
    if (models.length > 0) {
      result.defaultModel = { modelId: models[0].modelId };
    }
    if (style === "grouped") {
      const withHeaders: CpsModel[] = [];
      let lastProvider = "";
      const provCounts = new Map<string, number>();
      for (const g of groups) {
        provCounts.set(g.providerId, (provCounts.get(g.providerId) || 0) + 1);
      }

      groups.forEach((g, i) => {
        if (g.providerId !== lastProvider) {
          lastProvider = g.providerId;
          const count = provCounts.get(g.providerId) || 1;
          const prov = getProvider(g.providerId);
          const iconId = prov ? providerIconId(prov) : "";
          withHeaders.push(groupHeaderRow(g.providerId, prov?.name || g.providerId, count, iconId));
        }
        const isLast = (i === groups.length - 1) || (groups[i + 1].providerId !== g.providerId);
        const m = models[i];
        const hasImage = m.supportedInputTypes.includes("IMAGE");
        const hasReasoning = !!(
          m.additionalModelRequestFieldsSchema ||
          isForcedThinkingModel(g.baseId) ||
          g.protocol === "kiro" ||
          resolveModelReasoning(g.baseId, g.providerId)
        );
        // 私有微格式 __A2K_MDL__|推理|图片|窗口|挡位表|末行：选择器补丁读 p[1] / p[2]、末行靠 endsWith("|1")，
        // Context Usage 弹层补丁读 p[3] 显示真实总窗口（webview 拿不到 tokenLimits）；第 5 位（4.13.55）是
        // `候选,候选,…~来源~已知~解析值`，聊天框「上下文」下拉据此列挡位（见 contextWindow.formatContextTable）。
        m.description = `__A2K_MDL__|${hasReasoning ? 1 : 0}|${hasImage ? 1 : 0}|${m.tokenLimits.maxInputTokens}|${formatContextTable(ctxInfos[i])}|${isLast ? 1 : 0}`;
        withHeaders.push(m);
      });
      result.models = withHeaders;
    }
    return result;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 来源守卫（4.13.53 起，requestGuard.ts）：只放行本机非浏览器客户端，其余 403。放在身份端点与模型列表分派之前——
    // 一个 <img src> 式裸 GET 此前就能触发对全部启用 provider 的带 Key 拉取（路径含 availablemodels 即分派）。
    if (!applyGuard(req, res, "CPS")) {
      return;
    }

    const url = req.url || "/";
    const path = url.split("?")[0];

    // 头里有让位签名（4.13.53 起），身份握手要看它。
    if (serveIdentity(url, res, "cps", req.headers)) {
      return;
    }

    if (!isEnabled()) {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    const target = (req.headers["x-amz-target"] || req.headers["x-amzn-target"] || "") as string;
    const op = target.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "";
    const pathKey = path.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const contentType = target ? "application/x-amz-json-1.0" : "application/json";

    // Profiles
    if (op === "getprofile" || op === "listavailableprofiles" || pathKey.includes("profile")) {
      req.resume();
      const isList =
        op === "listavailableprofiles" ||
        pathKey.includes("listavailableprofiles") ||
        pathKey.includes("profiles");
      const profile = {
        arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/API2KIRODUAL",
        profileName: "API4Kiro",
        identityDetails: { region: "us-east-1" },
      };
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify(isList ? { profiles: [profile] } : { profile }));
      return;
    }

    // Model list
    if (op === "listavailablemodels" || pathKey.includes("availablemodels")) {
      req.resume();
      const t0 = Date.now();
      this.buildModelList()
        .then((list) => {
          // 这一步慢了 Kiro 会超时 → 空列表 → 选择器消失，所以把耗时记进日志方便排查
          info(`cps models: ${list.models.length} 条，用时 ${Date.now() - t0}ms`);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify(list));
        })
        .catch((e) => {
          error("buildModelList failed:", (e as Error)?.message);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify({ models: [] }));
        });
      return;
    }

    // Usage limits: we surface usage in our own panel, so return an empty stub
    // (Kiro tolerates an empty object here).
    if (op === "getusagelimits" || pathKey.includes("usagelimit")) {
      req.resume();
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify({}));
      return;
    }

    // Anything else: benign empty object.
    req.resume();
    info("CPS passthrough:", op || pathKey);
    res.writeHead(200, { "Content-Type": contentType });
    res.end("{}");
  }
}
