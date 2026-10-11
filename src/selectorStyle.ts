/**
 * 模型选择器深度卡片化分组与能力徽章（方案 B：精准特征隔离定制）。
 *
 * 核心设计准则：
 * 1. 100% 作用域隔离：所有 CSS 规则严格限定在 .a2k-exclusive-model-option 上，对 Workflow / Agent 等其他弹窗零误伤；
 * 2. 严格生命周期管理：当用户在控制面板关闭代理或停用插件时，自动触发逆向清理，将 IDE 彻底复原；开启时再按需装载。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { error, info, warn } from "./log";

const START = "/* api4kiro:group-header:start */";
const END = "/* api4kiro:group-header:end */";

export type TargetStatus = "applied" | "removed" | "unchanged" | "unavailable";

/** 4.13.55 可选组：聊天框「上下文」下拉（mermaid）与 setSessionConfigOption 宿主转发钩子（dist/extension.js）。 */
export type CtxTargetKey = "ctxSelector" | "ctxHost";
export type CtxExtras = Record<CtxTargetKey, TargetStatus>;
/** 可选组靶点的全集：上下文挡位两处 + kiro-agent usage-limits 启动重试钩子（dist/extension.js）。 */
export type ExtraKey = CtxTargetKey | "usageRetry";
export type SyncExtras = Record<ExtraKey, TargetStatus>;

export type StyleSyncResult = {
  status: TargetStatus;
  detail?: string;
  /**
   * 前置闸动过的痕迹（4.13.65 引入，4.13.66 起改成**逐文件**粒度）。只要本轮有文件因为
   * kiro-proxy 残留（`kiroproxy-…`）被跳过就是 `"kiro-proxy"`——可能是部分跳过（其余文件照常打补丁），
   * 也可能是全部跳过（那时 `status` / `targets` 全是 unavailable，一个字节都没写）。
   * 既有构造点不传即 `undefined`，向后兼容。
   */
  blockedBy?: "kiro-proxy";
  /** 被前置闸跳过的目标文件（`extensions/` 之后的短路径，逐文件）——提示里点名用。 */
  skippedBy?: string[];
  /**
   * 被跳过的文件旁边检测到的 kiro-proxy 出厂备份（`<文件名>.kiroproxy-bak-<版本>`）的绝对路径。
   * 有值时提示文案里给出「可用它恢复该文件」的可操作指引（谁的备份归谁，不存在自动覆盖）。
   */
  kiroProxyBackups?: string[];
  /** 三个靶点文件各自的结果：style.css / mermaid-*.js / kiro-agent dist/extension.js */
  targets: { style: TargetStatus; selectorScript: TargetStatus; backend: TargetStatus };
  /**
   * 可选组的结果（4.13.55）：靶点不命中只报 `unavailable`，不影响 `status` / `targets`——既有三处 + 弹层照常打；
   * 该文件本轮写失败时随所属靶点一起报 `unavailable`。
   * `usageRetry`（kiro-agent usage-limits 启动重试）同属可选组，且从不改变 `targets.backend`。
   */
  extras: SyncExtras;
};

function styleFile(): string {
  return path.join(
    vscode.env.appRoot,
    "extensions",
    "kiro.kiro-agent",
    "packages",
    "kiro-ui-agent-chat",
    "dist",
    "style.css"
  );
}

function jsDir(): string {
  return path.join(path.dirname(styleFile()), "assets");
}

/** kiro.kiro-agent 的 packages 目录。 */
function packagesDir(): string {
  return path.join(vscode.env.appRoot, "extensions", "kiro.kiro-agent", "packages");
}

/** 模型选择器的类名字面量：压缩器一个字符都不动字面量，用它认「这个 chunk 里有没有模型选择器」。 */
const SELECTOR_CHUNK_MARK = "chat-input-popup-option";

/** 同一标记的字节形态：判定按字节找，省掉多兆 chunk 的 UTF-16 解码。 */
const SELECTOR_MARK_BUF = Buffer.from(SELECTOR_CHUNK_MARK, "utf8");

/** 一个承载模型选择器的 chunk 及其所属 package 自己的样式表。 */
type SelectorPackage = { pkg: string; chunk: string; style: string };

/**
 * 承载模型选择器的**全部** package。
 *
 * Kiro 1.1.14 起聊天界面被拆到 `kiro-ui-session-details`：同一个 chunk（同名 base
 * `mermaid-GHXKKRXX`、不同 hash）在各 package 下各有一份，而且**各自独立压缩**
 * （实测 agent-chat 1 870 816 B / session-details 2 218 700 B，压缩名不同）。
 * 只处理 `kiro-ui-agent-chat` 会漏掉用户真正看到的那个视图：卡片补丁与 CSS 都打在 agent-chat，
 * 界面却由 session-details 的工厂 chunk 渲染，于是每行模型名下面直接显示 CPS 的
 * `__A2K_MDL__|…` 微格式（2026-09-15 实机截图：整张列表看起来就是一片乱码）。
 *
 * 判据用**内容**而不是文件名：两份 chunk 同名不同 hash，只有内容能区分；而
 * `chat-input-popup-option` 是类名字面量，压缩前后逐字不变。
 *
 * 两个遍历：先只认 `mermaid-*`（Kiro 一直把承载它的 chunk 归在这个 base 名下）；
 * 这一轮在该 package 里一份都没找到时，才回退扫**全部** `assets/*.js`。回退是必要的——
 * 文件名是 Kiro 内部的偶然命名，1.1.14 已经把聊天界面拆过一次 package；哪天 chunk 换了
 * 名字（不再叫 `mermaid-*`），只按名字找就会静默漏掉整个视图，微格式又会糊在模型列表里。
 * 回退要读几百个 chunk，只在「名字确实变了」时才会触发，因此没有常驻成本。
 *
 * 目录不可读（非 Kiro 宿主）时返回空数组，由调用方按「靶点不命中」处理。
 */
async function selectorPackages(): Promise<SelectorPackage[]> {
  const out: SelectorPackage[] = [];
  let pkgs: string[];
  try {
    pkgs = await fs.promises.readdir(packagesDir());
  } catch {
    return out;
  }
  /**
   * 读一份 chunk，含模型选择器标记才认。读不了（权限 / 目录）按不命中处理。
   *
   * 按**字节**找标记再判定：回退分支可能要读几百个 chunk（实测真机 1.1.14 的非 mermaid chunk
   * 共 732 个 / 28.7 MB），解成 UTF-16 字符串纯属浪费——Buffer 查找实测 0.11 s。
   * 非普通文件（目录、符号链指向的目录）一律不算候选：写盘路径只接受普通文件。
   */
  const carriesSelector = async (file: string): Promise<boolean> => {
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) {
        return false;
      }
      return (await fs.promises.readFile(file)).includes(SELECTOR_MARK_BUF);
    } catch {
      return false;
    }
  };
  for (const pkg of pkgs) {
    const dist = path.join(packagesDir(), pkg, "dist");
    const assets = path.join(dist, "assets");
    let names: string[];
    try {
      names = await fs.promises.readdir(assets);
    } catch {
      continue;
    }
    const js = names.filter((f) => f.endsWith(".js")).sort();
    const named = js.filter((f) => f.startsWith("mermaid-"));
    const hits: string[] = [];
    for (const f of named) {
      if (await carriesSelector(path.join(assets, f))) {
        hits.push(f);
      }
    }
    // 该 package「一张 mermaid-* 都不带标记」才回退全量扫；带了就维持既有行为，不多读文件。
    // 注意触发面比「Kiro 改名了」更宽：任何有 assets/ 但压根没有 mermaid-* 承载文件的 package
    // 也会走这里（1.1.14 上只有 kiro-ui-powers，2 个文件；真正的成本出现在改名那种情况）。
    if (hits.length === 0) {
      for (const f of js) {
        if (!f.startsWith("mermaid-") && (await carriesSelector(path.join(assets, f)))) {
          hits.push(f);
        }
      }
    }
    for (const f of hits) {
      out.push({ pkg, chunk: path.join(assets, f), style: path.join(dist, "style.css") });
    }
  }
  return out;
}

const CARD_CSS = `${START}
/* API4Kiro：模型选择器精致卡片化分组与自由拉伸缩放（整体缩小一小圈，支持手动调整宽高）
   只作用于 mermaid 补丁打上 a2k-model-selector-menu 的那一个菜单；Agent / 上下文拾取器等
   同样带 role="listbox" 的弹窗不得命中。
   width / height 不加 !important：Chromium 原生 resize 手柄是把新宽高写进元素内联样式，
   !important 会压过内联样式，手柄看得见却拖不动。Kiro 自己的 .chat-input-popup-menu 只有单类，
   这里两类选择器已足够覆盖它的 width:max-content。 */
.chat-input-popup-menu.a2k-model-selector-menu {
  width: 270px;
  min-width: 220px !important;
  max-width: 500px !important;
  height: auto;
  min-height: 180px !important;
  max-height: 330px !important;
  padding: 4px 0 !important;
  resize: both !important;
  overflow: auto !important;
  box-sizing: border-box !important;
}
/* 用户拖过手柄之后（Chromium 会在内联样式里写入 " height:"；Kiro Floating UI 的 size 中间件只写
   max-height / max-width，不会误命中）放开默认上限：高度可拉到接近视口，宽度可拉到 640px。 */
.chat-input-popup-menu.a2k-model-selector-menu[style*=" height:"],
.chat-input-popup-menu.a2k-model-selector-menu[style^="height:"] {
  max-height: min(calc(100vh - 120px), 900px) !important;
  max-width: min(90vw, 640px) !important;
}

/* 渠道卡片头：精简间距 */
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp {
  margin: 6px 5px 0 5px !important;
  padding: 4px 8px !important;
  border-radius: 8px 8px 0 0 !important;
  background: rgba(255, 255, 255, 0.035) !important;
  border: 1px solid rgba(255, 255, 255, 0.11) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
  cursor: default !important;
  pointer-events: auto !important;
  user-select: none !important;
}
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp:first-child {
  margin-top: 2px !important;
}
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp:hover {
  background: rgba(255, 255, 255, 0.05) !important;
}

.a2k-card-head {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  width: 100% !important;
}
.a2k-chev {
  font-size: 8px !important;
  color: rgba(255, 255, 255, 0.5) !important;
  transform: scale(0.8) !important;
  flex: none !important;
}
.a2k-logo {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 17px !important;
  height: 17px !important;
  border-radius: 50% !important;
  background: rgba(166, 108, 255, 0.18) !important;
  border: 1.2px solid rgba(166, 108, 255, 0.65) !important;
  color: #ffffff !important;
  font-size: 9.5px !important;
  font-weight: 700 !important;
  box-shadow: 0 0 6px rgba(166, 108, 255, 0.4) !important;
  flex: none !important;
  overflow: hidden !important;
  box-sizing: border-box !important;
}
.a2k-logo svg, .a2k-logo img {
  display: block !important;
  width: 11px !important;
  height: 11px !important;
}
.a2k-title {
  font-size: 11.5px !important;
  font-weight: 600 !important;
  color: rgb(214, 196, 255) !important;
  text-shadow: 0 0 5px rgba(166, 108, 255, 0.35) !important;
  letter-spacing: 0.1px !important;
}
.a2k-count {
  font-size: 10px !important;
  color: rgba(255, 255, 255, 0.4) !important;
  margin-left: 2px !important;
  font-weight: 500 !important;
}

/* 卡片内部模型行：微缩紧凑，上下居中 */
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-mdl {
  margin: 0 5px !important;
  padding: 3px 8px !important;
  min-height: 25px !important;
  box-sizing: border-box !important;
  background: rgba(255, 255, 255, 0.015) !important;
  border-left: 1px solid rgba(255, 255, 255, 0.11) !important;
  border-right: 1px solid rgba(255, 255, 255, 0.11) !important;
  border-top: none !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
  border-radius: 0 !important;
  transition: all 0.12s ease !important;
}
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-mdl:hover {
  background: rgba(255, 255, 255, 0.04) !important;
}

/* 卡片最后一行 */
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-last {
  border-radius: 0 0 8px 8px !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.11) !important;
  margin-bottom: 6px !important;
}

/* 模型行内部排版 */
.a2k-model-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  width: 100% !important;
  gap: 5px !important;
}
.a2k-model-name-box {
  display: inline-flex !important;
  align-items: center !important;
  min-width: 0 !important;
  flex: 1 1 auto !important;
}
.a2k-model-row .chat-input-popup-option-name {
  font-size: 11.5px !important;
  font-weight: 500 !important;
  color: rgba(255, 255, 255, 0.92) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  max-width: 180px !important;
}

/* 选中的模型格子：严格对齐截图3标准 —— 浅紫色半透明底 + 柔和光晕呼吸 + 晶莹内描边，名字亮起加粗 */
.chat-input-popup-option.a2k-exclusive-model-option[data-selected="true"].a2k-opt-mdl {
  margin: 2px 5px !important;
  padding: 3px 8px !important;
  border-radius: 6px !important;
  border: 1px solid rgba(166, 108, 255, 0.45) !important;
  background: rgba(166, 108, 255, 0.18) !important;
  box-shadow: inset 0 0 0 1px rgba(210, 190, 255, 0.45), 0 0 8px rgba(166, 108, 255, 0.32) !important;
}
.chat-input-popup-option.a2k-exclusive-model-option[data-selected="true"] .chat-input-popup-option-name {
  color: #ffffff !important;
  font-weight: 600 !important;
  text-shadow: 0 0 8px rgba(166, 108, 255, 0.6) !important;
}

/* 能力胶囊标签：微缩纯简笔画SVG */
.a2k-caps-box {
  display: inline-flex !important;
  align-items: center !important;
  gap: 3px !important;
  flex: none !important;
}
.a2k-cap {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 18px !important;
  height: 16px !important;
  border-radius: 3.5px !important;
  user-select: none !important;
  flex: none !important;
  box-sizing: border-box !important;
}
.a2k-cap-reason {
  background: rgba(255, 166, 87, 0.08) !important;
  border: 1px solid rgba(255, 166, 87, 0.3) !important;
  color: #ffb26b !important;
}
.a2k-cap-vision {
  background: rgba(57, 197, 207, 0.08) !important;
  border: 1px solid rgba(57, 197, 207, 0.3) !important;
  color: #5fd4dc !important;
}
.a2k-cap svg {
  display: block !important;
  width: 11px !important;
  height: 11px !important;
}

/* ==========================================================================
   Context Usage 弹层：Cursor 布局（标题行 / 「N% Full」+ Token 计数行 / 细分段条 / 方块色标 + 右对齐 Token 数）
   底色 = 聊天区背景（Kiro 的 body 用 --vscode-editor-background，Kiro Dark 下为 #211d25），实色不透明，
   与聊天区融为一体；只留一圈紫色描边 + 外圈极淡紫晕做分界。只命中 mermaid 补丁加了 a2k-cu 类的那一个弹层。
   ========================================================================== */
.kiro-context-popover.a2k-cu {
  width: 300px !important;
  border-radius: 12px !important;
  background: var(--vscode-editor-background, #211d25) !important;
  border: 1px solid rgba(166, 108, 255, 0.62) !important;
  /* 顶部 1px 内高光让描边有厚度感；外圈 1px 紫晕 + 深色投影，不做毛玻璃 */
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(166, 108, 255, 0.14),
    0 0 22px rgba(166, 108, 255, 0.16),
    0 16px 40px rgba(0, 0, 0, 0.55) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  padding: 13px 16px 13px !important;
  box-sizing: border-box !important;
  font-family: var(--vscode-font-family) !important;
  color: rgba(255, 255, 255, 0.92) !important;
  overflow: hidden !important;
}
.a2k-cu-head {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  margin-bottom: 9px !important;
}
.a2k-cu-title {
  font-size: 13px !important;
  font-weight: 600 !important;
  color: rgba(255, 255, 255, 0.95) !important;
  letter-spacing: 0.1px !important;
}
.a2k-cu-sub {
  display: flex !important;
  align-items: baseline !important;
  justify-content: space-between !important;
  font-size: 11px !important;
  color: rgba(255, 255, 255, 0.62) !important;
  margin-bottom: 7px !important;
}
.a2k-cu-pct {
  font-variant-numeric: tabular-nums !important;
  color: rgba(214, 196, 255, 0.92) !important;
  font-weight: 600 !important;
}
.a2k-cu-tokens {
  font-variant-numeric: tabular-nums !important;
  color: rgba(255, 255, 255, 0.66) !important;
}
/* Cursor 式细分段条：轨道用低对比浅灰紫、段间 1px 缝，整体圆角 */
.a2k-cu-bar {
  display: flex !important;
  height: 4px !important;
  width: 100% !important;
  border-radius: 999px !important;
  background: rgba(166, 108, 255, 0.12) !important;
  overflow: hidden !important;
  gap: 1px !important;
  margin: 0 0 12px !important;
}
.a2k-cu-seg {
  height: 100% !important;
  flex: none !important;
  transition: width 0.25s ease !important;
}
.a2k-cu-rows {
  display: flex !important;
  flex-direction: column !important;
  gap: 0 !important;
}
.a2k-cu-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  font-size: 11.5px !important;
  line-height: 16px !important;
  padding: 3px 0 !important;
  color: rgba(255, 255, 255, 0.86) !important;
  border-radius: 6px !important;
  transition: background 0.12s ease !important;
}
.a2k-cu-row:hover {
  background: rgba(166, 108, 255, 0.08) !important;
  margin: 0 -6px !important;
  padding: 3px 6px !important;
}
.a2k-cu-row[data-high] .a2k-cu-val {
  color: #fde68a !important;
}
.a2k-cu-left {
  display: inline-flex !important;
  align-items: center !important;
  gap: 8px !important;
  min-width: 0 !important;
}
/* Cursor 用的是圆角小方块色标；实色底上加一圈极淡描边让色块有边缘 */
.a2k-cu-sw {
  width: 10px !important;
  height: 10px !important;
  border-radius: 3px !important;
  flex: none !important;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.10) !important;
}
.a2k-cu-val {
  font-variant-numeric: tabular-nums !important;
  color: rgba(255, 255, 255, 0.92) !important;
}
/* 六个真实类别（Kiro store 的 breakdown 桶）+ 无 breakdown 时的兜底「Conversation」 */
.a2k-cu-c-prompts   { background: #60a5fa !important; }
.a2k-cu-c-responses { background: #c084fc !important; }
.a2k-cu-c-files     { background: #fbbf24 !important; }
.a2k-cu-c-builtin   { background: #34d399 !important; }
.a2k-cu-c-mcp       { background: #f472b6 !important; }
.a2k-cu-c-steering  { background: #fb7185 !important; }
.a2k-cu-c-conv      { background: #c084fc !important; }
.kiro-context-popover.a2k-cu .kiro-context-popover-hint {
  margin-top: 9px !important;
  padding-top: 7px !important;
  border-top: 1px dashed rgba(166, 108, 255, 0.28) !important;
  font-size: 10.5px !important;
  color: rgba(255, 255, 255, 0.58) !important;
}
/* Kiro 原生警告块：在实色底上收成同一套紫边风格 */
.kiro-context-popover.a2k-cu .kiro-context-popover-warning {
  margin: 0 0 10px !important;
  border-radius: 8px !important;
}

/* ==========================================================================
   聊天框「上下文」下拉（4.13.55，R24）：EffortSelector 右侧的原生 <select>，外观复刻 Kiro 的 .effort-selector-trigger
   （同边框 / 圆角 / 底色 / 字号 / hover），只命中 mermaid 补丁渲染出的 a2k-ctx-* 节点。select 去掉系统外观，
   箭头由 wrap::after 画出；下拉展开的选项面板走 --vscode-dropdown-* 色。
   ========================================================================== */
.a2k-ctx-wrap {
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: var(--spacing-xxs) !important;
  border: 1px solid var(--vscode-contrastBorder) !important;
  border-radius: var(--radius-md) !important;
  padding: 0 0 0 var(--spacing-xs) !important;
  background-color: var(--vscode-button-tertiaryBackground) !important;
  color: inherit !important;
  font-size: var(--text-sm) !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
  transition: background-color var(--kiro-transition) !important;
}
.a2k-ctx-wrap:hover {
  background-color: var(--vscode-button-tertiaryHoverBackground, var(--vscode-button-background)) !important;
}
.a2k-ctx-label {
  opacity: 0.7 !important;
  white-space: nowrap !important;
  pointer-events: none !important;
}
.a2k-ctx-select {
  appearance: none !important;
  -webkit-appearance: none !important;
  border: none !important;
  outline: none !important;
  background: transparent !important;
  color: inherit !important;
  font: inherit !important;
  font-size: var(--text-sm) !important;
  line-height: inherit !important;
  padding: var(--spacing-xs) 16px var(--spacing-xs) 2px !important;
  cursor: pointer !important;
  min-width: 0 !important;
  max-width: 120px !important;
  text-overflow: ellipsis !important;
}
.a2k-ctx-select:disabled {
  opacity: 0.5 !important;
  cursor: not-allowed !important;
}
.a2k-ctx-select option,
.a2k-ctx-select optgroup {
  background: var(--vscode-dropdown-background) !important;
  color: var(--vscode-dropdown-foreground) !important;
}
.a2k-ctx-select optgroup {
  font-style: normal !important;
  font-weight: 600 !important;
  opacity: 0.75 !important;
}
.a2k-ctx-wrap::after {
  content: "" !important;
  position: absolute !important;
  right: 6px !important;
  top: 50% !important;
  width: 5px !important;
  height: 5px !important;
  border-right: 1.5px solid currentColor !important;
  border-bottom: 1.5px solid currentColor !important;
  transform: translateY(-65%) rotate(45deg) !important;
  pointer-events: none !important;
  opacity: 0.75 !important;
}

/* ==========================================================================
   1.2 代模型面板（4.13.64，Kiro 1.2.56 起的 ModelPanel / ModelOptionRow）：只命中 a2kRowFix 打了
   data-a2k-grp 的分组标题行与 .a2k-caps-box 徽章节点，与 1.1 代选项行的规则无交集。
   卡片头内部（.a2k-card-head / .a2k-logo / .a2k-title / .a2k-count / .a2k-chev）与徽章（.a2k-cap*）沿用上面的规则。
   面板自己管宽度与选中滚动，不打 1.1 代的菜单宽度 / resize / 居中补丁。
   ========================================================================== */
.kiro-model-panel-option[data-a2k-grp="1"]{cursor:default !important;margin:6px 4px 0 !important;padding:4px 8px !important;border-radius:8px 8px 0 0 !important;background:rgba(255,255,255,.035) !important;border:1px solid rgba(255,255,255,.11) !important;}
.kiro-model-panel-option[data-a2k-grp="1"]:first-child{margin-top:2px !important;}
.kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-check,
.kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-header{display:none !important;}
.kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-description{display:block !important;color:inherit !important;opacity:1 !important;}
.kiro-model-panel-option-description > .a2k-caps-box{margin-top:2px !important;}
${END}`;

