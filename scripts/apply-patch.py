import os

js_file = r'D:\Kiro\resources\app\extensions\kiro.kiro-agent\packages\kiro-ui-agent-chat\dist\assets\mermaid-GHXKKRXX-IUK0bIya.js'
css_file = r'D:\Kiro\resources\app\extensions\kiro.kiro-agent\packages\kiro-ui-agent-chat\dist\style.css'

with open(r'E:\AI项目\反代项目\Gemini-3.8-flash 旁路 api2kiro\api2kiro-dual\src\selectorStyle.ts', 'r', encoding='utf-8') as f:
    ts = f.read()

# 提取 CARD_CSS
s_css = ts.find('const CARD_CSS = `${START}')
e_css = ts.find('${END}`;', s_css)
card_css = ts[s_css + len('const CARD_CSS = `${START}\n'):e_css]

start_marker = '/* api4kiro:group-header:start */'
end_marker = '/* api4kiro:group-header:end */'
block = f'{start_marker}\n{card_css}\n{end_marker}'

with open(css_file, 'r', encoding='utf-8') as f:
    cur_css = f.read()

if start_marker in cur_css:
    s = cur_css.find(start_marker)
    e = cur_css.find(end_marker, s) + len(end_marker)
    cur_css = cur_css[:s] + block + cur_css[e:]
else:
    cur_css = cur_css.rstrip() + '\n\n' + block + '\n'

with open(css_file, 'w', encoding='utf-8') as f:
    f.write(cur_css)

print('Updated style.css with 100% exclusive scoped rules!')

raw_orig = 'className:"chat-input-popup-option","data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a(()=>g(T),"onClick"),onKeyDown:a(O=>{O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??"credits"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})'

target_code = 'className:"chat-input-popup-option a2k-exclusive-model-option"+(typeof k==="string"&&k.startsWith("__A2K_GRP__|")?" a2k-opt-grp":typeof k==="string"&&k.startsWith("__A2K_MDL__|")?(" a2k-opt-mdl"+(k.endsWith("|1")?" a2k-opt-last":"")):""),"data-selected":C||void 0,"data-active":S||void 0,role:"option","aria-selected":C,tabIndex:S?0:-1,...p({onClick:a((e)=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))){e?.preventDefault?.();e?.stopPropagation?.();return}g(T)},"onClick"),onKeyDown:a(O=>{if(T?.startsWith?.("a2k-group:")||!E||(typeof k==="string"&&k.startsWith("__A2K_GRP__|")))return;O.key==="Enter"&&(O.preventDefault(),g(T))},"onKeyDown")}),children:(typeof k==="string"&&k.startsWith("__A2K_GRP__|"))?(()=>{const p=k.split("|");return b.jsx("div",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:"<span class=\\\"a2k-chev\\\">▼</span><span class=\\\"a2k-logo\\\">"+(p[3]||"P")+"</span><span class=\\\"a2k-title\\\">"+p[1]+"</span><span class=\\\"a2k-count\\\">"+p[2]+" ↑</span>"}})})():(typeof k==="string"&&k.startsWith("__A2K_MDL__|"))?(()=>{const p=k.split("|"),caps=(p[1]===\"1\"?"<span class=\\\"a2k-cap a2k-cap-reason\\\"><span class=\\\"a2k-cap-ico\\\">🧠</span>推理</span>":"")+(p[2]===\"1\"?"<span class=\\\"a2k-cap a2k-cap-vision\\\"><span class=\\\"a2k-cap-ico\\\">🖼️</span>图片</span>":""),selPill=C?"<span class=\\\"a2k-sel-pill\\\">● 预选</span>":"";return b.jsx("div",{className:"a2k-model-row",dangerouslySetInnerHTML:{__html:"<div class=\\\"a2k-model-name-box\\\"><span class=\\\"chat-input-popup-option-name\\\">"+E+"</span>"+selPill+"</div><div class=\\\"a2k-caps-box\\\">"+caps+"</div>"}})})():b.jsxs("div",{className:"chat-input-popup-option-content",children:[b.jsxs("div",{className:"model-selector-option-header",children:[b.jsx("span",{className:"chat-input-popup-option-name",children:E}),R?.rateMultiplier!=null&&b.jsxs("span",{className:"model-selector-option-rate",children:[R.rateMultiplier,"x ",R.rateUnit??\"credits\"]})]}),k&&b.jsx("span",{className:"chat-input-popup-option-description",children:k})]})'

with open(js_file, 'r', encoding='utf-8') as f:
    cur_js = f.read()

if raw_orig in cur_js:
    cur_js = cur_js.replace(raw_orig, target_code, 1)
    with open(js_file, 'w', encoding='utf-8') as f:
        f.write(cur_js)
    print('Patched JS successfully from raw_orig!')
elif target_code in cur_js:
    print('JS already has target_code!')
else:
    print('Pattern search...')
