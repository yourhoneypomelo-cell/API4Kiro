import os

SVG_BRAIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.6 6.5a3 3 0 0 0 .4-1.4"/><path d="M6 5.1a3 3 0 0 0 .4 1.4"/><path d="M3.5 10.9a4.5 4.5 0 0 0 1.5 2.1"/><path d="M20.5 10.9a4.5 4.5 0 0 1-1.5 2.1"/></svg>'

SVG_IMAGE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>'

SVG_OPENAI = '<svg viewBox="0 0 40 40" width="15" height="15" fill="currentColor"><path d="M32.837 16.48a9.49 9.49 0 0 0-.825-7.85 9.61 9.61 0 0 0-10.368-4.63 9.64 9.64 0 0 0-7.876 4.02 9.51 9.51 0 0 0-6.386 4.63 9.61 9.61 0 0 0 1.187 11.33 9.5 9.5 0 0 0 .817 7.84 9.62 9.62 0 0 0 10.378 4.63 9.64 9.64 0 0 0 7.87-4.01 9.53 9.53 0 0 0 6.384-4.63 9.63 9.63 0 0 0-1.181-11.33zm-14.4 20.1a7.14 7.14 0 0 1-4.59-1.66l.23-.13 7.62-4.4a1.27 1.27 0 0 0 .63-1.09v-10.74l3.22 1.86a.11.11 0 0 1 .06.08v8.9a7.18 7.18 0 0 1-7.17 7.18zm-15.42-6.58a7.13 7.13 0 0 1-.85-4.8l.23.14 7.63 4.4a1.23 1.23 0 0 0 1.24 0l9.31-5.37v3.72a.13.13 0 0 1-.05.1l-7.7 4.45a7.18 7.18 0 0 1-9.81-2.64zm-3.73-13.1a7.15 7.15 0 0 1 3.77-3.15V22.4a1.22 1.22 0 0 0 .62 1.08l9.27 5.35-3.22 1.86a.12.12 0 0 1-.11 0l-7.7-4.44a7.18 7.18 0 0 1-2.63-9.8zm26.47 6.15-9.3-5.37 3.22-1.86a.12.12 0 0 1 .11 0l7.7 4.45a7.17 7.17 0 0 1-1.08 12.92v-9.05a1.26 1.26 0 0 0-.65-1.09zm3.2-4.82-.22-.14-7.61-4.43a1.24 1.24 0 0 0-1.25 0l-9.31 5.37V15.3a.11.11 0 0 1 .05-.1l7.7-4.44a7.18 7.18 0 0 1 10.64 7.43zM13.25 20.5l-3.22-1.85a.13.13 0 0 1-.06-.09V9.69a7.18 7.18 0 0 1 11.76-5.5l-.23.13-7.61 4.4a1.27 1.27 0 0 0-.64 1.1zm1.75-3.77 4.15-2.39 4.16 2.39v4.78l-4.14 2.39-4.17-2.39z"/></svg>'

# 精美 CSS
CARD_CSS = '''/* api4kiro:group-header:start */
/* API4Kiro：模型选择器极致卡片化分组（100% 对齐控制面板图例视觉规范） */
.chat-input-popup-menu[role="listbox"] {
  width: 324px !important;
  max-width: 324px !important;
  padding: 6px 0 !important;
}

/* 渠道卡片头 */
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp {
  margin: 8px 6px 0 6px !important;
  padding: 6px 10px !important;
  border-radius: 9px 9px 0 0 !important;
  background: rgba(255, 255, 255, 0.035) !important;
  border: 1px solid rgba(255, 255, 255, 0.11) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
  cursor: default !important;
  pointer-events: auto !important;
  user-select: none !important;
}
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp:first-child {
  margin-top: 3px !important;
}
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-grp:hover {
  background: rgba(255, 255, 255, 0.05) !important;
}

.a2k-card-head {
  display: flex !important;
  align-items: center !important;
  gap: 7px !important;
  width: 100% !important;
}
.a2k-chev {
  font-size: 9px !important;
  color: rgba(255, 255, 255, 0.5) !important;
  transform: scale(0.85) !important;
  flex: none !important;
}
.a2k-logo {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 19px !important;
  height: 19px !important;
  border-radius: 50% !important;
  background: rgba(166, 108, 255, 0.18) !important;
  border: 1.5px solid rgba(166, 108, 255, 0.65) !important;
  color: #ffffff !important;
  font-size: 10.5px !important;
  font-weight: 700 !important;
  box-shadow: 0 0 8px rgba(166, 108, 255, 0.4) !important;
  flex: none !important;
}
.a2k-title {
  font-size: 12px !important;
  font-weight: 600 !important;
  color: rgb(214, 196, 255) !important;
  text-shadow: 0 0 6px rgba(166, 108, 255, 0.35) !important;
  letter-spacing: 0.2px !important;
}
.a2k-count {
  font-size: 11px !important;
  color: rgba(255, 255, 255, 0.4) !important;
  margin-left: 2px !important;
  font-weight: 500 !important;
}

/* 卡片内部模型行：紧凑小巧，上下居中 */
.chat-input-popup-option.a2k-exclusive-model-option.a2k-opt-mdl {
  margin: 0 6px !important;
  padding: 4px 10px !important;
  min-height: 29px !important;
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
  border-radius: 0 0 9px 9px !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.11) !important;
  margin-bottom: 8px !important;
}

/* 模型行内部排版 */
.a2k-model-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  width: 100% !important;
  gap: 6px !important;
}
.a2k-model-name-box {
  display: inline-flex !important;
  align-items: center !important;
  min-width: 0 !important;
  flex: 1 1 auto !important;
}
.a2k-model-row .chat-input-popup-option-name {
  font-size: 12px !important;
  font-weight: 500 !important;
  color: rgba(255, 255, 255, 0.92) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  max-width: 200px !important;
}

/* 选中的模型格子：加渐变，圆角化，微光内边框（参考插件模型列表） */
.chat-input-popup-option.a2k-exclusive-model-option[data-selected="true"].a2k-opt-mdl {
  margin: 2px 8px !important;
  padding: 4px 8px !important;
  border-radius: 6px !important;
  border: 1px solid rgba(166, 108, 255, 0.45) !important;
  background: linear-gradient(90deg, rgba(166, 108, 255, 0.22) 0%, rgba(166, 108, 255, 0.08) 65%, rgba(166, 108, 255, 0.02) 100%) !important;
  box-shadow: 0 0 10px rgba(166, 108, 255, 0.18), inset 0 0 0 1px rgba(255, 255, 255, 0.05) !important;
}
.chat-input-popup-option.a2k-exclusive-model-option[data-selected="true"] .chat-input-popup-option-name {
  color: #ffffff !important;
  font-weight: 600 !important;
}

/* 能力胶囊标签：纯简笔画SVG，无文字说明 */
.a2k-caps-box {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  flex: none !important;
}
.a2k-cap {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 20px !important;
  height: 18px !important;
  border-radius: 4px !important;
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
  width: 12px !important;
  height: 12px !important;
}
/* api4kiro:group-header:end */'''