const ORIG_JS_PATTERN =
  'className:"chat-input-popup-option","data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a(()=>g(T),"onClick"),onKeyDown:a(O=>{O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})';

const SVG_BRAIN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.6 6.5a3 3 0 0 0 .4-1.4"/><path d="M6 5.1a3 3 0 0 0 .4 1.4"/><path d="M3.5 10.9a4.5 4.5 0 0 0 1.5 2.1"/><path d="M20.5 10.9a4.5 4.5 0 0 1-1.5 2.1"/></svg>';

const SVG_IMAGE =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';

const SVG_OPENAI =
  '<svg viewBox="0 0 40 40" width="15" height="15" fill="currentColor"><path d="M32.837 16.48a9.49 9.49 0 0 0-.825-7.85 9.61 9.61 0 0 0-10.368-4.63 9.64 9.64 0 0 0-7.876 4.02 9.51 9.51 0 0 0-6.386 4.63 9.61 9.61 0 0 0 1.187 11.33 9.5 9.5 0 0 0 .817 7.84 9.62 9.62 0 0 0 10.378 4.63 9.64 9.64 0 0 0 7.87-4.01 9.53 9.53 0 0 0 6.384-4.63 9.63 9.63 0 0 0-1.181-11.33zm-14.4 20.1a7.14 7.14 0 0 1-4.59-1.66l.23-.13 7.62-4.4a1.27 1.27 0 0 0 .63-1.09v-10.74l3.22 1.86a.11.11 0 0 1 .06.08v8.9a7.18 7.18 0 0 1-7.17 7.18zm-15.42-6.58a7.13 7.13 0 0 1-.85-4.8l.23.14 7.63 4.4a1.23 1.23 0 0 0 1.24 0l9.31-5.37v3.72a.13.13 0 0 1-.05.1l-7.7 4.45a7.18 7.18 0 0 1-9.81-2.64zm-3.73-13.1a7.15 7.15 0 0 1 3.77-3.15V22.4a1.22 1.22 0 0 0 .62 1.08l9.27 5.35-3.22 1.86a.12.12 0 0 1-.11 0l-7.7-4.44a7.18 7.18 0 0 1-2.63-9.8zm26.47 6.15-9.3-5.37 3.22-1.86a.12.12 0 0 1 .11 0l7.7 4.45a7.17 7.17 0 0 1-1.08 12.92v-9.05a1.26 1.26 0 0 0-.65-1.09zm3.2-4.82-.22-.14-7.61-4.43a1.24 1.24 0 0 0-1.25 0l-9.31 5.37V15.3a.11.11 0 0 1 .05-.1l7.7-4.44a7.18 7.18 0 0 1 10.64 7.43zM13.25 20.5l-3.22-1.85a.13.13 0 0 1-.06-.09V9.69a7.18 7.18 0 0 1 11.76-5.5l-.23.13-7.61 4.4a1.27 1.27 0 0 0-.64 1.1zm1.75-3.77 4.15-2.39 4.16 2.39v4.78l-4.14 2.39-4.17-2.39z"/></svg>';

/**
 * 选项行补丁（4.13.53 起带「标记门」）：只有 description 以 CPS 私有前缀 `__A2K_GRP__|` / `__A2K_MDL__|` 开头的条目
 * 才加 `a2k-exclusive-model-option` 与卡片 / 模型行类名并接管点击；其余条目（Kiro 官方模型列表、本扩展未运行）
 * 的 className、事件与 children 与出厂表达式逐字等价（`tests/selector` native-fallback 用例以出厂表达式为 oracle）。
 * 4.13.52 及更早的变体把 `a2k-exclusive-model-option` 无条件写进 className，出厂列表也会带上该类。
 */
const PATCHED_JS_CODE =
  `className:"chat-input-popup-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")?" a2k-exclusive-model-option a2k-opt-grp":typeof k==="string"&&k.startsWith("__A2K_MDL__|")?(" a2k-exclusive-model-option a2k-opt-mdl"+(k.endsWith("|1")?" a2k-opt-last":"")):""),"data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a((e)=>{if(T?.startsWith?.("a2k-group:")||(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))||(typeof k==="string"&&k.startsWith("__A2K_")&&!E)){e?.preventDefault?.();e?.stopPropagation?.();return}g(T)},"onClick"),onKeyDown:a(O=>{if(T?.startsWith?.("a2k-group:")||(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))||(typeof k==="string"&&k.startsWith("__A2K_")&&!E))return;O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))?(()=>{const p=k.split("|");let logoHtml="";try{if(p[5]){logoHtml="<span class=\\\"a2k-logo\\\">"+atob(p[5])+"</span>";}}catch(_e){}if(!logoHtml){logoHtml=p[4]==="openai"?'<span class=\\"a2k-logo\\">${SVG_OPENAI}</span>':'<span class=\\"a2k-logo\\">'+(p[3]||"P")+'</span>';}return b.jsx("div",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:"<span class=\\\"a2k-chev\\\">▼</span>"+logoHtml+"<span class=\\\"a2k-title\\\">"+p[1]+"</span><span class=\\\"a2k-count\\\">"+p[2]+" ↑</span>"}})})():(typeof k==="string"&&k.startsWith("__A2K_MDL__|"))?(()=>{const p=k.split("|"),caps=(p[1]==="1"?'<span class=\\"a2k-cap a2k-cap-reason\\" title=\\"推理\\">${SVG_BRAIN}</span>':'')+(p[2]==="1"?'<span class=\\"a2k-cap a2k-cap-vision\\" title=\\"图片\\">${SVG_IMAGE}</span>':'');return b.jsx("div",{className:"a2k-model-row",dangerouslySetInnerHTML:{__html:"<div class=\\\"a2k-model-name-box\\\"><span class=\\\"chat-input-popup-option-name\\\" title=\\\""+E+"\\\">"+E+"</span></div><div class=\\\"a2k-caps-box\\\">"+caps+"</div>"}})})():b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 临时文件 + 原子 rename。rename 在 Windows 上可能被杀软 / 索引器短暂占用而失败，
 * 只做有限次重试；最终仍失败就清掉临时文件并抛错，绝不退化为直接覆写目标文件
 * （直接覆写中途失败会留下半截 Kiro 文件，比「本次不生效」严重得多）。
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.api4kiro-${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, "utf8");
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (e) {
        lastErr = e;
        await sleep(20 * (attempt + 1));
      }
    }
    throw lastErr;
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

/**
 * 清掉本插件早先留在 Kiro 目录里的过期临时文件（`<file>.api4kiro-<pid>.tmp`，非本进程且超过 60 s）。
 * 4.13.30 及更早的 writeAtomic 在 rename 失败后退化为直接覆写，2026-09-06 实拍 Kiro 1.0.411 的
 * assets/ 下就躺着一个 0 字节的 `mermaid-*.js.api4kiro-60336.tmp`。只认自己的命名，不碰其他文件。
 */
async function sweepStaleTmp(file: string): Promise<void> {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.api4kiro-`;
  const own = `${prefix}${process.pid}.tmp`;
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp") || name === own) continue;
      const p = path.join(dir, name);
      const st = await fs.promises.stat(p).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > 60_000) await fs.promises.unlink(p).catch(() => undefined);
    }
  } catch {
    // 目录不可读：由各 sync 函数自己上报
  }
}

/** 单个靶点的同步结果；detail 只在「本应写入却写失败」时给出（只读 / 被占用 / 权限不足）。 */
type TargetResult = { status: TargetStatus; detail?: string };

/**
 * 一份 Kiro 文件的写入计划（4.13.53 起三处靶点先全部算完再落盘）：`original` 是本轮读到的磁盘内容，`next` 是应写入的内容，
 * 相等则本轮不碰该文件。`original` 同时是提交失败时的回滚依据（不依赖仓内出厂串，任何 Kiro 版本都能回到本轮读到的状态）。
 * `log` 可选：提交成功时的日志覆盖，用于文件改动与靶点状态不一致的场景（只动了 usage 钩子段）。
 */
type FilePlan = { file: string; original: string; next: string; log?: string };
/**
 * 一个靶点的计划：`status` 是「全部写成功后」应报的状态；`files` 是该靶点涉及的文件（mermaid 可能多份）；
 * `extras` 是该文件里可选组靶点（4.13.55）的状态。
 */
type TargetPlan = { status: TargetStatus; detail?: string; files: FilePlan[]; extras?: Partial<SyncExtras>; packages?: SelectorPkgState[] };

/**
 * 逐 package 的补丁落地状态。
 *
 * 1.1.14 起同一份 chunk 在多个 package 各有一份、各自独立压缩，所以「这个靶点成没成」必须逐份回答：
 * 只要有一个承载 package 没打上，就不能整体报 applied —— 2026-09-23 的事故正是
 * 「一个视图有补丁、另一个没有」被报成成功（用户看到的是「选不了上下文容量」，日志里却是 applied）。
 */
export type SelectorPkgState = { pkg: string; chunk: string; patched: boolean; ctx: boolean };

const ORIG_MENU_PATTERN =
  'children:b.jsx("div",{ref:c.setFloating,className:"chat-input-popup-menu",style:d,role:"listbox","data-keyboard-nav":l!=="mouse"||void 0,...h(),children:r.map((y,x)=>{const{description:k,name:E,value:T}=y';

/**
 * 菜单容器补丁（4.13.53 起带「标记门」）：只有当前选项列表 `r` 里至少一条 description 以 `__A2K_` 开头（CPS 分组列表）
 * 才加 `a2k-model-selector-menu`（CARD_CSS 的 270px 宽 / resize 手柄 / 高度上限只命中这个类）；Kiro 官方列表得到的
 * className 逐字等于出厂 `"chat-input-popup-menu"`。4.13.52 及更早的变体无条件加类，出厂列表的菜单也会被收窄。
 */
const PATCHED_MENU_CODE =
  'children:b.jsx("div",{ref:c.setFloating,className:"chat-input-popup-menu"+(r.some(v=>typeof v?.description==="string"&&v.description.startsWith("__A2K_"))?" a2k-model-selector-menu":""),style:d,role:"listbox","data-keyboard-nav":l!=="mouse"||void 0,...h(),children:r.map((y,x)=>{const{description:k,name:E,value:T}=y';

const ORIG_REF_PATTERN =
  'ref:a(O=>{m.current[x]=O},"ref")';

/**
 * 选中项 ref 的搜索窗口（字符）。该写法是通用形态，bundle 里出现多处（上下文拾取器 / 智能体列表
 * 都用同形回调），因此只允许在「选项行起点之前这一段」里唯一命中。实测 1.1.14 的间距约 40 字符。
 */
const REF_SCOPE_CHARS = 2000;

/** 选中项居中滚动（4.13.53 起带「标记门」）：只对 description 以 `__A2K_MDL__|` 开头的选中行做一次居中；出厂列表不滚动。 */
const PATCHED_REF_CODE =
  'ref:a(O=>{m.current[x]=O;if(O&&C&&typeof k==="string"&&k.startsWith("__A2K_MDL__|")&&!O.dataset.a2kScrolled){O.dataset.a2kScrolled="1";setTimeout(()=>{O.scrollIntoView({block:"center",behavior:"instant"});},10);}},"ref")';

const ORIG_TRIGGER_PATTERN =
  'className:"model-selector-trigger",disabled:t||r.length===0';

const PATCHED_TRIGGER_CODE =
  'className:"model-selector-trigger",onMouseDown:a(()=>{try{if("vscode"in window&&(!window.__a2kLastReload||Date.now()-window.__a2kLastReload>2000)){window.__a2kLastReload=Date.now();window.vscode.postMessage({type:"executeCommand",command:"api2kiroDual.refreshActiveSession"});}}catch(_e){}},"onMouseDown"),disabled:t||r.length===0';

/**
 * Context Usage 弹层（Kiro `ContextUsagePopover`）出厂整函数的**规范模板**：以 Kiro 1.0.411 的压缩名书写
 * （函数名 Bde、警告文案函数 Pde、函数尾部局部变量 z）。4.13.44 起不再逐字比对：Kiro 1.0.437 重新压缩后
 * 只有这三个名字变了（Bde→qde、Pde→Ude、z→j），其余字符逐字相同。定位用结构匹配（scanMasked）把压缩名
 * 换成捕获组 / 反向引用做结构匹配（见 findPopoverFactory）；还原不再依赖本串，而是回填补丁时随身携带的
 * 块注释标记 `a2k-orig:<base64 出厂原文>`（见 carryMarker / restoreSelectorScript 第 5 步）。本串仍是
 * 4.13.36–4.13.43 写进 1.0.411 文件的历史变体的还原依据（restoreMarkedSpan 旧路径），也是测试 / 检查器的合成基准。
 */
const ORIG_POPOVER_PATTERN =
  'function Bde(t){const e=re.c(30),{livePercentage:n,conversationPct:r,mcpPct:s,steeringPct:i,hasBreakdown:o,warning:l,showWarning:u,style:c,floatingProps:d,summarizationThreshold:f}=t,h=Math.ceil(r),p=Math.ceil(s),m=Math.ceil(i),g=Math.ceil(n),y=n>=f-5;let x;e[0]!==u||e[1]!==l?(x=u&&l!=null&&b.jsxs("div",{className:"kiro-context-popover-warning",children:[b.jsx("div",{className:"kiro-context-popover-warning-header",children:b.jsx("span",{children:"High initial context usage"})}),b.jsx("div",{className:"kiro-context-popover-warning-message",children:Pde(l)})]}),e[0]=u,e[1]=l,e[2]=x):x=e[2];let k;e[3]===Symbol.for("react.memo_cache_sentinel")?(k=b.jsx("span",{children:"Context Usage"}),e[3]=k):k=e[3];const E=`${g}%`;let T;e[4]!==E?(T=b.jsxs("div",{className:"kiro-context-popover-header",children:[k,b.jsx("span",{children:E})]}),e[4]=E,e[5]=T):T=e[5];let C;e[6]===Symbol.for("react.memo_cache_sentinel")?(C=b.jsx("span",{children:"Conversation"}),e[6]=C):C=e[6];const S=`${h}%`;let R;e[7]!==S?(R=b.jsxs("div",{className:"kiro-context-popover-breakdown-row",children:[C,b.jsx("span",{children:S})]}),e[7]=S,e[8]=R):R=e[8];let O;e[9]!==o||e[10]!==p||e[11]!==m||e[12]!==l?.mcpTools||e[13]!==l?.steering?(O=o&&b.jsxs(b.Fragment,{children:[b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.mcpTools||void 0,children:[b.jsx("span",{children:"MCP tools"}),b.jsx("span",{children:`${p}%`})]}),b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.steering||void 0,children:[b.jsx("span",{children:"Steering files"}),b.jsx("span",{children:`${m}%`})]})]}),e[9]=o,e[10]=p,e[11]=m,e[12]=l?.mcpTools,e[13]=l?.steering,e[14]=O):O=e[14];let L;e[15]!==R||e[16]!==O?(L=b.jsxs("div",{className:"kiro-context-popover-breakdown",children:[R,O]}),e[15]=R,e[16]=O,e[17]=L):L=e[17];let I;e[18]!==y||e[19]!==f?(I=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`}),e[18]=y,e[19]=f,e[20]=I):I=e[20];let B;e[21]!==I||e[22]!==T||e[23]!==L?(B=b.jsxs("div",{className:"kiro-context-popover-content",children:[T,L,I]}),e[21]=I,e[22]=T,e[23]=L,e[24]=B):B=e[24];let z;return e[25]!==d||e[26]!==c||e[27]!==x||e[28]!==B?(z=b.jsxs("div",{className:"kiro-context-popover",style:c,role:"tooltip",...d,children:[x,B]}),e[25]=d,e[26]=c,e[27]=x,e[28]=B,e[29]=z):z=e[29],z}a(Bde,"ContextUsagePopover");';

/**
 * Cursor 布局的弹层。数据全部来自 Kiro 自己的 store：`a2kUsage`（由 PATCHED_POPOVER_CALL_CODE 传入的
 * `contextUsage` 原对象）里 breakdown 六个桶各带 `{percent, tokens}`（Kiro `isUsageBucket` 校验过），
 * Kiro 原生弹层只是把它们折成三行百分比。
 * 口径说明（2026-09-07 实测）：百分比是真值——代理按上游实际计费的 prompt token ÷ 我们在模型列表里报的
 * 窗口（如 deepseek-v4 1M）算出后经 Kiro 后端透传；六桶 tokens 则是 Kiro 前端按字符粗估（中文 / JSON 工具
 * 定义会低估一半以上）。两者口径不同，绝不能拿 Σtokens ÷ Σpercent 反推「窗口」——那会得到 430K 这种假数。
 * 窗口大小：webview bundle 里没有 maxInputTokens，由 cpsServer 塞进当前模型 description 的私有微格式
 * `__A2K_MDL__|推理|图片|窗口|末行` 第 3 位；这里用 Kiro 自己的 useSessionConfig（压缩名 l0，模型选择器同一个 hook）
 * 取 category==="model" 的 currentValue 对应选项读出。拿到窗口时右侧显示「~真实已用 / 窗口 tokens」，
 * 真实已用 = livePercentage × 窗口（百分比来自上游真实计费，比 Kiro 的字符估算准）；拿不到时退回「~Σ桶 tokens est.」。
 * 没有 breakdown 时退回 Kiro 原生三项百分比。警告块与 hint 沿用 Kiro 原生类名与文案。
 * 仍保留 re.c(30) 调用以维持 hook 顺序；l0() 也是 hook，必须无条件在顶层调用；不再用 memo 槽位。
 * 本串同样是以 1.0.411 压缩名书写的规范模板（Bde / Pde / l0 三个外部名）；写盘前用 renderTemplate() 换成当前 Kiro
 * 文件里实际的名字（弹层函数名与警告函数名来自 findPopoverFactory 的捕获，useSessionConfig 的压缩名按
 * `a(压缩名,"useSessionConfig")` 标签反查），并在 `function <fn>(t){` 之后紧跟插入 a2k-orig 携带标记。
 *
 * 标记门（4.13.53 起）：`A2K` = 当前会话模型列表（同一 useSessionConfig 数据）里至少一条 description 以 `__A2K_` 开头，
 * 即列表来自本扩展 CPS 的分组输出。`!A2K`（本扩展未运行 / Kiro 官方列表）时走 `N*` 原生分支：与出厂函数体
 * ORIG_POPOVER_PATTERN 逐节点等价（同类名、同文案、同 `&&` 短路值，只是不用 memo 槽位；两个 hook 仍无条件在顶层调用，
 * 两条分支 hook 顺序一致）。`tests/selector` native-fallback 用例以出厂函数为 oracle 做树比较。
 */
