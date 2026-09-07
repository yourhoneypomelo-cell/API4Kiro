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

export type StyleSyncResult = {
  status: TargetStatus;
  detail?: string;
  /** 三个靶点文件各自的结果：style.css / mermaid-*.js / kiro-agent dist/extension.js */
  targets: { style: TargetStatus; selectorScript: TargetStatus; backend: TargetStatus };
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
${END}`;

const ORIG_JS_PATTERN =
  'className:"chat-input-popup-option","data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a(()=>g(T),"onClick"),onKeyDown:a(O=>{O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})';

const SVG_BRAIN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.6 6.5a3 3 0 0 0 .4-1.4"/><path d="M6 5.1a3 3 0 0 0 .4 1.4"/><path d="M3.5 10.9a4.5 4.5 0 0 0 1.5 2.1"/><path d="M20.5 10.9a4.5 4.5 0 0 1-1.5 2.1"/></svg>';

const SVG_IMAGE =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';

const SVG_OPENAI =
  '<svg viewBox="0 0 40 40" width="15" height="15" fill="currentColor"><path d="M32.837 16.48a9.49 9.49 0 0 0-.825-7.85 9.61 9.61 0 0 0-10.368-4.63 9.64 9.64 0 0 0-7.876 4.02 9.51 9.51 0 0 0-6.386 4.63 9.61 9.61 0 0 0 1.187 11.33 9.5 9.5 0 0 0 .817 7.84 9.62 9.62 0 0 0 10.378 4.63 9.64 9.64 0 0 0 7.87-4.01 9.53 9.53 0 0 0 6.384-4.63 9.63 9.63 0 0 0-1.181-11.33zm-14.4 20.1a7.14 7.14 0 0 1-4.59-1.66l.23-.13 7.62-4.4a1.27 1.27 0 0 0 .63-1.09v-10.74l3.22 1.86a.11.11 0 0 1 .06.08v8.9a7.18 7.18 0 0 1-7.17 7.18zm-15.42-6.58a7.13 7.13 0 0 1-.85-4.8l.23.14 7.63 4.4a1.23 1.23 0 0 0 1.24 0l9.31-5.37v3.72a.13.13 0 0 1-.05.1l-7.7 4.45a7.18 7.18 0 0 1-9.81-2.64zm-3.73-13.1a7.15 7.15 0 0 1 3.77-3.15V22.4a1.22 1.22 0 0 0 .62 1.08l9.27 5.35-3.22 1.86a.12.12 0 0 1-.11 0l-7.7-4.44a7.18 7.18 0 0 1-2.63-9.8zm26.47 6.15-9.3-5.37 3.22-1.86a.12.12 0 0 1 .11 0l7.7 4.45a7.17 7.17 0 0 1-1.08 12.92v-9.05a1.26 1.26 0 0 0-.65-1.09zm3.2-4.82-.22-.14-7.61-4.43a1.24 1.24 0 0 0-1.25 0l-9.31 5.37V15.3a.11.11 0 0 1 .05-.1l7.7-4.44a7.18 7.18 0 0 1 10.64 7.43zM13.25 20.5l-3.22-1.85a.13.13 0 0 1-.06-.09V9.69a7.18 7.18 0 0 1 11.76-5.5l-.23.13-7.61 4.4a1.27 1.27 0 0 0-.64 1.1zm1.75-3.77 4.15-2.39 4.16 2.39v4.78l-4.14 2.39-4.17-2.39z"/></svg>';

const PATCHED_JS_CODE =
  `className:"chat-input-popup-option a2k-exclusive-model-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")?" a2k-opt-grp":typeof k==="string"&&k.startsWith("__A2K_MDL__|")?(" a2k-opt-mdl"+(k.endsWith("|1")?" a2k-opt-last":"")):""),"data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a((e)=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))){e?.preventDefault?.();e?.stopPropagation?.();return}g(T)},"onClick"),onKeyDown:a(O=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|")))return;O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))?(()=>{const p=k.split("|");let logoHtml="";try{if(p[5]){logoHtml="<span class=\\\"a2k-logo\\\">"+atob(p[5])+"</span>";}}catch(_e){}if(!logoHtml){logoHtml=p[4]==="openai"?'<span class=\\"a2k-logo\\">${SVG_OPENAI}</span>':'<span class=\\"a2k-logo\\">'+(p[3]||"P")+'</span>';}return b.jsx("div",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:"<span class=\\\"a2k-chev\\\">▼</span>"+logoHtml+"<span class=\\\"a2k-title\\\">"+p[1]+"</span><span class=\\\"a2k-count\\\">"+p[2]+" ↑</span>"}})})():(typeof k==="string"&&k.startsWith("__A2K_MDL__|"))?(()=>{const p=k.split("|"),caps=(p[1]==="1"?'<span class=\\"a2k-cap a2k-cap-reason\\" title=\\"推理\\">${SVG_BRAIN}</span>':'')+(p[2]==="1"?'<span class=\\"a2k-cap a2k-cap-vision\\" title=\\"图片\\">${SVG_IMAGE}</span>':'');return b.jsx("div",{className:"a2k-model-row",dangerouslySetInnerHTML:{__html:"<div class=\\\"a2k-model-name-box\\\"><span class=\\\"chat-input-popup-option-name\\\" title=\\\""+E+"\\\">"+E+"</span></div><div class=\\\"a2k-caps-box\\\">"+caps+"</div>"}})})():b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})`;

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

const ORIG_MENU_PATTERN =
  'children:b.jsx("div",{ref:c.setFloating,className:"chat-input-popup-menu",style:d,role:"listbox","data-keyboard-nav":l!=="mouse"||void 0,...h(),children:r.map((y,x)=>{const{description:k,name:E,value:T}=y';

const PATCHED_MENU_CODE =
  'children:b.jsx("div",{ref:c.setFloating,className:"chat-input-popup-menu a2k-model-selector-menu",style:d,role:"listbox","data-keyboard-nav":l!=="mouse"||void 0,...h(),children:r.map((y,x)=>{const{description:k,name:E,value:T}=y';

const ORIG_REF_PATTERN =
  'ref:a(O=>{m.current[x]=O},"ref")';

const PATCHED_REF_CODE =
  'ref:a(O=>{m.current[x]=O;if(O&&C&&!O.dataset.a2kScrolled){O.dataset.a2kScrolled="1";setTimeout(()=>{O.scrollIntoView({block:"center",behavior:"instant"});},10);}},"ref")';

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
 */
const PATCHED_POPOVER_CODE =
  'function Bde(t){const e=re.c(30),[a2kCfg]=l0(),{livePercentage:n,conversationPct:r,mcpPct:s,steeringPct:i,hasBreakdown:o,warning:l,showWarning:u,style:c,floatingProps:d,summarizationThreshold:f,a2kUsage:A}=t,g=Math.ceil(n),y=n>=f-5;const CW=(()=>{try{const q=(a2kCfg||[]).find(z=>z&&z.category==="model");if(!q||q.type!=="select")return 0;const z=(q.options||[]).flatMap(v=>v&&Array.isArray(v.options)?v.options:[v]).find(v=>v&&v.value===q.currentValue);const p=typeof z?.description==="string"?z.description.split("|"):null;const w=p&&p[0]==="__A2K_MDL__"?Number(p[3]):0;return w>0?w:0}catch(_e){return 0}})();const x=u&&l!=null&&b.jsxs("div",{className:"kiro-context-popover-warning",children:[b.jsx("div",{className:"kiro-context-popover-warning-header",children:b.jsx("span",{children:"High initial context usage"})}),b.jsx("div",{className:"kiro-context-popover-warning-message",children:Pde(l)})]});const K=v=>{if(v>=1e6){const q=(v/1e6).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"M"}if(v>=1e3){const q=(v/1e3).toFixed(1);return(q.endsWith(".0")?q.slice(0,-2):q)+"K"}return String(Math.round(v))};const V=A&&A.breakdown,W=V&&V.tools||{},D=[["prompts","Your prompts",V&&V.yourPrompts],["responses","Kiro responses",V&&V.kiroResponses],["files","Session files",V&&V.sessionFiles],["builtin","Built-in tools",W.builtin],["mcp","MCP tools",W.mcp],["steering","Steering files",V&&V.contextFiles]].filter(q=>q[2]&&typeof q[2].percent=="number"&&typeof q[2].tokens=="number");const J=D.length>0,Q=J?D.map(q=>({k:q[0],n:q[1],p:q[2].percent,v:q[2].tokens,h:q[0]==="mcp"?l?.mcpTools:q[0]==="steering"?l?.steering:void 0})):[{k:"conv",n:"Conversation",p:r,v:0,h:void 0}].concat(o?[{k:"mcp",n:"MCP tools",p:s,v:0,h:l?.mcpTools},{k:"steering",n:"Steering files",p:i,v:0,h:l?.steering}]:[]);const G=J?Q.reduce((q,w)=>q+w.v,0):0;const T=b.jsxs(b.Fragment,{children:[b.jsx("div",{className:"a2k-cu-head",children:b.jsx("span",{className:"a2k-cu-title",children:"Context Usage"})}),b.jsxs("div",{className:"a2k-cu-sub",children:[b.jsx("span",{className:"a2k-cu-pct",children:`${g}% Full`}),CW>0?b.jsx("span",{className:"a2k-cu-tokens",title:"Total = real usage reported by the upstream (percentage x context window). Per-category counts below are a rough client-side estimate by Kiro and may not add up to the total.",children:`~${K(Math.round(n/100*CW))} / ${K(CW)} tokens`}):J&&b.jsx("span",{className:"a2k-cu-tokens",title:"Token counts are a rough client-side estimate by Kiro; the percentage comes from the real token usage reported by the upstream.",children:`~${K(G)} tokens est.`})]}),b.jsx("div",{className:"a2k-cu-bar",children:Q.map(q=>b.jsx("div",{className:"a2k-cu-seg a2k-cu-c-"+q.k,style:{width:`${Math.max(0,Math.min(100,q.p))}%`}},q.k))})]});const L=b.jsx("div",{className:"kiro-context-popover-breakdown a2k-cu-rows",children:Q.map(q=>b.jsxs("div",{className:"kiro-context-popover-breakdown-row a2k-cu-row","data-high":q.h||void 0,children:[b.jsxs("span",{className:"a2k-cu-left",children:[b.jsx("span",{className:"a2k-cu-sw a2k-cu-c-"+q.k}),b.jsx("span",{children:q.n})]}),b.jsx("span",{className:"a2k-cu-val",children:J?K(q.v):`${Math.ceil(q.p)}%`})]},q.k))});const I=y&&b.jsx("div",{className:"kiro-context-popover-hint",children:`Auto-summarization at ${f}%`});const B=b.jsxs("div",{className:"kiro-context-popover-content",children:[T,L,I]});return b.jsxs("div",{className:"kiro-context-popover a2k-cu",style:c,role:"tooltip",...d,children:[x,B]})}a(Bde,"ContextUsagePopover");';

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

async function syncKiroAgentBackend(enabled: boolean): Promise<TargetResult> {
  const file = kiroAgentBackendFile();
  let original: string;
  try {
    original = await fs.promises.readFile(file, "utf8");
  } catch {
    // 文件不存在 / 不可读（非 Kiro 宿主）：静默放行
    return { status: "unavailable" };
  }
  await sweepStaleTmp(file);
  let content = restoreBackendHook(original);
  if (enabled) content = applyBackendHook(content);
  if (content !== original) {
    try {
      await writeAtomic(file, content);
    } catch (e) {
      // 写失败（只读 / 被占用 / 权限不足）：文件维持原样，但必须带 detail 上报——还原失败不能报成 removed
      const msg = (e as Error).message || String(e);
      error("kiroAgent backend write failed:", file, msg);
      return { status: "unavailable", detail: `${path.basename(file)}: ${msg}` };
    }
    info(enabled ? "hooked kiroAgent modelConfigProvider bridge" : "restored kiroAgent modelConfigProvider bridge");
    return { status: enabled ? "applied" : "removed" };
  }
  // 开启但结构锚点找不到、文件里也没有任何版本的钩子：Kiro 版本漂移，静默放行、不写文件。
  if (enabled && !/__kiroModelConfigProvider=t/.test(content)) return { status: "unavailable" };
  return { status: "unchanged" };
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

/** 选项行补丁各历史变体共有的尾巴：ORIG_JS_PATTERN 里 children: 之后原样保留的兜底分支。 */
const JS_OPTION_TAIL = ORIG_JS_PATTERN.slice(ORIG_JS_PATTERN.indexOf('b.jsxs("div",{className:"chat-input-popup-option-content"'));

/**
 * 把 mermaid 里所有 API4Kiro 注入（无论哪个版本打的）还原为出厂。
 * 先做当前版本的精确逆替换，再用锚点兜底历史变体；通道 B（onMouseDown 触发器）无条件清除。
 */
function restoreSelectorScript(content: string): string {
  let out = content;
  // 1. 选项行（a2k-exclusive-model-option … 出厂兜底分支尾巴）
  out = out.split(PATCHED_JS_CODE).join(ORIG_JS_PATTERN);
  out = replaceSpan(out, 'className:"chat-input-popup-option a2k-exclusive-model-option"', JS_OPTION_TAIL, ORIG_JS_PATTERN, 20000);
  // 2. 菜单容器类名
  out = out.split(PATCHED_MENU_CODE).join(ORIG_MENU_PATTERN);
  out = out.replace(/className:"chat-input-popup-menu a2k-[^"]*"/g, 'className:"chat-input-popup-menu"');
  // 3. 选中项居中滚动 ref
  out = out.split(PATCHED_REF_CODE).join(ORIG_REF_PATTERN);
  out = replaceSpan(out, "ref:a(O=>{m.current[x]=O;if(O&&C&&!O.dataset.a2kScrolled)", '},"ref")', ORIG_REF_PATTERN, 2000);
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
  const out = content
    .replace(ORIG_JS_PATTERN, PATCHED_JS_CODE)
    .replace(ORIG_MENU_PATTERN, PATCHED_MENU_CODE)
    .replace(ORIG_REF_PATTERN, PATCHED_REF_CODE);
  return applyPopover(out) ?? out;
}

async function syncModelSelectorScript(enabled: boolean): Promise<TargetResult> {
  const dir = jsDir();
  let changedAny = false;
  let patchedPresent = false;
  const writeErrors: string[] = [];
  try {
    const files = await fs.promises.readdir(dir);
    for (const f of files) {
      if (f.endsWith(".js") && f.startsWith("mermaid-")) {
        const p = path.join(dir, f);
        const original = await fs.promises.readFile(p, "utf8");
        await sweepStaleTmp(p);
        // 先归一到出厂，再按需打当前版本补丁：旧版本补丁孤儿会被顺手升级 / 清除，
        // 已是当前补丁的文件往返后逐字相同，不会产生无意义写入。
        let content = restoreSelectorScript(original);
        if (enabled) content = applySelectorScript(content);
        const changed = content !== original;

        if (changed) {
          try {
            await writeAtomic(p, content);
            changedAny = true;
            info(enabled ? "patched model selector script:" : "restored model selector script:", p);
          } catch (e) {
            // 单个文件写失败（只读 / 被占用）：不留半补丁，本文件维持原样，但带 detail 上报
            const msg = (e as Error).message || String(e);
            error("model selector script write failed:", p, msg);
            writeErrors.push(`${f}: ${msg}`);
            continue;
          }
        }
        if (content.includes(PATCHED_JS_CODE)) patchedPresent = true;
      }
    }
  } catch (e) {
    // 目录不存在 / 不可读（非 Kiro 宿主）：静默放行
    return { status: "unavailable" };
  }
  if (writeErrors.length > 0) return { status: "unavailable", detail: writeErrors.join("; ") };
  if (changedAny) return { status: enabled ? "applied" : "removed" };
  // 开启却没有任何 mermaid 文件带补丁：靶点不命中（Kiro 版本漂移）
  if (enabled && !patchedPresent) return { status: "unavailable" };
  return { status: "unchanged" };
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

async function syncStyleSheet(enabled: boolean): Promise<{ status: TargetStatus; detail?: string }> {
  const file = styleFile();
  let current: string;
  try {
    current = await fs.promises.readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || "";
    return { status: "unavailable", detail: `${code} ${file}`.trim() };
  }
  await sweepStaleTmp(file);

  const stripped = stripBlock(current);
  const next = enabled ? `${stripped.replace(/\s+$/, "")}\n${CARD_CSS}\n` : stripped;
  if (next === current) {
    return { status: "unchanged" };
  }

  try {
    await writeAtomic(file, next);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    error("selector style write failed:", msg);
    return { status: "unavailable", detail: msg };
  }
  info(enabled ? "applied card model selector style:" : "restored original Kiro style:", file);
  return { status: enabled ? "applied" : "removed" };
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
  const selectorScript = await syncModelSelectorScript(enabled);
  const backend = await syncKiroAgentBackend(enabled);
  // mermaid 靶点不命中（Kiro 升级）时不追加 CSS：CSS 里 .kiro-context-popover* 等规则
  // 不带专属类，单独落下就是「改了 IDE 外观却没有对应功能」的半补丁。
  const styleEnabled = enabled && selectorScript.status !== "unavailable";
  const style = await syncStyleSheet(styleEnabled);

  const targets = { style: style.status, selectorScript: selectorScript.status, backend: backend.status };
  // 任一 Kiro 文件「本应写入却写失败」都上浮为 unavailable 并带 detail：尤其是还原路径，
  // 否则 mermaid / extension.js 没还原成功却报 removed，调用方无从提示用户。
  const writeErrors = [selectorScript.detail, backend.detail].filter((d): d is string => !!d);
  let status: TargetStatus;
  let detail = style.detail;
  if (style.status === "unavailable") {
    status = "unavailable";
    detail = [style.detail, ...writeErrors].filter(Boolean).join("; ") || undefined;
  } else if (writeErrors.length > 0) {
    status = "unavailable";
    detail = writeErrors.join("; ");
  } else if (enabled && selectorScript.status === "unavailable") {
    status = "unavailable";
    detail = "model selector target not found in mermaid-*.js (Kiro version drift); style not applied";
  } else if (Object.values(targets).some((s) => s === "applied")) {
    status = "applied";
  } else if (Object.values(targets).some((s) => s === "removed")) {
    status = "removed";
  } else {
    status = "unchanged";
  }
  return detail ? { status, detail, targets } : { status, targets };
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
  },
  legacy: LEGACY_POPOVER_VARIANTS,
  paths: { styleFile, jsDir, kiroAgentBackendFile },
};