# 写入 style.css
css_file = r'D:\Kiro\resources\app\extensions\kiro.kiro-agent\packages\kiro-ui-agent-chat\dist\style.css'
with open(css_file, 'r', encoding='utf-8') as f:
    cur_css = f.read()

start_marker = '/* api4kiro:group-header:start */'
end_marker = '/* api4kiro:group-header:end */'

if start_marker in cur_css:
    s = cur_css.find(start_marker)
    e = cur_css.find(end_marker, s) + len(end_marker)
    cur_css = cur_css[:s] + CARD_CSS + cur_css[e:]
else:
    cur_css = cur_css.rstrip() + '\n\n' + CARD_CSS + '\n'

with open(css_file, 'w', encoding='utf-8') as f:
    f.write(cur_css)
print('style.css updated with compact cards, pure SVG caps, and gradient selection!')

# 更新 JS
js_file = r'D:\Kiro\resources\app\extensions\kiro.kiro-agent\packages\kiro-ui-agent-chat\dist\assets\mermaid-GHXKKRXX-IUK0bIya.js'
with open(js_file, 'r', encoding='utf-8') as f:
    cur_js = f.read()

# 纯简笔画SVG（推理与图片），无文字说明，无预选Tag
PATCHED_JS_CODE = '''className:"chat-input-popup-option a2k-exclusive-model-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")?" a2k-opt-grp":typeof k==="string"&&k.startsWith("__A2K_MDL__|")?(" a2k-opt-mdl"+(k.endsWith("|1")?" a2k-opt-last":"")):""),"data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a((e)=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))){e?.preventDefault?.();e?.stopPropagation?.();return}g(T)},"onClick"),onKeyDown:a(O=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|")))return;O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))?(()=>{const p=k.split("|"),logoHtml=(p[4]==="openai"?'<span class=\\"a2k-logo\\">'+''' + repr(SVG_OPENAI) + '''+'</span>':'<span class=\\"a2k-logo\\">'+(p[3]||"P")+'</span>');return b.jsx("div",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:"<span class=\\\"a2k-chev\\\">▼</span>"+logoHtml+"<span class=\\\"a2k-title\\\">"+p[1]+"</span><span class=\\\"a2k-count\\\">"+p[2]+" ↑</span>"}})})():(typeof k==="string"&&k.startsWith("__A2K_MDL__|"))?(()=>{const p=k.split("|"),caps=(p[1]==="1"?'<span class=\\"a2k-cap a2k-cap-reason\\" title=\\"推理\\">'+''' + repr(SVG_BRAIN) + '''+'</span>':'')+(p[2]==="1"?'<span class=\\"a2k-cap a2k-cap-vision\\" title=\\"图片\\">'+''' + repr(SVG_IMAGE) + '''+'</span>':'');return b.jsx("div",{className:"a2k-model-row",dangerouslySetInnerHTML:{__html:"<div class=\\\"a2k-model-name-box\\\"><span class=\\\"chat-input-popup-option-name\\\" title=\\\""+E+"\\\">"+E+"</span></div><div class=\\\"a2k-caps-box\\\">"+caps+"</div>"}})})():b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})'''

idx = cur_js.find('className:"chat-input-popup-option a2k-exclusive-model-option"')
if idx >= 0:
    end_idx = cur_js.find('},`model-${T}`)', idx)
    cur_js = cur_js[:idx] + PATCHED_JS_CODE + cur_js[end_idx:]
    with open(js_file, 'w', encoding='utf-8') as f:
        f.write(cur_js)
    print('mermaid JS updated with pure SVG caps, no tag, and integrated logo!')
else:
    print('Pattern not found in JS')