const PATCHED_POPOVER_CODE =
  'function Bde(t){const e=re.c(30),[a2kCfg]=l0(),{livePercentage:n,conversationPct:r,mcpPct:s,steeringPct:i,hasBreakdown:o,warning:l,showWarning:u,style:c,floatingProps:d,summarizationThreshold:f,a2kUsage:A}=t,g=Math.ceil(n),y=n>=f-5;const[CW,A2K]=(()=>{try{const q=(a2kCfg||[]).find(z=>z&&z.category==="model");if(!q||q.type!=="select")return[0,false];const F=(q.options||[]).flatMap(v=>v&&Array.isArray(v.options)?v.options:[v]);const M=F.some(v=>typeof v?.description==="string"&&v.description.startsWith("__A2K_"));const z=F.find(v=>v&&v.value===q.currentValue);const p=typeof z?.description==="string"?z.description.split("|"):null;const v0=p&&p[0]==="__A2K_MDL__"?Number(p[3]):0;return[v0>0?v0:0,M]}catch(_e){return[0,false]}})();const x=u&&l!=null&&b.jsxs("div",{className:"kiro-context-popover-warning",children:[b.jsx("div",{className:"kiro-context-popover-warning-header",children:b.jsx("span",{children:"High initial context usage"})}),b.jsx("div",{className:"kiro-context-popover-warning-message",children:Pde(l)})]});if(!A2K){const NH=Math.ceil(r),NP=Math.ceil(s),NM=Math.ceil(i);const NT=b.jsxs("div",{className:"kiro-context-popover-header",children:[b.jsx("span",{children:"Context Usage"}),b.jsx("span",{children:`${g}%`})]});const NR=b.jsxs("div",{className:"kiro-context-popover-breakdown-row",children:[b.jsx("span",{children:"Conversation"}),b.jsx("span",{children:`${NH}%`})]});const NO=o&&b.jsxs(b.Fragment,{children:[b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.mcpTools||void 0,children:[b.jsx("span",{children:"MCP tools"}),b.jsx("span",{children:`${NP}%`})]}),b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.steering||void 0,children:[b.jsx("span",{children:"Steering files"}),b.jsx("span",{children:`${NM}%`})]})]});const NL=b.jsxs("div",{className:"kiro-context-popover-breakdown",children:[NR,NO]});const NI=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`});const NB=b.jsxs("div",{className:"kiro-context-popover-content",children:[NT,NL,NI]});return b.jsxs("div",{className:"kiro-context-popover",style:c,role:"tooltip",...d,children:[x,NB]})}const K=v=>{if(v>=1e6){const q=(v/1e6).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"M"}if(v>=1e3){const q=(v/1e3).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"K"}return String(Math.round(v))};const V=A&&A.breakdown,W=V&&V.tools||{},D=[["prompts","Your prompts",V&&V.yourPrompts],["responses","Kiro responses",V&&V.kiroResponses],["files","Session files",V&&V.sessionFiles],["builtin","Built-in tools",W.builtin],["mcp","MCP tools",W.mcp],["steering","Steering files",V&&V.contextFiles]].filter(q=>q[2]&&typeof q[2].percent=="number"&&typeof q[2].tokens=="number");const J=D.length>0,Q=J?D.map(q=>({k:q[0],n:q[1],p:q[2].percent,v:q[2].tokens,h:q[0]==="mcp"?l?.mcpTools:q[0]==="steering"?l?.steering:void 0})):[{k:"conv",n:"Conversation",p:r,v:0,h:void 0}].concat(o?[{k:"mcp",n:"MCP tools",p:s,v:0,h:l?.mcpTools},{k:"steering",n:"Steering files",p:i,v:0,h:l?.steering}]:[]);const G=J?Q.reduce((q,v0)=>q+v0.v,0):0;const T=b.jsxs(b.Fragment,{children:[b.jsx("div",{className:"a2k-cu-head",children:b.jsx("span",{className:"a2k-cu-title",children:"Context Usage"})}),b.jsxs("div",{className:"a2k-cu-sub",children:[b.jsx("span",{className:"a2k-cu-pct",children:`${g}% Full`}),CW>0?b.jsx("span",{className:"a2k-cu-tokens",title:"Total = real usage reported by the upstream (percentage x context window). Per-category counts below are a rough client-side estimate by Kiro and may not add up to the total.",children:`~${K(Math.round(n/100*CW))} / ${K(CW)} tokens`}):J&&b.jsx("span",{className:"a2k-cu-tokens",title:"Token counts are a rough client-side estimate by Kiro; the percentage comes from the real token usage reported by the upstream.",children:`~${K(G)} tokens est.`})]}),b.jsx("div",{className:"a2k-cu-bar",children:Q.map(q=>b.jsx("div",{className:"a2k-cu-seg a2k-cu-c-"+q.k,style:{width:`${Math.max(0,Math.min(100,q.p))}%`}},q.k))})]});const L=b.jsx("div",{className:"kiro-context-popover-breakdown a2k-cu-rows",children:Q.map(q=>b.jsxs("div",{className:"kiro-context-popover-breakdown-row a2k-cu-row","data-high":q.h||void 0,children:[b.jsxs("span",{className:"a2k-cu-left",children:[b.jsx("span",{className:"a2k-cu-sw a2k-cu-c-"+q.k}),b.jsx("span",{children:q.n})]}),b.jsx("span",{className:"a2k-cu-val",children:J?K(q.v):`${Math.ceil(q.p)}%`})]},q.k))});const v1=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`});const B=b.jsxs("div",{className:"kiro-context-popover-content",children:[T,L,v1]});return b.jsxs("div",{className:"kiro-context-popover a2k-cu",style:c,role:"tooltip",...d,children:[x,B]})}a(Bde,"ContextUsagePopover");';

/**
 * ContextUsageIndicator（1.0.411 压缩名 Ude）里挂载弹层的一行：多传 store 原对象 `n`（contextUsage），其余不动。
 * 两串都是以 1.0.411 弹层函数名 Bde 书写的规范模板；查找 / 写盘前用 renderTemplate(…, ["Bde"], [实际函数名]) 渲染。
 */
const ORIG_POPOVER_CALL_PATTERN =
  'Y=g&&b.jsx(Bde,{livePercentage:i,conversationPct:y,mcpPct:x,steeringPct:k,hasBreakdown:E,warning:T,showWarning:I,style:R,floatingProps:{...L(),ref:S},summarizationThreshold:o})';
const PATCHED_POPOVER_CALL_CODE =
  'Y=g&&b.jsx(Bde,{livePercentage:i,conversationPct:y,mcpPct:x,steeringPct:k,hasBreakdown:E,warning:T,showWarning:I,style:R,floatingProps:{...L(),ref:S},summarizationThreshold:o,a2kUsage:n})';

/** 4.13.36 及更早版本的弹层局部补丁串（函数内四处）。只用于测试描述历史变体；还原不再依赖它们。 */
const LEGACY_POPOVER_VARIANTS = {
  BDE_ORIG: 'const E=`${g}%`;let T;e[4]!==E?(T=b.jsxs("div",{className:"kiro-context-popover-header",children:[k,b.jsx("span",{children:E})]}),e[4]=E,e[5]=T):T=e[5];',
  BDE_PATCHED:
    'const E=`${g}%`;const cBar=b.jsxs("div",{className:"cursor-context-bar-wrap",children:[b.jsx("div",{className:"cursor-context-seg seg-conv",style:{width:`${h}%`}}),b.jsx("div",{className:"cursor-context-seg seg-mcp",style:{width:`${p}%`}}),b.jsx("div",{className:"cursor-context-seg seg-steering",style:{width:`${m}%`}})]});let T;e[4]!==E?(T=b.jsxs(b.Fragment,{children:[b.jsxs("div",{className:"kiro-context-popover-header",children:[k,b.jsx("span",{children:E})]}),cBar]}),e[4]=E,e[5]=T):T=e[5];',
  CONV_ORIG: 'let C;e[6]===Symbol.for("react.memo_cache_sentinel")?(C=b.jsx("span",{children:"Conversation"}),e[6]=C):C=e[6];',
  CONV_PATCHED:
    'let C;e[6]===Symbol.for("react.memo_cache_sentinel")?(C=b.jsxs("span",{className:"cursor-row-left",children:[b.jsx("span",{className:"cursor-legend-dot dot-conv"}),b.jsx("span",{children:"Conversation"})]}),e[6]=C):C=e[6];',
  MCP_ORIG: 'b.jsx("span",{children:"MCP tools"})',
  MCP_PATCHED: 'b.jsxs("span",{className:"cursor-row-left",children:[b.jsx("span",{className:"cursor-legend-dot dot-mcp"}),b.jsx("span",{children:"MCP tools"})]})',
  STEERING_ORIG: 'b.jsx("span",{children:"Steering files"})',
  STEERING_PATCHED:
    'b.jsxs("span",{className:"cursor-row-left",children:[b.jsx("span",{className:"cursor-legend-dot dot-steering"}),b.jsx("span",{children:"Steering files"})]})',
};

/**
 * 4.13.52 及更早版本的菜单容器 / 选中项居中补丁串（无标记门：出厂列表也被加类、也被滚动）。
 * 磁盘实拍 fixture（1.0.411）与真机只读副本（1.0.437）都处于这个形态；只用于测试描述历史变体，还原走锚点路径。
 */
const LEGACY_SELECTOR_VARIANTS = {
  MENU_4_13_52:
    'children:b.jsx("div",{ref:c.setFloating,className:"chat-input-popup-menu a2k-model-selector-menu",style:d,role:"listbox","data-keyboard-nav":l!=="mouse"||void 0,...h(),children:r.map((y,x)=>{const{description:k,name:E,value:T}=y',
  REF_4_13_52:
    'ref:a(O=>{m.current[x]=O;if(O&&C&&!O.dataset.a2kScrolled){O.dataset.a2kScrolled="1";setTimeout(()=>{O.scrollIntoView({block:"center",behavior:"instant"});},10);}},"ref")',
};


function kiroAgentBackendFile(): string {
  return path.join(
    vscode.env.appRoot,
    "extensions",
    "kiro.kiro-agent",
    "dist",
    "extension.js"
  );
}

/**
 * 后端 `modelConfigProvider` setter 钩子的规范模板（Kiro 1.0.411 压缩名：setter QPe、存储变量 Oue）。
 * 1.0.437 变成 `function XPe(t){Fue=t}`，1.1.14 实测为 `function ufs…` 形态但结构不变。定位靶点改用结构锚点（见 findBackendHook）：
 * 「`function NAME(t){STORE=t}` 紧跟 `function X(){return STORE}`，且全文存在 `STORE.getAvailableModels()`」——
 * 在 1.0.411 / 1.0.437 / **1.1.14** 都恰好唯一命中。写盘前用 renderTemplate(PATCHED_QPE_PATTERN, ["QPe","Oue"], [fn, store]) 渲染。
 */
const ORIG_QPE_PATTERN = 'function QPe(t){Oue=t}';
const PATCHED_QPE_PATTERN = 'function QPe(t){Oue=t;try{globalThis.__kiroModelConfigProvider=t}catch(_){}}';

// ============================================================================
// 结构匹配：名字用正则捕获，模板用规范名书写（4.13.44；Kiro 1.0.437 重新压缩改名事故）
// ============================================================================

const IDENT_SRC = "[A-Za-z_$][\\w$]*";
/** 按 JS 标识符边界切出标识符：前一个字符不能是 [\w$]，本身以字母 / _ / $ 开头。数字字面量（30、1e6）不会被切成标识符。 */
const IDENT_RE = /(?<![\w$])[A-Za-z_$][\w$]*/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

/**
 * 按标识符边界把模板里的规范名换成实际名（同一趟替换，不会链式改写）。
 *
 * 实现委托给 renderIdentifierMap：它会把字符串 / 模板串 / 注释整段跳过，
 * 绝不去动里面的字面量（早期版本用裸 IDENT_RE 替换，会把模板串里的反引号也换掉，
 * 产出 `` v2{g}% `` 这种坏代码）。
 */
function renderTemplate(template: string, canonNames: string[], actualNames: string[]): string {
  return renderIdentifierMap(template, canonNames, actualNames);
}

/**
 * 渲染前的护栏：实际名若与模板里其他标识符同名（例如 Kiro 某天把 useSessionConfig 压成 `K`，而补丁里已有局部 `const K`），
 * 渲染结果会发生遮蔽 / TDZ 错误。这种情况宁可不打（静默放行）。
 */
function namesCollide(template: string, canonNames: string[], actualNames: string[]): boolean {
  // 只收**代码**里的标识符：字符串 / 模板串 / 注释里的词不参与判定。
  // 用裸 IDENT_RE 会把 `children:"manual"`、`+"M")` 这类字面量里的词（M / K / at / of…）
  // 也算成「模板里的名字」，于是真机把 jsx 运行时压成 `M` 时整条补丁被无谓拒绝
  // （实测 CTX_SEL_FN_TEMPLATE + jsx=`M` → 旧判据 true）。字面量里的词不会遮蔽任何东西。
  const others = new Set<string>();
  for (const t of codeTokens(template)) {
    if (t.isIdent && !canonNames.includes(t.text)) others.add(t.text);
  }
  return actualNames.some((n) => others.has(n));
}

// ============================================================================
// 结构等价匹配（4.13.59；Kiro 1.1.14 整体重压缩事故）
//
// 压缩器唯一的自由度是给标识符改名：它不改结构、不改属性名、不改字符串字面量、不改数字。
// 于是「模板」与「真机文本」若只差一次一致改名，就应当被认成同一段代码——
// 判据是两者的 token 流同构：非标识符 token 逐一相同、标识符 token 一一对应。
// 同构还顺带产出一份「规范名 → 真机名」映射，用 renderTemplate 把整份补丁模板渲染成真机形态。
//
// 定位不靠屏蔽串 indexOf：屏蔽后标识符全被吃掉，模板只剩零星标点与属性名，
// 两段无关代码也可能长度相同且屏蔽后相同（实测 KaTeX 符号表里就能撞上选项行的屏蔽串）；
// 而且屏蔽串比原文短，屏蔽串偏移**不能**用来切原文。改为拿模板里最长的非标识符 run
// （属性名 / 字符串 / 标点，压缩器一个字符都不动）当锚逐字定位，再对窗口做 token 复验。
//
// 实测：Kiro 1.1.14 的选项行 / 菜单 / ref / 弹层函数 / 弹层调用处五份规范模板原始串全不中，
// 走本模块后各命中恰好 1 次。
// ============================================================================

/** 标识符哨兵。U+0000 不可能出现在 JS 源码里；只用于诊断导出。 */
const MASK_CHAR = "\u0000";

/** 屏蔽掉全部标识符之后的文本。只用于人肉排查，判结构等价请用 verifyTokens。 */
function mask(content: string): string {
  return content.replace(IDENT_RE, MASK_CHAR);
}

/** 一段命中：start/end 是内容里的切片边界，text 是原样内容，map 是规范名 → 实际名。 */
type MaskedSpan = { start: number; end: number; text: string; map: ReadonlyMap<string, string> };

/** 代码 token：标识符，或「非标识符字面区」（字符串 / 模板串 / 注释 / 属性名 / 标点 / 数字）。 */
type CodeToken = { isIdent: boolean; text: string; at: number };

/**
 * 把代码切成 token 流。
 *
 * **必须**先把字符串 / 模板串 / 注释整段跳过去，再在剩下的代码里切标识符：
 * 否则模板串里的内容会被当成代码——补丁模板里的 `` `${g}%` `` 反引号会被 IDENT_RE
 * 当成标识符选中（反引号不在 `[\w$]` 里，`(?<![\w$])` 放行），渲染时被替换成正则占位符，
 * 产出 `` v2{g}% `` 这种直接语法错误。字符串与注释里的字面量在压缩前后逐字不变，
 * 正好可以当成可靠的结构锚。
 *
 * 成员访问的属性名（`.` 之后的标识符，`...x` 展开除外）按**字面量**处理：压缩器从不改属性名，
 * 它们不参与改名映射。4.13.64 修：Kiro 1.2.56 的 agent-chat 把弹层函数里的局部 `style:c` 压成
 * `style:u`（`c`/`u` 对调），而 `ne.c(30)` 的 `.c` 是 React Compiler 运行时的属性；旧实现把 `.c`
 * 也当成可改名标识符，verifyTokens 于是看到规范名 `c` 同时映到 `c`（属性）与 `u`（局部），判不一致 → 0 命中。
 */
function codeTokens(text: string): CodeToken[] {
  const out: CodeToken[] = [];
  const splitScan = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let last = 0;
  const pushCode = (from: number, to: number) => {
    let prev = from;
    for (const m of text.slice(from, to).matchAll(IDENT_RE)) {
      const at = from + (m.index as number);
      if (at > prev) out.push({ isIdent: false, text: text.slice(prev, at), at: prev });
      // `a.b` / `a?.b` 的 b 是属性名（不可压缩）；`...b` 是展开，b 仍是标识符
      const member = at > 0 && text[at - 1] === "." && !(at > 1 && text[at - 2] === ".");
      out.push({ isIdent: !member, text: m[0], at });
      prev = at + m[0].length;
    }
    if (prev < to) out.push({ isIdent: false, text: text.slice(prev, to), at: prev });
  };
  for (const m of text.matchAll(splitScan)) {
    const at = m.index as number;
    pushCode(last, at);
    out.push({ isIdent: false, text: m[0], at });
    last = at + m[0].length;
  }
  pushCode(last, text.length);
  return out;
}

/**
 * 结构等价复验 + 改名映射（一趟）。
 *
 * - 非标识符 token 必须逐一相同（属性名 / 字符串字面量 / 数字 / 标点都不可压缩，
 *   这条几乎排除了全部误命中）；
 * - 标识符 token 必须一一对应，且同一规范名必须始终对应同一实际名
 *   （压缩器不会把同一个名字在不同位置压成两个名字）。
 * - 成员访问的属性名（`ne.c` 的 `.c`）由 codeTokens 归为字面量，必须逐字相同、不进映射
 *   （4.13.64：1.2.56 的局部 `c`/`u` 对调曾让属性 `.c` 与局部 `c` 抢同一条映射）。
 *
 * 注意**不要**在这里检查「两个规范名映到同一实际名」：那是合法且常见的
 * （1.1.14 的弹层里规范名 `z` 与 `H` 都映到实际的 `H`）。真正会出问题的是
 * 「用真机名写模板」时的替换冲突，那由 renderMatched 的落地守卫负责。
 *
 * 返回 null 表示「不是一次一致改名」。
 */
function verifyTokens(canonical: string, actual: string): { map: Map<string, string> } | null {
  const ct = codeTokens(canonical);
  const at = codeTokens(actual);
  if (ct.length !== at.length) return null;
  const map = new Map<string, string>();
  for (let i = 0; i < ct.length; i++) {
    if (ct[i].isIdent !== at[i].isIdent) return null;
    if (!ct[i].isIdent) {
      if (ct[i].text !== at[i].text) return null;
      continue;
    }
    const known = map.get(ct[i].text);
    if (known !== undefined) {
      if (known !== at[i].text) return null;
      continue;
    }
    map.set(ct[i].text, at[i].text);
  }
  return { map };
}

/**
 * 结构等价段的全部命中位置。
 *
 * 做法：把模板编译成「非标识符逐字、标识符各自独立通配」的正则，直接在原文上匹配。
 *
 * 为什么标识符必须**独立**通配、而不是同名反引用：模板是拿一个 Kiro 版本的压缩名写的，
 * 真机是另一个版本，同一个规范名在真机里对应哪个实际名无从预设。反引用会强行要求「两处同名」，
 * Kiro 一旦把两个同名变量压成不同名就整段失配——正是这次事故的形态。
 * 名字统一从逐 token 的结构对齐里读，不再用捕获组。
 *
 * 为什么不用 identifier-masked 串 indexOf：屏蔽后标识符全被吃掉，模板只剩零星标点与属性名，
 * 两段无关代码也可能长度相同且屏蔽后相同（实测 KaTeX 符号表里就能撞上选项行的屏蔽串）；
 * 而且屏蔽串比原文短（1.1.14 的 mermaid bundle：1 843 793 → 981 285），
 * 屏蔽串上的偏移**不能**直接用来切原文。逐字保留非标识符、用标识符边界夹住通配，
 * 既保住全部可压缩信息，又让匹配偏移就是原文偏移。
 *
 * 命中后再逐 token 复验并产出改名映射（同一趟）：本函数是「宁可漏、不可错」的定位器，
 * 命中数不为 1 时 matchMasked 报不可用（全有或全无）。
 */
function scanMasked(content: string, canonical: string): MaskedSpan[] {
  const hits: MaskedSpan[] = [];
  const seen = new Set<number>();
  for (const m of content.matchAll(structuralRegex(canonical))) {
    const start = m.index as number;
    if (seen.has(start)) continue;
    seen.add(start);
    const text = m[0];
    const verified = verifyTokens(canonical, text);
    if (!verified) continue;
    hits.push({ start, end: start + text.length, text, map: verified.map });
  }
  return hits;
}

/**
 * 把模板编译成结构正则：非标识符片段逐字转义，每个标识符换成
 * `(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])`——各自独立，不共享捕获组、不互相反引用。
 *
 * 字符串 / 模板串 / 注释整段当成「非标识符片段」逐字转义，绝不在里面放通配：
 * 模板串里的 `${g}%` 是代码，但两边逐字相同，不需要通配；而把反引号当标识符切
 * 会直接产出坏正则。
 */
function structuralRegex(canonical: string): RegExp {
  let src = "";
  let last = 0;
  for (const t of codeTokens(canonical)) {
    src += escapeRe(canonical.slice(last, t.at));
    src += t.isIdent ? `(?<![\\w$])${IDENT_SRC}(?![\\w$])` : escapeRe(t.text);
    last = t.at + t.text.length;
  }
  src += escapeRe(canonical.slice(last));
  return new RegExp(src, "g");
}

