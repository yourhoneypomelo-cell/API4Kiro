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

export type StyleSyncResult = {
  status: TargetStatus;
  detail?: string;
  /** 三个靶点文件各自的结果：style.css / mermaid-*.js / kiro-agent dist/extension.js */
  targets: { style: TargetStatus; selectorScript: TargetStatus; backend: TargetStatus };
  /**
   * 可选组的结果（4.13.55）：靶点不命中只报 `unavailable`，不影响 `status` / `targets`——既有三处 + 弹层照常打；
   * 该文件本轮写失败时随所属靶点一起报 `unavailable`。
   */
  extras: CtxExtras;
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
 */
type FilePlan = { file: string; original: string; next: string };
/**
 * 一个靶点的计划：`status` 是「全部写成功后」应报的状态；`files` 是该靶点涉及的文件（mermaid 可能多份）；
 * `extras` 是该文件里可选组靶点（4.13.55）的状态。
 */
type TargetPlan = { status: TargetStatus; detail?: string; files: FilePlan[]; extras?: Partial<CtxExtras> };

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
 * 只有这三个名字变了（Bde→qde、Pde→Ude、z→j），其余 2361 字符逐字相同。定位用 templateRegex() 把三个规范名
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
  'function Bde(t){const e=re.c(30),[a2kCfg]=l0(),{livePercentage:n,conversationPct:r,mcpPct:s,steeringPct:i,hasBreakdown:o,warning:l,showWarning:u,style:c,floatingProps:d,summarizationThreshold:f,a2kUsage:A}=t,g=Math.ceil(n),y=n>=f-5;const[CW,A2K]=(()=>{try{const q=(a2kCfg||[]).find(z=>z&&z.category==="model");if(!q||q.type!=="select")return[0,false];const F=(q.options||[]).flatMap(v=>v&&Array.isArray(v.options)?v.options:[v]);const M=F.some(v=>typeof v?.description==="string"&&v.description.startsWith("__A2K_"));const z=F.find(v=>v&&v.value===q.currentValue);const p=typeof z?.description==="string"?z.description.split("|"):null;const w=p&&p[0]==="__A2K_MDL__"?Number(p[3]):0;return[w>0?w:0,M]}catch(_e){return[0,false]}})();const x=u&&l!=null&&b.jsxs("div",{className:"kiro-context-popover-warning",children:[b.jsx("div",{className:"kiro-context-popover-warning-header",children:b.jsx("span",{children:"High initial context usage"})}),b.jsx("div",{className:"kiro-context-popover-warning-message",children:Pde(l)})]});if(!A2K){const NH=Math.ceil(r),NP=Math.ceil(s),NM=Math.ceil(i);const NT=b.jsxs("div",{className:"kiro-context-popover-header",children:[b.jsx("span",{children:"Context Usage"}),b.jsx("span",{children:`${g}%`})]});const NR=b.jsxs("div",{className:"kiro-context-popover-breakdown-row",children:[b.jsx("span",{children:"Conversation"}),b.jsx("span",{children:`${NH}%`})]});const NO=o&&b.jsxs(b.Fragment,{children:[b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.mcpTools||void 0,children:[b.jsx("span",{children:"MCP tools"}),b.jsx("span",{children:`${NP}%`})]}),b.jsxs("div",{className:"kiro-context-popover-breakdown-row","data-high":l?.steering||void 0,children:[b.jsx("span",{children:"Steering files"}),b.jsx("span",{children:`${NM}%`})]})]});const NL=b.jsxs("div",{className:"kiro-context-popover-breakdown",children:[NR,NO]});const NI=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`});const NB=b.jsxs("div",{className:"kiro-context-popover-content",children:[NT,NL,NI]});return b.jsxs("div",{className:"kiro-context-popover",style:c,role:"tooltip",...d,children:[x,NB]})}const K=v=>{if(v>=1e6){const q=(v/1e6).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"M"}if(v>=1e3){const q=(v/1e3).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"K"}return String(Math.round(v))};const V=A&&A.breakdown,W=V&&V.tools||{},D=[["prompts","Your prompts",V&&V.yourPrompts],["responses","Kiro responses",V&&V.kiroResponses],["files","Session files",V&&V.sessionFiles],["builtin","Built-in tools",W.builtin],["mcp","MCP tools",W.mcp],["steering","Steering files",V&&V.contextFiles]].filter(q=>q[2]&&typeof q[2].percent=="number"&&typeof q[2].tokens=="number");const J=D.length>0,Q=J?D.map(q=>({k:q[0],n:q[1],p:q[2].percent,v:q[2].tokens,h:q[0]==="mcp"?l?.mcpTools:q[0]==="steering"?l?.steering:void 0})):[{k:"conv",n:"Conversation",p:r,v:0,h:void 0}].concat(o?[{k:"mcp",n:"MCP tools",p:s,v:0,h:l?.mcpTools},{k:"steering",n:"Steering files",p:i,v:0,h:l?.steering}]:[]);const G=J?Q.reduce((q,w)=>q+w.v,0):0;const T=b.jsxs(b.Fragment,{children:[b.jsx("div",{className:"a2k-cu-head",children:b.jsx("span",{className:"a2k-cu-title",children:"Context Usage"})}),b.jsxs("div",{className:"a2k-cu-sub",children:[b.jsx("span",{className:"a2k-cu-pct",children:`${g}% Full`}),CW>0?b.jsx("span",{className:"a2k-cu-tokens",title:"Total = real usage reported by the upstream (percentage x context window). Per-category counts below are a rough client-side estimate by Kiro and may not add up to the total.",children:`~${K(Math.round(n/100*CW))} / ${K(CW)} tokens`}):J&&b.jsx("span",{className:"a2k-cu-tokens",title:"Token counts are a rough client-side estimate by Kiro; the percentage comes from the real token usage reported by the upstream.",children:`~${K(G)} tokens est.`})]}),b.jsx("div",{className:"a2k-cu-bar",children:Q.map(q=>b.jsx("div",{className:"a2k-cu-seg a2k-cu-c-"+q.k,style:{width:`${Math.max(0,Math.min(100,q.p))}%`}},q.k))})]});const L=b.jsx("div",{className:"kiro-context-popover-breakdown a2k-cu-rows",children:Q.map(q=>b.jsxs("div",{className:"kiro-context-popover-breakdown-row a2k-cu-row","data-high":q.h||void 0,children:[b.jsxs("span",{className:"a2k-cu-left",children:[b.jsx("span",{className:"a2k-cu-sw a2k-cu-c-"+q.k}),b.jsx("span",{children:q.n})]}),b.jsx("span",{className:"a2k-cu-val",children:J?K(q.v):`${Math.ceil(q.p)}%`})]},q.k))});const I=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`});const B=b.jsxs("div",{className:"kiro-context-popover-content",children:[T,L,I]});return b.jsxs("div",{className:"kiro-context-popover a2k-cu",style:c,role:"tooltip",...d,children:[x,B]})}a(Bde,"ContextUsagePopover");';

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
 * 1.0.437 变成 `function XPe(t){Fue=t}`。定位靶点改用结构锚点（见 findBackendHook）：
 * 「`function NAME(t){STORE=t}` 紧跟 `function X(){return STORE}`，且全文存在 `STORE.getAvailableModels()`」——
 * 在 1.0.411 与 1.0.437 都恰好唯一命中。写盘前用 renderTemplate(PATCHED_QPE_PATTERN, ["QPe","Oue"], [fn, store]) 渲染。
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

type TemplateRegex = { re: RegExp; groups: string[] };
const templateRegexCache = new Map<string, TemplateRegex>();

/**
 * 把「以规范名书写的模板」编译成结构正则：模板整体正则转义，每个规范名按标识符边界替换——首次出现替换为
 * 捕获组 `([A-Za-z_$][\w$]*)`，之后出现替换为对应的反向引用（包在 (?:) 里，避免与后面的数字连成 \12）。
 * 返回的 groups 是捕获组顺序对应的规范名（按首次出现顺序，不一定等于 canonNames 顺序）。
 */
function templateRegex(template: string, canonNames: string[]): TemplateRegex {
  const key = canonNames.join(",") + "\u0000" + template;
  const cached = templateRegexCache.get(key);
  if (cached) return cached;
  const groups: string[] = [];
  let src = "";
  let last = 0;
  for (const m of template.matchAll(IDENT_RE)) {
    const name = m[0];
    const at = m.index as number;
    src += escapeRe(template.slice(last, at));
    if (canonNames.includes(name)) {
      const g = groups.indexOf(name);
      if (g >= 0) src += `(?:\\${g + 1})`;
      else {
        groups.push(name);
        src += `(${IDENT_SRC})`;
      }
    } else {
      src += escapeRe(name);
    }
    last = at + name.length;
  }
  src += escapeRe(template.slice(last));
  const out = { re: new RegExp(src, "g"), groups };
  templateRegexCache.set(key, out);
  return out;
}

/** 按标识符边界把模板里的规范名换成实际名（同一趟替换，不会链式改写）。 */
function renderTemplate(template: string, canonNames: string[], actualNames: string[]): string {
  return template.replace(IDENT_RE, (name) => {
    const i = canonNames.indexOf(name);
    return i >= 0 ? actualNames[i] : name;
  });
}

/**
 * 渲染前的护栏：实际名若与模板里其他标识符同名（例如 Kiro 某天把 useSessionConfig 压成 `K`，而补丁里已有局部 `const K`），
 * 渲染结果会发生遮蔽 / TDZ 错误。这种情况宁可不打（静默放行）。
 */
function namesCollide(template: string, canonNames: string[], actualNames: string[]): boolean {
  const others = new Set<string>();
  for (const m of template.matchAll(IDENT_RE)) if (!canonNames.includes(m[0])) others.add(m[0]);
  return actualNames.some((n) => others.has(n));
}

/**
 * Kiro 给每个函数都打了 `a(压缩名,"原名")` 标签（React 组件 / hook 的 displayName 保留）。
 * 按原名反查压缩名；全文必须恰好一处，否则返回 null。
 */
function resolveTaggedName(content: string, originalName: string): string | null {
  const re = new RegExp(`a\\((${IDENT_SRC}),"${escapeRe(originalName)}"\\)`, "g");
  const hits = [...content.matchAll(re)];
  return hits.length === 1 ? hits[0][1] : null;
}

/** ORIG_POPOVER_PATTERN 里随压缩器改名的三个名字：弹层函数、警告文案函数、函数尾部局部变量。 */
const POPOVER_FACTORY_CANON = ["Bde", "Pde", "z"];
/** PATCHED_POPOVER_CODE 里需要换成实际名的三个外部名：弹层函数、警告文案函数、useSessionConfig。 */
const POPOVER_PATCH_CANON = ["Bde", "Pde", "l0"];
/** PATCHED_QPE_PATTERN 里需要换成实际名的两个名字：setter、存储变量。 */
const BACKEND_CANON = ["QPe", "Oue"];

type PopoverFactoryHit = { start: number; end: number; text: string; names: { fn: string; warn: string; local: string } };
type SpanHit = { start: number; end: number; text: string };
type BackendHookHit = { start: number; end: number; fn: string; store: string };

/** 用结构正则在文件里找出厂弹层函数；必须恰好一处，否则 null。 */
function findPopoverFactory(content: string): PopoverFactoryHit | null {
  const { re, groups } = templateRegex(ORIG_POPOVER_PATTERN, POPOVER_FACTORY_CANON);
  const hits = [...content.matchAll(re)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  const byCanon = (c: string) => m[groups.indexOf(c) + 1];
  return {
    start: m.index as number,
    end: (m.index as number) + m[0].length,
    text: m[0],
    names: { fn: byCanon("Bde"), warn: byCanon("Pde"), local: byCanon("z") },
  };
}

/** 弹层调用处（出厂形态，以实际函数名渲染后逐字查找）；必须恰好一处，否则 null。 */
function findPopoverCall(content: string, fn: string): SpanHit | null {
  const text = renderTemplate(ORIG_POPOVER_CALL_PATTERN, ["Bde"], [fn]);
  const i = content.indexOf(text);
  if (i < 0 || content.indexOf(text, i + 1) >= 0) return null;
  return { start: i, end: i + text.length, text };
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
    return { status: "unavailable", files: [] };
  }
  await sweepStaleTmp(file);
  let content = restoreCtxHostHook(restoreBackendHook(original));
  if (enabled) {
    content = applyBackendHook(content);
    // 可选组的宿主钩子只在主钩子（通道 A）打上时才打：没有通道 A，聊天框改挡位也到不了 Kiro 的下一轮列表；
    // 主钩子漂移时文件一字不写，targets.backend 仍按老口径报 unavailable。
    if (/__kiroModelConfigProvider=t/.test(content)) content = applyCtxHostHook(content);
  }
  const extras = { ctxHost: ctxStatus(enabled, original.includes("__a2kSessionConfigOption"), content.includes("__a2kSessionConfigOption")) };
  if (content !== original) return { status: enabled ? "applied" : "removed", files: [{ file, original, next: content }], extras };
  // 开启但结构锚点找不到、文件里也没有任何版本的钩子：Kiro 版本漂移，静默放行、不写文件。
  if (enabled && !/__kiroModelConfigProvider=t/.test(content)) return { status: "unavailable", files: [], extras };
  return { status: "unchanged", files: [], extras };
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
 * A2kContextSelector：EffortSelector 右侧的「上下文」下拉。规范名 `b`（jsx 运行时）、`l0`（useSessionConfig）；函数名固定 a2kCtxSel。
 * 数据全部来自 Kiro 自己的 useSessionConfig：category==="model" 的 select 里当前选项的 description（CPS 私有微格式
 * `__A2K_MDL__|推理|图片|窗口|挡位表|末行`，第 5 位 = `候选,候选,…~来源~已知~解析值`）。不足 6 位（本扩展未运行 / 旧版 CPS /
 * Kiro 官方列表）→ 返回 null，聊天框与出厂一致。选中项变化 → `setter("a2k:ctx","<modelId>|<tokens>")`：webview 现成的
 * setSessionConfigOption 载体，宿主 zas 入口钩子转发到本扩展，agent 对未知 configId 无副作用（见 research §1.4）。
 * <select> 不受控（defaultValue + key=模型:窗口）：用户选完立刻显示所选，通道 A 推回新列表后 key 变化重挂到真实生效值。
 * 选项分两个 optgroup：「auto (解析来源)」只含解析值（选它 = 清除覆盖）、「manual」含其余挡位——显示文案只有数字，不占聊天栏宽度。
 * 模板里不能出现独立单词 a / b / l0 之外的规范名用法（renderTemplate 按标识符边界替换，字符串里的单词也会被换）。
 */
const CTX_SEL_FN_TEMPLATE =
  'function a2kCtxSel({disabled:t=!1}={}){const[cfg,setCfg]=l0();const row=(()=>{try{const q=(cfg||[]).find(z=>z&&z.category==="model");if(!q||q.type!=="select")return null;const F=(q.options||[]).flatMap(v=>v&&Array.isArray(v.options)?v.options:[v]);const z=F.find(v=>v&&v.value===q.currentValue);const p=typeof z?.description==="string"?z.description.split("|"):null;if(!p||p[0]!=="__A2K_MDL__"||p.length<6)return null;const c=String(p[4]).split("~");const cand=String(c[0]||"").split(",").map(Number).filter(v=>Number.isFinite(v)&&v>0);if(!cand.length)return null;const win=Number(p[3]);return{id:String(q.currentValue),win:win>0?win:cand[cand.length-1],cand,src:c[1]||"default",known:c[2]==="1",res:Number(c[3])||0,rsrc:c[4]||"default"}}catch(_e){return null}})();if(!row)return null;const K=v=>{if(!(v>0))return"?";const f=(x,u)=>(Number.isInteger(x)?String(x):x.toFixed(1))+u;if(v%1000!==0&&v%1024===0){const k=v/1024;return k>=1024?f(k/1024,"M"):f(k,"K")}const k=v/1000;return k>=1000?f(k/1000,"M"):f(k,"K")};const SRC={override:"your override",upstream:"upstream /models",vendor:"vendor catalog",catalog:"models.dev",default:row.known?"default":"unknown, default"};const tip="Context window: "+K(row.win)+" tokens ("+(SRC[row.src]||row.src)+"). Kiro summarizes at 80% and truncates at 95% of it. Choose smaller if the upstream rejects long inputs; the auto group follows the catalog again.";const opt=v=>b.jsx("option",{value:String(v),children:K(v)},v);const hasAuto=row.cand.includes(row.res);const list=hasAuto?[b.jsx("optgroup",{label:"auto ("+(SRC[row.rsrc]||row.rsrc)+")",children:opt(row.res)},"auto"),b.jsxs("optgroup",{label:"manual",children:row.cand.filter(v=>v!==row.res).map(opt)},"manual")]:row.cand.map(opt);return b.jsxs("span",{className:"a2k-ctx-wrap",title:tip,children:[b.jsx("span",{className:"a2k-ctx-label",children:"Ctx"}),b.jsxs("select",{className:"a2k-ctx-select",disabled:t,defaultValue:String(row.win),"aria-label":"Context window",onChange:ev=>{const v=Number(ev.target.value);v>0&&v!==row.win&&setCfg("a2k:ctx",row.id+"|"+v)},children:list},row.id+":"+row.win)]})}';
const CTX_SEL_CANON = ["b", "l0"];

/**
 * EffortSelector 调用处（chat-input-bottom-row-left 里唯一一处 `<b>.jsx(<EffortSelector>,{disabled:<v>})`）：
 * 出厂 → 包一层 Fragment 同时渲染 A2kContextSelector。规范名 `b`（jsx 运行时）、`a0e`（EffortSelector，1.0.437 压缩名；
 * 1.0.411 为 e0e）、`M`（disabled 变量）。React Compiler 的 memo 槽只缓存这个元素，子组件仍按自己的 hook 状态重渲染。
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

/** EffortSelector 组件名 + 标签结束位置；标签必须全文恰好一处。 */
function findEffortSelector(content: string): EffortSelectorHit | null {
  const hits = [...content.matchAll(CTX_EFFORT_TAG_RE)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  return { fn: m[2], tagger: m[1], tagEnd: (m.index as number) + m[0].length };
}

/** `<b>.jsx(<fn>,{disabled:<v>})` 恰好一处，捕获 jsx 运行时名与 disabled 变量名。 */
function findEffortSelectorCall(content: string, fn: string): EffortCallHit | null {
  const rendered = renderTemplate(CTX_CALL_ORIG_TEMPLATE, ["a0e"], [fn]);
  const { re, groups } = templateRegex(rendered, ["b", "M"]);
  const hits = [...content.matchAll(re)];
  if (hits.length !== 1) return null;
  const m = hits[0];
  const by = (c: string) => m[groups.indexOf(c) + 1];
  return { start: m.index as number, end: (m.index as number) + m[0].length, text: m[0], jsx: by("b"), disabled: by("M") };
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

/** 选项行补丁各历史变体共有的尾巴：ORIG_JS_PATTERN 里 children: 之后原样保留的兜底分支。 */
const JS_OPTION_TAIL = ORIG_JS_PATTERN.slice(ORIG_JS_PATTERN.indexOf('b.jsxs("div",{className:"chat-input-popup-option-content"'));
/** 4.13.53 起标记门形态选项行的起始锚（出厂文件里绝不出现 `__A2K_GRP__`）。 */
const JS_OPTION_GATED_START = 'className:"chat-input-popup-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")';

/**
 * 把 mermaid 里所有 API4Kiro 注入（无论哪个版本打的）还原为出厂。
 * 先做当前版本的精确逆替换，再用锚点兜底历史变体；通道 B（onMouseDown 触发器）无条件清除。
 */
function restoreSelectorScript(content: string): string {
  let out = content;
  // 1. 选项行：a) 4.13.53 起的标记门形态（className 表达式以 __A2K_GRP__ 判定开头）；b) 4.13.52 及更早无条件带
  //    a2k-exclusive-model-option 的形态。两者都以出厂兜底分支尾巴收口。
  out = out.split(PATCHED_JS_CODE).join(ORIG_JS_PATTERN);
  out = replaceSpan(out, JS_OPTION_GATED_START, JS_OPTION_TAIL, ORIG_JS_PATTERN, 20000);
  out = replaceSpan(out, 'className:"chat-input-popup-option a2k-exclusive-model-option"', JS_OPTION_TAIL, ORIG_JS_PATTERN, 20000);
  // 2. 菜单容器类名：a) 4.13.53 起 `"chat-input-popup-menu"+(r.some(…)?" a2k-model-selector-menu":"")`（任何以 `+(` 开头、
  //    到 `,style:d,role:"listbox"` 为止的表达式变体都回到出厂字面量）；b) 旧版逐字类名
  out = out.split(PATCHED_MENU_CODE).join(ORIG_MENU_PATTERN);
  out = replaceSpan(out, 'className:"chat-input-popup-menu"+(', '),style:d,role:"listbox"', 'className:"chat-input-popup-menu",style:d,role:"listbox"', 400);
  out = out.replace(/className:"chat-input-popup-menu a2k-[^"]*"/g, 'className:"chat-input-popup-menu"');
  // 3. 选中项居中滚动 ref（任何带 if(…) 分支的变体都回到出厂单句）
  out = out.split(PATCHED_REF_CODE).join(ORIG_REF_PATTERN);
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
  out = out.split(PATCHED_POPOVER_CODE).join(ORIG_POPOVER_PATTERN);
  out = restoreMarkedSpan(out, "function Bde(t){", 'a(Bde,"ContextUsagePopover");', /a2k-cu|cursor-context|cursor-legend-dot|cursor-row-left/, ORIG_POPOVER_PATTERN, 12000);
  // 6. 弹层调用处多传的 a2kUsage 属性（正则不带函数名，任何压缩名都覆盖）
  out = out.split(PATCHED_POPOVER_CALL_CODE).join(ORIG_POPOVER_CALL_PATTERN);
  out = out.replace(/,a2kUsage:n\}\)/g, "})");
  // 7. 聊天框「上下文」下拉（4.13.55）：删定界函数段 + 调用处拆包
  out = restoreCtxSelector(out);
  return out;
}

/**
 * 在出厂内容上打 Context Usage 弹层两处（函数体 + 调用处传参）。三个条件全部成立才打：
 * 结构正则唯一命中出厂函数（拿到实际的函数名 / 警告函数名）、以该函数名渲染的调用处唯一命中、
 * `a(名,"useSessionConfig")` 标签唯一反查到 hook 名。任一不成立返回 null（全有或全无）。
 */
function applyPopover(content: string): string | null {
  const fac = findPopoverFactory(content);
  if (!fac) return null;
  const call = findPopoverCall(content, fac.names.fn);
  if (!call) return null;
  const useSessionConfig = resolveTaggedName(content, "useSessionConfig");
  if (!useSessionConfig) return null;
  const actual = [fac.names.fn, fac.names.warn, useSessionConfig];
  if (namesCollide(PATCHED_POPOVER_CODE, POPOVER_PATCH_CANON, actual)) return null;
  const head = `function ${fac.names.fn}(t){`;
  const body = renderTemplate(PATCHED_POPOVER_CODE, POPOVER_PATCH_CANON, actual);
  if (!body.startsWith(head)) return null;
  const patchedFn = head + carryMarker(fac.text) + body.slice(head.length);
  const patchedCall = renderTemplate(PATCHED_POPOVER_CALL_CODE, ["Bde"], [fac.names.fn]);
  // 两段互不重叠；从后往前拼，前一段的偏移不受影响
  const spans = [
    { start: fac.start, end: fac.end, text: patchedFn },
    { start: call.start, end: call.end, text: patchedCall },
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
 */
function applySelectorScript(content: string): string {
  const selectorHit = [ORIG_JS_PATTERN, ORIG_MENU_PATTERN, ORIG_REF_PATTERN].every((s) => content.includes(s));
  if (!selectorHit) return content;
  let out = content
    .replace(ORIG_JS_PATTERN, PATCHED_JS_CODE)
    .replace(ORIG_MENU_PATTERN, PATCHED_MENU_CODE)
    .replace(ORIG_REF_PATTERN, PATCHED_REF_CODE);
  out = applyPopover(out) ?? out;
  // 可选组（4.13.55）：聊天框「上下文」下拉——锚点不命中就不打，不影响上面几处
  return applyCtxSelector(out) ?? out;
}

/** mermaid-*.js 的写入计划（只读盘、不写）。目录不存在 / 不可读（非 Kiro 宿主）→ unavailable 且无文件。 */
async function planModelSelectorScript(enabled: boolean): Promise<TargetPlan> {
  const dir = jsDir();
  const files: FilePlan[] = [];
  let patchedPresent = false;
  let ctxBefore = false;
  let ctxAfter = false;
  try {
    for (const f of await fs.promises.readdir(dir)) {
      if (!f.endsWith(".js") || !f.startsWith("mermaid-")) continue;
      const p = path.join(dir, f);
      const original = await fs.promises.readFile(p, "utf8");
      await sweepStaleTmp(p);
      // 先归一到出厂，再按需打当前版本补丁：旧版本补丁孤儿会被顺手升级 / 清除，
      // 已是当前补丁的文件往返后逐字相同，不会产生无意义写入。
      let content = restoreSelectorScript(original);
      if (enabled) content = applySelectorScript(content);
      if (content !== original) files.push({ file: p, original, next: content });
      if (content.includes(PATCHED_JS_CODE)) patchedPresent = true;
      if (original.includes(CTX_SEL_FN)) ctxBefore = true;
      if (content.includes(CTX_SEL_FN)) ctxAfter = true;
    }
  } catch {
    return { status: "unavailable", files: [] };
  }
  const extras = { ctxSelector: ctxStatus(enabled, ctxBefore, ctxAfter) };
  if (files.length > 0) return { status: enabled ? "applied" : "removed", files, extras };
  // 开启却没有任何 mermaid 文件带补丁：靶点不命中（Kiro 版本漂移）
  if (enabled && !patchedPresent) return { status: "unavailable", files: [], extras };
  return { status: "unchanged", files: [], extras };
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

/** style.css 的写入计划（只读盘、不写）。文件不可读 → unavailable + `<code> <path>` detail（ENOENT 表示非 Kiro 宿主）。 */
async function planStyleSheet(enabled: boolean): Promise<TargetPlan> {
  const file = styleFile();
  let current: string;
  try {
    current = await fs.promises.readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || "";
    return { status: "unavailable", detail: `${code} ${file}`.trim(), files: [] };
  }
  await sweepStaleTmp(file);
  const stripped = stripBlock(current);
  const next = enabled ? `${stripped.replace(/\s+$/, "")}\n${CARD_CSS}\n` : stripped;
  if (next === current) return { status: "unchanged", files: [] };
  return { status: enabled ? "applied" : "removed", files: [{ file, original: current, next }] };
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
        info(enabled ? TARGET_LOG[key].on : TARGET_LOG[key].off, fp.file);
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

async function syncGroupHeaderStyleUnlocked(enabled: boolean): Promise<StyleSyncResult> {
  const selectorScript = await planModelSelectorScript(enabled);
  const backend = await planKiroAgentBackend(enabled);
  // mermaid 靶点不命中（Kiro 升级）时不追加 CSS：CSS 里 .kiro-context-popover* 等规则
  // 不带专属类，单独落下就是「改了 IDE 外观却没有对应功能」的半补丁。
  const styleEnabled = enabled && selectorScript.status !== "unavailable";
  const style = await planStyleSheet(styleEnabled);
  const committed = await commitPlans(enabled, { selectorScript, backend, style });

  const targets = {
    style: committed.style.status,
    selectorScript: committed.selectorScript.status,
    backend: committed.backend.status,
  };
  // 可选组（4.13.55）：所属文件本轮写失败 / 被全有或全无中止（unavailable 且带 detail）→ 也报 unavailable；否则按计划推导的状态。
  const extraOf = (plan: TargetPlan, res: TargetResult, key: CtxTargetKey): TargetStatus =>
    res.status === "unavailable" && res.detail ? "unavailable" : plan.extras?.[key] ?? "unavailable";
  const extras: CtxExtras = {
    ctxSelector: extraOf(selectorScript, committed.selectorScript, "ctxSelector"),
    ctxHost: extraOf(backend, committed.backend, "ctxHost"),
  };
  if (enabled && (extras.ctxSelector === "unavailable" || extras.ctxHost === "unavailable")) {
    info(`context selector targets (optional group): selector=${extras.ctxSelector} host=${extras.ctxHost} — chat-input context dropdown falls back to the panel`);
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
    status = "unavailable";
    detail = "model selector target not found in mermaid-*.js (Kiro version drift); style not applied";
  } else if (Object.values(targets).some((s) => s === "applied")) {
    status = "applied";
  } else if (Object.values(targets).some((s) => s === "removed")) {
    status = "removed";
  } else {
    status = "unchanged";
  }
  return detail ? { status, detail, targets, extras } : { status, targets, extras };
}

/** 仅供 tests/selector、scripts/check-selector-patch.js、probe-kiro.js 使用：暴露靶点模板、标记块与结构匹配器。 */
export const __selectorStyleInternals = {
  START,
  END,
  CARD_CSS,
  /** 结构匹配器：模板以 1.0.411 压缩名书写，名字按结构捕获 / 反查 / 渲染。 */
  matchers: {
    templateRegex,
    renderTemplate,
    namesCollide,
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
    CTX_HOST_LITERAL,
    CTX_SEL_CANON,
    CTX_CALL_CANON,
    CTX_HOST_CANON,
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
  },
  legacy: LEGACY_POPOVER_VARIANTS,
  legacySelector: LEGACY_SELECTOR_VARIANTS,
  paths: { styleFile, jsDir, kiroAgentBackendFile },
};
