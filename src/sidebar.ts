import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readdirSync } from "fs";
import { isEnabled, updateSetting } from "./config";
import { GITHUB_URL, checkForUpdate } from "./updateChecker";
import {
  PRESETS,
  PRIMARY_CREDENTIAL_ID,
  Preset,
  Protocol,
  ProviderConfig,
  addCredential,
  allPresets,
  baseModelId,
  credentialLabel,
  credentialsOf,
  freshProviderId,
  getPreset,
  getProviders,
  hasPool,
  isCredentialConfigured,
  isModelEnabled,
  isProviderUsable,
  kiroModelIds,
  providerFromPreset,
  removeCredential,
  resolveRootUrl,
  saveProviders,
  splitQualifiedModelId,
  tokenKeyOf,
} from "./providers";
import { clearCooldown, credentialRuntimes, forgetCredential, poolStatus, reasonText } from "./credentialPool";
import { maskKey, error } from "./log";
import { RelayModel, capabilitySource, fetchAllModels, fetchProviderModels, resolveModelImage, resolveModelReasoning, seedProviderModels } from "./modelStore";
import { catalogSize, onCatalogChanged, refreshCatalog } from "./modelCatalog";
import {
  RangePreset,
  clearUsage,
  credentialTotals,
  dailyTrend,
  getTimeSeriesTrend,
  forgetCredentialTotals,
  getActivityHeatmap,
  getContextBreakdownStats,
  getModelUsageRatios,
  getSankeyData,
  getUsageAnalyticsStats,
  onUsageChanged,
  recentRecords,
  resolveRange,
  statsByProvider,
  summarize,
} from "./usageStore";
import {
  deletePrompt,
  getPrompt,
  listPrompts,
  onPromptsChanged,
  savePrompt,
  setPromptEnabled,
} from "./promptStore";
import { BatchHandle, ProviderDraft, measureLatency, probeModels, testModels } from "./providerProbe";
import { RECOMMENDED_COUNT, apiFormatOf, autoIconId, isOAuthProvider, normalizeIcon, presetIconId, providerFromOAuthVendor, providerIconId, vendorIconId } from "./providers";
import { LoginMode, OAUTH_VENDORS, getVendor } from "./oauth/vendors";
import { APP_LABEL, ScanResult, candidateToProvider, findCcSwitchStore, scanCcSwitch } from "./ccSwitchImport";
import { isHttpUrl, openInBrowser } from "./openBrowser";
import { copyToken, deleteProviderTokens, deleteToken, getToken, moveToken, onTokensChanged, setToken } from "./oauth/tokenStore";

/** 某 provider 某把凭证的 token（键规则见 tokenKeyOf）。 */
function getTokenFor(providerId: string, credentialId: string) {
  return getToken(tokenKeyOf(providerId, credentialId));
}
import { LoginStatus, cancelLogin, markLoggedIn, oauthState, startLogin } from "./oauth";

export interface PortInfo {
  krsPort: number;
  cpsPort: number;
}

/** 面板刷新模型清单时最多等多久就先出一版（慢的渠道用勾选的模型顶上，之后再补完整版）。 */
const REFRESH_BUDGET_MS = 4000;

/**
 * 自定义 provider 可选 Logo（assets/glyphs）的展示顺序。这套标是我们自己按「AI 厂商品牌标」的路数画的
 * 抽象几何图形——环与结、螺旋与弧、多边形与格、节点与网络、波与信号、圆与轨道、光与能量——粗描边或实心，
 * 对称克制，霓虹紫上色后和 OpenAI / Cohere / Perplexity 那类官方标站在一起不违和；
 * 刻意避开四角星（Google）/ 无穷（Meta）/ 阶梯方块（Mistral）这些会撞脸的形。目录里缺的会被跳过。
 */
const GLYPH_ORDER = [
  "rings-2", "rings-3", "trefoil", "chain-8", "diamond-dot", "helix", "cycle",
  "triskele", "sonar", "turbine", "eclipse", "swirl", "arcs-cross", "portal",
  "hex-nest", "hex-cube", "mesh", "tri-nest", "tri-3", "diamond-4", "star-8", "star-5", "octa-cross", "infinity-tri",
  "cube-iso", "layers-iso", "stack-3", "prism", "grid-4",
  "node-3", "node-4", "molecule", "constellation", "lattice",
  "waves-3", "flow", "pulse-ring", "bars-ring", "signal", "ripple",
  "orbit-3", "orbit-dot", "target", "halo", "eye", "shield",
  "burst-8", "star-6", "spark-3", "bolt-ring", "flame", "chevrons-3", "plus-ring",
];

/**
 * 简笔画线性图标（Lucide 风格：currentColor 描边、圆角线帽），内联进 webview。
 * 内联 SVG 是 DOM 节点不是资源加载，不受 CSP img-src 限制，也不用打包图片。
 */
const svg = (body: string, strokeWidth = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  /** 设置：齿轮（Lucide settings） */
  settings: svg(
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  ),
  /**
   * 模型：芯片（对齐 Kilo 的「模型」图标——方形芯片、中心一个圆）。
   * 比通用 cpu 图标多些细节：每边 3 根引脚而非 2 根、中心圆内再加一颗实心点；
   * 引脚密了所以线条收细到 1.6，16px 下相邻引脚仍分得开。
   */
  chip: svg(
    '<rect x="5" y="5" width="14" height="14" rx="2.5"/>' +
      '<circle cx="12" cy="12" r="3.4"/>' +
      '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>' +
      '<path d="M8 2v3M12 2v3M16 2v3M8 19v3M12 19v3M16 19v3M2 8h3M2 12h3M2 16h3M19 8h3M19 12h3M19 16h3"/>',
    1.6
  ),
  /** 星芒：用量页 Tokens 卡片的图标。 */
  sparkles: svg(
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>'
  ),
  /** 提供商：插头（接入/连接） */
  plug: svg('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  /** 用量：柱状图 */
  chart: svg('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  /**
   * 能力标签「推理」：大脑——左右两个脑叶 + 中缝 + 若干脑沟。
   * 标签里只有 11px，脑沟会糊成一点点纹理，但双叶轮廓足够辨认；放大看细节齐全。
   */
  brain: svg(
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
      '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>' +
      '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>' +
      '<path d="M17.6 6.5a3 3 0 0 0 .4-1.4"/><path d="M6 5.1a3 3 0 0 0 .4 1.4"/>' +
      '<path d="M3.5 10.9a4 4 0 0 1 .6-.4"/><path d="M19.9 10.5a4 4 0 0 1 .6.4"/>' +
      '<path d="M6 18a4 4 0 0 1-2-.5"/><path d="M20 17.5a4 4 0 0 1-2 .5"/>'
  ),
  /** 能力标签「图片」：相框里一座山、一个太阳。 */
  image: svg(
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<circle cx="9" cy="9" r="2"/>' +
      '<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'
  ),
  /** 提示词：带文字行的书（cc-switch 的提示词入口用的是 Lucide Book，这里多两行字）。 */
  book: svg(
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>' +
      '<path d="M8 7h6"/><path d="M8 11h8"/>'
  ),
  /** 编辑：铅笔（cc-switch 提示词行的 Edit3） */
  pencil: svg(
    '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>'
  ),
  /** 删除：垃圾桶（cc-switch 提示词行的 Trash2） */
  trash: svg(
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>'
  ),
  /** Provider 行「编辑」：方框里一支笔（Lucide square-pen） */
  squarePen: svg(
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.4 2.6a1 1 0 0 1 3 3L12.4 14.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>'
  ),
  /** Provider 行「创建副本」：两张叠着的纸（Lucide copy） */
  copy: svg('<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  /** Provider 行「测量延迟」：心电脉冲（Lucide activity） */
  activity: svg(
    '<path d="M22 12h-2.5a2 2 0 0 0-1.9 1.5l-2.4 8.3a.25.25 0 0 1-.5 0L9.2 2.2a.25.25 0 0 0-.5 0L6.4 10.5A2 2 0 0 1 4.5 12H2"/>'
  ),
  /** Provider 行左侧拖柄：六个点（Lucide grip-vertical，cc-switch 同款） */
  grip: svg(
    '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>' +
      '<circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
    2.4
  ),
  /** Key 输入框「显示密码」：眼睛（Lucide eye） */
  eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  /** 「隐藏密码」：划掉的眼睛（Lucide eye-off） */
  eyeOff: svg(
    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
      '<path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
      '<line x1="2" x2="22" y1="2" y2="22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>'
  ),
  /** 导入：箭头落进托盘（Lucide download）。 */
  import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  /** 加号：池底部「再登录一个账号 / 再加一把 Key」的方形小按钮（Lucide plus，线条加粗到 2.4 免得 15px 下发虚）。 */
  plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>', 2.4),
  /**
   * 接口格式（协议）：折角文档 + 右下角一枚带对号的圆徽（用户给的参考图：协议 = 盖了章的文书）。
   * 圆徽故意画大（r=5.5，占图标近一半），文档的右边和底边在圆徽处断开留白，12px 下对号仍看得出；
   * 三根文字线右端避开圆徽。Provider 行副标题用。
   */
  docCheck: svg(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6.5"/>' +
      '<path d="M14 2l6 6v3.8"/>' +
      '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
      '<path d="M8 10.5h8M8 14h3.5M8 17.5h2.4"/>' +
      '<circle cx="17.5" cy="17.5" r="5.5"/>' +
      '<path d="m14.9 17.6 1.8 1.8 3.4-3.8"/>',
    1.6
  ),
};

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "api2kiroDual.panel";

  private view?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private getPorts: () => PortInfo;
  /** 用量页当前时间范围（webview 切换时更新，推送时按它算）。 */
  private usageRange: RangePreset = "today";
  private usageTimer: NodeJS.Timeout | undefined;
  /** 进行中的批量测活（按 batchId），弹窗关了 / 用户点取消就 cancel。 */
  private batches = new Map<string, BatchHandle>();
  /** 登录会话 → 由它新建出来的 provider id（进度消息里带给弹窗）。 */
  private oauthCreated = new Map<string, string>();
  /** 上一次「从 CC Switch 导入」扫出来的候选（含明文 key，只留在扩展侧；webview 里按 idx 勾选）。 */
  private ccScan: ScanResult | undefined;

  constructor(context: vscode.ExtensionContext, getPorts: () => PortInfo) {
    this.context = context;
    this.getPorts = getPorts;
    // 每落一笔账就刷用量页（防抖 300ms，工具循环连发不抖屏）。对齐 cc-switch 的
    // usage-log-recorded → invalidate 实时刷新。
    context.subscriptions.push(
      onUsageChanged(() => {
        if (this.usageTimer) {
          clearTimeout(this.usageTimer);
        }
        this.usageTimer = setTimeout(() => {
          this.usageTimer = undefined;
          if (this.view?.visible) {
            this.postUsage();
            // key 池的冷却 / 计数是内存态，随每次请求结果变化——顺带刷一遍 provider 状态，编辑弹窗里的凭证列表才是活的
            this.postState();
          }
        }, 300);
      })
    );
    // 提示词增删改/启停 → 推「提示词」页（改动来自面板自己或命令，都走这条）。
    context.subscriptions.push(
      onPromptsChanged(() => {
        if (this.view?.visible) {
          this.postPrompts();
        }
      })
    );
    // 登录 token 变化（刷新 / 重新登录 / 失效）→ provider 行的账号与状态要跟着变。
    context.subscriptions.push(
      onTokensChanged(() => {
        if (this.view?.visible) {
          this.postState();
        }
      })
    );
    // models.dev 目录刷新 → 预设列表（可连的提供商）跟着变
    context.subscriptions.push(
      onCatalogChanged(() => {
        if (this.view?.visible) {
          this.postState();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // 只放开 assets/：provider 图标 SVG 从这里以 webview URI 加载（CSS mask）
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "assets")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postAll();
      }
    });
    this.postAll();
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand("api2kiroDual.panel.focus");
    }
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postAll();
        break;

      case "toggleEnabled": {
        const r = await updateSetting("enabled", !!msg.enabled);
        if (!r.settingsOk) {
          error("切换启用状态写入 Kiro 设置失败(已本地兜底):", r.error || "");
          this.toast("error", "已本地记录,但写入 Kiro 设置失败:" + (r.error || "未知错误"));
        }
        this.postState();
        break;
      }

      case "addProvider": {
        // 从预设一键连接（Kilo 式）：带 apiKey/baseUrl 就直接填好并启用；只有预设 id 就建一条待配置。
        // 预设含内置的与 models.dev 衍生的（md:xxx）。
        const preset = getPreset(typeof msg.presetId === "string" ? msg.presetId : undefined);
        const list = getProviders();
        const created: ProviderConfig = preset
          ? providerFromPreset(preset, list)
          : {
              id: freshProviderId(list),
              name: typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : "新 Provider",
              protocol: (msg.protocol === "anthropic" ? "anthropic" : msg.protocol === "gemini" ? "gemini" : "openai") as Protocol,
              anthropicMode: msg.protocol === "anthropic" ? (msg.anthropicMode === "official" ? "official" : "kiro") : undefined,
              openaiApi: msg.protocol === "openai" ? (msg.openaiApi === "responses" ? "responses" : "chat") : undefined,
              baseUrl: "",
              apiKey: "",
              enabled: false,
            };
        // 自定义端点 / 无内置地址的通用预设：允许一次性带上地址。
        if (typeof msg.baseUrl === "string" && msg.baseUrl.trim() && !created.baseUrl) {
          created.baseUrl = msg.baseUrl.trim();
        }
        const key = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
        if (key) {
          created.apiKey = key;
        }
        const icon = normalizeIcon(msg.icon);
        if (icon) {
          created.icon = icon;
        }
        // 有 key 且地址齐（预设自带地址）→ 直接启用，连接即用。
        created.enabled = !!created.apiKey && !!created.baseUrl;
        // 严格 opt-in：默认一个模型不进列表。连接弹窗里「拉取模型」后勾选的那几个例外——直接带进来。
        const picked = Array.isArray(msg.enabledModels)
          ? (msg.enabledModels as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map(baseModelId)
          : [];
        created.enabledModels = Array.from(new Set(picked));
        list.push(created);
        await this.persist(
          list,
          created.enabled
            ? picked.length
              ? `已连接 ${created.name}，${created.enabledModels.length} 个模型已进入 Kiro 列表`
              : `已连接 ${created.name}，去「模型」页勾选要用的模型`
            : `已添加 ${created.name}，请补全地址与 Key`
        );
        if (created.enabled) {
          // 连上就跳到模型页，免得用户重载后发现选择器里啥都没有。
          this.post({ type: "gotoTab", tab: "models" });
        }
        break;
      }

      case "saveProvider": {
        const id = String(msg.id);
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p) {
          this.toast("error", "provider 不存在");
          break;
        }
        if (typeof msg.name === "string" && msg.name.trim()) {
          p.name = msg.name.trim();
        }
        if (msg.protocol === "anthropic" || msg.protocol === "openai" || msg.protocol === "gemini") {
          p.protocol = msg.protocol;
          p.anthropicMode = msg.protocol === "anthropic" ? p.anthropicMode ?? "kiro" : undefined;
          p.openaiApi = msg.protocol === "openai" ? p.openaiApi ?? "chat" : undefined;
        }
        if (p.protocol === "anthropic" && (msg.anthropicMode === "kiro" || msg.anthropicMode === "official")) {
          p.anthropicMode = msg.anthropicMode;
        }
        if (p.protocol === "openai" && (msg.openaiApi === "chat" || msg.openaiApi === "responses")) {
          p.openaiApi = msg.openaiApi;
        }
        if (typeof msg.baseUrl === "string") {
          p.baseUrl = msg.baseUrl.trim();
        }
        // Key 留空表示不改动，避免掩码值把真 Key 覆盖掉。改的是首条凭证（c1）；池里其余的走 credential* 消息。
        if (typeof msg.apiKey === "string" && msg.apiKey.trim()) {
          const key = msg.apiKey.trim();
          if (p.credentials && p.credentials.length > 0) {
            p.credentials[0].apiKey = key;
          }
          p.apiKey = key;
          clearCooldown(p.id, PRIMARY_CREDENTIAL_ID);
        }
        if (msg.poolStrategy === "priority" || msg.poolStrategy === "least-used") {
          p.poolStrategy = msg.poolStrategy === "priority" ? undefined : "least-used";
        }
        if (typeof msg.defaultModel === "string") {
          p.defaultModel = msg.defaultModel.trim() || undefined;
        }
        // 头像：空串 = 回到自动；非法值忽略
        if (typeof msg.icon === "string") {
          p.icon = normalizeIcon(msg.icon);
        }
        await this.persist(list, "已保存");
        break;
      }

      // ---------- key 池：同一 provider 的多把凭证 ----------
      case "credentialAdd": {
        // key 类：带 apiKey 直接入池。OAuth 类不走这里（走 oauthStart + credentialId="new"）。
        const id = String(msg.id);
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p) {
          this.toast("error", "provider 不存在");
          break;
        }
        const key = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
        if (isOAuthProvider(p) || !key) {
          this.toast("error", isOAuthProvider(p) ? "登录类 provider 请用「再登录一个账号」" : "请填写 API Key");
          break;
        }
        if (credentialsOf(p).some((c) => c.apiKey === key)) {
          this.toast("error", "这把 Key 已经在池里了");
          break;
        }
        const cred = addCredential(p, { apiKey: key, label: typeof msg.label === "string" ? msg.label : undefined });
        await this.persist(list, `已加入「${p.name}」的 key 池（${credentialsOf(p).length} 把）`, true);
        this.post({ type: "credentialAdded", id, credentialId: cred.id });
        break;
      }

      case "credentialUpdate": {
        // 改备注 / 优先级 / 启停 / 换 key（key 留空=不改）
        const id = String(msg.id);
        const cid = String(msg.credentialId || "");
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        const creds = p ? [...credentialsOf(p)] : [];
        const c = creds.find((x) => x.id === cid);
        if (!p || !c) {
          this.toast("error", "凭证不存在");
          break;
        }
        if (typeof msg.label === "string") {
          c.label = msg.label.trim().slice(0, 40) || undefined;
        }
        if (typeof msg.priority === "number" && isFinite(msg.priority)) {
          c.priority = Math.max(0, Math.floor(msg.priority));
        }
        if (typeof msg.enabled === "boolean") {
          c.enabled = msg.enabled;
        }
        if (!isOAuthProvider(p) && typeof msg.apiKey === "string" && msg.apiKey.trim()) {
          c.apiKey = msg.apiKey.trim();
          clearCooldown(p.id, c.id);
        }
        if (msg.clearCooldown === true) {
          clearCooldown(p.id, c.id);
        }
        p.credentials = creds;
        await this.persist(list, msg.clearCooldown === true ? "已解除冷却" : "已保存", true);
        break;
      }

      case "credentialReorder": {
        // 拖拽后的顺序 → 重写 priority（0,1,2…）
        const id = String(msg.id);
        const ids = Array.isArray(msg.credentialIds) ? (msg.credentialIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p) {
          break;
        }
        const creds = [...credentialsOf(p)];
        let n = 0;
        for (const cid of ids) {
          const c = creds.find((x) => x.id === cid);
          if (c) {
            c.priority = n++;
          }
        }
        for (const c of creds) {
          if (!ids.includes(c.id)) {
            c.priority = n++;
          }
        }
        p.credentials = creds;
        await this.persist(list, "已调整优先级", true);
        break;
      }

      case "credentialRemove": {
        const id = String(msg.id);
        const cid = String(msg.credentialId || "");
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p) {
          break;
        }
        if (credentialsOf(p).length <= 1) {
          this.toast("error", "最后一把凭证不能删；要清空请用「清除 Key」/「退出登录」");
          break;
        }
        const r = removeCredential(p, cid);
        if (!r) {
          this.toast("error", "凭证不存在");
          break;
        }
        if (isOAuthProvider(p)) {
          if (r.promotedFromId) {
            // 删的是 c1，下一把被提升为 c1：它的 token 从 providerId/cN 挪到裸 providerId 键上（覆盖掉被删的）
            moveToken(tokenKeyOf(p.id, r.promotedFromId), tokenKeyOf(p.id, PRIMARY_CREDENTIAL_ID));
            forgetCredential(p.id, r.promotedFromId);
          } else {
            deleteToken(tokenKeyOf(p.id, r.removed.id));
          }
        }
        forgetCredential(p.id, r.removed.id);
        forgetCredentialTotals(p.id, r.removed.id);
        await this.persist(list, `已移除凭证，剩 ${credentialsOf(p).length} 把`, true);
        break;
      }

      case "setModelEnabled": {
        // 模型页勾选：把 base id 加进/移出 provider.enabledModels。这是模型进 Kiro 列表的唯一入口。
        const id = String(msg.id);
        const modelId = baseModelId(String(msg.modelId || "").trim());
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p || !modelId) {
          this.toast("error", "参数无效");
          break;
        }
        // undefined（迁移来的"全部"）一旦被用户碰过，就物化成显式列表，从此按勾选算。
        const cur = p.enabledModels === undefined ? await this.allBaseIds(p) : [...p.enabledModels];
        const set = new Set(cur.map((s) => s.toLowerCase()));
        if (msg.enabled) {
          if (!set.has(modelId.toLowerCase())) {
            cur.push(modelId);
          }
        } else {
          for (let i = cur.length - 1; i >= 0; i--) {
            if (cur[i].toLowerCase() === modelId.toLowerCase()) {
              cur.splice(i, 1);
            }
          }
        }
        p.enabledModels = cur;
        await this.persist(list, msg.enabled ? `已加入 Kiro 列表：${modelId}` : `已移出 Kiro 列表：${modelId}`, true);
        break;
      }

      case "setAllModelsEnabled": {
        // 某 provider 全选 / 全不选。带 modelIds 时只对这批操作（搜索过滤后的"全部加入"）。
        const id = String(msg.id);
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p) {
          this.toast("error", "provider 不存在");
          break;
        }
        const subset = Array.isArray(msg.modelIds)
          ? (msg.modelIds as unknown[]).filter((x): x is string => typeof x === "string").map(baseModelId)
          : undefined;
        if (subset && subset.length) {
          const cur = p.enabledModels === undefined ? await this.allBaseIds(p) : [...p.enabledModels];
          const set = new Set(cur.map((s) => s.toLowerCase()));
          if (msg.enabled) {
            for (const m of subset) {
              if (!set.has(m.toLowerCase())) {
                cur.push(m);
                set.add(m.toLowerCase());
              }
            }
          } else {
            const drop = new Set(subset.map((s) => s.toLowerCase()));
            for (let i = cur.length - 1; i >= 0; i--) {
              if (drop.has(cur[i].toLowerCase())) {
                cur.splice(i, 1);
              }
            }
          }
          p.enabledModels = cur;
          await this.persist(list, `${p.name}：已${msg.enabled ? "加入" : "移出"} ${subset.length} 个`, true);
          break;
        }
        p.enabledModels = msg.enabled ? await this.allBaseIds(p) : [];
        await this.persist(list, msg.enabled ? `${p.name}：已全部加入` : `${p.name}：已全部移出`, true);
        break;
      }

      case "removeModels": {
        // 批量编辑「移除所选」：可能跨多个 provider，一次写盘、一条提示。
        const items = Array.isArray(msg.items) ? (msg.items as Array<{ id?: unknown; modelIds?: unknown }>) : [];
        const list = getProviders();
        let removed = 0;
        for (const it of items) {
          const p = list.find((x) => x.id === String(it.id));
          const ids = Array.isArray(it.modelIds)
            ? (it.modelIds as unknown[]).filter((x): x is string => typeof x === "string").map(baseModelId)
            : [];
          if (!p || !ids.length) {
            continue;
          }
          const cur = p.enabledModels === undefined ? await this.allBaseIds(p) : [...p.enabledModels];
          const drop = new Set(ids.map((s) => s.toLowerCase()));
          const next = cur.filter((m) => !drop.has(m.toLowerCase()));
          removed += cur.length - next.length;
          p.enabledModels = next;
        }
        if (!removed) {
          this.toast("error", "没有可移除的模型");
          break;
        }
        await this.persist(list, `已移出 ${removed} 个模型`, true);
        break;
      }

      case "setModelOverride": {
        // Kilo 式「推理/图片」勾选：写进 provider.modelOverrides[modelId]。
        const id = String(msg.id);
        const modelId = String(msg.modelId || "").trim();
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (!p || !modelId) {
          this.toast("error", "参数无效");
          break;
        }
        const ov = { ...(p.modelOverrides || {}) };
        const cur = { ...(ov[modelId] || {}) };
        if (msg.field === "image" || msg.field === "reasoning") {
          // 三态循环：未设 → true → false → 未设，UI 传 value（true/false/null）。
          if (msg.value === null) {
            delete (cur as Record<string, unknown>)[msg.field];
          } else {
            (cur as Record<string, unknown>)[msg.field] = !!msg.value;
          }
        }
        if (Object.keys(cur).length === 0) {
          delete ov[modelId];
        } else {
          ov[modelId] = cur;
        }
        p.modelOverrides = Object.keys(ov).length ? ov : undefined;
        await this.persist(list, "已更新模型能力", true);
        break;
      }

      case "toggleProvider": {
        const id = String(msg.id);
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (p) {
          p.enabled = !!msg.enabled;
          await this.persist(list, p.enabled ? "已启用" : "已停用");
        }
        break;
      }

      case "clearProviderKey": {
        const id = String(msg.id);
        const list = getProviders();
        const p = list.find((x) => x.id === id);
        if (p) {
          if (isOAuthProvider(p)) {
            // 登录类的"清除 Key"= 退出登录：删凭据（池里全部账号），provider 留着，随时可重新登录。
            deleteProviderTokens(id);
            p.credentials = undefined;
            await this.persist(list, `已退出「${p.name}」的登录`, true);
          } else {
            p.apiKey = "";
            p.credentials = undefined;
            await this.persist(list, "已清除 Key");
          }
          forgetCredential(id);
        }
        break;
      }

      case "deleteProvider": {
        // 行尾一键可达的删除，必须先确认：Key / 已选模型 / 能力覆盖一起没了，没有回收站。
        const id = String(msg.id);
        const target = getProviders().find((x) => x.id === id);
        if (!target) {
          this.toast("error", "provider 不存在");
          break;
        }
        // 面板里已经用自己的确认框问过（confirmed）；没带标记的（外部调用）才退回系统对话框。
        if (msg.confirmed !== true) {
          const ok = await vscode.window.showWarningMessage(
            isOAuthProvider(target)
              ? `删除「${target.name}」？其登录凭据、已选模型与能力设置会一并移除，不可恢复。`
              : `删除「${target.name}」？其 API Key、已选模型与能力设置会一并移除，不可恢复。`,
            { modal: true },
            "删除"
          );
          if (ok !== "删除") {
            break;
          }
        }
        const list = getProviders().filter((x) => x.id !== id);
        await this.persist(list, `已删除「${target.name}」`);
        deleteProviderTokens(id);
        forgetCredential(id);
        forgetCredentialTotals(id);
        break;
      }

      case "reorderProviders": {
        // 拖拽排序：按 webview 给的 id 顺序重排；没在列表里的（并发新增）按原序补在后面。
        // 顺序有实际意义——同名模型按靠前的渠道路由（fetchAllModels 先出现者胜）。
        const ids = Array.isArray(msg.ids) ? (msg.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const list = getProviders();
        const byId = new Map(list.map((p) => [p.id, p] as const));
        const next: ProviderConfig[] = [];
        for (const id of ids) {
          const p = byId.get(id);
          if (p) {
            next.push(p);
            byId.delete(id);
          }
        }
        for (const p of list) {
          if (byId.has(p.id)) {
            next.push(p);
          }
        }
        if (next.map((p) => p.id).join() === list.map((p) => p.id).join()) {
          break;
        }
        await this.persist(next, "已调整顺序（同名模型按靠前的渠道路由）", true);
        break;
      }

      case "ccswitchScan": {
        // 从 CC Switch 导入：找它的库（~/.cc-switch/cc-switch.db 或老版 config.json），找不到 / 用户要换文件时弹系统选择框。
        // 只读，不改 CC Switch 的任何东西。候选留在扩展侧（含明文 key），webview 只拿打码后的列表按 idx 勾选。
        let file = msg.browse === true ? undefined : findCcSwitchStore();
        if (!file) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "选择 CC Switch 数据库",
            title: "选择 CC Switch 的 cc-switch.db（或旧版 config.json）",
            filters: { "CC Switch 数据": ["db", "json"], 全部: ["*"] },
          });
          file = picked && picked[0] ? picked[0].fsPath : undefined;
          if (!file) {
            this.post({ type: "ccswitchResult", cancelled: true });
            break;
          }
        }
        try {
          const scan = scanCcSwitch(file);
          this.ccScan = scan;
          this.post({
            type: "ccswitchResult",
            path: scan.path,
            items: scan.candidates.map((c) => ({
              idx: c.idx,
              name: c.name,
              sources: c.sources.map((s) => APP_LABEL[s] || s),
              protocol: c.protocol,
              format: apiFormatOf({ protocol: c.protocol, openaiApi: c.openaiApi }),
              anthropicMode: c.anthropicMode || "",
              baseUrl: c.baseUrl,
              maskedKey: maskKey(c.apiKey),
              models: c.models,
              existsAs: c.existsAs || "",
            })),
            skipped: scan.skipped.map((s) => ({ name: s.name, source: APP_LABEL[s.source] || s.source, reason: s.reason })),
          });
        } catch (e) {
          error("ccswitch scan failed:", (e as Error)?.message);
          this.post({ type: "ccswitchResult", path: file, error: (e as Error)?.message || String(e) });
        }
        break;
      }

      case "ccswitchImport": {
        const scan = this.ccScan;
        const picks = Array.isArray(msg.picks) ? (msg.picks as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n)) : [];
        if (!scan || !picks.length) {
          this.toast("error", "没有可导入的条目");
          break;
        }
        const list = getProviders();
        const names = new Set(list.map((p) => p.name));
        let added = 0;
        let models = 0;
        for (const idx of picks) {
          const c = scan.candidates[idx];
          if (!c) {
            continue;
          }
          const p = candidateToProvider(c, freshProviderId(list), names);
          list.push(p);
          added++;
          models += p.enabledModels?.length || 0;
        }
        if (!added) {
          this.toast("error", "没有可导入的条目");
          break;
        }
        await this.persist(list, `已从 CC Switch 导入 ${added} 个 provider${models ? `，${models} 个模型已进入 Kiro 列表` : ""}`);
        this.post({ type: "ccswitchDone", added });
        break;
      }

      case "duplicateProvider": {
        // 创建副本：整份配置照抄（含 Key / 已选模型 / 能力覆盖 / 映射），紧跟在原条目后面，
        // 默认不启用——副本通常是为了改个格式或换个 Key 试，别一上来就和原件抢同名模型的路由。
        const id = String(msg.id);
        const list = getProviders();
        const idx = list.findIndex((x) => x.id === id);
        const src = list[idx];
        if (!src) {
          this.toast("error", "provider 不存在");
          break;
        }
        const names = new Set(list.map((x) => x.name));
        let name = `${src.name} 副本`;
        for (let n = 2; names.has(name); n++) {
          name = `${src.name} 副本 ${n}`;
        }
        const copy: ProviderConfig = {
          ...src,
          id: freshProviderId(list),
          name,
          enabled: false,
          credentials: src.credentials ? src.credentials.map((c) => ({ ...c })) : undefined,
          modelMapping: src.modelMapping ? { ...src.modelMapping } : undefined,
          modelOverrides: src.modelOverrides ? JSON.parse(JSON.stringify(src.modelOverrides)) : undefined,
          enabledModels: src.enabledModels ? [...src.enabledModels] : src.enabledModels,
        };
        list.splice(idx + 1, 0, copy);
        // 登录类：副本共用同一批账号的凭据（各自独立刷新，互不影响）。
        if (isOAuthProvider(src)) {
          for (const c of credentialsOf(src)) {
            copyToken(tokenKeyOf(src.id, c.id), tokenKeyOf(copy.id, c.id));
          }
        }
        await this.persist(list, `已创建「${name}」（未启用），在「编辑」里改好后再打开`);
        break;
      }

      case "oauthStart": {
        // 第三方账号登录：新建（无 providerId）或给既有 provider 重新登录。进度用 oauthStatus 逐步推给弹窗。
        const vendor = getVendor(String(msg.vendor));
        if (!vendor) {
          this.toast("error", "未知的登录厂商");
          break;
        }
        const targetId = typeof msg.providerId === "string" && msg.providerId ? msg.providerId : undefined;
        // credentialId："new" = 往既有 provider 的池里再登一个账号；cN = 给池里那一把重新登录；缺省 = 首条
        const credArg = typeof msg.credentialId === "string" && msg.credentialId ? msg.credentialId : PRIMARY_CREDENTIAL_ID;
        // mode：厂商有多种登录方式时（Kiro 官方 5 种授权方式：oauth / import / access_token / json / api_key 等）
        const mode = typeof msg.mode === "string" ? (msg.mode as LoginMode) : undefined;
        const input = msg.input && typeof msg.input === "object" ? (msg.input as Record<string, string>) : undefined;
        const sessionId = startLogin({
          vendor: vendor.id,
          mode,
          input,
          // 登录页也直接用系统浏览器开：用户刚点了「开始登录」，不必再被 Kiro 问一遍
          openUrl: (url) => void openInBrowser(url),
          // 每条进度都带上 provider id（重新登录=既有的；新建=onToken 里刚创建的），弹窗据此接着选模型。
          onStatus: (s: LoginStatus) =>
            this.post({ type: "oauthStatus", ...s, providerId: targetId ?? this.oauthCreated.get(s.sessionId) }),
          onToken: async (tok) => {
            if (targetId) {
              const list = getProviders();
              const p = list.find((x) => x.id === targetId);
              if (!p) {
                throw new Error("provider 已不存在");
              }
              if (credArg === "new") {
                // 同一个账号不重复入池（按 accountId / email 认；Kiro 官方导入还按 refresh token 认——同一份本机登录态导两次）
                const dup = credentialsOf(p).find((c) => {
                  const t = getTokenFor(p.id, c.id);
                  return (
                    t &&
                    ((tok.accountId && t.accountId === tok.accountId) ||
                      (tok.email && t.email === tok.email) ||
                      (tok.refreshToken && t.refreshToken === tok.refreshToken))
                  );
                });
                if (dup) {
                  setToken(tokenKeyOf(p.id, dup.id), tok);
                  markLoggedIn(tokenKeyOf(p.id, dup.id));
                  clearCooldown(p.id, dup.id);
                  await this.persist(list, `这个账号已在「${p.name}」的池里，已刷新其登录`, true);
                  return;
                }
                const cred = addCredential(p, { label: tok.email || undefined });
                setToken(tokenKeyOf(p.id, cred.id), tok);
                markLoggedIn(tokenKeyOf(p.id, cred.id));
                await this.persist(list, `「${p.name}」已加入账号${tok.email ? " " + tok.email : ""}（池内 ${credentialsOf(p).length} 个）`, true);
                return;
              }
              const key = tokenKeyOf(targetId, credArg);
              setToken(key, tok);
              markLoggedIn(key);
              clearCooldown(targetId, credArg);
              // 登录回来 provider 从"不可用"变"可用"，模型合并列表要重算。
              await this.persist(list, `「${p.name}」已重新登录${tok.email ? "：" + tok.email : ""}`, true);
              return;
            }
            const list = getProviders();
            const created = providerFromOAuthVendor(vendor.id, list, tok.email);
            setToken(created.id, tok);
            markLoggedIn(created.id);
            list.push(created);
            this.oauthCreated.set(sessionId, created.id);
            await this.persist(list, `已登录 ${vendor.name}${tok.email ? "（" + tok.email + "）" : ""}，勾选要用的模型`);
          },
        });
        this.post({ type: "oauthSession", sessionId, vendor: vendor.id, providerId: targetId });
        break;
      }

      case "oauthCancel": {
        cancelLogin(String(msg.sessionId || ""));
        break;
      }

      case "refresh":
        void this.refresh();
        break;

      // 「添加模型」弹窗打开时：过了 60s 缓存的渠道重拉一遍，候选池不落后于上游新增的模型
      case "refreshSoft":
        void this.refresh(false);
        break;

      case "refreshCatalog":
        void refreshCatalog(true).then((ok) => {
          this.toast(ok ? "ok" : "error", ok ? `能力目录已更新（${catalogSize()} 个模型）` : "目录更新失败，稍后重试");
          this.postState();
        });
        break;

      case "pickLocalJsonFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "导入凭证 JSON",
          title: "选择 Kiro 凭证 JSON 文件（kiro-auth-token.json 或工具导出的凭据）",
          filters: { "JSON 文件": ["json"], "所有文件": ["*"] },
        });
        if (picked && picked[0]) {
          try {
            const content = await fs.promises.readFile(picked[0].fsPath, "utf8");
            this.post({ type: "pickedJsonContent", content, filename: path.basename(picked[0].fsPath) });
          } catch (e) {
            this.toast("error", "读取文件失败：" + ((e as Error)?.message || String(e)));
          }
        }
        break;
      }

      case "openLog":
        await vscode.commands.executeCommand("api2kiroDual.openLog");
        break;

      case "openExternal": {
        // 面板里已经确认过一次，这里直接交给系统浏览器，不再经 Kiro 的外部网站确认框
        const url = String(msg.url || "");
        if (isHttpUrl(url)) {
          const ok = await openInBrowser(url);
          if (!ok) {
            this.toast("error", "没能打开浏览器，链接已复制到剪贴板");
            await vscode.env.clipboard.writeText(url);
          }
        }
        break;
      }

      case "checkUpdate":
        // 设置页「检查更新」：手动查 GitHub 最新 Release，结果用面板 toast 反馈
        await checkForUpdate(this.context, { manual: true, toast: (k, m) => this.toast(k, m) });
        break;

      case "copyText": {
        // 面板内「复制链接」：走剪贴板，不触发 Kiro 的外部网站确认
        const text = String(msg.text || "");
        if (text) {
          await vscode.env.clipboard.writeText(text);
          this.toast("ok", "已复制到剪贴板");
        }
        break;
      }

      case "selectModel": {
        // 模型页点选 = 设为 Kiro 当前模型。走 Kiro 自己选择器用的同一条命令
        // （kiro.agentModels.setLastSelectedModel，写入其 globalState 的「上次选中」），
        // 新会话即以此为默认；已开着的会话仍按其会话内选择。
        const modelId = String(msg.modelId || "").trim();
        if (!modelId) {
          break;
        }
        try {
          await vscode.commands.executeCommand("kiro.agentModels.setLastSelectedModel", { modelId });
          await this.context.globalState.update("ui.selectedModel", modelId);
          // 带渠道限定的 id 提示里写成「模型（渠道）」，不把 @p3 这种内部写法露给用户
          const q = splitQualifiedModelId(modelId);
          const owner = q.providerId ? getProviders().find((p) => p.id === q.providerId) : undefined;
          this.toast("ok", `已把 ${q.modelId}${owner ? `（${owner.name}）` : ""} 设为预选，新会话将使用它`);
        } catch (e) {
          this.toast("error", "设置失败：" + ((e as Error)?.message || String(e)));
        }
        this.postState();
        break;
      }

      case "setUsageRange": {
        const r = String(msg.range || "today");
        this.usageRange = r === "7d" || r === "30d" || r === "all" ? r : "today";
        this.postUsage();
        break;
      }

      case "refreshUsage":
        this.postUsage();
        break;

      case "clearUsage": {
        const ok =
          msg.confirmed === true
            ? "清空"
            : await vscode.window.showWarningMessage("清空本地用量统计？这会删除全部请求记录与汇总，不可恢复。", { modal: true }, "清空");
        if (ok === "清空") {
          await clearUsage();
          this.toast("ok", "已清空用量统计");
          this.postUsage();
        }
        break;
      }

      // ---------- Provider 探测：测延迟 / 拉模型 / 测活（针对表单草稿，不落盘） ----------
      case "probeLatency": {
        const d = this.draftFrom(msg.draft);
        const reqId = String(msg.reqId || "");
        if (!d) {
          this.post({ type: "probeResult", kind: "latency", reqId, ok: false, error: "请先填地址和 Key" });
          break;
        }
        const r = await measureLatency(d);
        this.post({ type: "probeResult", kind: "latency", reqId, ...r });
        break;
      }

      case "probeModels": {
        const d = this.draftFrom(msg.draft);
        const reqId = String(msg.reqId || "");
        if (!d) {
          this.post({ type: "probeResult", kind: "models", reqId, ok: false, models: [], error: "请先填地址和 Key" });
          break;
        }
        const r = await probeModels(d);
        this.post({ type: "probeResult", kind: "models", reqId, ...r });
        // 给已连接 provider 刷出来的清单直接灌进模型缓存并重算候选池：不用等缓存过期，
        // 「添加模型」里马上就搜得到新模型；路由表（同名模型归属）也同步更新。
        if (d.providerId && r.ok && r.models && r.models.length) {
          const p = getProviders().find((x) => x.id === d.providerId);
          if (p) {
            seedProviderModels(p, r.models);
            void fetchAllModels(false).catch(() => undefined);
            void this.refresh(false);
          }
        }
        break;
      }

      case "testModels": {
        const d = this.draftFrom(msg.draft);
        const batchId = String(msg.batchId || "");
        const ids = Array.isArray(msg.modelIds) ? (msg.modelIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
        if (!d || !ids.length) {
          this.post({ type: "modelTestDone", batchId, error: !d ? "请先填地址和 Key" : "没有要测的模型" });
          break;
        }
        this.cancelBatch(batchId);
        const handle = testModels(d, ids, (r, index, total) => {
          this.post({ type: "modelTest", batchId, index, total, ...r });
        });
        this.batches.set(batchId, handle);
        void handle.done.then(() => {
          if (this.batches.get(batchId) === handle) {
            this.batches.delete(batchId);
            this.post({ type: "modelTestDone", batchId });
          }
        });
        break;
      }

      case "cancelTests": {
        this.cancelBatch(String(msg.batchId || ""));
        break;
      }

      // ---------- 提示词（用户侧 system 提示词） ----------
      case "savePrompt": {
        try {
          const saved = await savePrompt({
            id: typeof msg.id === "string" && msg.id ? msg.id : undefined,
            name: String(msg.name || ""),
            description: typeof msg.description === "string" ? msg.description : "",
            content: typeof msg.content === "string" ? msg.content : "",
          });
          this.toast("ok", msg.id ? `已保存「${saved.name}」` : `已添加「${saved.name}」`);
        } catch (e) {
          this.toast("error", "保存失败：" + ((e as Error)?.message || String(e)));
        }
        this.postPrompts();
        break;
      }

      case "setPromptEnabled": {
        const id = String(msg.id || "");
        try {
          await setPromptEnabled(id, !!msg.enabled);
          const p = getPrompt(id);
          this.toast("ok", msg.enabled ? `已启用「${p?.name}」，下一次请求起注入` : `已停用「${p?.name}」`);
        } catch (e) {
          this.toast("error", (e as Error)?.message || String(e));
        }
        this.postPrompts();
        break;
      }

      case "deletePrompt": {
        const id = String(msg.id || "");
        const p = getPrompt(id);
        if (!p) {
          break;
        }
        if (p.enabled) {
          this.toast("error", "已启用的提示词不能删除，请先停用");
          break;
        }
        const ok =
          msg.confirmed === true
            ? "删除"
            : await vscode.window.showWarningMessage(`确定要删除提示词「${p.name}」吗？内容不可恢复。`, { modal: true }, "删除");
        if (ok === "删除") {
          try {
            await deletePrompt(id);
            this.toast("ok", `已删除「${p.name}」`);
          } catch (e) {
            this.toast("error", (e as Error)?.message || String(e));
          }
        }
        this.postPrompts();
        break;
      }
    }
  }

  /**
   * webview 表单草稿 → 探测用的 ProviderDraft。Key 留空但带 id（编辑已有 provider）时用已保存的 Key，
   * 这样在设置弹窗里不用重新贴 Key 就能测。地址或 Key 缺一返回 undefined。
   */
  private draftFrom(raw: unknown): ProviderDraft | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const r = raw as Record<string, unknown>;
    const existing = typeof r.id === "string" && r.id ? getProviders().find((p) => p.id === r.id) : undefined;
    const baseUrl = (typeof r.baseUrl === "string" && r.baseUrl.trim()) || existing?.baseUrl || "";
    const format =
      r.format === "anthropic" || r.format === "chat" || r.format === "responses"
        ? r.format
        : existing
        ? apiFormatOf(existing)
        : "chat";
    // 探测池里的哪一把：草稿指定 credentialId，缺省首条
    const credId = (typeof r.credentialId === "string" && r.credentialId) || PRIMARY_CREDENTIAL_ID;
    // 登录类 provider：没有 Key，凭据按 provider id + 凭证 id 从 token 仓取；地址/格式固定用已保存的。
    if (existing && isOAuthProvider(existing)) {
      return {
        name: existing.name,
        baseUrl: existing.baseUrl,
        apiKey: "",
        format: apiFormatOf(existing),
        anthropicMode: existing.anthropicMode || "official",
        oauthVendor: existing.oauthVendor,
        providerId: existing.id,
        credentialId: credId,
      };
    }
    const saved = existing ? credentialsOf(existing).find((c) => c.id === credId)?.apiKey : undefined;
    const apiKey = (typeof r.apiKey === "string" && r.apiKey.trim()) || saved || "";
    if (!baseUrl || !apiKey) {
      return undefined;
    }
    return {
      name: typeof r.name === "string" ? r.name : existing?.name,
      baseUrl,
      apiKey,
      format,
      anthropicMode: r.anthropicMode === "official" ? "official" : existing?.anthropicMode || "kiro",
      presetId: (typeof r.presetId === "string" && r.presetId) || existing?.presetId || undefined,
      // 已连接 provider 的草稿带上它的 id：探测到的模型清单可以直接回灌它的缓存
      providerId: existing?.id,
      credentialId: credId,
    };
  }

  private cancelBatch(batchId: string): void {
    const h = this.batches.get(batchId);
    if (h) {
      h.cancel();
      this.batches.delete(batchId);
    }
  }

  /** 推「提示词」页数据：全部条目（含内容，编辑弹窗要用）+ 当前启用的 id。 */
  private postPrompts(): void {
    const prompts = listPrompts();
    const active = prompts.find((p) => p.enabled);
    this.post({
      type: "prompts",
      prompts: prompts.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || "",
        content: p.content,
        enabled: p.enabled,
        updatedAt: p.updatedAt,
        chars: p.content.length,
      })),
      activeId: active?.id || "",
    });
  }

  /**
   * 推用量页数据：本地账本按当前范围算出 总览 / 按 provider（级联到模型）/ 趋势 / 最近请求。
   * 纯内存计算，零网络。
   */
  private postUsage(): void {
    const range = resolveRange(this.usageRange);
    const summary = summarize(range);
    const providers = statsByProvider(range);
    const trend = dailyTrend(range);
    const seriesTrend = getTimeSeriesTrend(this.usageRange, range);
    const stats = getUsageAnalyticsStats();
    const heatmap = getActivityHeatmap();
    const modelRatios = getModelUsageRatios(range);
    const sankey = getSankeyData(range);
    const contextBreakdown = getContextBreakdownStats(range);
    const recent = recentRecords(30, range).map((r) => ({
      ts: r.ts,
      providerName: r.providerName,
      model: r.model,
      upstreamModel: r.upstreamModel || "",
      tokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      latencyMs: r.latencyMs,
      firstTokenMs: r.firstTokenMs ?? null,
      ok: r.ok,
      status: r.status,
      error: r.error || "",
    }));
    this.post({
      type: "usage",
      range: this.usageRange,
      from: range.from,
      to: range.to,
      summary,
      providers,
      trend,
      seriesTrend,
      recent,
      stats,
      heatmap,
      modelRatios,
      sankey,
      contextBreakdown,
    });
  }

  /** 某 provider 上游全部模型的 base id（去重），用于"全选"和把 undefined 物化成显式列表。 */
  private async allBaseIds(p: ProviderConfig): Promise<string[]> {
    const models = await fetchProviderModels(p, false).catch(() => []);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      const b = baseModelId(m.id);
      const k = b.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(b);
      }
    }
    return out;
  }

  /**
   * 把注册表写回去，然后刷新面板。
   *
   * `light=true` 用于只改了本地选择（勾选/取消模型、能力覆盖、设为默认）的场景：
   * 上游的模型列表没有变，**不重拉** /models，直接用缓存重算派生数据推给 webview。
   * 这是勾选响应从"秒级"回到"即时"的关键——之前一次勾选会触发 3 轮全量上游拉取
   * （persist 里一轮、fetchAllModels 一轮、settings 变更回调再一轮）加两次用量查询。
   *
   * 改了地址/Key/协议/启停/增删 provider 才走 `light=false` 全量刷新。
   */
  private async persist(list: ProviderConfig[], okMsg: string, light = false): Promise<void> {
    // 标记：接下来那次 onDidChangeConfiguration 回调是我们自己写的，别再全量刷新一遍。
    // 通道 A 的结果也在这里登记（写 settings 之前就建好 promise）：不管配置回调先到还是 persist 先跑完，
    // extension.ts 拿到的都是「这一次变更」的刷新结果，用它决定要不要提示重载，而不再自己刷第二次。
    this.selfWriteUntil = Date.now() + 1500;
    let settleChannelA!: (ok: boolean) => void;
    this.channelA = new Promise<boolean>((resolve) => (settleChannelA = resolve));
    const r = await saveProviders(list);
    if (r.ok) {
      this.toast("ok", okMsg);
    } else {
      error("provider 未写入 Kiro 设置,已本地兜底:", r.error || "");
      this.toast("error", "已本地保存并生效；但未写入 Kiro 设置:" + (r.error || "未知错误"));
    }
    this.postState();
    // 方案 1（通道 A）：模型列表变动后，静默通知 Kiro 刷新当前会话与模型选择器，无需手动 Reload Window
    void vscode.commands
      .executeCommand<boolean>("api2kiroDual.refreshActiveSession")
      .then((ok) => settleChannelA(ok === true), () => settleChannelA(false));
    if (light) {
      // 路由表要跟勾选走（CPS 广播 / KRS 路由都读 mergedCache），但只重算不重拉。
      void fetchAllModels(false).catch(() => undefined);
      void this.refresh(false);
      return;
    }
    void fetchAllModels(true).catch(() => undefined);
    void this.refresh(true);
  }

  /** 我们自己写 settings 的时间窗，期间到来的配置变更回调不再触发全量刷新。 */
  private selfWriteUntil = 0;
  /** 最近一次 persist 触发的通道 A 刷新结果（true = Kiro 已静默刷新，不必提示重载）。 */
  private channelA: Promise<boolean> = Promise.resolve(false);

  /** 外部（extension.ts 的 onDidChangeConfiguration）调用：是否是面板自己刚写的。 */
  isSelfWrite(): boolean {
    return Date.now() < this.selfWriteUntil;
  }

  /** 外部调用：面板刚写 settings 时那次通道 A 的结果；不在自写窗口内返回 undefined（由调用方自己触发刷新）。 */
  channelAResult(): Promise<boolean> | undefined {
    return this.isSelfWrite() ? this.channelA : undefined;
  }

  postAll(): void {
    this.postState();
    this.postUsage();
    this.postPrompts();
    void this.refresh(true);
  }

  /** 只推派生数据（模型清单/计数），全走缓存、不发任何 HTTP。 */
  postDerived(): void {
    this.postState();
    void this.refresh(false);
  }

  private postState(): void {
    const ports = this.getPorts();
    const providers = getProviders().map((p) => {
      const oauth = isOAuthProvider(p);
      const st = oauth ? oauthState(p) : undefined;
      const vendor = oauth ? getVendor(p.oauthVendor) : undefined;
      // key 池：每把凭证的配置 + 运行态（冷却 / 计数），编辑弹窗与行副标题用
      const runtimes = new Map(credentialRuntimes(p).map((r) => [r.credentialId, r] as const));
      const totals = new Map(credentialTotals(p.id).map((t) => [t.credentialId, t] as const));
      const pool = poolStatus(p);
      const credentials = credentialsOf(p).map((c, i) => {
        const rt = runtimes.get(c.id);
        const tt = totals.get(c.id);
        const cst = oauth ? oauthState(p, c.id) : undefined;
        return {
          id: c.id,
          label: credentialLabel(c),
          customLabel: c.label || "",
          priority: c.priority,
          enabled: c.enabled,
          configured: isCredentialConfigured(p, c),
          maskedKey: oauth ? "" : maskKey(c.apiKey || ""),
          account: cst?.token?.email || "",
          plan: cst?.token?.plan || "",
          loginState: cst?.state || "",
          cooldownUntil: rt?.cooldownUntil || 0,
          cooldownReason: rt?.cooldownReason ? reasonText(rt.cooldownReason) : "",
          lastError: rt?.lastError || "",
          requests: tt?.requests || 0,
          failures: tt?.failures || 0,
          tokens: tt?.tokens || 0,
          lastTs: tt?.lastTs || 0,
        };
      });
      return {
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        anthropicMode: p.anthropicMode || "kiro",
        openaiApi: p.openaiApi || "chat",
        format: apiFormatOf(p),
        baseUrl: p.baseUrl,
        hasKey: oauth ? st?.state === "ok" : !!p.apiKey,
        maskedKey: oauth ? "" : maskKey(p.apiKey),
        enabled: p.enabled,
        usable: isProviderUsable(p),
        credentials,
        poolStrategy: p.poolStrategy || "priority",
        poolSize: pool.total,
        poolCooling: pool.cooling,
        defaultModel: p.defaultModel || "",
        presetId: p.presetId || "",
        // 头像：手选优先（glyph:xxx），否则自动认出的厂商标；空串 → 前端画首字母
        iconId: providerIconId(p),
        icon: normalizeIcon(p.icon) || "",
        autoIconId: autoIconId(p),
        // 登录类：厂商 / 账号 / 登录状态（ok=正常；expired=刷新被拒需重新登录；missing=从未登录）
        auth: oauth ? "oauth" : "key",
        oauthVendor: p.oauthVendor || "",
        vendorName: vendor?.name || "",
        account: st?.token?.email || "",
        plan: st?.token?.plan || "",
        loginState: st?.state || "",
        loginError: st?.error || "",
      };
    });
    this.post({
      type: "state",
      enabled: isEnabled(),
      providers,
      // 内置预设 + models.dev 目录衍生的（OpenCode / Kilo 那一长串），已排好序：热门在前
      presets: allPresets().map((p: Preset) => ({
        id: p.id,
        name: p.name,
        blurb: p.blurb,
        protocol: p.protocol,
        format: apiFormatOf({ protocol: p.protocol, openaiApi: p.openaiApi }),
        anthropicMode: p.anthropicMode || "",
        baseUrl: p.baseUrl,
        keyHint: p.keyHint,
        docsUrl: p.docsUrl || "",
        popular: !!p.popular,
        source: p.source || "builtin",
        modelCount: p.modelCount || 0,
        iconId: presetIconId(p),
      })),
      // 可登录的厂商（「第三方登录直连」分组）
      oauthVendors: OAUTH_VENDORS.map((v) => ({
        id: v.id,
        name: v.name,
        blurb: v.blurb,
        flow: v.flow,
        loginModes: v.loginModes || [],
        official: !!v.official,
        callbackPort: v.callbackPort || 0,
        signupUrl: v.signupUrl || "",
        signupLabel: v.signupLabel || "",
        modelCount: v.models.length,
        iconId: vendorIconId(v.id),
      })),
      catalogSize: catalogSize(),
      krsPort: ports.krsPort,
      cpsPort: ports.cpsPort,
      selectedModel: this.context.globalState.get<string>("ui.selectedModel", "") || "",
    });
  }

  /**
   * 各 provider 模型清单（含能力判定）推给 webview。
   * `force=false`：模型列表走 60s 缓存（命中则零网络）。
   */
  async refresh(force = true): Promise<void> {
    const providers = getProviders().filter((p) => p.enabled && isProviderUsable(p));
    const seq = ++this.refreshSeq;
    // image / reasoning 是最终判定（用户覆盖 > 厂商目录 > models.dev；null=没人知道）；
    // autoImage / autoReasoning 是不算用户覆盖时的判定——编辑弹窗的「自动」标签要把它显示出来，
    // 否则用户看到一个灰色「自动」不知道系统到底认为它支不支持。
    type ModelRow = {
      id: string; kiroId: string; name: string; enabled: boolean;
      image: boolean | null; reasoning: boolean | null;
      autoImage: boolean | null; autoReasoning: boolean | null;
      /** 「自动」判定是谁给的：vendor（厂商表）/ upstream（上游 /models 声明）/ catalog（models.dev）/ none */
      imageSource: string; reasoningSource: string;
      override: unknown;
    };
    /** 每个 provider 拉到的清单；null = 拉失败；没有键 = 还没回来 */
    const results = new Map<string, RelayModel[] | null>();

    // 「自动」那一档的判定是谁给的（跳过用户覆盖）
    const autoSource = (field: "image" | "reasoning", base: string, pid: string): string => capabilitySource(field, base, pid, true);
    const rowsOf = (p: ProviderConfig, list: RelayModel[]): ModelRow[] => {
      // 每个模型带上：是否已勾进 Kiro（enabled）、「图片/推理」判定值、能力覆盖。
      // 按 base id 去重——选择器里 -effort 变体折叠成一个模型，这里也一行代表一族。
      const seen = new Set<string>();
      const rows: ModelRow[] = [];
      for (const rm of list) {
        const base = baseModelId(rm.id);
        if (seen.has(base)) {
          continue;
        }
        seen.add(base);
        rows.push({
          id: base,
          kiroId: base,
          name: rm.name && rm.name !== rm.id ? rm.name : base,
          enabled: isModelEnabled(p, base),
          image: resolveModelImage(base, p.id) ?? null,
          reasoning: resolveModelReasoning(base, p.id) ?? null,
          autoImage: resolveModelImage(base, p.id, true) ?? null,
          autoReasoning: resolveModelReasoning(base, p.id, true) ?? null,
          imageSource: autoSource("image", base, p.id),
          reasoningSource: autoSource("reasoning", base, p.id),
          override: (p.modelOverrides && p.modelOverrides[base]) || null,
        });
      }
      // 已勾的排前面，同组内按 id 排；用户先看到自己选了什么。
      rows.sort((a, b) => (a.enabled === b.enabled ? a.id.localeCompare(b.id) : a.enabled ? -1 : 1));
      // 不再按 400 截断：OpenRouter 已经 400+ 个，按 id 排在后面的会被整段切掉，「添加模型」里怎么搜都搜不到。
      return rows.slice(0, 5000);
    };

    /** 还没回来 / 拉失败的渠道：先用它勾选的模型 id 顶上，至少 Kiro 列表那一页不缺东西。 */
    const stubRows = (p: ProviderConfig): ModelRow[] =>
      rowsOf(
        p,
        (p.enabledModels || []).filter((id) => id && id.trim()).map((id) => ({ id, name: id, providerId: p.id, protocol: p.protocol }))
      );

    const publish = (): void => {
      if (seq !== this.refreshSeq) {
        return; // 已有更新的一轮刷新在跑，别用旧数据盖新数据
      }
      const counts: Record<string, { total: number; enabled: number } | null> = {};
      const modelsByProvider: Record<string, ModelRow[]> = {};
      for (const p of providers) {
        const got = results.get(p.id);
        if (got && got.length) {
          const rows = rowsOf(p, got);
          counts[p.id] = { total: rows.length, enabled: rows.filter((r) => r.enabled).length };
          modelsByProvider[p.id] = rows;
        } else {
          counts[p.id] = null;
          modelsByProvider[p.id] = stubRows(p);
        }
      }
      // 每行在 Kiro 那边的 id：同名模型在多个渠道都勾了时，第一个渠道用原 id、其余带 @providerId
      // （与 cpsServer 广播的一致），面板「预选」就能精确指到某一渠道的那一行。
      const enabledRows: Array<{ row: ModelRow; providerId: string }> = [];
      for (const p of providers) {
        for (const row of modelsByProvider[p.id] || []) {
          if (row.enabled) {
            enabledRows.push({ row, providerId: p.id });
          }
        }
      }
      const ids = kiroModelIds(enabledRows.map((e) => ({ id: e.row.id, providerId: e.providerId })));
      enabledRows.forEach((e, i) => {
        e.row.kiroId = ids[i];
      });
      this.post({ type: "models", counts, modelsByProvider });
    };

    // 二三十个渠道并发拉；不等最慢的那个——预算一到先发一版（慢的渠道用勾选的 id 顶上），
    // 剩下的回来后再发一版完整的。否则一个挂住的中转就能让整页"空"上半分钟。
    const tasks = providers.map((p) =>
      fetchProviderModels(p, force).then(
        (m) => {
          results.set(p.id, Array.isArray(m) ? m : []);
        },
        () => {
          results.set(p.id, null);
        }
      )
    );
    const all = Promise.all(tasks);
    await Promise.race([all, new Promise<void>((r) => setTimeout(r, REFRESH_BUDGET_MS))]);
    publish();
    if (results.size < providers.length) {
      void all.then(publish);
    }
    // 用量页不再依赖上游接口，由本地账本 postUsage() 单独推送。
  }
  /** 递增的刷新序号：晚到的旧一轮结果不能盖掉新一轮。 */
  private refreshSeq = 0;

  private toast(level: "ok" | "error", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  /** assets/<sub> 里有哪些 SVG（文件名 = 图标 id）。目录读不到就当没有，前端退回首字母头像。 */
  private svgIds(sub: string): string[] {
    return Object.keys(this.iconFiles(sub, ["svg"]));
  }

  /**
   * assets/<sub> 里的图标文件：id → 扩展名。厂商标既有 SVG（OpenCode / lobe 的矢量）也有 PNG
   * （从官网 favicon 抠出来的透明剪影），同名时 SVG 优先。前端按扩展名拼 URL，都当 mask 用。
   */
  private iconFiles(sub: string, exts: string[] = ["svg", "png"]): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const dir = vscode.Uri.joinPath(this.context.extensionUri, "assets", sub).fsPath;
      for (const f of readdirSync(dir)) {
        const m = /^(.+)\.([a-z0-9]+)$/i.exec(f);
        if (!m || !exts.includes(m[2].toLowerCase())) {
          continue;
        }
        const id = m[1], ext = m[2].toLowerCase();
        if (!out[id] || exts.indexOf(ext) < exts.indexOf(out[id])) {
          out[id] = ext;
        }
      }
    } catch {
      /* 目录读不到 → 没有图标 */
    }
    return out;
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const version = String(this.context.extension.packageJSON.version || "");
    // GitHub Octicon mark（单色，随主题 currentColor）
    const ghSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="vertical-align:-2px;margin-right:5px;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
    // img-src 只给 webview 自己的资源域：厂商图标 / 头像线稿以 CSS mask-image 引用 assets/**.svg
    const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const assetUri = (sub: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "assets", sub)).toString();
    const iconBase = assetUri("providers");
    const iconFiles = JSON.stringify(this.iconFiles("providers"));
    const glyphBase = assetUri("glyphs");
    // CC Switch 官方标（彩色 PNG，透明底，MIT，仅用于指代该软件）：导入按钮与导入弹窗标题栏都用 <img> 原色显示
    const ccLogo = assetUri("ccswitch.png");
    // 头像线稿按策划好的顺序（光与天象 → 自然 → 机器 → 出行 → 安全/开发 → 灵感 → 形与物），目录里没有的跳过
    const have = new Set(this.svgIds("glyphs"));
    const glyphIds = JSON.stringify(GLYPH_ORDER.filter((g) => have.has(g)));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground, #8b8b8b);
    --card: var(--vscode-editorWidget-background, #1e1e1e);
    --card2: var(--vscode-editor-background, #181818);
    --border: var(--vscode-panel-border, #333);
    /* 主色：荧光紫。不再跟 Kiro 主题的按钮紫（偏暗沉）走，面板有自己的一套霓虹调：
       --accent 做实色填充（Tab/按钮/开关/胶囊），--accent-rgb 拿去调各种半透明底与光晕，
       --accent-edge 是光晕描边用的更亮一档的霓虹边。 */
    --accent: #a66cff;
    --accent-fg: #fff;
    --accent-hover: #b98aff;
    --accent-rgb: 166,108,255;
    --accent-edge: 210,190,255;
    /* 黄昏色系（运行中徽章用）：琥珀 / 玫红，往主题紫过渡 */
    --dusk-amber: 255,170,80;
    --dusk-rose: 255,110,150;
    --ghost-bg: var(--vscode-button-secondaryBackground, rgba(255,255,255,.06));
    --ghost-fg: var(--vscode-button-secondaryForeground, var(--fg));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); padding: 10px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .3px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .cardhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }

  /* 顶栏开关右侧/包裹器 */
  .switch-wrap { display:inline-flex; align-items:center; gap:6px; flex:none; }
  .switch-lbl { font-size:12px; font-weight:700; color:var(--muted); transition:color .2s; white-space:nowrap; }
  .switch-lbl.on { color:rgb(var(--accent-edge)); text-shadow:0 0 8px rgba(var(--accent-rgb),.5); }

  /* 顶栏阶梯响应式收缩 */
  .hdr .title-text { white-space:nowrap; flex:none; }
  @container (max-width: 360px) {
    .hdr .title-text { display:none; } /* ① 优先隐藏 API4Kiro 标题 */
  }
  @container (max-width: 290px) {
    .switch-lbl { display:none; } /* ② 其次隐藏「开启代理」文字 */
  }
  @container (max-width: 230px) {
    .badge .bi .lbl { display:none !important; } /* ③ 再其次压缩提供商&模型文字只留logo和数字 */
    .hdr .badge.badge-on { padding:1px 4px; }
  }
  .prov { border: 1px solid var(--border); border-radius: 9px; margin-bottom: 8px; overflow: hidden; border-left: 3px solid var(--border); background: var(--card2); }
  .prov.on { border-left-color: var(--green); }
  .prow { display: flex; align-items: center; gap: 9px; padding: 9px 10px; cursor: pointer; }
  .prow:hover { background: rgba(255,255,255,.03); }
  .pdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
  .pdot.ok { background: var(--green); box-shadow: 0 0 6px rgba(63,185,80,.5); }
  .pdot.idle { background: var(--yellow); box-shadow: 0 0 6px rgba(210,153,34,.5); }
  .pdot.off { background: var(--red); box-shadow: 0 0 6px rgba(248,81,73,.5); }
  /* Provider 首字母 logo：荧光紫——亮紫字、实一点的紫底、一圈细描边加柔光，深色底上也跳得出来 */
  /* 头像基座：统一一套霓虹线条感——不填底色，只有荧光紫的线 + 光晕（光晕用 filter 打在外层，贴着形状走） */
  .picon { width: 22px; height: 22px; border-radius: 50%; flex:none; display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; color: rgb(var(--accent-edge)); background:transparent; filter: drop-shadow(0 0 2px rgba(var(--accent-rgb),.95)) drop-shadow(0 0 6px rgba(var(--accent-rgb),.55)); }
  /* 首字母 monogram：一圈细环 + 一个字母，环和字同色同光，像霓虹灯管弯出来的 */
  .picon.mono { border:1.5px solid rgba(var(--accent-edge),.9); font-size:11px; font-weight:700; line-height:1; letter-spacing:0; font-family: ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif; }
  /* 厂商原标 / 手选线稿：SVG 当 alpha 蒙版，颜色由底色给 */
  .picon.logo .pmask { display:block; width:82%; height:82%; background: rgb(var(--accent-edge)); -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-position:center; mask-position:center; -webkit-mask-size:contain; mask-size:contain; }
  .picon.logo.glyph .pmask { width:78%; height:78%; }
  /* 彩色位图标（CC Switch 官方标）：不套霓虹处理，原色显示 */
  .picon.img { background:transparent; border:none; box-shadow:none; filter:none; }
  .picon.img img { width:100%; height:100%; object-fit:contain; display:block; }
  /* 按钮里的 CC Switch 官方彩标：原色 <img>，按钮底色改成深青，好让橙 / 黄 / 青三色的星芒标立得住 */
  .btn .ico .cclogo { width:18px; height:18px; display:block; object-fit:contain; }
  /* 统一占位标（没有官方标的厂商）：同一色系但收一档亮度，别抢真标的风头 */
  .picon.logo.generic .pmask { background:rgba(var(--accent-edge),.78); }
  .picon.logo.generic { filter: drop-shadow(0 0 2px rgba(var(--accent-rgb),.6)) drop-shadow(0 0 5px rgba(var(--accent-rgb),.3)); }
  /* 头像选择器：当前头像一条 + 线稿格子 */
  .ipick { margin-top:4px; }
  .ipick-cur { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box; padding:5px 8px; border-radius:8px; cursor:pointer; background:var(--input-bg); color:var(--fg); border:1px solid var(--input-border); font:inherit; font-size:12px; text-align:left; }
  .ipick-cur:hover { border-color:var(--accent); }
  .ipick-cur .picon { width:20px; height:20px; font-size:10px; }
  .ipick-cur .ipick-lbl { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); }
  .ipick-cur .chev { color:var(--muted); font-size:10px; flex:none; }
  .ipick-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(30px, 1fr)); gap:4px; margin-top:6px; padding:6px; border:1px solid var(--border); border-radius:8px; background:var(--card2); max-height:168px; overflow:auto; }
  .ipick-cell { display:inline-flex; align-items:center; justify-content:center; width:100%; aspect-ratio:1; box-sizing:border-box; padding:0; border-radius:7px; border:1px solid transparent; background:transparent; cursor:pointer; }
  .ipick-cell:hover { background:rgba(var(--accent-rgb),.12); }
  .ipick-cell.sel { border-color:rgba(var(--accent-rgb),.7); background:rgba(var(--accent-rgb),.16); box-shadow:0 0 8px rgba(var(--accent-rgb),.35); }
  .ipick-cell .picon { width:20px; height:20px; font-size:10px; }
  .ptitle { flex: 1; min-width: 0; }
  .ptitle .n { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ptitle .s { color: var(--muted); font-size: 11px; }
  .chev { color: var(--muted); font-size: 11px; transition: transform .15s; flex:none; }
  .prov.open .chev { transform: rotate(90deg); }
  .pbody { padding: 4px 12px 12px; border-top: 1px solid var(--border); }
  .pbody.collapsed { display: none; }
  .seg { display:flex; gap:0; border:1px solid var(--input-border); border-radius:7px; overflow:hidden; }
  .seg button { flex:1; padding:7px 6px; font-size:11px; background: var(--input-bg); color: var(--muted); border:none; cursor:pointer; }
  /* 分段切换按钮（用量范围：今天/7天/30天/全部）选中态：浅紫色半透明渐变底 + 微光描边 + 柔和光晕 */
  .seg button.sel { background:linear-gradient(135deg, rgba(166,108,255,.32) 0%, rgba(120,68,220,.24) 100%); color:#ffffff; font-weight:600; box-shadow:0 0 12px rgba(var(--accent-rgb),.32), inset 0 0 6px rgba(var(--accent-rgb),.15); text-shadow:0 0 8px rgba(var(--accent-rgb),.5); }

  /* 模型能力清单 */
  .models { margin-top: 8px; border-top:1px dashed var(--border); }
  .mline { display:flex; align-items:center; gap:6px; padding:5px 0; border-bottom:1px dashed var(--border); }
  .mline .mid { flex:1; min-width:0; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cap { display:inline-flex; align-items:center; gap:3px; font-size:10px; padding:2px 6px; border-radius:5px; cursor:pointer; border:1px solid var(--border); background: var(--input-bg); color: var(--muted); user-select:none; white-space:nowrap; flex:none; }
  /* 能力图标：推理=大脑、图片=山景相框。宽时图标+文字，窄时只留图标（见 container query）。 */
  .cap .ico { display:inline-flex; width:11px; height:11px; flex:none; }
  .cap .ico svg { width:11px; height:11px; }
  /* 能力用色：推理=琥珀橙（与选中行的紫色互补，不会混在一起），图片/多模态=青。
     绿/红只表示"支持/不支持"的判定状态（编辑弹窗里的三态标签用）。 */
  .cap.on { background: rgba(63,185,80,.16); color: var(--green); border-color: rgba(63,185,80,.4); }
  .cap.off { background: rgba(248,81,73,.12); color: var(--red); border-color: rgba(248,81,73,.35); }
  /* 自动态：整体收一档亮度；结论符号跟目录判定走——✓ 绿 / ✗ 红 / ? 灰，让人一眼看出系统认为它支不支持 */
  .cap.auto { opacity:.75; }
  .cap.auto .st { font-weight:600; }
  .cap.auto.auto-on .st { color: var(--green); }
  .cap.auto.auto-off .st { color: var(--red); }
  .cap.reason { background: rgba(255,166,87,.14); color: #ffb26b; border-color: rgba(255,166,87,.45); cursor:default; }
  .cap.vision { background: rgba(57,197,207,.14); color: #5fd4dc; border-color: rgba(57,197,207,.45); cursor:default; }
  .cap.on.reason { background: rgba(255,166,87,.2); color: #ffb26b; border-color: rgba(255,166,87,.6); cursor:pointer; }
  .cap.on.vision { background: rgba(57,197,207,.2); color: #5fd4dc; border-color: rgba(57,197,207,.6); cursor:pointer; }
  .mfoot { font-size:10px; color: var(--muted); margin-top:6px; line-height:1.5; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; gap: 8px; }
  .key { color: var(--muted); }
  .val { font-weight: 600; text-align: right; white-space: nowrap; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 7px; background: var(--input-bg); color: var(--input-fg); font-size: 13px; outline: none; }
  input:focus { border-color: var(--accent); }
  textarea { width: 100%; min-height: 180px; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 7px; background: var(--input-bg); color: var(--input-fg); font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 1.5; outline: none; resize: vertical; box-sizing: border-box; }
  textarea:focus { border-color: var(--accent); }
  /* Key 输入框：右侧眼睛切换明文 / 掩码 */
  .keywrap { position:relative; }
  .keywrap input { padding-right:34px; }
  .keywrap .eye { position:absolute; right:5px; top:50%; transform:translateY(-50%); width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:none; border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; }
  .keywrap .eye svg { width:16px; height:16px; }
  .keywrap .eye:hover { color:var(--fg); background:rgba(255,255,255,.06); }
  .keywrap .eye.on { color:var(--accent); }

  /* 下拉框：原生 select 去掉系统箭头，用 CSS 画一个（CSP default-src 'none' 不让用 data: 图片） */
  .selwrap { position:relative; }
  .selwrap select { width:100%; padding:8px 30px 8px 10px; border:1px solid var(--input-border); border-radius:7px; background:var(--input-bg); color:var(--input-fg); font-size:13px; outline:none; appearance:none; -webkit-appearance:none; cursor:pointer; }
  .selwrap select:focus { border-color:var(--accent); }
  .selwrap::after { content:''; position:absolute; right:12px; top:50%; width:7px; height:7px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:translateY(-70%) rotate(45deg); pointer-events:none; }
  .selwrap select option { background:var(--card); color:var(--fg); }

  /* 精美荧光浅紫自定义下拉框组件（替换浏览器原生刺眼蓝底弹出菜单） */
  .csel { position:relative; width:100%; user-select:none; }
  .csel-trigger { display:flex; align-items:center; justify-content:space-between; width:100%; padding:8px 12px; border:1px solid var(--input-border); border-radius:7px; background:var(--input-bg); color:var(--input-fg); font-size:13px; cursor:pointer; transition:all .15s; box-sizing:border-box; }
  .csel-trigger:hover, .csel.open .csel-trigger { border-color:rgba(var(--accent-rgb),.75); box-shadow:0 0 10px rgba(var(--accent-rgb),.25); }
  .csel-trigger .csel-label { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
  .csel-trigger .csel-arrow { width:7px; height:7px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:translateY(-2px) rotate(45deg); transition:transform .2s; flex:none; margin-left:8px; }
  .csel.open .csel-trigger .csel-arrow { transform:translateY(2px) rotate(-135deg); border-color:var(--accent); }
  .csel-menu { position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:1000; background:linear-gradient(180deg, rgba(30,22,46,.98) 0%, rgba(20,14,32,.99) 100%); border:1px solid rgba(var(--accent-edge),.6); border-radius:8px; box-shadow:0 12px 32px rgba(0,0,0,.7), 0 0 16px rgba(var(--accent-rgb),.32); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); padding:4px; max-height:220px; overflow-y:auto; display:none; }
  .csel.open .csel-menu { display:block; animation:csel-pop .15s ease-out; }
  @keyframes csel-pop { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
  .csel-opt { padding:7px 10px; border-radius:6px; font-size:12px; color:var(--fg); cursor:pointer; transition:all .12s; display:flex; align-items:center; justify-content:space-between; margin-bottom:2px; }
  .csel-opt:last-child { margin-bottom:0; }
  .csel-opt:hover { background:rgba(var(--accent-rgb),.2); color:#ffffff; }
  /* 选中的选项：浅紫色半透明荧光发光底 + 霓虹亮紫描边 + 柔和外发光晕，彻底替换刺眼系统蓝 */
  .csel-opt.sel { background:linear-gradient(135deg, rgba(166,108,255,.36) 0%, rgba(120,68,220,.28) 100%); color:#ffffff; font-weight:600; border:1px solid rgba(var(--accent-edge),.75); box-shadow:0 0 12px rgba(var(--accent-rgb),.35), inset 0 0 6px rgba(var(--accent-rgb),.18); text-shadow:0 0 6px rgba(var(--accent-rgb),.6); }

  /* Provider 探测工具：测延迟 / 拉取模型 / 测活 */
  .tools { display:flex; align-items:center; gap:6px; margin-top:10px; flex-wrap:wrap; }
  .tools .btn { flex:none; }
  /* 结果：成功/进行中紧跟按钮一行；失败原因换到按钮下面独占一行、可换行（截成省略号就没法排查了） */
  .tools .tres { flex:1 1 60px; min-width:0; font-size:11px; line-height:1.35; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tools .tres:empty { display:none; }
  .tools .tres.bad { flex:1 1 100%; order:5; white-space:normal; overflow:visible; text-overflow:clip; word-break:break-word; }
  .tools .tres.bad b { font-weight:600; opacity:.85; }
  .tres.ok { color:var(--green); } .tres.bad { color:var(--red); } .tres.run { color:var(--accent); }
  .plist { margin-top:8px; border:1px solid var(--border); border-radius:8px; max-height:min(38vh, 300px); overflow:auto; background:var(--card2); }
  .phead { display:flex; align-items:center; gap:6px; padding:6px 8px; position:sticky; top:0; background:var(--card); border-bottom:1px solid var(--border); font-size:11px; color:var(--muted); z-index:1; }
  .phead .ptitle { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .phead .btn-sm { padding:3px 8px; font-size:11px; white-space:nowrap; flex:none; }
  .phead .ck.pall { flex:none; margin-right:2px; }
  .phead .palive.done { opacity:.55; cursor:default; }
  .psearch { padding:6px 8px 2px; }
  .psearch input { padding:5px 26px 5px 8px; font-size:12px; }
  .psearch .sclear { right:12px; top:calc(50% + 2px); width:18px; height:18px; font-size:10px; }
  .prowm { display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px dashed var(--border); font-size:12px; min-width:0; }
  .prowm:last-child { border-bottom:none; }
  .prowm .ck { width:14px; height:14px; font-size:10px; }
  .prowm .pid { flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prowm .pst { flex:0 1 auto; max-width:46%; min-width:0; font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .prowm .pst.ok { color:var(--green); } .prowm .pst.bad { color:var(--red); } .prowm .pst.run { color:var(--accent); }
  /* 失败原因独占一行、可换行——截成省略号就没法排查了 */
  .prowm { flex-wrap:wrap; row-gap:3px; }
  .prowm .pst.bad { flex:1 1 100%; order:10; max-width:none; white-space:normal; overflow:visible; text-overflow:clip; word-break:break-word; line-height:1.35; }
  .prowm .psub { flex-wrap:wrap; }
  .prowm .btn-sm { flex:none; padding:2px 7px; font-size:11px; }
  .prowm.two { flex-wrap:wrap; row-gap:4px; }
  .prowm .psub { flex:1 1 100%; display:flex; align-items:center; gap:6px; min-width:0; }
  .prowm .psub .pst { flex:1 1 0; max-width:none; text-align:right; }
  .prowm.live { background:rgba(63,185,80,.06); }
  .prowm.dead { background:rgba(248,81,73,.06); }
  .pfoot { font-size:11px; color:var(--muted); padding:6px 8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .pfoot .lnk { color:var(--accent); cursor:pointer; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .spin { display:inline-block; width:10px; height:10px; border:1.5px solid rgba(var(--accent-rgb),.35); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; margin-right:4px; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border: 1px solid transparent; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn:active { transform: translateY(1px); }
  .btn-primary { background: var(--accent); color: var(--accent-fg); flex: 1; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-ghost { background: var(--ghost-bg); color: var(--ghost-fg); border-color: var(--border); }
  .btn-ghost:hover { border-color: var(--accent); }
  .btn-sm { padding: 6px 8px; font-size: 11px; }
  .btn-danger { color: var(--red); }
  .btns { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .iconbtn { background: transparent; border: 1px solid var(--border); color: var(--fg); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 13px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .iconbtn:hover { border-color: var(--accent); color: var(--accent); }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; white-space:nowrap; }
  .badge-on { background: rgba(63,185,80,.16); color: var(--green); }
  /* 运行中徽章胶囊：从左到右紫到黑渐变毛玻璃风格，整颗带荧光微光晕 */
  .badge.badge-on {
    display:inline-flex; align-items:center; padding:2px 9px; line-height:14px; font-size:10.5px; color:#ffffff;
    background:linear-gradient(90deg, rgba(166,108,255,.45) 0%, rgba(120,65,210,.30) 45%, rgba(20,14,32,.72) 100%);
    border:1px solid rgba(var(--accent-edge),.72);
    border-radius:20px;
    box-shadow:0 2px 10px rgba(0,0,0,.45), 0 0 14px rgba(var(--accent-rgb),.35), inset 0 0 8px rgba(255,255,255,.15);
    backdrop-filter:blur(10px);
    -webkit-backdrop-filter:blur(10px);
  }
  .badge .bi { display:inline-flex; align-items:center; gap:3px; margin:0; border:none; }
  .badge .bi .ico { display:inline-flex; width:11px; height:11px; flex:none; }
  .badge .bi .ico svg { width:11px; height:11px; }
  .badge .bi b { font-weight:700; font-variant-numeric:tabular-nums; }
  .badge .bi .lbl { font-weight:500; opacity:.9; }
  .badge .bi-p { color:#5eead4; text-shadow:0 0 6px rgba(94,234,212,.55); }
  .badge .bi-m { color:#fde68a; text-shadow:0 0 6px rgba(245,158,11,.45); }
  /* 两段之间一条竖向细分割线，把一个胶囊分成两格 */
  .badge .sep { display:inline-block; width:1px; height:11px; margin:0 7px; background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.45), rgba(255,255,255,.05)); flex:none; }
  .badge-off { background: rgba(248,81,73,.16); color: var(--red); }
  .badge-idle { background: rgba(210,153,34,.16); color: var(--yellow); }
  .badge-name { background: rgba(var(--accent-rgb),.16); color: var(--accent); }
  .tag { display:inline-block; padding:1px 7px; border-radius: 5px; font-size:10px; background: var(--card2); border:1px solid var(--border); color: var(--muted); }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: var(--card2); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; }
  .stat .t { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
  .stat .v { font-size: 17px; font-weight: 700; }
  .stat .v.cost { color: var(--green); }

  .bar-wrap { height: 7px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; margin: 8px 0 4px; }
  .bar { height: 100%; width: 0%; transition: width .4s; background: var(--green); }

  .mrow { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-top: 1px dashed var(--border); }
  .mrow:first-of-type { border-top: none; }
  .mname { font-weight: 600; font-size: 12px; }
  .msub { color: var(--muted); font-size: 11px; }
  .mcost { color: var(--green); font-weight: 600; font-size: 12px; }

  .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: none; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; cursor: pointer; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 12px; transition: .2s; }
  .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; top: 2px; background: var(--muted); border-radius: 50%; transition: .2s; }
  .switch input:checked + .slider { background: var(--accent); box-shadow: 0 0 8px rgba(var(--accent-rgb),.5); }
  .switch input:checked + .slider:before { transform: translateX(18px); background: var(--accent-fg); }

  select { width:100%; padding:8px 10px; border:1px solid var(--input-border); border-radius:7px; background: var(--input-bg); color: var(--input-fg); font-size:12px; }
  .big { font-size: 26px; font-weight: 700; text-align: center; }
  .muted { color: var(--muted); font-size: 11px; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .hidden { display: none !important; }
  /* 底部提示条：底色半透明 + 毛玻璃透出底下的列表，文字保持全不透明可读 */
  .toast { position: fixed; left: 10px; right: 10px; bottom: 10px; padding: 9px 12px; border-radius: 7px; color: #fff; font-size: 12px; opacity: 0; transition: .25s; pointer-events: none; text-align: center; z-index: 99; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .toast.show { opacity: 1; }
  .toast.ok { background: rgba(46,160,67,.82); } .toast.error { background: rgba(218,54,51,.82); }

  /* Kilo 式列表行：图标 + 名字/副标题 + 右侧按钮/开关 */
  .lrow { display:flex; align-items:center; gap:8px; padding:11px 0; border-bottom:1px solid var(--border); min-width:0; }
  .lrow:last-child { border-bottom:none; }
  .lrow .picon { width:24px; height:24px; flex:none; }
  .lrow .picon.mono { font-size:12px; }
  .lrow .ltext { flex:1 1 0; min-width:0; overflow:hidden; }
  .lrow .ln { font-size:13px; font-weight:600; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lrow .ls { font-size:11px; color:var(--muted); margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 副标题里的简笔画（接口格式 = 盖章文档，模型 = 芯片）：与 11px 文字同高，贴在数字/名称前 */
  .lrow .ls .lsi { display:inline-block; width:12px; height:12px; vertical-align:-2px; margin-right:3px; opacity:.85; }
  .lrow .ls .lsi svg { width:100%; height:100%; display:block; }
  .lrow .ls .lsep { opacity:.6; }
  /* 接口格式：宽面板显示全称，窄面板（≤460px，全称会挤掉模型计数）换首字母缩写 AM / GG / OCC / OR */
  .lrow .ls .fmt-abbr { display:none; letter-spacing:.3px; }
  @container (max-width: 460px) {
    .lrow .ls .fmt-full { display:none; }
    .lrow .ls .fmt-abbr { display:inline; }
  }
  /* 再窄（由 fitProviderText 按文字列可用宽度分档）：副标题只留简笔画 → 文字列只剩两三个字宽时整列文字隐藏只留 logo。悬停 logo 看名字与副标题 */
  #providers.glyphonly .lrow .ls .fmt-full, #providers.glyphonly .lrow .ls .fmt-abbr,
  #providers.glyphonly .lrow .ls .lstxt, #providers.glyphonly .lrow .ls .lsep { display:none; }
  #providers.glyphonly .lrow .ls .lsi { margin-right:0; }
  #providers.glyphonly .lrow .ls .lsg + .lsg { margin-left:7px; }
  #providers.glyphonly .lrow .ls .lsg:empty { display:none; }
  #providers.logoonly .lrow .ltext { display:none; }
  #providers.logoonly .lrow .picon { cursor:help; }
  /* 文字列没了，开关与动作按钮仍贴右边，和宽面板时同一列位置 */
  #providers.logoonly .lrow .lact { margin-left:auto; }
  .lrow .lact { display:flex; align-items:center; gap:0; flex:none; }
  .lrow .lact .switch { margin-right:4px; }
  /* 拖柄与拖拽态 */
  .grip { flex:none; width:12px; height:20px; margin-left:-4px; margin-right:-2px; display:inline-flex; align-items:center; justify-content:center; color:var(--muted); opacity:.45; cursor:grab; touch-action:none; }
  .grip svg { width:14px; height:14px; }
  .lrow:hover .grip { opacity:.9; }
  /* 拖拽排序（dnd-kit 手感）：排序中其它行的位移带 200ms 过渡；被拖行本身无过渡、跟手，
     抬起来（放大、阴影、紫描边）；松手后切到 .dropping 用过渡滑进槽位 */
  #providers.sorting .lrow { transition:transform .2s cubic-bezier(.2,.8,.2,1); }
  #providers.sorting .lrow.dragging { transition:none; }
  #providers.sorting .lrow.dropping { transition:transform .2s cubic-bezier(.2,.8,.2,1); }
  .lrow.dragging, .lrow.dropping { position:relative; z-index:5; background:var(--card); border-bottom-color:transparent; border-radius:10px; padding-left:8px; padding-right:8px; margin-left:-8px; margin-right:-8px;
    box-shadow:0 10px 28px rgba(0,0,0,.55), 0 0 0 1px rgba(var(--accent-edge),.6), 0 0 16px rgba(var(--accent-rgb),.35); }
  .lrow.dragging .grip { opacity:.9; cursor:grabbing; }
  body.nosel, body.nosel * { user-select:none !important; }
  /* 截断文字悬停滚动中：去掉省略号让末尾露出来 */
  .mq-on { text-overflow:clip !important; }
  body.grabbing, body.grabbing * { cursor:grabbing !important; }
  /* 拉伸弹窗时全局光标跟着把手方向走 */
  body[data-rz="n"] *, body[data-rz="s"] * { cursor:ns-resize !important; }
  body[data-rz="e"] *, body[data-rz="w"] * { cursor:ew-resize !important; }
  body[data-rz="ne"] *, body[data-rz="sw"] * { cursor:nesw-resize !important; }
  body[data-rz="nw"] *, body[data-rz="se"] * { cursor:nwse-resize !important; }
  /* 行尾三个纯图标动作：编辑 / 创建副本 / 测延迟。平时灰，悬停亮起；测延迟进行中转成主色 */
  .rowact { border-color:transparent; color:var(--muted); width:30px; height:30px; border-radius:7px; }
  .rowact svg { width:20px; height:20px; }
  .rowact .spin { width:14px; height:14px; min-width:14px; min-height:14px; border-width:2px; border-color:rgba(var(--accent-rgb),.3); border-top-color:var(--accent); margin:0 auto; flex:none; box-sizing:border-box; aspect-ratio:1 / 1; }
  /* 行内开关比头部总开关小一号：一行里它只是众多控件之一，不该最抢眼 */
  .lrow .switch { width:34px; height:19px; }
  .lrow .slider { border-radius:10px; }
  .lrow .slider:before { width:13px; height:13px; left:2px; top:2px; }
  .lrow .switch input:checked + .slider:before { transform:translateX(15px); }
  .rowact:hover { border-color:var(--border); color:var(--fg); background:rgba(255,255,255,.04); }
  .rowact.run { color:var(--accent); }
  .rowact[disabled] { cursor:default; }
  /* 删除：常态就是红色（和其它三个灰图标区分开），悬停红底 */
  .rowact.del { color:rgba(248,81,73,.85); }
  .rowact.del:hover { color:var(--red); border-color:rgba(248,81,73,.4); background:rgba(248,81,73,.1); }
  .lrow .ln { display:flex; align-items:center; gap:6px; min-width:0; }
  /* 名字优先：至少保住四成宽度，右侧的延迟胶囊 / 登录失效文字先让 */
  .lrow .ln .nm { flex:1 1 auto; min-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .latpill { flex:none; font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; border:1px solid var(--border); color:var(--muted); white-space:nowrap; max-width:50%; overflow:hidden; text-overflow:ellipsis; }
  .latpill.ok { color:var(--green); border-color:rgba(63,185,80,.4); background:rgba(63,185,80,.1); }
  .latpill.warn { color:var(--yellow); border-color:rgba(210,153,34,.5); background:rgba(210,153,34,.12); box-shadow:0 0 6px rgba(210,153,34,.2); }
  .latpill.bad { color:var(--red); border-color:rgba(248,81,73,.4); background:rgba(248,81,73,.08); }
  .latpill.run { color:var(--accent); border-color:rgba(var(--accent-rgb),.4); }
  /* 登录失效 / 异常状态提示：纯文字无边框无背景，红/橙色，加文字不加框 */
  .warntext { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; font-weight:500; color:#ff7b72; white-space:nowrap; margin-left:2px; cursor:help; }
  .warntext.cool { color:var(--yellow); }
  .lrow .connect { flex:none; white-space:nowrap; }
  .empty { padding:14px 2px; color:var(--muted); font-size:12px; }

  /* 居中模态弹窗（对齐 Kilo 的 Dialog） */
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:16px 8px; z-index:50; overflow:auto; box-sizing:border-box; }
  /* 弹窗不超视口：标题栏钉住，正文（.mbody）在内部滚动；初始态与拉伸态同一套布局 */
  .modal { position:relative; width:100%; max-width:340px; min-width:0; box-sizing:border-box; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px; box-shadow:0 12px 40px rgba(0,0,0,.5); display:flex; flex-direction:column; max-height:calc(100vh - 32px); }
  /* 拉伸把手：四边细条 + 四角小方块；右下角常显一个折角提示可拉。悬停时把手泛紫。 */
  .rz { position:absolute; z-index:5; border-radius:3px; }
  .rz.n { top:-3px; left:12px; right:12px; height:7px; cursor:ns-resize; }
  .rz.s { bottom:-3px; left:12px; right:12px; height:7px; cursor:ns-resize; }
  .rz.e { right:-3px; top:12px; bottom:12px; width:7px; cursor:ew-resize; }
  .rz.w { left:-3px; top:12px; bottom:12px; width:7px; cursor:ew-resize; }
  .rz.ne { top:-3px; right:-3px; width:15px; height:15px; cursor:nesw-resize; }
  .rz.sw { bottom:-3px; left:-3px; width:15px; height:15px; cursor:nesw-resize; }
  .rz.nw { top:-3px; left:-3px; width:15px; height:15px; cursor:nwse-resize; }
  .rz.se { bottom:-3px; right:-3px; width:15px; height:15px; cursor:nwse-resize; }
  .rz:hover { background:rgba(var(--accent-rgb),.4); }
  .rz.se::after { content:''; position:absolute; right:5px; bottom:5px; width:7px; height:7px; border-right:2px solid rgba(var(--accent-edge),.5); border-bottom:2px solid rgba(var(--accent-edge),.5); border-radius:0 0 3px 0; pointer-events:none; }
  .modal > .mhead { flex:none; }
  .modal > .mbody { flex:1 1 auto; min-height:0; overflow:auto; margin:0 -6px; padding:0 6px 2px; }
  /* 拉伸后：尺寸由行内样式钉死，多出的内容不外溢 */
  .modal.resized { overflow:hidden; }
  .modal.resizing { box-shadow:0 12px 40px rgba(0,0,0,.5), 0 0 0 1px rgba(var(--accent-rgb),.6), 0 0 18px rgba(var(--accent-rgb),.35); }
  /* 确认框：窄一点、随遮罩垂直居中，两个按钮等宽 */
  .modal.confirm { max-width:320px; margin-top:0; }
  .modal.confirm .mdesc { margin-bottom:4px; }
  .modal.confirm .mfootbtns .btn { flex:1; }
  .modal.confirm .btn:focus { outline:2px solid rgba(var(--accent-rgb),.55); outline-offset:1px; }
  .modal .mhead .iconbtn { flex:none; }
  .modal .mhead { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .modal .mhead .picon { width:26px; height:26px; }
  .modal .mhead .picon.mono { font-size:13px; }
  .modal .mtitle { font-size:15px; font-weight:700; flex:1; }
  .modal .mdesc { color:var(--muted); font-size:12px; line-height:1.5; margin-bottom:10px; }
  .modal .mfootbtns { display:flex; gap:8px; margin-top:14px; }

  /* ===== 用量页 ===== */
  .ubar { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .ubar .seg { flex:1; }
  #uRefresh { width:32px; height:32px; border-radius:7px; background:var(--input-bg); border:1px solid var(--input-border); color:var(--muted); font-size:15px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; flex:none; transition:all .15s; }
  #uRefresh:hover { border-color:var(--accent); color:var(--fg); background:rgba(var(--accent-rgb),.1); box-shadow:0 0 10px rgba(var(--accent-rgb),.35); }

  /* 1. 综合用量统计顶栏大卡片 (Hero 指标与维度指标合二为一) */
  .ustats-head { display:flex; align-items:center; gap:8px; margin:4px 0 8px; }
  .ustats-title { font-size:16px; font-weight:700; color:var(--fg); margin:0; }
  .ustats-tag { font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.08); color:var(--muted); border:1px solid rgba(255,255,255,.08); }
  .ustats-card { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:10px; }
  .ustats-card .hero { border:none; border-radius:0; margin-bottom:0; border-bottom:1px solid var(--border); }
  .ustats-subgrid { display:grid; grid-template-columns:repeat(4, 1fr); gap:0; background:rgba(255,255,255,.015); }
  .ucell { padding:9px 10px 8px; border-right:1px solid var(--border); text-align:left; min-width:0; }
  .ucell:last-child { border-right:none; }
  .uc-val { font-size:14px; font-weight:700; color:var(--fg); font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .uc-lbl { font-size:10px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  @container (max-width: 320px) {
    .ustats-subgrid { grid-template-columns:repeat(2, 1fr); }
    .ucell:nth-child(2) { border-right:none; }
    .ucell:nth-child(1), .ucell:nth-child(2) { border-bottom:1px solid var(--border); }
  }

  /* 2. Token 活动热力图 (GitHub / newapi 风格) */
  .ucard-heatmap { margin-bottom:10px; padding:10px 12px; }
  .ucard-heatmap .cardhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .useg-hm, .useg-curve, .useg-dim, .useg-sk { display:inline-flex; gap:0; border:1px solid var(--input-border); border-radius:6px; overflow:hidden; flex:none; }
  .useg-hm button, .useg-curve button, .useg-dim button, .useg-sk button { padding:4px 8px; font-size:10px; background:var(--input-bg); color:var(--muted); border:none; cursor:pointer; white-space:nowrap; flex:none; }
  .useg-hm button.sel, .useg-curve button.sel, .useg-dim button.sel, .useg-sk button.sel { background:linear-gradient(135deg, rgba(166,108,255,.32) 0%, rgba(120,68,220,.24) 100%); color:#ffffff; font-weight:600; box-shadow:0 0 10px rgba(var(--accent-rgb),.3); text-shadow:0 0 6px rgba(var(--accent-rgb),.5); }
  .uhm-wrap { overflow-x:auto; overflow-y:hidden; padding-bottom:4px; }
  .uhm-wrap::-webkit-scrollbar { height:5px; }
  .uhm-wrap::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:3px; }
  .uhm-svg-box { min-width:100%; }
  .hm-cell { rx:2.5px; ry:2.5px; transition:all .15s; cursor:pointer; }
  .hm-cell:hover { stroke:rgba(255,255,255,.7); stroke-width:1.2px; }
  .hm-l0 { fill:rgba(255,255,255,.05); }
  .hm-l1 { fill:rgba(var(--accent-rgb), 0.35); }
  .hm-l2 { fill:rgba(var(--accent-rgb), 0.62); }
  .hm-l3 { fill:rgba(var(--accent-rgb), 0.88); }
  .hm-l4 { fill:#b98aff; filter:drop-shadow(0 0 4px rgba(var(--accent-rgb),.75)); }
  .hm-month-txt { font-size:9.5px; fill:var(--muted); font-family:var(--vscode-font-family); }

  /* 3. 多模型趋势图 */
  .ucard-trend { margin-bottom:10px; padding:10px 12px; }
  .ucard-trend .cardhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; flex-wrap:wrap; gap:6px; }
  .useg-curve button { white-space:nowrap; }
  .ucurve-legend { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px; font-size:11px; }
  .ucurve-item { display:inline-flex; align-items:center; gap:5px; color:var(--muted); }
  .ucurve-dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .ucurve-box { width:100%; height:150px; min-height:120px; position:relative; overflow:hidden; }
  .ucurve-box svg { width:100%; height:100%; display:block; overflow:visible; }
  .cv-grid-line { stroke:rgba(255,255,255,.08); stroke-dasharray:3 3; }
  .cv-axis-txt { font-size:10px; fill:var(--muted); font-family:var(--vscode-font-family); }
  .cv-path, .cv-model-path { fill:none; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; pointer-events:none; }
  .cv-path { stroke-width:1.2px; stroke-opacity:.75; }
  .cv-model-path { stroke-width:1.4px; }

  /* 趋势图交互节点：平时完全隐藏，鼠标滑过/悬停时平滑浮现发光点与垂直对齐线 */
  .cv-col-group { opacity: 0; transition: opacity .18s ease-out; }
  .cv-col-group:hover, .cv-col-group.active { opacity: 1; }
  .cv-ref-line { stroke: rgba(166,108,255,.45); stroke-dasharray: 2 2; pointer-events: none; }
  .cv-dot-halo, .cv-dot-main, .cv-dot-model { pointer-events:none; vector-effect:non-scaling-stroke; }
  .cv-hover-rect { fill: transparent; cursor: crosshair; }

  @container (max-width: 250px) {
    .ucard-trend { padding:8px 8px; }
    .ucard-trend .cardhead { flex-direction:column; align-items:stretch; gap:6px; }
    .useg-curve { width:100%; display:flex; }
    .useg-curve button { flex:1; padding:3px 2px; font-size:10px; }
    .ucurve-legend { gap:4px 8px; font-size:10px; }
    .ucurve-item { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ucurve-box { height:140px; min-height:110px; }
  }

  /* 4. 模型用量环形图 */
  .ucard-donut { margin-bottom:10px; padding:10px 12px; }
  .ucard-donut .cardhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .udonut-body { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  .udonut-chart-wrap { position:relative; width:140px; height:140px; flex:none; margin:0 auto; }
  .udonut-svg-box { width:100%; height:100%; }
  .donut-center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none; }
  .donut-c-val { font-size:15px; font-weight:700; color:var(--fg); }
  .donut-c-lbl { font-size:10px; color:var(--muted); }
  .donut-slice { cursor:pointer; transition:all .18s ease-out; fill-opacity:.92; }
  .donut-slice:hover { fill-opacity:1; filter:drop-shadow(0 0 6px currentColor); }
  .udonut-legend { flex:1 1 140px; min-width:0; display:flex; flex-direction:column; gap:6px; max-height:220px; overflow-y:auto; padding-right:2px; }
  .udonut-legend::-webkit-scrollbar { width:4px; }
  .udonut-legend::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
  .d-leg-row { display:flex; align-items:center; justify-content:space-between; font-size:11.5px; gap:8px; }
  .d-leg-left { display:flex; align-items:center; gap:6px; min-width:0; flex:1 1 auto; }
  .d-leg-dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .d-leg-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .d-leg-right { flex:none; text-align:right; font-variant-numeric:tabular-nums; }
  .d-leg-pct { color:var(--muted); font-size:11px; margin-left:4px; }

  /* 5. 分流桑基图 (Sankey) */
  .ucard-sankey { margin-bottom:10px; padding:10px 12px; overflow:hidden; }
  .ucard-sankey .cardhead { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .usankey-scroll { overflow-x:auto; padding-bottom:8px; }
  .usankey-scroll::-webkit-scrollbar { height:5px; }
  .usankey-scroll::-webkit-scrollbar-thumb { background:rgba(255,255,255,.18); border-radius:3px; }
  /* 1080 是 4.13.27 六层拓扑的遗留；回到五层后按用户要求收窄，列距随之变小 */
  .usankey-box { min-width:960px; width:100%; position:relative; }
  /* Cursor 风格上下文微观透视卡片样式 */
  .ctx-card {
    background: linear-gradient(135deg, rgba(30, 20, 50, 0.7) 0%, rgba(15, 10, 28, 0.85) 100%);
    border: 1px solid rgba(168, 85, 247, 0.28);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 16px rgba(168, 85, 247, 0.08);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 16px;
  }
  .ctx-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .ctx-title {
    font-size: 13px;
    font-weight: 600;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctx-subtitle {
    font-size: 11px;
    color: #94a3b8;
  }
  .ctx-bar {
    height: 12px;
    border-radius: 6px;
    display: flex;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
    margin-bottom: 12px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.4);
  }
  .ctx-seg {
    height: 100%;
    transition: width 0.3s ease, filter 0.2s;
    cursor: pointer;
  }
  .ctx-seg:hover { filter: brightness(1.25); }
  .ctx-seg.files { background: #38bdf8; }
  .ctx-seg.history { background: #818cf8; }
  .ctx-seg.tools { background: #c084fc; }
  .ctx-seg.rules { background: #f43f5e; }
  .ctx-seg.current { background: #34d399; }
  .ctx-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: #cbd5e1;
    cursor: pointer;
    padding: 2px 5px;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .ctx-item:hover { background: rgba(255,255,255,0.06); }
  .ctx-dot { width: 8px; height: 8px; border-radius: 50%; }
  .ctx-dot.files { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.6); }
  .ctx-dot.history { background: #818cf8; box-shadow: 0 0 6px rgba(129, 140, 248, 0.6); }
  .ctx-dot.tools { background: #c084fc; box-shadow: 0 0 6px rgba(192, 132, 252, 0.6); }
  .ctx-dot.rules { background: #f43f5e; box-shadow: 0 0 6px rgba(244, 63, 94, 0.6); }
  .ctx-dot.current { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
  .ctx-val { font-weight: 600; color: #f8fafc; margin-left: 2px; }
  .ctx-pct { color: #94a3b8; font-size: 10px; }
  .rrow-detail {
    font-size: 10px;
    color: #94a3b8;
    margin-top: 3px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .usankey-box svg { width:100%; height:100%; display:block; }
  /* 门：直角、不透明——圆角会在流带贴合处留出缺口，半透明会让门/流交界处透出底色形成暗缝 */
  .sk-node { stroke:none; cursor:pointer; transition:filter .15s; }
  .sk-node:hover { filter:drop-shadow(0 0 5px currentColor); }
  .sk-node-hit { fill:transparent; stroke:none; cursor:pointer; }
  .sk-node-txt { font-size:11px; fill:var(--fg); font-family:var(--vscode-font-family); paint-order:stroke; stroke:var(--card); stroke-width:3px; stroke-linejoin:round; cursor:help; }
  /* 流带：单个路径不透明，整组用 <g opacity> 统一半透明——相邻流带共享边缘时不会因各自半透明叠加出暗线 */
  .sk-link { stroke:none; transition:filter .2s ease; cursor:pointer; }
  .sk-link-group:hover .sk-link { filter:brightness(1.35) saturate(1.2) drop-shadow(0 0 5px currentColor); }
  .sk-link-hit { fill:none; stroke:transparent; pointer-events:stroke; vector-effect:non-scaling-stroke; cursor:pointer; }

  .hero { display:grid; grid-template-columns:repeat(4, 1fr); gap:0; background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:10px; }
  .hcell { padding:10px 10px 9px; border-right:1px solid var(--border); min-width:0; }
  .hcell:last-child { border-right:none; }
  .ht { display:flex; align-items:center; gap:5px; font-size:10px; color:var(--muted); letter-spacing:.4px; text-transform:uppercase; white-space:nowrap; }
  .hico { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:4px; font-size:10px; font-weight:700; flex:none; }
  .hico svg { width:11px; height:11px; }
  .hico.tk { background:rgba(var(--accent-rgb),.18); color:#d2beff; }
  .hico.rq { background:rgba(57,197,207,.16); color:#5fd4dc; }
  .hico.in { background:rgba(63,185,80,.16); color:var(--green); }
  .hico.out { background:rgba(210,153,34,.18); color:var(--yellow); }
  .hv { font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hs { font-size:10px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  .trend { display:flex; align-items:flex-end; gap:3px; height:44px; padding:2px 0; }
  .trend .bar2 { flex:1; min-width:3px; background:rgba(var(--accent-rgb),.35); border-radius:2px 2px 0 0; position:relative; transition:background .15s; }
  .trend .bar2:hover { background:var(--accent); }
  .trend .bar2.today { background:rgba(var(--accent-rgb),.7); }
  .trend .empty2 { flex:1; text-align:center; color:var(--muted); font-size:11px; align-self:center; }

  .card.uprov-card { overflow:hidden; padding:0; }
  .card.uprov-card .cardhead { margin:0; padding:10px 12px; background:linear-gradient(180deg, rgba(var(--accent-rgb),.15) 0%, rgba(var(--accent-rgb),.04) 100%); border-bottom:1px solid rgba(var(--accent-rgb),.25); box-shadow:inset 0 1px 0 rgba(255,255,255,.05); }
  .card.uprov-card .cardhead h3 { font-size:13px; font-weight:700; color:rgb(var(--accent-edge)); text-shadow:0 0 8px rgba(var(--accent-rgb),.4); }
  .card.uprov-card .thead { padding:6px 12px; }
  .card.uprov-card #uProviders { padding:0 8px 6px; }

  .thead, .urow { display:grid; grid-template-columns: minmax(0,1fr) 40px 58px 44px 40px; gap:5px; align-items:center; }
  .thead { font-size:10px; color:var(--muted); padding:0 2px 6px; border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:.3px; }
  .c-num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .urow { padding:8px 2px; border-bottom:1px dashed var(--border); font-size:12px; font-family:var(--vscode-font-family); }
  .urow.prov { cursor:pointer; font-weight:600; }
  .urow.prov:hover { background:rgba(255,255,255,.03); }
  .urow.model { font-weight:400; color:var(--muted); padding-left:16px; font-size:12px; font-family:var(--vscode-font-family); }
  .urow.model .c-name { display:flex; align-items:center; gap:6px; min-width:0; }
  .urow.model .mono { font-family:var(--vscode-font-family); font-size:12px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .urow .c-name { display:flex; align-items:center; gap:6px; min-width:0; }
  .urow .c-name .nm { font-family:var(--vscode-font-family); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .urow .chev2 { color:var(--muted); font-size:10px; width:10px; flex:none; transition:transform .15s; }
  .urow.open .chev2 { transform:rotate(90deg); }
  .urow .rate.good { color:var(--green); } .urow .rate.warn { color:var(--yellow); } .urow .rate.bad { color:var(--red); }
  .models-fold.collapsed { display:none; }

  .rrow { display:flex; align-items:center; gap:8px; padding:7px 2px; border-bottom:1px dashed var(--border); font-size:11px; }
  .rrow .rdot { width:6px; height:6px; border-radius:50%; flex:none; background:var(--green); }
  .rrow .rdot.bad { background:var(--red); }
  .rrow .rmain { flex:1 1 0; min-width:0; }
  .rrow .rmodel { font-family:var(--vscode-editor-font-family, monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--fg); }
  .rrow .rsub { color:var(--muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rrow .rnum { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; flex:none; }
  .rrow .rnum .t { color:var(--fg); }
  .rrow .rnum .l { color:var(--muted); font-size:10px; }
  .rrow .rerr { color:var(--red); }

  /* 各页顶部的长按钮（添加模型 / 连接新 Provider / 添加提示词），都套下面的 .btn-connect */
  .btn.wide { width:100%; padding:10px 12px; margin-bottom:10px; font-size:13px; }
  .btn.wide .ico { display:inline-flex; width:16px; height:16px; }
  .btn.wide .ico svg { width:16px; height:16px; }
  /* 提供商页顶部两颗并排：左「连接新 Provider」（主题紫），右「从 CC Switch 导入」（青色系，和紫拉开）。
     两颗共用同一套"深底渐变 + 半透明描边 + 同色光晕"，只换色相。 */
  .btnrow { display:flex; gap:8px; margin-bottom:10px; }
  /* width:auto 不能少：窄栏下右键切成 flex-basis:auto，若仍带着 .btn.wide 的 width:100%，
     它会以整行宽度为基准且不收缩，把左键挤成一个图标并撑出横向滚动条。 */
  .btnrow .btn.wide { margin-bottom:0; min-width:0; width:auto; flex:1 1 0; padding:10px 8px; }
  .btnrow .btn .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* 两颗按文字算约需 291px（连接 135 + 导入 148 + 间距 8），加 body 内边距 20 → 面板窄于 320px 就放不下完整文字。
     此时两颗一起缩成等宽的纯图标（悬停有 title 提示），而不是一颗独占宽度、另一颗缩成小方块。 */
  @container (max-width: 320px) {
    .btnrow .btn.wide .lbl { display:none; }
    .btnrow .btn.wide .ico, .btnrow .btn.wide .ico svg, .btnrow .btn.wide .ico .cclogo { width:18px; height:18px; }
  }
  /* 主题紫的那一款：「连接新 Provider」「添加模型」「添加提示词」三颗长按钮共用：
     严格对齐图2框住的风格 —— 浅紫色半透明渐变底 + 微光霓虹描边 + 柔和外发光晕，晶莹通透不沉闷 */
  .btn-connect { background:linear-gradient(135deg, rgba(166,108,255,.24) 0%, rgba(120,68,220,.18) 100%); color:#ffffff; border:1px solid rgba(var(--accent-rgb),.65); font-weight:600; box-shadow:0 0 14px rgba(var(--accent-rgb),.32), inset 0 0 8px rgba(var(--accent-rgb),.15); text-shadow:0 0 8px rgba(var(--accent-rgb),.6); backdrop-filter:blur(6px); }
  .btn-connect:hover { background:linear-gradient(135deg, rgba(166,108,255,.36) 0%, rgba(138,82,230,.28) 100%); border-color:rgba(var(--accent-edge),.9); box-shadow:0 0 20px rgba(var(--accent-rgb),.55), inset 0 0 10px rgba(var(--accent-rgb),.25); color:#ffffff; }
  .btn-import { background:linear-gradient(135deg, rgba(57,197,207,.22) 0%, rgba(30,140,150,.16) 100%); color:#ffffff; border:1px solid rgba(95,212,220,.65); font-weight:600; box-shadow:0 0 14px rgba(57,197,207,.32), inset 0 0 8px rgba(57,197,207,.15); text-shadow:0 0 8px rgba(57,197,207,.6); backdrop-filter:blur(6px); }
  .btn-import:hover { background:linear-gradient(135deg, rgba(57,197,207,.34) 0%, rgba(30,140,150,.26) 100%); border-color:rgba(140,240,248,.9); box-shadow:0 0 20px rgba(57,197,207,.55), inset 0 0 10px rgba(57,197,207,.25); color:#ffffff; }
  .btn-import .ico { display:inline-flex; width:18px; height:18px; }
  /* 导入弹窗：候选清单（勾选 / 名字 / 来源 / 地址 / key / 模型数），跳过项折叠在底部 */
  .ccrow { display:flex; align-items:flex-start; gap:8px; padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.05); cursor:pointer; }
  .ccrow:last-child { border-bottom-color:transparent; }
  .ccrow:hover { background:rgba(255,255,255,.03); }
  .ccrow .ck { margin-top:2px; }
  .ccrow .ccmain { flex:1 1 0; min-width:0; }
  .ccrow .ccname { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; min-width:0; }
  .ccrow .ccname .nm { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ccrow .ccname .tag { flex:none; }
  .ccrow .ccsub { display:flex; align-items:center; gap:4px; font-size:11px; color:var(--muted); margin-top:3px; min-width:0; }
  .ccrow .ccsub .tag { flex:none; }
  .ccrow .ccsub .cctxt { flex:1 1 0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ccrow .ccsub .mono { font-family:var(--mono, ui-monospace, Menlo, Consolas, monospace); display:inline-block; max-width:60%; vertical-align:bottom; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ccrow.dim .ccname, .ccrow.dim .ccsub { opacity:.55; }
  .tag.src { color:#5fd4dc; border-color:rgba(95,212,220,.4); font-size:10px; padding:0 5px; }
  .tag.exist { color:var(--yellow); border-color:rgba(210,153,34,.45); font-size:10px; padding:0 5px; }
  .ccskip { margin-top:8px; font-size:11px; color:var(--muted); }
  .ccskip summary { cursor:pointer; user-select:none; }
  .ccskip li { margin:3px 0 0 14px; line-height:1.4; }
  .ccskip li b { color:var(--fg); font-weight:600; }
  .ccpath { font-size:11px; color:var(--muted); margin-bottom:6px; display:flex; align-items:center; gap:6px; min-width:0; }
  .ccpath .k { flex:none; white-space:nowrap; }
  .ccpath .mono { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--mono, ui-monospace, Menlo, Consolas, monospace); }
  .ccpath .lnk { color:var(--accent); cursor:pointer; flex:none; }
  .ccpath .lnk:hover { text-decoration:underline; }
  .modal.ccimport .cclist { max-height:min(56vh, 480px); overflow:auto; margin:0 -6px; padding:0 6px; }

  /* 选择弹窗（对齐 Kilo ProviderSelectDialog）：搜索 + 分组列表，点行进入连接弹窗 */
  .modal.select { padding:12px; }
  .selgroup { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--muted); font-weight:600; margin:10px 2px 4px; letter-spacing:.3px; }
  .selgroup > span:first-child { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .selgroup .selact { flex:none; color:var(--accent); cursor:pointer; letter-spacing:0; white-space:nowrap; }
  .selgroup .selact:hover { text-decoration:underline; }
  .selgroup .selact b { font-weight:700; }
  .selrow { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:8px; cursor:pointer; }
  .selrow:hover { background:rgba(255,255,255,.05); }
  .selrow .picon { width:22px; height:22px; flex:none; }
  .selrow .ltext { flex:1 1 0; min-width:0; }
  .selrow .ln { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .selrow .ls { display:none; }
  .selrow .plus { color:var(--muted); font-size:14px; flex:none; }
  .selrow:hover .plus { color:var(--accent); }
  .selrow .tag.custom { color:var(--accent); border-color:rgba(var(--accent-rgb),.4); }
  .tag.oauth { color:#5fd4dc; border-color:rgba(95,212,220,.4); font-size:10px; padding:0 5px; }
  /* 预设连接弹窗里的只读信息行（地址 / 接口） */
  .pinfo { display:flex; gap:8px; align-items:baseline; font-size:11.5px; margin-top:6px; min-width:0; }
  .pinfo .k { color:var(--muted); flex:none; }
  .pinfo .v { color:var(--fg); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  label .lblhint { float:right; font-weight:400; color:var(--muted); font-size:11px; }
  .selgroup .gcnt { flex:none; font-weight:600; letter-spacing:0; color:var(--muted); opacity:.8; }
  /* 选择弹窗里一类接入方式一张卡：同模型页的渠道卡——极淡描边 + 顶部一点紫的渐变，标题带上写类型名与计数 */
  .selcard { margin:8px 0 0; border:1px solid rgba(255,255,255,.11); border-radius:10px; overflow:hidden;
    background:linear-gradient(180deg, rgba(var(--accent-rgb),.075) 0%, rgba(var(--accent-rgb),.025) 40px, rgba(255,255,255,.012) 100%); transition:border-color .15s; }
  .selcard:first-child { margin-top:2px; }
  .selcard:hover { border-color:rgba(var(--accent-rgb),.3); }
  .selcardhead { display:flex; align-items:center; gap:8px; padding:7px 10px; font-size:11.5px; font-weight:600; color:var(--muted); letter-spacing:.3px; background:rgba(255,255,255,.03); border-bottom:1px solid rgba(255,255,255,.08); cursor:pointer; user-select:none; }
  .selcardhead:hover { background:rgba(255,255,255,.05); }
  .selcard:not(.open) .selcardhead { border-bottom-color:transparent; }
  .selcardhead .gchev { color:var(--muted); font-size:10px; width:10px; flex:none; transition:transform .15s; }
  .selcard.open .selcardhead .gchev { transform:rotate(90deg); }
  .selcardhead .t { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .selcardhead .gcnt { flex:none; opacity:.8; }
  .selcardbody { padding:2px 6px 3px; }
  .selcardbody.collapsed { display:none; }
  .selcardbody .selrow { border-radius:6px; border-bottom:1px solid rgba(255,255,255,.06); padding:8px 6px; }
  .selcardbody .selrow.compact { padding:6px 6px; }
  .selcardbody .selrow:last-child { border-bottom-color:transparent; }
  .selcardbody .selmore { margin:4px 2px 5px; width:calc(100% - 4px); }
  /* 「查看更多供应商」：整行按钮，弹出「连接提供商」大列表 */
  .selmore { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box; padding:9px 10px; margin:6px 0 2px; border-radius:8px; cursor:pointer; color:var(--accent); font:inherit; font-size:12.5px; font-weight:600; background:rgba(var(--accent-rgb),.06); border:1px dashed rgba(var(--accent-rgb),.4); text-align:left; }
  .selmore:hover { background:rgba(var(--accent-rgb),.12); border-style:solid; box-shadow:0 0 10px rgba(var(--accent-rgb),.25); }
  .selmore .ico { display:inline-flex; width:15px; height:15px; flex:none; }
  .selmore .ico svg { width:15px; height:15px; }
  .selmore .chev { font-size:14px; color:var(--muted); flex:none; }
  .selmore:hover .chev { color:var(--accent); }
  .selmore .cnt { margin-left:auto; font-size:11px; font-weight:600; color:var(--muted); background:var(--card2); border:1px solid var(--border); border-radius:10px; padding:0 7px; }
  .modal.select .sellist { max-height:min(70vh, 640px); overflow:auto; }
  /* 「连接提供商」大列表：紧凑行（标 + 名字），对齐 Kilo 的 ProviderSelectDialog */
  .selrow.compact { padding:6px 8px; gap:10px; }
  .selrow.compact .picon { width:20px; height:20px; }
  .selrow.compact .picon.mono { font-size:10px; }
  .selrow.compact .ln { font-weight:500; }
  .selrow.compact .tag.custom { font-size:10px; padding:0 5px; }
  .modal.allprov .sellist { max-height:min(72vh, 720px); }
  /* 打开外部网站的确认框：叠在其它弹窗之上（自己的挂载点 #linkRoot），小而克制 */
  #linkRoot .overlay.link { z-index:60; }
  .modal.linkbox { max-width:360px; }
  .modal.linkbox .mdesc { margin-bottom:8px; }
  .modal.linkbox .mdesc b { color:var(--fg); font-weight:600; }
  .linkurl { font-family:var(--mono, ui-monospace, Menlo, Consolas, monospace); font-size:11.5px; color:rgb(var(--accent-edge)); background:rgba(var(--accent-rgb),.08); border:1px solid rgba(var(--accent-rgb),.25); border-radius:8px; padding:7px 9px; word-break:break-all; line-height:1.45; max-height:96px; overflow:auto; }
  .linknote { font-size:11px; color:var(--muted); line-height:1.5; margin-top:8px; }
  .modal.linkbox .mfootbtns { margin-top:12px; gap:6px; }
  .modal.linkbox .mfootbtns .btn { flex:1 1 0; min-width:0; padding:8px 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .modal.linkbox .mfootbtns .lOpen { flex:1.3 1 0; }
  .modal.allprov .mfootbtns { margin-top:10px; }

  /* 登录弹窗（第三方登录直连）：说明 → 进度（设备码大字 / 浏览器授权）→ 成功（账号 + 探测面板） */
  .omsg { font-size:12px; color:var(--muted); line-height:1.6; }
  .oBtns .oStart { margin-left:auto; }
  /* 多种登录方式：说明一条一段；登录按钮单独一行等宽并排（返回 / 注册留在上一行） */
  .omodes { display:flex; flex-direction:column; gap:6px; }
  .omode b { color:var(--fg); font-weight:600; }
  .oModeBtns { margin-top:6px; gap:6px; }
  .oModeBtns .btn { flex:1 1 0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 手填表单（Access Token / JSON / API Key）：控件沿用全局 label / input / textarea 规则，这里只放差异 */
  .omodeFields { margin:10px 0; }
  .omodeFields textarea { min-height:96px; font-size:11px; }
  .omodeFields .req { color:var(--red); }
  .omodeFields .fhint { font-size:11px; color:var(--muted); margin-top:2px; }
  .omodeFields .pickrow { margin:8px 0 4px; }
  .omodeFields .oPickJsonBtn { width:100%; margin:0; display:flex; align-items:center; justify-content:center; gap:6px; padding:8px 12px; font-size:12px; font-weight:600; color:#fff; border:1px solid rgba(var(--accent-rgb),.65); border-radius:6px; background:linear-gradient(135deg, rgba(166,108,255,.24) 0%, rgba(120,68,220,.18) 100%); box-shadow:0 0 14px rgba(var(--accent-rgb),.32), inset 0 0 8px rgba(var(--accent-rgb),.15); text-shadow:0 0 8px rgba(var(--accent-rgb),.6); cursor:pointer; }
  .ophase { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--fg); margin:6px 0 10px; }
  .ocode { text-align:center; padding:12px 8px 10px; border:1px dashed rgba(var(--accent-edge),.55); border-radius:10px; background:rgba(var(--accent-rgb),.08); }
  .ocodeLbl { font-size:11px; color:var(--muted); margin-bottom:6px; }
  .ocodeVal { font-family:var(--mono, ui-monospace, Menlo, Consolas, monospace); font-size:22px; font-weight:700; letter-spacing:3px; color:rgb(var(--accent-edge)); text-shadow:0 0 12px rgba(var(--accent-rgb),.6); user-select:all; word-break:break-all; }
  .ocodeBtns, .ourl { display:flex; gap:6px; justify-content:center; margin-top:8px; flex-wrap:wrap; }
  .oerr { color:#ff8080; font-size:12px; line-height:1.5; padding:8px 10px; border:1px solid rgba(255,107,107,.4); border-radius:8px; background:rgba(255,107,107,.08); margin-top:6px; word-break:break-all; }
  .oerr.small { font-size:11px; padding:5px 8px; }
  .oacct { font-size:12.5px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .oacct .okdot { width:8px; height:8px; border-radius:50%; background:#3ddc84; box-shadow:0 0 8px rgba(61,220,132,.7); flex:none; }
  .mono { font-family:var(--mono, ui-monospace, Menlo, Consolas, monospace); font-size:12px; }
  .oacctline { display:flex; align-items:center; gap:7px; flex-wrap:wrap; padding:7px 9px; border:1px solid var(--border); border-radius:8px; background:var(--card2); }
  .oacctline .pdot { margin:0; }
  .ostate { margin-left:auto; font-size:11px; color:var(--muted); }
  .ostate.ok { color:#3ddc84; }
  .ostate.bad { color:#ff8080; }
  .oacctbtns { margin-top:8px !important; }

  /* 顶部 Tab 栏：图标 + 名称；窄栏下只留图标 */
  .tabs { display:flex; gap:2px; margin-bottom:12px; background:var(--card2); border:1px solid var(--border); border-radius:9px; padding:3px; }
  .tab { flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; padding:7px 4px; font-size:12px; font-weight:600; color:var(--muted); background:transparent; border:none; border-radius:7px; cursor:pointer; white-space:nowrap; }
  .tab:hover { color:var(--fg); }
  /* 顶部 Tab 选中态：增强荧光质感，高亮浅紫微透底 + 强力霓虹描边 + 柔美外漫射光晕 + 晶莹内发光 */
  .tab.sel { background:linear-gradient(135deg, rgba(166,108,255,.48) 0%, rgba(138,82,230,.38) 100%); color:#ffffff; border:1px solid rgba(var(--accent-edge),.95); box-shadow:0 0 18px rgba(var(--accent-rgb),.65), 0 0 8px rgba(var(--accent-rgb),.45), inset 0 0 10px rgba(var(--accent-rgb),.3); text-shadow:0 0 10px rgba(var(--accent-rgb),.85); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); position:relative; z-index:1; }
  .tab .ico { display:inline-flex; width:16px; height:16px; flex:none; }
  .tab .ico svg { width:16px; height:16px; }
  .tab .lbl { overflow:hidden; text-overflow:ellipsis; }
  .tab .cnt { font-size:10px; opacity:.8; }
  .tab .cnt:empty { display:none; }
  /* 任一 Tab 文字放不下（会出省略号）→ 整排只留图标（由 fitTabs() 量出来加的类） */
  .tabs.icons-only .tab .lbl, .tabs.icons-only .tab .cnt { display:none; }
  .tabs.icons-only .tab { padding:8px 0; }
  .tabs.icons-only .tab .ico { width:18px; height:18px; }
  .tabs.icons-only .tab .ico svg { width:18px; height:18px; }
  .tabpage { }

  /* 窄栏自适应：用 container query 按面板实际宽度切换。
     容器放在 html 上：元素不能响应"自己作为容器"的查询，放 body 上则 body 自身的
     padding 规则不生效。webview 里 html 宽度就是面板宽度。 */
  html { container-type: inline-size; }
  @container (max-width: 250px) {
    .tab .lbl, .tab .cnt { display:none; }
    .tab { padding:8px 0; }
    .tab .ico { width:18px; height:18px; }
    .tab .ico svg { width:18px; height:18px; }
    /* 页头：红字状态徽章缩成一个点；运行中徽章保留 图标+数字，再收紧一点 */
    .hdr .badge.badge-off { font-size:0; padding:0; width:8px; height:8px; border-radius:50%; background:var(--red); }
    .hdr .badge.badge-on { padding:1px 5px; }
    .badge .sep { margin:0 3px; }
    /* 列表行：文字列整个收起，只留 logo（悬停看名字），控件仍靠右；开关与动作图标缩小 */
    .lrow .ltext { display:none; }
    .lrow .picon { cursor:help; }
    .lrow .lact { margin-left:auto; }
    .lrow { gap:6px; padding:9px 0; }
    .lrow .lact { gap:2px; }
    .lrow .lact .switch { margin-right:2px; }
    .lrow .switch { width:30px; height:17px; }
    .lrow .slider:before { width:11px; height:11px; }
    .lrow .switch input:checked + .slider:before { transform:translateX(13px); }
    .rowact { width:26px; height:26px; }
    .rowact svg { width:17px; height:17px; }
    /* 延迟胶囊缩成一个色点（绿=通 / 红=不通 / 黄=告警 / 紫=测试中），悬停看数值 */
    .latpill { font-size:0; width:8px; height:8px; padding:0; border-radius:50%; border:none; }
    .latpill .spin { display:none; }
    .latpill.ok { background:var(--green); } .latpill.warn { background:var(--yellow); } .latpill.bad { background:var(--red); } .latpill.run { background:var(--accent); }
    /* 热门行的「+ 连接」缩成「+」 */
    .connect .lbl { display:none; }
    /* 卡片标题与右侧说明不再挤同一行 */
    .cardhead { flex-wrap:wrap; }
    .cardhead h3 { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; }
    .card { padding:8px; }
    body { padding:6px; }
    /* 模型页：组头藏计数与图标，清空/全部加入缩成 ✕/✓；名字旁「预选」胶囊只留圆点；能力标签只留图标 */
    .mgrouphead .gc, .mgrouphead .picon { display:none; }
    .mgrouphead .gn { flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mgrouphead .btn { padding:3px 6px; font-size:11px; }
    .mgrouphead .btn .lbl { display:none; }
    #modelSummary { display:none; }
    .modal.addmodel .mlist { max-height:min(56vh, 420px); }
    .defpill .lbl { display:none; }
    .defpill { padding:3px 5px; }
    .mline .mid { font-size:12px; }
    .mline .act { width:20px; height:20px; }
    /* 选择弹窗：藏「自定义 / 授权方式」小标签与副标题，名字独占一行 */
    .selrow .tag.custom, .selrow .tag.oauth, .selrow .ls { display:none; }
    .ocodeVal { font-size:18px; letter-spacing:2px; }
    .ostate { display:none; }
    .selrow .ln { overflow:hidden; text-overflow:ellipsis; }
    .btn.wide .lbl { display:inline; }
    .modal .mdesc { display:none; }
    /* 用量页：Hero 两列、表格藏成功率与延迟列、范围切换只留短字 */
    .hero { grid-template-columns:repeat(2, 1fr); }
    .hcell:nth-child(2) { border-right:none; }
    .hcell:nth-child(1), .hcell:nth-child(2) { border-bottom:1px solid var(--border); }
    .hv { font-size:15px; }
    .thead, .urow { grid-template-columns: minmax(0,1fr) 34px 52px; gap:4px; }
    .thead .c-num:nth-child(4), .thead .c-num:nth-child(5), .urow .c-num:nth-child(4), .urow .c-num:nth-child(5) { display:none; }
    .thead .c-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .urow.model { padding-left:10px; }
    .rrow .rsub { display:none; }
    .useg button { font-size:10px; padding:6px 2px; }
    #uClear .lbl { display:none; }
    /* 批量编辑条：藏计数文字，「移除所选」缩成「移除」 */
    .editbar { left:6px; right:6px; bottom:6px; padding:6px; gap:4px; justify-content:flex-end; }
    .editbar .ecount { display:none; }
    .editbar #editRemove .lbl { display:none; }
    /* Key 池行：状态胶囊在这个宽度只剩一个圆点，藏掉；状态由行底色（冷却黄 / 停用半透明）与副标题承担，让三颗操作按钮放得下 */
    .kprow .kst { display:none; }
    /* 设置页：键值行改纵向（端口号不再折成两半），两个按钮各占一整行 */
    #page-settings .row { flex-direction:column; align-items:stretch; gap:2px; }
    #page-settings .row .val { text-align:left; }
    #page-settings .btns { flex-direction:column; }
    #page-settings .btns .btn { width:100%; flex:none; }
    /* 提示词页：描述与「已启用」小标藏起，开关缩小（.ontag 的基础规则在后面且设了 display，这里要更高特异性才压得住）*/
    .prow .ls, .prow .ln .ontag { display:none; }
    .prow { gap:6px; padding:9px 4px; margin:0 -4px; }
    .prow .switch { width:32px; height:18px; }
    .prow .slider:before { width:12px; height:12px; }
    .prow .switch input:checked + .slider:before { transform:translateX(14px); }
    .psum { font-size:11px; padding:6px 8px; }
  }
  /* 中等宽度：名字保留，只藏计数 */
  @container (max-width: 300px) and (min-width: 251px) {
    .tab .cnt { display:none; }
    .tab { gap:4px; font-size:11px; }
  }
  /* ≤300px：能力标签只留图标（推理=大脑 / 图片=相框），文字藏起；编辑弹窗里的三态标签
     保留 ✓✗自动 的判定符号，否则窄栏下看不出当前是哪一态。 */
  @container (max-width: 300px) {
    /* 页头徽章：只留 图标+数字 */
    .badge .bi .lbl { display:none; }
    /* 列表行：logo 始终保留（文字放不下时由 fitProviderText 收起文字列）；开关与动作图标回到紧凑尺寸 */
    .lrow .lact { gap:2px; }
    .lrow .lact .switch { margin-right:2px; }
    .lrow .switch { width:30px; height:17px; }
    .lrow .slider:before { width:11px; height:11px; }
    .lrow .switch input:checked + .slider:before { transform:translateX(13px); }
    .rowact { width:26px; height:26px; }
    .rowact svg { width:17px; height:17px; }
    .cap .lbl { display:none; }
    .cap { padding:2px 4px; gap:2px; }
    .cap .ico { width:12px; height:12px; }
    .cap .ico svg { width:12px; height:12px; }
    /* Key 池行：窄弹窗里藏每行的启停开关（仍可在行内按钮里操作）*/
    .kprow .kact .switch { display:none; }
  }

  /* key 池（编辑弹窗里的凭证列表）：一行一把，拖柄 / 序号 / 名字·掩码 / 状态胶囊 / 操作 */
  .kpool { border:1px solid var(--border); border-radius:8px; background:var(--card2); margin-top:4px; overflow:hidden; }
  .kphead { display:flex; align-items:center; gap:8px; padding:6px 8px; font-size:11px; color:var(--muted); border-bottom:1px solid var(--border); }
  .kphead .t { flex:1 1 auto; min-width:0; font-weight:600; }
  .kphead .seg { flex:none; }
  .kphead .seg button { padding:3px 8px; font-size:10px; }
  .kprow { display:flex; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px dashed var(--border); font-size:12px; min-width:0; }
  .kprow:last-child { border-bottom:none; }
  .kprow.off { opacity:.55; }
  .kprow.cool { background:rgba(210,153,34,.06); }
  .kprow .grip { color:var(--muted); cursor:grab; flex:none; display:inline-flex; }
  .kprow .grip svg { width:12px; height:12px; }
  .kprow .kidx { flex:none; width:16px; text-align:center; font-size:10px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .kprow .kmain { flex:1 1 0; min-width:4em; }
  .kprow .kname { display:flex; align-items:center; gap:6px; min-width:0; }
  .kprow .kname .nm { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  /* 掩码 / 邮箱：可收缩、会截断，窄弹窗下不能压到右侧的胶囊和按钮上 */
  .kprow .kname .mono { color:var(--muted); font-size:11px; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .kprow .kname .tag { flex:none; }
  .kprow > .latpill { flex:none; max-width:38%; }
  .kprow .ksub { font-size:10px; color:var(--muted); margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* 状态胶囊可收缩、最多占四成半：名字位至少留 4em；冷却倒计时放在副标题里，胶囊只写原因 */
  .kprow .kst { flex:0 1 auto; min-width:0; max-width:45%; overflow:hidden; text-overflow:ellipsis; font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid transparent; white-space:nowrap; }
  .kprow .kst.ok { color:var(--green); border-color:rgba(63,185,80,.4); }
  .kprow .kst.cool { color:var(--yellow); border-color:rgba(210,153,34,.5); background:rgba(210,153,34,.12); }
  .kprow .kst.bad { color:var(--red); border-color:rgba(248,81,73,.4); }
  .kprow .kst.idle { color:var(--muted); border-color:var(--border); }
  .kprow .kact { display:flex; align-items:center; gap:2px; flex:none; }
  .kprow .kact .iconbtn { width:24px; height:24px; border-color:transparent; color:var(--muted); }
  .kprow .kact .iconbtn svg { width:14px; height:14px; }
  .kprow .kact .iconbtn .spin { width:12px; height:12px; min-width:12px; min-height:12px; border-width:2px; margin:0 auto; flex:none; box-sizing:border-box; aspect-ratio:1 / 1; }
  .kprow .kact .iconbtn:hover { color:var(--fg); border-color:var(--border); }
  .kprow .kact .iconbtn.run { color:var(--accent); }
  .kprow .kact .iconbtn.del:hover { color:var(--red); border-color:rgba(248,81,73,.4); }
  .kprow .kact .switch { width:28px; height:16px; margin-right:2px; }
  .kprow .kact .slider:before { width:10px; height:10px; }
  .kprow .kact .switch input:checked + .slider:before { transform:translateX(12px); }
  .kprow.dragging { opacity:.6; }
  .kprow.dropbefore { box-shadow: inset 0 2px 0 var(--accent); }
  .kpadd { display:flex; gap:6px; padding:8px; border-top:1px solid var(--border); align-items:center; }
  /* 池底部「再登录一个账号 / 再加一把 Key」：不写字，只一枚靠右的方形小按钮，与顶部长按钮同款荧光紫光晕；说明在悬停里 */
  .kpadd.kpadd-mini { justify-content:flex-end; padding:6px 8px; }
  .btn-connect.btn-sq { width:28px; height:28px; padding:0; border-radius:7px; flex:none; }
  .btn-connect.btn-sq svg { width:15px; height:15px; }
  .kpadd .keywrap { flex:1 1 auto; min-width:0; }
  .kpadd input.klabel { flex:0 0 96px; min-width:0; }
  .kpadd .btn { flex:none; }
  .kpfoot { font-size:10px; color:var(--muted); padding:0 8px 8px; }
  .kpedit { display:flex; gap:6px; padding:6px 8px 8px 30px; align-items:center; border-bottom:1px dashed var(--border); background:rgba(var(--accent-rgb),.05); }
  .kpedit .keywrap { flex:1 1 auto; min-width:0; }
  .kpedit input.klabel { flex:0 0 96px; min-width:0; }
  /* 行副标题里的池标记 */
  .lrow .poolpill { display:inline-flex; align-items:center; gap:3px; font-size:10px; padding:0 6px; border-radius:999px; border:1px solid rgba(var(--accent-rgb),.45); color:rgb(var(--accent-edge)); margin-left:6px; flex:none; vertical-align:middle; }
  .lrow .poolpill.cool { border-color:rgba(210,153,34,.5); color:var(--yellow); }

  /* 模型页 */
  .msearch { width:100%; margin-bottom:10px; }
  .mgroup { margin-bottom:12px; }
  .mgrouphead { display:flex; align-items:center; gap:8px; margin:0 0 4px; min-width:0; }
  .mgrouphead .picon { width:20px; height:20px; flex:none; }
  .mgrouphead .picon.mono { font-size:10px; }
  .mgrouphead .gn { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:0 1 auto; }
  .mgrouphead .gc { font-size:11px; color:var(--muted); flex:1 0 auto; white-space:nowrap; }
  .mgrouphead .btn { flex:none; }
  .msum { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
  .msum .warn { color:var(--yellow); }
  #modelSummary.warn { color:var(--yellow); }

  /* 搜索框 + 右侧清空叉号 */
  .search { position:relative; margin-bottom:8px; }
  .search input { width:100%; padding-right:30px; }
  .sclear { position:absolute; right:6px; top:50%; transform:translateY(-50%); width:20px; height:20px; border-radius:50%; border:none; background:var(--ghost-bg); color:var(--muted); font-size:11px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
  .sclear:hover { background:var(--accent); color:var(--accent-fg); }

  /* 模型行：已选（可删）与候选（可加）共用 .mline，右侧动作不同 */
  .mline .act { flex:none; width:22px; height:22px; border-radius:6px; border:1px solid var(--border); background:var(--input-bg); color:var(--muted); font-size:13px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
  .mline .act.add:hover { border-color:var(--green); color:var(--green); }
  .mline .act.del:hover { border-color:var(--red); color:var(--red); }
  .mline.selected .act { background:rgba(var(--accent-rgb),.2); }
  .empty.small { padding:8px 2px; }
  .mgroup.pool .mgrouphead .gc { font-weight:400; }
  .onlyEn { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--muted); margin:0; white-space:nowrap; cursor:pointer; }
  .onlyEn input { width:auto; margin:0; }
    /* 默认模型所在行：更亮的紫底 + 内描边 + 外发光，发光缓慢呼吸；名字加粗。
     描边用 inset box-shadow 而不是 border，避免行高跳 2px。 */
  .mline.selected { background:rgba(var(--accent-rgb),.24); border-radius:6px; padding-left:6px; padding-right:6px; margin:0 -6px; border-bottom-color:transparent; animation: sel-glow 2.6s ease-in-out infinite; }
  .mline.selected .mid { font-weight:600; }
  @keyframes sel-glow {
    0%, 100% { box-shadow: inset 0 0 0 1px rgba(var(--accent-edge),.45), 0 0 6px rgba(var(--accent-rgb),.25); }
    50%      { box-shadow: inset 0 0 0 1px rgba(var(--accent-edge),.9),  0 0 16px rgba(var(--accent-rgb),.6); }
  }

/* 渠道分组：组头可点折叠 */
  .mgrouphead.fold { cursor:pointer; user-select:none; border-radius:6px; padding:4px 4px; margin:0 -4px 4px; }
  .mgrouphead.fold:hover { background:rgba(255,255,255,.03); }
  .mgrouphead .gchev { color:var(--muted); font-size:10px; width:10px; flex:none; transition:transform .15s; }
  .mgroup.open .gchev { transform:rotate(90deg); }
  .mgroup .gbody.collapsed { display:none; }

  /* 模型页的分组卡：一个渠道一张薄卡——1px 极淡描边、自上而下几乎看不出的紫→透明渐变、
     组头一条略亮的带子；行间用极淡实线（不再是虚线）。目的是让眼睛先看到"几组"再看到"几行"，
     而不是一屏几十行平铺。颜色都压得很低，久看不累；悬停时描边微微泛紫，算是唯一的动效。 */
  #selectedList { margin-top:6px; }
  #selectedList.sorting .mgroup { transition:transform .2s cubic-bezier(.2,.8,.2,1); }
  #selectedList.sorting .mgroup.dragging { transition:none; }
  #selectedList.sorting .mgroup.dropping { transition:transform .2s cubic-bezier(.2,.8,.2,1); }
  #selectedList .mgroup { margin:0 0 8px; border:1px solid rgba(255,255,255,.11); border-radius:10px; overflow:hidden;
    background:linear-gradient(180deg, rgba(var(--accent-rgb),.075) 0%, rgba(var(--accent-rgb),.025) 44px, rgba(255,255,255,.012) 100%);
    transition:border-color .15s, box-shadow .15s; }
  #selectedList .mgroup:hover { border-color:rgba(var(--accent-rgb),.3); }
  #selectedList .mgroup.dragging, #selectedList .mgroup.dropping {
    position:relative; z-index:10; border-color:rgba(var(--accent-edge),.7) !important;
    box-shadow:0 12px 36px rgba(0,0,0,.65), 0 0 0 1px rgba(var(--accent-edge),.6), 0 0 20px rgba(var(--accent-rgb),.4);
    background:linear-gradient(180deg, rgba(var(--accent-rgb),.2) 0%, rgba(var(--accent-rgb),.08) 44px, rgba(20,20,28,.98) 100%) !important;
  }
  #selectedList .mgrouphead.fold { margin:0; padding:7px 10px; border-radius:0; background:rgba(255,255,255,.03); border-bottom:1px solid rgba(255,255,255,.08); cursor:grab; touch-action:none; }
  #selectedList .mgrouphead.fold:active { cursor:grabbing; }
  #selectedList .mgroup:not(.open) .mgrouphead.fold { border-bottom-color:transparent; }
  #selectedList .mgrouphead.fold:hover { background:rgba(255,255,255,.05); }
  #selectedList .mgrouphead .gc { opacity:.8; }
  /* 预选模型所在的渠道卡：描边与顶部渐变泛紫一档、一圈很淡的光晕、组名亮起——
     和行内「预选」胶囊同一色系但轻得多，只是把视线引到这一组，不和胶囊抢 */
  #selectedList .mgroup.cur { border-color:rgba(var(--accent-rgb),.45); box-shadow:0 0 10px rgba(var(--accent-rgb),.16);
    background:linear-gradient(180deg, rgba(var(--accent-rgb),.16) 0%, rgba(var(--accent-rgb),.05) 44px, rgba(var(--accent-rgb),.025) 100%); }
  #selectedList .mgroup.cur:hover { border-color:rgba(var(--accent-rgb),.6); }
  #selectedList .mgroup.cur .mgrouphead.fold { background:rgba(var(--accent-rgb),.06); border-bottom-color:rgba(var(--accent-rgb),.18); }
  #selectedList .mgroup.cur .mgrouphead .gn { color:rgb(var(--accent-edge)); }
  #selectedList .gbody { padding:2px 8px 3px; }
  #selectedList .mline { padding:6px 4px; border-bottom:1px solid rgba(255,255,255,.06); }
  #selectedList .mline:last-child { border-bottom-color:transparent; }
  #selectedList .mline .mid { color:var(--fg); }
  /* 卡内的高亮行不再向外撑（去掉负边距），改成卡内圆角块，与截图3风格一致 */
    #selectedList .mline.selected, #selectedList .mline.checked, #selectedList .mline.checked:hover, #selectedList .mline.editing:hover { margin:2px 0; padding-left:8px; padding-right:8px; border-radius:6px; }
  #selectedList .mline.selected { background:rgba(var(--accent-rgb),.18); border:none; box-shadow:none; }
/* 能力标签在页面上只是"说明"，不是按钮：去掉底色、描边压淡、字色略收，悬停到该行时才回到全色 */
  #selectedList .cap.reason { background:transparent; border-color:rgba(255,166,87,.26); color:rgba(255,178,107,.78); }
  #selectedList .cap.vision { background:transparent; border-color:rgba(57,197,207,.26); color:rgba(95,212,220,.78); }
  #selectedList .mline:hover .cap.reason { border-color:rgba(255,166,87,.5); color:#ffb26b; }
  #selectedList .mline:hover .cap.vision { border-color:rgba(57,197,207,.5); color:#5fd4dc; }
  #page-models .hint { opacity:.75; }

  /* 添加模型弹窗：比连接弹窗宽一点，列表可滚 */
  .modal.addmodel { max-width:380px; }
  .modal .mlist { max-height:min(62vh, 520px); overflow:auto; margin:0 -6px; padding:0 6px; }
  .modal .mlist .mline .mid { color:var(--muted); }
  .modal .mlist .mline:hover .mid { color:var(--fg); }
  .modal .mlist .mgrouphead { position:sticky; top:0; background:var(--card); z-index:1; padding-top:6px; }
  /* Kiro 列表行：名字 + 「预选」胶囊同盒，胶囊紧贴名字；双击整行设预选，故行内禁用选字。 */
  #page-models .mline { user-select:none; }

  /* 批量编辑态：平时行尾没有 ✕、组头没有「清空」，点卡片头「编辑」进入编辑态——
     每行前面出一个勾选框、组头出一个全选框、底部浮出操作条；勾好后一次性移除。 */
  .hright { display:flex; align-items:center; gap:8px; flex:none; }
  #editModels.on { border-color:var(--accent); color:var(--accent); box-shadow:0 0 8px rgba(var(--accent-rgb),.3); }
  .ck { width:16px; height:16px; border-radius:4px; border:1.5px solid var(--muted); flex:none; display:inline-flex; align-items:center; justify-content:center; color:transparent; font-size:11px; line-height:1; cursor:pointer; transition:background .1s, border-color .1s; }
  .ck.on { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); box-shadow:0 0 6px rgba(var(--accent-rgb),.45); }
  .ck.some { border-color:var(--accent); color:var(--accent); }
  .mline.editing { cursor:pointer; }
  .mline.editing:hover { background:rgba(255,255,255,.03); border-radius:6px; padding-left:6px; padding-right:6px; margin:0 -6px; }
  .mline.checked, .mline.checked:hover { background:rgba(var(--accent-rgb),.14); border-radius:6px; padding-left:6px; padding-right:6px; margin:0 -6px; border-bottom-color:transparent; }
  .mgrouphead .ck { margin-left:auto; }
  .editbar { position:fixed; left:10px; right:10px; bottom:10px; z-index:40; display:flex; align-items:center; gap:6px; padding:8px 10px; border-radius:10px; background:var(--card); border:1px solid rgba(var(--accent-edge),.45); box-shadow:0 8px 28px rgba(0,0,0,.5), 0 0 16px rgba(var(--accent-rgb),.3); }
  .editbar .ecount { flex:1 1 auto; min-width:0; font-size:12px; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .editbar .btn { flex:none; white-space:nowrap; gap:0; }
  .btn-danger-fill { background:var(--red); color:#fff; }
  .btn-danger-fill:hover { background:#ff6b64; }
  .btn-danger-fill[disabled] { opacity:.4; cursor:not-allowed; }
  .btn-danger-fill[disabled]:hover { background:var(--red); }
  body.editing { padding-bottom:64px; }
  .mname { flex:1 1 0; min-width:0; display:inline-flex; align-items:center; gap:6px; }
  .mname .mid { flex:0 1 auto; }
    /* 「预选」胶囊：只在预选那一行出现。实色 accent 底 + 实心圆 + 扩散光环。 */
  .defpill { display:inline-flex; align-items:center; gap:5px; font-size:10px; padding:2px 7px; border-radius:5px; background:var(--accent); color:var(--accent-fg); font-weight:600; white-space:nowrap; flex:none; box-shadow:0 0 0 2px rgba(var(--accent-rgb),.28), 0 0 10px rgba(var(--accent-rgb),.55); }
  .defpill .dot { position:relative; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
  .defpill .dot::after { content:''; position:absolute; inset:-1.5px; border-radius:50%; border:1.5px solid currentColor; animation: pulse-ring 1.8s ease-out infinite; }
  @keyframes pulse-ring {
    0%   { transform:scale(1);   opacity:.9; }
    70%  { transform:scale(2.6); opacity:0; }
    100% { transform:scale(2.6); opacity:0; }
  }
  /* 减弱动效：必须排在上面所有 animation 规则之后，同特异性下才能压过它们 */
  @media (prefers-reduced-motion: reduce) {
    .mline.selected { animation:none; box-shadow: inset 0 0 0 1px rgba(var(--accent-edge),.6), 0 0 8px rgba(var(--accent-rgb),.35); }
    .defpill .dot::after { animation:none; display:none; }
    .csel.open .csel-menu { animation:none; }
    * { transition-duration:.01ms !important; }
  }

/* 提示词页（对齐 cc-switch PromptListItem：开关 | 名称/描述 | 编辑 | 删除） */
  .prow { display:flex; align-items:center; gap:10px; padding:10px 6px; border-bottom:1px solid var(--border); min-width:0; border-radius:6px; margin:0 -6px; }
  .prow:last-child { border-bottom:none; }
  .prow .ltext { flex:1 1 0; min-width:0; overflow:hidden; }
  .prow .ln { display:flex; align-items:center; font-size:13px; font-weight:600; color:var(--fg); white-space:nowrap; min-width:0; }
  .prow .ln .nm { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prow .ls { font-size:11px; color:var(--muted); margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .prow .lact { display:flex; align-items:center; gap:4px; flex:none; }
  .prow .iconbtn { border-color:transparent; color:var(--muted); }
  .prow .iconbtn svg { width:14px; height:14px; }
  .prow .iconbtn:hover { border-color:var(--border); color:var(--fg); }
  .prow .iconbtn.del:hover { color:var(--red); border-color:rgba(248,81,73,.4); background:rgba(248,81,73,.08); }
  .prow .iconbtn[disabled] { opacity:.35; cursor:not-allowed; }
  .prow .iconbtn[disabled]:hover { color:var(--muted); border-color:transparent; background:transparent; }
  /* 启用中的那条：淡紫底 + 名字旁「已启用」小标 */
  .prow.on { background:rgba(var(--accent-rgb),.1); border-bottom-color:transparent; }
  .prow.on .ln { color:var(--fg); }
  .prow .ontag { display:inline-block; flex:none; font-size:10px; font-weight:600; padding:1px 6px; border-radius:4px; background:var(--accent); color:var(--accent-fg); margin-left:6px; vertical-align:1px; }
  .psum { font-size:12px; color:var(--muted); padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--card2); margin-bottom:8px; }
  .psum b { color:var(--fg); font-weight:600; }
  .pmeta { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-top:4px; }
  .modal.prompt { max-width:420px; }
  .modal.connect { max-width:420px; }

  /* Kiro 风格浮动气泡提示 / 备注窗口：紫色基调炫彩毛玻璃风格（极光多重微光 + 玫瑰粉&电光青光晕 + 高斯滤波与高饱和水晶质感） */
  #kTip {
    position: fixed;
    z-index: 10000;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transform: translateY(4px);
    transition: opacity 0.14s ease, transform 0.14s ease;
    width: max-content;
    max-width: min(360px, calc(100vw - 20px));
    padding: 8px 13px;
    font-size: 11.5px;
    line-height: 1.52;
    color: #ffffff;
    background:
      radial-gradient(circle at 12% 18%, rgba(192, 132, 252, 0.48) 0%, transparent 48%),
      radial-gradient(circle at 88% 18%, rgba(244, 114, 182, 0.36) 0%, transparent 45%),
      radial-gradient(circle at 85% 82%, rgba(56, 189, 248, 0.30) 0%, transparent 52%),
      radial-gradient(circle at 20% 80%, rgba(139, 92, 246, 0.35) 0%, transparent 50%),
      linear-gradient(135deg, rgba(42, 18, 78, 0.78) 0%, rgba(22, 14, 44, 0.84) 60%, rgba(14, 9, 28, 0.90) 100%);
    border: 1px solid rgba(216, 180, 254, 0.65);
    border-radius: 9px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.55),
      0 0 20px rgba(168, 85, 247, 0.45),
      0 0 8px rgba(56, 189, 248, 0.25),
      inset 0 1px 1px rgba(255, 255, 255, 0.45),
      inset 0 0 12px rgba(192, 132, 252, 0.22);
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75), 0 0 8px rgba(216, 180, 254, 0.7);
    word-break: break-all;
    overflow-wrap: anywhere;
    white-space: normal;
    backdrop-filter: blur(16px) saturate(190%);
    -webkit-backdrop-filter: blur(16px) saturate(190%);
  }
  #kTip.show {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
  #kTip .tip-row { word-break: break-all; overflow-wrap: anywhere; }
  /* 富文本 Tooltip 卡片排版 */
  .tip-card { display:flex; flex-direction:column; gap:6px; min-width:140px; }
  .tip-hdr { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:10.5px; opacity:.9; border-bottom:1px solid rgba(255,255,255,.15); padding-bottom:4px; }
  .tip-date { font-weight:700; color:#ffffff; }
  .tip-req { color:#e2e8f0; font-size:10px; }
  .tip-total { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin:2px 0; }
  .tip-lbl { font-size:11px; color:#e2e8f0; }
  .tip-val { font-size:14px; font-weight:700; color:#ffffff; text-shadow:0 0 8px rgba(var(--accent-rgb),.85); font-variant-numeric:tabular-nums; }
  .tip-models { display:flex; flex-direction:column; gap:4px; border-top:1px dashed rgba(255,255,255,.15); padding-top:4px; margin-top:2px; }
  .tip-mrow { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:10.5px; }
  .tip-mleft { display:flex; align-items:center; gap:5px; min-width:0; }
  .tip-mdot { width:6px; height:6px; border-radius:50%; flex:none; }
  .tip-mname { color:#cbd5e1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px; }
  .tip-mval { color:#ffffff; font-weight:600; flex:none; font-variant-numeric:tabular-nums; }
</style>
</head>
<body>
  <div class="cardhead hdr" style="margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;overflow:hidden;">
      <h3 class="title-text" style="font-size:15px;white-space:nowrap;">API4Kiro</h3>
      <span class="badge" id="statusBadge" title="">--</span>
    </div>
    <div class="switch-wrap">
      <span class="switch-lbl" id="enableLbl">开启代理</span>
      <label class="switch" title="启用/关闭代理"><input type="checkbox" id="enable"><span class="slider"></span></label>
    </div>
  </div>

  <div class="tabs" role="tablist">
    <button class="tab" data-tab="providers" role="tab" aria-selected="false" title="提供商"><span class="ico">${ICONS.plug}</span><span class="lbl">提供商</span></button>
    <button class="tab sel" data-tab="models" role="tab" aria-selected="true" title="模型"><span class="ico">${ICONS.chip}</span><span class="lbl">模型</span></button>
    <button class="tab" data-tab="usage" role="tab" aria-selected="false" title="用量"><span class="ico">${ICONS.chart}</span><span class="lbl">用量</span></button>
    <button class="tab" data-tab="settings" role="tab" aria-selected="false" title="设置"><span class="ico">${ICONS.settings}</span><span class="lbl">设置</span></button>
  </div>

  <!-- ========== 模型页 ========== -->
  <div class="tabpage" id="page-models">
    <button class="btn btn-connect wide" id="showAddModel" title="添加模型到 Kiro 列表">
      <span class="ico">${ICONS.chip}</span><span class="lbl">添加模型</span>
    </button>
    <!-- 已进入 Kiro 列表的模型，按渠道分组（可折叠），每行可删 -->
    <div class="card" id="selectedCard">
      <div class="cardhead" style="margin-bottom:4px;">
        <h3>Kiro 模型列表</h3>
        <div class="hright">
          <span class="muted" id="modelSummary">--</span>
          <button class="btn btn-ghost btn-sm" id="editModels" title="批量编辑：勾选要移出 Kiro 列表的模型">编辑</button>
        </div>
      </div>
      <div id="selectedList"></div>
    </div>
    <!-- 批量编辑操作条：只在编辑态出现，浮在面板底部 -->
    <div class="editbar hidden" id="editBar">
      <span class="ecount" id="editCount">已选 0 个</span>
      <button class="btn btn-ghost btn-sm" id="editAll">全选</button>
      <button class="btn btn-sm btn-danger-fill" id="editRemove" disabled>移除<span class="lbl">所选</span></button>
      <button class="btn btn-primary btn-sm" id="editDone">完成</button>
    </div>
  </div>

  <!-- ========== 提供商页 ========== -->
  <div class="tabpage hidden" id="page-providers">
    <div class="btnrow">
      <button class="btn btn-connect wide" id="showAdd" title="连接新 Provider">
        <span class="ico">${ICONS.plug}</span><span class="lbl">连接新 Provider</span>
      </button>
      <button class="btn btn-import wide" id="ccImport" title="读取 CC Switch 里配好的供应商（Claude Code / Codex / Gemini CLI / OpenCode…），一键接进来">
        <span class="ico"><img class="cclogo" src="${ccLogo}" alt=""></span><span class="lbl">从 CC Switch 导入</span>
      </button>
    </div>
    <div class="card">
      <div class="cardhead" style="margin-bottom:2px;">
        <h3>已连接的 Provider</h3>
      </div>
      <div id="providers"></div>
    </div>
  </div>

  <!-- ========== 用量页（本地账本，跨 provider）========== -->
  <div class="tabpage hidden" id="page-usage">
    <!-- 时间范围 + 刷新（对齐 cc-switch UsageDashboard 顶栏） -->
    <div class="ubar">
      <div class="seg useg" role="tablist">
        <button data-r="today" class="sel">今天</button>
        <button data-r="7d">7 天</button>
        <button data-r="30d">30 天</button>
        <button data-r="all">全部</button>
      </div>
      <button class="iconbtn" id="uRefresh" title="刷新">&#8635;</button>
    </div>

    <!-- 1. 综合用量统计（合并使用统计与核心用量指标为统一大卡片） -->
    <div class="ustats-head">
      <h3 class="ustats-title">使用统计</h3>
      <span class="ustats-tag">应用用量</span>
    </div>
    <div class="ustats-card">
      <div class="hero">
        <div class="hcell"><div class="ht"><span class="hico tk">${ICONS.sparkles}</span>Tokens</div><div class="hv" id="hTokens">--</div><div class="hs" id="hTokensSub"></div></div>
        <div class="hcell"><div class="ht"><span class="hico rq">${ICONS.chart}</span>请求</div><div class="hv" id="hReq">--</div><div class="hs" id="hReqSub"></div></div>
        <div class="hcell"><div class="ht"><span class="hico in">↓</span>输入</div><div class="hv" id="hIn">--</div><div class="hs" id="hInSub"></div></div>
        <div class="hcell"><div class="ht"><span class="hico out">↑</span>输出</div><div class="hv" id="hOut">--</div><div class="hs" id="hOutSub"></div></div>
      </div>
      <div class="ustats-subgrid">
        <div class="ucell">
          <div class="uc-val" id="stPeakTokens">--</div>
          <div class="uc-lbl">单日峰值 Token</div>
        </div>
        <div class="ucell">
          <div class="uc-val" id="stLongestDur">--</div>
          <div class="uc-lbl">最长请求耗时</div>
        </div>
        <div class="ucell">
          <div class="uc-val" id="stCurStreak">--</div>
          <div class="uc-lbl">当前连续天数</div>
        </div>
        <div class="ucell">
          <div class="uc-val" id="stMaxStreak">--</div>
          <div class="uc-lbl">最长连续天数</div>
        </div>
      </div>
    </div>

    <!-- 2. Token 活动热力图 (GitHub / newapi 风格格子阵列) -->
    <div class="card ucard-heatmap">
      <div class="cardhead">
        <div style="display:flex;align-items:center;gap:8px;">
          <h3>Token 活动</h3>
        </div>
        <div class="seg useg-hm" role="tablist">
          <button data-hm="daily" class="sel">每日</button>
          <button data-hm="weekly">每周</button>
          <button data-hm="cumul">累计</button>
        </div>
      </div>
      <div class="uhm-wrap">
        <div class="uhm-svg-box" id="uHeatmapSvg"></div>
      </div>
    </div>

    <!-- 3. 时间范围多模型平滑曲线趋势图 -->
    <div class="card ucard-trend" id="trendCard">
      <div class="cardhead">
        <h3 id="trendTitle">每日 Token 趋势图</h3>
        <div class="seg useg-curve" role="tablist">
          <button data-cv="tokens" class="sel">Token</button>
          <button data-cv="requests">请求</button>
        </div>
      </div>
      <div class="ucurve-legend" id="uCurveLegend"></div>
      <div class="ucurve-box" id="uCurveSvg"></div>
    </div>

    <!-- 4. 模型用量环形图 (Donut Chart) -->
    <div class="card ucard-donut">
      <div class="cardhead">
        <h3>模型用量</h3>
        <div class="seg useg-dim" role="tablist">
          <button data-dim="tokens" class="sel">Token 用量</button>
          <button data-dim="requests">请求次数</button>
        </div>
      </div>
      <div class="udonut-body">
        <div class="udonut-chart-wrap">
          <div class="udonut-svg-box" id="uDonutSvg"></div>
        </div>
        <div class="udonut-legend" id="uDonutLegend"></div>
      </div>
    </div>

    <!-- 5. 方法 B：独立于桑基滚动画布的上下文微观透视卡片 -->
    <div class="card ctx-card" id="ctxBreakdownCard">
      <div class="ctx-header">
        <div class="ctx-title">
          <span>✨ 上下文微观构成透视 (Context Composition · Cursor Style)</span>
        </div>
        <div class="ctx-subtitle" id="ctxTotalTok">输入总量: -- Tokens</div>
      </div>
      <div class="ctx-bar" id="ctxBar">
        <div class="ctx-seg files" id="ctxSegFiles" style="width: 0%;" data-k-tip="关联代码文件"></div>
        <div class="ctx-seg history" id="ctxSegHistory" style="width: 0%;" data-k-tip="历史会话记录"></div>
        <div class="ctx-seg tools" id="ctxSegTools" style="width: 0%;" data-k-tip="工具规格定义"></div>
        <div class="ctx-seg rules" id="ctxSegRules" style="width: 0%;" data-k-tip="系统规则设定"></div>
        <div class="ctx-seg current" id="ctxSegCurrent" style="width: 0%;" data-k-tip="当前用户指令"></div>
      </div>
      <div class="ctx-legend">
        <div class="ctx-item" data-k-tip="当前打开与关联读取的代码文档">
          <span class="ctx-dot files"></span>
          <span>关联代码文件</span>
          <span class="ctx-val" id="ctxValFiles">--</span>
          <span class="ctx-pct" id="ctxPctFiles">(0%)</span>
        </div>
        <div class="ctx-item" data-k-tip="多轮历史提问、回复与思考链路">
          <span class="ctx-dot history"></span>
          <span>历史会话记录</span>
          <span class="ctx-val" id="ctxValHistory">--</span>
          <span class="ctx-pct" id="ctxPctHistory">(0%)</span>
        </div>
        <div class="ctx-item" data-k-tip="Kiro 声明的工具规格与 JSON Schema">
          <span class="ctx-dot tools"></span>
          <span>工具规格定义</span>
          <span class="ctx-val" id="ctxValTools">--</span>
          <span class="ctx-pct" id="ctxPctTools">(0%)</span>
        </div>
        <div class="ctx-item" data-k-tip="系统 Prompt、MCP 规约与工作区规则">
          <span class="ctx-dot rules"></span>
          <span>系统规则设定</span>
          <span class="ctx-val" id="ctxValRules">--</span>
          <span class="ctx-pct" id="ctxPctRules">(0%)</span>
        </div>
        <div class="ctx-item" data-k-tip="当前轮次用户提问与工具执行输出">
          <span class="ctx-dot current"></span>
          <span>当前用户指令</span>
          <span class="ctx-val" id="ctxValCurrent">--</span>
          <span class="ctx-pct" id="ctxPctCurrent">(0%)</span>
        </div>
      </div>
    </div>

    <!-- 6. 桑基分流数图 (Sankey: 渠道 -> 凭证 -> 模型 -> 状态) -->
    <div class="card ucard-sankey">
      <div class="cardhead">
        <div>
          <h3>分流桑基图</h3>
          <div class="muted" id="sankeySub" style="font-size:10.5px;margin-top:2px;">渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态 &rarr; 缓存命中 / Token 细分</div>
        </div>
        <div class="seg useg-sk" role="tablist">
          <button data-sk="tokens" class="sel">Token</button>
          <button data-sk="requests">次数</button>
        </div>
      </div>
      <div class="usankey-scroll">
        <div class="usankey-box" id="uSankeySvg"></div>
      </div>
    </div>

    <!-- 按渠道（可展开到模型）：对齐 cc-switch ProviderStatsTable → ModelStatsTable 级联 -->
    <div class="card uprov-card">
      <div class="cardhead" style="margin-bottom:6px;">
        <h3>按渠道明细</h3>
        <span class="muted" id="provSub"></span>
      </div>
      <div class="thead"><span class="c-name">渠道 / 模型</span><span class="c-num">请求</span><span class="c-num">Tokens</span><span class="c-num">成功率</span><span class="c-num">延迟</span></div>
      <div id="uProviders"></div>
    </div>

    <!-- 最近请求（对齐 cc-switch RequestLogTable，精简列） -->
    <div class="card">
      <div class="cardhead" style="margin-bottom:6px;">
        <h3>最近请求</h3>
        <button class="btn btn-ghost btn-sm btn-danger" id="uClear" title="清空全部用量统计">清空统计</button>
      </div>
      <div id="uRecent"></div>
    </div>
    <div class="hint">数据由本扩展在代理层直接记账，覆盖所有已连接 provider；不依赖上游的用量接口。明细保留 30 天 / 2000 条，汇总长期保留。</div>
  </div>

  <!-- ========== 设置页（整合提示词管理与本地端口设置，其他页面彻底移除本地端口卡片）========== -->
  <div class="tabpage hidden" id="page-settings">
    <!-- 提示词管理 -->
    <button class="btn btn-connect wide" id="showAddPrompt" title="添加提示词">
      <span class="ico">${ICONS.book}</span><span class="lbl">添加提示词</span>
    </button>
    <div class="card" style="margin-bottom:10px;">
      <div class="psum" id="promptSummary">--</div>
      <div class="search hidden" id="promptSearch">
        <input class="sq" id="promptQ" type="text" placeholder="搜索提示词名称、描述或内容…" spellcheck="false" autocomplete="off">
        <button class="sclear hidden" id="promptClr" title="清空">✕</button>
      </div>
      <div id="prompts"></div>
      <div class="hint">启用的提示词作为 system 注入每次请求；同一时间仅启用一条，即时生效。</div>
    </div>

    <!-- 本地端口与核心端点设置（仅在设置页显示） -->
    <div class="card">
      <div class="cardhead" style="margin-bottom:8px;">
        <h3>本地端口设置</h3>
      </div>
      <div class="row"><span class="key">代理监听端口</span><span class="val" id="ports">--</span></div>
      <div class="btns" style="margin-top:10px;">
        <button class="btn btn-ghost" id="log" style="flex:1;">打开日志</button>
        <button class="btn btn-ghost" id="catRefresh" style="flex:1;">刷新能力目录</button>
      </div>
      <div class="hint">与原版 API2Kiro 共用 Kiro 端点设置，同一时间只能一个生效；启用本扩展前请先关掉原版代理。能力目录来自 models.dev，用于判断模型是否支持图片、思考档位形态、上下文窗口。</div>
    </div>
    <div class="card">
      <div class="cardhead" style="margin-bottom:8px;">
        <h3>关于</h3>
        <span class="muted">v${version}</span>
      </div>
      <div class="btns" style="margin-top:2px;">
        <button class="btn btn-ghost" id="ghRepo" style="flex:1;">${ghSvg}GitHub 项目主页</button>
        <button class="btn btn-ghost" id="checkUpdate" style="flex:1;">检查更新</button>
      </div>
      <div class="hint">开源于 GitHub。点「检查更新」比对仓库最新 Release，有新版会提示你去 Release 页下载 .vsix。</div>
    </div>
  </div>

  <div class="toast" id="toast"></div>
  <div id="modalRoot"></div>
  <div id="kTip"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const ICON_BRAIN = ${JSON.stringify(ICONS.brain)};
  const ICON_IMAGE = ${JSON.stringify(ICONS.image)};
  const ICON_PENCIL = ${JSON.stringify(ICONS.pencil)};
  const ICON_TRASH = ${JSON.stringify(ICONS.trash)};
  const ICON_SQPEN = ${JSON.stringify(ICONS.squarePen)};
  const ICON_COPY = ${JSON.stringify(ICONS.copy)};
  const ICON_ACTIVITY = ${JSON.stringify(ICONS.activity)};
  const ICON_GRIP = ${JSON.stringify(ICONS.grip)};
  const ICON_CHIP = ${JSON.stringify(ICONS.chip)};
  const ICON_DOCCHECK = ${JSON.stringify(ICONS.docCheck)};
  const ICON_PLUS = ${JSON.stringify(ICONS.plus)};
  const ICON_PLUG = ${JSON.stringify(ICONS.plug)};
  const ICON_EYE = ${JSON.stringify(ICONS.eye)};
  const ICON_IMPORT = ${JSON.stringify(ICONS.import)};
  const ICON_EYE_OFF = ${JSON.stringify(ICONS.eyeOff)};
  // 厂商图标：assets/providers/<id>.<svg|png>（矢量来自 OpenCode / lobe 图标库，PNG 是官网 favicon 抠出的剪影），以 CSS mask 上色
  const ICON_BASE = ${JSON.stringify(iconBase)};
  const ICON_FILES = ${iconFiles};
  const ICON_IDS = new Set(Object.keys(ICON_FILES));
  // CC Switch 官方标（彩色 PNG）
  const CCSWITCH_LOGO = ${JSON.stringify(ccLogo)};
  // 选择弹窗直接列出的推荐家数（已连接的不算，从推荐榜往后补位）
  const RECOMMENDED_COUNT = ${RECOMMENDED_COUNT};
  // 自定义 Logo 图库：assets/glyphs/<name>.svg，iconId 写成 glyph:<name>
  const GLYPH_BASE = ${JSON.stringify(glyphBase)};
  const GLYPH_IDS = ${glyphIds};
  const GLYPH_SET = new Set(GLYPH_IDS);

  // Key 输入框：右侧一只眼睛切换明文/掩码。keyInput() 出 HTML，bindEyes(root) 装事件。
  function keyInput(cls, placeholder) {
    return '<div class="keywrap"><input class="' + cls + '" type="password" spellcheck="false" autocomplete="off" placeholder="' + esc(placeholder || '') + '">'
      + '<button type="button" class="eye" title="显示 Key" tabindex="-1">' + ICON_EYE + '</button></div>';
  }
  function bindEyes(root) {
    for (const w of root.querySelectorAll('.keywrap')) {
      const input = w.querySelector('input'), btn = w.querySelector('.eye');
      if (!input || !btn || btn.dataset.bound) continue;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
        btn.title = showing ? '显示 Key' : '隐藏 Key';
        btn.classList.toggle('on', !showing);
        input.focus();
      });
    }
  }
  // 能力标签的公共壳：图标 + 文字（+ 可选的判定符号）。窄栏下 CSS 会藏掉 .lbl 只留图标。
  function capChip(kind, label, state) {
    const el = document.createElement('span');
    el.innerHTML = '<span class="ico">' + (kind === 'reasoning' ? ICON_BRAIN : ICON_IMAGE) + '</span>'
      + '<span class="lbl">' + label + '</span>'
      + (state ? '<span class="st">' + state + '</span>' : '');
    return el;
  }
  let toastTimer = 0;
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
  const credits = (n) => (Number(n) || 0).toFixed(2) + ' credits';
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const show = (el, on) => el && el.classList.toggle('hidden', !on);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let modelCounts = {};
  let modelsByProvider = {};
  let lastProviders = [];
  let lastPresets = [];
  let lastVendors = [];
  let selectedModel = '';
  let proxyEnabled = false;

  // 页头徽章：插头 + 运行中的 provider 数 · 芯片 + 进入 Kiro 列表的模型数（提供商在前、模型在后，与 Tab 顺序一致）。
  // 宽时 图标+数字+文字，≤300px 只留 图标+数字；关闭 / 无可用 provider 时是一句红字。
  function renderBadge() {
    const b = $('statusBadge');
    if (!proxyEnabled) { b.textContent = '已关闭'; b.className = 'badge badge-off'; b.title = '代理已关闭，Kiro 走官方通道'; return; }
    const actives = lastProviders.filter((p) => p.enabled && p.usable);
    if (!actives.length) { b.textContent = '无可用 provider'; b.className = 'badge badge-off'; b.title = '没有启用且配置完整的 provider'; return; }
    let models = 0;
    for (const p of actives) models += (modelsByProvider[p.id] || []).filter((mm) => mm.enabled).length;
    b.className = 'badge badge-on';
    // 两段各用一色：模型=主题紫（同芯片 Tab），提供商=青（同「图片」标签 / 登录标签）；底是中性深色胶囊
    // 类名用 bi-m / bi-p：别叫 .models——页面上已有一个 .models（模型列表容器）规则，会把这段顶下去
    b.innerHTML =
      '<span class="bi bi-p"><span class="ico">' + ICON_PLUG + '</span><b>' + actives.length + '</b><span class="lbl">提供商</span></span>'
      + '<span class="sep"></span>'
      + '<span class="bi bi-m"><span class="ico">' + ICON_CHIP + '</span><b>' + models + '</b><span class="lbl">模型</span></span>';
    b.title = actives.length + ' 个 provider 运行中 · ' + models + ' 个模型已进入 Kiro 列表';
  }

  function toast(level, msg) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + level;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  // 已连接列表副标题里的接口格式：Anthropic / Chat / Responses（Anthropic 官方直通再标一下）
  const FORMAT_SHORT = { anthropic: 'Anthropic', chat: 'Chat', responses: 'Responses', gemini: 'Gemini', kiro: 'Kiro' };
  // 已连接列表副标题用全称，与「连接新 Provider」弹窗接口下拉里的叫法（FORMAT_LABEL）逐字一致；
  // 面板窄（≤460px，见 .fmt-abbr 的容器查询）时自动换成首字母缩写，悬停看全称
  const FORMAT_FULL = { chat: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', responses: 'OpenAI Responses', gemini: 'Google Gemini', kiro: 'Kiro CodeWhisperer' };
  const FORMAT_ABBR = { chat: 'OCC', anthropic: 'AM', responses: 'OR', gemini: 'GG', kiro: 'KC' };
  const fmtOf = (p) => p.format || (p.protocol === 'anthropic' ? 'anthropic' : p.protocol === 'gemini' ? 'gemini' : p.protocol === 'kiro' ? 'kiro' : (p.openaiApi === 'responses' ? 'responses' : 'chat'));
  // 「API 格式」值 → 扩展侧 protocol/openaiApi 字段
  const fmtFields = (fmt) => ({ protocol: fmt === 'anthropic' ? 'anthropic' : fmt === 'gemini' ? 'gemini' : 'openai', openaiApi: fmt === 'responses' ? 'responses' : 'chat' });
  const initialOf = (n) => (n || '?').trim().charAt(0).toUpperCase();

  // 头像：厂商标（OpenCode 图标库）/ 手选线稿（glyph:xxx，Lucide）都是无填充单色矢量，荧光紫 + 光晕；
  // 都没有就首字母——细环 + 字母的单色 monogram，同一套霓虹线条感。
  // 图标以 mask-image 引用 SVG：形状来自 SVG 的 alpha，颜色由 background 给，光晕打在外层（filter 在 mask 之后才算）。
  function iconUrl(iconId) {
    if (!iconId) return '';
    if (iconId.startsWith('glyph:')) { const g = iconId.slice(6); return GLYPH_SET.has(g) ? GLYPH_BASE + '/' + g + '.svg' : ''; }
    return ICON_IDS.has(iconId) ? ICON_BASE + '/' + iconId + '.' + ICON_FILES[iconId] : '';
  }
  // 目录里没标的厂商统一用 _provider（六边形节点）这枚占位标，不出首字母——列表里几十个字母头像太乱。
  const GENERIC_LOGO = '_provider';
  // fallbackId：iconId 对不上文件时退到的图（预设 / 目录厂商传 GENERIC_LOGO；自定义 provider 不传 → 首字母）
  function iconEl(name, iconId, fallbackId) {
    const s = document.createElement('span');
    let url = iconUrl(iconId);
    if (!url && fallbackId) { url = iconUrl(fallbackId); if (url) iconId = fallbackId; }
    if (url) {
      s.className = 'picon logo' + (iconId.startsWith('glyph:') ? ' glyph' : '') + (iconId === GENERIC_LOGO ? ' generic' : '');
      const m = document.createElement('i'); m.className = 'pmask';
      const u = 'url("' + url + '")';
      m.style.webkitMaskImage = u; m.style.maskImage = u;
      s.appendChild(m);
      return s;
    }
    s.className = 'picon mono'; s.textContent = initialOf(name); return s;
  }
  // 已连接 provider 的兜底标：从目录预设建的走占位标（和选择列表一致）；自定义 / 迁移来的保留首字母（用户可在 Logo 里改）
  function logoFallback(p) {
    const pid = (p && p.presetId) || '';
    return pid && !pid.startsWith('oauth-') && !/^(generic-|legacy-)/.test(pid) ? GENERIC_LOGO : '';
  }

  // Logo 选择器：当前 Logo + 「自动」说明，点开一格格的图库（几十个科技风线稿）。
  // opts: { value: 'glyph:xxx' | '', autoIconId, nameOf(): 首字母用的名字, onChange(v), preview(el) }
  // 图库展开/收起后要通知弹窗重新分配高度：拉大过的弹窗里，展开的图库应该吃掉多出来的空间。
  function iconPicker(opts) {
    let value = opts.value || '';
    const wrap = document.createElement('div'); wrap.className = 'ipick';
    const cur = document.createElement('button'); cur.className = 'ipick-cur'; cur.type = 'button';
    const grid = document.createElement('div'); grid.className = 'ipick-grid hidden';
    // 自动态：认出厂商标 → 官方 Logo；目录预设但没标 → 占位标；自定义 → 首字母
    const fb = opts.fallbackId || '';
    const autoDesc = () => (opts.autoIconId && iconUrl(opts.autoIconId)) ? '自动 · 厂商官方 Logo' : fb ? '自动 · 通用标' : '自动 · 首字母';
    const curIcon = () => iconEl(opts.nameOf(), value || opts.autoIconId || '', value ? '' : fb);
    function paintCur() {
      cur.innerHTML = '';
      cur.appendChild(curIcon());
      const t = document.createElement('span'); t.className = 'ipick-lbl'; t.textContent = value ? ('图库 · ' + value.slice(6)) : autoDesc(); cur.appendChild(t);
      const ch = document.createElement('span'); ch.className = 'chev'; ch.textContent = grid.classList.contains('hidden') ? '▾' : '▴'; cur.appendChild(ch);
      grid.querySelectorAll('.ipick-cell').forEach((c) => c.classList.toggle('sel', (c.dataset.v || '') === value));
      // 「自动」格跟着名字/自动认出的标变（自定义弹窗里边打名字边变首字母）
      const auto = grid.querySelector('.ipick-cell[data-v=""]');
      if (auto) { auto.innerHTML = ''; auto.appendChild(iconEl(opts.nameOf(), opts.autoIconId || '', fb)); auto.title = autoDesc(); }
      if (opts.preview) opts.preview(curIcon());
    }
    function cell(v, title) {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'ipick-cell'; c.dataset.v = v; c.title = title;
      c.appendChild(iconEl(opts.nameOf(), v || opts.autoIconId || '', v ? '' : fb));
      c.addEventListener('click', () => { value = v; grid.classList.add('hidden'); paintCur(); refit(); if (opts.onChange) opts.onChange(value); });
      return c;
    }
    const refit = () => { const m = wrap.closest('.modal'); if (m) requestAnimationFrame(() => fitModalContent(m)); };
    grid.appendChild(cell('', autoDesc()));
    for (const g of GLYPH_IDS) grid.appendChild(cell('glyph:' + g, g));
    cur.addEventListener('click', () => { grid.classList.toggle('hidden'); paintCur(); refit(); });
    wrap.appendChild(cur); wrap.appendChild(grid);
    paintCur();
    return { el: wrap, get value() { return value; }, repaint: paintCur };
  }

  // ---------- 已连接列表：一行一个；行尾三个图标：编辑 / 创建副本 / 测延迟 ----------
  // 行内测延迟的状态：{ [providerId]: { cls:'run'|'ok'|'bad', text } }，结果写进副标题末尾。
  const rowLatency = {};
  const latencyReqs = {}; // reqId → providerId，probeResult 回来据此找行
  function renderProviders(providers) {
    // 拖拽进行中不能重画（会把正在跟手的行换掉），记下来等松手再画
    if (drag && drag.active) { drag.pendingRender = true; return; }
    const wrap = $('providers'); wrap.innerHTML = '';
    if (!(providers || []).length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = '还没有连接任何 provider。点上方「连接新 Provider」。';
      wrap.appendChild(e); return;
    }
    for (const p of providers) {
      const count = modelCounts[p.id];
      const oauth = p.auth === 'oauth';
      // 登录类：未登录 / 登录失效 都算"待处理"，副标题直说该干什么。
      // 正常态（就绪 / 已登录）不写字——绿点已经说明了，副标题只留有信息量的内容。
      const dot = !p.enabled ? 'off' : p.usable && !(oauth && p.loginState === 'expired') ? 'ok' : 'idle';
      const isExpired = oauth && p.loginState === 'expired';
      const statusTxt = !p.enabled ? '已停用'
        : oauth ? (p.loginState === 'ok' ? '' : isExpired ? '' : '未登录')
        : p.usable ? '' : '待配置';
      // 副标题 = 📄✓ 接口格式全称 · ▦ 已选/总数 · [异常状态]。登录类不显示账号（编辑弹窗的账号池里有）。
      const fmt = fmtOf(p);
      const fmtFull = FORMAT_FULL[fmt] || 'OpenAI Chat Completions';
      const official = p.protocol === 'anthropic' && p.anthropicMode === 'official';
      const subParts = [];
      subParts.push({ icon: ICON_DOCCHECK, full: fmtFull, abbr: FORMAT_ABBR[fmt] || 'OCC', text: official ? ' · 官方' : '', tip: '接口格式：' + fmtFull + (official ? '（官方直通）' : '') });
      if (count) subParts.push({ icon: ICON_CHIP, text: count.enabled + '/' + count.total, tip: '已选 ' + count.enabled + ' / ' + count.total + ' 个模型' });
      if (statusTxt) subParts.push({ text: statusTxt });
      const row = document.createElement('div'); row.className = 'lrow'; row.dataset.id = p.id;
      // 拖柄：按住上下拖动调整顺序（cc-switch 同款六点）。顺序决定同名模型归哪个渠道。
      const grip = document.createElement('span'); grip.className = 'grip'; grip.innerHTML = ICON_GRIP; grip.title = '拖动调整顺序（同名模型按靠前的渠道路由）';
      grip.addEventListener('pointerdown', (e) => startDrag(e, row));
      row.appendChild(grip);

      // 状态圆点：统一直径 8px 小圆点，纯粹展示连接就绪状态，不挂载多余数字
      const dotTip = dot === 'ok' ? '就绪' : dot === 'idle' ? '待处理' : '已停用';
      row.appendChild(dotEl(dot, dotTip));

      row.appendChild(iconEl(p.name, p.iconId, logoFallback(p)));
      const t = document.createElement('div'); t.className = 'ltext';
      const n = document.createElement('div'); n.className = 'ln';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name; nm.title = p.name; n.appendChild(nm);
      // 测延迟结果：完成时做成名字旁的小胶囊（测速中在按钮上转圈，不显示气泡）；
      // 失败时胶囊显示 Error / 耗时，详细报错挂在 hover 提示上
      const lat = rowLatency[p.id];
      if (lat && lat.cls !== 'run') {
        const l = document.createElement('span'); l.className = 'latpill ' + lat.cls;
        l.innerHTML = lat.cls === 'bad' ? esc(lat.short || 'Error') : esc(lat.text);
        l.title = lat.title || lat.text || '';
        n.appendChild(l);
      }
      // 登录失效提示：移出副标题，放在 Error / 警告胶囊右侧，加文字不加框
      if (isExpired) {
        const wp = document.createElement('span');
        wp.className = 'warntext';
        wp.textContent = '登录失效，请重新登录';
        wp.title = p.loginError || '登录凭证已失效，点击右侧编辑重新登录账号';
        n.appendChild(wp);
      }
      const s = document.createElement('div'); s.className = 'ls';
      subParts.forEach((sp, i) => {
        if (i) { const d = document.createElement('span'); d.className = 'lsep'; d.textContent = ' · '; s.appendChild(d); }
        const g = document.createElement('span'); g.className = 'lsg';
        if (sp.icon) { const ic = document.createElement('span'); ic.className = 'lsi'; ic.innerHTML = sp.icon; g.appendChild(ic); }
        if (sp.full) {
          // 全称与缩写都渲染，由容器查询按面板宽度只显示其一
          const f = document.createElement('span'); f.className = 'fmt-full'; f.textContent = sp.full; g.appendChild(f);
          const a = document.createElement('span'); a.className = 'fmt-abbr'; a.textContent = sp.abbr; g.appendChild(a);
        }
        if (sp.text) { const tx = document.createElement('span'); tx.className = 'lstxt'; tx.textContent = sp.text; g.appendChild(tx); }
        if (sp.tip) g.title = sp.tip;
        s.appendChild(g);
      });
      // 文字列被收起（logoonly）时，名字与副标题挂在 logo 的悬停提示上
      const plain = subParts.map((sp) => (sp.full ? sp.full : '') + (sp.text || '')).filter(Boolean).join(' · ');
      const picon = row.querySelector('.picon');
      if (picon) picon.title = p.name + (plain ? ' — ' + plain : '');
      t.appendChild(n); t.appendChild(s);
      row.appendChild(t);
      const act = document.createElement('div'); act.className = 'lact';
      const sw = document.createElement('label'); sw.className = 'switch'; sw.title = p.enabled ? '停用' : '启用';
      sw.innerHTML = '<input type="checkbox"><span class="slider"></span>';
      const chk = sw.querySelector('input'); chk.checked = !!p.enabled;
      chk.addEventListener('change', (e) => vscode.postMessage({ type: 'toggleProvider', id: p.id, enabled: e.target.checked }));
      act.appendChild(sw);
      const mk = (icon, title, cls, onClick) => {
        const b = document.createElement('button'); b.className = 'iconbtn rowact' + (cls ? ' ' + cls : ''); b.title = title; b.setAttribute('aria-label', title); b.innerHTML = icon;
        b.addEventListener('click', onClick); act.appendChild(b); return b;
      };
      mk(ICON_SQPEN, '编辑', '', () => openEditModal(p));
      mk(ICON_COPY, '创建副本（整份配置照抄，默认不启用）', '', () => vscode.postMessage({ type: 'duplicateProvider', id: p.id }));
      const isRunning = !!(lat && lat.cls === 'run');
      const lb = mk(isRunning ? '<span class="spin"></span>' : ICON_ACTIVITY, isRunning ? '正在测速…' : (p.usable ? '测量延迟（GET /models）' : (oauth ? '先登录' : '先补全地址与 Key')), isRunning ? 'run' : '', () => {
        if (!p.usable) { toast('error', oauth ? '先登录再测' : '先补全地址与 Key 再测'); return; }
        const reqId = 'row' + (++probeSeq);
        latencyReqs[reqId] = p.id;
        rowLatency[p.id] = { cls: 'run' };
        renderProviders(lastProviders);
        vscode.postMessage({ type: 'probeLatency', reqId, draft: { id: p.id } });
      });
      if (isRunning) lb.disabled = true;
      mk(ICON_TRASH, '删除（会先确认）', 'del', () => confirmDeleteProvider(p));
      row.appendChild(act);
      wrap.appendChild(row);
    }
    fitProviderText();
  }
  // 窄面板下已连接列表的分级收缩（全列表统一切换，不逐行——有的行有字有的行没字会显得坏了）：
  //   全称 → 缩写（容器查询 ≤460px）→ 文字列窄到放不下缩写副标题：副标题只留简笔画（glyphonly）
  //   → 文字列窄到名字只剩两三个字：整列文字隐藏，只留 logo（logoonly）。
  // 按**文字列的可用宽度**分档，不看某一行是否溢出：一个超长名字不该把整列都收起来——有像样的宽度时
  // 长名字截断显示就好（用户原话：明明还有足够的空间显示部分遮挡的信息）。
  // 先把两个收缩态摘掉再量，同一个任务里改回去，中间不会闪。
  const TEXT_COL_GLYPH_BELOW = 96; // 缩写副标题「OCC · ▦ 7/422」约 84px，再窄就只留两枚简笔画
  const TEXT_COL_LOGO_BELOW = 56;  // 名字只剩 2～3 个汉字 / 7 个字母时，文字已没有辨认价值
  function fitProviderText() {
    const wrap = $('providers');
    if (!wrap) return;
    wrap.classList.remove('glyphonly', 'logoonly');
    // 各行布局一致，量第一条 .lrow 的 .ltext 即可
    const row = wrap.querySelector('.lrow');
    const col = row && row.querySelector('.ltext');
    if (!col) return;
    const w = col.clientWidth;
    if (w <= 0) return; // 容器查询已把文字列整个藏了（≤250px），不用再判
    if (w < TEXT_COL_LOGO_BELOW) wrap.classList.add('logoonly');
    else if (w < TEXT_COL_GLYPH_BELOW) wrap.classList.add('glyphonly');
  }
  if (window.ResizeObserver) {
    // 只在宽度真的变了才重算（高度变化、滚动条出现等不触发），与用量页桑基的 ResizeObserver 同一做法
    let fitRaf = 0, fitLastW = 0;
    new ResizeObserver(() => {
      const w = document.documentElement.clientWidth;
      if (!w || w === fitLastW) return;
      fitLastW = w;
      cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitProviderText);
    }).observe(document.documentElement);
  } else {
    window.addEventListener('resize', fitProviderText);
  }
  // ---------- 拖拽排序：dnd-kit（cc-switch）同款手感，全部用 transform 做 ----------
  //  · 按住拖柄移动超过 6px 才算开始（activationConstraint.distance），误触不会抖；
  //  · 被拖的行**本身**跟着指针走（translateY + 轻微放大 + 阴影），DOM 不动；
  //  · 其它行在被拖行的中心越过它们中心时，用 200ms 过渡上下让位（verticalListSortingStrategy）；
  //  · 松手后被拖行 200ms 滑进目标槽位，再按新顺序重画并写回（dnd-kit 的 drop animation）。
  const DRAG_ACTIVATE_PX = 6;
  // ---------- 拖拽期间的页面滚动（两种拖拽共用） ----------
  //  · 位移一律按文档坐标算：dy = 指针位移 + 拖拽开始以来的页面滚动量。这样滚动时被拖项始终贴着指针，
  //    落点跟着滚动变化（否则被拖项会随内容滚走，滚轮对落点毫无作用）。
  //  · 拖拽中滚轮：显式滚页面（不依赖默认行为），再按最近一次指针位置重算。
  //  · 拖到视口上下边缘 DRAG_EDGE_PX 内：按距离比例自动滚（dnd-kit autoScroll 同款），离开边缘即停。
  const DRAG_EDGE_PX = 40;
  const DRAG_EDGE_MAX_SPEED = 16; // px / frame
  const pageScrollTop = () => (document.scrollingElement || document.documentElement).scrollTop;
  let dragScroll = null; // { lastY, startScroll, recompute, raf }
  function dragScrollStart(startY, recompute) {
    dragScroll = { lastY: startY, startScroll: pageScrollTop(), recompute, raf: 0 };
    window.addEventListener('wheel', onDragWheel, { passive: false });
    window.addEventListener('scroll', onDragScrolled, { passive: true });
    const tick = () => {
      if (!dragScroll) return;
      dragScroll.raf = requestAnimationFrame(tick);
      const y = dragScroll.lastY, h = window.innerHeight;
      let v = 0;
      if (y < DRAG_EDGE_PX) v = -Math.ceil(DRAG_EDGE_MAX_SPEED * (DRAG_EDGE_PX - Math.max(0, y)) / DRAG_EDGE_PX);
      else if (y > h - DRAG_EDGE_PX) v = Math.ceil(DRAG_EDGE_MAX_SPEED * (y - (h - DRAG_EDGE_PX)) / DRAG_EDGE_PX);
      if (!v) return;
      const before = pageScrollTop();
      window.scrollBy(0, v);
      if (pageScrollTop() !== before) dragScroll.recompute();
    };
    dragScroll.raf = requestAnimationFrame(tick);
  }
  function dragScrollStop() {
    if (!dragScroll) return;
    cancelAnimationFrame(dragScroll.raf);
    window.removeEventListener('wheel', onDragWheel);
    window.removeEventListener('scroll', onDragScrolled);
    dragScroll = null;
  }
  /** 拖拽开始以来页面滚动了多少（文档坐标位移的滚动分量）。 */
  const dragScrollDelta = () => (dragScroll ? pageScrollTop() - dragScroll.startScroll : 0);
  function onDragWheel(e) {
    if (!dragScroll) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
    window.scrollBy(0, step);
    dragScroll.recompute();
  }
  function onDragScrolled() {
    if (dragScroll) dragScroll.recompute();
  }

  let drag = null; // { row, rows:[{el,top,height,center}], a, startY, active, pendingRender, newIdx }
  function startDrag(e, row) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const list = $('providers');
    const els = Array.from(list.querySelectorAll('.lrow'));
    const rows = els.map((el) => { const r = el.getBoundingClientRect(); return { el, top: r.top, height: r.height, center: r.top + r.height / 2 }; });
    const a = els.indexOf(row);
    if (a < 0) return;
    drag = { row, rows, a, startY: e.clientY, active: false, pendingRender: false, newIdx: a, list };
    dragScrollStart(e.clientY, () => { if (drag && dragScroll) onDragMove({ clientY: dragScroll.lastY }); });
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }
  function onDragMove(e) {
    if (!drag) return;
    if (!drag.row.isConnected) { cancelDrag(); return; }
    if (dragScroll) dragScroll.lastY = e.clientY;
    const dy = e.clientY - drag.startY + dragScrollDelta();
    if (!drag.active) {
      if (Math.abs(dy) < DRAG_ACTIVATE_PX) return;
      drag.active = true;
      drag.list.classList.add('sorting');
      drag.row.classList.add('dragging');
      document.body.classList.add('nosel', 'grabbing');
    }
    const { rows, a } = drag;
    const activeH = rows[a].height;
    const activeCenter = rows[a].center + dy;
    // 目标槽位 = 有多少个其它行的中心在被拖行中心之上
    let newIdx = 0;
    rows.forEach((r, i) => { if (i !== a && r.center < activeCenter) newIdx++; });
    drag.newIdx = newIdx;
    rows.forEach((r, i) => {
      if (i === a) return;
      let shift = 0;
      if (i < a && i >= newIdx) shift = activeH;        // 被拖行往上走，它们让到下面
      else if (i > a && i <= newIdx) shift = -activeH;  // 被拖行往下走，它们让到上面
      r.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
    drag.row.style.transform = 'translateY(' + dy + 'px) scale(1.02)';
  }
  function cancelDrag() {
    if (!drag) return;
    dragScrollStop();
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('nosel', 'grabbing');
    const d = drag; drag = null;
    d.list.classList.remove('sorting');
    for (const r of d.rows) { r.el.style.transform = ''; r.el.classList.remove('dragging', 'dropping'); }
    if (d.pendingRender) renderProviders(lastProviders);
  }
  function endDrag() {
    if (!drag) return;
    dragScrollStop();
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('nosel', 'grabbing');
    if (!drag.active) { drag = null; return; } // 没动到激活阈值：什么都没发生
    const d = drag; drag = null;
    const { rows, a, newIdx } = d;
    // 被拖行滑到目标槽位：目标偏移 = 途经各行高度之和
    let target = 0;
    if (newIdx > a) for (let i = a + 1; i <= newIdx; i++) target += rows[i].height;
    else if (newIdx < a) for (let i = newIdx; i < a; i++) target -= rows[i].height;
    d.row.classList.add('dropping');
    d.row.style.transform = 'translateY(' + target + 'px)';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      d.row.removeEventListener('transitionend', finish);
      d.list.classList.remove('sorting');
      for (const r of rows) { r.el.style.transform = ''; r.el.classList.remove('dragging', 'dropping'); }
      if (newIdx !== a) {
        const ids = rows.map((r) => r.el.dataset.id);
        const [moved] = ids.splice(a, 1); ids.splice(newIdx, 0, moved);
        // 乐观：本地 lastProviders 先按新顺序排好，扩展回来的 state 再对齐
        const pos = {}; ids.forEach((id, i) => { pos[id] = i; });
        lastProviders.sort((x, y) => (pos[x.id] ?? 1e9) - (pos[y.id] ?? 1e9));
        renderProviders(lastProviders); renderModels();
        vscode.postMessage({ type: 'reorderProviders', ids });
      } else if (d.pendingRender) {
        renderProviders(lastProviders);
      }
    };
    d.row.addEventListener('transitionend', finish);
    setTimeout(finish, 260); // transitionend 偶尔不触发（被重画/隐藏），兜一手
  }

  // ---------- 模型页渠道卡整组拖拽排序（标题区域按住拖动改变渠道顺序） ----------
  let groupDrag = null;
  function startGroupDrag(e, card) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('.ck') || e.target.closest('button') || e.target.closest('input')) return;
    const list = $('selectedList');
    if (!list) return;
    const cards = Array.from(list.querySelectorAll('.mgroup'));
    if (cards.length <= 1) return;
    const a = cards.indexOf(card);
    if (a < 0) return;
    const rows = cards.map((el) => {
      const r = el.getBoundingClientRect();
      return { el, top: r.top, height: r.height, center: r.top + r.height / 2 };
    });
    groupDrag = { card, rows, a, startY: e.clientY, active: false, newIdx: a, list, moved: false };
    dragScrollStart(e.clientY, () => { if (groupDrag && dragScroll) onGroupDragMove({ clientY: dragScroll.lastY }); });
    window.addEventListener('pointermove', onGroupDragMove);
    window.addEventListener('pointerup', endGroupDrag);
    window.addEventListener('pointercancel', endGroupDrag);
  }
  function onGroupDragMove(e) {
    if (!groupDrag) return;
    if (!groupDrag.card.isConnected) { cancelGroupDrag(); return; }
    if (dragScroll) dragScroll.lastY = e.clientY;
    const dy = e.clientY - groupDrag.startY + dragScrollDelta();
    if (!groupDrag.active) {
      if (Math.abs(dy) < DRAG_ACTIVATE_PX) return;
      groupDrag.active = true;
      groupDrag.moved = true;
      groupDrag.list.classList.add('sorting');
      groupDrag.card.classList.add('dragging');
      document.body.classList.add('nosel', 'grabbing');
    }
    const { rows, a } = groupDrag;
    const activeH = rows[a].height;
    const activeCenter = rows[a].center + dy;
    let newIdx = 0;
    rows.forEach((r, i) => { if (i !== a && r.center < activeCenter) newIdx++; });
    groupDrag.newIdx = newIdx;
    rows.forEach((r, i) => {
      if (i === a) return;
      let shift = 0;
      if (i < a && i >= newIdx) shift = activeH + 8;
      else if (i > a && i <= newIdx) shift = -(activeH + 8);
      r.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
    groupDrag.card.style.transform = 'translateY(' + dy + 'px) scale(1.015)';
  }
  function cancelGroupDrag() {
    if (!groupDrag) return;
    dragScrollStop();
    window.removeEventListener('pointermove', onGroupDragMove);
    window.removeEventListener('pointerup', endGroupDrag);
    window.removeEventListener('pointercancel', endGroupDrag);
    document.body.classList.remove('nosel', 'grabbing');
    const d = groupDrag; groupDrag = null;
    d.list.classList.remove('sorting');
    for (const r of d.rows) { r.el.style.transform = ''; r.el.classList.remove('dragging', 'dropping'); }
  }
  function endGroupDrag(e) {
    if (!groupDrag) return;
    dragScrollStop();
    window.removeEventListener('pointermove', onGroupDragMove);
    window.removeEventListener('pointerup', endGroupDrag);
    window.removeEventListener('pointercancel', endGroupDrag);
    document.body.classList.remove('nosel', 'grabbing');
    if (!groupDrag.active) {
      // 没达到拖动激活阈值：视作普通点击，触发折叠切换
      const card = groupDrag.card;
      const pid = card.dataset.id;
      groupDrag = null;
      if (pid) {
        groupOpen[pid] = !isGroupOpen(pid);
        card.classList.toggle('open', groupOpen[pid]);
        const b = card.querySelector('.gbody');
        if (b) b.classList.toggle('collapsed', !groupOpen[pid]);
      }
      return;
    }
    const d = groupDrag; groupDrag = null;
    const { rows, a, newIdx } = d;
    let target = 0;
    if (newIdx > a) for (let i = a + 1; i <= newIdx; i++) target += rows[i].height + 8;
    else if (newIdx < a) for (let i = newIdx; i < a; i++) target -= (rows[i].height + 8);
    d.card.classList.add('dropping');
    d.card.style.transform = 'translateY(' + target + 'px)';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      d.card.removeEventListener('transitionend', finish);
      d.list.classList.remove('sorting');
      for (const r of rows) { r.el.style.transform = ''; r.el.classList.remove('dragging', 'dropping'); }
      if (newIdx !== a) {
        const pids = rows.map((r) => r.el.dataset.id);
        const [moved] = pids.splice(a, 1);
        pids.splice(newIdx, 0, moved);
        // 按页面上拖拽后的渠道顺序重排 lastProviders
        const pos = {};
        pids.forEach((id, i) => { pos[id] = i; });
        lastProviders.sort((x, y) => (pos[x.id] ?? 1e9) - (pos[y.id] ?? 1e9));
        // 全量 Provider 顺序：被排的保持新相对顺序，其他未选/停用的原样补齐
        const fullIds = lastProviders.map((x) => x.id);
        renderProviders(lastProviders);
        renderModels();
        vscode.postMessage({ type: 'reorderProviders', ids: fullIds });
      }
    };
    d.card.addEventListener('transitionend', finish);
    setTimeout(finish, 260);
  }

  // ---------- 被省略号截断的单行文字：悬停片刻后慢慢横向滚到末尾，移开归位。
  // 通用规则：凡 text-overflow:ellipsis + overflow:hidden + nowrap 且真的溢出的元素都算，
  // 不用逐个登记（模型名 / provider 名 / 副标题 / 测活结果 / 用量表格…）。 ----------
  let mq = null; // { el, raf, timer }
  function mqStop() {
    if (!mq) return;
    cancelAnimationFrame(mq.raf); clearTimeout(mq.timer);
    mq.el.classList.remove('mq-on'); mq.el.scrollLeft = 0;
    mq = null;
  }
  function mqFind(t) {
    for (let el = t, i = 0; el && el.nodeType === 1 && i < 6; el = el.parentElement, i++) {
      if (el.scrollWidth - el.clientWidth <= 2) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' && (cs.overflowX === 'hidden' || cs.overflowX === 'auto')) return el;
    }
    return null;
  }
  document.addEventListener('mouseover', (e) => {
    if (mq && !mq.el.isConnected) mqStop();
    const el = mqFind(e.target);
    if (!el) { if (mq && !mq.el.contains(e.target)) mqStop(); return; }
    if (mq && mq.el === el) return;
    mqStop();
    const dist = el.scrollWidth - el.clientWidth;
    mq = { el, raf: 0, timer: 0 };
    mq.timer = setTimeout(() => {
      if (!mq || mq.el !== el || !el.isConnected) return;
      el.classList.add('mq-on'); // 滚动期间去掉省略号，否则末尾几个字始终被它盖住
      const dur = Math.max(500, dist * 14); // ≈70px/s，越长滚得越久
      const t0 = performance.now();
      const step = (t) => {
        if (!mq || mq.el !== el) return;
        if (!el.isConnected) { mqStop(); return; }
        const k = Math.min(1, (t - t0) / dur);
        el.scrollLeft = Math.round(dist * k);
        if (k < 1) mq.raf = requestAnimationFrame(step);
      };
      mq.raf = requestAnimationFrame(step);
    }, 350);
  });
  document.addEventListener('mouseout', (e) => {
    if (!mq) return;
    if (!e.relatedTarget || !mq.el.contains(e.relatedTarget)) {
      // 真离开了这段文字（不是在它内部的子元素间移动）
      if (mq.el === e.target || mq.el.contains(e.target)) mqStop();
    }
  });

  // ---------- Kiro 风格悬浮气泡提示 (Custom Floating Tooltip) ----------
  const kTipEl = document.getElementById('kTip');
  let kTipTarget = null;
  let kTipTimer = null;

  // isHtml：只有元素显式带 data-k-tip-html="1"（趋势图的富文本卡片）才按 HTML 渲染；其余一律当纯文本，
  // provider 名 / 报错文案等上游字符串以 '<' 开头也不会被解析成标签
  function showKTip(text, targetEl, clientX, clientY, isHtml) {
    if (!kTipEl || !text) return;
    const sText = String(text);
    if (isHtml) {
      kTipEl.innerHTML = sText;
    } else {
      const nl = String.fromCharCode(10);
      const cr = String.fromCharCode(13);
      // 提取显式换行并在行内保持天然不折断（避免单个字被无故折到下一行）
      const rawLines = sText.split(cr).join('').split(nl).join(String.fromCharCode(9999)).split('&#10;').join(String.fromCharCode(9999)).split(String.fromCharCode(9999));
      const htmlLines = rawLines.map((l) => '<div class="tip-row">' + esc(l) + '</div>').join('');
      kTipEl.innerHTML = htmlLines;
    }
    kTipEl.classList.add('show');
    const pos = calcTipPos(targetEl, clientX, clientY);
    kTipEl.style.left = pos.left + 'px';
    kTipEl.style.top = pos.top + 'px';
  }

  function calcTipPos(targetEl, clientX, clientY) {
    const tipW = kTipEl ? (kTipEl.offsetWidth || 180) : 180;
    const tipH = kTipEl ? (kTipEl.offsetHeight || 36) : 36;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const margin = 8;

    let left = 0;
    let top = 0;

    if (clientX != null && clientY != null) {
      // 智能水平双向避让：鼠标靠右时向左弹出，靠左时向右弹出，绝不挤成细条
      if (clientX + tipW + margin + 10 > winW) {
        left = clientX - tipW - 12;
      } else {
        left = clientX + 12;
      }

      // 智能垂直双向避让：下方放不下时向上弹出
      if (clientY + tipH + margin + 14 > winH) {
        top = clientY - tipH - 8;
      } else {
        top = clientY + 14;
      }
    } else if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      left = rect.left + rect.width / 2 - tipW / 2;
      top = rect.bottom + 6;
      if (top + tipH > winH - margin) {
        top = rect.top - tipH - 6;
      }
    }

    // 屏幕物理边界防越界安全约束
    left = Math.max(margin, Math.min(winW - tipW - margin, left));
    top = Math.max(margin, Math.min(winH - tipH - margin, top));
    return { left: Math.round(left), top: Math.round(top) };
  }

  function hideKTip() {
    if (kTipTimer) {
      clearTimeout(kTipTimer);
      kTipTimer = null;
    }
    if (kTipEl) kTipEl.classList.remove('show');
    kTipTarget = null;
  }

  // 统一捕获阶段监听 mouseover，确保无论 SVG 内部还是 HTML 元素均 100% 触发
  document.addEventListener('mouseover', (e) => {
    // 自动寻找最近的带有 title 或 data-k-tip 属性的元素
    let t = e.target;
    while (t && t !== document.body && t !== document.documentElement) {
      if ((t.getAttribute && (t.getAttribute('title') || t.getAttribute('data-k-tip'))) || (t.dataset && t.dataset.kTip)) {
        break;
      }
      t = t.parentElement || (t.parentNode && t.parentNode.nodeType === 1 ? t.parentNode : null);
    }
    if (!t || t === document.body || t === document.documentElement) {
      if (kTipTarget && !kTipTarget.contains(e.target)) hideKTip();
      return;
    }
    if (kTipTarget === t) return;
    hideKTip();

    const tip = (t.getAttribute && t.getAttribute('data-k-tip')) || (t.dataset && t.dataset.kTip) || (t.getAttribute && t.getAttribute('title'));
    if (!tip || !tip.trim()) return;

    kTipTarget = t;
    // 永久保存在 data-k-tip 中，同时清空原生 title 避免浏览器黄色小标签干扰；
    // 摘 title 前把文案写进 aria-label（没有可读名字的图标按钮等才写，有文字的元素保留自己的文字作名字）
    if (t.setAttribute) t.setAttribute('data-k-tip', tip);
    if (t.removeAttribute && t.hasAttribute('title')) {
      if (t.setAttribute && !t.getAttribute('aria-label') && !(t.textContent || '').trim()) t.setAttribute('aria-label', tip);
      t.removeAttribute('title');
    }
    const isHtml = !!(t.getAttribute && t.getAttribute('data-k-tip-html') === '1');

    kTipTimer = setTimeout(() => {
      if (kTipTarget === t && t.isConnected) {
        showKTip(tip, t, e.clientX, e.clientY, isHtml);
      }
    }, 60);
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!kTipTarget || !kTipEl || !kTipEl.classList.contains('show')) return;
    const pos = calcTipPos(kTipTarget, e.clientX, e.clientY);
    kTipEl.style.left = pos.left + 'px';
    kTipEl.style.top = pos.top + 'px';
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (kTipTarget && (!e.relatedTarget || !kTipTarget.contains(e.relatedTarget))) {
      hideKTip();
    }
  }, true);

  function confirmDeleteProvider(p) {
    const oauth = p.auth === 'oauth';
    confirmModal({
      icon: p.name, iconId: p.iconId, fallbackId: logoFallback(p), title: '删除「' + p.name + '」？',
      desc: (oauth ? '其登录凭据' : '其 API Key') + '、已选模型与能力设置会一并移除，不可恢复。',
      okText: '删除', danger: true,
      onOk: () => vscode.postMessage({ type: 'deleteProvider', id: p.id, confirmed: true }),
    });
  }

  // 行内测延迟的回包（弹窗里的探测面板另有自己的 reqId，互不干扰）
  function onRowLatency(m) {
    const pid = latencyReqs[m.reqId];
    if (!pid) return false;
    delete latencyReqs[m.reqId];
    const fullErr = (m.note ? m.note + '：' : '') + (m.error || '失败');
    rowLatency[pid] = m.ok
      ? (m.note
          ? { cls: 'warn', text: m.ms + ' ms ⚠', title: m.note + '（HTTP ' + m.status + '）' }
          : { cls: 'ok', text: m.ms + ' ms', title: 'HTTP ' + m.status })
      : { cls: 'bad', short: m.ms >= 0 ? m.ms + ' ms Error' : 'Error', text: fullErr, title: fullErr };
    renderProviders(lastProviders);
    return true;
  }
  function dotEl(cls, title) {
    const d = document.createElement('span');
    d.className = 'pdot ' + cls;
    if (title) d.title = title;
    return d;
  }

  // ---------- 选择弹窗：「连接新 Provider」→ 列出可连的（含自定义）→ 点行进入连接弹窗 ----------
  // 对齐 Kilo 的 ProviderSelectDialog：自定义置顶，其余分「推荐 / 其他」，带搜索。
  // ---------- 选择弹窗公用件：预设行 / 登录厂商行 / 分组标题 ----------
  const CUSTOM_PRESET = { custom: true, name: '自定义 Provider', blurb: '填 Base URL + Key，接任意 Anthropic / OpenAI / Gemini 兼容端点' };
  // 预设行。compact=true 是「连接提供商」大列表里的紧凑样式（对齐 Kilo：一行一个，标 + 名字，不带说明）；
  // back 是连接弹窗里「返回」要回到的那一层（默认回「连接新 Provider」）
  function selRow(ps, compact, back) {
    const row = document.createElement('div'); row.className = 'selrow' + (compact ? ' compact' : '');
    // 自定义那一行用「圆环加号」标：新建/手填的意思；厂商预设用各家官方标，没有标的统一用占位标
    row.appendChild(iconEl(ps.custom ? '+' : ps.name, ps.custom ? 'glyph:plus-ring' : ps.iconId, ps.custom ? '' : GENERIC_LOGO));
    const t = document.createElement('div'); t.className = 'ltext';
    const n = document.createElement('div'); n.className = 'ln'; n.textContent = ps.name;
    if (ps.custom) { const tag = document.createElement('span'); tag.className = 'tag custom'; tag.textContent = '自定义'; tag.style.marginLeft = '6px'; n.appendChild(tag); }
    t.appendChild(n);
    if (!compact) { const s = document.createElement('div'); s.className = 'ls'; s.textContent = ps.blurb || ''; t.appendChild(s); }
    row.appendChild(t);
    if (!compact) { const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '›'; row.appendChild(plus); }
    row.addEventListener('click', () => openConnectModal(ps, back));
    return row;
  }
  // 登录厂商行：名字后面「设备授权 / 浏览器授权」胶囊，已登录过的标出账号数
  function vendorRow(v) {
    const row = document.createElement('div'); row.className = 'selrow';
    row.appendChild(iconEl(v.name, v.iconId));
    const t = document.createElement('div'); t.className = 'ltext';
    const n = document.createElement('div'); n.className = 'ln'; n.textContent = v.name;
    const tag = document.createElement('span'); tag.className = 'tag oauth'; tag.textContent = v.flow === 'device' ? '设备授权' : v.flow === 'import' ? (Array.isArray(v.loginModes) && v.loginModes.length > 1 ? '导入 / 浏览器授权' : '本机登录态') : '浏览器授权'; tag.style.marginLeft = '6px'; n.appendChild(tag);
    const have = lastProviders.filter((p) => p.auth === 'oauth' && p.oauthVendor === v.id).length;
    const s = document.createElement('div'); s.className = 'ls'; s.textContent = (v.blurb || '') + (have ? ' · 已登录 ' + have + ' 个账号' : '');
    t.appendChild(n); t.appendChild(s); row.appendChild(t);
    const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '›'; row.appendChild(plus);
    row.addEventListener('click', () => openOAuthModal(v));
    return row;
  }
  // 有多种登录方式的厂商（Kiro 官方授权）：一种方式一行，名字是方式名、副标题是说明；点进去直接是该方式的弹窗
  function vendorModeRow(v, m, back) {
    const row = document.createElement('div'); row.className = 'selrow';
    row.appendChild(iconEl(v.name, v.iconId));
    const t = document.createElement('div'); t.className = 'ltext';
    const n = document.createElement('div'); n.className = 'ln'; n.textContent = m.label;
    const s = document.createElement('div'); s.className = 'ls'; s.textContent = m.hint || '';
    t.appendChild(n); t.appendChild(s); row.appendChild(t);
    const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '›'; row.appendChild(plus);
    row.addEventListener('click', () => openOAuthModal(v, undefined, undefined, m.id, back));
    return row;
  }
  // 一类接入方式一张卡（同模型页的渠道卡）：标题带 + 计数，行装在卡身里；点标题带折叠 / 展开，
  // 折叠状态按标题记住（本次面板会话内），搜索时一律展开。
  // defaultOpen：没记录时的初始态——「连接新 Provider」三组默认收起（用户要求这一页默认折叠），
  // 「查看更多供应商」大列表默认展开（收起来打开就是空的）。
  const selOpen = {};
  function selCard(list, title, count, forceOpen, defaultOpen = true) {
    const open = forceOpen || (selOpen[title] !== undefined ? selOpen[title] : defaultOpen);
    const card = document.createElement('div'); card.className = 'selcard' + (open ? ' open' : '');
    const head = document.createElement('div'); head.className = 'selcardhead';
    const ch = document.createElement('span'); ch.className = 'gchev'; ch.textContent = '▶'; head.appendChild(ch);
    const t = document.createElement('span'); t.className = 't'; t.textContent = title; head.appendChild(t);
    if (count != null && count !== '') { const c = document.createElement('span'); c.className = 'gcnt'; c.textContent = count; head.appendChild(c); }
    const body = document.createElement('div'); body.className = 'selcardbody' + (open ? '' : ' collapsed');
    head.title = open ? '点击折叠' : '点击展开';
    head.addEventListener('click', () => {
      const now = !card.classList.contains('open');
      selOpen[title] = now;
      card.classList.toggle('open', now); body.classList.toggle('collapsed', !now);
      head.title = now ? '点击折叠' : '点击展开';
      const m = card.closest('.modal'); if (m) requestAnimationFrame(() => fitModalContent(m));
    });
    card.appendChild(head); card.appendChild(body);
    list.appendChild(card);
    return body;
  }
  // 推荐榜上还没连接的前 N 家（榜比 N 长，连上几家就从后面补几家，永远凑齐 N）
  function recommended(avail, match) {
    return avail.filter((ps) => ps.popular && match(ps)).slice(0, RECOMMENDED_COUNT);
  }
  // 可连的预设：已连接的预设不再列出（同 Kilo：connected 的从可选里剔掉）
  function availPresets() {
    const connectedPresetIds = new Set(lastProviders.map((p) => p.presetId).filter(Boolean));
    return (lastPresets || []).filter((ps) => ps.baseUrl && !connectedPresetIds.has(ps.id));
  }
  function presetMatcher(kw) {
    return (ps) => !kw || ps.name.toLowerCase().includes(kw) || (ps.blurb || '').toLowerCase().includes(kw) || (ps.id || '').toLowerCase().includes(kw) || (ps.baseUrl || '').toLowerCase().includes(kw);
  }
  function searchBox(placeholder) {
    const box = document.createElement('div');
    box.innerHTML = '<div class="search"><input class="sq" type="text" placeholder="' + placeholder + '" spellcheck="false" autocomplete="off"><button class="sclear hidden" title="清空">✕</button></div><div class="sellist"></div>';
    return box;
  }

  // 连接新 Provider：四类接入方式
  //  · Kiro 官方登录：Kiro 自己的账号（导入本机登录 / 浏览器授权），不算第三方 —— 永远置顶
  //  · 自定义 Provider：任意兼容端点（同 Kilo / OpenCode 的 CUSTOM_PROVIDER_ID）
  //  · 第三方登录直连：用厂商账号登录，不用 Key —— Kimi / Codex / xAI / Antigravity / Anthropic
  //  · 第三方 Key 直连：只列 10 家推荐；其余一两百家（models.dev 登记的，对齐 OpenCode / Kilo）
  //    收进「查看更多供应商」弹窗；这里的搜索仍然跨全部
  function openSelectModal() {
    const modal = buildModal('+', '连接新 Provider', '');
    modal.classList.add('select');
    const box = searchBox('搜索 provider…');
    modal.appendChild(box);
    const q = box.querySelector('.sq'), clr = box.querySelector('.sclear'), list = box.querySelector('.sellist');
    function render() {
      const kw = (q.value || '').trim().toLowerCase();
      show(clr, kw.length > 0);
      list.innerHTML = '';
      const avail = availPresets();
      const match = presetMatcher(kw);
      // Kiro 自己的账号单独一组置顶；其余登录厂商才是「第三方」
      const official = (lastVendors || []).filter((v) => v.official && match(v));
      const oauth = (lastVendors || []).filter((v) => !v.official && match(v));
      // 不搜索：推荐榜前 10 家（连上的不算）+ 其余全部收进「查看更多」；搜索：命中的全列，推荐榜的在前
      const matched = avail.filter(match);
      const popular = kw ? matched.filter((ps) => ps.popular) : recommended(avail, match);
      const more = matched.filter((ps) => !popular.includes(ps));
      const force = kw.length > 0;
      const showCustom = match(CUSTOM_PRESET) || (!popular.length && !official.length && !oauth.length && !more.length && !kw);
      if (official.length) {
        // Kiro 官方授权：五种方式一行一个（OAuth 授权 / 本地导入 / Kiro Access Token / JSON 登录 / API Key 登录）
        const rows = official.flatMap((v) => (Array.isArray(v.loginModes) && v.loginModes.length > 1 ? v.loginModes.map((m) => vendorModeRow(v, m, openSelectModal)) : [vendorRow(v)]));
        const b = selCard(list, 'Kiro 官方授权', rows.length > 1 ? rows.length : null, force, false);
        for (const r of rows) b.appendChild(r);
      }
      if (showCustom) { selCard(list, '自定义', null, force, false).appendChild(selRow(CUSTOM_PRESET)); }
      if (oauth.length) { const b = selCard(list, '第三方登录直连', oauth.length, force, false); for (const v of oauth) b.appendChild(vendorRow(v)); }
      // 搜索时推荐榜里没命中就不建这张卡（否则是一张空的「第三方 Key 直连 0」），命中的全在下面「更多提供商」
      if (popular.length || (!kw && more.length)) {
        const b = selCard(list, '第三方 Key 直连', kw ? popular.length : '推荐 ' + popular.length, force, false);
        for (const ps of popular) b.appendChild(selRow(ps));
        if (!kw && more.length) {
          // 「查看更多供应商」：整行按钮，弹出独立的「连接提供商」大列表（推荐 / 其他 + 搜索）
          const t = document.createElement('button'); t.className = 'selmore';
          t.innerHTML = '<span class="ico">' + ICON_PLUG + '</span><span>查看更多供应商</span><span class="cnt">' + (popular.length + more.length) + '</span><span class="chev">›</span>';
          t.title = 'models.dev 登记的全部提供商（' + (popular.length + more.length) + ' 家）';
          t.addEventListener('click', () => openAllProvidersModal());
          b.appendChild(t);
        }
      }
      if (kw && more.length) {
        const b2 = selCard(list, '更多提供商', more.length, force, false);
        for (const ps of more) b2.appendChild(selRow(ps));
      }
      if (kw && !popular.length && !more.length && !official.length && !oauth.length && !match(CUSTOM_PRESET)) {
        const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '没有匹配「' + kw + '」的 provider，可用「自定义」接入。'; list.appendChild(e);
        selCard(list, '自定义', null, true).appendChild(selRow(CUSTOM_PRESET));
      }
    }
    q.addEventListener('input', render);
    clr.addEventListener('click', () => { q.value = ''; render(); q.focus(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; render(); } else closeModal(); } });
    render();
    setTimeout(() => q.focus(), 30);
  }

  // 连接提供商（对齐 Kilo 的 ProviderSelectDialog）：搜索 + 「推荐」/「其他」两组，紧凑行（标 + 名字），
  // 「其他」按名字排序、自定义排第一。点行进入连接弹窗；「返回」回到上一层。
  function openAllProvidersModal(initialKw) {
    const modal = buildModal('+', '连接提供商', '');
    modal.classList.add('select'); modal.classList.add('allprov');
    const box = searchBox('搜索提供商');
    modal.appendChild(box);
    const q = box.querySelector('.sq'), clr = box.querySelector('.sclear'), list = box.querySelector('.sellist');
    if (initialKw) q.value = initialKw;
    function render() {
      const kw = (q.value || '').trim().toLowerCase();
      show(clr, kw.length > 0);
      list.innerHTML = '';
      const avail = availPresets();
      const match = presetMatcher(kw);
      // 「推荐」与主弹窗一致：推荐榜前 10 家；其余（含榜上第 11 名起的）按名字排进「其他」
      const popular = kw ? avail.filter((ps) => ps.popular && match(ps)) : recommended(avail, match);
      const others = avail.filter((ps) => match(ps) && !popular.includes(ps)).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
      const custom = match(CUSTOM_PRESET);
      const back = () => openAllProvidersModal(q.value);
      const force = kw.length > 0;
      if (popular.length) { const b = selCard(list, '推荐', popular.length, force); for (const ps of popular) b.appendChild(selRow(ps, true, back)); }
      if (others.length || custom) {
        const b = selCard(list, '其他', others.length + (custom ? 1 : 0), force);
        if (custom) b.appendChild(selRow(CUSTOM_PRESET, true, back));
        for (const ps of others) b.appendChild(selRow(ps, true, back));
      }
      if (!popular.length && !others.length && !custom) {
        const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '没有匹配「' + kw + '」的提供商，可用「自定义」接入。'; list.appendChild(e);
        selCard(list, '自定义', null, true).appendChild(selRow(CUSTOM_PRESET, true, back));
      }
    }
    const foot = document.createElement('div'); foot.className = 'mfootbtns';
    const back = document.createElement('button'); back.className = 'btn btn-ghost'; back.textContent = '‹ 返回';
    back.addEventListener('click', openSelectModal); foot.appendChild(back);
    modal.appendChild(foot);
    q.addEventListener('input', render);
    clr.addEventListener('click', () => { q.value = ''; render(); q.focus(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; render(); } else openSelectModal(); } });
    render();
    setTimeout(() => q.focus(), 30);
  }

  // ---------- 从 CC Switch 导入：扫库 → 勾选候选 → 导入 ----------
  // 点按钮先开一个"正在读取"的弹窗，扩展扫完（或弹了系统文件框让用户选库）回 ccswitchResult 再填内容。
  let ccModal = null; // { modal, box }
  function openCcImportModal(browse) {
    // 标题栏放 CC Switch 的官方彩色标
    const logo = document.createElement('span'); logo.className = 'picon img';
    const img = document.createElement('img'); img.src = CCSWITCH_LOGO; img.alt = 'CC Switch'; logo.appendChild(img);
    const modal = buildModal('CC', '从 CC Switch 导入', '读取 CC Switch 里配好的供应商（Claude Code / Codex / Gemini CLI / OpenCode / Hermes），把地址、Key 与模型直接接进来。只读，不改 CC Switch 的任何文件。', { iconNode: logo });
    modal.classList.add('connect'); modal.classList.add('ccimport');
    const box = document.createElement('div'); box.className = 'ccbox';
    box.innerHTML = '<div class="omsg"><span class="spin"></span> 正在读取 CC Switch 数据…</div>';
    modal.appendChild(box);
    ccModal = { modal, box };
    vscode.postMessage({ type: 'ccswitchScan', browse: !!browse });
  }
  function onCcSwitchResult(m) {
    if (!ccModal || !ccModal.modal.isConnected) return;
    const box = ccModal.box; box.innerHTML = '';
    if (m.cancelled) { closeModal(); return; }
    const pathLine = document.createElement('div'); pathLine.className = 'ccpath';
    const segs = String(m.path || '').split(/[\\\\/]+/).filter(Boolean);
    const shortPath = (segs.length > 2 ? '…/' : '') + segs.slice(-2).join('/');
    pathLine.innerHTML = '<span class="k">来源</span><span class="mono" title="' + esc(m.path || '') + '">' + esc(shortPath) + '</span><span class="lnk">换一个文件…</span>';
    pathLine.querySelector('.lnk').addEventListener('click', () => { box.innerHTML = '<div class="omsg"><span class="spin"></span> 正在读取…</div>'; vscode.postMessage({ type: 'ccswitchScan', browse: true }); });
    box.appendChild(pathLine);
    if (m.error) {
      const e = document.createElement('div'); e.className = 'oerr'; e.textContent = '读取失败：' + m.error; box.appendChild(e);
      const foot = document.createElement('div'); foot.className = 'mfootbtns';
      const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.textContent = '关闭'; b.addEventListener('click', closeModal); foot.appendChild(b);
      box.appendChild(foot);
      return;
    }
    const items = m.items || [];
    const picked = new Set(items.filter((it) => !it.existsAs).map((it) => it.idx));
    const list = document.createElement('div'); list.className = 'cclist';
    const head = document.createElement('div'); head.className = 'selgroup';
    const headT = document.createElement('span'); head.appendChild(headT);
    const all = ckEl(''); all.title = '全选 / 全不选'; head.appendChild(all);
    const foot = document.createElement('div'); foot.className = 'mfootbtns';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-ghost'; cancel.textContent = '取消'; cancel.addEventListener('click', closeModal);
    const go = document.createElement('button'); go.className = 'btn btn-primary';
    foot.appendChild(cancel); foot.appendChild(go);
    function paint() {
      headT.textContent = items.length ? ('找到 ' + items.length + ' 个可导入的供应商 · 已勾 ' + picked.size) : '没有找到可导入的供应商';
      const allOn = picked.size === items.length && items.length > 0, some = !allOn && picked.size > 0;
      all.className = 'ck' + (allOn ? ' on' : some ? ' some' : '');
      all.textContent = some ? '–' : '✓';
      list.querySelectorAll('.ccrow').forEach((r) => { const on = picked.has(Number(r.dataset.idx)); r.querySelector('.ck').className = 'ck' + (on ? ' on' : ''); r.classList.toggle('dim', !on); });
      go.textContent = picked.size ? ('导入 ' + picked.size + ' 个') : '导入';
      go.disabled = !picked.size;
    }
    all.addEventListener('click', () => { if (picked.size === items.length) picked.clear(); else for (const it of items) picked.add(it.idx); paint(); });
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'ccrow'; row.dataset.idx = String(it.idx);
      row.appendChild(ckEl(''));
      const main = document.createElement('div'); main.className = 'ccmain';
      // 第一行：名字 + （已连接）；第二行：来源 CLI 胶囊 + 接口 · 地址 · Key · 模型数
      const nm = document.createElement('div'); nm.className = 'ccname';
      const n = document.createElement('span'); n.className = 'nm'; n.textContent = it.name; nm.appendChild(n);
      if (it.existsAs) { const t = document.createElement('span'); t.className = 'tag exist'; t.textContent = '已连接'; t.title = '面板里已有同地址同 Key 的 provider：' + it.existsAs; nm.appendChild(t); }
      const sub = document.createElement('div'); sub.className = 'ccsub';
      for (const s of it.sources || []) { const t = document.createElement('span'); t.className = 'tag src'; t.textContent = s; sub.appendChild(t); }
      const fmt = (FORMAT_SHORT[it.format] || it.format || '') + (it.protocol === 'anthropic' && it.anthropicMode === 'official' ? ' · 官方' : '');
      const txt = document.createElement('span'); txt.className = 'cctxt';
      txt.innerHTML = esc(fmt) + ' · <span class="mono">' + esc(it.baseUrl) + '</span> · Key ' + esc(it.maskedKey || '—') + (it.models && it.models.length ? ' · ' + it.models.length + ' 个模型' : ' · 未指定模型');
      sub.appendChild(txt);
      sub.title = (it.models && it.models.length) ? ('模型：' + it.models.join(', ')) : '未在 CC Switch 里指定模型，导入后到「添加模型」里挑';
      main.appendChild(nm); main.appendChild(sub);
      row.appendChild(main);
      row.addEventListener('click', () => { if (picked.has(it.idx)) picked.delete(it.idx); else picked.add(it.idx); paint(); });
      list.appendChild(row);
    }
    box.appendChild(head); box.appendChild(list);
    if (m.skipped && m.skipped.length) {
      const d = document.createElement('details'); d.className = 'ccskip';
      d.innerHTML = '<summary>跳过 ' + m.skipped.length + ' 项（没有 Key 或走账号登录）</summary><ul>' + m.skipped.map((s) => '<li><b>' + esc(s.name) + '</b> <span class="tag src">' + esc(s.source) + '</span> ' + esc(s.reason) + '</li>').join('') + '</ul>';
      box.appendChild(d);
    }
    box.appendChild(foot);
    go.addEventListener('click', () => { if (!picked.size) return; go.disabled = true; go.textContent = '导入中…'; vscode.postMessage({ type: 'ccswitchImport', picks: Array.from(picked) }); });
    paint();
    requestAnimationFrame(() => fitModalContent(ccModal.modal));
  }
  $('ccImport').addEventListener('click', () => openCcImportModal(false));

  // ---------- 打开外部网站：面板内自己的确认框（叠在当前弹窗之上，不打断正在填的表单） ----------
  // 这就是唯一的一道确认：「在浏览器打开」由扩展直接交给系统浏览器（不走 Kiro 的外部网站确认框），
  // 「复制链接」走剪贴板。
  function openUrl(url) {
    if (!url) return;
    let root = $('linkRoot');
    if (!root) { root = document.createElement('div'); root.id = 'linkRoot'; document.body.appendChild(root); }
    root.innerHTML = '';
    const ov = document.createElement('div'); ov.className = 'overlay link';
    const box = document.createElement('div'); box.className = 'modal confirm linkbox';
    let host = url;
    try { host = new URL(url).host; } catch (e) { /* keep raw */ }
    box.innerHTML = '<div class="mhead"></div>'
      + '<div class="mdesc">将在系统浏览器里打开 <b>' + esc(host) + '</b></div>'
      + '<div class="linkurl mono" title="' + esc(url) + '">' + esc(url) + '</div>'
      + '<div class="mfootbtns"><button class="btn btn-ghost lCancel">取消</button><button class="btn btn-ghost lCopy">复制链接</button><button class="btn btn-primary lOpen">在浏览器打开</button></div>';
    const head = box.querySelector('.mhead');
    head.appendChild(iconEl('', 'glyph:portal'));
    const h = document.createElement('div'); h.className = 'mtitle'; h.textContent = '打开外部网站'; head.appendChild(h);
    const x = document.createElement('button'); x.className = 'iconbtn'; x.textContent = '✕'; x.title = '关闭'; x.setAttribute('aria-label', '关闭'); head.appendChild(x);
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    // Enter：焦点在框内按钮上时交给按钮自己的 click（「取消」上按 Enter 是取消，不是打开）；其余位置视为「在浏览器打开」
    const onKey = (e) => {
      if (!box.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Enter') return;
      const a = document.activeElement;
      if (a && box.contains(a) && a.tagName === 'BUTTON') return;
      e.preventDefault(); e.stopPropagation(); close(); vscode.postMessage({ type: 'openExternal', url });
    };
    x.addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    box.querySelector('.lCancel').addEventListener('click', close);
    box.querySelector('.lCopy').addEventListener('click', () => { vscode.postMessage({ type: 'copyText', text: url }); close(); });
    box.querySelector('.lOpen').addEventListener('click', () => { close(); vscode.postMessage({ type: 'openExternal', url }); });
    document.addEventListener('keydown', onKey);
    ov.appendChild(box); root.appendChild(ov);
    setTimeout(() => box.querySelector('.lOpen').focus(), 30);
  }

  // ---------- 模态弹窗基座 ----------
  // 弹窗级键盘监听：同一时刻只挂一个；closeModal / 换弹窗时先摘掉，不留残余监听
  let modalKeyFn = null;
  function setModalKey(fn) {
    if (modalKeyFn) document.removeEventListener('keydown', modalKeyFn);
    modalKeyFn = fn || null;
    if (modalKeyFn) document.addEventListener('keydown', modalKeyFn);
  }
  // 外链确认框（#linkRoot）叠在弹窗之上时，键盘归它，底下的弹窗不响应
  const linkBoxOpen = () => { const r = $('linkRoot'); return !!(r && r.querySelector('.overlay')); };
  function closeModal() {
    if (activeProbe) { try { activeProbe.dispose(); } catch (e) { /* ignore */ } activeProbe = null; }
    setModalKey(null);
    // 登录弹窗关掉不取消登录：用户可能正在浏览器里授权，回来发现 provider 已经建好（扩展会 toast）。
    $('modalRoot').innerHTML = ''; addModal = null; editModal = null; oauthModal = null; ccModal = null;
  }
  // 确认弹窗：和其它弹窗同一套皮（不再弹系统原生对话框）。{ icon, iconId, fallbackId, title, desc, okText, danger, onOk }
  function confirmModal(o) {
    const modal = buildModal(o.icon || '!', o.title, o.desc ? esc(o.desc) : '', { plain: true, iconId: o.iconId, fallbackId: o.fallbackId });
    modal.classList.add('confirm');
    const foot = document.createElement('div'); foot.className = 'mfootbtns';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-ghost'; cancel.textContent = o.cancelText || '取消';
    cancel.addEventListener('click', closeModal);
    const ok = document.createElement('button'); ok.className = 'btn ' + (o.danger ? 'btn-danger-fill' : 'btn-primary'); ok.textContent = o.okText || '确定';
    ok.addEventListener('click', () => { closeModal(); o.onOk(); });
    foot.appendChild(cancel); foot.appendChild(ok);
    modal.appendChild(foot);
    // Esc 取消；Enter 只在焦点不在弹窗内按钮上时才算确认——焦点在「取消」上按 Enter 走按钮自己的 click（即取消）
    setModalKey((e) => {
      if (!modal.isConnected) { setModalKey(null); return; }
      if (linkBoxOpen() || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key !== 'Enter') return;
      const a = document.activeElement;
      if (a && a !== document.body && modal.contains(a) && (a.tagName === 'BUTTON' || a.tagName === 'A' || a.tagName === 'TEXTAREA')) return;
      e.preventDefault(); closeModal(); o.onOk();
    });
    setTimeout(() => cancel.focus(), 30);
    return modal;
  }
  function buildModal(iconName, title, descHtml, mopts) {
    const root = $('modalRoot'); root.innerHTML = '';
    const ov = document.createElement('div'); ov.className = 'overlay';
    ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
    const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const head = document.createElement('div'); head.className = 'mhead';
    // 当 iconName 显式传 '' 且没有指定 iconNode/iconId 时，不渲染左侧图标
    if (mopts && mopts.iconNode) {
      head.appendChild(mopts.iconNode);
    } else if (iconName || (mopts && (mopts.iconId || mopts.fallbackId))) {
      head.appendChild(iconEl(iconName, mopts && mopts.iconId, mopts && mopts.fallbackId));
    }
    const h = document.createElement('div'); h.className = 'mtitle'; h.textContent = title; head.appendChild(h);
    const x = document.createElement('button'); x.className = 'iconbtn'; x.textContent = '✕'; x.title = '关闭'; x.setAttribute('aria-label', '关闭');
    x.addEventListener('click', closeModal); head.appendChild(x);
    modal.appendChild(head);
    if (descHtml) { const d = document.createElement('div'); d.className = 'mdesc'; d.innerHTML = descHtml; modal.appendChild(d); }
    ov.appendChild(modal); root.appendChild(ov);
    // plain：小确认框，不装拉伸把手
    if (!(mopts && mopts.plain)) makeResizable(modal, ov);
    // 所有弹窗（含 plain）统一：Esc 关闭。搜索框自己吃掉的 Esc（清空文字）会 preventDefault，这里不再重复处理；
    // 开着的自绘下拉先收起，再按一次才关弹窗
    setModalKey((e) => {
      if (!modal.isConnected) { setModalKey(null); return; }
      if (e.key !== 'Escape' || e.defaultPrevented || linkBoxOpen()) return;
      const openSel = modal.querySelector('.csel.open');
      if (openSel) { e.preventDefault(); openSel.classList.remove('open'); return; }
      e.preventDefault(); closeModal();
    });
    // 正文一律进 .mbody（标题栏钉住、正文内部滚动，初始态就不超视口）。调用方在本调用栈里继续往 modal 上挂内容，
    // 所以先包一次，再在微任务里把后挂的也收进去；ensureBody 每次都会把游离的直系子元素归位。
    ensureBody(modal);
    Promise.resolve().then(() => { if (modal.isConnected) ensureBody(modal); });
    return modal;
  }

  // ---------- 弹窗可拉伸：八个把手（四边 + 四角），拖动改宽高；标题栏固定、正文内部滚动。
  // 尺寸按弹窗种类（connect / select / addmodel / prompt…）记住，下次打开同类弹窗沿用。 ----------
  const MODAL_MIN_W = 240, MODAL_MIN_H = 160;
  let modalSizes = {};
  try { modalSizes = (vscode.getState() || {}).modalSizes || {}; } catch (e) { modalSizes = {}; }
  function modalKind(modal) {
    const k = Array.from(modal.classList).filter((c) => c !== 'modal' && c !== 'resized' && c !== 'resizing');
    return k.join('.') || 'default';
  }
  // 把标题栏以外的内容包进 .mbody（可滚动），标题栏留在顶上。可重复调用：已有 .mbody 时把后来直接挂在
  // .modal 上的游离子元素（调用方追加的表单 / 底栏）也收进去，保证正文永远只有这一个滚动容器。
  function ensureBody(modal) {
    let body = modal.querySelector(':scope > .mbody');
    if (!body) {
      body = document.createElement('div'); body.className = 'mbody';
      // 把手要留在 .modal 直系下；正文插到把手之前
      const firstRz = modal.querySelector(':scope > .rz');
      modal.insertBefore(body, firstRz);
    }
    for (const ch of Array.from(modal.children)) {
      if (ch === body || ch.classList.contains('rz') || ch.classList.contains('mhead')) continue;
      body.appendChild(ch);
    }
    return body;
  }
  function applyModalSize(modal, w, h) {
    ensureBody(modal);
    modal.classList.add('resized');
    modal.style.width = Math.round(w) + 'px';
    modal.style.height = Math.round(h) + 'px';
    modal.style.maxWidth = 'none';
    requestAnimationFrame(() => fitModalContent(modal));
  }
  // 拉高弹窗时，里面的可滚动清单（模型列表 / 候选池 / 选择列表）要跟着长高填满，而不是缩在原来的固定高度里。
  // 量法：先把清单压到 0 量出"其余内容"的高度，剩下的全给它；不够放就给个下限让正文整体滚动。
  const GROW_SEL = '.plist:not(.hidden), .mlist, .sellist, .cclist';
  function fitModalContent(modal) {
    modal = modal || document.querySelector('.modal.resized');
    if (!modal || !modal.classList.contains('resized')) return;
    const body = modal.querySelector(':scope > .mbody');
    if (!body) return;
    // 展开着的 Logo 图库优先吃空间（用户正在挑）；收起后空间还给模型清单
    const gridOpen = body.querySelector('.ipick-grid:not(.hidden)');
    const list = body.querySelector(GROW_SEL);
    const grow = gridOpen || list;
    if (!grow) return;
    if (gridOpen && list) list.style.maxHeight = '';
    for (const g of body.querySelectorAll('.ipick-grid.hidden')) g.style.maxHeight = '';
    grow.style.maxHeight = '0px';
    // scrollHeight 不会小于 clientHeight，量不出"内容比容器矮多少"，所以逐个直系子元素加（含外边距）
    let rest = 0;
    for (const ch of body.children) {
      const cs = getComputedStyle(ch);
      rest += ch.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    const bcs = getComputedStyle(body);
    rest += (parseFloat(bcs.paddingTop) || 0) + (parseFloat(bcs.paddingBottom) || 0);
    const avail = body.clientHeight - rest - 4; // 清单自己的上下边框等零头
    grow.style.maxHeight = Math.max(140, avail) + 'px';
  }
  // 面板（抽屉）宽度变了：拉过尺寸的弹窗收进新范围并重新居中（它本来就走 flex 居中，收尺寸即可）
  window.addEventListener('resize', () => {
    const modal = document.querySelector('.modal.resized');
    if (!modal || rz) return;
    const ov = modal.parentElement;
    const maxW = ov.clientWidth - 16, maxH = ov.clientHeight - 16;
    if (modal.offsetWidth > maxW) modal.style.width = Math.max(MODAL_MIN_W, maxW) + 'px';
    if (modal.offsetHeight > maxH) modal.style.height = Math.max(MODAL_MIN_H, maxH) + 'px';
    fitModalContent(modal);
  });
  function makeResizable(modal, ov) {
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const hnd = document.createElement('div'); hnd.className = 'rz ' + dir; hnd.dataset.dir = dir;
      hnd.addEventListener('pointerdown', (e) => startResize(e, modal, ov, dir));
      modal.appendChild(hnd);
    }
    // 上次这类弹窗拉成的尺寸：直接沿用（仍居中、顶部对齐；窗口变小了就按当前可用范围收）
    setTimeout(() => {
      const saved = modalSizes[modalKind(modal)];
      if (!saved) return;
      const maxW = ov.clientWidth - 16, maxH = ov.clientHeight - 16;
      applyModalSize(modal, Math.max(MODAL_MIN_W, Math.min(saved.w, maxW)), Math.max(MODAL_MIN_H, Math.min(saved.h, maxH)));
    }, 0);
  }
  let rz = null;
  function startResize(e, modal, ov, dir) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault(); e.stopPropagation();
    const r = modal.getBoundingClientRect(), o = ov.getBoundingClientRect();
    ensureBody(modal);
    // 转成绝对定位，拖哪边只动哪边（对边钉住），手感和桌面窗口一致
    modal.classList.add('resized', 'resizing');
    modal.style.position = 'absolute';
    modal.style.left = (r.left - o.left) + 'px'; modal.style.top = (r.top - o.top + ov.scrollTop) + 'px';
    modal.style.width = r.width + 'px'; modal.style.height = r.height + 'px'; modal.style.maxWidth = 'none'; modal.style.margin = '0';
    rz = { modal, ov, dir, x0: e.clientX, y0: e.clientY, left: r.left - o.left, top: r.top - o.top + ov.scrollTop, w: r.width, h: r.height, ow: ov.clientWidth, oh: ov.clientHeight };
    document.body.classList.add('nosel');
    document.body.dataset.rz = dir;
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }
  function onResizeMove(e) {
    if (!rz) return;
    const dx = e.clientX - rz.x0, dy = e.clientY - rz.y0;
    let { left, top, w, h } = rz;
    const d = rz.dir;
    if (d.includes('e')) w = rz.w + dx;
    if (d.includes('s')) h = rz.h + dy;
    if (d.includes('w')) { w = rz.w - dx; left = rz.left + dx; }
    if (d.includes('n')) { h = rz.h - dy; top = rz.top + dy; }
    // 下限 + 不出遮罩范围（留 4px 边）
    if (w < MODAL_MIN_W) { if (d.includes('w')) left -= (MODAL_MIN_W - w); w = MODAL_MIN_W; }
    if (h < MODAL_MIN_H) { if (d.includes('n')) top -= (MODAL_MIN_H - h); h = MODAL_MIN_H; }
    if (left < 4) { w -= (4 - left); left = 4; }
    if (top < 4) { h -= (4 - top); top = 4; }
    if (left + w > rz.ow - 4) w = rz.ow - 4 - left;
    if (top + h > rz.oh - 4) h = rz.oh - 4 - top;
    const m = rz.modal;
    m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.width = w + 'px'; m.style.height = h + 'px';
    fitModalContent(m);
  }
  function endResize() {
    if (!rz) return;
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', endResize);
    window.removeEventListener('pointercancel', endResize);
    document.body.classList.remove('nosel');
    delete document.body.dataset.rz;
    const m = rz.modal;
    m.classList.remove('resizing');
    if (m.isConnected && m.offsetWidth >= MODAL_MIN_W && m.offsetHeight >= MODAL_MIN_H) {
      modalSizes[modalKind(m)] = { w: m.offsetWidth, h: m.offsetHeight };
      try { vscode.setState(Object.assign({}, vscode.getState() || {}, { modalSizes })); } catch (e) { /* ignore */ }
    }
    // 松手后回到 flex 流里：尺寸保留、位置交给遮罩居中——之后面板宽度再变，它自动跟着居中，不会歪在一边
    m.style.position = ''; m.style.left = ''; m.style.top = ''; m.style.margin = '';
    fitModalContent(m);
    rz = null;
  }

  // 连接弹窗（热门 / 自定义）：填 Key（自定义再加地址+协议）→ 连接
  // ---------- API 格式下拉 + Provider 探测面板（连接弹窗 / 设置弹窗共用） ----------
  const FORMAT_OPTIONS = [
    { v: 'chat', label: 'OpenAI Chat Completions (/chat/completions)', hint: '绝大多数中转站与聚合站（OpenRouter、DeepSeek…）都是这种' },
    { v: 'anthropic', label: 'Anthropic Messages (/v1/messages)', hint: 'Claude 系与 kiro2cc 一类中转；保留 Kiro 私有字段（effort 档位、思考与计费显示）' },
    { v: 'responses', label: 'OpenAI Responses (/responses)', hint: 'OpenAI 新一代接口；GPT-5 系推理在工具循环里靠 encrypted_content 回放' },
    { v: 'gemini', label: 'Google Gemini (generateContent)', hint: 'Google AI Studio 的 Gemini API（x-goog-api-key）；Base URL 填到 /v1beta' },
  ];
  const FORMAT_LABEL = { chat: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', responses: 'OpenAI Responses', gemini: 'Google Gemini', kiro: 'Kiro CodeWhisperer' };
  const fmtHint = (v) => (FORMAT_OPTIONS.find((o) => o.v === v) || {}).hint || '';
  function formatSelect(cls, value) {
    // 渲染带有隐藏真实 select（保持与之前 .value / change 事件完全兼容）+ 自定义荧光浅紫弹出框
    const selOpt = FORMAT_OPTIONS.find((o) => o.v === value) || FORMAT_OPTIONS[0];
    let h = '<div class="csel ' + cls + '-wrap" data-cls="' + cls + '">';
    h += '<select class="' + cls + '" style="display:none;">' + FORMAT_OPTIONS.map((o) => '<option value="' + o.v + '"' + (o.v === value ? ' selected' : '') + '>' + o.label + '</option>').join('') + '</select>';
    h += '<div class="csel-trigger"><span class="csel-label">' + esc(selOpt.label) + '</span><span class="csel-arrow"></span></div>';
    h += '<div class="csel-menu">';
    FORMAT_OPTIONS.forEach((o) => {
      const isSel = o.v === value;
      h += '<div class="csel-opt' + (isSel ? ' sel' : '') + '" data-val="' + o.v + '"><span>' + esc(o.label) + '</span></div>';
    });
    h += '</div>';
    h += '</div>';
    return h;
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.csel')) {
      document.querySelectorAll('.csel.open').forEach((c) => c.classList.remove('open'));
    }
  });

  function mountCustomSelect(host) {
    if (!host) return;
    host.querySelectorAll('.csel').forEach((csel) => {
      const trigger = csel.querySelector('.csel-trigger');
      const label = csel.querySelector('.csel-label');
      const menu = csel.querySelector('.csel-menu');
      const hiddenSelect = csel.querySelector('select');
      if (!trigger || !menu || !hiddenSelect) return;

      const toggleMenu = (open) => {
        const next = open !== undefined ? open : !csel.classList.contains('open');
        if (next) document.querySelectorAll('.csel.open').forEach((o) => { if (o !== csel) o.classList.remove('open'); });
        csel.classList.toggle('open', next);
        // 弹窗正文是滚动容器：菜单贴着底边展开时把它滚进可视区，不让下半截藏在滚动条外
        if (next && menu.scrollIntoView) requestAnimationFrame(() => { if (csel.classList.contains('open')) menu.scrollIntoView({ block: 'nearest' }); });
      };

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu();
      });

      menu.querySelectorAll('.csel-opt').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.val;
          menu.querySelectorAll('.csel-opt').forEach((o) => o.classList.toggle('sel', o === opt));
          label.textContent = opt.textContent;
          hiddenSelect.value = val;
          hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
          toggleMenu(false);
        });
      });
    });
  }

  // 探测面板：测延迟 · 拉取模型 · 单个/批量测活。针对表单里的草稿工作（getDraft() 每次点按钮时取当前输入），
  // 不落盘。activeProbe 是当前开着的那个，扩展回的 probeResult / modelTest 消息路由给它。
  let activeProbe = null;
  let probeSeq = 0;
  const BATCH_CAP = 40;
  function mountProbe(host, getDraft, opts) {
    opts = opts || {};
    const st = {
      models: (opts.models || []).slice(), results: {}, pending: new Set(), checked: new Set(opts.checked || []),
      q: '', lat: null, fetch: null, batchId: '', batchTotal: 0, batchDone: 0, running: false, reqLat: '', reqFetch: '',
    };
    host.innerHTML = '<div class="tools">'
      + '<button class="btn btn-ghost btn-sm pLat" title="GET /models，量到收到响应头的时间">测延迟</button><span class="tres pLatRes"></span>'
      + '<button class="btn btn-ghost btn-sm pFetch" title="拉取该地址的模型清单">' + (st.models.length ? '刷新模型' : '拉取模型') + '</button><span class="tres pFetchRes"></span>'
      + '</div><div class="plist hidden"></div>';
    const latRes = host.querySelector('.pLatRes'), fetchRes = host.querySelector('.pFetchRes'), list = host.querySelector('.plist');

    // 成功/进行中的结果紧跟按钮；失败原因独占一行完整显示（前面标上是哪个动作的）
    function paintTools() {
      const paint = (el, r, runTxt, label) => {
        el.className = 'tres' + (r ? ' ' + r.cls : '');
        el.innerHTML = r ? (r.cls === 'run' ? '<span class="spin"></span>' + runTxt : (r.cls === 'bad' ? '<b>' + label + '：</b>' : '') + esc(r.text)) : '';
        el.title = r && r.title || '';
      };
      paint(latRes, st.lat, '测试中', '测延迟');
      paint(fetchRes, st.fetch, '拉取中', '拉取模型');
      host.querySelector('.pFetch').textContent = st.models.length ? '刷新模型' : '拉取模型';
    }
    // route：结果交给谁。不传 = 显示在「测延迟」按钮旁；池行的「用这把测延迟」传一个回调，结果标到那一行去
    const runLatency = (route) => {
      st.reqLat = 'lat' + (++probeSeq); st.latRoute = typeof route === 'function' ? route : null;
      if (!st.latRoute) { st.lat = { cls: 'run' }; paintTools(); }
      vscode.postMessage({ type: 'probeLatency', reqId: st.reqLat, draft: getDraft() });
    };
    host.querySelector('.pLat').addEventListener('click', () => runLatency());
    host.querySelector('.pFetch').addEventListener('click', () => {
      st.reqFetch = 'fetch' + (++probeSeq); st.fetch = { cls: 'run' }; paintTools();
      vscode.postMessage({ type: 'probeModels', reqId: st.reqFetch, draft: getDraft() });
    });

    function startTests(ids, isBatch) {
      ids = ids.filter((id) => !st.pending.has(id));
      if (!ids.length) return;
      const batchId = 'b' + (++probeSeq);
      for (const id of ids) { st.pending.add(id); delete st.results[id]; }
      if (isBatch) { st.batchId = batchId; st.batchTotal = ids.length; st.batchDone = 0; st.running = true; }
      renderList();
      vscode.postMessage({ type: 'testModels', batchId, draft: getDraft(), modelIds: ids });
    }
    function shownModels() {
      const kw = st.q.trim().toLowerCase();
      return kw ? st.models.filter((m) => m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)) : st.models;
    }
    function batchTargets() {
      // 勾选的 / 已在 Kiro 列表的优先，其余按当前过滤后的顺序补足，最多 BATCH_CAP 个。
      const shown = shownModels();
      const prefer = new Set([...(opts.preferIds || []), ...st.checked]);
      const first = shown.filter((m) => prefer.has(m.id)), rest = shown.filter((m) => !prefer.has(m.id));
      const ids = [...first, ...rest].map((m) => m.id).slice(0, BATCH_CAP);
      if (shown.length > BATCH_CAP) toast('ok', '一次最多测 ' + BATCH_CAP + ' 个，' + (prefer.size ? '已选/勾选的优先；' : '') + '可先用搜索框缩小范围');
      return ids;
    }

    function renderList() {
      if (!st.models.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
      list.classList.remove('hidden');
      const shown = shownModels();
      const vals = Object.values(st.results);
      const okN = vals.filter((r) => r.ok).length, badN = vals.filter((r) => !r.ok).length;
      list.innerHTML = '';
      const head = document.createElement('div'); head.className = 'phead';
      if (opts.selectable && shown.length) {
        // 全选：三态勾选框，作用于当前列出（搜索过滤后）的模型
        const allOn = shown.every((m) => st.checked.has(m.id)), someOn = shown.some((m) => st.checked.has(m.id));
        const ck = ckEl(allOn ? 'on' : someOn ? 'some' : ''); ck.classList.add('pall');
        ck.title = allOn ? '取消全选' : ('全选' + (st.q.trim() ? '（当前搜索结果）' : ''));
        ck.addEventListener('click', () => { for (const m of shown) { if (allOn) st.checked.delete(m.id); else st.checked.add(m.id); } renderList(); });
        head.appendChild(ck);
      }
      const title = document.createElement('span'); title.className = 'ptitle';
      title.textContent = (st.q.trim() ? shown.length + ' / ' : '') + st.models.length + ' 个模型' + (okN || badN ? ' · ✓ ' + okN + (badN ? ' · ✗ ' + badN : '') : '') + (opts.selectable && st.checked.size ? ' · 已选 ' + st.checked.size : '');
      head.appendChild(title);
      if (opts.selectable && okN) {
        // 一键选活：把测活通过的全部勾上（不动没测 / 没过的）
        const passIds = Object.keys(st.results).filter((id) => st.results[id].ok);
        const allPassed = passIds.every((id) => st.checked.has(id));
        const alive = document.createElement('button'); alive.className = 'btn btn-ghost btn-sm palive' + (allPassed ? ' done' : '');
        alive.textContent = allPassed ? '已选活' : '选活'; alive.disabled = allPassed;
        alive.title = allPassed ? '测活通过的都已勾选' : ('勾选全部测活通过的模型（' + passIds.filter((id) => !st.checked.has(id)).length + ' 个未勾）');
        alive.addEventListener('click', () => { for (const id of passIds) st.checked.add(id); renderList(); });
        head.appendChild(alive);
      }
      if (st.running) {
        const cancel = document.createElement('button'); cancel.className = 'btn btn-ghost btn-sm';
        cancel.innerHTML = '<span class="spin"></span>' + st.batchDone + ' / ' + st.batchTotal + ' · 取消';
        cancel.addEventListener('click', () => { vscode.postMessage({ type: 'cancelTests', batchId: st.batchId }); finishBatch(st.batchId); });
        head.appendChild(cancel);
      } else {
        const batch = document.createElement('button'); batch.className = 'btn btn-ghost btn-sm'; batch.textContent = '批量测活';
        batch.title = '给列出的模型各发一条最小请求（最多 ' + BATCH_CAP + ' 个，勾选/已选的优先）';
        batch.addEventListener('click', () => startTests(batchTargets(), true));
        head.appendChild(batch);
      }
      list.appendChild(head);
      if (st.models.length > 8) {
        const sw = document.createElement('div'); sw.className = 'search psearch';
        sw.innerHTML = '<input class="sq" type="text" placeholder="搜索模型…" spellcheck="false" autocomplete="off"><button class="sclear' + (st.q ? '' : ' hidden') + '" title="清空">✕</button>';
        const q = sw.querySelector('.sq'); q.value = st.q;
        q.addEventListener('input', () => { st.q = q.value; renderList(); const nq = list.querySelector('.psearch .sq'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } });
        sw.querySelector('.sclear').addEventListener('click', () => { st.q = ''; renderList(); });
        list.appendChild(sw);
      }
      for (const m of shown.slice(0, 500)) {
        const r = st.results[m.id], pend = st.pending.has(m.id);
        const row = document.createElement('div'); row.className = 'prowm' + (r ? (r.ok ? ' live' : ' dead') : '');
        if (opts.selectable) {
          const ck = ckEl(st.checked.has(m.id) ? 'on' : ''); ck.title = '连接后直接加入 Kiro 模型列表';
          ck.addEventListener('click', () => { if (st.checked.has(m.id)) st.checked.delete(m.id); else st.checked.add(m.id); renderList(); });
          row.appendChild(ck);
        }
        const pid = document.createElement('span'); pid.className = 'pid'; pid.textContent = m.id; pid.title = m.name && m.name !== m.id ? (m.name + ' · ' + m.id) : m.id;
        row.appendChild(pid);
        const pst = document.createElement('span'); pst.className = 'pst' + (pend ? ' run' : r ? (r.ok ? ' ok' : ' bad') : '');
        if (pend) pst.innerHTML = '<span class="spin"></span>测试中';
        else if (r) { pst.textContent = r.ok ? ('✓ ' + r.ms + 'ms' + (r.sample ? ' · ' + r.sample : '')) : ('✗ ' + (r.error || ('HTTP ' + r.status))); pst.title = r.ok ? ('HTTP ' + r.status + ' · ' + r.ms + 'ms' + (r.sample ? ' · 回复：' + r.sample : '')) : (r.error || ''); }
        const tb = document.createElement('button'); tb.className = 'btn btn-ghost btn-sm'; tb.textContent = r ? '重测' : '测活'; tb.disabled = pend;
        tb.addEventListener('click', () => startTests([m.id], false));
        const extras = opts.rowExtra ? (opts.rowExtra(m) || []) : [];
        if (extras.length) {
          // 带能力标签的行两行摆：上行 id + 测活，下行 标签 + 结果，否则窄栏下 id 会被挤没
          row.classList.add('two');
          row.appendChild(tb);
          const sub = document.createElement('div'); sub.className = 'psub';
          for (const el of extras) sub.appendChild(el);
          sub.appendChild(pst);
          row.appendChild(sub);
        } else {
          row.appendChild(pst);
          row.appendChild(tb);
        }
        list.appendChild(row);
      }
      if (shown.length > 500) { const e = document.createElement('div'); e.className = 'pfoot'; e.textContent = '只显示前 500 个，请用搜索缩小范围'; list.appendChild(e); }
      if (opts.selectable && st.checked.size) {
        const foot = document.createElement('div'); foot.className = 'pfoot';
        const s = document.createElement('span'); s.textContent = '已勾选 ' + st.checked.size + ' 个，连接后直接进入 Kiro 列表'; foot.appendChild(s);
        const clr = document.createElement('span'); clr.className = 'lnk'; clr.textContent = '清空'; clr.addEventListener('click', () => { st.checked.clear(); renderList(); }); foot.appendChild(clr);
        list.appendChild(foot);
      }
      fitModalContent();
    }
    function finishBatch(batchId) {
      if (st.batchId !== batchId) return;
      st.running = false; st.batchId = '';
      // 取消后还没回来的都清掉 pending（在途结果回来也会被忽略，因为 pending 里已没有它）
      for (const id of Array.from(st.pending)) st.pending.delete(id);
      renderList();
    }

    const api = {
      onMessage(m) {
        if (m.type === 'probeResult' && m.kind === 'latency' && m.reqId === st.reqLat) {
          const r = m.ok
            ? (m.note
                ? { cls: 'warn', text: m.ms + ' ms ⚠', title: m.note + '（HTTP ' + m.status + '）' }
                : { cls: 'ok', text: m.ms + ' ms', title: 'HTTP ' + m.status })
            : { cls: 'bad', text: (m.ms >= 0 ? m.ms + ' ms · ' : '') + (m.note || m.error || '失败'), title: m.error || '', short: m.ms >= 0 ? m.ms + ' ms Error' : 'Error' };
          if (st.latRoute) { const route = st.latRoute; st.latRoute = null; route(r); }
          else { st.lat = r; paintTools(); }
        } else if (m.type === 'probeResult' && m.kind === 'models' && m.reqId === st.reqFetch) {
          if (m.ok) {
            st.models = m.models || [];
            // ok 但带 error 说明上游 /models 不可用、清单来自 models.dev 目录——标出来，别让人以为是上游返回的
            st.fetch = m.error
              ? { cls: 'ok', text: st.models.length + ' 个 · models.dev 清单', title: m.error }
              : { cls: 'ok', text: '拉到 ' + st.models.length + ' 个 · ' + m.ms + ' ms' };
            if (opts.onModels) opts.onModels(st.models);
          } else st.fetch = { cls: 'bad', text: m.error || '拉取失败', title: m.error || '' };
          paintTools(); renderList();
        } else if (m.type === 'modelTest') {
          if (!st.pending.has(m.modelId)) return;
          st.pending.delete(m.modelId);
          st.results[m.modelId] = { ok: !!m.ok, ms: m.ms, status: m.status, sample: m.sample || '', error: m.error || '' };
          if (m.batchId === st.batchId) st.batchDone++;
          renderList();
        } else if (m.type === 'modelTestDone') {
          if (m.error) toast('error', m.error);
          if (m.batchId === st.batchId) finishBatch(m.batchId);
          else renderList();
        }
      },
      setModels(models) { st.models = (models || []).slice(); paintTools(); renderList(); },
      checked() { return Array.from(st.checked); },
      models() { return st.models.slice(); },
      runLatency,
      dispose() { if (st.running && st.batchId) vscode.postMessage({ type: 'cancelTests', batchId: st.batchId }); },
    };
    paintTools(); renderList();
    activeProbe = api;
    return api;
  }

  // 连接弹窗：Provider 名称 / Base URL / API Key / API 格式 + 探测面板（测延迟 · 拉取模型 · 测活）。
  // 预设（有内置地址）只填 Key；自定义填全套。拉到模型后可勾选，连接时直接进 Kiro 列表。
  function openConnectModal(ps, back) {
    const custom = ps && ps.custom;
    // 目录预设的 blurb（接口 · 环境变量）下面的信息行已经写了，不再重复；内置预设的说明保留
    const modal = buildModal(ps ? ps.name : '自定义', ps ? ('连接 ' + ps.name) : '自定义 Provider',
      ps && ps.blurb && ps.source !== 'models.dev' ? esc(ps.blurb) : '', { iconId: ps && (ps.custom ? 'glyph:plus-ring' : ps.iconId), fallbackId: ps && !ps.custom ? GENERIC_LOGO : '' });
    modal.classList.add('connect');
    let html = '';
    if (custom) {
      html += '<label>Provider 名称</label><input class="mName" type="text" spellcheck="false" placeholder="我的 Provider">'
        + '<label>Base URL</label><input class="mUrl" type="text" spellcheck="false" placeholder="https://api.example.com/v1">'
        + '<label>Logo</label><div class="ipickHost"></div>';
    }
    if (!custom && ps) {
      // 预设：地址与接口格式由目录定死，只展示不给改（改就去「自定义」）
      html += '<div class="pinfo"><span class="k">地址</span><span class="v mono">' + esc(ps.baseUrl) + '</span></div>'
        + '<div class="pinfo"><span class="k">接口</span><span class="v">' + esc(FORMAT_LABEL[ps.format] || ps.format || 'Chat') + '</span></div>';
    }
    html += '<label>API Key' + (ps && ps.keyHint && /_KEY|TOKEN/.test(ps.keyHint) ? '<span class="lblhint">环境变量 ' + esc(ps.keyHint) + ' 的值</span>' : '') + '</label>' + keyInput('mKey', (ps && ps.keyHint) || 'sk-...');
    if (ps && ps.docsUrl) html += '<div class="mfoot" style="margin-top:6px;">没有 Key？<span class="lnk" style="color:var(--accent);cursor:pointer;">点此获取</span></div>';
    if (custom) html += '<label>API 格式</label>' + formatSelect('mFmt', 'chat') + '<div class="mfoot mFmtHint" style="margin-top:4px;"></div>';
    html += '<div class="probe"></div>';
    // 「返回」回到选择弹窗（对齐 Kilo 的 onBack），「连接」提交。
    html += '<div class="mfootbtns"><button class="btn btn-ghost mBack">‹ 返回</button><button class="btn btn-primary mGo">连接</button></div>';
    const box = document.createElement('div'); box.innerHTML = html; modal.appendChild(box);
    mountCustomSelect(box);
    bindEyes(box);
    const mName = box.querySelector('.mName'), mUrl = box.querySelector('.mUrl'), mKey = box.querySelector('.mKey'), mFmt = box.querySelector('.mFmt'), fmtHintEl = box.querySelector('.mFmtHint');
    if (mFmt) { const paint = () => { fmtHintEl.textContent = fmtHint(mFmt.value); }; paint(); mFmt.addEventListener('change', paint); }
    // 自定义：头像选择器（缺省首字母，跟着名字变；也可以从线稿库挑一个），标题栏的头像同步预览
    let picker = null;
    if (custom) {
      picker = iconPicker({ value: '', autoIconId: '', nameOf: () => mName.value.trim() || '自定义',
        preview: (el) => { const h = modal.querySelector('.mhead .picon'); if (h) h.replaceWith(el); } });
      box.querySelector('.ipickHost').appendChild(picker.el);
      mName.addEventListener('input', () => picker.repaint());
    }
    const doc = box.querySelector('.lnk');
    if (doc) doc.addEventListener('click', () => openUrl(ps.docsUrl));
    const getDraft = () => custom
      ? { name: mName.value, baseUrl: mUrl.value, apiKey: mKey.value, format: mFmt.value, anthropicMode: 'kiro' }
      : { name: ps.name, baseUrl: ps.baseUrl, apiKey: mKey.value, format: ps.format || (ps.protocol === 'anthropic' ? 'anthropic' : ps.protocol === 'gemini' ? 'gemini' : 'chat'), anthropicMode: ps.anthropicMode || 'kiro', presetId: ps.id };
    const probe = mountProbe(box.querySelector('.probe'), getDraft, { selectable: true });
    box.querySelector('.mBack').addEventListener('click', () => (typeof back === 'function' ? back : openSelectModal)());
    box.querySelector('.mGo').addEventListener('click', () => {
      const key = mKey.value.trim();
      if (!key) { toast('error', '请填写 API Key'); mKey.focus(); return; }
      const enabledModels = probe.checked();
      if (custom) {
        const url = mUrl.value.trim();
        if (!url) { toast('error', '请填写 Base URL'); mUrl.focus(); return; }
        const fmt = mFmt.value;
        const ff = fmtFields(fmt);
        vscode.postMessage({ type: 'addProvider', name: mName.value, protocol: ff.protocol, anthropicMode: 'kiro', openaiApi: ff.openaiApi, baseUrl: url, apiKey: key, enabledModels, icon: picker ? picker.value : '' });
      } else {
        vscode.postMessage({ type: 'addProvider', presetId: ps.id, apiKey: key, baseUrl: '', enabledModels });
      }
      closeModal();
    });
    setTimeout(() => (custom ? mName : mKey).focus(), 30);
  }

  // ---------- 登录弹窗（第三方登录直连）：开始登录 → 设备码 / 浏览器授权进度 → 登录成功 → 在同一弹窗里选模型、测活 ----------
  // 对齐 CPA 的「OAuth 登录」页：一张卡一个厂商，「立即注册」+「使用 X 登录」；登录成功后接着是我们自己的探测面板。
  // vendor: 选择弹窗里的厂商；existing: 给既有 provider 重新登录时传它（登录成功只换凭据，不新建）。
  let oauthModal = null; // { vendor, sessionId, providerId, probe, phase, onStatus(m), onState() }
  // credentialId：给既有 provider 池里的哪一把重新登录（cN），或 'new' = 再登一个账号进池；不传 = 首条
  // initialMode: 点进来的具体方式（如 oauth / import / access_token / json / api_key）；back: 自定义返回回调
  function openOAuthModal(v, existing, credentialId, initialMode, back) {
    const addingAccount = credentialId === 'new';
    const modes = Array.isArray(v.loginModes) && v.loginModes.length > 1 ? v.loginModes : null;
    const activeModeId = initialMode || (modes ? (addingAccount ? 'oauth' : modes[0].id) : '');
    const curMode = modes ? (modes.find((m) => m.id === activeModeId) || modes[0]) : null;

    const titlePrefix = curMode && modes ? curMode.label : v.name;
    // 有具体登录方式时，说明由正文里的「方式：hint」一条承担，标题下不再重复一遍
    const modal = buildModal(
      v.name,
      existing ? ((addingAccount ? '再添加一个账号 · ' : '重新授权 ') + existing.name) : (titlePrefix),
      curMode ? '' : esc(v.blurb || ''),
      { iconId: v.iconId }
    );
    modal.classList.add('connect'); modal.classList.add('oauth');
    const box = document.createElement('div');

    // 渲染手填表单（access_token / json / api_key 等带 fields 的方式）
    function renderModeFields(fields) {
      if (!fields || !fields.length) return '';
      // 控件样式全部交给全局 label / input / textarea 规则（与其它弹窗同一副皮），这里只出结构
      let h = '<div class="omodeFields">';
      const lbl = (f) => '<label>' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>';
      const attrs = (f) => 'class="mFieldInput" data-key="' + esc(f.key) + '" data-required="' + (f.required ? '1' : '0') + '" placeholder="' + esc(f.placeholder || '') + '"';
      for (const f of fields) {
        h += lbl(f);
        if (f.multiline) {
          h += '<textarea ' + attrs(f) + ' spellcheck="false"></textarea>';
          if (f.key === 'json' || f.key === 'jsonText' || activeModeId === 'json') {
            h += '<div class="pickrow"><button type="button" class="btn wide oPickJsonBtn"><span class="ico">' + ICON_IMPORT + '</span><span class="lbl">从本地选择 JSON 文件</span></button></div>';
          }
        } else if (f.secret) {
          h += '<div class="keywrap"><input ' + attrs(f) + ' type="password" spellcheck="false" autocomplete="off">'
            + '<button type="button" class="eye" title="显示/隐藏" tabindex="-1">' + ICON_EYE + '</button></div>';
        } else {
          h += '<input ' + attrs(f) + ' type="text" spellcheck="false" autocomplete="off">';
        }
        if (f.hint) h += '<div class="fhint">' + esc(f.hint) + '</div>';
      }
      h += '</div>';
      return h;
    }

    const hasFields = !!(curMode && curMode.fields && curMode.fields.length);
    const startBtnLabel = curMode
      ? (curMode.id === 'import' ? '立即导入' : curMode.id === 'oauth' || curMode.id === 'browser' ? '开始授权' : '连接')
      : '开始登录';

    box.innerHTML =
      '<div class="ostage">'
      + '<div class="ointro">'
      + '<div class="omsg">'
      + (curMode
          ? '<div class="omodes"><div class="omode"><b>' + esc(curMode.label) + '</b>：' + esc(curMode.hint) + '</div></div>'
          : v.flow === 'device'
          ? '点「开始登录」后会打开浏览器的确认页，页面里核对下面显示的一次性代码并同意授权即可；本插件不会看到你的密码。'
          : '点「开始登录」后会打开浏览器登录页，登录并授权后浏览器会跳回本机' + (v.callbackPort ? '（localhost:' + v.callbackPort + '）' : '') + '，本插件不会看到你的密码。')
      + '</div>'
      + (hasFields ? renderModeFields(curMode.fields) : '')
      + '<div class="mfootbtns oBtns">'
      + '<button class="btn btn-ghost mBack">‹ 返回</button>'
      + (v.signupUrl ? '<button class="btn btn-ghost oSignup">' + esc(v.signupLabel || '立即注册') + '</button>' : '')
      + '<button class="btn btn-primary oStart" data-mode="' + esc(activeModeId) + '">' + esc(startBtnLabel) + '</button>'
      + '</div>'
      + (modes && !initialMode ? '<div class="mfootbtns oModeBtns">' + modes.map((m) => '<button class="btn ' + (m.id === activeModeId ? 'btn-primary' : 'btn-ghost') + ' oStart" data-mode="' + esc(m.id) + '">' + esc(m.label) + '</button>').join('') + '</div>' : '')
      + '</div>'
      + '<div class="oprog hidden">'
      + '<div class="ophase"><span class="spin"></span><span class="ophaseTxt">正在准备登录…</span></div>'
      + '<div class="ocode hidden"><div class="ocodeLbl">在浏览器里核对 / 输入这个代码</div><div class="ocodeVal"></div>'
      + '<div class="ocodeBtns"><button class="btn btn-ghost btn-sm oCopy">复制代码</button><button class="btn btn-ghost btn-sm oOpen">再次打开确认页</button></div></div>'
      + '<div class="ourl hidden"><button class="btn btn-ghost btn-sm oOpenUrl">浏览器没打开？点此重开</button><button class="btn btn-ghost btn-sm oCopyUrl">复制登录链接</button></div>'
      + '<div class="oerr hidden"></div>'
      + '<div class="mfootbtns"><button class="btn btn-ghost oCancel">取消</button><button class="btn btn-primary oRetry hidden">重试</button></div>'
      + '</div>'
      + '<div class="odone hidden">'
      + '<div class="oacct"></div>'
      + '<div class="mfoot" style="margin:6px 0 2px;">下面是该账号可用的模型：勾选进入 Kiro 列表，「测活」验证账号确实能用。</div>'
      + '<div class="probe"></div>'
      + '<div class="mfootbtns"><button class="btn btn-primary oFinish">完成</button></div>'
      + '</div>'
      + '</div>';
    modal.appendChild(box);
    bindEyes(box);
    const intro = box.querySelector('.ointro'), prog = box.querySelector('.oprog'), done = box.querySelector('.odone');
    const phaseTxt = box.querySelector('.ophaseTxt'), phaseBox = box.querySelector('.ophase');
    const codeBox = box.querySelector('.ocode'), codeVal = box.querySelector('.ocodeVal'), urlBox = box.querySelector('.ourl'), errBox = box.querySelector('.oerr');
    const retryBtn = box.querySelector('.oRetry'), cancelBtn = box.querySelector('.oCancel');
    const state = { vendor: v, sessionId: '', providerId: existing ? existing.id : '', probe: null, phase: 'idle', openUrl: '', code: '', mode: activeModeId, input: {} };
    oauthModal = state;

    const showStage = (which) => { show(intro, which === 'intro'); show(prog, which === 'prog'); show(done, which === 'done'); };
    const collectInput = () => {
      const inp = {};
      let valid = true;
      box.querySelectorAll('.mFieldInput').forEach((el) => {
        const k = el.dataset.key;
        const val = (el.value || '').trim();
        if (el.dataset.required === '1' && !val) {
          valid = false;
          el.style.borderColor = 'var(--error,#f44336)';
        } else {
          el.style.borderColor = '';
        }
        if (k) inp[k] = val;
      });
      return valid ? inp : null;
    };

    const start = (mode) => {
      if (mode) state.mode = mode;
      if (hasFields) {
        const inp = collectInput();
        if (!inp) {
          toast('error', '请填写必填项');
          return;
        }
        state.input = inp;
      }
      state.phase = 'starting'; state.openUrl = ''; state.code = '';
      showStage('prog'); show(codeBox, false); show(urlBox, false); show(errBox, false); show(retryBtn, false); show(phaseBox, true);
      cancelBtn.textContent = '取消';
      phaseTxt.textContent = '正在连接…';
      vscode.postMessage({
        type: 'oauthStart',
        vendor: v.id,
        mode: state.mode || undefined,
        input: state.input || undefined,
        providerId: existing ? existing.id : undefined,
        credentialId: existing ? (credentialId || undefined) : undefined,
      });
    };
    box.querySelector('.mBack').addEventListener('click', () => (back ? back() : (existing ? openEditModal(existing) : openSelectModal())));
    const signup = box.querySelector('.oSignup');
    if (signup) signup.addEventListener('click', () => openUrl(v.signupUrl));
    const pickJsonBtn = box.querySelector('.oPickJsonBtn');
    if (pickJsonBtn) pickJsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickLocalJsonFile' }));
    box.querySelectorAll('.oStart').forEach((b) => b.addEventListener('click', () => start(b.dataset.mode || '')));
    // 重试沿用上次点的那种方式
    retryBtn.addEventListener('click', () => start(''));
    cancelBtn.addEventListener('click', () => {
      if (state.sessionId && state.phase !== 'error' && state.phase !== 'cancelled') vscode.postMessage({ type: 'oauthCancel', sessionId: state.sessionId });
      state.sessionId = ''; state.phase = 'idle'; showStage('intro');
    });
    box.querySelector('.oCopy').addEventListener('click', () => { copyText(state.code); toast('ok', '已复制代码'); });
    box.querySelector('.oOpen').addEventListener('click', () => { if (state.openUrl) openUrl(state.openUrl); });
    box.querySelector('.oOpenUrl').addEventListener('click', () => { if (state.openUrl) openUrl(state.openUrl); });
    box.querySelector('.oCopyUrl').addEventListener('click', () => { copyText(state.openUrl); toast('ok', '已复制登录链接'); });
    box.querySelector('.oFinish').addEventListener('click', () => {
      // 给既有 provider 加账号 / 重登：回到它的编辑弹窗看池；新建：勾选的模型进列表
      if (existing) { const fresh = lastProviders.find((x) => x.id === existing.id); if (fresh) { openEditModal(fresh); return; } closeModal(); return; }
      const picked = state.probe ? state.probe.checked() : [];
      if (picked.length && state.providerId) {
        vscode.postMessage({ type: 'setAllModelsEnabled', id: state.providerId, enabled: true, modelIds: picked });
        selectTab('models');
      }
      closeModal();
    });

    // 登录成功：显示账号，装探测面板（模型清单由扩展按内置目录给），自动拉一次
    const showDone = (acct) => {
      state.phase = 'done'; showStage('done');
      const p = lastProviders.find((x) => x.id === state.providerId);
      const who = (acct && acct.email) || (!addingAccount && p && p.account) || '';
      const plan = (acct && acct.plan) || (!addingAccount && p && p.plan) || '';
      box.querySelector('.oacct').innerHTML =
        '<span class="okdot"></span><b>登录成功</b>' + (who ? ' · <span class="mono">' + esc(who) + '</span>' : ' · <span class="muted">已授权（' + esc(v.name) + ' 不返回账号信息）</span>') + (plan ? ' <span class="tag oauth">' + esc(plan) + '</span>' : '')
        + (addingAccount ? '<div class="mfoot" style="margin-top:4px;">已加入「' + esc(existing.name) + '」的账号池' + (p && p.poolSize ? '（现在 ' + p.poolSize + ' 个账号）' : '') + '，点「完成」回到设置查看。</div>'
          : existing ? '' : '<div class="mfoot" style="margin-top:4px;">已作为 provider 加入「提供商」页' + (p ? '：' + esc(p.name) : '') + '</div>');
      if (addingAccount) { box.querySelector('.oFinish').textContent = '完成'; return; }
      if (!state.probe && state.providerId) {
        const preferIds = (modelsByProvider[state.providerId] || []).filter((mm) => mm.enabled).map((mm) => mm.id);
        state.probe = mountProbe(box.querySelector('.probe'), () => ({ id: state.providerId }), { selectable: !existing, preferIds, checked: preferIds });
        // 直接拉（内置目录秒回）
        const btn = box.querySelector('.probe .pFetch'); if (btn) btn.click();
      }
    };
    state.onStatus = (m) => {
      if (m.type === 'oauthSession') { if (m.vendor === v.id) state.sessionId = m.sessionId; return; }
      if (m.vendor !== v.id || (state.sessionId && m.sessionId !== state.sessionId)) return;
      if (!state.sessionId) state.sessionId = m.sessionId;
      if (m.providerId) state.providerId = m.providerId;
      state.phase = m.phase;
      if (m.phase === 'device') {
        state.code = m.userCode || ''; state.openUrl = m.verificationUriComplete || m.verificationUri || '';
        codeVal.textContent = state.code; show(codeBox, true); show(urlBox, false);
        phaseTxt.textContent = m.text || '等待你在浏览器里确认授权…';
      } else if (m.phase === 'browser') {
        state.openUrl = m.authUrl || ''; show(urlBox, true); show(codeBox, false);
        phaseTxt.textContent = m.text || '等待浏览器授权…';
      } else if (m.phase === 'starting' || m.phase === 'exchanging') {
        phaseTxt.textContent = m.text || '';
      } else if (m.phase === 'done') {
        showDone(m.account);
      } else if (m.phase === 'error') {
        show(phaseBox, false); show(codeBox, false); show(urlBox, false);
        errBox.textContent = '登录失败：' + (m.error || '未知错误'); show(errBox, true); show(retryBtn, true);
        cancelBtn.textContent = '返回';
      } else if (m.phase === 'cancelled') {
        state.sessionId = ''; showStage('intro');
      }
    };
    // 扩展推 state（登录后 provider 出现在列表里）时刷一下账号行
    state.onState = () => { if (state.phase === 'done') showDone(null); };
    showStage('intro');
  }
  function copyText(s) {
    if (!s) return;
    try { navigator.clipboard.writeText(s); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) { /* ignore */ } ta.remove();
    }
  }

  // 能力标签三态：自动 → 手动支持 → 手动不支持 → 自动。
  // 「自动」不是一个值，是"交给目录判"——所以标签上要把目录判出来的结果一起写出来
  // （自动·✗ / 自动·✓ / 自动·?），否则用户看到灰色「自动」不知道系统到底认为它支不支持。
  // 手动值只有和自动判定不同时才有意义，相同时给个提示但不阻止（用户可能就是想钉死它）。
  function capCell(p, modelId, field, label) {
    const mm = (modelsByProvider[p.id] || []).find((x) => x.id === modelId);
    const ov = mm && mm.override && typeof mm.override[field] === 'boolean' ? mm.override[field] : null;
    const auto = mm ? (field === 'image' ? mm.autoImage : mm.autoReasoning) : null;
    const src = mm ? (field === 'image' ? mm.imageSource : mm.reasoningSource) : 'none';
    // 判定来源：上游自己说的最硬；厂商表是我们手写的；目录是第三方 models.dev
    const who = src === 'upstream' ? '上游 /models 声明' : src === 'vendor' ? '内置厂商表' : src === 'catalog' ? 'models.dev 目录' : '';
    const manual = ov !== null;
    const kind = field === 'reasoning' ? ' reason' : ' vision';
    const what = field === 'image' ? '图片输入' : '思考/推理';
    let el;
    // 推理设为「不支持」有实际动作：OpenAI 兼容渠道会带 enable_thinking:false / thinking:{type:disabled} 关掉思考；
    // GLM-5.3 系是强制思考（关不掉），只能压到 reasoning_effort:low（与 src/thinkingPolicy.ts 的判定保持一致）
    const forcedThink = /glm[-_.]?5\.3/i.test(String(modelId || '').split('/').pop() || '');
    const offEffect = field === 'reasoning' && (p.protocol === 'openai')
      ? (forcedThink ? '；该模型思考不可关闭（GLM-5.3 系强制思考），设为不支持时请求改带 reasoning_effort:low 压短思考' : '；请求会带 enable_thinking:false 关掉上游思考（把回答塞进思考通道导致重复输出的模型可用）')
      : field === 'image' ? '；带图的请求会先剥掉图片再发' : '';
    if (manual) {
      el = capChip(field, label, ov ? '✓' : '✗');
      el.className = ov ? ('cap on' + kind) : 'cap off';
      el.title = label + '：手动设为「' + (ov ? '支持' : '不支持') + '」' + (auto !== null && auto !== ov ? '（' + who + '判定是「' + (auto ? '支持' : '不支持') + '」，已被你覆盖）' : auto === ov ? '（与' + who + '判定相同）' : '（没有任何来源的记录）') + (ov ? '' : offEffect) + '。点击 → ' + (ov ? '不支持' : '自动');
    } else {
      // 自动：显示判定结论；颜色仍是"自动"的灰，但结论符号让人一眼看到系统认为它支不支持
      el = capChip(field, label, auto === true ? '自动 ✓' : auto === false ? '自动 ✗' : '自动 ?');
      el.className = 'cap auto' + (auto === true ? ' auto-on' : auto === false ? ' auto-off' : '');
      el.title = label + '：自动 — ' + (auto === true ? who + '认为支持' + what : auto === false ? who + '认为不支持' + what + (field === 'image' ? '，带图的请求会先剥掉图片再发' : '') : '上游、厂商表、目录都没有这个模型的记录，' + (field === 'image' ? '先照发、被拒后自动学习' : '按名字推断')) + '。点击 → 手动支持' + (field === 'reasoning' && p.protocol === 'openai' ? '（再点一次 → 不支持' + offEffect + '）' : '');
    }
    el.addEventListener('click', () => {
      const cur = manual ? ov : null;
      const next = cur == null ? true : cur === true ? false : null;
      // 手动值恰好等于目录判定时，提醒一句但照常写入（用户可能想钉死，防目录以后变）
      if (next !== null && auto !== null && next === auto) toast('ok', '目录本来就判「' + (next ? '支持' : '不支持') + '」，手动设置会钉死这个值不再跟随目录');
      if (mm) {
        mm[field] = next == null ? auto : next;
        mm.override = Object.assign({}, mm.override || {});
        if (next == null) delete mm.override[field]; else mm.override[field] = next;
      }
      renderEditModalModels(); renderModels(); renderAddModelModal();
      vscode.postMessage({ type: 'setModelOverride', id: p.id, modelId, field, value: next });
    });
    return el;
  }

  // 编辑弹窗开着时非空：{ p, probe }。模型清单由探测面板渲染（每行：id · 推理/图片能力标签 · 测活），
  // 点标签 / 扩展推回 models 时用 setModels 重画——探测结果留在面板状态里不丢。
  let editModal = null;
  function editModalModels(p) {
    return (modelsByProvider[p.id] || []).map((mm) => ({ id: mm.id, name: mm.name || mm.id }));
  }
  function renderEditModalModels() {
    if (!editModal) return;
    const { p, probe, foot } = editModal;
    const models = editModalModels(p);
    probe.setModels(models);
    // 有模型时不写说明（能力标签怎么点，悬停标签自己会讲）；只在拉不到清单时提示怎么办
    foot.textContent = models.length
      ? ''
      : (p.enabled && p.usable ? '未获取到模型列表（上游 /models 为空或拉取失败）。可点上方「拉取模型」重试。' : '');
  }

  // ---------- key 池（编辑弹窗里的凭证列表） ----------
  // 一行一把：拖柄（改优先级）/ 序号 / 备注·掩码 / 状态胶囊（就绪 · 冷却倒计时 · 停用 · 未登录）/ 开关 / 测活 / 改 / 删。
  // 底部一行「+ 加一把」。状态来自 state.providers[].credentials，扩展每次请求后会重推，所以冷却是活的。
  // 单把凭证时也渲染（就一行），把"加一把"入口摆在用户眼前——这是发现 key 池功能的地方。
  function fmtCooldown(until) {
    const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (s >= 3600) return Math.ceil(s / 3600) + ' 小时';
    if (s >= 60) return Math.ceil(s / 60) + ' 分钟';
    return s + ' 秒';
  }
  function fmtAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }
  function mountKeyPool(host, p, opts) {
    opts = opts || {};
    const oauth = p.auth === 'oauth';
    let editing = ''; // 正在改的凭证 id
    let adding = false;
    let tick = null;
    // 行内「用这把测延迟」的结果：{ [credentialId]: { cls:'run'|'ok'|'bad', text, title } }，标在那一行上
    const latency = {};
    const el = document.createElement('div'); el.className = 'kpool';
    host.appendChild(el);
    // 凭证在对话框 / 提示里的叫法：备注 > 账号邮箱（登录类）/ Key 掩码（Key 类）> 序号
    const credName = (c, i) => c.customLabel || (oauth ? (c.account || ('账号 ' + (i + 1))) : (c.maskedKey || ('Key ' + (i + 1))));

    function render(pp) {
      p = pp || p;
      const creds = (p.credentials || []).slice().sort((a, b) => a.priority - b.priority);
      el.innerHTML = '';
      // 头：标题 + 策略切换（只有多把时才有意义）
      const head = document.createElement('div'); head.className = 'kphead';
      const t = document.createElement('span'); t.className = 't';
      const cooling = creds.filter((c) => c.cooldownUntil > Date.now()).length;
      const unit = oauth ? ' 个' : ' 把';
      t.textContent = (oauth ? '账号池' : 'Key 池') + ' · ' + creds.length + unit + (cooling ? ' · ' + cooling + unit + '冷却中' : '');
      head.appendChild(t);
      if (creds.length > 1) {
        const seg = document.createElement('div'); seg.className = 'seg';
        seg.innerHTML = '<button data-k="priority" title="主备：固定用最优先的一把，它挂了才切下一把；同一会话粘住同一把（保住 prompt cache 命中率）">主备</button><button data-k="least-used" title="均衡：每个新会话选累计使用最少的一把，把额度摊开；会话内仍粘住同一把">均衡</button>';
        seg.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('sel', b.dataset.k === (p.poolStrategy || 'priority'));
          b.addEventListener('click', () => vscode.postMessage({ type: 'saveProvider', id: p.id, poolStrategy: b.dataset.k }));
        });
        head.appendChild(seg);
      }
      el.appendChild(head);

      creds.forEach((c, i) => {
        const now = Date.now();
        const cool = c.cooldownUntil > now;
        const row = document.createElement('div'); row.className = 'kprow' + (!c.enabled ? ' off' : cool ? ' cool' : ''); row.dataset.cid = c.id;
        row.draggable = creds.length > 1;
        const grip = document.createElement('span'); grip.className = 'grip'; grip.innerHTML = ICON_GRIP; grip.title = creds.length > 1 ? '拖动调整优先级（越靠上越优先）' : '';
        row.appendChild(grip);
        const idx = document.createElement('span'); idx.className = 'kidx'; idx.textContent = String(i + 1); row.appendChild(idx);
        const main = document.createElement('div'); main.className = 'kmain';
        const name = document.createElement('div'); name.className = 'kname';
        // 登录类：名字位放账号邮箱（每行同一种字体、同样会截断），有备注才是「备注 + 等宽邮箱」；
        // Key 类：名字位只放备注（多数人没有），掩码用等宽字。序号在最左边，不再自动起「主凭证」。
        const nmText = oauth ? (c.customLabel || c.account || '') : c.customLabel;
        if (nmText) { const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = nmText; nm.title = nmText; name.appendChild(nm); }
        if (!oauth && c.maskedKey) { const mk = document.createElement('span'); mk.className = 'mono'; mk.textContent = c.maskedKey; mk.title = c.maskedKey; name.appendChild(mk); }
        if (oauth && c.customLabel && c.account && c.account !== c.customLabel) { const ac = document.createElement('span'); ac.className = 'mono'; ac.textContent = c.account; ac.title = c.account; name.appendChild(ac); }
        if (oauth && c.plan) { const pl = document.createElement('span'); pl.className = 'tag oauth'; pl.textContent = c.plan; name.appendChild(pl); }
        main.appendChild(name);
        const sub = document.createElement('div'); sub.className = 'ksub';
        const parts = [];
        if (c.requests) parts.push(c.requests + ' 次' + (c.failures ? '（' + c.failures + ' 失败）' : '') + (c.tokens ? ' · ' + fmtTokens(c.tokens) + ' tok' : ''));
        if (c.lastTs) parts.push('最近 ' + fmtAgo(c.lastTs));
        if (cool && c.lastError) parts.push(c.lastError);
        sub.textContent = parts.join(' · ') || (c.configured ? '尚未使用' : (oauth ? '未登录' : '未配置 Key'));
        sub.title = cool && c.lastError ? c.lastError : '';
        // 冷却倒计时放副标题末尾（每秒由下面的 tick 刷新），状态胶囊只写原因，窄弹窗里不再把名字挤没
        if (cool) { const cd = document.createElement('span'); cd.className = 'kcd'; cd.textContent = ' · 还剩 ' + fmtCooldown(c.cooldownUntil); sub.appendChild(cd); }
        main.appendChild(sub);
        row.appendChild(main);
        // 行内测延迟的结果：进行中不在名字后显示文字气泡（在按钮上转圈）；
        // 测完后在名字旁展现结果胶囊（通=绿色毫秒 / 警告=黄色毫秒⚠ / 失败=红色 Error），原因挂在悬停提示上
        const lat = latency[c.id];
        if (lat && lat.cls !== 'run') {
          const lp = document.createElement('span'); lp.className = 'latpill ' + lat.cls;
          lp.innerHTML = lat.cls === 'bad' ? esc(lat.short || 'Error') : esc(lat.text);
          lp.title = lat.title || lat.text || '';
          name.appendChild(lp);
        }
        // 状态胶囊
        const st = document.createElement('span');
        if (!c.enabled) { st.className = 'kst idle'; st.textContent = '已停用'; }
        else if (!c.configured) { st.className = 'kst bad'; st.textContent = oauth ? '未登录' : '无 Key'; }
        else if (oauth && c.loginState === 'expired') { st.className = 'kst bad'; st.textContent = '登录失效'; }
        else if (cool) { st.className = 'kst cool'; st.textContent = c.cooldownReason || '冷却中'; st.title = (c.cooldownReason ? c.cooldownReason + ' · ' : '') + '冷却中，点「解除冷却」可立刻放回池里'; }
        else { st.className = 'kst ok'; st.textContent = '就绪'; }
        row.appendChild(st);
        // 操作
        const act = document.createElement('div'); act.className = 'kact';
        if (creds.length > 1) {
          const sw = document.createElement('label'); sw.className = 'switch'; sw.title = c.enabled ? '停用这把（不参与调度）' : '启用';
          sw.innerHTML = '<input type="checkbox"><span class="slider"></span>';
          const chk = sw.querySelector('input'); chk.checked = !!c.enabled;
          chk.addEventListener('change', (e) => vscode.postMessage({ type: 'credentialUpdate', id: p.id, credentialId: c.id, enabled: e.target.checked }));
          act.appendChild(sw);
        }
        const mk = (icon, title, cls, onClick) => { const b = document.createElement('button'); b.className = 'iconbtn' + (cls ? ' ' + cls : ''); b.title = title; b.setAttribute('aria-label', title); b.innerHTML = icon; b.addEventListener('click', onClick); act.appendChild(b); return b; };
        const isTesting = !!(lat && lat.cls === 'run');
        if (cool) mk(ICON_ACTIVITY, '解除冷却，立刻放回池里', '', () => vscode.postMessage({ type: 'credentialUpdate', id: p.id, credentialId: c.id, clearCooldown: true }));
        else if (c.configured && opts.onTest) {
          const tb = mk(isTesting ? '<span class="spin"></span>' : ICON_ACTIVITY, isTesting ? '正在测速…' : '用这把测延迟（结果标在本行）', isTesting ? 'run' : '', () => opts.onTest(c));
          if (isTesting) tb.disabled = true;
        }
        if (oauth) mk(ICON_SQPEN, c.configured ? '重新登录这个账号' : '登录', '', () => opts.onRelogin && opts.onRelogin(c));
        else mk(ICON_SQPEN, '改备注 / 换 Key', '', () => { editing = editing === c.id ? '' : c.id; adding = false; render(); });
        if (creds.length > 1) mk(ICON_TRASH, '从池里移除', 'del', () => {
          // confirmModal 会顶掉编辑弹窗；确认或取消后都回到编辑弹窗
          const reopen = () => { const fresh = lastProviders.find((x) => x.id === p.id); if (fresh) openEditModal(fresh); };
          const m = confirmModal({
            icon: p.name, iconId: p.iconId, fallbackId: logoFallback(p), title: '移除「' + credName(c, i) + '」？',
            desc: '从「' + p.name + '」的' + (oauth ? '账号池里移除，并退出该账号的登录。' : ' Key 池里移除这把 Key。') + '其余凭证不受影响。',
            okText: '移除', danger: true,
            onOk: () => { vscode.postMessage({ type: 'credentialRemove', id: p.id, credentialId: c.id }); setTimeout(reopen, 250); },
          });
          m.querySelector('.mfootbtns .btn-ghost').addEventListener('click', reopen);
        });
        row.appendChild(act);
        // 拖拽改优先级（HTML5 DnD 够用：列表短、只在弹窗里）
        if (creds.length > 1) {
          row.addEventListener('dragstart', (e) => { row.classList.add('dragging'); e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; });
          row.addEventListener('dragend', () => { row.classList.remove('dragging'); el.querySelectorAll('.kprow').forEach((r) => r.classList.remove('dropbefore')); });
          row.addEventListener('dragover', (e) => { e.preventDefault(); el.querySelectorAll('.kprow').forEach((r) => r.classList.remove('dropbefore')); row.classList.add('dropbefore'); });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData('text/plain'); if (!from || from === c.id) return;
            const order = creds.map((x) => x.id).filter((x) => x !== from);
            order.splice(order.indexOf(c.id), 0, from);
            vscode.postMessage({ type: 'credentialReorder', id: p.id, credentialIds: order });
          });
        }
        el.appendChild(row);
        // 展开的编辑行（key 类）：备注 + 新 Key（留空不改）
        if (!oauth && editing === c.id) {
          const ed = document.createElement('div'); ed.className = 'kpedit';
          ed.innerHTML = '<input class="klabel" type="text" placeholder="备注" spellcheck="false" maxlength="40">' + keyInput('knew', '新 Key（留空不改）') + '<button class="btn btn-primary btn-sm ksave">保存</button>';
          bindEyes(ed);
          const lb = ed.querySelector('.klabel'); lb.value = c.customLabel || '';
          const save = () => { vscode.postMessage({ type: 'credentialUpdate', id: p.id, credentialId: c.id, label: lb.value, apiKey: ed.querySelector('.knew').value }); editing = ''; };
          ed.querySelector('.ksave').addEventListener('click', save);
          ed.querySelector('.knew').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
          el.appendChild(ed);
          setTimeout(() => lb.focus(), 0);
        }
      });

      // 底部：加一把
      const add = document.createElement('div'); add.className = 'kpadd';
      if (oauth) {
        add.classList.add('kpadd-mini');
        add.innerHTML = '<button class="btn btn-connect btn-sq kaddacct" title="再登录一个账号，进同一个池（被限流 / 额度用尽时自动切到下一个）">' + ICON_PLUS + '</button>';
        add.querySelector('.kaddacct').addEventListener('click', () => opts.onAddAccount && opts.onAddAccount());
      } else if (adding) {
        add.innerHTML = '<input class="klabel" type="text" placeholder="备注（可选）" spellcheck="false" maxlength="40">' + keyInput('knew', '再贴一把 API Key') + '<button class="btn btn-primary btn-sm kadd">加入</button><button class="btn btn-ghost btn-sm kcancel">取消</button>';
        bindEyes(add);
        const doAdd = () => { const k = add.querySelector('.knew').value.trim(); if (!k) { toast('error', '请填写 API Key'); return; } vscode.postMessage({ type: 'credentialAdd', id: p.id, apiKey: k, label: add.querySelector('.klabel').value }); adding = false; };
        add.querySelector('.kadd').addEventListener('click', doAdd);
        add.querySelector('.knew').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
        add.querySelector('.kcancel').addEventListener('click', () => { adding = false; render(); });
        setTimeout(() => add.querySelector('.knew').focus(), 0);
      } else {
        add.classList.add('kpadd-mini');
        add.innerHTML = '<button class="btn btn-connect btn-sq kaddbtn" title="' + (creds.length > 1 ? '再加一把 Key；被限流 / 额度用尽 / 鉴权失败时自动切到下一把' : '再加一把 Key 组成池：一把被限流或额度用尽时自动切换') + '">' + ICON_PLUS + '</button>';
        add.querySelector('.kaddbtn').addEventListener('click', () => { adding = true; editing = ''; render(); });
      }
      el.appendChild(add);
      const m = el.closest('.modal'); if (m) requestAnimationFrame(() => fitModalContent(m));
      // 冷却倒计时每秒走一下（只在有冷却时）
      if (tick) { clearInterval(tick); tick = null; }
      if (cooling) tick = setInterval(() => { if (!el.isConnected) { clearInterval(tick); tick = null; return; } el.querySelectorAll('.kprow').forEach((r) => { const c = creds.find((x) => x.id === r.dataset.cid); const cd = r.querySelector('.kcd'); if (c && cd && c.cooldownUntil > Date.now()) cd.textContent = ' · 还剩 ' + fmtCooldown(c.cooldownUntil); else if (c && cd) render(); }); }, 1000);
    }
    render();
    return {
      render,
      credName,
      /** 行内测延迟：r = { cls:'run'|'ok'|'bad', text, title, short }，null 清掉；重画该池。 */
      setLatency(cid, r) { if (r) latency[cid] = r; else delete latency[cid]; render(); },
      dispose() { if (tick) clearInterval(tick); },
    };
  }
  function fmtTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

  // 编辑弹窗（已连接 provider）：API 格式 / 名称 / Base URL / Key 池 + 探测面板（含模型能力与测活）+ 删除
  function openEditModal(p) {
    if (p.auth === 'oauth') { openOAuthEditModal(p); return; }
    const modal = buildModal(p.name, '设置 ' + p.name, esc(p.baseUrl || ''), { iconId: p.iconId, fallbackId: logoFallback(p) });
    modal.classList.add('connect');
    const fmt0 = p.format || (p.protocol === 'anthropic' ? 'anthropic' : (p.openaiApi === 'responses' ? 'responses' : 'chat'));
    const box = document.createElement('div');
    // 没有任何 Key 时给一个直接的输入框（首次配置）；有 Key 后换成 key 池列表（首条的改 Key 在池行里做）
    const noKey = !(p.credentials || []).some((c) => c.configured);
    box.innerHTML =
      '<label>Provider 名称</label><input class="eName" type="text" spellcheck="false">'
      + '<label>Logo</label><div class="ipickHost"></div>'
      + '<label>Base URL</label><input class="eUrl" type="text" spellcheck="false" placeholder="https://...">'
      + (noKey
          ? '<label>API Key</label>' + keyInput('eKey', '贴入 API Key') + '<div class="muted eKeyHint" style="margin-top:6px;">尚未配置 Key</div>'
          : '<label>API Key</label><div class="kpoolHost"></div>')
      + '<label>API 格式</label>' + formatSelect('eFmt', fmt0)
      + '<div class="seg eMode" style="margin-top:6px;"><button data-k="kiro" title="Claude 系与 kiro2cc 一类中转：保留 Kiro 私有字段（effort 档位、思考与计费显示）">中转 · 深度兼容</button><button data-k="official" title="纯 /v1/messages 透传，剥掉 Kiro 私有字段——官方 API 与严格校验的网关用">Anthropic 官方直通</button></div>'
      + '<div class="probe"></div>'
      + '<div class="mfoot eFoot" style="margin-top:6px;"></div>'
      + '<div class="mfootbtns"><button class="btn btn-primary eSave">保存</button>'
      + '<button class="btn btn-ghost btn-sm eClear">' + (noKey ? '清除 Key' : '清空全部 Key') + '</button>'
      + '<button class="btn btn-ghost btn-sm btn-danger eDel">删除</button></div>';
    modal.appendChild(box);
    bindEyes(box);
    mountCustomSelect(box);
    const eName = box.querySelector('.eName'), eUrl = box.querySelector('.eUrl'), eKey = box.querySelector('.eKey'), eFmt = box.querySelector('.eFmt'), eMode = box.querySelector('.eMode');
    eName.value = p.name;
    eUrl.value = p.baseUrl || '';
    // Logo：自动（预设/域名认出的厂商标；目录预设没标时用占位标；自定义是首字母）或从图库手选；标题栏同步预览
    const picker = iconPicker({ value: p.icon || '', autoIconId: p.autoIconId || '', fallbackId: logoFallback(p), nameOf: () => eName.value.trim() || p.name,
      preview: (el) => { const h = modal.querySelector('.mhead .picon'); if (h) h.replaceWith(el); } });
    box.querySelector('.ipickHost').appendChild(picker.el);
    eName.addEventListener('input', () => picker.repaint());
    // key 池列表；「用这把测延迟」把该凭证 id 塞进探测草稿
    let probeCred = '';
    let poolWidget = null;
    const kpHost = box.querySelector('.kpoolHost');
    if (kpHost) {
      poolWidget = mountKeyPool(kpHost, p, {
        // 结果标在那一行（转圈 → 毫秒数 / ✗），不占下面「测延迟」按钮旁的位置
        onTest: (c) => { if (!probe) return; probeCred = c.id; poolWidget.setLatency(c.id, { cls: 'run' }); probe.runLatency((r) => poolWidget.setLatency(c.id, r)); },
      });
    }
    let selMode = p.anthropicMode === 'official' ? 'official' : 'kiro';
    // 格式说明不再单独占一行（下拉项里已带路径，两种 Anthropic 模式的说明在按钮悬停里）
    const paintFmt = () => {
      show(eMode, eFmt.value === 'anthropic');
      eMode.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.k === selMode));
    };
    paintFmt();
    eFmt.addEventListener('change', paintFmt);
    eMode.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { selMode = b.dataset.k; paintFmt(); }));

    // 探测草稿：Key 框（首次配置）或池里指定的那把（credentialId；空=首条）
    const getDraft = () => ({ id: p.id, name: eName.value, baseUrl: eUrl.value, apiKey: eKey ? eKey.value : '', format: eFmt.value, anthropicMode: selMode, credentialId: probeCred || undefined });
    const preferIds = (modelsByProvider[p.id] || []).filter((mm) => mm.enabled).map((mm) => mm.id);
    const probe = mountProbe(box.querySelector('.probe'), getDraft, {
      models: editModalModels(p),
      preferIds,
      // 每行带推理/图片三态能力标签（能力值从 modelsByProvider 取；刷新后新出现的模型为「自动」）
      rowExtra: (m) => [capCell(p, m.id, 'reasoning', '推理'), capCell(p, m.id, 'image', '图片')],
    });
    editModal = { p, probe, foot: box.querySelector('.eFoot'), pool: poolWidget };
    renderEditModalModels();

    box.querySelector('.eSave').addEventListener('click', () => {
      const ff = fmtFields(eFmt.value);
      vscode.postMessage({ type: 'saveProvider', id: p.id, name: eName.value, baseUrl: eUrl.value, apiKey: eKey ? eKey.value : '',
        protocol: ff.protocol, anthropicMode: selMode, openaiApi: ff.openaiApi, icon: picker.value });
      closeModal();
    });
    box.querySelector('.eClear').addEventListener('click', () => {
      const n = (p.credentials || []).length;
      if (noKey || n <= 1) { vscode.postMessage({ type: 'clearProviderKey', id: p.id }); closeModal(); return; }
      confirmModal({
        icon: p.name, iconId: p.iconId, fallbackId: logoFallback(p), title: '清空全部 ' + n + ' 把 Key？',
        desc: '「' + p.name + '」的 Key 池会被清空，provider 保留，之后需重新填 Key 才能用。',
        okText: '清空', danger: true,
        onOk: () => vscode.postMessage({ type: 'clearProviderKey', id: p.id }),
      });
    });
    box.querySelector('.eDel').addEventListener('click', () => confirmDeleteProvider(p));
  }

  // 登录类 provider 的设置弹窗：地址 / 格式由厂商定死，不给改；显示账号与登录状态，
  // 提供「重新登录 / 退出登录」，下面仍是模型能力与测活面板。
  function openOAuthEditModal(p) {
    const modal = buildModal(p.name, '设置 ' + p.name, esc((p.vendorName || '') + (p.baseUrl ? ' · ' + p.baseUrl : '')), { iconId: p.iconId });
    modal.classList.add('connect');
    const box = document.createElement('div');
    const vendor = (lastVendors || []).find((x) => x.id === p.oauthVendor) || { id: p.oauthVendor, name: p.vendorName || p.oauthVendor, flow: 'device', blurb: '' };
    // 有的厂商（Kimi）登录时不返回账号信息、也没有查询接口——池行里显示不出账号是正常的
    const noAcct = vendor.id === 'kimi';
    box.innerHTML =
      '<label>Provider 名称</label><input class="eName" type="text" spellcheck="false">'
      + '<label>Logo</label><div class="ipickHost"></div>'
      + '<label>账号</label><div class="kpoolHost"></div>'
      + (noAcct ? '<div class="mfoot" style="margin-top:4px;">' + esc(vendor.name) + ' 的登录流程不返回邮箱/用户名（官方客户端同样拿不到），池里按序号区分。</div>' : '')
      + (p.loginError ? '<div class="oerr small">' + esc(p.loginError) + '</div>' : '')
      + '<div class="mfootbtns oacctbtns">' + (p.loginState !== 'missing' ? '<button class="btn btn-ghost btn-sm eLogout">退出全部登录</button>' : '') + '</div>'
      + '<div class="mfoot" style="margin-top:8px;">接口：' + esc(FORMAT_LABEL[p.format] || p.format || '') + '（由厂商决定）</div>'
      + '<div class="probe"></div>'
      + '<div class="mfoot eFoot" style="margin-top:6px;"></div>'
      + '<div class="mfootbtns"><button class="btn btn-primary eSave">保存</button>'
      + '<button class="btn btn-ghost btn-sm btn-danger eDel">删除</button></div>';
    modal.appendChild(box);
    const eName = box.querySelector('.eName'); eName.value = p.name;
    const picker = iconPicker({ value: p.icon || '', autoIconId: p.autoIconId || '', nameOf: () => eName.value.trim() || p.name,
      preview: (el) => { const h = modal.querySelector('.mhead .picon'); if (h) h.replaceWith(el); } });
    box.querySelector('.ipickHost').appendChild(picker.el);
    eName.addEventListener('input', () => picker.repaint());
    let probeCred = '';
    const preferIds = (modelsByProvider[p.id] || []).filter((mm) => mm.enabled).map((mm) => mm.id);
    const probe = mountProbe(box.querySelector('.probe'), () => ({ id: p.id, credentialId: probeCred || undefined }), {
      models: editModalModels(p),
      preferIds,
      rowExtra: (m) => [capCell(p, m.id, 'reasoning', '推理'), capCell(p, m.id, 'image', '图片')],
    });
    // 账号池：每行一个已登录账号；「重新登录」针对那一把；「再登录一个账号」进同一个池
    const poolWidget = mountKeyPool(box.querySelector('.kpoolHost'), p, {
      onTest: (c) => { probeCred = c.id; poolWidget.setLatency(c.id, { cls: 'run' }); probe.runLatency((r) => poolWidget.setLatency(c.id, r)); },
      onRelogin: (c) => openOAuthModal(vendor, p, c.id),
      onAddAccount: () => openOAuthModal(vendor, p, 'new'),
    });
    editModal = { p, probe, foot: box.querySelector('.eFoot'), pool: poolWidget };
    renderEditModalModels();
    const lo = box.querySelector('.eLogout');
    if (lo) lo.addEventListener('click', () => {
      const n = (p.credentials || []).length;
      if (n <= 1) { vscode.postMessage({ type: 'clearProviderKey', id: p.id }); closeModal(); return; }
      confirmModal({
        icon: p.name, iconId: p.iconId, fallbackId: logoFallback(p), title: '退出全部 ' + n + ' 个账号？',
        desc: '「' + p.name + '」池里所有账号的登录都会被清除，provider 保留，之后可重新登录。',
        okText: '退出登录', danger: true,
        onOk: () => vscode.postMessage({ type: 'clearProviderKey', id: p.id }),
      });
    });
    box.querySelector('.eSave').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveProvider', id: p.id, name: eName.value, icon: picker.value });
      closeModal();
    });
    box.querySelector('.eDel').addEventListener('click', () => confirmDeleteProvider(p));
  }

  // ---------- 顶部 Tab 切换 ----------
  let curTab = 'models';
  function snapHeatmapToLatest() {
    const wrap = document.querySelector('.uhm-wrap');
    if (wrap) {
      wrap.scrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    }
  }

  function selectTab(name) {
    curTab = name;
    for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.tab === name; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    show($('page-models'), name === 'models');
    show($('page-providers'), name === 'providers');
    show($('page-usage'), name === 'usage');
    show($('page-settings'), name === 'settings' || name === 'prompts');

    if (name === 'usage') {
      requestAnimationFrame(() => {
        snapHeatmapToLatest();
        if (currentUsageMsg) {
          renderTrendCurve(currentUsageMsg.providers || [], currentUsageMsg.trend || [], currentUsageMsg.seriesTrend || [], currentUsageMsg.range || "today");
          renderSankey(currentUsageMsg.sankey || { nodes: [], links: [] });
        }
      });
    }
  }
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => selectTab(b.dataset.tab));

  // Tab 文字放不下就整排只留图标：容器查询只认宽度，认不出"哪个字被省略了"，所以量一下。
  // 先去掉 icons-only 按完整形态量，任一 .lbl 溢出就加回来——同一帧内完成，不会闪。
  function fitTabs() {
    const tabs = document.querySelector('.tabs');
    if (!tabs) return;
    tabs.classList.remove('icons-only');
    const truncated = Array.from(tabs.querySelectorAll('.tab .lbl')).some((l) => l.scrollWidth > l.clientWidth + 1);
    if (truncated) tabs.classList.add('icons-only');
  }
  if (typeof ResizeObserver !== 'undefined') {
    const tabsEl = document.querySelector('.tabs');
    if (tabsEl) new ResizeObserver(() => fitTabs()).observe(tabsEl);

    // 监听 Token 活动热力图容器：窗口被挤压折叠时，优先靠右显示最新日期
    const hmWrap = document.querySelector('.uhm-wrap');
    if (hmWrap) {
      new ResizeObserver(() => {
        snapHeatmapToLatest();
      }).observe(hmWrap);
    }

    // 监听 Token 趋势图卡片容器：面板被拉伸或挤压时，动态重绘铺满卡片窗口
    const trendBox = document.getElementById('uCurveSvg');
    if (trendBox) {
      let tRaf = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(tRaf);
        tRaf = requestAnimationFrame(() => {
          if (currentUsageMsg && curTab === 'usage') {
            renderTrendCurve(currentUsageMsg.providers || [], currentUsageMsg.trend || [], currentUsageMsg.seriesTrend || [], currentUsageMsg.range || "today");
          }
        });
      }).observe(trendBox);
    }
    const sankeyBox = $('uSankeySvg');
    if (sankeyBox) {
      let lastWidth = 0, sankeyFrame = 0;
      new ResizeObserver(() => {
        const width = sankeyBox.clientWidth;
        if (!width || width === lastWidth) return;
        lastWidth = width;
        cancelAnimationFrame(sankeyFrame);
        sankeyFrame = requestAnimationFrame(() => {
          if (currentUsageMsg && curTab === 'usage') renderSankey(currentUsageMsg.sankey);
        });
      }).observe(sankeyBox);
    }
  } else {
    window.addEventListener('resize', () => {
      fitTabs();
      snapHeatmapToLatest();
      if (currentUsageMsg && curTab === 'usage') {
        renderTrendCurve(currentUsageMsg.providers || [], currentUsageMsg.trend || [], currentUsageMsg.seriesTrend || [], currentUsageMsg.range || "today");
        renderSankey(currentUsageMsg.sankey);
      }
    });
  }
  fitTabs();

  // ---------- 模型页：「Kiro 模型列表」(已选，按渠道折叠，可删)；「添加模型」走弹窗 ----------
  // 能力标签：推理=橙，图片/多模态=青（只展示已确认支持的）。
  function capTags(mm) {
    const out = [];
    if (mm.reasoning === true) { const t = capChip('reasoning', '推理'); t.className = 'cap reason'; t.title = '推理模型'; out.push(t); }
    if (mm.image === true) { const t = capChip('image', '图片'); t.className = 'cap vision'; t.title = '支持图片输入（多模态）'; out.push(t); }
    return out;
  }
  function groupHead(p, rightText, foldable) {
    const gh = document.createElement('div'); gh.className = 'mgrouphead' + (foldable ? ' fold' : '');
    if (foldable) { const ch = document.createElement('span'); ch.className = 'gchev'; ch.textContent = '▶'; gh.appendChild(ch); }
    gh.appendChild(iconEl(p.name, p.iconId, logoFallback(p)));
    const gn = document.createElement('span'); gn.className = 'gn'; gn.textContent = p.name; gh.appendChild(gn);
    const gc = document.createElement('span'); gc.className = 'gc'; gc.textContent = rightText; gh.appendChild(gc);
    return gh;
  }
  // 渠道分组的折叠状态（页面上的已选列表）。默认展开；跨刷新保持。
  const groupOpen = {};
  const isGroupOpen = (id) => groupOpen[id] !== false;

  // 乐观更新：先改本地副本立刻重画，再通知扩展落盘。扩展回来的 models 消息会以真实
  // 状态覆盖——两者一致时用户看不到任何闪动，不一致（写失败）时才会跳回去。
  // 弹窗开着时也要一起重画，否则加进去的模型不会从候选池里消失。
  function setEnabledLocal(providerId, modelId, enabled) {
    const list = modelsByProvider[providerId] || [];
    for (const mm of list) if (mm.id === modelId) mm.enabled = enabled;
    renderModels(); renderAddModelModal();
  }
  function setAllEnabledLocal(providerId, enabled, onlyIds) {
    const list = modelsByProvider[providerId] || [];
    const pick = onlyIds ? new Set(onlyIds) : null;
    for (const mm of list) if (!pick || pick.has(mm.id)) mm.enabled = enabled;
    renderModels(); renderAddModelModal();
  }

  // ---------- 批量编辑态 ----------
  let editMode = false;
  const checked = new Set(); // provider\0model
  const ckey = (pid, mid) => pid + '\u0000' + mid;
  function ckEl(state) { const c = document.createElement('span'); c.className = 'ck' + (state === 'on' ? ' on' : state === 'some' ? ' some' : ''); c.textContent = state === 'some' ? '–' : '✓'; return c; }
  function setEditMode(on) {
    editMode = on;
    if (!on) checked.clear();
    document.body.classList.toggle('editing', on);
    show($('editBar'), on);
    const b = $('editModels'); b.textContent = on ? '完成' : '编辑'; b.classList.toggle('on', on);
    renderModels();
  }
  // 当前列表里所有 (provider, model) 键——全选 / 判断是否已全选用
  function pickedKeys() {
    const out = [];
    for (const p of lastProviders.filter((x) => x.enabled && x.usable)) for (const mm of (modelsByProvider[p.id] || [])) if (mm.enabled) out.push(ckey(p.id, mm.id));
    return out;
  }
  function updateEditBar() {
    const n = checked.size, total = pickedKeys().length;
    $('editCount').textContent = '已选 ' + n + ' / ' + total + ' 个';
    $('editRemove').disabled = n === 0;
    $('editAll').textContent = total && n >= total ? '取消全选' : '全选';
  }
  function removeChecked() {
    const byProv = {};
    for (const k of checked) { const i = k.indexOf('\u0000'); const pid = k.slice(0, i), mid = k.slice(i + 1); (byProv[pid] || (byProv[pid] = [])).push(mid); }
    const items = Object.keys(byProv).map((id) => ({ id, modelIds: byProv[id] }));
    if (!items.length) return;
    for (const it of items) setAllEnabledLocal(it.id, false, it.modelIds);
    vscode.postMessage({ type: 'removeModels', items });
    checked.clear();
    if (!pickedKeys().length) setEditMode(false); else renderModels();
  }
  $('editModels').addEventListener('click', () => setEditMode(!editMode));
  $('editDone').addEventListener('click', () => setEditMode(false));
  $('editRemove').addEventListener('click', removeChecked);
  $('editAll').addEventListener('click', () => {
    const all = pickedKeys();
    if (checked.size >= all.length) checked.clear(); else for (const k of all) checked.add(k);
    renderModels();
  });

  // 「预选」按该行在 Kiro 那边的 id（kiroId）匹配：同名模型在多个渠道都勾了时，第一个渠道是原 id、
  // 其余带 @渠道 限定（扩展侧 kiroModelIds 算好推过来），所以每个渠道的同名模型都能各自被预选。
  const kiroIdOf = (mm) => mm.kiroId || mm.id;
  function isDefaultRow(p, mm) { return !!selectedModel && selectedModel.toLowerCase() === kiroIdOf(mm).toLowerCase(); }

  function modelLine(p, mm, mode) {
    const isCur = mode === 'del' && isDefaultRow(p, mm);
    const isChecked = mode === 'del' && editMode && checked.has(ckey(p.id, mm.id));
    const line = document.createElement('div');
    line.className = 'mline' + (isCur ? ' selected' : '') + (mode === 'del' && editMode ? ' editing' : '') + (isChecked ? ' checked' : '');
    const mid = document.createElement('span'); mid.className = 'mid'; mid.textContent = mm.name || mm.id; mid.title = mm.id;
    if (mode === 'del') {
      if (editMode) line.appendChild(ckEl(isChecked ? 'on' : ''));
      // 名字 + 「默认」胶囊放同一个弹性盒：胶囊紧贴名字右侧，名字过长时只截名字。
      const nm = document.createElement('span'); nm.className = 'mname';
      nm.appendChild(mid);
      if (isCur) {
        const pill = document.createElement('span'); pill.className = 'defpill';
        pill.innerHTML = '<span class="dot"></span><span class="lbl">预选</span>';
        pill.title = '预选模型：Kiro 新会话默认使用它';
        nm.appendChild(pill);
      }
      line.appendChild(nm);
    } else {
      line.appendChild(mid);
    }
    for (const t of capTags(mm)) line.appendChild(t);
    if (mode === 'del') {
      if (editMode) {
        // 编辑态：点整行勾/取消勾；不响应双击设默认。
        line.title = isChecked ? '取消勾选' : '勾选以移除';
        line.addEventListener('click', () => { const k = ckey(p.id, mm.id); if (checked.has(k)) checked.delete(k); else checked.add(k); renderModels(); });
      } else {
        // 双击整行 = 设为预选（已是预选则不动）。行上禁用了文字选择，双击不会选中半个模型名。
        line.title = isCur ? '预选模型：Kiro 新会话默认使用它' : '双击设为预选（Kiro 新会话默认使用）';
        if (!isCur) line.addEventListener('dblclick', () => vscode.postMessage({ type: 'selectModel', modelId: kiroIdOf(mm) }));
      }
    } else {
      const add = document.createElement('button'); add.className = 'act add'; add.textContent = '+'; add.title = '加入 Kiro 模型列表';
      add.addEventListener('click', () => { setEnabledLocal(p.id, mm.id, true); vscode.postMessage({ type: 'setModelEnabled', id: p.id, modelId: mm.id, enabled: true }); });
      line.appendChild(add);
      mid.style.cursor = 'pointer';
      mid.addEventListener('click', () => add.click());
    }
    return line;
  }

  // 页面：已选模型，按渠道分组、组头可折叠、每行可删
  function renderModels() {
    const active = lastProviders.filter((p) => p.enabled && p.usable);
    const sel = $('selectedList'); sel.innerHTML = '';
    let enabledTotal = 0;
    for (const p of active) {
      const models = modelsByProvider[p.id] || [];
      const picked = models.filter((mm) => mm.enabled);
      enabledTotal += picked.length;
      if (!picked.length) continue;
      const open = isGroupOpen(p.id);
      // 预选模型所在的渠道：整张卡轻微高亮（描边泛紫、组名亮起），折叠着也看得出预选在哪一家
      const hasCur = picked.some((mm) => isDefaultRow(p, mm));
      const g = document.createElement('div'); g.className = 'mgroup' + (open ? ' open' : '') + (hasCur ? ' cur' : '');
      g.dataset.id = p.id;
      const gh = groupHead(p, picked.length + ' 个', true);
      gh.title = '按住可上下拖拽整组调整排序；点击折叠/展开';
      gh.addEventListener('pointerdown', (e) => startGroupDrag(e, g));
      if (editMode) {
        // 编辑态组头：全选框（全部已勾 ✓ / 部分 – / 无）。平时组头右侧什么都没有。
        const n = picked.filter((mm) => checked.has(ckey(p.id, mm.id))).length;
        const ck = ckEl(n === picked.length ? 'on' : n > 0 ? 'some' : '');
        ck.title = n === picked.length ? '取消勾选该渠道全部' : '勾选该渠道全部';
        ck.addEventListener('click', (e) => {
          e.stopPropagation();
          const all = n === picked.length;
          for (const mm of picked) { const k = ckey(p.id, mm.id); if (all) checked.delete(k); else checked.add(k); }
          renderModels();
        });
        gh.appendChild(ck);
      }
      const body = document.createElement('div'); body.className = 'gbody' + (open ? '' : ' collapsed');
      for (const mm of picked) body.appendChild(modelLine(p, mm, 'del'));
      g.appendChild(gh); g.appendChild(body);
      sel.appendChild(g);
    }
    if (!active.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = '还没有可用的 provider。先去「提供商」标签连接一个。';
      sel.appendChild(e);
    } else if (!enabledTotal) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = '还是空的 —— Kiro 的模型选择器目前没有任何模型。点上方「添加模型」加入。';
      sel.appendChild(e);
    }
    const tabModelsEl = $('tabModelsCnt'); if (tabModelsEl) tabModelsEl.textContent = enabledTotal ? String(enabledTotal) : '';
    renderBadge();
    fitTabs();
    const sum = $('modelSummary');
    sum.textContent = enabledTotal ? (enabledTotal + ' 个模型') : '空';
    sum.className = 'muted' + (enabledTotal ? '' : ' warn');
    show($('editModels'), enabledTotal > 0 || editMode);
    if (editMode) {
      // 列表被外部改动（扩展推来的 models）后，清掉已不在列表里的勾选；空了就退出编辑态。
      const valid = new Set(pickedKeys());
      for (const k of Array.from(checked)) if (!valid.has(k)) checked.delete(k);
      if (!enabledTotal) { setEditMode(false); return; }
      updateEditBar();
    }
  }

  // 弹窗：候选池（未加入的），搜索 + 逐个「+」+ 按渠道「全部加入 / 加入匹配」
  let addModal = null; // { list, q, sum } 弹窗开着时非空，用于实时重画
  // 弹窗里渠道分组的折叠状态（与页面上的 groupOpen 独立）。默认折叠；有搜索关键词时自动展开命中的组
  const poolOpen = {};
  const isPoolOpen = (id, q) => q ? (poolOpen[id] !== false) : !!poolOpen[id];
  function openAddModelModal() {
    for (const k of Object.keys(poolOpen)) delete poolOpen[k];
    const modal = buildModal('', '添加模型', '');
    modal.classList.add('addmodel');
    const box = document.createElement('div');
    box.innerHTML = '<div class="search"><input class="sq" type="text" placeholder="搜索模型…" spellcheck="false" autocomplete="off"><button class="sclear hidden" title="清空">✕</button></div>'
      + '<div class="muted msum2" style="margin:-2px 0 6px;"></div><div class="mlist"></div>'
      + '<div class="mfootbtns"><button class="btn btn-primary mDone">完成</button></div>';
    modal.appendChild(box);
    const q = box.querySelector('.sq'), clr = box.querySelector('.sclear');
    addModal = { list: box.querySelector('.mlist'), q, clr, sum: box.querySelector('.msum2') };
    q.addEventListener('input', () => { for (const k of Object.keys(poolOpen)) delete poolOpen[k]; renderAddModelModal(); });
    clr.addEventListener('click', () => { q.value = ''; renderAddModelModal(); q.focus(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; renderAddModelModal(); } else closeModal(); } });
    box.querySelector('.mDone').addEventListener('click', closeModal);
    renderAddModelModal();
    // 顺手让扩展把过期（>60s）的模型清单重拉一遍：拉到就推 models 消息，弹窗开着会就地刷新候选池
    vscode.postMessage({ type: 'refreshSoft' });
    setTimeout(() => q.focus(), 30);
  }
  function renderAddModelModal() {
    if (!addModal || !document.body.contains(addModal.list)) { addModal = null; return; }
    const { list, q: qi, clr, sum } = addModal;
    const q = (qi.value || '').trim().toLowerCase();
    show(clr, q.length > 0);
    list.innerHTML = '';
    const active = lastProviders.filter((p) => p.enabled && p.usable);
    let poolTotal = 0, poolShown = 0, total = 0;
    for (const p of active) {
      const models = modelsByProvider[p.id] || [];
      total += models.length;
      const rest = models.filter((mm) => !mm.enabled);
      poolTotal += rest.length;
      const matched = q ? rest.filter((mm) => (mm.name || mm.id).toLowerCase().includes(q) || mm.id.toLowerCase().includes(q)) : rest;
      if (!matched.length) continue;
      poolShown += matched.length;
      // 渠道分组默认折叠（状态独立于页面上的分组）；折叠时组头的计数仍能看出有多少可加 / 匹配。
      const open = isPoolOpen(p.id, q);
      const g = document.createElement('div'); g.className = 'mgroup pool' + (open ? ' open' : '');
      const gh = groupHead(p, q ? (matched.length + ' / ' + rest.length) : (rest.length + ' 个可加'), true);
      const all = document.createElement('button'); all.className = 'btn btn-ghost btn-sm';
      // 搜索中只加匹配到的这几个；没搜索就是该渠道全部。
      all.innerHTML = '✓<span class="lbl">&nbsp;' + (q ? '加入匹配' : '全部加入') + '</span>';
      all.title = q ? ('把匹配到的 ' + matched.length + ' 个加入 Kiro 列表') : '把该渠道的全部模型加入 Kiro 列表';
      const ids = matched.map((mm) => mm.id);
      all.addEventListener('click', (e) => { e.stopPropagation(); setAllEnabledLocal(p.id, true, q ? ids : null); vscode.postMessage({ type: 'setAllModelsEnabled', id: p.id, enabled: true, modelIds: q ? ids : undefined }); });
      gh.appendChild(all);
      const body = document.createElement('div'); body.className = 'gbody' + (open ? '' : ' collapsed');
      for (const mm of matched) body.appendChild(modelLine(p, mm, 'add'));
      gh.addEventListener('click', () => {
        const next = !isPoolOpen(p.id, q);
        poolOpen[p.id] = next;
        g.classList.toggle('open', next);
        body.classList.toggle('collapsed', !next);
      });
      g.appendChild(gh); g.appendChild(body);
      list.appendChild(g);
    }
    sum.textContent = poolTotal ? (q ? (poolShown + ' 个匹配 · 共 ' + poolTotal + ' 个可加') : (poolTotal + ' 个可加')) : (total ? '全部已加入' : '');
    if (!active.length) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '还没有可用的 provider，先去「提供商」页连接一个。'; list.appendChild(e);
    } else if (!total) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '未获取到模型（上游 /models 为空或拉取失败）。'; list.appendChild(e);
    } else if (!poolTotal) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '各渠道的模型都已加入。'; list.appendChild(e);
    } else if (!poolShown) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '没有匹配「' + q + '」的模型'; list.appendChild(e);
    }
    fitModalContent();
  }
  $('showAddModel').addEventListener('click', openAddModelModal);

  $('enable').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleEnabled', enabled: e.target.checked }));
  $('showAdd').addEventListener('click', openSelectModal);
  $('log').addEventListener('click', () => vscode.postMessage({ type: 'openLog' }));
  $('catRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshCatalog' }));
  $('ghRepo') && $('ghRepo').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: ${JSON.stringify(GITHUB_URL)} }));
  $('checkUpdate') && $('checkUpdate').addEventListener('click', () => vscode.postMessage({ type: 'checkUpdate' }));

  // ---------- 用量页 ----------
  // 紧凑 token 数：对齐 cc-switch formatTokensShort 的中文量纲（万 / 亿）
  const tokShort = (n) => { n = Number(n) || 0; if (n >= 1e8) return (n/1e8).toFixed(2) + ' 亿'; if (n >= 1e4) return (n/1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万'; return n.toLocaleString('en-US'); };
  const ms = (v) => v == null ? '--' : (v >= 1000 ? (v/1000).toFixed(1) + 's' : Math.round(v) + 'ms');
  const durStr = (msVal) => {
    if (!msVal || msVal <= 0) return '0秒';
    const sec = Math.floor(msVal / 1000);
    if (sec < 60) return sec + '秒';
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return min + '分' + (remSec ? remSec + '秒' : '');
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return hr + '小时' + (remMin ? ' ' + remMin + '分钟' : '');
  };
  const rateCls = (r) => r == null ? '' : r >= 0.98 ? 'good' : r >= 0.9 ? 'warn' : 'bad';
  const ratePct = (r) => r == null ? '--' : (r * 100).toFixed(r >= 0.995 ? 0 : 1) + '%';
  const timeHM = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2,'0'); return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); };
  const provOpen = {}; // providerId -> 是否展开到模型

  // 用量子组件状态与配色
  let currentUsageMsg = null;
  let hmMode = 'daily';     // 'daily' | 'weekly' | 'cumul'
  let curveDim = 'tokens';  // 'tokens' | 'requests'：趋势卡维度（时间范围统一由页顶「今天 / 7 天 / 30 天 / 全部」决定）
  let donutDim = 'tokens';  // 'tokens' | 'requests'
  let sankeyDim = 'tokens'; // 'tokens' | 'requests'

  const PALETTE = ['#06b6d4', '#10b981', '#3b82f6', '#f43f5e', '#f59e0b', '#14b8a6', '#ec4899', '#0ea5e9', '#eab308', '#f97316'];

  for (const b of document.querySelectorAll('.useg button')) b.addEventListener('click', () => {
    document.querySelectorAll('.useg button').forEach((x) => x.classList.toggle('sel', x === b));
    vscode.postMessage({ type: 'setUsageRange', range: b.dataset.r });
  });

  document.querySelectorAll('.useg-hm button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.useg-hm button').forEach((x) => x.classList.toggle('sel', x === b));
    hmMode = b.dataset.hm;
    if (currentUsageMsg) renderHeatmap(currentUsageMsg.heatmap || []);
  }));

  document.querySelectorAll('.useg-curve button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.useg-curve button').forEach((x) => x.classList.toggle('sel', x === b));
    curveDim = b.dataset.cv === 'requests' ? 'requests' : 'tokens';
    if (currentUsageMsg) renderTrendCurve(currentUsageMsg.providers || [], currentUsageMsg.trend || [], currentUsageMsg.seriesTrend || [], currentUsageMsg.range || "today");
  }));

  document.querySelectorAll('.useg-dim button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.useg-dim button').forEach((x) => x.classList.toggle('sel', x === b));
    donutDim = b.dataset.dim;
    if (currentUsageMsg) renderDonut(currentUsageMsg.modelRatios || []);
  }));

  document.querySelectorAll('.useg-sk button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.useg-sk button').forEach((x) => x.classList.toggle('sel', x === b));
    sankeyDim = b.dataset.sk;
    const subEl = $('sankeySub');
    if (subEl) {
      subEl.innerHTML = sankeyDim === 'tokens'
        ? '渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态 &rarr; 缓存命中 / Token 细分'
        : '渠道 &rarr; 凭证 &rarr; 模型 &rarr; 状态';
    }
    if (currentUsageMsg) renderSankey(currentUsageMsg.sankey || { nodes: [], links: [] });
  }));

  $('uRefresh').addEventListener('click', () => { $('uRefresh').textContent = '…'; vscode.postMessage({ type: 'refreshUsage' }); });
  $('uClear').addEventListener('click', () => confirmModal({
    icon: '用', iconId: 'glyph:bars-ring', title: '清空本地用量统计？', desc: '会删除全部请求记录与汇总，不可恢复。', okText: '清空', danger: true,
    onOk: () => vscode.postMessage({ type: 'clearUsage', confirmed: true }),
  }));

  // 1. 渲染 Token 活动热力图 (GitHub / newapi 风格 52周 x 7天)
  function renderHeatmap(days) {
    const box = $('uHeatmapSvg');
    if (!box) return;
    if (!days || !days.length) {
      box.innerHTML = '<div class="empty small" style="text-align:center;">暂无热力图数据</div>';
      return;
    }

    const cellSize = 10;
    const cellGap = 3;
    const numRows = 7;
    const numCols = Math.ceil(days.length / numRows);
    const width = numCols * (cellSize + cellGap) + 10;
    const height = numRows * (cellSize + cellGap) + 20;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" style="display:block;">';

    // 累积状态或每周状态处理
    let maxVal = Math.max(1, ...days.map((d) => d.tokens));
    let runSum = 0;

    days.forEach((d, idx) => {
      const col = Math.floor(idx / numRows);
      const row = idx % numRows;
      const x = col * (cellSize + cellGap);
      const y = row * (cellSize + cellGap);

      let lvl = d.level;
      let displayTokens = d.tokens;
      let displayReqs = d.requests;

      if (hmMode === 'cumul') {
        runSum += d.tokens;
        displayTokens = runSum;
        const p = maxVal > 0 ? (runSum / (maxVal * 20)) : 0;
        lvl = runSum > 0 ? (p > 0.6 ? 4 : p > 0.3 ? 3 : p > 0.1 ? 2 : 1) : 0;
      }

      const tipText = d.date + '&#10;' + fmt(displayTokens) + ' tokens · ' + fmt(displayReqs) + ' 次请求';
      svg += '<rect class="hm-cell hm-l' + lvl + '" x="' + x + '" y="' + y + '" width="' + cellSize + '" height="' + cellSize + '" title="' + tipText + '" data-k-tip="' + tipText + '"></rect>';
    });

    // 底部月份刻度标 (每隔约 4-5 列标一次月份)
    let lastMonth = -1;
    for (let c = 0; c < numCols; c++) {
      const dIdx = c * numRows;
      if (dIdx < days.length) {
        const dObj = new Date(days[dIdx].dayTs);
        const m = dObj.getMonth() + 1;
        if (m !== lastMonth && (c === 0 || c - lastMonth >= 3)) {
          lastMonth = m;
          const x = c * (cellSize + cellGap);
          svg += '<text class="hm-month-txt" x="' + x + '" y="' + (height - 4) + '">' + m + '月</text>';
        }
      }
    }

    svg += '</svg>';
    box.innerHTML = svg;
    requestAnimationFrame(() => {
      snapHeatmapToLatest();
    });
  }

  // 2. 渲染每日 Token 趋势平滑贝塞尔曲线图
  function renderTrendCurve(provs, rawTrend, seriesTrend, currentRange) {
    const box = document.getElementById('uCurveSvg');
    const legBox = document.getElementById('uCurveLegend');
    if (!box || !legBox) return;
    // 维度：Token（默认）或请求次数。同一份时间序列，两个维度各自成图；标题随维度切换。
    const isTok = curveDim !== 'requests';
    const title = document.getElementById('trendTitle');
    if (title) title.textContent = isTok ? '每日 Token 趋势图' : '每日 请求 趋势图';
    const valOf = (d) => (isTok ? d.tokens : d.requests) || 0;
    const modelValOf = (d, m) => ((isTok ? d.modelTokens : d.modelRequests) || {})[m] || 0;
    const fmtVal = (v) => (isTok ? tokShort(v) : fmt(Math.round(v)));
    const unitText = (v) => (isTok ? fmt(v) + ' tokens' : fmt(v) + ' 次');

    // 优先使用连续时间轴数据点（当天24小时/7天/30天），保证完整连线与渐变面积
    let dataPoints = [];
    if (Array.isArray(seriesTrend) && seriesTrend.length > 0) {
      dataPoints = seriesTrend;
    } else if (Array.isArray(rawTrend) && rawTrend.length > 0) {
      dataPoints = rawTrend.map((d) => ({
        ts: d.day,
        label: (new Date(d.day).getMonth() + 1) + '/' + new Date(d.day).getDate(),
        tokens: d.tokens,
        requests: d.requests,
        modelTokens: {},
        modelRequests: {},
      }));
    }

    if (!dataPoints || !dataPoints.length) {
      box.innerHTML = '<div class="empty small" style="text-align:center;padding:50px 0;">暂无趋势数据</div>';
      legBox.innerHTML = '';
      return;
    }
    // 「全部」范围的连续序列会从纪元起逐日补零（宿主按 range.from=0 生成）；超过一个月的序列只保留首个有数据的点起的尾段，
    // 无数据时保留最新 31 点。挤压时优先显示最新日期，也避免几万个隐藏悬停节点。
    if (dataPoints.length > 31) {
      const first = dataPoints.findIndex((p) => (p.tokens > 0) || (p.requests > 0));
      const keepFrom = first < 0 ? dataPoints.length - 31 : Math.min(first, dataPoints.length - 7);
      if (keepFrom > 0) dataPoints = dataPoints.slice(keepFrom);
    }

    // 提取 top 模型（最多前 4 个模型分曲线，对齐 cc-switch 风格）；按当前维度的合计排名
    const modelTotals = {};
    dataPoints.forEach((pt) => {
      const bag = (isTok ? pt.modelTokens : pt.modelRequests) || {};
      Object.keys(bag).forEach((m) => {
        modelTotals[m] = (modelTotals[m] || 0) + (bag[m] || 0);
      });
    });
    const topModels = Object.keys(modelTotals).filter((m) => modelTotals[m] > 0).sort((a, b) => modelTotals[b] - modelTotals[a]).slice(0, 4);

    const mainColor = '#a66cff'; // 主题荧光紫
    legBox.innerHTML = '';

    // 渲染图例
    const addLegend = (name, color, dashed) => {
      const item = document.createElement('div');
      item.className = 'ucurve-item';
      const dotStyle = dashed
        ? 'width:14px;height:2px;background:' + color + ';border-radius:1px;flex:none;'
        : 'width:8px;height:8px;border-radius:50%;background:' + color + ';flex:none;';
      item.innerHTML = '<span class="ucurve-dot" style="' + dotStyle + '"></span><span>' + esc(name) + '</span>';
      legBox.appendChild(item);
    };

    addLegend(isTok ? '总用量' : '总请求', mainColor, false);
    topModels.forEach((m, i) => addLegend(m, PALETTE[(i + 1) % PALETTE.length], false));

    // 动态感知当前容器实际宽度与高度，长宽比自动调整铺满卡片窗口
    const W = Math.max(120, box.clientWidth || 280);
    const H = Math.max(110, box.clientHeight || 140);
    const isUltraNarrow = W < 180;
    const isNarrow = W < 230;
    const axisFont = isUltraNarrow ? 8.5 : 10;
    const gridSteps = isUltraNarrow ? 2 : 3;
    // 纵轴上限：Token 维至少 100；请求维是整数，上限抬到 gridSteps 的倍数让每格刻度都是整数（不出现「1.7 次」）
    let maxVal = Math.max(isTok ? 100 : gridSteps, ...dataPoints.map(valOf));
    if (!isTok) maxVal = Math.ceil(maxVal / gridSteps) * gridSteps;
    // 左侧留白按最宽的纵轴刻度文字（如「6988 万」）估算，固定 36px 会把首位数字裁掉
    const axisTextWidth = (text) => {
      let w = 0;
      for (const ch of text) w += ch.codePointAt(0) > 255 ? axisFont : (ch === ' ' ? axisFont * 0.3 : axisFont * 0.6);
      return w;
    };
    const widestTick = Math.max(...Array.from({ length: gridSteps + 1 }, (_, g) => axisTextWidth(fmtVal(maxVal * (1 - g / gridSteps)))));
    const padL = Math.ceil(Math.max(isUltraNarrow ? 22 : isNarrow ? 28 : 36, widestTick + 6));
    const padR = isUltraNarrow ? 6 : isNarrow ? 10 : 14;
    const padT = 12;
    const padB = 20;
    const innerW = Math.max(40, W - padL - padR);
    const innerH = Math.max(40, H - padT - padB);

    const stepX = innerW / Math.max(1, dataPoints.length - 1);
    const getY = (val) => padT + innerH - (val / maxVal) * innerH;

    const points = dataPoints.map((d, i) => ({
      x: padL + i * stepX,
      y: getY(valOf(d)),
      data: d,
    }));

    // 平滑三次贝塞尔曲线
    const makePath = (pts) => {
      if (!pts || !pts.length) return '';
      if (pts.length === 1) {
        return 'M ' + pts[0].x + ' ' + pts[0].y + ' L ' + (pts[0].x + 1) + ' ' + pts[0].y;
      }
      let p = 'M ' + pts[0].x + ' ' + pts[0].y;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const cx = (p0.x + p1.x) / 2;
        p += ' C ' + cx + ' ' + p0.y + ', ' + cx + ' ' + p1.y + ', ' + p1.x + ' ' + p1.y;
      }
      return p;
    };

    const mainLinePath = makePath(points);
    const mainAreaPath = points.length > 1
      ? mainLinePath + ' L ' + points[points.length - 1].x + ' ' + (padT + innerH) + ' L ' + points[0].x + ' ' + (padT + innerH) + ' Z'
      : '';

    // 使用 preserveAspectRatio="none" 结合 100% 宽高，确保面积和曲线铺满窗口且自适应伸展
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="100%" preserveAspectRatio="none" style="display:block;width:100%;height:100%;overflow:visible;">';

    // 渐变定义（CC Switch 风格半透明渐变面积）
    svg += '<defs>'
      + '<linearGradient id="cvGradMain" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="' + mainColor + '" stop-opacity="0.32" />'
      + '<stop offset="90%" stop-color="' + mainColor + '" stop-opacity="0.0" />'
      + '</linearGradient>';

    topModels.forEach((m, i) => {
      const c = PALETTE[(i + 1) % PALETTE.length];
      svg += '<linearGradient id="cvGrad_' + i + '" x1="0" y1="0" x2="0" y2="1">'
        + '<stop offset="0%" stop-color="' + c + '" stop-opacity="0.18" />'
        + '<stop offset="90%" stop-color="' + c + '" stop-opacity="0.0" />'
        + '</linearGradient>';
    });
    svg += '</defs>';

    // 水平虚线网格（超窄屏适当减少档数，保持清爽）
    for (let g = 0; g <= gridSteps; g++) {
      const gy = padT + (innerH / gridSteps) * g;
      const gVal = maxVal * (1 - g / gridSteps);
      svg += '<line class="cv-grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>';
      svg += '<text class="cv-axis-txt" x="' + (padL - 4) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="' + axisFont + '">' + fmtVal(gVal) + '</text>';
    }

    const modelCurves = topModels.map((m, i) => {
      const pts = dataPoints.map((d, idx) => ({
        x: padL + idx * stepX,
        y: getY(modelValOf(d, m)),
      }));
      const line = makePath(pts);
      const area = pts.length > 1
        ? line + ' L ' + pts[pts.length - 1].x + ' ' + (padT + innerH) + ' L ' + pts[0].x + ' ' + (padT + innerH) + ' Z'
        : '';
      return { model: m, color: PALETTE[(i + 1) % PALETTE.length], line, area };
    });

    // SVG 按顺序覆盖：所有面积必须先于描边，总用量必须先于模型线。
    svg += '<g class="cv-areas" pointer-events="none">';
    if (mainAreaPath) svg += '<path d="' + mainAreaPath + '" fill="url(#cvGradMain)"></path>';
    modelCurves.forEach((curve, i) => {
      if (curve.area) svg += '<path d="' + curve.area + '" fill="url(#cvGrad_' + i + ')"></path>';
    });
    svg += '</g><g class="cv-lines" pointer-events="none">';
    svg += '<path class="cv-path" d="' + mainLinePath + '" stroke="' + mainColor + '"></path>';
    modelCurves.forEach((curve) => {
      svg += '<path class="cv-model-path" data-model="' + esc(curve.model) + '" d="' + curve.line + '" stroke="' + curve.color + '"></path>';
    });
    svg += '</g>';

    // 交互式数据点切片：平时完全隐藏无圆点，鼠标滑过/悬停时平滑浮现发光点、辅助垂直虚线与精致富文本气泡
    points.forEach((pt) => {
      // 气泡：主行是当前维度，右上角副值是另一维度（Token 维看请求数，请求维看 Token 数）
      let tipHtml = '<div class="tip-card">'
        + '<div class="tip-hdr"><span class="tip-date">' + esc(pt.data.label) + '</span><span class="tip-req">' + (isTok ? fmt(pt.data.requests || 0) + ' 次请求' : tokShort(pt.data.tokens || 0) + ' tokens') + '</span></div>'
        + '<div class="tip-total"><span class="tip-lbl">' + (isTok ? '总用量' : '总请求') + '</span><span class="tip-val">' + unitText(valOf(pt.data)) + '</span></div>';

      {
        let hasModels = false;
        let mListHtml = '<div class="tip-models">';
        topModels.forEach((m, mIdx) => {
          const mv = modelValOf(pt.data, m);
          if (mv > 0) {
            hasModels = true;
            const mColor = PALETTE[(mIdx + 1) % PALETTE.length];
            mListHtml += '<div class="tip-mrow"><div class="tip-mleft"><span class="tip-mdot" style="background:' + mColor + ';"></span><span class="tip-mname">' + esc(m) + '</span></div><span class="tip-mval">' + fmtVal(mv) + '</span></div>';
          }
        });
        mListHtml += '</div>';
        if (hasModels) tipHtml += mListHtml;
      }
      tipHtml += '</div>';

      const colW = Math.max(16, stepX);
      const colX = pt.x - colW / 2;

      svg += '<g class="cv-col-group">';
      // 垂直对齐辅助虚线
      svg += '<line class="cv-ref-line" x1="' + pt.x + '" y1="' + padT + '" x2="' + pt.x + '" y2="' + (padT + innerH) + '"></line>';

      // 重合位置只显示模型色点，避免总量白点再次遮住模型。
      const overlapsModel = topModels.some((m) => {
        const value = modelValOf(pt.data, m);
        return value > 0 && Math.abs(getY(value) - pt.y) < 0.5;
      });
      if (!overlapsModel) {
        svg += '<circle class="cv-dot-halo" cx="' + pt.x + '" cy="' + pt.y + '" r="4" fill="none" stroke="' + mainColor + '" stroke-width="1" stroke-opacity="0.45"></circle>';
        svg += '<circle class="cv-dot-main" cx="' + pt.x + '" cy="' + pt.y + '" r="2.3" fill="#ffffff" stroke="' + mainColor + '" stroke-width="1"></circle>';
      }
      topModels.forEach((m, mIdx) => {
        const mv = modelValOf(pt.data, m);
        if (mv > 0) {
          const mColor = PALETTE[(mIdx + 1) % PALETTE.length];
          const mY = getY(mv);
          svg += '<circle class="cv-dot-model" cx="' + pt.x + '" cy="' + mY + '" r="2.5" fill="' + mColor + '" stroke="#140e22" stroke-width="0.8"></circle>';
        }
      });

      // 全高透明交互矩形：扩大感应区域，绑定富文本气泡
      svg += '<rect class="cv-hover-rect" x="' + colX + '" y="0" width="' + colW + '" height="' + H + '" data-k-tip-html="1" data-k-tip="' + esc(tipHtml) + '"></rect>';
      svg += '</g>';
    });

    // 底部横坐标：根据实际可用宽度动态自适应步长；以最新一点为锚向左等距取标签，
    // 挤压时优先保留最新日期，且任意两枚标签间距都不小于一个步长（旧写法从最旧点起步会让末两枚贴在一起）
    const totalPts = points.length;
    const minLabelWidth = isUltraNarrow ? 55 : isNarrow ? 45 : 40;
    const maxLabels = Math.max(2, Math.floor(innerW / minLabelWidth));
    const stride = Math.max(1, Math.ceil(totalPts / maxLabels));
    points.forEach((pt, i) => {
      if ((totalPts - 1 - i) % stride === 0) {
        svg += '<text class="cv-axis-txt" x="' + pt.x + '" y="' + (H - 4) + '" text-anchor="middle" font-size="' + (isUltraNarrow ? '8.5' : '10') + '">' + esc(pt.data.label) + '</text>';
      }
    });

    svg += '</svg>';
    box.innerHTML = svg;
  }

  function renderDonut(ratios) {
    const box = $('uDonutSvg');
    const leg = $('uDonutLegend');
    if (!box || !leg) return;

    if (!ratios || !ratios.length) {
      box.innerHTML = '<div class="empty small" style="text-align:center;padding-top:45px;">暂无数据</div>';
      leg.innerHTML = '';
      return;
    }

    const isTok = donutDim === 'tokens';
    const totalVal = ratios.reduce((acc, x) => acc + (isTok ? x.tokens : x.requests), 0);
    // 直接展示所有真实模型 ID，完全不合并为“其他模型”！
    const sorted = ratios.slice().filter((x) => (isTok ? x.tokens : x.requests) > 0).sort((a, b) => (isTok ? b.tokens - a.tokens : b.requests - a.requests));

    if (!sorted.length || totalVal <= 0) {
      box.innerHTML = '<div class="empty small" style="text-align:center;padding-top:45px;">暂无数据</div>';
      leg.innerHTML = '';
      return;
    }

    const cx = 70;
    const cy = 70;
    const R = 54; // 外半径
    const r = 38; // 内半径

    let svg = '<svg viewBox="0 0 140 140" width="140" height="140" style="display:block;overflow:visible;">';
    // 背景底环
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="' + (R - r) + '"></circle>';

    leg.innerHTML = '';

    // 如果只有一个模型，画一个完整圆环
    if (sorted.length === 1) {
      const item = sorted[0];
      const color = PALETTE[0];
      const val = isTok ? item.tokens : item.requests;
      const tipText = esc(item.model) + '&#10;' + (isTok ? fmt(val) + ' tokens' : fmt(val) + ' 次') + ' (100%)';
      svg += '<circle class="donut-slice" cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' + color + '" stroke-width="' + (R - r) + '" title="' + tipText + '" data-k-tip="' + tipText + '"></circle>';

      const row = document.createElement('div');
      row.className = 'd-leg-row';
      row.innerHTML = '<div class="d-leg-left"><span class="d-leg-dot" style="background:' + color + ';"></span><span class="d-leg-name" title="' + esc(item.model) + '">' + esc(item.model) + '</span></div>'
        + '<div class="d-leg-right"><span>' + (isTok ? tokShort(val) : fmt(val)) + '</span><span class="d-leg-pct">100%</span></div>';
      leg.appendChild(row);
    } else {
      let currentAngle = -Math.PI / 2; // 从 12 点钟方向开始顺时针旋转
      sorted.forEach((item, idx) => {
        const color = PALETTE[idx % PALETTE.length];
        const val = isTok ? item.tokens : item.requests;
        const pct = val / totalVal;
        const sweepAngle = pct * 2 * Math.PI;
        const endAngle = currentAngle + sweepAngle;

        // 计算扇形内外弧的 4 个端点坐标
        const x0 = cx + R * Math.cos(currentAngle);
        const y0 = cy + R * Math.sin(currentAngle);
        const x1 = cx + R * Math.cos(endAngle);
        const y1 = cy + R * Math.sin(endAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const x3 = cx + r * Math.cos(currentAngle);
        const y3 = cy + r * Math.sin(currentAngle);

        const largeArc = sweepAngle > Math.PI ? 1 : 0;
        const pathD = 'M ' + x0.toFixed(2) + ' ' + y0.toFixed(2)
          + ' A ' + R + ' ' + R + ' 0 ' + largeArc + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2)
          + ' L ' + x2.toFixed(2) + ' ' + y2.toFixed(2)
          + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 0 ' + x3.toFixed(2) + ' ' + y3.toFixed(2)
          + ' Z';

        const pctTxt = (pct * 100).toFixed(pct >= 0.1 ? 1 : 0) + '%';
        const tipText = esc(item.model) + '&#10;' + (isTok ? fmt(val) + ' tokens' : fmt(val) + ' 次') + ' (' + pctTxt + ')';

        // 真实几何互斥扇区：每个 path 只占自身角度，物理空间完全隔离，绝不发生命中穿透！
        svg += '<path class="donut-slice" d="' + pathD + '" fill="' + color + '" title="' + tipText + '" data-k-tip="' + tipText + '"></path>';

        currentAngle = endAngle;

        // 图例项：直接展示真实模型 ID
        const row = document.createElement('div');
        row.className = 'd-leg-row';
        row.innerHTML = '<div class="d-leg-left"><span class="d-leg-dot" style="background:' + color + ';"></span><span class="d-leg-name" title="' + esc(item.model) + '">' + esc(item.model) + '</span></div>'
          + '<div class="d-leg-right"><span>' + (isTok ? tokShort(val) : fmt(val)) + '</span><span class="d-leg-pct">' + pctTxt + '</span></div>';
        leg.appendChild(row);
      });
    }

    svg += '</svg>';
    svg += '<div class="donut-center"><span class="donut-c-val">' + (isTok ? tokShort(totalVal) : fmt(totalVal)) + '</span><span class="donut-c-lbl">' + (isTok ? 'tokens' : '次请求') + '</span></div>';
    box.innerHTML = svg;
  }

  function layoutSankey(data, dimension, width) {
    const isReq = dimension === 'requests';
    const minW = 680;
    const W = (Number.isFinite(width) && width > 0) ? Math.max(minW, width) : minW;
    const empty = { width: W, height: 120, nodes: [], links: [], scale: 0 };
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) return empty;
    const byId = new Map();
    const stableColor = (id) => {
      if (id === 's:success') return '#34d399';
      if (id === 's:failed') return '#fb7185';
      if (id === 't:cache_read') return '#10b981';
      if (id === 't:cache_write') return '#a855f7';
      if (id === 't:input') return '#38bdf8';
      if (id === 't:output') return '#f59e0b';
      // Layer 5 微观去向色板
      if (id === 'ctx:files') return '#38bdf8';
      if (id === 'ctx:history') return '#818cf8';
      if (id === 'ctx:tools') return '#c084fc';
      if (id === 'ctx:rules') return '#f43f5e';
      if (id === 'ctx:current') return '#34d399';
      if (id === 'out:completion') return '#f59e0b';
      let hash = 0;
      for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      return PALETTE[hash % PALETTE.length];
    };
    ((data || {}).nodes || []).forEach((node) => {
      if (!node || typeof node.id !== 'string' || byId.has(node.id)) return;
      const layer = Number(node.layer);
      if (!Number.isInteger(layer) || layer < 0) return;
      // 次数维度只丢掉 Token/上下文去向节点，不能按层号>3 过滤（稀疏层会把状态层映射到 27）
      if (isReq && /^(t:|ctx:|out:)/.test(node.id)) return;
      byId.set(node.id, {
        id: node.id, name: String(node.name || node.id), layer,
        value: 0, inValue: 0, outValue: 0, incoming: [], outgoing: [],
        color: node.color || stableColor(node.id),
      });
    });
    const links = [];
    ((data || {}).links || []).forEach((link) => {
      if (!link) return;
      const src = byId.get(link.source), tgt = byId.get(link.target);
      if (!src || !tgt) return;
      if (isReq && (/^(t:|ctx:|out:)/.test(src.id) || /^(t:|ctx:|out:)/.test(tgt.id))) return;
      const value = Number(isReq ? link.requests : link.tokens);
      if (src.layer >= tgt.layer || !Number.isFinite(value) || value <= 0) return;
      const edge = { source: src.id, target: tgt.id, value, width: 0, sy: 0, ty: 0 };
      links.push(edge);
      src.outgoing.push(edge); tgt.incoming.push(edge);
      src.outValue += value; tgt.inValue += value;
    });
    if (!links.length) return empty;

    const nodes = [...byId.values()].filter((node) => node.incoming.length || node.outgoing.length);
    const layerMap = new Map();
    nodes.forEach((node) => {
      node.value = Math.max(node.inValue, node.outValue);
      if (!layerMap.has(node.layer)) layerMap.set(node.layer, []);
      layerMap.get(node.layer).push(node);
      if (node.id.startsWith('c:') && node.incoming.length) {
        const primary = node.incoming.reduce((a, b) => a.value >= b.value ? a : b);
        node.color = byId.get(primary.source).color;
      }
    });
    const layers = [...layerMap.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    if (!layers.length) return empty;

    // 1. 无交叉层级拓扑对齐排序：首层按流量降序；其余各层按主来源父级在上一层的位置归拢，同父级内按流量降序
    layers[0].sort((a, b) => (b.value - a.value) || a.id.localeCompare(b.id));

    for (let l = 1; l < layers.length; l++) {
      const prevLayer = layers[l - 1];
      layers[l].sort((a, b) => {
        const primaryA = a.incoming.reduce((m, e) => e.value > m.value ? e : m, a.incoming[0]);
        const primaryB = b.incoming.reduce((m, e) => e.value > m.value ? e : m, b.incoming[0]);
        const parentA = primaryA ? byId.get(primaryA.source) : null;
        const parentB = primaryB ? byId.get(primaryB.source) : null;
        const idxA = parentA ? prevLayer.indexOf(parentA) : 999;
        const idxB = parentB ? prevLayer.indexOf(parentB) : 999;
        if (idxA !== idxB) return idxA - idxB;
        return (b.value - a.value) || a.id.localeCompare(b.id);
      });
    }

    // 2. 语义层覆盖排序：只作用于含状态 / Token / 上下文去向节点的层；渠道、凭证、模型层保留上面的父级归拢顺序
    const semanticId = /^(s:|t:|ctx:|out:)/;
    layers.forEach((layer) => {
      if (!layer.some((node) => semanticId.test(node.id))) return;
      layer.sort((a, b) => {
        if (a.id === 's:success') return -1;
        if (b.id === 's:success') return 1;
        if (a.id === 's:failed') return 1;
        if (b.id === 's:failed') return -1;
        const orderTok = { 't:cache_read': 1, 't:cache_write': 2, 't:input': 3, 't:output': 4 };
        if (orderTok[a.id] && orderTok[b.id]) return orderTok[a.id] - orderTok[b.id];
        const orderCtx = { 'ctx:files': 1, 'ctx:history': 2, 'ctx:tools': 3, 'ctx:rules': 4, 'ctx:current': 5, 'out:completion': 6 };
        if (orderCtx[a.id] && orderCtx[b.id]) return orderCtx[a.id] - orderCtx[b.id];
        return (b.value - a.value) || a.id.localeCompare(b.id);
      });
    });

    // 3. 全局统一物理比例尺：门高 = value*scale，连线宽 = value*scale，二者用同一把尺，门与流严丝合缝。
    //    极小节点不抬高门（抬高就会出现门比流高、流贴在门顶的错位）；改为给每个节点一个 ≥14px 的「槽位」
    //    只用于标签与悬停感应区，门本身居中放在槽位里，几何仍是真实用量。
    //    槽位 14 + 间隙 8 = 每行 22px（11px 标签留 11px 空行）；原 16 + 12 = 28 被用户指出「上下间距比较大」。
    const padY = 24, padL = 18, padR = 150, nodeW = 12, gap = 8, minSlot = 14;
    const maxLayerSum = Math.max(...layers.map((layer) => layer.reduce((sum, n) => sum + n.value, 0)));
    const scale = 230 / Math.max(1, maxLayerSum);

    let maxReqH = 0;
    layers.forEach((layer) => {
      const sumH = layer.reduce((s, n) => s + Math.max(minSlot, n.value * scale), 0) + (layer.length - 1) * gap;
      if (sumH > maxReqH) maxReqH = sumH;
    });
    const H = padY * 2 + maxReqH;
    const stepX = (W - padL - padR - nodeW) / Math.max(1, layers.length - 1);

    // 4. 统一主干水平对齐：每层从 padY 起按槽位堆叠，最大节点的槽位就是它自己的门高，所以主干顶边对齐
    layers.forEach((layer, lIdx) => {
      let y = padY;
      layer.forEach((node) => {
        const h = node.value * scale;
        const slot = Math.max(minSlot, h);
        node.x = padL + lIdx * stepX;
        node.w = nodeW;
        node.h = h;
        node.slotY = y;
        node.slotH = slot;
        node.y = y + (slot - h) / 2;
        y += slot + gap;
      });
    });

    // 5. 严格等宽连线几何计算
    links.forEach((link) => {
      link.width = link.value * scale;
      link.color = byId.get(link.source).color;
    });

    nodes.forEach((node) => {
      node.outgoing.sort((a, b) => byId.get(a.target).y - byId.get(b.target).y || a.target.localeCompare(b.target));
      node.incoming.sort((a, b) => byId.get(a.source).y - byId.get(b.source).y || a.source.localeCompare(b.source));

      let sy = node.y;
      node.outgoing.forEach((link) => {
        link.sy = sy;
        sy += link.width;
      });

      let ty = node.y;
      node.incoming.forEach((link) => {
        link.ty = ty;
        ty += link.width;
      });
    });

    return {
      width: W, height: H, scale,
      nodes: nodes.map(({ incoming, outgoing, ...node }) => node),
      links,
    };
  }

  function renderSankey(data) {
    const box = $('uSankeySvg');
    if (!box) return;
    if (kTipTarget && box.contains(kTipTarget)) hideKTip();
    const layout = layoutSankey(data, sankeyDim, box.clientWidth);
    // 显式 CSS 像素高度避免宽屏按 SVG 宽高比把整张图拉长。
    box.style.height = layout.height + 'px';
    if (!layout.links.length) {
      box.innerHTML = '<div class="empty small" style="text-align:center;padding:32px 0;">当前范围暂无' + (sankeyDim === 'tokens' ? ' Token 分流' : '请求分流') + '数据</div>';
      return;
    }
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const valueText = (value) => fmt(value) + (sankeyDim === 'tokens' ? ' tokens' : ' 次请求');
    let svg = '<svg viewBox="0 0 ' + layout.width + ' ' + layout.height + '" width="100%" height="' + layout.height + '" preserveAspectRatio="none" role="img" aria-label="渠道到模型的用量分流图">';
    const orderedLinks = layout.links.slice().sort((a, b) => b.width - a.width);
    // 流带端点向门内延伸 2px（门宽 12px，门在流带之后绘制且不透明），门/流交界处不再出现抗锯齿暗缝；
    // 所有流带放在同一个 <g opacity> 里统一半透明。几何（sy/ty/w）不变。
    const overlap = 2;
    // 同一门边上相邻两条流带共享一条边：抗锯齿会让这条边的像素被两条带各覆盖一半、合成后仍透出底色，形成一条暗线。
    // 让上面那条带的底边多画 ≤0.6px（不超过下面那条带宽度的 40%，末条不延伸），共享边像素被完整盖住，暗线消失。
    const seamPad = (bands, key) => {
      const pads = new Map();
      const sorted = bands.slice().sort((a, b) => a[key] - b[key]);
      sorted.forEach((band, i) => { pads.set(band, i + 1 < sorted.length ? Math.min(0.6, sorted[i + 1].width * 0.4) : 0); });
      return pads;
    };
    const outPad = new Map(), inPad = new Map();
    layout.nodes.forEach((node) => {
      seamPad(layout.links.filter((l) => l.source === node.id), 'sy').forEach((pad, band) => outPad.set(band, pad));
      seamPad(layout.links.filter((l) => l.target === node.id), 'ty').forEach((pad, band) => inPad.set(band, pad));
    });
    svg += '<g class="sk-links" opacity="0.42">';
    orderedLinks.forEach((link) => {
      const src = byId.get(link.source), tgt = byId.get(link.target);
      const x0 = src.x + src.w - overlap, x1 = tgt.x + overlap, cx = (x0 + x1) / 2;
      const sy = link.sy, ty = link.ty, w = link.width;
      const e0 = outPad.get(link) || 0, e1 = inPad.get(link) || 0;
      // 严格平行三次贝塞尔等宽带：两端竖直切口，宽度处处等于 w（底边只多出上面说的抗锯齿补丁量）
      const d = 'M ' + x0 + ' ' + sy + ' C ' + cx + ' ' + sy + ', ' + cx + ' ' + ty + ', ' + x1 + ' ' + ty
        + ' L ' + x1 + ' ' + (ty + w + e1) + ' C ' + cx + ' ' + (ty + w + e1) + ', ' + cx + ' ' + (sy + w + e0) + ', ' + x0 + ' ' + (sy + w + e0) + ' Z';
      const tip = esc(src.name) + ' &rarr; ' + esc(tgt.name) + '&#10;' + valueText(link.value);
      svg += '<g class="sk-link-group" data-k-tip="' + tip + '"><path class="sk-link" d="' + d + '" fill="' + link.color + '"></path>';
      // 提供透明加宽感应区，确保鼠标悬停可灵敏触发 Tooltip，绝不添加任何可见边框或描边
      const center = 'M ' + x0 + ' ' + (sy + w / 2) + ' C ' + cx + ' ' + (sy + w / 2) + ', ' + cx + ' ' + (ty + w / 2) + ', ' + x1 + ' ' + (ty + w / 2);
      svg += '<path class="sk-link-hit" d="' + center + '" stroke-width="' + Math.max(8, w) + '"></path>';
      svg += '</g>';
    });
    svg += '</g>';
    layout.nodes.forEach((node) => {
      const tip = esc(node.name) + '&#10;' + valueText(node.value);
      // 门：直角、不透明，高度就是真实用量；盖在流带端点之上
      svg += '<rect class="sk-node" x="' + node.x + '" y="' + node.y + '" width="' + node.w + '" height="' + node.h + '" fill="' + node.color + '" data-k-tip="' + tip + '"></rect>';
      if (node.h < node.slotH - 1e-9) {
        // 门比标签槽位矮时，用透明感应区补满整个槽位，保证极小用量的门也能悬停
        svg += '<rect class="sk-node-hit" x="' + (node.x - 3) + '" y="' + node.slotY + '" width="' + (node.w + 6) + '" height="' + node.slotH + '" data-k-tip="' + tip + '"></rect>';
      }
    });

    // 严格同源居中对齐：每个节点的文字严格以该节点自身的垂直中心点 (node.y + node.h / 2) 对齐
    const columns = [...new Set(layout.nodes.map((node) => node.x))].sort((a, b) => a - b);
    layout.nodes.forEach((node) => {
      const x = node.x + node.w + 7;
      const nextColumn = columns.find((col) => col > node.x);
      const maxWidth = (nextColumn == null ? layout.width - 12 : nextColumn - 10) - x;
      const budget = maxWidth - 12;
      const charWidth = (ch) => ch.codePointAt(0) > 255 ? 11 : 6.5;
      const textWidth = (text) => { let sum = 0; for (const ch of text) sum += charWidth(ch); return sum; };
      // 放不下时先去掉末尾的英文括注（「缓存命中读取 (Cache Read)」→「缓存命中读取」），仍放不下再按字省略；完整名保留在悬停气泡里
      const short = node.name.replace(/\\s*[(（][^()（）]*[)）]\\s*$/, '');
      const candidate = textWidth(node.name) <= budget ? node.name : (short && short !== node.name ? short : node.name);
      let used = 0, label = '';
      for (const ch of candidate) {
        const w = charWidth(ch);
        if (used + w > budget) { label += '…'; break; }
        label += ch; used += w;
      }
      const tip = esc(node.name) + '&#10;' + valueText(node.value);
      svg += '<text class="sk-node-txt" x="' + x + '" y="' + (node.y + node.h / 2) + '" dominant-baseline="middle" data-k-tip="' + tip + '">' + esc(label) + '</text>';
    });
    box.innerHTML = svg + '</svg>';
  }

  
  function renderContextBreakdownCard(cb) {
    if (!cb) return;
    const total = cb.totalInputTokens || 0;
    $('ctxTotalTok').textContent = '输入总量: ' + fmt(total) + ' Tokens';

    const setSeg = (id, valId, pctId, tokens, pct, name) => {
      const el = $(id);
      const valEl = $(valId);
      const pctEl = $(pctId);
      if (el) {
        el.style.width = pct.toFixed(1) + '%';
        el.dataset.kTip = name + '&#10;' + fmt(tokens) + ' tokens (' + pct.toFixed(1) + '%)';
      }
      if (valEl) valEl.textContent = tokShort(tokens);
      if (pctEl) pctEl.textContent = '(' + pct.toFixed(1) + '%)';
    };

    setSeg('ctxSegFiles', 'ctxValFiles', 'ctxPctFiles', cb.filesTokens || 0, cb.filesPct || 0, '关联代码文件');
    setSeg('ctxSegHistory', 'ctxValHistory', 'ctxPctHistory', cb.historyTokens || 0, cb.historyPct || 0, '历史会话记录');
    setSeg('ctxSegTools', 'ctxValTools', 'ctxPctTools', cb.toolsTokens || 0, cb.toolsPct || 0, '工具规格定义');
    setSeg('ctxSegRules', 'ctxValRules', 'ctxPctRules', cb.rulesTokens || 0, cb.rulesPct || 0, '系统规则设定');
    setSeg('ctxSegCurrent', 'ctxValCurrent', 'ctxPctCurrent', cb.currentInputTokens || 0, cb.currentPct || 0, '当前用户指令');
  }

  function renderUsage(m) {
    currentUsageMsg = m;
    $('uRefresh').innerHTML = '&#8635;';
    document.querySelectorAll('.useg button').forEach((x) => x.classList.toggle('sel', x.dataset.r === m.range));
    const s = m.summary || {};

    // 1. 使用统计 5 维度大卡片
    const st = m.stats || {};
    $('stPeakTokens').textContent = tokShort(st.peakTokens || 0);
    $('stPeakTokens').title = '单日最高 ' + fmt(st.peakTokens || 0) + ' tokens';
    $('stLongestDur').textContent = durStr(st.longestDurationMs || 0);
    $('stCurStreak').textContent = (st.currentStreakDays || 0) + ' 天';
    $('stMaxStreak').textContent = (st.longestStreakDays || 0) + ' 天';

    // 2. Token 活动热力图
    renderHeatmap(m.heatmap || []);

    // 3. 多模型趋势曲线图
    renderTrendCurve(m.providers || [], m.trend || [], m.seriesTrend || [], m.range || "today");

    // 4. 模型用量环形图
    renderDonut(m.modelRatios || []);

    // 5. 桑基分流数图
    renderSankey(m.sankey || { nodes: [], links: [] });

    // 5.1 Cursor 风格上下文微观构成卡片 (方法 B)
    if (m.contextBreakdown) {
      renderContextBreakdownCard(m.contextBreakdown);
    }

    // 6. Hero 头部指标
    $('hTokens').textContent = tokShort(s.totalTokens); $('hTokens').title = fmt(s.totalTokens) + ' tokens';
    $('hTokensSub').textContent = s.cacheHitRate == null ? '' : ('缓存命中 ' + ratePct(s.cacheHitRate));
    $('hReq').textContent = fmt(s.requests);
    $('hReqSub').textContent = s.requests ? ('成功 ' + ratePct(s.successRate) + (s.avgLatencyMs != null ? ' · 平均 ' + ms(s.avgLatencyMs) : '')) : '';
    $('hIn').textContent = tokShort(s.inputTokens + (s.cacheReadTokens||0) + (s.cacheWriteTokens||0)); $('hIn').title = fmt(s.inputTokens) + ' 未命中 + ' + fmt(s.cacheReadTokens) + ' 缓存读 + ' + fmt(s.cacheWriteTokens) + ' 缓存写';
    $('hInSub').textContent = s.cacheReadTokens ? ('其中缓存读 ' + tokShort(s.cacheReadTokens)) : '';
    $('hOut').textContent = tokShort(s.outputTokens); $('hOut').title = fmt(s.outputTokens) + ' tokens（含思考）';
    $('hOutSub').textContent = s.avgFirstTokenMs != null ? ('首 token ' + ms(s.avgFirstTokenMs)) : '';

    // 趋势
    const tw = $('trend'); tw.innerHTML = '';
    const trend = m.trend || [];
    show($('trendCard'), m.range !== 'today');
    if (trend.length) {
      const max = Math.max(1, ...trend.map((d) => d.tokens));
      const today = new Date(); today.setHours(0,0,0,0);
      for (const d of trend) {
        const bar = document.createElement('div'); bar.className = 'bar2' + (d.day === today.getTime() ? ' today' : '');
        bar.style.height = Math.max(2, Math.round(d.tokens / max * 40)) + 'px';
        const dd = new Date(d.day); bar.title = (dd.getMonth()+1) + '/' + dd.getDate() + ' · ' + fmt(d.tokens) + ' tokens · ' + fmt(d.requests) + ' 次';
        tw.appendChild(bar);
      }
      $('trendSub').textContent = trend.length + ' 天';
    } else {
      tw.innerHTML = '<div class="empty2">暂无数据</div>'; $('trendSub').textContent = '';
    }

    // 按渠道（级联到模型）
    const pw = $('uProviders'); pw.innerHTML = '';
    const provs = m.providers || [];
    $('provSub').textContent = provs.length ? (provs.length + ' 个渠道') : '';
    if (!provs.length) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '该时段还没有请求。用 Kiro 聊几句，这里会实时出现。'; pw.appendChild(e);
    }
    for (const p of provs) {
      const open = !!provOpen[p.providerId];
      const row = document.createElement('div'); row.className = 'urow prov' + (open ? ' open' : '');
      row.innerHTML = '<span class="c-name"><span class="chev2">▶</span><span class="nm"></span></span>'
        + '<span class="c-num"></span><span class="c-num"></span><span class="c-num rate"></span><span class="c-num"></span>';
      row.querySelector('.nm').textContent = p.providerName; row.querySelector('.nm').title = p.providerName + ' · ' + p.protocol;
      const cells = row.querySelectorAll('.c-num');
      cells[0].textContent = fmt(p.requests);
      cells[1].textContent = tokShort(p.totalTokens); cells[1].title = fmt(p.totalTokens) + ' = in ' + fmt(p.inputTokens) + ' + out ' + fmt(p.outputTokens) + ' + cache ' + fmt(p.cacheReadTokens + p.cacheWriteTokens);
      cells[2].textContent = ratePct(p.successRate); cells[2].classList.add(rateCls(p.successRate));
      cells[3].textContent = ms(p.avgLatencyMs);
      const fold = document.createElement('div'); fold.className = 'models-fold' + (open ? '' : ' collapsed');
      for (const mm of p.models) {
        const mr = document.createElement('div'); mr.className = 'urow model';
        mr.innerHTML = '<span class="c-name"><span class="mono"></span></span><span class="c-num"></span><span class="c-num"></span><span class="c-num rate"></span><span class="c-num"></span>';
        mr.querySelector('.mono').textContent = mm.model; mr.querySelector('.mono').title = mm.model;
        const mc = mr.querySelectorAll('.c-num');
        mc[0].textContent = fmt(mm.requests);
        mc[1].textContent = tokShort(mm.totalTokens); mc[1].title = 'in ' + fmt(mm.inputTokens) + ' · out ' + fmt(mm.outputTokens) + ' · cache读 ' + fmt(mm.cacheReadTokens) + ' · cache写 ' + fmt(mm.cacheWriteTokens);
        mc[2].textContent = ratePct(mm.successRate); mc[2].classList.add(rateCls(mm.successRate));
        mc[3].textContent = ms(mm.avgLatencyMs);
        fold.appendChild(mr);
      }
      row.addEventListener('click', () => { provOpen[p.providerId] = !provOpen[p.providerId]; row.classList.toggle('open', provOpen[p.providerId]); fold.classList.toggle('collapsed', !provOpen[p.providerId]); });
      pw.appendChild(row); pw.appendChild(fold);
    }

    // 最近请求
    const rw = $('uRecent'); rw.innerHTML = '';
    const recent = m.recent || [];
    if (!recent.length) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '暂无记录'; rw.appendChild(e);
    }
    for (const r of recent) {
      const row = document.createElement('div'); row.className = 'rrow';
      row.innerHTML = '<span class="rdot"></span><div class="rmain"><div class="rmodel"></div><div class="rsub"></div></div><div class="rnum"><div class="t"></div><div class="l"></div></div>';
      if (!r.ok) row.querySelector('.rdot').classList.add('bad');
      row.querySelector('.rmodel').textContent = r.model + (r.upstreamModel ? ' → ' + r.upstreamModel : '');
      row.querySelector('.rsub').textContent = timeHM(r.ts) + ' · ' + r.providerName + (r.ok ? '' : (' · ' + (r.error || ('HTTP ' + r.status))));
      if (!r.ok) row.querySelector('.rsub').classList.add('rerr');
      row.querySelector('.t').textContent = tokShort(r.tokens);
      row.querySelector('.t').title = 'in ' + fmt(r.inputTokens) + ' · out ' + fmt(r.outputTokens) + (r.cacheReadTokens ? ' · cache读 ' + fmt(r.cacheReadTokens) : '');
      row.querySelector('.l').textContent = ms(r.latencyMs) + (r.firstTokenMs != null ? ' · 首' + ms(r.firstTokenMs) : '');
      rw.appendChild(row);
    }
  }

  // ---------- 提示词页：列表（开关 | 名称/描述 | 编辑 | 删除）+ 添加/编辑弹窗 ----------
  // 对齐 cc-switch PromptLibrary/PromptListItem/PromptFormPanel；单选启用、启用中的不能删。
  let prompts = [];
  let promptQ = '';
  const promptSearchEl = $('promptSearch'), promptQEl = $('promptQ'), promptClrEl = $('promptClr');
  const fmtChars = (n) => n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : (n + ' 字');
  function renderPrompts() {
    const wrap = $('prompts'); wrap.innerHTML = '';
    const active = prompts.find((p) => p.enabled);
    const tabPromptEl = $('tabPromptCnt'); if (tabPromptEl) tabPromptEl.textContent = active ? '1' : '';
    fitTabs();
    const sum = $('promptSummary');
    sum.innerHTML = '共 <b>' + prompts.length + '</b> 个提示词 · ' + (active ? '已启用: <b>' + esc(active.name) + '</b>' : '未启用任何提示词');
    // 条目多了才显示搜索框（cc-switch 常驻；侧栏空间紧，≥4 条再给）
    show(promptSearchEl, prompts.length >= 4);
    show(promptClrEl, promptQ.length > 0);
    if (!prompts.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = '还没有提示词。点上方「添加提示词」，写好后打开开关即注入。';
      wrap.appendChild(e); return;
    }
    const kw = promptQ.trim().toLowerCase();
    const list = kw ? prompts.filter((p) => [p.name, p.description, p.content].some((v) => (v || '').toLowerCase().includes(kw))) : prompts;
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'empty small'; e.textContent = '没有匹配「' + promptQ.trim() + '」的提示词。'; wrap.appendChild(e); return;
    }
    for (const p of list) {
      const row = document.createElement('div'); row.className = 'prow' + (p.enabled ? ' on' : '');
      const sw = document.createElement('label'); sw.className = 'switch'; sw.title = p.enabled ? '停用' : '启用（会停用其它提示词）';
      sw.innerHTML = '<input type="checkbox"><span class="slider"></span>';
      const chk = sw.querySelector('input'); chk.checked = !!p.enabled;
      chk.addEventListener('change', (e) => {
        // 乐观更新：单选，本地先切，扩展回来的 prompts 消息以真实状态覆盖。
        const on = e.target.checked;
        for (const x of prompts) x.enabled = on && x.id === p.id;
        renderPrompts();
        vscode.postMessage({ type: 'setPromptEnabled', id: p.id, enabled: on });
      });
      row.appendChild(sw);
      const t = document.createElement('div'); t.className = 'ltext';
      // 名字单独包一层可截断的 .nm，「已启用」小标不参与截断，长名字下也不会被省略号吃掉
      const n = document.createElement('div'); n.className = 'ln';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name; nm.title = p.name; n.appendChild(nm);
      if (p.enabled) { const tag = document.createElement('span'); tag.className = 'ontag'; tag.textContent = '已启用'; n.appendChild(tag); }
      const s = document.createElement('div'); s.className = 'ls';
      s.textContent = p.description || (fmtChars(p.chars) + (p.content ? '' : ' · 内容为空'));
      t.appendChild(n); t.appendChild(s); row.appendChild(t);
      const act = document.createElement('div'); act.className = 'lact';
      const ed = document.createElement('button'); ed.className = 'iconbtn'; ed.title = '编辑'; ed.setAttribute('aria-label', '编辑'); ed.innerHTML = ICON_PENCIL;
      ed.addEventListener('click', () => openPromptModal(p));
      const del = document.createElement('button'); del.className = 'iconbtn del'; del.innerHTML = ICON_TRASH;
      if (p.enabled) { del.disabled = true; del.title = '请先停用再删除'; del.setAttribute('aria-label', '请先停用再删除'); }
      else { del.title = '删除'; del.setAttribute('aria-label', '删除'); del.addEventListener('click', () => confirmModal({
        icon: p.name, iconId: 'glyph:layers-iso', title: '删除提示词「' + p.name + '」？', desc: '内容不可恢复。', okText: '删除', danger: true,
        onOk: () => vscode.postMessage({ type: 'deletePrompt', id: p.id, confirmed: true }),
      })); }
      act.appendChild(ed); act.appendChild(del); row.appendChild(act);
      wrap.appendChild(row);
    }
  }
  promptQEl.addEventListener('input', () => { promptQ = promptQEl.value || ''; renderPrompts(); });
  promptClrEl.addEventListener('click', () => { promptQEl.value = ''; promptQ = ''; renderPrompts(); promptQEl.focus(); });
  promptQEl.addEventListener('keydown', (e) => { if (e.key === 'Escape' && promptQEl.value) { promptQEl.value = ''; promptQ = ''; renderPrompts(); } });

  // 添加/编辑弹窗：名称 / 描述 / 内容（Markdown，等宽）+ 字数；Ctrl/Cmd+Enter 保存。
  function openPromptModal(p) {
    const editing = !!p;
    const modal = buildModal('', editing ? '编辑提示词' : '添加提示词', '');
    modal.classList.add('prompt');
    const box = document.createElement('div');
    box.innerHTML =
      '<label>名称</label><input class="pName" type="text" spellcheck="false" placeholder="例如：项目默认提示词" maxlength="80">'
      + '<label>描述</label><input class="pDesc" type="text" spellcheck="false" placeholder="可选的描述信息" maxlength="200">'
      + '<label>内容</label><textarea class="pContent" spellcheck="false" placeholder="在此输入提示词内容…（支持 Markdown，原样发给模型）"></textarea>'
      + '<div class="pmeta"><span class="pChars">0 字</span><span>Ctrl/⌘ + Enter 保存</span></div>'
      + '<div class="mfootbtns"><button class="btn btn-primary pSave">保存</button><button class="btn btn-ghost btn-sm pCancel">取消</button></div>';
    modal.appendChild(box);
    const name = box.querySelector('.pName'), desc = box.querySelector('.pDesc'), content = box.querySelector('.pContent'), chars = box.querySelector('.pChars'), save = box.querySelector('.pSave');
    if (editing) { name.value = p.name; desc.value = p.description || ''; content.value = p.content || ''; }
    const paint = () => { chars.textContent = fmtChars(content.value.length); save.disabled = !name.value.trim(); };
    paint();
    name.addEventListener('input', paint); content.addEventListener('input', paint);
    const doSave = () => {
      if (!name.value.trim()) { name.focus(); return; }
      vscode.postMessage({ type: 'savePrompt', id: editing ? p.id : '', name: name.value, description: desc.value, content: content.value });
      closeModal();
    };
    save.addEventListener('click', doSave);
    box.querySelector('.pCancel').addEventListener('click', closeModal);
    box.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSave(); } });
    setTimeout(() => (editing ? content : name).focus(), 30);
  }
  $('showAddPrompt').addEventListener('click', () => openPromptModal(null));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'state') {
      $('enable').checked = !!m.enabled;
      proxyEnabled = !!m.enabled;
      const elbl = $('enableLbl');
      if (elbl) {
        elbl.textContent = m.enabled ? '已开启' : '开启代理';
        elbl.classList.toggle('on', !!m.enabled);
      }
      const active = (m.providers || []).filter((p) => p.enabled && p.usable).length;

      lastProviders = m.providers || [];
      selectedModel = m.selectedModel || '';
      // 预设全量留给选择弹窗；弹窗打开时再按已连接剔除。
      lastPresets = m.presets || [];
      lastVendors = m.oauthVendors || [];
      renderProviders(lastProviders);
      renderModels();
      if (oauthModal) oauthModal.onState();
      // 编辑弹窗开着：key 池列表跟着新状态重画（冷却 / 计数 / 新加的 key 立刻出现）
      if (editModal && editModal.pool) {
        const fresh = lastProviders.find((x) => x.id === editModal.p.id);
        if (fresh) { editModal.p = fresh; editModal.pool.render(fresh); }
      }
      const tabProvEl = $('tabProvCnt'); if (tabProvEl) tabProvEl.textContent = active ? String(active) : '';
      fitTabs();

      $('ports').textContent = 'KRS ' + m.krsPort + ' / CPS ' + m.cpsPort;
    } else if (m.type === 'models') {
      modelCounts = m.counts || {};
      modelsByProvider = m.modelsByProvider || {};
      renderProviders(lastProviders); // 用新计数就地重渲染已连接列表
      renderModels();
      renderAddModelModal(); // 弹窗开着就同步刷新候选池
      renderEditModalModels(); // 编辑弹窗开着就同步刷新能力标签（真实判定覆盖乐观值）
    } else if (m.type === 'usage') {
      renderUsage(m);
    } else if (m.type === 'prompts') {
      prompts = m.prompts || [];
      renderPrompts();
    } else if (m.type === 'probeResult' || m.type === 'modelTest' || m.type === 'modelTestDone') {
      if (m.type === 'probeResult' && m.kind === 'latency' && onRowLatency(m)) { /* 行内测延迟已处理 */ }
      else if (activeProbe) activeProbe.onMessage(m);
    } else if (m.type === 'gotoTab') {
      selectTab(m.tab || 'models');
    } else if (m.type === 'oauthSession' || m.type === 'oauthStatus') {
      if (oauthModal) oauthModal.onStatus(m);
    } else if (m.type === 'ccswitchResult') {
      onCcSwitchResult(m);
    } else if (m.type === 'ccswitchDone') {
      closeModal(); selectTab('providers');
    } else if (m.type === 'pickedJsonContent') {
      const ta = document.querySelector('.omodeFields textarea[data-key="jsonText"]')
              || document.querySelector('.omodeFields textarea[data-key="json"]')
              || document.querySelector('.omodeFields textarea')
              || document.querySelector('textarea.mFieldInput');
      if (ta) {
        ta.value = m.content || '';
        ta.style.borderColor = '';
        toast('ok', '已读取 ' + (m.filename || 'JSON 凭证文件'));
      }
    } else if (m.type === 'toast') {
      toast(m.level, m.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