/** 恰好一处结构等价命中才返回，否则 null（「唯一命中」语义：多了就是有歧义，宁可不打）。 */
function matchMasked(content: string, canonical: string): MaskedSpan | null {
  const hits = scanMasked(content, canonical);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 用命中段的映射把模板渲染成真机形态；映射不可靠时返回 null（宁可不打）。
 *
 * 只把「在真机里确实改了名」的名字当规范名参与整串替换（映射回自身的名字不参与，
 * 那些是模板自带的局部名或真机里恰好同名的外部名，替换它们只会引入遮蔽风险）。
 *
 * 落地守卫：新名字若已被模板自己声明为局部名，就放弃这一条改名——压缩名会撞车：
 * 1.1.14 真机把选项行 name 变量压成 `w`，而补丁模板里也有自己的 `w` 一族，
 * 无脑替换会把模板局部名一起改掉。规范名**本身**声明在模板里不算冲突
 * （`function Bde(t){` 那种头部是补丁签名，本来就得换成真机名）。
 * 这种情况顶多让某个靶点报不可用，绝不产出错代码（与 namesCollide 同一取向）。
 */
function renderMatched(template: string, canonical: string, span: MaskedSpan): string | null {
  if (span.map.size === 0) return null;
  const canonNames: string[] = [];
  const actualNames: string[] = [];
  const seen = new Set<string>();
  for (const t of codeTokens(canonical)) {
    if (!t.isIdent || seen.has(t.text)) continue;
    seen.add(t.text);
    const act = span.map.get(t.text);
    if (act === undefined || act === t.text) continue;
    if (isDeclaredName(template, act)) continue;
    canonNames.push(t.text);
    actualNames.push(act);
  }
  if (canonNames.length === 0) return null;
  if (namesCollide(template, canonNames, actualNames)) return null;
  return renderIdentifierMap(template, canonNames, actualNames);
}

/**
 * 按标识符边界替换名字，但**跳过字符串 / 模板串 / 注释**——模板串里的 `${g}%` 是代码，
 * 但反引号本身绝不能被当成标识符选中（否则会产出 `v2{g}%` 这种坏代码）。
 * 同一趟替换，不会链式改写。成员访问的属性名（`.c`、`.jsx`）不可压缩，不参与改名（见 codeTokens）。
 */
function renderIdentifierMap(template: string, canonNames: string[], actualNames: string[]): string {
  const map = new Map<string, string>();
  for (let i = 0; i < canonNames.length; i++) map.set(canonNames[i], actualNames[i]);
  let out = "";
  for (const t of codeTokens(template)) {
    if (t.isIdent) out += map.get(t.text) ?? t.text;
    else out += t.text;
  }
  return out;
}

/**
 * 该标识符在文本里是否已被就地声明为局部名（解构字段 / 函数参数 / 变量声明）。
 *
 * 判据取三种声明位置，但必须在**剥掉字符串字面量与注释**之后匹配：`"livePercentage"` 这类
 * JSX 属性名混在引号里，直接跑正则会把它误判成「模板声明了这个名字」。
 * 宁可保守（漏判只是少打一次补丁，绝不产出错代码）。
 */
function isDeclaredName(text: string, name: string): boolean {
  const code = scrubText(text);
  const n = escapeRe(name);
  return (
    new RegExp(`[{,]\\s*${n}\\s*:`).test(code) ||
    // 形参列表必须能认出「这是形参表」，不能只看括号：
    // 早期判据 `[(,]${n}[,)]` 会把再普通不过的**单参调用** `g(T)` 当成「模板声明了 T」。
    // 1.1.14 的 kiro-ui-session-details chunk 上正好踩中：真机把规范名 `T` 有关的 `k` 压成 `T`，
    // 于是这条改名被丢掉，`k` 随之落进 namesCollide 的 others，与另一条 `b→k` 撞车 →
    // 整条选项行补丁被拒（实机现象：每行模型名下面直接显示 CPS 的 `__A2K_MDL__|…` 微格式）。
    // 宁可漏判一次声明（漏判只是少打一次补丁），也不要把调用当声明（误判会拒掉整条补丁）。
    new RegExp(`(?:[(,]\\s*${n}\\s*,|,\\s*${n}\\s*\\))`).test(code) ||
    // 单形参的函数声明与箭头函数单独认：`function f(T)` / `(T)=>` / `T=>`。
    new RegExp(`function[^()]*\\(\\s*${n}\\s*\\)`).test(code) ||
    new RegExp(`\\(?\\s*${n}\\s*\\)?\\s*=>`).test(code) ||
    new RegExp(`(?:const|let|var)\\s+${n}(?![\\w$])(?!\\s*:)`).test(code)
  );
}

/**
 * 把字符串字面量（含模板串）与注释的内容整体替换为空格，保留长度与引号 / 括号骨架。
 * 只服务 isDeclaredName 的声明判定——不需要解析嵌套，只要长度不变、引号内外不串。
 */
function scrubText(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out[i] = " ";
          if (i + 1 < src.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        out[i] = " ";
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out[i] = " ";
        i++;
      }
      if (i < src.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Kiro 给每个函数都打了 `<名字助手>(压缩名,"原名")` 标签（React 组件 / hook 的 displayName 保留）。
 * 按原名反查压缩名；全文必须恰好一处，否则返回 null。
 *
 * ⚠️ **名字助手自己也会被压缩，而且各 bundle 独立压缩**：同一个 Kiro 版本里
 * `kiro-ui-agent-chat` 是 `a(X,"useSessionConfig")`，而 `kiro-ui-session-details` 是
 * `o(C1,"useSessionConfig")`（1.1.14 实测）。旧实现把助手名写死成 `a`，于是
 * session-details 里这个反查恒为「未命中」→ `applyCtxSelector` 返回 null →
 * **该视图的聊天框「上下文」下拉整体不注入**（2026-09-23 用户实测：选不了上下文容量）。
 * 这也是「一个锚点漂移会连带关掉整组」的又一处实例，判定必须按结构而不是按压缩名。
 *
 * 顺序：先按历史形态 `a(` 找（1.0.x 与 agent-chat 一直如此，保持既有行为逐字不变），
 * 不中再放宽到「任意助手名」。两个形态都要求**全文总计恰好一处**——只放宽助手名，
 * 不放宽唯一性：宽形态会命中更松的形状，混用（窄一处 + 别处一处宽）时宁可返回 null，
 * 挑错名字会把真机的 hook 名写进补丁，比不打更糟。
 *
 * 两种形态都要求助手名是**独立调用**（`(?<![\w$.])`）：`ns.a(X,"useSessionConfig")`
 * 这种成员调用不是 displayName 标签，不许当靶点。
 *
 * 已知边界：判定在**原始文本**上跑，不排除字符串 / 注释里的同形文本（给每个多兆 chunk
 * 多跑一次分词不值当）。后果在安全侧——字符串里多一处同形文本会让唯一性失败而返回 null，
 * 也就是「宁可不打」，不会挑错名字。实测 1.1.14 两份 chunk 里 `"useSessionConfig"` 各只出现 1 次。
 */
function resolveTaggedName(content: string, originalName: string): string | null {
  const tag = `,"${escapeRe(originalName)}"\\)`;
  const narrow = [...content.matchAll(new RegExp(`(?<![\\w$.])a\\((${IDENT_SRC})${tag}`, "g"))];
  const wide = [...content.matchAll(new RegExp(`(?<![\\w$.])(${IDENT_SRC})\\((${IDENT_SRC})${tag}`, "g"))];
  // 窄形态是宽形态的子集（同一处命中两个正则都会命中），所以按「起始位置去重」计总数。
  const total = new Set([...narrow, ...wide].map((m) => m.index));
  if (total.size !== 1) {
    return null;
  }
  return narrow.length === 1 ? narrow[0][1] : wide[0][2];
}

/** ORIG_POPOVER_PATTERN 里随压缩器改名的三个名字：弹层函数、警告文案函数、函数尾部局部变量。 */
const POPOVER_FACTORY_CANON = ["Bde", "Pde", "z"];
/**
 * 规范模板尾部挂着的 displayName 标签（函数体之外），定位函数体时要摘掉。
 * 以 1.0.411 压缩名书写，所以整串出现在 ORIG_POPOVER_PATTERN 里。**只用于切模板**：
 * 写盘 / 比对时一律用真机的助手名（见 popoverTagText / readPopoverTagger）。
 */
const POPOVER_TAG_SUFFIX = 'a(Bde,"ContextUsagePopover");';
/** 弹层函数体的规范模板（= 规范串去掉尾部 displayName 标签），结构匹配以它为准。 */
const POPOVER_FACTORY_BODY_CANON = ORIG_POPOVER_PATTERN.replace('a(Bde,"ContextUsagePopover");', "");
/**
 * PATCHED_POPOVER_CODE 里需要换成实际名的外部名：弹层函数、警告文案函数、useSessionConfig、React Compiler 运行时。
 *
 * 第 4 个 `re` 是 `re.c(30)` 里的 React Compiler 运行时命名空间（压缩名，各版本不同：1.1.14 / 1.2.56 是 `ne`）。
 * 4.13.64 及以前漏了它：补丁里的 `re.c(30)` 原样落地，而 1.2.56 里顶层的 `re` 是另一个函数
 * （`function re(t){const e=C.useContext(...)`），于是 Context Usage 弹层一渲染就抛
 * `re.c is not a function`，整个 webview 掉进 "Something went wrong"。
 */
const POPOVER_PATCH_CANON = ["Bde", "Pde", "l0", "re"];
/** 补丁模板的**函数体**（不含尾部标签）：标签按真机助手名单独拼，不参与模板改名（见下）。 */
const PATCHED_POPOVER_BODY = PATCHED_POPOVER_CODE.endsWith(POPOVER_TAG_SUFFIX)
  ? PATCHED_POPOVER_CODE.slice(0, -POPOVER_TAG_SUFFIX.length)
  : PATCHED_POPOVER_CODE;

/**
 * displayName 标签的逐字形态：`<助手>(<函数名>,"ContextUsagePopover");`。
 *
 * ⚠️ 助手名同样是**压缩名**，而且各 bundle 独立压缩：1.1.14 里 `kiro-ui-agent-chat` 是 `a(...)`、
 * `kiro-ui-session-details` 是 `o(...)`（实测把真机标签的 `a` 改成 `o`，旧实现因为拿规范名 `a`
 * 逐字比对，`findPopoverFactory` 立刻返回 null、弹层补丁整条不再注入）。
 *
 * 标签**不参与模板改名**：直接按真机助手名拼字符串，避免把 "a" 塞进 renderTemplate 的 canon
 * 列表——那样一旦真机助手名与模板局部名撞车（助手名常见单字母），改名会把模板自己的局部名也改掉。
 */
function popoverTagText(tagger: string, fn: string): string {
  return `${tagger}(${fn},"ContextUsagePopover");`;
}

/** 读命中段**紧跟着**的标签，取真机助手名。贴着命中段末尾锚定，不需要预设任何压缩名。 */
function readPopoverTagger(content: string, at: number, fn: string): string | null {
  const re = new RegExp(`^([A-Za-z_$][\\w$]*)\\(${escapeRe(fn)},"ContextUsagePopover"\\);`);
  const m = re.exec(content.slice(at, at + fn.length + 64));
  return m ? m[1] : null;
}

/**
 * 弹层调用处追加的属性里的 store 名。它由外层 `{…}=<hook>(<store>)` 绑定，出厂调用处本身不引用，
 * 所以命中段里读不出来——只能沿用实测值；写成 `typeof <store>==="undefined"?void 0:<store>`，
 * 这样 Kiro 再次重压缩把这个名字改掉时，弹层退回「无 breakdown」的原生三项视图，而不是抛 ReferenceError。
 */
const POPOVER_STORE_NAME = "n";
/** PATCHED_QPE_PATTERN 里需要换成实际名的两个名字：setter、存储变量。 */
const BACKEND_CANON = ["QPe", "Oue"];

type PopoverFactoryHit = {
  start: number;
  end: number;
  text: string;
  names: { fn: string; warn: string; local: string };
  /** 真机 displayName 标签的助手名（1.1.14 两份 chunk 分别是 a / o）。 */
  tagger: string;
  /** 函数体（不含尾部 displayName 标签）的命名映射，供 renderMatched 渲染补丁模板。 */
  span: MaskedSpan;
};
type SpanHit = { start: number; end: number; text: string };
type BackendHookHit = { start: number; end: number; fn: string; store: string };

/** 用结构匹配在文件里找出厂弹层函数；必须恰好一处，否则 null。 */
function findPopoverFactory(content: string): PopoverFactoryHit | null {
  // ORIG_POPOVER_PATTERN 的规范模板把「整函数 + 紧随其后的 displayName 标签」写成一串。
  // 标签在函数体**之外**，而函数体本身与真机是 1:1 同名改写关系，所以搜索时把标签摘掉，
  // 命中后按真机函数名 + **真机助手名**把标签读回来（两个名字都要跟着换）。
  const search = ORIG_POPOVER_PATTERN.replace(POPOVER_TAG_SUFFIX, "");
  const span = matchMasked(content, search);
  if (!span) return null;
  const names = {
    fn: span.map.get("Bde") ?? "Bde",
    warn: span.map.get("Pde") ?? "Pde",
    local: span.map.get("z") ?? "z",
  };
  const tagger = readPopoverTagger(content, span.end, names.fn);
  if (!tagger) return null;
  const tag = popoverTagText(tagger, names.fn);
  return { start: span.start, end: span.end + tag.length, text: span.text + tag, names, tagger, span };
}

/** 弹层调用处（出厂形态，以实际函数名渲染后做结构匹配）；必须恰好一处，否则 null。 */
function findPopoverCall(content: string, fn: string): SpanHit | null {
  const canonical = renderTemplate(ORIG_POPOVER_CALL_PATTERN, ["Bde"], [fn]);
  const span = matchMasked(content, canonical);
  return span ? { start: span.start, end: span.end, text: span.text } : null;
}

const BACKEND_HOOK_RE = /function ([A-Za-z_$][\w$]*)\(t\)\{([A-Za-z_$][\w$]*)=t\}(?=function [A-Za-z_$][\w$]*\(\)\{return \2\})/g;

function usesGetAvailableModels(content: string, store: string): boolean {
  const needle = `${store}.getAvailableModels()`;
  let i = -1;
  while ((i = content.indexOf(needle, i + 1)) >= 0) {
    const prev = i > 0 ? content[i - 1] : "";
    if (!/[\w$]/.test(prev)) return true;
  }
  return false;
}

/**
 * 后端 setter 钩子的结构锚点：`function NAME(t){STORE=t}` 紧跟 `function X(){return STORE}`，
 * 且全文存在 `STORE.getAvailableModels()`（标识符边界）。候选恰好一个才返回。
 */
function findBackendHook(content: string): BackendHookHit | null {
  const hits: BackendHookHit[] = [];
  for (const m of content.matchAll(BACKEND_HOOK_RE)) {
    if (!usesGetAvailableModels(content, m[2])) continue;
    hits.push({ start: m.index as number, end: (m.index as number) + m[0].length, fn: m[1], store: m[2] });
    if (hits.length > 1) return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

/** 已打上补丁的后端钩子（任何版本 / 任何名字）：`function NAME(t){STORE=t;try{globalThis.__kiroModelConfigProvider=t…}catch(_){}}` */
const BACKEND_PATCHED_RE = /function ([A-Za-z_$][\w$]*)\(t\)\{([A-Za-z_$][\w$]*)=t;try\{globalThis\.__kiroModelConfigProvider=t[^}]*\}catch\(_\)\{\}\}/g;

/**
 * 随身携带的出厂原文标记：打补丁时紧跟在 `function <fn>(t){` 之后插入。base64 字母表不含 `*`，不可能提前闭合块注释；
 * 约 3.2 KB，只在一个函数里出现一次。还原时按本标记解码回填，不需要知道当时的 Kiro 版本或函数名。
 */
function carryMarker(factoryText: string): string {
  return `/*a2k-orig:${Buffer.from(factoryText, "utf8").toString("base64")}*/`;
}
const POPOVER_CARRY_RE = /function ([A-Za-z_$][\w$]*)\(t\)\{\/\*a2k-orig:([A-Za-z0-9+/=]+)\*\/[\s\S]*?"ContextUsagePopover"\);/;
/** 只匹配标记本身（测试 / 检查器用来剥掉标记后与模板比对）。 */
const POPOVER_CARRY_MARK_RE = /\/\*a2k-orig:[A-Za-z0-9+/=]+\*\//g;

/**
 * 标记式还原：解码 a2k-orig 携带的出厂原文，守卫通过（以 `function <fn>(t){` 开头、以 `"ContextUsagePopover");` 结尾、
 * 长度 < 12000）才整段替换。守卫不过则原地不动，留给旧路径。
 */
function restoreCarriedPopover(content: string): string {
  let out = content;
  for (let guard = 0; guard < 8; guard++) {
    const m = POPOVER_CARRY_RE.exec(out);
    if (!m) break;
    const decoded = Buffer.from(m[2], "base64").toString("utf8");
    const valid = decoded.startsWith(`function ${m[1]}(t){`) && decoded.endsWith('"ContextUsagePopover");') && decoded.length < 12000;
    if (!valid) break;
    out = out.slice(0, m.index) + decoded + out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * 锚点式还原：把 [startAnchor … endAnchor]（含两端）整段替换为 replacement。
 *
 * 为什么不只做「当前 PATCHED_* → ORIG_*」的精确替换：补丁字串每改一版（换 SVG、加分支），
 * 旧版本打进 Kiro 文件里的补丁就再也匹配不上，停用时永远还原不了——2026-09-06 实拍的
 * Kiro 1.0.411 里 mermaid 选项行正是一份旧版 PATCHED_JS_CODE 孤儿。起止锚点选所有历史变体
 * 都共有、而出厂文件里绝不出现的片段（a2k- / __kiroModelConfigProvider 等），跨度超过
 * maxSpan 视为误命中不动。
 */
function replaceSpan(content: string, startAnchor: string, endAnchor: string, replacement: string, maxSpan: number): string {
  let out = content;
  for (let guard = 0; guard < 8; guard++) {
    const s = out.indexOf(startAnchor);
    if (s < 0) break;
    const e = out.indexOf(endAnchor, s + startAnchor.length);
    if (e < 0) break;
    const end = e + endAnchor.length;
    if (end - s > maxSpan) break;
    out = out.slice(0, s) + replacement + out.slice(end);
  }
  return out;
}

/**
 * 整块回填：找到 [startAnchor … endAnchor] 一段，只有当这一段带我们的标记（marker）且与出厂串不同时
 * 才用出厂串替换。标记守卫是为了 Kiro 升级后同名函数体变了、而我们从未打过补丁的情况——那时绝不能拿
 * 旧出厂串覆盖 Kiro 的新代码。
 */
function restoreMarkedSpan(content: string, startAnchor: string, endAnchor: string, marker: RegExp, replacement: string, maxSpan: number): string {
  const s = content.indexOf(startAnchor);
  if (s < 0) return content;
  const e = content.indexOf(endAnchor, s + startAnchor.length);
  if (e < 0) return content;
  const end = e + endAnchor.length;
  if (end - s > maxSpan) return content;
  const span = content.slice(s, end);
  if (span === replacement || !marker.test(span)) return content;
  return content.slice(0, s) + replacement + content.slice(end);
}

/** 无论哪个历史版本、哪套压缩名打的 setter 钩子，都还原为出厂 `function NAME(t){STORE=t}`。 */
function restoreBackendHook(content: string): string {
  return content.replace(BACKEND_PATCHED_RE, "function $1(t){$2=t}");
}

/** 在出厂内容上按结构锚点打后端钩子；找不到唯一锚点或名字与模板局部撞名则原样返回。 */
function applyBackendHook(content: string): string {
  const hook = findBackendHook(content);
  if (!hook) return content;
  const actual = [hook.fn, hook.store];
  if (namesCollide(PATCHED_QPE_PATTERN, BACKEND_CANON, actual)) return content;
  return content.slice(0, hook.start) + renderTemplate(PATCHED_QPE_PATTERN, BACKEND_CANON, actual) + content.slice(hook.end);
}

/** 后端钩子的写入计划（只读盘、不写）。文件不存在 / 不可读（非 Kiro 宿主）→ unavailable 且无文件。 */
async function planKiroAgentBackend(enabled: boolean): Promise<TargetPlan> {
  const file = kiroAgentBackendFile();
  let original: string;
  try {
    original = await fs.promises.readFile(file, "utf8");
  } catch {
    // 非 Kiro 宿主：没有文件可改，usageRetry 也不算漂移（不打漂移日志）。
    return { status: "unavailable", files: [], extras: { usageRetry: "unchanged" } };
  }
  await sweepStaleTmp(file);
  let content = restoreUsageHook(restoreCtxHostHook(restoreBackendHook(original)));
  if (enabled) {
    content = applyBackendHook(content);
    // 可选组的宿主钩子只在主钩子（通道 A）打上时才打：没有通道 A，聊天框改挡位也到不了 Kiro 的下一轮列表；
    // 主钩子漂移时文件一字不写，targets.backend 仍按老口径报 unavailable。
    if (/__kiroModelConfigProvider=t/.test(content)) content = applyCtxHostHook(content);
    // usage 重试钩子与通道 A 无关（A2），独立打；锚点漂移只跳过自己。
    content = applyUsageHook(content);
  }
  const mainHooked = /__kiroModelConfigProvider=t/.test(content);
  // targets.backend 不看 usage 段（FR-1.7）：只有主钩子 / ctx 宿主钩子的改动才算 applied / removed。
  const coreChanged = restoreUsageHook(content) !== restoreUsageHook(original);
  const usageBefore = original.includes(USAGE_START);
  const usageAfter = content.includes(USAGE_START);
  const status: TargetStatus = enabled ? (mainHooked ? (coreChanged ? "applied" : "unchanged") : "unavailable") : coreChanged ? "removed" : "unchanged";
  const extras = {
    ctxHost: ctxStatus(enabled, original.includes("__a2kSessionConfigOption"), content.includes("__a2kSessionConfigOption")),
    usageRetry: ctxStatus(enabled, usageBefore, usageAfter),
  };
  // 开启但结构锚点找不到、文件里也没有任何版本的钩子：Kiro 版本漂移，静默放行、不写文件（content === original）。
  if (content === original) return { status, files: [], extras };
  // 提交日志要与实际改动一致：只动了 usage 段 → 只报 usage；两者都动 → 合并；只动主钩子 / ctx → 沿用 TARGET_LOG。
  const usageLog = enabled ? "hooked kiroAgent usage-limits retry" : "restored kiroAgent usage-limits retry";
  const log = !coreChanged ? usageLog : usageBefore !== usageAfter ? `${status === "removed" ? TARGET_LOG.backend.off : TARGET_LOG.backend.on} + ${usageLog}` : undefined;
  return { status, files: [{ file, original, next: content, ...(log ? { log } : {}) }], extras };
}

/**
 * Kiro 后端 `modelConfigProvider`（1.0.411 压缩名 Wid）经 setter 钩子挂到 globalThis 后的形状。
 * `refreshWithOutcome({signal,force=false,trigger="explicit"})`：inflight 时等待；`!force && isCacheFresh()`（TTL 5 分钟）
 * 返回 `{kind:"cached"}`；否则重拉，成功后无条件 `notifyListeners()` → modelRegistryManager.refreshAll →
 * 每个会话 `config_option_update` → 前端 `useSessionConfig` 重渲染。setter 之后还会被 Proxy 重设，Proxy 对函数做了 bind，
 * 拿到 Proxy 也能调。`refresh` 是旧入口，只当没有 `refreshWithOutcome` 时退回。
 */
type KiroRefreshOutcome = { kind?: string; models?: unknown };
type KiroModelConfigProvider = {
  refreshWithOutcome?: (opts?: { signal?: AbortSignal; force?: boolean; trigger?: string }) => Promise<KiroRefreshOutcome | undefined>;
  refresh?: (opts?: { force?: boolean }) => Promise<unknown>;
};

function outcomeModelCount(outcome: KiroRefreshOutcome | undefined): string {
  const m = outcome?.models;
  if (Array.isArray(m)) return String(m.length);
  if (typeof m === "number") return String(m);
  return "?";
}

/**
 * 方案 1（通道 A）：在模型增删改后，直接唤醒 Kiro 活跃模型注册中心强刷。
 *
 * 钩子只有在本扩展与 kiro-agent 跑在同一个扩展宿主里才读得到——Kiro 工作台把 `kiro.kiroagent` 隔离到独立宿主，
 * 本扩展靠 package.json `extensionDependencies: ["kiro.kiroAgent"]` 被并进同一组（4.13.45）。钩子不在时返回 false，
 * 调用方据此退回「提示重载窗口」。
 */
export async function triggerKiroModelRefresh(): Promise<boolean> {
  const provider = (globalThis as unknown as { __kiroModelConfigProvider?: KiroModelConfigProvider }).__kiroModelConfigProvider;
  const hasOutcome = !!provider && typeof provider.refreshWithOutcome === "function";
  const hasRefresh = !!provider && typeof provider.refresh === "function";
  if (!hasOutcome && !hasRefresh) {
    info("Channel A: 通道 A 钩子不可达（未并组或未打补丁）——globalThis.__kiroModelConfigProvider 缺失或没有 refresh 方法");
    return false;
  }
  try {
    if (hasOutcome) {
      const outcome = await provider!.refreshWithOutcome!({ force: true, trigger: "explicit" });
      const kind = typeof outcome?.kind === "string" ? outcome.kind : "unknown";
      const models = outcomeModelCount(outcome);
      if (kind === "failed" || kind === "aborted") {
        warn(`Channel A: refreshWithOutcome({force:true}) kind=${kind} models=${models}; falling back to reload prompt`);
        return false;
      }
      info(`Channel A: refreshWithOutcome({force:true,trigger:"explicit"}) kind=${kind} models=${models}`);
      return true;
    }
    await provider!.refresh!({ force: true });
    info("Channel A: refresh({force:true}) succeeded (provider has no refreshWithOutcome)");
    return true;
  } catch (e) {
    warn("Channel A: refresh threw:", e);
    return false;
  }
}

// ============================================================================
// 上下文挡位（4.13.55，R24 目标 A6）：聊天框 EffortSelector 旁的 <select> + kiro-agent setSessionConfigOption 宿主转发钩子。
// 两处都是「加法」：插入段用 /*a2k-ctx:start*/…/*a2k-ctx:end*/ 定界（还原 = 删段），调用处包一层 Fragment（还原 = 正则拆包）。
// 作为可选组：任一锚点不命中只报 unavailable，不影响既有三处 + 弹层。
// ============================================================================

const CTX_START = "/*a2k-ctx:start*/";
const CTX_END = "/*a2k-ctx:end*/";
/** 注入到 mermaid 的组件函数名——出厂 bundle 里绝不出现，同时也是还原 / 测试 / 检查器的标记。 */
const CTX_SEL_FN = "a2kCtxSel";
/** 定界段（函数体 / 宿主钩子）；超过 maxSpan 视为误命中不删。 */
const CTX_SEGMENT_RE = /\/\*a2k-ctx:start\*\/[\s\S]*?\/\*a2k-ctx:end\*\//g;
const CTX_SEGMENT_MAX = 12000;

/**
 * A2kContextSelector：EffortSelector 右侧（1.2 起 ModelSelector 触发器右侧）的「上下文」下拉。规范名 `b`（jsx 运行时）、`l0`（useSessionConfig）；函数名固定 a2kCtxSel。
 * 数据全部来自 Kiro 自己的 useSessionConfig：category==="model" 的 select 里当前选项的 description（CPS 私有微格式
 * `__A2K_MDL__|推理|图片|窗口|挡位表|末行`，第 5 位 = `候选,候选,…~来源~已知~解析值`）。不足 6 位（本扩展未运行 / 旧版 CPS /
 * Kiro 官方列表）→ 返回 null，聊天框与出厂一致。选中项变化 → `setter("a2k:ctx","<modelId>|<tokens>")`：webview 现成的
 * setSessionConfigOption 载体，宿主 zas 入口钩子转发到本扩展，agent 对未知 configId 无副作用（见 research §1.4）。
 * <select> 不受控（defaultValue + key=模型:窗口）：用户选完立刻显示所选，通道 A 推回新列表后 key 变化重挂到真实生效值。
 * 选项分两个 optgroup：「auto (解析来源)」只含解析值（选它 = 清除覆盖）、「manual」含其余挡位——显示文案只有数字，不占聊天栏宽度。
 * 模板里不能出现独立单词 a / b / l0 之外的规范名用法（renderTemplate 按标识符边界替换，字符串里的单词也会被换）。
 *
 * ⚠️ **我们自己声明的每个标识符（含内部对象的键与所有属性访问）都必须带 `a2k` 前缀。**
 * namesCollide 的判据是：真机压缩名若与模板里任一**代码标识符**同名 → 整条补丁被拒（防遮蔽 / TDZ）。
 * 本模板原先用 `t / q / z / F / v / p / c / f / k / K` 这类短名，而 `kiro-ui-session-details`
 * 的 jsx 运行时压缩名恰好是 `k`（撞上格式化器里的 `const k`）→ 该视图的补丁恒被拒，
 * **聊天框「上下文」下拉整体不注入**（2026-09-23 用户实测：选不了上下文容量；agent-chat 的
 * jsx 运行时是 `b`，没有撞上，所以只有那一个视图有下拉）。压缩器只产出 a–z / A–Z / aa… 形态的名字，
 * 绝不会产出 `a2k*`，所以前缀化之后这个模板只剩外部 API / 属性名在 others 里，
 * 只有「真机把 jsx 运行时或 useSessionConfig 压成 `disabled` / `children` 这种既有属性名」
 * 这类理论情况才可能再撞。改名同名同改，语义与产物（DOM 结构、文案、行为）逐字等价。
 */
const CTX_SEL_FN_TEMPLATE =
  'function a2kCtxSel({disabled:a2kDisabled=!1}={}){const[a2kCfg,a2kSetCfg]=l0();const a2kRow=(()=>{try{const a2kModel=(a2kCfg||[]).find(a2kZ=>a2kZ&&a2kZ.category==="model");if(!a2kModel||a2kModel.type!=="select")return null;const a2kOpts=(a2kModel.options||[]).flatMap(a2kV=>a2kV&&Array.isArray(a2kV.options)?a2kV.options:[a2kV]);const a2kSel=a2kOpts.find(a2kV=>a2kV&&a2kV.value===a2kModel.currentValue);const a2kParts=typeof a2kSel?.description==="string"?a2kSel.description.split("|"):null;if(!a2kParts||a2kParts[0]!=="__A2K_MDL__"||a2kParts.length<6)return null;const a2kBits=String(a2kParts[4]).split("~");const a2kCand=String(a2kBits[0]||"").split(",").map(Number).filter(a2kV=>Number.isFinite(a2kV)&&a2kV>0);if(!a2kCand.length)return null;const a2kWin=Number(a2kParts[3]);return{a2kId:String(a2kModel.currentValue),a2kWin:a2kWin>0?a2kWin:a2kCand[a2kCand.length-1],a2kCand,a2kSrc:a2kBits[1]||"default",a2kKnown:a2kBits[2]==="1",a2kRes:Number(a2kBits[3])||0,a2kRsrc:a2kBits[4]||"default"}}catch(a2kErr){return null}})();if(!a2kRow)return null;const a2kFmt=a2kV=>{if(!(a2kV>0))return"?";const a2kFixed=(a2kNum,a2kSuffix)=>(Number.isInteger(a2kNum)?String(a2kNum):a2kNum.toFixed(1))+a2kSuffix;if(a2kV%1000!==0&&a2kV%1024===0){const a2kUnit=a2kV/1024;return a2kUnit>=1024?a2kFixed(a2kUnit/1024,"M"):a2kFixed(a2kUnit,"K")}const a2kUnit=a2kV/1000;return a2kUnit>=1000?a2kFixed(a2kUnit/1000,"M"):a2kFixed(a2kUnit,"K")};const a2kSrcLabels={override:"your override",upstream:"upstream /models",vendor:"vendor catalog",codex:"Codex subscription catalog",catalog:"models.dev",default:a2kRow.a2kKnown?"default":"unknown, default"};const a2kTip="Context window: "+a2kFmt(a2kRow.a2kWin)+" tokens ("+(a2kSrcLabels[a2kRow.a2kSrc]||a2kRow.a2kSrc)+"). Kiro summarizes at 80% and truncates at 95% of it. Choose smaller if the upstream rejects long inputs; the auto group follows the catalog again.";const a2kOpt=a2kV=>b.jsx("option",{value:String(a2kV),children:a2kFmt(a2kV)},a2kV);const a2kHasAuto=a2kRow.a2kCand.includes(a2kRow.a2kRes);const a2kList=a2kHasAuto?[b.jsx("optgroup",{label:"auto ("+(a2kSrcLabels[a2kRow.a2kRsrc]||a2kRow.a2kRsrc)+")",children:a2kOpt(a2kRow.a2kRes)},"auto"),b.jsxs("optgroup",{label:"manual",children:a2kRow.a2kCand.filter(a2kV=>a2kV!==a2kRow.a2kRes).map(a2kOpt)},"manual")]:a2kRow.a2kCand.map(a2kOpt);return b.jsxs("span",{className:"a2k-ctx-wrap",title:a2kTip,children:[b.jsx("span",{className:"a2k-ctx-label",children:"Ctx"}),b.jsxs("select",{className:"a2k-ctx-select",disabled:a2kDisabled,defaultValue:String(a2kRow.a2kWin),"aria-label":"Context window",onChange:a2kEv=>{const a2kV=Number(a2kEv.target.value);a2kV>0&&a2kV!==a2kRow.a2kWin&&a2kSetCfg("a2k:ctx",a2kRow.a2kId+"|"+a2kV)},children:a2kList},a2kRow.a2kId+":"+a2kRow.a2kWin)]})}';
const CTX_SEL_CANON = ["b", "l0"];

/**
 * EffortSelector 调用处（chat-input-bottom-row-left 里唯一一处 `<b>.jsx(<EffortSelector>,{disabled:<v>})`）：
 * 出厂 → 包一层 Fragment 同时渲染 A2kContextSelector。规范名 `b`（jsx 运行时）、`a0e`（EffortSelector，1.0.437 压缩名；
 * 1.0.411 为 e0e）、`M`（disabled 变量）。React Compiler 的 memo 槽只缓存这个元素，子组件仍按自己的 hook 状态重渲染。
 * 1.2 起 EffortSelector 被删，`a0e` 位置换成 ModelSelector（同一调用形状，见 CTX_MODEL_SELECTOR_TAG_RE），模板与还原正则照用。
 */
const CTX_CALL_ORIG_TEMPLATE = "b.jsx(a0e,{disabled:M})";
const CTX_CALL_PATCHED_TEMPLATE = "b.jsxs(b.Fragment,{children:[b.jsx(a0e,{disabled:M}),b.jsx(a2kCtxSel,{disabled:M})]})";
const CTX_CALL_CANON = ["b", "a0e", "M"];
/** 任何压缩名下的补丁调用处 → 出厂：`<b>.jsxs(<b>.Fragment,{children:[<b>.jsx(<fn>,{disabled:<v>}),<b>.jsx(a2kCtxSel,{disabled:<v>})]})` → 第 2 组。 */
const CTX_CALL_RESTORE_RE =
  /(?<![\w$])([A-Za-z_$][\w$]*)\.jsxs\(\1\.Fragment,\{children:\[(\1\.jsx\([A-Za-z_$][\w$]*,\{disabled:([A-Za-z_$][\w$]*)\}\)),\1\.jsx\(a2kCtxSel,\{disabled:\3\}\)\]\}\)/g;
/** `<tagger>(<fn>,"EffortSelector");`——Kiro 给组件打的 displayName 标签，全文恰好一处。函数插在标签之后。 */
const CTX_EFFORT_TAG_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),"EffortSelector"\);/g;
/**
 * 1.2 起的回退锚点（4.13.64）：Kiro 1.2.56 删掉了 EffortSelector 组件（Effort 挪进模型面板），
 * 「上下文」下拉改挂在 ModelSelector 触发器右边。调用处形状不变：`<jsx>.jsx(<ModelSelector>,{disabled:<v>})`，
 * 在 chat-input-bottom-row-left 里全文唯一（实测 agent-chat `b.jsx(rve,{disabled:ue})`、session-details `x.jsx(jje,{disabled:de})`）。
 * 只在 EffortSelector 标签 0 命中时启用，1.1.x 行为逐字不变。
 */
const CTX_MODEL_SELECTOR_TAG_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),"ModelSelector"\);/g;

/**
 * 宿主 `setSessionConfigOption` 入口（1.0.437 压缩名 zas；1.0.411 为 fas）：`async function <fn>(<sessionId>,<configId>,<value>){`
 * 体内唯一字面量 `executeCommand("kiro.agentModels.setLastSelectedModel",{modelId:<value>})`，其后有 `.setSessionConfigOption(`。
 * 钩子插在 `{` 之后：configId 以 `a2k:` 开头时先交给 globalThis.__a2kSessionConfigOption(configId, value, sessionId)
 * （本扩展 extension.ts 登记；同宿主共享 globalThis），然后照旧落到 agent。规范名 `t` / `e` / `r` = 三个参数。
 */
const CTX_HOST_HOOK_TEMPLATE =
  '/*a2k-ctx:start*/try{typeof e=="string"&&e.startsWith("a2k:")&&typeof globalThis.__a2kSessionConfigOption=="function"&&globalThis.__a2kSessionConfigOption(e,r,t)}catch(_){}/*a2k-ctx:end*/';
const CTX_HOST_CANON = ["t", "e", "r"];
const CTX_HOST_LITERAL = 'executeCommand("kiro.agentModels.setLastSelectedModel",{modelId:';
const CTX_HOST_HEAD_RE = /^async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/;

type EffortSelectorHit = { fn: string; tagger: string; tagEnd: number };
type EffortCallHit = { start: number; end: number; text: string; jsx: string; disabled: string };
type HostFnHit = { fn: string; params: [string, string, string]; bodyStart: number };

/**
 * 「上下文」下拉的挂载组件名 + 标签结束位置；标签必须全文恰好一处。
 * 先找 EffortSelector（1.0.x / 1.1.x）；**只有它 0 命中时**才回退到 ModelSelector（1.2 起，见 CTX_MODEL_SELECTOR_TAG_RE）。
 * EffortSelector 多命中仍返回 null（有歧义，宁可不打），不回退。
 */
function findEffortSelector(content: string): EffortSelectorHit | null {
  let hits = [...content.matchAll(CTX_EFFORT_TAG_RE)];
  if (hits.length === 0) hits = [...content.matchAll(CTX_MODEL_SELECTOR_TAG_RE)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  return { fn: m[2], tagger: m[1], tagEnd: (m.index as number) + m[0].length };
}

/**
 * EffortSelector 的调用处：结构正则 `<jsx>.jsx(<fn>,{disabled:<v>})`，捕获 jsx 运行时名与 disabled 变量名。
 * JSX 自身的标识符（jsx 运行时 / disabled 变量）会被压缩，所以不能写成逐字串；
 * 但标签 `a(<fn>,"EffortSelector")` 里的 `<fn>` 是已知的（由 findEffortSelector 读出）。
 * 要求恰好一处命中——同一组件在别处复用会得到多个候选，这时宁可不打。
 */
function findEffortSelectorCall(content: string, fn: string): EffortCallHit | null {
  const re = new RegExp(`(?<![\\w$])(${IDENT_SRC})\\.jsx\\(${escapeRe(fn)},\\{disabled:(${IDENT_SRC})\\}\\)`, "g");
  const hits = [...content.matchAll(re)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  const start = m.index as number;
  return { start, end: start + m[0].length, text: m[0], jsx: m[1], disabled: m[2] };
}

/**
 * 宿主 setSessionConfigOption 函数：字面量唯一 → 向前找最近的 `async function <fn>(a,b,c){` 头（800 字符内、中间无嵌套 function），
 * 字面量后紧跟 `<value 参数>})`，900 字符内出现 `.setSessionConfigOption(`。
 */
function findHostConfigOptionFn(content: string): HostFnHit | null {
  const i = content.indexOf(CTX_HOST_LITERAL);
  if (i < 0 || content.indexOf(CTX_HOST_LITERAL, i + 1) >= 0) return null;
  const headStart = content.lastIndexOf("async function ", i);
  if (headStart < 0 || i - headStart > 800) return null;
  const head = CTX_HOST_HEAD_RE.exec(content.slice(headStart, Math.min(i, headStart + 160)));
  if (!head) return null;
  const bodyStart = headStart + head[0].length;
  if (/(?<![\w$])function(?![\w$])/.test(content.slice(bodyStart, i))) return null;
  if (!content.startsWith(`${head[4]}})`, i + CTX_HOST_LITERAL.length)) return null;
  if (!content.slice(i, i + 900).includes(".setSessionConfigOption(")) return null;
  return { fn: head[1], params: [head[2], head[3], head[4]], bodyStart };
}

/** 删掉所有定界段（函数体 / 宿主钩子；任何版本打的都一样），超长段视为误命中不动。 */
function removeCtxSegments(content: string): string {
  if (!content.includes(CTX_START)) return content;
  return content.replace(CTX_SEGMENT_RE, (m) => (m.length <= CTX_SEGMENT_MAX ? "" : m));
}

/** mermaid：删定界函数段 + 调用处拆包（任何压缩名）。 */
function restoreCtxSelector(content: string): string {
  let out = removeCtxSegments(content);
  if (out.includes(CTX_SEL_FN)) out = out.replace(CTX_CALL_RESTORE_RE, (_m, _jsx, inner: string) => inner);
  return out;
}

/** 在出厂内容上打聊天框「上下文」下拉两处（组件函数 + 调用处）。三个锚点全部唯一命中且无撞名才打；否则 null（全有或全无）。 */
function applyCtxSelector(content: string): string | null {
  const sel = findEffortSelector(content);
  if (!sel) return null;
  const call = findEffortSelectorCall(content, sel.fn);
  if (!call) return null;
  const useSessionConfig = resolveTaggedName(content, "useSessionConfig");
  if (!useSessionConfig) return null;
  const fnActual = [call.jsx, useSessionConfig];
  const callActual = [call.jsx, sel.fn, call.disabled];
  if (namesCollide(CTX_SEL_FN_TEMPLATE, CTX_SEL_CANON, fnActual) || namesCollide(CTX_CALL_PATCHED_TEMPLATE, CTX_CALL_CANON, callActual)) return null;
  const fnText = CTX_START + renderTemplate(CTX_SEL_FN_TEMPLATE, CTX_SEL_CANON, fnActual) + CTX_END;
  const callText = renderTemplate(CTX_CALL_PATCHED_TEMPLATE, CTX_CALL_CANON, callActual);
  // 两段互不重叠（函数插在 EffortSelector 标签之后，调用处在聊天输入组件里）；从后往前拼
  const spans = [
    { start: sel.tagEnd, end: sel.tagEnd, text: fnText },
    { start: call.start, end: call.end, text: callText },
  ].sort((x, y) => y.start - x.start);
  let out = content;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** dist/extension.js：删定界钩子段。 */
function restoreCtxHostHook(content: string): string {
  return removeCtxSegments(content);
}

/** 在出厂内容上打宿主转发钩子；锚点不唯一或参数名与模板局部撞名则原样返回。 */
function applyCtxHostHook(content: string): string {
  const hit = findHostConfigOptionFn(content);
  if (!hit) return content;
  if (namesCollide(CTX_HOST_HOOK_TEMPLATE, CTX_HOST_CANON, hit.params)) return content;
  return content.slice(0, hit.bodyStart) + renderTemplate(CTX_HOST_HOOK_TEMPLATE, CTX_HOST_CANON, hit.params) + content.slice(hit.bodyStart);
}

/** 可选组一个靶点的状态：按「处理前 / 处理后是否带标记」推导（文件其它部分的改动不算在它头上）。 */
function ctxStatus(enabled: boolean, before: boolean, after: boolean): TargetStatus {
  if (enabled) return after ? (before ? "unchanged" : "applied") : "unavailable";
  return before ? "removed" : "unchanged";
}

// ============================================================================
// usage-limits 启动重试钩子（4.13.65，可选组 usageRetry）：kiro-agent 是本扩展的 extensionDependencies，比我们先激活，
// 它在激活期调用 `kiro.usageLimits.getUsageLimits`，打到上一次会话写进设置的 CPS 端点（127.0.0.1:19811）时我们还没绑端口，
// 得到 ECONNREFUSED，且它不重试，直接弹一条（5 分钟限频的）错误 toast。
// 钩子两处纯插入，用 /*a2k-usage:start*/…/*a2k-usage:end*/ 定界，还原 = 删段（与 ctx / row 同一套路，不用 a2k-orig）：
//   A. 把 `()=>u.send(d)` 包成 `()=>(重试函数)(()=>u.send(d))`：回环地址 ECONNREFUSED 时每 500ms 重发一次，预算 10s；
//      耗尽后在错误对象上打 `__a2kLocalRefused` 标记（打不上 = 保持原行为，照常弹 toast）。
//   B. catch 里 `…:(X.error(h),WEf(h))` 的 `:` 之后插 `f&&f.__a2kLocalRefused?X.warn(h):`，带标记的错误只记 warn、不弹 toast。
// 其余错误（非回环 ECONNREFUSED、HTTP 5xx 等）走原路径，行为逐字不变。
// 状态只通过 extras.usageRetry 上报，绝不改 targets.backend；锚点漂移只跳过自己，不影响其它钩子。
// ============================================================================

const USAGE_START = "/*a2k-usage:start*/";
const USAGE_END = "/*a2k-usage:end*/";
const USAGE_SEGMENT_RE = /\/\*a2k-usage:start\*\/[\s\S]*?\/\*a2k-usage:end\*\//g;
const USAGE_SEGMENT_MAX = 4000;
/** 处理函数注册串与错误文案串之间的最大距离（实测 588）。 */
const USAGE_HANDLER_SPAN = 1500;
const USAGE_REG = '"kiro.usageLimits.getUsageLimits",async';
const USAGE_LIT = "`Unable to fetch account usage data";

/**
 * 重试函数的源码（一个 `async a2kRun=>{…}` 表达式）。自己声明的标识符全带 `a2k` 前缀，只引用全局
 * （Date / setTimeout / Promise / Object / String），所以不需要 namesCollide。文本里不得出现星号加斜杠（定界注释会被提前截断）。
 */
function renderUsageRetry(delayMs = 500, budgetMs = 10000): string {
  return String.raw`async a2kRun=>{const a2kLocal=a2kE=>{if(!a2kE)return!1;const a2kM=String(a2kE.message||"");const a2kRefused=a2kE.code==="ECONNREFUSED"||/ECONNREFUSED/.test(a2kM);const a2kLoop=/^(?:127\.|::1$|::ffff:127\.|localhost$)/.test(String(a2kE.address||""))||/(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?):\d{1,5}/.test(a2kM);return a2kRefused&&a2kLoop};const a2kEnd=Date.now()+${budgetMs};for(;;){try{return await a2kRun()}catch(a2kE){if(!a2kLocal(a2kE))throw a2kE;if(Date.now()+${delayMs}>a2kEnd){try{Object.defineProperty(a2kE,"__a2kLocalRefused",{value:!0})}catch(a2kX){}throw a2kE}await new Promise(a2kR=>setTimeout(a2kR,${delayMs}))}}}`;
}

type UsageHookHit = {
  /** 插入点 A 的前缀 / 后缀位置（thunk 体 `u.send(d)` 的起止），插入点 B（catch 里 `:` 之后）。 */
  sendStart: number;
  sendEnd: number;
  catchAt: number;
  errVar: string;
  msgVar: string;
  logger: string;
};

function countOccurrences(content: string, needle: string): number {
  let n = 0;
  for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * 在**出厂（已还原）**内容里定位 usage-limits 处理函数的三个插入点；任一条件不满足返回 null（整个钩子跳过，不留半截改动）。
 * 全部结构锚定，压缩名一律捕获：见 02-design 的 Matching 六步。
 */
function findUsageHook(content: string): UsageHookHit | null {
  if (countOccurrences(content, USAGE_REG) !== 1) return null;
  if (countOccurrences(content, USAGE_LIT) !== 1) return null;
  const r = content.indexOf(USAGE_REG);
  const l = content.indexOf(USAGE_LIT);
  if (!(r < l && l - r <= USAGE_HANDLER_SPAN)) return null;

  // 3. 处理函数片段里恰好一处 `xW("GetUsageLimits",l,()=>u.send(d))`
  const handler = content.slice(r, l);
  const sends = [...handler.matchAll(new RegExp(`(?<![\\w$])(${IDENT_SRC})\\("GetUsageLimits",(${IDENT_SRC}),\\(\\)=>((${IDENT_SRC})\\.send\\((${IDENT_SRC})\\))\\)`, "g"))];
  if (sends.length !== 1) return null;
  const sm = sends[0];
  const sendEnd = r + (sm.index as number) + sm[0].length - 1; // 紧挨着收尾的 `)` 之前
  const sendStart = sendEnd - sm[3].length;
  // 3a. 置信度检查：命令变量确实是在本片段里 new 出来的 GetUsageLimitsCommand
  const cmd = escapeRe(sm[5]);
  if (!handler.includes("GetUsageLimitsCommand") || !new RegExp(`(?<![\\w$])${cmd}=new [\\w$.]*\\(`).test(handler)) return null;

  // 4. catch 头：`catch(f){let h=` 正好收在错误文案字面量前
  const head = new RegExp(`catch\\((${IDENT_SRC})\\)\\{let (${IDENT_SRC})=$`).exec(content.slice(Math.max(0, l - 80), l));
  if (!head) return null;
  const errVar = head[1];
  const msg = escapeRe(head[2]);

  // 5. 错误 / toast 分支：`?X.warn(h):(X.error(h),WEf(h))}` 恰好一处
  const tailRe = new RegExp(`\\?(${IDENT_SRC})\\.warn\\(${msg}\\):\\(\\1\\.error\\(${msg}\\),(${IDENT_SRC})\\(${msg}\\)\\)\\}`, "g");
  const tails = [...content.slice(l, l + 1200).matchAll(tailRe)];
  if (tails.length !== 1) return null;
  const tm = tails[0];
  const logger = tm[1];
  const toast = tm[2];
  const catchAt = l + (tm.index as number) + `?${logger}.warn(${head[2]}):`.length;

  // 6. toast 函数确实是限频 toast：`c(WEf,"showErrorToastRateLimited");` 全文恰好一处且函数名一致
  const tags = [...content.matchAll(new RegExp(`(?<![\\w$])(${IDENT_SRC})\\((${IDENT_SRC}),"showErrorToastRateLimited"\\);`, "g"))];
  if (tags.length !== 1 || tags[0][2] !== toast) return null;

  return { sendStart, sendEnd, catchAt, errVar, msgVar: head[2], logger };
}

/** 在出厂内容上打 usage 重试钩子；锚点不唯一 / 漂移则原样返回。 */
function applyUsageHook(content: string): string {
  const hit = findUsageHook(content);
  if (!hit) return content;
  const retry = renderUsageRetry();
  // 从高位往低位拼，前面的偏移不受影响：B → A 后缀 → A 前缀
  const branch = `${USAGE_START}${hit.errVar}&&${hit.errVar}.__a2kLocalRefused?${hit.logger}.warn(${hit.msgVar}):${USAGE_END}`;
  return (
    content.slice(0, hit.sendStart) +
    `${USAGE_START}(${retry})(()=>${USAGE_END}` +
    content.slice(hit.sendStart, hit.sendEnd) +
    `${USAGE_START})${USAGE_END}` +
    content.slice(hit.sendEnd, hit.catchAt) +
    branch +
    content.slice(hit.catchAt)
  );
}

/** 删掉所有 usage 定界段（还原为出厂）；单段超过 USAGE_SEGMENT_MAX 视为误命中不删。 */
function restoreUsageHook(content: string): string {
  if (!content.includes(USAGE_START)) return content;
  return content.replace(USAGE_SEGMENT_RE, (m) => (m.length <= USAGE_SEGMENT_MAX ? "" : m));
}

// ============================================================================
// 1.2 代模型面板（4.13.64，v2）：Kiro 1.2.56 把模型选择器整个重写成 ModelPanel / ModelOptionRow / useModelSelector
// （带搜索框、勾选列、Effort 滑条），1.1 代的选项行 / 菜单 / ref 三个锚点全部消失。v2 不改 React Compiler 的记忆化
// 组件体，只改它的 props：行组件函数头后插 `<p>=a2kRowFix(<p>);`（唯一的 hook `ne.c(47)` 调用次序不变），
// `a2kRowFix` 定义插在 `<h>(<Row>,"ModelOptionRow");` 之后，useModelSelector 的 writeModel 入口加一条守卫，
// 让分组标题（modelId 以 `a2k-group:` 开头，= src/modelStore.ts 的 GROUP_HEADER_PREFIX）选不中。
// 三处都是纯插入，用 /*a2k-row:start*/…/*a2k-row:end*/ 定界，还原 = 删段；三处全中才写（全有或全无）。
// 只认 displayName 标签、函数头、jsx 运行时名与唯一字面量 `},"writeModel")`，不依赖任何局部压缩名。
// ============================================================================

const ROW_START = "/*a2k-row:start*/";
const ROW_END = "/*a2k-row:end*/";
/** 注入到 mermaid 的 props 改写函数名——出厂 bundle 里绝不出现，同时也是「补丁已在位」的判定标记。 */
const ROW_FIX_FN = "a2kRowFix";
const ROW_SEGMENT_RE = /\/\*a2k-row:start\*\/[\s\S]*?\/\*a2k-row:end\*\//g;
const ROW_SEGMENT_MAX = 12000;
/** `<tagger>(<Row>,"ModelOptionRow");`——行组件的 displayName 标签，全文恰好一处。 */
const ROW_TAG_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),"ModelOptionRow"\);/g;
/** useModelSelector 里 writeModel 回调的尾巴（displayName 字面量），全文恰好一处。 */
const WRITE_MODEL_TAG = '},"writeModel")';
/** 函数头 → 标签的最大距离（1.2.56 实测约 2.3 KB）。 */
const ROW_FN_MAX_SPAN = 20000;
/** writeModel 回调头的回看窗口（实测 `a(At=>{At!==R&&(…)},"writeModel")` 约 120 字符）。 */
const WRITE_MODEL_WINDOW = 400;
const ROW_FIX_CANON = ["b"];
/**
 * 行 props 改写（规范名 `b` = jsx 运行时）。只认 description 以 `__A2K_` 开头的行，其余原样返回同一对象：
 * - `__A2K_GRP__|名称|数量|字母|图标id|图标base64`：itemProps 换成不可交互（aria-disabled、阻断点击），
 *   description 换成卡片头节点（沿用 1.1 的 .a2k-card-head / .a2k-logo / .a2k-title / .a2k-count / .a2k-chev 样式）；
 * - `__A2K_MDL__|推理|图片|…`：description 换成能力徽章节点，没有徽章就是 void 0（不再显示微格式）。
 * 自有标识符全部带 `a2k` 前缀（namesCollide 判据，见 CTX_SEL_FN_TEMPLATE 的说明）。
 * **不许出现正则字面量**：codeTokens 不识别正则，里面的引号会打乱分词；HTML 转义用 split/join。
 */
const ROW_FIX_TEMPLATE = `function a2kRowFix(a2kP){try{const a2kItem=a2kP&&a2kP.item,a2kOpt=a2kItem&&a2kItem.option,a2kD=a2kOpt&&a2kOpt.description;if(typeof a2kD!=="string"||!a2kD.startsWith("__A2K_"))return a2kP;const a2kEsc=a2kS=>String(a2kS==null?"":a2kS).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");const a2kParts=a2kD.split("|");if(a2kParts[0]==="__A2K_GRP__"){let a2kLogo="";try{if(a2kParts[5])a2kLogo='<span class="a2k-logo">'+atob(a2kParts[5])+"</span>"}catch(a2kE){}if(!a2kLogo)a2kLogo=a2kParts[4]==="openai"?'<span class="a2k-logo">${SVG_OPENAI}</span>':'<span class="a2k-logo">'+a2kEsc(a2kParts[3]||"P")+"</span>";return{...a2kP,isSelected:!1,isActive:!1,itemProps:{"aria-disabled":"true","data-a2k-grp":"1",onClick:a2kEv=>{a2kEv&&a2kEv.preventDefault&&a2kEv.preventDefault();a2kEv&&a2kEv.stopPropagation&&a2kEv.stopPropagation()}},item:{...a2kItem,option:{...a2kOpt,description:b.jsx("span",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:'<span class="a2k-chev">▼</span>'+a2kLogo+'<span class="a2k-title">'+a2kEsc(a2kParts[1])+'</span><span class="a2k-count">'+a2kEsc(a2kParts[2])+" ↑</span>"}})}}}}if(a2kParts[0]==="__A2K_MDL__"){const a2kCaps=(a2kParts[1]==="1"?'<span class="a2k-cap a2k-cap-reason" title="推理">${SVG_BRAIN}</span>':"")+(a2kParts[2]==="1"?'<span class="a2k-cap a2k-cap-vision" title="图片">${SVG_IMAGE}</span>':"");return{...a2kP,item:{...a2kItem,option:{...a2kOpt,description:a2kCaps?b.jsx("span",{className:"a2k-caps-box",dangerouslySetInnerHTML:{__html:a2kCaps}}):void 0}}}}return a2kP}catch(a2kErr){return a2kP}}`;
/** writeModel 守卫：分组标题的 modelId 前缀（与 src/modelStore.ts 的 GROUP_HEADER_PREFIX 一致；不 import，本模块只依赖 fs/path/vscode/log）。 */
const ROW_GUARD_PREFIX = "a2k-group:";

type ModelPanelRowHit = { fn: string; param: string; jsx: string; bodyStart: number; tagEnd: number; guardAt: number; guardParam: string };

/** 1.2 代模型面板的三处插入点；任一条件不满足返回 null。 */
function findModelPanelRow(content: string): ModelPanelRowHit | null {
  const tags = [...content.matchAll(ROW_TAG_RE)];
  if (tags.length !== 1) return null;
  const fn = tags[0][2];
  const tagAt = tags[0].index as number;
  const tagEnd = tagAt + tags[0][0].length;
  const heads = [...content.matchAll(new RegExp(`(?<![\\w$.])function ${escapeRe(fn)}\\((${IDENT_SRC})\\)\\{`, "g"))];
  if (heads.length !== 1) return null;
  const headAt = heads[0].index as number;
  if (headAt >= tagAt || tagAt - headAt > ROW_FN_MAX_SPAN) return null;
  const param = heads[0][1];
  const bodyStart = headAt + heads[0][0].length;
  const body = content.slice(bodyStart, tagAt);
  if (!body.includes('className:"chat-input-popup-option')) return null;
  const receivers = new Set([...body.matchAll(new RegExp(`(?<![\\w$.])(${IDENT_SRC})\\.jsxs?\\(`, "g"))].map((m) => m[1]));
  if (receivers.size !== 1) return null;
  const jsx = [...receivers][0];
  const w = content.indexOf(WRITE_MODEL_TAG);
  if (w < 0 || content.indexOf(WRITE_MODEL_TAG, w + 1) >= 0) return null;
  const winStart = Math.max(0, w - WRITE_MODEL_WINDOW);
  const guards = [...content.slice(winStart, w).matchAll(new RegExp(`(?<![\\w$.])${IDENT_SRC}\\((${IDENT_SRC})=>\\{`, "g"))];
  if (guards.length === 0) return null;
  const g = guards[guards.length - 1];
  const guardParam = g[1];
  const guardAt = winStart + (g.index as number) + g[0].length;
  if (!content.startsWith(`${guardParam}!==`, guardAt)) return null;
  return { fn, param, jsx, bodyStart, tagEnd, guardAt, guardParam };
}

/** writeModel 守卫段（逐字，由 applyModelPanelRow 写入；P22 用它断言）。 */
function modelPanelGuardText(g: string): string {
  return `${ROW_START}if(typeof ${g}==="string"&&${g}.startsWith("${ROW_GUARD_PREFIX}"))return;${ROW_END}`;
}

/** 在出厂内容上打 v2 三处；三处全中且无撞名才写，否则 null。 */
function applyModelPanelRow(content: string): string | null {
  const hit = findModelPanelRow(content);
  if (!hit) return null;
  if (namesCollide(ROW_FIX_TEMPLATE, ROW_FIX_CANON, [hit.jsx])) return null;
  const spans = [
    { at: hit.tagEnd, text: ROW_START + renderTemplate(ROW_FIX_TEMPLATE, ROW_FIX_CANON, [hit.jsx]) + ROW_END },
    { at: hit.bodyStart, text: `${ROW_START}${hit.param}=${ROW_FIX_FN}(${hit.param});${ROW_END}` },
    { at: hit.guardAt, text: modelPanelGuardText(hit.guardParam) },
  ].sort((x, y) => y.at - x.at);
  let out = content;
  for (const s of spans) out = out.slice(0, s.at) + s.text + out.slice(s.at);
  return out;
}

/** 删掉所有 v2 定界段（任何版本打的都一样），超长段视为误命中不动。 */
function restoreModelPanelRow(content: string): string {
  if (!content.includes(ROW_START)) return content;
  return content.replace(ROW_SEGMENT_RE, (m) => (m.length <= ROW_SEGMENT_MAX ? "" : m));
}

/** 选项行补丁各历史变体共有的尾巴：ORIG_JS_PATTERN 里 children: 之后原样保留的兜底分支。 */
const JS_OPTION_TAIL = ORIG_JS_PATTERN.slice(ORIG_JS_PATTERN.indexOf('b.jsxs("div",{className:"chat-input-popup-option-content"'));
/** 4.13.53 起标记门形态选项行的起始锚（出厂文件里绝不出现 `__A2K_GRP__`）。 */
const JS_OPTION_GATED_START = 'className:"chat-input-popup-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")';

/**
 * 结构式逆替换：在文本里结构匹配 `patched` 的形态（压缩名由真机渲染而来，所以必须结构匹配），
 * 再用命中段的映射把它渲染回 `original` 的形态——补丁里的压缩名（如 ref 回调形参 `N`）
 * 要跟着回到出厂形态（`O`），所以这里必须复用命中段的映射。
 *
 * 命中一处就地替换一处，直到不再命中；多份同样注入（历史重复追加）因此都能清掉。
 */
function restoreStructural(content: string, patched: string, original: string): string {
  let out = content;
  for (let guard = 0; guard < 8; guard++) {
    const spans = scanMasked(out, patched);
    if (spans.length === 0) break;
    let changed = false;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      const fixed = renderMatched(original, patched, span);
      if (fixed === null) continue;
      out = out.slice(0, span.start) + fixed + out.slice(span.end);
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 打补丁时写入的弹层函数（含尾部标签、含随身携带标记）的**规范形态**。
 * 标记是块注释、不含标识符，插在函数头之后；不把它算进来，函数体结构的
 * 「非标识符 token 逐一相同」判据就过不了。补丁里的压缩名由真机渲染而来，所以还要
 * 用同一次命中的映射把补丁模板渲染成真机形态，再拿它去匹配。
 */
/**
 * 打补丁时写进文件的弹层函数（含尾部标签）的**逐字形态**。
 *
 * 关键点：这里的几个名字都必须用**真机的实际名**，不能混进规范名 `Bde`——否则还原时
 * 结构匹配会把真机名再「映射」一次，把 `n2e` 又写回 `Bde`。
 * 随身携带标记由调用方传进来（它内嵌的是出厂原文，与压缩名无关）。
 */
function patchedPopoverWritten(origText: string, fn: string, warn: string, useSessionConfig: string, runtime: string, tagger: string): string {
  const body = renderTemplate(PATCHED_POPOVER_BODY, POPOVER_PATCH_CANON, [fn, warn, useSessionConfig, runtime]);
  const head = `function ${fn}(t){`;
  const withMarker = body.startsWith(head) ? head + carryMarker(origText) + body.slice(head.length) : body;
  return withMarker + popoverTagText(tagger, fn);
}

/** 弹层函数（函数体 + 尾部 displayName 标签）的出厂形态（用给定函数名 / 助手名书写）。 */
function popoverCanonicalWithTag(fn: string, tagger: string): string {
  return POPOVER_FACTORY_BODY_CANON + popoverTagText(tagger, fn);
}

/**
 * 弹层调用处的补丁特征：`<jsx>.jsx(<fn>,{…livePercentage:……},a2kUsage:<v>})`。
 * `a2kUsage` 的值兼容两种形态：老的裸标识符，以及新的 `typeof <id>==="undefined"?void 0:<id>`
 * （把 store 名被压缩器改掉的后果从「ReferenceError 崩掉弹层」降级为「退回原生三项视图」）。
 * 属性名与字面量都不可压缩，所以用结构正则（标识符通配）匹配即可，
 * 不需要预设任何压缩名——这正是它能覆盖任意 Kiro 版本的原因。
 * 前两组囊括除 `,a2kUsage:…` 之外的全部原文，替换时原样保留（真机压缩名不受影响）。
 */
const POPOVER_CALL_PATCHED_RE =
  /((?<![A-Za-z_$][\w$]*\.)[A-Za-z_$][\w$]*\.jsx\([A-Za-z_$][\w$]*,\{(?=[^{}]*livePercentage:)[^{}]*?),a2kUsage:(?:typeof [A-Za-z_$][\w$]*==="undefined"\?void 0:)?[A-Za-z_$][\w$]*\}\)/g;

/** 去掉弹层调用处多传的 `a2kUsage` 参数（逐字，不碰任何压缩名）。 */
function dropPopoverCallUsage(content: string): string {
  return content.replace(POPOVER_CALL_PATCHED_RE, "$1})");
}

/** 还原弹层函数：结构匹配补丁形态的逐字串，再渲染回出厂形态。多份重复注入循环清掉。 */
function restorePatchedPopover(content: string): string {
  let out = content;
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    // 先从补丁函数体（含尾部标签、不含携带标记）读出真机名
    const body = matchMasked(out, PATCHED_POPOVER_CODE);
    if (body) {
      const fn = body.map.get("Bde") ?? "Bde";
      const warn = body.map.get("Pde") ?? "Pde";
      const use = body.map.get("l0") ?? "l0";
      const runtime = body.map.get("re") ?? "re";
      // 助手名从同一次命中的映射读（规范模板尾标签里写着 `a`）；读不出就用贴着正文末尾锚定的读法兜底。
      const tagger = body.map.get("a") ?? readPopoverTagger(out, body.start + body.text.length - 1, fn);
      if (tagger) {
        // 用真机名 + 实际携带标记拼出「写进文件的那一串」去定位函数
        const writtenText = patchedPopoverWritten(body.text, fn, warn, use, runtime, tagger);
        const written = matchMasked(out, writtenText);
        if (written) {
          const fixed = renderMatched(popoverCanonicalWithTag(fn, tagger), writtenText, written);
          if (fixed !== null) {
            out = out.slice(0, written.start) + fixed + out.slice(written.end);
            changed = true;
          }
        }
      }
    }
    // 调用处：结构正则去掉 a2kUsage，逐字保留真机名
    const dropped = dropPopoverCallUsage(out);
    if (dropped !== out) {
      out = dropped;
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 把 mermaid 里所有 API4Kiro 注入（无论哪个版本打的）还原为出厂。
 * 先做当前版本的结构逆替换，再用锚点兜底历史变体；通道 B（onMouseDown 触发器）无条件清除。
 */
function restoreSelectorScript(content: string): string {
  let out = content;
  // 选中项居中滚动 ref：该写法是通用形态（`ref:a(X=>{arr.current[i]=X},"ref")` 在 bundle 里出现多处），
  // 必须限定在「选项行补丁之前这一段」窗口内。窗口基准要在**还原选项行之前**量取：
  // 选项行换回出厂形态后长度变短，PATCHED_JS_CODE 的起点会前移。
  const jsPatched = matchMasked(out, PATCHED_JS_CODE);
  if (jsPatched) {
    const refWinStart = Math.max(0, jsPatched.start - REF_SCOPE_CHARS);
    const refPatched = matchMasked(out.slice(refWinStart, jsPatched.start), PATCHED_REF_CODE);
    if (refPatched) {
      const refFixed = renderMatched(ORIG_REF_PATTERN, PATCHED_REF_CODE, refPatched);
      if (refFixed) {
        const at = refWinStart + refPatched.start;
        out = out.slice(0, at) + refFixed + out.slice(at + refPatched.text.length);
      }
    }
  }
  // 1. 选项行：a) 4.13.53 起的标记门形态（className 表达式以 __A2K_GRP__ 判定开头）；b) 4.13.52 及更早无条件带
  //    a2k-exclusive-model-option 的形态。两者都以出厂兜底分支尾巴收口。
  out = restoreStructural(out, PATCHED_JS_CODE, ORIG_JS_PATTERN);
  out = replaceSpan(out, JS_OPTION_GATED_START, JS_OPTION_TAIL, ORIG_JS_PATTERN, 20000);
  out = replaceSpan(out, 'className:"chat-input-popup-option a2k-exclusive-model-option"', JS_OPTION_TAIL, ORIG_JS_PATTERN, 20000);
  // 2. 菜单容器类名：a) 4.13.53 起 `"chat-input-popup-menu"+(r.some(…)?" a2k-model-selector-menu":"")`（任何以 `+(` 开头、
  //    到 `,style:d,role:"listbox"` 为止的表达式变体都回到出厂字面量）；b) 旧版逐字类名
  out = restoreStructural(out, PATCHED_MENU_CODE, ORIG_MENU_PATTERN);
  out = replaceSpan(out, 'className:"chat-input-popup-menu"+(', '),style:d,role:"listbox"', 'className:"chat-input-popup-menu",style:d,role:"listbox"', 400);
  out = out.replace(/className:"chat-input-popup-menu a2k-[^"]*"/g, 'className:"chat-input-popup-menu"');
  // 3. ref 的历史变体兜底（旧版补丁没有标记门，锚点不同）
  out = replaceSpan(out, "ref:a(O=>{m.current[x]=O;if(", '},"ref")', ORIG_REF_PATTERN, 2000);
  // 4. 通道 B 触发器：用户已关闭，任何残留一律清掉
  out = out.split(PATCHED_TRIGGER_CODE).join(ORIG_TRIGGER_PATTERN);
  out = replaceSpan(out, 'className:"model-selector-trigger",onMouseDown:', '"onMouseDown"),disabled:t||r.length===0', ORIG_TRIGGER_PATTERN, 2000);
  // 5. Context Usage 弹层，三条路径按序：
  //    a) 4.13.44 起：补丁函数随身携带 a2k-orig 出厂原文，解码回填——不依赖 Kiro 版本、函数名或本文件里的任何出厂串；
  //    b) 4.13.38–4.13.43 写进 1.0.411 文件的整函数替换（Bde，无携带标记）：精确逆替换；
  //    c) 4.13.36 及更早的函数内四处局部替换（cursor-* 类名）：按 Bde 函数首尾锚点整体回填出厂，只在函数体带
  //       a2k-cu / cursor- 标记时才动（Kiro 升级后的新函数体不碰）
  out = restoreCarriedPopover(out);
  out = restorePatchedPopover(out);
  out = restoreMarkedSpan(out, "function Bde(t){", 'a(Bde,"ContextUsagePopover");', /a2k-cu|cursor-context|cursor-legend-dot|cursor-row-left/, ORIG_POPOVER_PATTERN, 12000);
  // 6. 弹层调用处多传的 a2kUsage 属性：函数体与调用处已在 restorePatchedPopover 里一起处理，
  //    这里只兜底清理任何残留（旧版本可能只写了调用处）。
  out = out.replace(/,a2kUsage:(?:typeof [A-Za-z_$][\w$]*==="undefined"\?void 0:)?[A-Za-z_$][\w$]*\}\)/g, "})");
  // 7. 聊天框「上下文」下拉（4.13.55）：删定界函数段 + 调用处拆包
  out = restoreCtxSelector(out);
  // 8. 1.2 代模型面板（4.13.64）：删 a2k-row 定界段（函数头 / 标签后 / writeModel 三处）
  out = restoreModelPanelRow(out);
  return out;
}

/**
 * 在出厂内容上打 Context Usage 弹层两处（函数体 + 调用处传参）。三个条件全部成立才打：
 * 结构匹配唯一命中出厂函数（拿到实际的函数名 / 警告函数名）、以该函数名渲染的调用处唯一命中、
 * `a(名,"useSessionConfig")` 标签唯一反查到 hook 名。任一不成立返回 null（全有或全无）。
 */
function applyPopover(content: string): string | null {
  const fac = findPopoverFactory(content);
  if (!fac) return null;
  const useSessionConfig = resolveTaggedName(content, "useSessionConfig");
  if (!useSessionConfig) return null;
  // jsx 运行时名：模板（PATCHED_POPOVER_CODE）与**还原侧**（patchedPopoverWritten）都以规范名 `b`
  // 逐字落地，所以只有真机 jsx 名恰好是 `b` 时才允许改写。真机名从命中段的映射读出（
  // 结构匹配对所有标识符都建了 名字↔真机名 映射，含 `b`→`b` 这种同名项）。
  // 读不出、或读出来不是 `b`：直接跳过——宁可这个视图退回原生外观，也不能把 `b.jsx(...)`
  // 写进一个 jsx 运行时叫别的名字的 bundle（那会让弹层组件运行时直接抛错）。
  // 要支持任意 jsx 名，得把真机名一路穿到 restorePatchedPopover 的期望形态里，见
  // docs/ARCHITECTURE.md「已知限制」。
  if (fac.span.map.get("b") !== "b") return null;
  // 补丁模板直接按真机名字渲染（补丁自带局部名保持原样，避免与真机压缩名撞车）。
  // 模板渲染出来的函数名 / 警告函数名必须与结构匹配读出的名字一致，否则宁可不打。
  // 尾部 displayName 标签不参与模板改名：按真机助手名（fac.tagger）单独拼，见 popoverTagText。
  // React Compiler 运行时名（`re.c(30)` 的 `re`）必须取真机的命名空间名：写死规范名 `re` 会在 1.2.56 上
  // 落到另一个同名顶层函数上，运行时抛 `re.c is not a function`。读不出就不打（宁可退回原生弹层）。
  const compilerRuntime = fac.span.map.get("re");
  if (!compilerRuntime) return null;
  const patchedFnText = renderTemplate(PATCHED_POPOVER_BODY, POPOVER_PATCH_CANON, [fac.names.fn, fac.names.warn, useSessionConfig, compilerRuntime]) + popoverTagText(fac.tagger, fac.names.fn);
  const head = `function ${fac.names.fn}(t){`;
  if (!patchedFnText.startsWith(head)) return null;
  const patchedFn = head + carryMarker(fac.text) + patchedFnText.slice(head.length);
  // 调用处：结构匹配定位（用真机函数名书写的出厂形态）。补丁形态 = 命中的真机文本 + `,a2kUsage:<store>}`。
  // 不能拿 PATCHED_POPOVER_CALL_CODE 模板渲染：那串以 1.0.411 的局部名（`Y` / `E` / `I` / `R`…）书写，
  // 直接套上去会把真机自己的包装变量名写错（实测 1.1.14 是 `q=g&&`，模板写的是 `Y=g&&`）。
  //
  // store 名读不出来（见 POPOVER_STORE_NAME 的说明），所以写成 `typeof <store>==="undefined"?void 0:<store>`：
  // 名字被压缩器改掉时不再抛 ReferenceError，弹层退回「无 breakdown」的原生三项视图。
  // 旧形态（裸标识符）与新形态都由 POPOVER_CALL_PATCHED_RE 兜住，还原不受影响。
  const callSpan = matchMasked(content, renderTemplate(ORIG_POPOVER_CALL_PATTERN, ["Bde"], [fac.names.fn]));
  if (!callSpan) return null;
  if (!callSpan.text.endsWith("})")) return null;
  const store = POPOVER_STORE_NAME;
  const patchedCall = `${callSpan.text.slice(0, -2)},a2kUsage:typeof ${store}==="undefined"?void 0:${store}})`;
  // 两段互不重叠；从后往前拼，前一段的偏移不受影响
  const spans = [
    { start: fac.start, end: fac.end, text: patchedFn },
    { start: callSpan.start, end: callSpan.end, text: patchedCall },
  ].sort((a, b) => b.start - a.start);
  let out = content;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/**
 * 在出厂内容上打当前版本补丁。全有或全无：选择器三处（选项行 / 菜单容器 / 选中项居中）
 * 任一不命中就整个文件一字不写——只打菜单不打选项行，会得到一个被收窄成 270px 却仍是
 * 原生行的怪菜单，正是「半补丁」。Context Usage 弹层两处（函数体 + 调用处传参）同理：只换函数不传参，
 * 弹层拿不到 breakdown 会退回三项百分比，虽不崩但不是目标外观。通道 B 不打。
 *
 * 4.13.59 起三处选择器靶点改用结构匹配（见 scanMasked）：Kiro 重新压缩 webview bundle
 * 只会改标识符，规范模板除压缩名外逐字不变，因此不再依赖 1.0.411 / 1.0.437 的压缩名。
 * 4.13.64 起选择器分两代：1.1 代（applyOptionRowV1）不中时试 1.2 代模型面板（applyModelPanelRow），
 * 两代都不中才整个文件一字不写。
 */
function applySelectorScript(content: string): string {
  // 两代模型选择器（4.13.64）：先试 1.1 代（选项行 / 菜单 / ref），不中再试 1.2 代模型面板（v2）。
  // 两代锚点不会同时出现：1.1.x 上 v1 命中、行为与以前逐字一样；1.2.56 上 v1 0 命中。
  const rows = applyOptionRowV1(content) ?? applyModelPanelRow(content);
  if (rows === null) return content;
  const out = applyPopover(rows) ?? rows;
  // 可选组（4.13.55）：聊天框「上下文」下拉——锚点不命中就不打，不影响上面几处
  return applyCtxSelector(out) ?? out;
}

/** 1.1 代选项行 / 菜单容器 / 选中项居中三处（全有或全无）；任一不命中返回 null。 */
function applyOptionRowV1(content: string): string | null {
  // 选项行：结构匹配 → 用真机压缩名渲染补丁
  const jsSpan = matchMasked(content, ORIG_JS_PATTERN);
  if (!jsSpan) return null;
  const patchedJs = renderMatched(PATCHED_JS_CODE, ORIG_JS_PATTERN, jsSpan);
  if (!patchedJs) return null;
  // 菜单容器
  const menuSpan = matchMasked(content, ORIG_MENU_PATTERN);
  if (!menuSpan) return null;
  const patchedMenu = renderMatched(PATCHED_MENU_CODE, ORIG_MENU_PATTERN, menuSpan);
  if (!patchedMenu) return null;
  // 选中项居中滚动 ref：该写法是通用形态（bundle 里出现多处的
  // `ref:a(X=>{arr.current[i]=X},"ref")`），必须限定作用域。实测 1.1.14 里目标 ref
  // 紧挨在 `className:"chat-input-popup-option"` 之前约 40 字符，这里留 2000 字符窗口，
  // 并要求窗口内唯一命中，避免撞上上下文拾取器 / 智能体列表的同形 ref。
  const refWindowStart = Math.max(0, jsSpan.start - REF_SCOPE_CHARS);
  const refSpan = matchMasked(content.slice(refWindowStart, jsSpan.start), ORIG_REF_PATTERN);
  if (!refSpan) return null;
  const patchedRef = renderMatched(PATCHED_REF_CODE, ORIG_REF_PATTERN, refSpan);
  if (!patchedRef) return null;

  // 三处互不重叠；从后往前拼，前一段的偏移不受影响
  const spans = [
    { start: jsSpan.start, end: jsSpan.end, text: patchedJs },
    { start: menuSpan.start, end: menuSpan.end, text: patchedMenu },
    { start: refWindowStart + refSpan.start, end: refWindowStart + refSpan.end, text: patchedRef },
  ].sort((a, b) => b.start - a.start);
  let out = content;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/**
 * 「补丁已在位」的判定标记。
 *
 * **不能用 `content.includes(PATCHED_JS_CODE)`**：模板是以某一版 Kiro 的压缩名书写的，而真正写进
 * 真机的补丁是 renderMatched 用**真机压缩名**渲染出来的形态（1.1.14 把选项行 name 变量压成 `w`），
 * 规范模板永远不会逐字出现在文件里 → 判定恒为 false。
 *
 * 后果不只是「误报」：`unavailable` 会让 `syncGroupHeaderStyleUnlocked` 里的
 * `styleEnabled = enabled && selectorScript.status !== "unavailable"` 变成 false，
 * 于是 CARD_CSS 被当成「改外观却没有对应功能」的半补丁剥掉——模型卡片带着补丁却没样式，
 * 看起来就是一片没有样式的碎字符。而且每次重载都会重演一遍，永远无法自愈。
 *
 * 只认「类名 / 注入函数名」这类**字符串字面量**：压缩器一个字符都不动字面量，
 * 出厂文件也绝不含 `a2k-`（见 stripBlock 的注释）。
 */
const SELECTOR_PATCH_MARKS = ["a2k-model-name-box", "a2k-card-head", "a2k-exclusive-model-option", ROW_FIX_FN];

/**
 * mermaid-*.js 的写入计划（只读盘、不写）。
 *
 * `pkgs` 是**全部**承载模型选择器的 package（见 selectorPackages）——Kiro 1.1.14 起同一 chunk
 * 在 `kiro-ui-agent-chat` 与 `kiro-ui-session-details` 各有一份，逐份都要处理。
 * 一份都没有（目录不存在 / 不可读，或真机确实没有模型选择器靶点）→ unavailable 且无文件。
 */
async function planModelSelectorScript(enabled: boolean, pkgs: SelectorPackage[]): Promise<TargetPlan> {
  const files: FilePlan[] = [];
  const states: SelectorPkgState[] = [];
  let ctxBefore = false;
  try {
    for (const { pkg, chunk: p } of pkgs) {
      const original = await fs.promises.readFile(p, "utf8");
      await sweepStaleTmp(p);
      // 先归一到出厂，再按需打当前版本补丁：旧版本补丁孤儿会被顺手升级 / 清除，
      // 已是当前补丁的文件往返后逐字相同，不会产生无意义写入。
      let content = restoreSelectorScript(original);
      if (enabled) content = applySelectorScript(content);
      if (content !== original) files.push({ file: p, original, next: content });
      const patched = SELECTOR_PATCH_MARKS.some((t) => content.includes(t));
      states.push({ pkg, chunk: p, patched, ctx: content.includes(CTX_SEL_FN) });
      if (original.includes(CTX_SEL_FN)) ctxBefore = true;
    }
  } catch {
    return { status: "unavailable", files: [], packages: states };
  }
  const landed = states.filter((s) => s.patched).map((s) => s.pkg);
  const missed = states.filter((s) => !s.patched).map((s) => s.pkg);
  const ctxMissed = states.filter((s) => !s.ctx).map((s) => s.pkg);
  // 可选组的 ctx 状态也逐 package：全中才是 applied；一份不全中就是 unavailable，
  // 不能因为「有一个 package 成了」就报成功（该视图的聊天框没有下拉）。
  const ctxSelector: TargetStatus = enabled
    ? states.length > 0 && ctxMissed.length === 0
      ? "applied"
      : "unavailable"
    : ctxBefore
      ? "removed"
      : "unchanged";
  const extras = { ctxSelector };
  const base = { files, extras, packages: states };
  // 开启路径上「有承载 package 没打上」= 半套补丁：报 unavailable 并把落地的 / 没落地的 package 都点名，
  // 让调用方提示用户（不是目录权限问题）。CSS 由调用方按同一份 packages 逐份决定，工作良好的那份不被牵连。
  if (enabled && missed.length > 0) {
    return {
      ...base,
      status: "unavailable",
      detail:
        landed.length > 0
          ? `model selector patch landed in ${landed.join(", ")} but not in ${missed.join(", ")} — that view's factory structure differs in this Kiro build (not just minified names), so it keeps showing the raw model-list microformat`
          : `model selector targets not found in ${missed.length ? missed.join(", ") : "any carrier package"} — 选项行（1.1 形态）与模型面板行（1.2 形态 ModelOptionRow）均未命中; this Kiro build changed the factory structure (not just minified names)`,
    };
  }
  if (files.length > 0) return { ...base, status: enabled ? "applied" : "removed" };
  return { ...base, status: "unchanged" };
}

/**
 * 剥掉所有 API4Kiro 注入：标记块（含历史版本重复追加的多块）以及标记块之外的 a2k- 孤儿规则
 * （2026-09-06 实拍：某旧版本把 `.a2k-logo svg, .a2k-logo img {…}` 直接追加在标记块前面，
 * 只剥标记块永远清不掉）。Kiro 出厂 CSS 不含 a2k-。有改动时末尾归一为单个换行；
 * 出厂文件原样返回、一个字节不动。
 */
function stripBlock(css: string): string {
  let out = css;
  for (let guard = 0; guard < 16; guard++) {
    const s = out.indexOf(START);
    if (s < 0) break;
    const e = out.indexOf(END, s);
    const head = out.slice(0, s).replace(/\s+$/, "");
    const tail = e < 0 ? "" : out.slice(e + END.length).replace(/^\s+/, "");
    out = head + "\n" + tail;
  }
  out = stripStrayA2kRules(out);
  if (out !== css) out = out.replace(/\s+$/, "") + "\n";
  return out;
}

/**
 * 删除选择器里含 a2k- 的顶层规则（`selector { … }` 连同其后的一个换行）。
 * 用 indexOf 手工扫描而不用正则：600 KB 压缩 CSS 里 base64 字体段很长，正则会灾难性回溯。
 */
function stripStrayA2kRules(css: string): string {
  let out = css;
  let from = 0;
  for (let guard = 0; guard < 64; guard++) {
    const i = out.indexOf("a2k-", from);
    if (i < 0) break;
    const start = Math.max(out.lastIndexOf("}", i), out.lastIndexOf("\n", i)) + 1;
    const open = out.indexOf("{", i);
    const close = open < 0 ? -1 : out.indexOf("}", open);
    const selector = out.slice(start, i);
    const inSelectorPosition =
      open >= 0 && close >= 0 && !selector.includes("{") && !out.slice(i, open).includes("}");
    if (!inSelectorPosition) {
      from = i + 4;
      continue;
    }
    let end = close + 1;
    while (end < out.length && (out[end] === " " || out[end] === "\t")) end++;
    if (out[end] === "\r") end++;
    if (out[end] === "\n") end++;
    out = out.slice(0, start) + out.slice(end);
    from = start;
  }
  return out;
}

/**
 * style.css 的写入计划（只读盘、不写）。
 *
 * 每个承载模型选择器的 package 都有自己的 style.css，而 CSS 只能作用于**同一个 webview 文档**里的节点，
 * 所以 CARD_CSS 必须逐份落进各自的 style.css（4.13.60：session-details 那份漏掉时，卡片补丁虽然打上了，
 * 但样式规则不在该文档里，卡片依然是没样式的裸标记）。
 *
 * **逐份开关**（4.13.63）：`enabled` 由调用方按「这个 package 的 chunk 到底有没有拿到补丁」给出。
 * 这样一份失败不会牵连另一份（打上的那份保留卡片样式），失败的那份也不会留下
 * 「改了外观却没有对应功能」的半套 CSS。关闭路径一律 `enabled:false`（全剥）。
 *
 * 全部文件都不可读 → unavailable + `<code> <path>` detail（ENOENT 表示非 Kiro 宿主）。
 * 部分可读部分不可读 → 能写的照写，读失败进 detail 上浮。
 */
async function planStyleSheet(plans: Array<{ file: string; enabled: boolean }>): Promise<TargetPlan> {
  const files: FilePlan[] = [];
  const errors: string[] = [];
  let anyOn = false;
  for (const { file, enabled } of plans) {
    let current: string;
    try {
      current = await fs.promises.readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code || "";
      errors.push(`${code} ${file}`.trim());
      continue;
    }
    await sweepStaleTmp(file);
    const stripped = stripBlock(current);
    if (enabled) anyOn = true;
    const next = enabled ? `${stripped.replace(/\s+$/, "")}\n${CARD_CSS}\n` : stripped;
    if (next === current) continue;
    files.push({ file, original: current, next });
  }
  const detail = errors.join("; ");
  if (files.length > 0) return { status: anyOn ? "applied" : "removed", detail: detail || undefined, files };
  if (errors.length > 0) return { status: "unavailable", detail, files: [] };
  return { status: "unchanged", files: [] };
}

type TargetKey = "selectorScript" | "backend" | "style";
const COMMIT_ORDER: TargetKey[] = ["selectorScript", "backend", "style"];
const TARGET_LOG: Record<TargetKey, { on: string; off: string }> = {
  selectorScript: { on: "patched model selector script:", off: "restored model selector script:" },
  backend: { on: "hooked kiroAgent modelConfigProvider bridge", off: "restored kiroAgent modelConfigProvider bridge" },
  style: { on: "applied card model selector style:", off: "restored original Kiro style:" },
};

/**
 * 提交三处计划（4.13.53 起）。
 *
 * enabled=true：**全有或全无**。按 mermaid → extension.js → style.css 的顺序逐个 writeAtomic；任一份写失败，立刻停止，
 * 并把本轮已替换的文件用各自的 `original` 回滚，返回 unavailable + detail（含回滚结果）。CSS 排在最后，所以只在
 * 前两处都成功后才落盘——不再出现「补丁 JS 已写、CSS 未写」或「CSS 已写、JS 写失败」的半补丁窗口
 * （2026-09-07 4.13.46 事故的同一时序）。被中止 / 回滚的靶点报 unavailable（文件不在目标态），不报 applied。
 *
 * enabled=false：**尽力还原**，每份独立写、失败各自上报（`scripts/check-selector-patch.js` readonly 节与
 * `tests/selector` readonly-restore 锁定该语义）。用户明确要关闭时，能还原的先还原；写失败的那份带 detail 让调用方提示。
 * 4.13.53 起补丁 JS 自带标记门，CPS 一停、列表里没有 `__A2K_` 标记，残留的补丁 JS 渲染即出厂，这条路径不再产生可见半补丁。
 */
async function commitPlans(enabled: boolean, plans: Record<TargetKey, TargetPlan>): Promise<Record<TargetKey, TargetResult>> {
  const result: Record<TargetKey, TargetResult> = {
    selectorScript: { status: plans.selectorScript.status, detail: plans.selectorScript.detail },
    backend: { status: plans.backend.status, detail: plans.backend.detail },
    style: { status: plans.style.status, detail: plans.style.detail },
  };
  const written: FilePlan[] = [];
  for (const key of COMMIT_ORDER) {
    const plan = plans[key];
    const errors: string[] = [];
    for (const fp of plan.files) {
      try {
        await writeAtomic(fp.file, fp.next);
        written.push(fp);
        // 日志按**计划状态**判定，不按 enabled 参数：关闭卡片样式时 styleEnabled=false，
        // 计划是 removed（剥掉 CARD_CSS），若按 enabled=true 记成 "applied card model selector style"
        // 就是谎报——排查时会以为 CSS 在位，实际文件里一个 a2k 都没有（2026-09-15 实拍）。
        // 文件改动与靶点状态不一致时（backend 文件只动了 usage 钩子段）由 fp.log 给出准确文案。
        info(fp.log ?? (plan.status === "removed" ? TARGET_LOG[key].off : TARGET_LOG[key].on), fp.file);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        error(`${key} write failed:`, fp.file, msg);
        errors.push(`${path.basename(fp.file)}: ${msg}`);
        if (enabled) break;
      }
    }
    if (errors.length === 0) continue;
    result[key] = { status: "unavailable", detail: errors.join("; ") };
    if (!enabled) continue;
    // 全有或全无：回滚本轮已写的文件，其余未写的靶点标记为未落盘
    const rollbackErrors: string[] = [];
    for (const fp of written.reverse()) {
      try {
        await writeAtomic(fp.file, fp.original);
        info("rolled back after partial patch failure:", fp.file);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        error("ROLLBACK FAILED:", fp.file, msg);
        rollbackErrors.push(`rollback failed ${path.basename(fp.file)}: ${msg}`);
      }
    }
    for (const other of COMMIT_ORDER) {
      if (other === key || plans[other].files.length === 0) continue;
      result[other] = { status: "unavailable", detail: `not written (aborted: ${key} failed)` };
    }
    if (rollbackErrors.length > 0) result[key] = { status: "unavailable", detail: [result[key].detail, ...rollbackErrors].join("; ") };
    break;
  }
  return result;
}

// 三个文件都是「读-改-写」，并发调用（配置监听里 groupHeaderStyle 与 enabled 同时变化、
// deactivate 撞上未完成的 apply）会互相覆盖，这里串行化，保证最后一次调用的语义落地。
let syncChain: Promise<unknown> = Promise.resolve();

/**
 * 同步模型选择器的定制效果。
 * enabled=true: 挂载严格隔离的专属类名与卡片样式；
 * enabled=false: 彻底清除并 100% 还原为官方出厂文件。
 * 只由用户动作触发（开关代理 / 开关卡片样式 / 代理关闭状态下激活）；扩展宿主关闭（deactivate）不调用本函数——
 * 三份文件必须跨 Reload 留在磁盘上，同宿主里先于本扩展激活的 kiro-agent 才能加载到补丁版（见 extension.ts#deactivate）。
 */
export function syncGroupHeaderStyle(enabled: boolean): Promise<StyleSyncResult> {
  const run = syncChain.then(() => syncGroupHeaderStyleUnlocked(enabled));
  syncChain = run.catch(() => undefined);
  return run;
}

/** usage 重试钩子的漂移日志每个宿主只打一次（每次同步都会重算，不去重会刷屏）。 */
let usageDriftLogged = false;

/** kiro-proxy 补丁残留的标记字面量。实测三种形态都带这个前缀：
 * `/*kiroproxy-ctxwin-css:r1*​/`、`/*kiroproxy-ctxwin-ui:r2*​/`、`/*kiroproxy-toolcard:r1*​/`，
 * 以及它们注入的规则（`.kiroproxy-ctxwin-wrap` 等）。压缩器不动字面量，所以按它判定稳定。
 */
const KIRO_PROXY_MARK = "kiroproxy-";

/** kiro-proxy 自己留下的出厂备份名（`<文件名>.kiroproxy-bak-<版本>`），提示里给用户当恢复入口。 */
const KIRO_PROXY_BAK = ".kiroproxy-bak-";

/** 被前置闸挡下的整轮文案（宿主内提示与卸载脚本共用同一句约束）。 */
const KIRO_PROXY_DETAIL =
  "检测到 kiro-proxy 的补丁残留（kiroproxy-…）：为避免两套注入互相覆盖，本轮未写入带残留的那些 Kiro 文件。";

/**
 * 前置闸（4.13.65 引入，4.13.66 起**逐文件**判定）：打补丁前先读目标文件，把带 kiro-proxy 残留的挑出来。
 *
 * 为什么逐文件而不是整轮拒绝：两套补丁只有落在**同一个文件**里才会互相覆盖（双方都按自己的标记段
 * 找段落，别人写进去的字节会让自己的锚点错位）。目标文件之间没有交叉依赖——`selectorStyle.ts` 的三处
 * 补丁各自在一个文件内文本级增删（chunk 的选择器渲染、style.css 的 CARD_CSS、dist/extension.js 的钩子），
 * 都不读别的目标文件的内容。唯一的跨文件约束是**同一 package 内 chunk ↔ style.css 必须成对**
 * （chunk 拿到补丁才给那份 style.css 加 CARD_CSS，见 planStyleSheet 的逐份开关），
 * 这条约束由调用方按 package 过滤时一起保住。
 *
 * 所以：带残留的文件跳过（在结果里报告清单），其余干净文件照常打补丁。整轮拒绝的粒度比必要的粗——
 * 本机真实 Kiro 就是「agent-chat 的 chunk + style.css + extension.js 带残留、session-details 干净」，
 * 整轮拒绝会让用户完全用不上补丁，而逐文件至少能保住干净的那几份。
 *
 * 逐文件 try/catch：读不到（ENOENT / EACCES）视为「该文件无标记」，让后续 planX 照常报 unavailable +
 * `code path` detail——普通 VS Code 宿主不该被报成「检测到了 kiro-proxy」。
 */
async function preflightKiroProxy(files: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const file of [...new Set(files)]) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes(KIRO_PROXY_MARK)) {
      hits.push(file);
    }
  }
  return hits;
}

/** 被跳过的文件的短名（`extensions/` 之后的相对路径；拿不到相对路径就退回 basename）。 */
function shortTargetName(file: string): string {
  const base = path.join(vscode.env.appRoot, "extensions");
  const rel = path.relative(base, file);
  return rel && !rel.startsWith("..") ? rel : path.basename(file);
}

/** 被跳过的文件旁边有没有 kiro-proxy 自己留下的出厂备份（有则在提示里给出恢复指引）。 */
async function findKiroProxyBackups(files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of [...new Set(files.map((f) => path.dirname(f)))]) {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (n.includes(KIRO_PROXY_BAK)) {
        out.push(path.join(dir, n));
      }
    }
  }
  return out;
}

async function syncGroupHeaderStyleUnlocked(enabled: boolean): Promise<StyleSyncResult> {
  // 一次发现，两处复用：同一 chunk 在多个 package 各有一份，CSS 也要落进各自的 style.css。
  const pkgs = await selectorPackages();
  const backendFile = kiroAgentBackendFile();
  // 前置闸只在开补丁时跑：关闭路径不跑闸门，只删自己的标记段（别人注入的字节一个都不碰）。
  const allTargets = [...new Set([...pkgs.map((p) => p.chunk), ...pkgs.map((p) => p.style), backendFile])];
  const polluted = enabled ? await preflightKiroProxy(allTargets) : [];
  const pollutedSet = new Set(polluted);
  // 同一 package 的 chunk 与 style.css 必须成对（给一份 style.css 加 CARD_CSS 的前提是那份 chunk 拿到了补丁）：
  // 两者之一带残留 ⇒ 整个 package 一起跳过，不当「改了一半」的那一套。
  const blockedPkgFiles = new Set<string>();
  for (const p of pkgs) {
    if (pollutedSet.has(p.chunk) || pollutedSet.has(p.style)) {
      blockedPkgFiles.add(p.chunk);
      blockedPkgFiles.add(p.style);
    }
  }
  const skippedSet = new Set([...pollutedSet, ...blockedPkgFiles]);
  const skippedFiles = allTargets.filter((f) => skippedSet.has(f));
  const activePkgs = pkgs.filter((p) => !blockedPkgFiles.has(p.chunk));
  if (skippedFiles.length > 0) {
    const names = skippedFiles.map(shortTargetName);
    info(`selector patch sync: skipped ${names.length} file(s) with a kiro-proxy residue: ${names.join(", ")}`);
  }
  if (enabled && skippedFiles.length === allTargets.length) {
    // 全部目标文件都带残留：与 4.13.65 的整轮拒绝同义（一个字节都不写），沿用同一套状态与文案。
    const names = skippedFiles.map(shortTargetName);
    const backups = await findKiroProxyBackups(skippedFiles);
    info(`selector patch sync blocked by a kiro-proxy residue: ${KIRO_PROXY_DETAIL}`);
    return {
      status: "unavailable",
      blockedBy: "kiro-proxy",
      detail: `跳过 ${names.join("、")}（${KIRO_PROXY_DETAIL}）`,
      skippedBy: names,
      ...(backups.length > 0 ? { kiroProxyBackups: backups } : {}),
      targets: { style: "unavailable", selectorScript: "unavailable", backend: "unavailable" },
      extras: { ctxSelector: "unavailable", ctxHost: "unavailable", usageRetry: "unavailable" },
    };
  }
  const skippedChunks = activePkgs.length !== pkgs.length;
  const skippedStyles = pkgs.some((p) => skippedSet.has(p.style));
  const skippedBackend = skippedSet.has(backendFile);
  const selectorScript = await planModelSelectorScript(enabled, activePkgs);
  // 被跳过的后端文件**不读也不写**：这里不能走 planKiroAgentBackend(false)（那是还原路径，会删掉自己的段）。
  const backend: TargetPlan = skippedBackend
    ? { status: "unavailable", files: [], extras: { ctxHost: "unavailable", usageRetry: "unavailable" } }
    : await planKiroAgentBackend(enabled);
  // CSS 逐份决定：只给「本 package 的 chunk 确实拿到了补丁」的那些包加 CARD_CSS。
  // 否则就是「改了 IDE 外观却没有对应功能」的半补丁；反过来，一份靶点漂移也不该牵连
  // 另一份（打上的那份保留卡片样式）。关闭路径 / 靶点整体不命中 → patched 集合为空 → 全部剥掉。
  const patchedSet = new Set((selectorScript.packages ?? []).filter((s) => s.patched).map((s) => s.pkg));
  const style = await planStyleSheet(activePkgs.map((p) => ({ file: p.style, enabled: enabled && patchedSet.has(p.pkg) })));
  const committed = await commitPlans(enabled, { selectorScript, backend, style });

  const targets = {
    // 被跳过的文件一律报 unavailable（它不在目标态）；其余按计划推导的状态。
    style: skippedStyles ? "unavailable" : committed.style.status,
    selectorScript: skippedChunks ? "unavailable" : committed.selectorScript.status,
    backend: skippedBackend ? "unavailable" : committed.backend.status,
  };
  // 可选组（4.13.55）：所属文件本轮写失败 / 被全有或全无中止（unavailable 且带 detail）→ 也报 unavailable；否则按计划推导的状态。
  const extraOf = (plan: TargetPlan, res: TargetResult, key: ExtraKey, skipped: boolean): TargetStatus =>
    skipped || (res.status === "unavailable" && res.detail) ? "unavailable" : plan.extras?.[key] ?? "unavailable";
  const extras: SyncExtras = {
    ctxSelector: extraOf(selectorScript, committed.selectorScript, "ctxSelector", skippedChunks),
    ctxHost: extraOf(backend, committed.backend, "ctxHost", skippedBackend),
    usageRetry: extraOf(backend, committed.backend, "usageRetry", skippedBackend),
  };
  // usage 重试钩子是可选组：锚点漂移只在整个宿主里记一次 info（写失败另有 error 日志，这里不重复）。
  if (enabled && extras.usageRetry === "unavailable" && !committed.backend.detail && !usageDriftLogged) {
    usageDriftLogged = true;
    info("usage-limits retry hook (optional): unavailable — kiro-agent may still toast ECONNREFUSED on startup");
  }
  if (enabled && (extras.ctxSelector === "unavailable" || extras.ctxHost === "unavailable")) {
    const ctxMissing = (selectorScript.packages ?? []).filter((s) => !s.ctx).map((s) => s.pkg);
    info(
      `context selector targets (optional group): selector=${extras.ctxSelector} host=${extras.ctxHost}` +
        (ctxMissing.length > 0 ? ` — missing in: ${ctxMissing.join(", ")}` : "") +
        ` — chat-input context dropdown falls back to the panel there`
    );
  }
  // 任一 Kiro 文件「本应写入却写失败」都上浮为 unavailable 并带 detail：尤其是还原路径，
  // 否则 mermaid / extension.js 没还原成功却报 removed，调用方无从提示用户。
  const writeErrors = [committed.selectorScript.detail, committed.backend.detail].filter((d): d is string => !!d);
  let status: TargetStatus;
  let detail = committed.style.detail;
  if (committed.style.status === "unavailable") {
    status = "unavailable";
    detail = [committed.style.detail, ...writeErrors].filter(Boolean).join("; ") || undefined;
  } else if (writeErrors.length > 0) {
    status = "unavailable";
    detail = writeErrors.join("; ");
  } else if (enabled && committed.selectorScript.status === "unavailable") {
    // 4.13.59 起靶点定位不再依赖压缩名，所以走到这里只可能是 Kiro 真的改写了出厂结构
    // （不是「重新压缩」）。同时别再让用户去查目录权限：写失败会带 detail 走上一分支。
    status = "unavailable";
    detail =
      "model selector targets not found in mermaid-*.js (选项行（1.1 形态）与模型面板行（1.2 形态 ModelOptionRow）均未命中); this Kiro build changed the factory structure (not just minified names), so the patch was skipped and no style was applied";
  } else if (Object.values(targets).some((s) => s === "applied")) {
    status = "applied";
  } else if (Object.values(targets).some((s) => s === "removed")) {
    status = "removed";
  } else {
    status = "unchanged";
  }
  const out: StyleSyncResult = { status, targets, extras };
  // 有文件被前置闸跳过（部分跳过）：整轮报 unavailable + 一句可操作的中文说明，
  // 并带上跳过清单；调用方（extension.ts#notifyStyleSync）据此提示用户而不是当成成功。
  if (skippedFiles.length > 0) {
    const names = skippedFiles.map(shortTargetName);
    out.status = "unavailable";
    out.blockedBy = "kiro-proxy";
    out.skippedBy = names;
    const backups = await findKiroProxyBackups(skippedFiles);
    if (backups.length > 0) {
      out.kiroProxyBackups = backups;
    }
    out.detail = [`跳过 ${names.join(", ")}（${KIRO_PROXY_DETAIL}）`, detail].filter(Boolean).join(" ");
  } else if (detail) {
    out.detail = detail;
  }
  return out;
}

/** 仅供 tests/selector、scripts/check-selector-patch.js、probe-kiro.js 使用：暴露靶点模板、标记块与结构匹配器。 */
export const __selectorStyleInternals = {
  START,
  END,
  CARD_CSS,
  /** 「这个文件已带本扩展的补丁」的标记集合（4.13.65 起随 internals 暴露，供 verify 脚本断言还原干净）。 */
  SELECTOR_PATCH_MARKS,
  /** 结构匹配器：模板以 1.0.411 压缩名书写，名字按结构捕获 / 反查 / 渲染。 */
  matchers: {
    renderTemplate,
    namesCollide,
    /** 剥掉 CARD_CSS 标记块与 a2k- 孤儿规则，供 dev/verify-selector-patch.js 把 fixture 归一为出厂。 */
    stripBlock,
    /** 结构等价匹配（4.13.59）：不依赖任何压缩名的靶点定位 + 改名映射渲染。 */
    scanMasked,
    matchMasked,
    renderMatched,
    /** 还原管线入口，供 dev/verify-selector-patch.js 逐步观测中间产物。 */
    restoreStructural,
    restorePatchedPopover,
    restoreSelectorScript,
    /** 补丁管线入口（纯函数，不下盘），供验证脚本断言「命中 ⇒ 真的注入」。 */
    applySelectorScript,
    resolveTaggedName,
    findPopoverFactory,
    findPopoverCall,
    findBackendHook,
    carryMarker,
    restoreCarriedPopover,
    restoreBackendHook,
    POPOVER_CARRY_RE,
    POPOVER_CARRY_MARK_RE,
    BACKEND_HOOK_RE,
    BACKEND_PATCHED_RE,
    POPOVER_FACTORY_CANON,
    POPOVER_PATCH_CANON,
    BACKEND_CANON,
    /** 4.13.55 可选组：聊天框「上下文」下拉 + 宿主转发钩子 */
    findEffortSelector,
    findEffortSelectorCall,
    findHostConfigOptionFn,
    applyCtxSelector,
    restoreCtxSelector,
    applyCtxHostHook,
    restoreCtxHostHook,
    removeCtxSegments,
    CTX_START,
    CTX_END,
    CTX_SEL_FN,
    CTX_SEGMENT_RE,
    CTX_CALL_RESTORE_RE,
    CTX_EFFORT_TAG_RE,
    CTX_MODEL_SELECTOR_TAG_RE,
    CTX_HOST_LITERAL,
    CTX_SEL_CANON,
    CTX_CALL_CANON,
    CTX_HOST_CANON,
    /** 4.13.65 usage-limits 启动重试钩子（可选组 usageRetry） */
    findUsageHook,
    applyUsageHook,
    restoreUsageHook,
    renderUsageRetry,
    USAGE_START,
    USAGE_END,
    USAGE_SEGMENT_RE,
    /** 4.13.64 1.2 代模型面板（v2） */
    findModelPanelRow,
    applyModelPanelRow,
    restoreModelPanelRow,
    modelPanelGuardText,
    ROW_START,
    ROW_END,
    ROW_FIX_FN,
    ROW_SEGMENT_RE,
  },
  patterns: {
    ORIG_JS_PATTERN,
    PATCHED_JS_CODE,
    ORIG_MENU_PATTERN,
    PATCHED_MENU_CODE,
    ORIG_REF_PATTERN,
    PATCHED_REF_CODE,
    ORIG_TRIGGER_PATTERN,
    PATCHED_TRIGGER_CODE,
    ORIG_POPOVER_PATTERN,
    PATCHED_POPOVER_CODE,
    ORIG_POPOVER_CALL_PATTERN,
    PATCHED_POPOVER_CALL_CODE,
    ORIG_QPE_PATTERN,
    PATCHED_QPE_PATTERN,
    // 4.13.55 可选组（不以 ORIG_/PATCHED_ 命名：scripts/check-selector-patch.js 按该前缀自动配对逐字靶点，这组按结构定位）
    CTX_SEL_FN_TEMPLATE,
    CTX_CALL_ORIG_TEMPLATE,
    CTX_CALL_PATCHED_TEMPLATE,
    CTX_HOST_HOOK_TEMPLATE,
    ROW_FIX_TEMPLATE,
  },
  legacy: LEGACY_POPOVER_VARIANTS,
  legacySelector: LEGACY_SELECTOR_VARIANTS,
  paths: {
    /** 主 package（kiro-ui-agent-chat）的样式表；承载模型选择器的 package 可能不止一个，见 selectorPackages。 */
    styleFile,
    jsDir,
    kiroAgentBackendFile,
    /** 承载模型选择器的全部 package（chunk + 各自 style.css），供 dev/verify-selector-patch.js 断言。 */
    selectorPackages,
  },
};
