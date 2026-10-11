# Kiro 1.2.56 兼容：调查结论与实施计划

worktree：`<repo>/.worktrees/kiro-1.2.56-compat`（分支 `fix/kiro-1.2.56-compat`，HEAD `ac64f04`，4.13.63）
目标 Kiro：1.2.56（product.json commit `a9f29386…`，date 2026-10-08；kiro-agent `kiroAgent` 1.1.343）

## 0. 结论

后端与网络这一侧在 1.2.56 上都还正常：端点重定向、CPS 模型列表、KRS、通道 A setter 钩子、`a2k:ctx` 宿主转发钩子都能用。坏的全在 webview 补丁（`src/selectorStyle.ts`），原因有三个，互相独立：

1. **模型选择器被 Kiro 整个重写了**（不只是重新压缩）。旧的 `chat-input-popup-option` 选项行、菜单、ref 三个锚点一个都不在了，换成了新的 `ModelPanel`/`ModelOptionRow`/`useModelSelector`（带搜索框、勾选列、Effort 滑条）。选择器补丁按全有或全无放弃，于是**弹层和 Ctx 下拉也一起不打**（`applySelectorScript` 在选项行不中时直接 return）。而 CPS 照样广播 `__A2K_GRP__|…`/`__A2K_MDL__|…` 微格式，新面板会把它原样渲染在 `kiro-model-panel-option-description` 里。分组标题还会变成可以选中的空名「模型」。
2. **`EffortSelector` 组件被删了**，Effort 挪进了模型面板（`EffortSection`）。Ctx 下拉的锚点（`<h>(<fn>,"EffortSelector");` 加调用处）在两个 package 里都是 0 命中。
3. **结构匹配器有一个潜伏 bug，被这次压缩触发了**：`codeTokens` 把成员访问的属性名（`ne.c(30)` 里的 `.c`）也当成可改名的标识符。1.2.56 的 agent-chat 恰好把局部变量 `c`/`u` 对调（`showWarning:c,style:u`），`verifyTokens` 于是看到规范名 `c` 同时映射到 `c`（属性）和 `u`（局部变量），判定不一致，弹层函数 0 命中。弹层函数本身的结构与规范模板逐 token 等长（1088 vs 1088），没有任何非标识符差异。

修好这三处以后，在 1.2.56 的出厂副本上原型验证过：两个 package 都能打上新的行补丁（`node --check` 通过、往返还原逐字一致），Ctx 下拉两个 package 都能注入（解析通过、往返一致），agent-chat 的弹层能命中（`Ake`/`Cke`，jsx=`b`）。

## 1. 环境实况（只读核对）

- 安装目录：`/Applications/Kiro.app/Contents/Resources/app`，`product.json` 与 `package.json` 都是 1.2.56，mtime 为 Oct 8 13:50。
- 承载模型选择器的 chunk（按内容 `chat-input-popup-option` 判定，两份都命中）：
  - `extensions/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/assets/mermaid-GHXKKRXX-CSjtlRpj.js`（出厂 1,982,997 B，jsx 运行时 `b`，名字助手 `a`）
  - `extensions/kiro.kiro-agent/packages/kiro-ui-session-details/dist/assets/mermaid-GHXKKRXX-Bitgocve.js`（2,363,349 B，jsx `x`，助手 `o`）
- **另一个扩展 `kiro-proxy.kiro-api-proxy-6.5.13` 也在改这几份文件**（2026-10-10 安装）：
  - agent-chat 的 chunk 被它注入了 `/*kiroproxy-ctxwin-ui:r2*/function KiroProxyCtxWinSelect…`，还在 `chat-input-bottom-row-left` 的 children 里追加了一个调用。备份在 `…CSjtlRpj.js.kiroproxy-bak-1.2.56`。
  - `dist/extension.js` 被注入了 `/*kiroproxy-toolcard:r1*/…`，备份在 `dist/extension.js.kiroproxy-bak-1.2.56`。
  - agent-chat 的 `style.css` 带了 `kiroproxy-ctxwin-*` 规则。
  - 它也会写 `codewhisperer.config.*Endpoints`。我们的日志有 6 次 `endpoints at global was set by another writer (not this extension); left untouched`。
  - 带着它的残留，我们的锚点仍然唯一：`b.jsx(rve,{disabled:ue})` 只有 1 处，`"useSessionConfig"` 标签只有 1 处。两套代理**同时启用会抢端点**，这是既有行为，不属于本任务，只告知用户。
- 当前真机三份靶文件里都**没有** a2k 补丁。1.2.56 下 API4Kiro 只启用过一次（log `20261010T194118`）：打补丁失败，用户随后关闭代理，后端钩子已还原。
- 当前真机状态的依据：真机 agent-chat 的 chunk 与两份 `style.css` 里搜不到任何 `a2k-` 标记，`dist/extension.js` 里没有 `__kiroModelConfigProvider`。session-details 的 chunk 唯一一处 `a2k` 字样是 `a2kohama`，它属于出厂文本，与补丁无关。
- 出厂只读副本：`/tmp/kiro-1.2.56-factory`（`kiro.kiro-agent/{dist/extension.js,package.json,packages/{kiro-ui-agent-chat,kiro-ui-session-details}/dist/{style.css,assets/mermaid-*.js}}`）。agent-chat 的 chunk 与 `extension.js` 取自 `.kiroproxy-bak-1.2.56`，是纯出厂态。`/tmp` 可能被清理，丢了就按 §5 的命令重建。

### 1.1 运行时日志（`~/Library/Application Support/Kiro/logs/20261010T194118/window1/exthost/output_logging_*/3-API4Kiro.log`）

```
[02:41:44Z] KRS OWNER on 127.0.0.1:19810 / CPS OWNER on 127.0.0.1:19811
[02:41:44Z] endpoints / krsEndpoints / cpsEndpoints -> 127.0.0.1:1981x
[02:41:45Z] hooked kiroAgent modelConfigProvider bridge …/dist/extension.js
[02:41:45Z] context selector targets (optional group): selector=unavailable host=applied — missing in: kiro-ui-agent-chat, kiro-ui-session-details
[02:41:45Z] [error] selector patch sync unavailable: model selector targets not found in kiro-ui-agent-chat, kiro-ui-session-details — this Kiro build changed the factory structure (not just minified names)
[02:41:52Z] KRS MCP: tools/list
[02:41:52Z] KRS unhandled: POST /
[02:41:53Z] cps models: 7 条，用时 1033ms
[02:42:12Z] endpoints removed at global …   [02:42:13Z] restored kiroAgent modelConfigProvider bridge
```

在 1.2.56 启动后（`-newer product.json`）的全部 API4Kiro 日志里，排除 `fetch failed` 噪声后，只剩上面这几类 warn/error。`provider p2/p3 /models fetch failed` 是用户自己的上游离线，与 Kiro 无关。

## 2. 逐个集成点核对（1.2.56 实测）

先跑 `dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory` 得到基线，再用编译出的 `__selectorStyleInternals` 逐项探测。

| # | 集成点（代码位置） | 1.2.56 是否命中 | 证据 |
| --- | --- | --- | --- |
| 1 | 承载 chunk 发现 `selectorPackages()`，`SELECTOR_CHUNK_MARK="chat-input-popup-option"` | ✅ 两个 package | 新行组件仍用类名 `"chat-input-popup-option kiro-model-panel-option"` |
| 2 | 选项行 `ORIG_JS_PATTERN` | ❌ 0 次（两份） | 全文只剩 AgentSelector 一处 `className:"chat-input-popup-option"`。模型行改为 `function Xke(t){const e=ne.c(47),{item:n,rowId:r,isSelected:s,isActive:i,rowRef:o,itemProps:l}=t,{option:c,matches:u}=n,{name:d,description:f}=c;…b.jsxs("div",{id:r,ref:o,className:"chat-input-popup-option kiro-model-panel-option",…,...l,children:[O,D]})…}a(Xke,"ModelOptionRow");`，description 渲染为 `b.jsx("span",{id:`${r}-description`,className:"kiro-model-panel-option-description",children:f})` |
| 3 | 菜单容器 `ORIG_MENU_PATTERN` | ❌ 0 次 | 新容器是 `className:"chat-input-popup-menu kiro-model-selector-popup",role:"dialog"`，列表是 `role:"listbox",className:"kiro-model-selector-list"`（在 `Zke` / `"ModelPanel"` 里） |
| 4 | 选中项 ref `ORIG_REF_PATTERN`（窗口限定） | ❌（窗口基准没了） | 新的是 `rowRef:a(F=>{p.current[$]=F},"rowRef")`。面板自带 `revealRow` 滚动 |
| 5 | 触发器 `ORIG_TRIGGER_PATTERN`（通道 B，现在只做还原） | 不适用 | 出厂是 `className:"model-selector-trigger",disabled:t||o.length===0`，与模板 `r.length` 不同。只影响清理旧残留，不需要改 |
| 6 | 弹层函数 `findPopoverFactory`（`POPOVER_FACTORY_BODY_CANON`） | ❌ → 修匹配器后 agent-chat ✅ | token 数相同（1088/1088），唯一冲突是 `c→c`（`.c` 属性）对 `c→u`（局部变量）。成员名改为字面量后 agent-chat 命中 `fn=Ake warn=Cke tagger=a jsx=b`。session-details 仍 0 命中：模板串插值 `${g}%` 对 `${v}%` 不同，加上 jsx=`x` 被现有守卫拦下，见 D3 |
| 7 | 弹层调用处 `ORIG_POPOVER_CALL_PATTERN` | ✅ 两份各 1 次 | `K=g&&b.jsx(Ake,{livePercentage:i,…,summarizationThreshold:o})`（在 `Lke`/`"ContextUsageIndicator"` 里） |
| 8 | 弹层 store 名 `POPOVER_STORE_NAME="n"` | ✅（agent-chat） | `Lke(){const t=ne.c(38),e=Ni(),n=xp(e,Oke)…`，其中 `Oke=a(t=>t.contextUsage,"contextUsageSelector")`；`Ske(t){const e=t?.breakdown…}` 的字段 `yourPrompts/kiroResponses/sessionFiles/tools/contextFiles` 不变 |
| 9 | `resolveTaggedName(…,"useSessionConfig")` | ✅ | agent-chat `a(zg,"useSessionConfig")`，session-details `o(d4,"useSessionConfig")`。返回值 `[o,h,d]` 的第 2 项 `h(m,g)` 仍是 fire-and-forget 的 setter，与 `const[a2kCfg,a2kSetCfg]=l0()` 兼容 |
| 10 | Ctx 下拉 `findEffortSelector`（`"EffortSelector"` 标签） | ❌ 0 次（两份） | 组件被删。可替代的锚点：`a(rve,"ModelSelector")`/`o(jje,"ModelSelector")`，调用处在 `chat-input-bottom-row-left`：`b.jsx(rve,{disabled:ue})`/`x.jsx(jje,{disabled:de})`，各唯一。原型已注入并通过 `node --check`，往返一致 |
| 11 | 后端 setter `findBackendHook`（`BACKEND_HOOK_RE` + `.getAvailableModels()`） | ✅ | `{"fn":"d$e","store":"uye"}`。日志实打 `hooked … bridge` |
| 12 | 通道 A `refreshWithOutcome` | 静态 ✅ | `refreshWithOutcome` 在 extension.js 里出现 4 次。没在真机触发过，未验证 |
| 13 | 宿主转发 `findHostConfigOptionFn`（`CTX_HOST_LITERAL`） | ✅ | `async function D4s(t,e,r){…executeCommand("kiro.agentModels.setLastSelectedModel",{modelId:r})…n.setSessionConfigOption(s)…}`。日志 `host=applied` |
| 14 | 命令 `kiro.agentModels.setLastSelectedModel`（`sidebar.ts:1111`） | ✅ | `ar("kiro.agentModels.setLastSelectedModel",Yih)` 已注册 |
| 15 | 命令 `kiro.agentModels.getEffortLevel`（`effort.ts:99`） | ⚠️ 不存在 | 1.2.56 里 0 次。代码已 try/catch，先用请求体里的档位，可以容忍，不改 |
| 16 | `kiroAgent.focusChatInput` / `kiroAgent.mcp.enable` / `.reconnectServer` / `.showLogs` / `kiroAgent.openUserMcpConfig` / `.openWorkspaceMcpConfig` | ✅ | kiro-agent `package.json` 各有声明 |
| 17 | 设置 `codewhisperer.config.{endpoints,krsEndpoints,cpsEndpoints}`（`endpoints.ts`） | ✅ | `udn(t){let e=…getConfiguration("codewhisperer.config");return f1p(e.inspect(t),e.get(t),isTrusted)}`，不受信任时只认 globalValue。我们写 Global，兼容。日志：CPS 实际收到模型请求，KRS 收到 MCP 调用 |
| 18 | CPS 模型字段到 webview 的透传 | ✅ | `Imp(t)` 生成 `{value:r.id,name:r.name,description:r.description??void 0,_meta:{kiro:{rateMultiplier,hasEffort,effortLevels…}}}`。所以**微格式会原样到达新面板** |
| 19 | KRS 路由 | ✅ 有 1 个未知请求 | `KRS unhandled: POST /` 出现 1 次，内容不明（日志没记 `x-amz-target`）。回的是 `{}`，没看到连带报错 |
| 20 | `extensionDependencies: ["kiro.kiroAgent"]` 同宿主 | ✅ | `Placing extension(s) kiro.kiroAgent, api2kiro-dual.api2kiro-dual on a separate extension host.` |

## 3. 设计决策（每条 1–2 句理由）

- **D1：新增「1.2 代模型面板」补丁路径（v2），v1 一行不删。** `applySelectorScript` 先试 v1（现有的选项行、菜单、ref），v1 不中再试 v2。1.1.x 上 v1 命中，行为和以前逐字一样。1.2.56 上 v1 是 0 命中（已实测），v2 才会生效。两代锚点不会同时出现。
- **D2：v2 不重写 React Compiler 的记忆化组件，只改它的 props。** 在 `function <Row>(<p>){` 后面插一句 `<p>=a2kRowFix(<p>);`，在 `<h>(<Row>,"ModelOptionRow");` 后面插入 `a2kRowFix` 的定义。行组件里唯一的 hook `ne.c(47)` 的调用次序因此不变。只认 displayName 标签、函数头和 jsx 运行时名，不依赖任何局部压缩名。
  - `__A2K_GRP__` 行：`itemProps` 换成 `{"aria-disabled":"true","data-a2k-grp":"1",onClick:阻断}`，description 换成 `a2k-card-head` 节点。
  - `__A2K_MDL__` 行：description 换成能力徽章节点，没有徽章时就是 `void 0`。
  - 其他行原样返回。
- **D3：session-details 的 Context Usage 弹层在 1.2.56 上保持原生。** 它的 jsx 运行时是 `x`，现有守卫只允许 `b`（ARCHITECTURE「已知限制」）。另外模板串插值里的名字也漂了。要改得同时改写入侧和还原侧，而且模板局部名 `x` 会撞名，不便宜。agent-chat 那份照常注入。
- **D4：分组标题不可选中，靠在 `useModelSelector` 的 `writeModel` 入口加守卫来保证。** 键盘 Home+Enter 能落到第 0 行，而第 0 行就是分组标题，只靠行级 `onClick` 阻断挡不住。守卫锚点是唯一字面量 `},"writeModel")`，以及紧挨在前面的 `<p>=>{<p>!==`。它和 D2 的两处同属全有或全无（三处全中才写）。
- **D5：Ctx 下拉挂在 ModelSelector 触发器右边。** EffortSelector 没了以后，`"ModelSelector"` 标签加 `<jsx>.jsx(<fn>,{disabled:<v>})` 这个调用形状和原来完全一样，现有模板、还原正则（`CTX_CALL_RESTORE_RE` 不限函数名）和 P15 渲染测试都能直接复用。放进面板的 Effort 区要多锚好几处，不划算。
- **D6：匹配器修正适用于所有代。** `.` 后面的属性名（`...` 展开除外）一律当字面量 token，因为压缩器从不改属性名。这样 `verifyTokens` 更严格（属性名必须逐字相同），`renderIdentifierMap` 也不会再误改 `.c`、`.jsx` 这类属性。对 1.1.x 只是让 `namesCollide` 少拦一些（属性名本来就不会造成遮蔽）。
- **D7：v2 不打菜单宽度、resize、选中滚动这三项补丁。** 新面板自己管宽度（浮层中间件写 `width:min(avail,420)px`），自己做 `revealRow` 滚动。CARD_CSS 里 v1 的菜单规则只认 `.a2k-model-selector-menu`，在 1.2 上不生效也无害。v2 的样式全部加在 `data-a2k-grp` 和 `.a2k-caps-box` 作用域下。
- **D8：1.1.x 兼容性只能用合成夹具证明（这一点须明确告知用户）。** 本机没有 1.1.14 的安装或副本。验证脚本新增 P23，按 1.1.14 实测的改名表把规范模板渲染成「1.1.x 形态」，断言 v1 全链路（选项行、菜单、ref、弹层、Ctx）能打上并逐字往返。这能覆盖本次唯一改到 v1 路径的地方，也就是 D6 的分词变化。真实 1.1.14 bundle 上的回归没跑。
- **D9：版本号 4.13.63 → 4.13.64**，沿用每次适配 Kiro 都升补丁号的做法（4.13.59、4.13.63）。不改配置项，所以不用重新生成 `docs/CONFIGURATION.md`。
- **D10：依赖用 `npm ci` 装进 worktree**（按 lockfile 锁定版本，CONTRIBUTING 就是这么写的）。不用软链：`.gitignore` 里的 `node_modules/` 带尾斜杠，只匹配目录，名为 node_modules 的软链会被当成未跟踪文件，容易误提交。

## 4. 实施计划

约定：
- 所有路径都在 worktree 里，用绝对路径。git 一律用 `git -C <repo>/.worktrees/kiro-1.2.56-compat`。
- 不碰 `/Applications/Kiro.app`，不往 Kiro 里装 vsix。
- 只在本地提交，不 push。提交信息用 Conventional Commits，见 CONTRIBUTING。

下文 `W=<repo>/.worktrees/kiro-1.2.56-compat`，`FX=/tmp/kiro-1.2.56-factory`。

- [ ] 1. **装依赖并确认基线**
      在 `$W` 里跑 `npm ci`。
      Files: 无（`node_modules/` 已被忽略）
      Verify:
      - `cd $W && npm run compile` 退出码 0。
      - `node dev/verify-selector-patch.js $FX` 输出 FAIL（这是基线，P1 选项行 0 次，之后崩在 P16 的 `fac.start`）。
      - `$FX` 不存在时先按 §5 重建。

- [ ] 2. **匹配器：成员访问的属性名当字面量（D6）**
      在 `src/selectorStyle.ts` 的 `codeTokens()` 的 `pushCode` 里：标识符紧跟在 `.` 之后、且 `.` 前面不是 `.`（排除 `...x` 展开）时，按 `isIdent:false` 推入。写法：
      ```ts
      const member = at > 0 && text[at - 1] === "." && !(at > 1 && text[at - 2] === ".");
      out.push({ isIdent: !member, text: m[0], at });
      ```
      同步更新 `codeTokens`、`verifyTokens`、`renderIdentifierMap` 的注释：属性名不可压缩，不参与改名映射。附上 1.2.56 的实例，`ne.c(30)` 的 `.c` 与局部 `style:c→u` 对调。
      Files: `src/selectorStyle.ts`
      Verify:
      - `npm run compile` 通过。
      - `node dev/verify-selector-patch.js $FX` 中，`P1b 至少一个 package 的弹层函数可命中` 与 `P16 agent-chat 命中弹层工厂` 两项变为 PASS。其余项仍可能 FAIL，第 5 项会改脚本。

- [ ] 3. **Ctx 下拉锚点回退到 ModelSelector（D5）**
      新增常量：
      ```ts
      const CTX_MODEL_SELECTOR_TAG_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),"ModelSelector"\);/g;
      ```
      `findEffortSelector()` 先按 `CTX_EFFORT_TAG_RE` 找。**只在 EffortSelector 命中 0 次时**改用 ModelSelector 标签，仍要求恰好 1 处。不改返回结构。
      更新 `CTX_CALL_*` 与 A2kContextSelector 的注释：1.2 起挂在 ModelSelector 旁。
      在 `__selectorStyleInternals.matchers` 里导出 `CTX_MODEL_SELECTOR_TAG_RE`。
      Files: `src/selectorStyle.ts`
      Verify:
      - `npm run compile` 通过。
      - `P15 kiro-ui-agent-chat 能注入 Ctx 下拉` 与 `P15 kiro-ui-session-details 能注入 Ctx 下拉` 变为 PASS。
      - 「调用处已接线」要等第 4 项完成才会通过。

- [ ] 4. **v2 模型面板行补丁 + 选择守卫 + 样式 + 还原（D1/D2/D4/D7）**，依赖第 2 项
      全部在 `src/selectorStyle.ts`：
      a) 新增常量：
         - `ROW_START="/*a2k-row:start*/"`、`ROW_END="/*a2k-row:end*/"`、`ROW_FIX_FN="a2kRowFix"`
         - `ROW_SEGMENT_RE=/\/\*a2k-row:start\*\/[\s\S]*?\/\*a2k-row:end\*\//g`、`ROW_SEGMENT_MAX=12000`
         - `ROW_TAG_RE=/(?<![\w$.])([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),"ModelOptionRow"\);/g`
         - `WRITE_MODEL_TAG='},"writeModel")'`、`ROW_FIX_CANON=["b"]`
         - `ROW_FIX_TEMPLATE`：TS 模板字面量，插 `SVG_OPENAI/SVG_BRAIN/SVG_IMAGE`。jsx 用规范名 `b`，自有标识符全部加 `a2k` 前缀。**模板里不许出现正则字面量**（`codeTokens` 不识别正则，里面的引号会把分词搞乱），转义用 split/join。内容如下：
           ```
           function a2kRowFix(a2kP){try{const a2kItem=a2kP&&a2kP.item,a2kOpt=a2kItem&&a2kItem.option,a2kD=a2kOpt&&a2kOpt.description;if(typeof a2kD!=="string"||!a2kD.startsWith("__A2K_"))return a2kP;const a2kEsc=a2kS=>String(a2kS==null?"":a2kS).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");const a2kParts=a2kD.split("|");if(a2kParts[0]==="__A2K_GRP__"){let a2kLogo="";try{if(a2kParts[5])a2kLogo='<span class="a2k-logo">'+atob(a2kParts[5])+"</span>"}catch(a2kE){}if(!a2kLogo)a2kLogo=a2kParts[4]==="openai"?'<span class="a2k-logo">${SVG_OPENAI}</span>':'<span class="a2k-logo">'+a2kEsc(a2kParts[3]||"P")+"</span>";return{...a2kP,isSelected:!1,isActive:!1,itemProps:{"aria-disabled":"true","data-a2k-grp":"1",onClick:a2kEv=>{a2kEv&&a2kEv.preventDefault&&a2kEv.preventDefault();a2kEv&&a2kEv.stopPropagation&&a2kEv.stopPropagation()}},item:{...a2kItem,option:{...a2kOpt,description:b.jsx("span",{className:"a2k-card-head",dangerouslySetInnerHTML:{__html:'<span class="a2k-chev">▼</span>'+a2kLogo+'<span class="a2k-title">'+a2kEsc(a2kParts[1])+'</span><span class="a2k-count">'+a2kEsc(a2kParts[2])+" ↑</span>"}})}}}}if(a2kParts[0]==="__A2K_MDL__"){const a2kCaps=(a2kParts[1]==="1"?'<span class="a2k-cap a2k-cap-reason" title="推理">${SVG_BRAIN}</span>':"")+(a2kParts[2]==="1"?'<span class="a2k-cap a2k-cap-vision" title="图片">${SVG_IMAGE}</span>':"");return{...a2kP,item:{...a2kItem,option:{...a2kOpt,description:a2kCaps?b.jsx("span",{className:"a2k-caps-box",dangerouslySetInnerHTML:{__html:a2kCaps}}):void 0}}}}return a2kP}catch(a2kErr){return a2kP}}
           ```
           `a2k-group:` 前缀必须与 `src/modelStore.ts:150` 的 `GROUP_HEADER_PREFIX` 一致。只在注释里引用它，**不要 import**：selectorStyle 目前只依赖 fs/path/vscode/log。
      b) `findModelPanelRow(content)`，返回 `{fn,param,jsx,bodyStart,tagEnd,guardAt,guardParam}|null`：
         - `ROW_TAG_RE` 必须恰好 1 处，得到 `fn` 与 `tagEnd`。
         - ``new RegExp(`(?<![\\w$.])function ${escapeRe(fn)}\\((${IDENT_SRC})\\)\\{`,"g")`` 必须恰好 1 处，且在标签之前、距离 ≤ 20000。得到 `param` 和 `bodyStart`。
         - 函数体（`bodyStart` 到标签之间）必须包含 `className:"chat-input-popup-option`。函数体里所有 `(?<![\w$.])(IDENT)\.jsxs?\(` 的接收者去重后必须恰好 1 个，就是 `jsx`。
         - 全文 `WRITE_MODEL_TAG` 必须恰好 1 处。在它前面 400 字符窗口里取最后一个 `(?<![\w$.])IDENT\((IDENT)=>\{`，得到 `guardParam` 和 `guardAt`（`{` 之后的位置），并要求 `content.startsWith(`${guardParam}!==`, guardAt)`。
         - 任一条件不满足就返回 null。
      c) `applyModelPanelRow(content): string|null`。三段从后往前拼，要么全写，要么返回 null：
         - 先查 `namesCollide(ROW_FIX_TEMPLATE, ROW_FIX_CANON, [jsx])`，为真则返回 null。
         - 在 `tagEnd` 处插 `ROW_START + renderTemplate(ROW_FIX_TEMPLATE, ROW_FIX_CANON, [jsx]) + ROW_END`。
         - 在 `bodyStart` 处插 `` `${ROW_START}${param}=${ROW_FIX_FN}(${param});${ROW_END}` ``。
         - 在 `guardAt` 处插 `` `${ROW_START}if(typeof ${g}==="string"&&${g}.startsWith("a2k-group:"))return;${ROW_END}` ``（`g` 即 `guardParam`）。
         - `restoreModelPanelRow(content)`：删掉所有长度 ≤ `ROW_SEGMENT_MAX` 的 `ROW_SEGMENT_RE` 段。
      d) 重构 `applySelectorScript`：
         - 把现有的选项行、菜单、ref 三段抽成 `applyOptionRowV1(content): string|null`，不中返回 null，函数体逐字搬过去。
         - 新的 `applySelectorScript` 写成：`const rows = applyOptionRowV1(content) ?? applyModelPanelRow(content); if (rows === null) return content;`，之后照旧 `applyPopover` → `applyCtxSelector`。
         - 在 `restoreSelectorScript` 末尾，`restoreCtxSelector` 之后，加 `out = restoreModelPanelRow(out);`。
      e) `SELECTOR_PATCH_MARKS` 加 `"a2kRowFix"`。
      f) 在 `CARD_CSS` 的 `${END}` 之前追加 1.2 面板样式块。只作用于 `[data-a2k-grp="1"]` 与 `.a2k-caps-box`，与 1.1.x 无交集。注释说明 `.a2k-card-head`、`.a2k-logo`、`.a2k-title`、`.a2k-count`、`.a2k-chev`、`.a2k-cap*` 沿用现有规则：
         ```css
         .kiro-model-panel-option[data-a2k-grp="1"]{cursor:default !important;margin:6px 4px 0 !important;padding:4px 8px !important;border-radius:8px 8px 0 0 !important;background:rgba(255,255,255,.035) !important;border:1px solid rgba(255,255,255,.11) !important;}
         .kiro-model-panel-option[data-a2k-grp="1"]:first-child{margin-top:2px !important;}
         .kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-check,
         .kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-header{display:none !important;}
         .kiro-model-panel-option[data-a2k-grp="1"] .kiro-model-panel-option-description{display:block !important;color:inherit !important;opacity:1 !important;}
         .kiro-model-panel-option-description > .a2k-caps-box{margin-top:2px !important;}
         ```
      g) 在 `__selectorStyleInternals` 里导出：matchers 加 `findModelPanelRow`、`applyModelPanelRow`、`restoreModelPanelRow`、`ROW_START`、`ROW_END`、`ROW_FIX_FN`、`ROW_SEGMENT_RE`；patterns 加 `ROW_FIX_TEMPLATE`。
      h) 更新 `syncGroupHeaderStyleUnlocked` 与 `planModelSelectorScript` 里的 unavailable detail：两代锚点都不中时写「选项行（1.1 形态）与模型面板行（1.2 形态 ModelOptionRow）均未命中」。
      Files: `src/selectorStyle.ts`
      Verify:
      - `npm run compile` 通过。
      - 临时跑 `node -e` 调已编译的内部函数，或者直接做第 5 项后跑脚本。期望 `applySelectorScript(出厂)` 在两份 chunk 上都包含 `a2kRowFix` 与 `a2kCtxSel`，agent-chat 那份还包含 `a2k-cu-head`；`restoreSelectorScript(apply(x)) === x`。

- [ ] 5. **验证脚本改成按代判定，并补 v2 / 合成 v1 断言（D8）**，依赖第 2–4 项
      在 `dev/verify-selector-patch.js` 的 `main()` 开头加两个辅助：
      ```js
      const gen = (t) => M.matchMasked(t, P.ORIG_JS_PATTERN) ? "v1" : M.findModelPanelRow(t) ? "v2" : "none";
      const isPatched = (t) => t.includes("a2k-model-name-box") || t.includes(M.ROW_FIX_FN);
      ```
      逐节修改：
      - **P1**：去掉写死的 `n2e/t2e`，只断言 `!!fac`，并打印 `fac.names`。选项行与菜单两项只在 `gen(chat)==="v1"` 时跑；v2 改为断言 `findModelPanelRow(chat)` 非 null。「EffortSelector 调用处命中」改名为「EffortSelector/ModelSelector 调用处命中」。
      - **P1b**：每个 package 按 `gen` 跑 v1 两项，或者 v2 一项 `findModelPanelRow` 非 null。
      - **P13、P11、P16「弹层跳过不影响三处选择器补丁」、P18、P20**：所有 `includes("a2k-model-name-box")` 换成 `isPatched(...)`。
      - **P14**：v1 的 package 照旧做 `renderMatched` 断言；v2 的 package 断言 `M.applyModelPanelRow(factory)!==null`。
      - **P20 的 chunk 级破坏**：v1 照旧替换 `className:"chat-input-popup-option"`；v2 改为把 `"ModelOptionRow"` 替换成 `"ModelOptionRowX"`。Ctx 的破坏同时把 `"EffortSelector"` 和 `"ModelSelector"` 都替换成 `…Renamed`。
      - **P4 的常量表**：加入 `I.patterns.ROW_FIX_TEMPLATE`、`M.ROW_START`、`M.ROW_END`。
      - **P21（新增，每个 v2 package 各跑一遍）**：
        - 取出 `applyModelPanelRow(factory)` 里以 `ROW_START+"function a2kRowFix("` 开头的那一段，去掉两端标记。
        - 用 `new Function(jsx, seg+"\nreturn a2kRowFix;")(jsxStub)` 求值（复用 P15 的 jsxStub，jsx 名取 `findModelPanelRow(factory).jsx`）。
        - 普通 props（description 为 `""` 或 undefined）原样返回，且 `===` 原对象。
        - `__A2K_GRP__|<img onerror=x>|3|O|openai|` 输出 `itemProps["aria-disabled"]==="true"`、`itemProps["data-a2k-grp"]==="1"`，description 节点的 className 为 `a2k-card-head`，`__html` 里含 `&lt;img` 且不含 `<img onerror`。
        - 它的 `itemProps.onClick(stubEvent)` 调用了 `preventDefault` 和 `stopPropagation`。
        - `__A2K_MDL__|1|0|272000|32768~codex~1~272000~codex|0` 输出 className 为 `a2k-caps-box`，含 `a2k-cap-reason`，不含 `a2k-cap-vision`。
        - `__A2K_MDL__|0|0|272000|…|0` 输出的 description 是 `undefined`。
      - **P22（新增，v2）**：打补丁后的文本里，`},"writeModel")` 之前存在 `` `${g}=>{${ROW_START}if(typeof ${g}==="string"&&${g}.startsWith("a2k-group:"))return;${ROW_END}${g}!==` ``（`g`=`findModelPanelRow(factory).guardParam`）。
      - **P23（新增，合成 1.1.x 夹具，不依赖真机）**：
        - 用 `M.renderTemplate(text, canon, actual)` 按 1.1.14 实测改名表生成文本：
          - 选项行、菜单、ref 共用 `{E:"w",R:"I",O:"N"}`。
          - 弹层用 `{Bde:"n2e",re:"ne",Pde:"t2e",E:"w",R:"I",O:"N",I:"R",B:"$",z:"H"}`。
          - 调用处用 `renderTemplate(ORIG_POPOVER_CALL_PATTERN,["Bde","Y"],["n2e","q"])`。
          - 再拼上 `a(E0,"useSessionConfig");a(x2e,"EffortSelector");b.jsx(x2e,{disabled:K})`。
          - 拼接顺序：`menu + "," + ref + "," + row + ";" + popover + ";" + call + ";" + 标签们`。ref 必须落在选项行之前 2000 字符以内。
        - 断言：
          - `gen(syn)==="v1"`。
          - `applySelectorScript(syn)` 含 `a2k-model-name-box`、`a2k-model-selector-menu`、`a2kScrolled`、`a2k-cu-head`、`a2kCtxSel`，且不含 `a2kRowFix`。
          - `restoreSelectorScript(applied)===syn`。
          - 对 restore 后的结果再 apply 一次，与第一次 apply 的结果相同。
        - 1.2.56 回归：弹层模板按 `{Bde:"Ake",re:"ne",Pde:"Cke",u:"c",c:"u"}` 改名后，`findPopoverFactory` 非 null 且 `names.fn==="Ake"`。这一条在第 2 项修好之前必然失败。
      - 文件头注释：版本说明从 4.13.59/1.1.14 更新为「1.1.x（v1）与 1.2.x（v2）两代」。
      Files: `dev/verify-selector-patch.js`
      Verify: `node dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory` 最后一行 0 FAIL，且没有 `verification crashed`。

- [ ] 6. **KRS 未处理请求记下 `x-amz-target`**（诊断用，对应 §2 #19）
      `src/krsServer.ts` 的 `info("KRS unhandled:", method, path)` 改为同时输出 `x-amz-target` 或 `x-amzn-target` 头的值，有才输出，写法同 `cpsServer.ts:393`。不改响应。
      Files: `src/krsServer.ts`
      Verify: `npm run compile` 通过。

- [ ] 7. **文档与版本（D9）**
      - `package.json` 的 `"version"` 改为 `4.13.64`；`package-lock.json` 第 3 行和第 9 行的 `"version"` 同步改。
      - `README.md`：
        - 第 11 行徽章改成 `1.0.411 – 1.2.56`。
        - 第 63 行验证版本加上 1.2.56，并补一句「1.2 起模型选择器改为带搜索的模型面板，补丁按两代结构分别适配」。
        - 「Kiro 前端补丁（重要）」一节，靶文件表的 mermaid 行改为「模型选择器组头 / 能力徽章（1.1 选项行；1.2 模型面板行）、Context Usage 弹层、Ctx 下拉（1.1 在 Effort 旁，1.2 在模型触发器旁）」。
        - 同一节新增一条 4.13.64 说明：三个成因（§0）；session-details 弹层在 1.2.56 保持原生；与 kiro-proxy 同时启用会争抢端点与同一份 chunk。
      - `docs/ARCHITECTURE.md`：
        - 「Kiro 前端补丁」靶文件表与上面同步。
        - 新增「1.2.56 起两代靶点」段：v1/v2 的判定顺序；v2 三处插入点，即函数头、标签后、writeModel；`a2k-row` 定界与还原。
        - 「已知限制」第 137 行改成「1.0.411 / 1.0.437 / 1.1.14 / 1.2.56」，项数以脚本自报为准；加一条「1.2.56 session-details 弹层保持原生（jsx=`x`）」和「1.1.x 本轮只有合成夹具回归（P23）」。
        - 「结构匹配」一条补一句：成员访问的属性名按字面量处理。
      Files: `package.json`、`package-lock.json`、`README.md`、`docs/ARCHITECTURE.md`
      Verify: `npm run compile` 通过；`node -p "require('$W/package.json').version"` 输出 `4.13.64`。

- [ ] 8. **整体验证**，依赖 1–7
      ```bash
      cd <repo>/.worktrees/kiro-1.2.56-compat
      npm run compile
      npm_config_yes=true npm run package            # 生成 api2kiro-dual-4.13.64.vsix（*.vsix 已被 gitignore）
      python3 - <<'PY'                               # 复刻 CI 的密钥检查
      import glob,re,sys,zipfile
      v=glob.glob("*.vsix"); assert len(v)==1, v
      real=re.compile(rb"GOCSPX-[A-Za-z0-9_-]{10,}")
      hits=[n for n in zipfile.ZipFile(v[0]).namelist() if real.search(zipfile.ZipFile(v[0]).read(n))]
      print("hits",hits); sys.exit(1 if hits else 0)
      PY
      node dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory   # 纯出厂 1.2.56：0 FAIL
      node dev/verify-selector-patch.js                            # 真机只读副本（带 kiro-proxy 残留）：0 FAIL
      node dev/verify-opencode-session.js                          # 不相关模块的回归：VERIFY OK
      ```
      期望全部退出码 0。`git -C $W status --short` 里只有计划内的文件。
      `dev/measure-latency.mjs` 是只读的账本测量工具，与本任务无关，不用跑。

## 5. 夹具重建（`/tmp/kiro-1.2.56-factory` 丢失时）

```bash
A=/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent; F=/tmp/kiro-1.2.56-factory/extensions/kiro.kiro-agent
rm -rf /tmp/kiro-1.2.56-factory; mkdir -p $F/dist
for p in kiro-ui-agent-chat kiro-ui-session-details; do mkdir -p $F/packages/$p/dist/assets; cp $A/packages/$p/dist/style.css $F/packages/$p/dist/; cp $A/packages/$p/dist/assets/mermaid-*.js $F/packages/$p/dist/assets/; done
B=$A/packages/kiro-ui-agent-chat/dist/assets/mermaid-GHXKKRXX-CSjtlRpj.js.kiroproxy-bak-1.2.56; [ -f "$B" ] && cp "$B" $F/packages/kiro-ui-agent-chat/dist/assets/mermaid-GHXKKRXX-CSjtlRpj.js
if [ -f $A/dist/extension.js.kiroproxy-bak-1.2.56 ]; then cp $A/dist/extension.js.kiroproxy-bak-1.2.56 $F/dist/extension.js; else cp $A/dist/extension.js $F/dist/extension.js; fi
```

整个过程只读 `/Applications`，只写 `/tmp`。

## 6. 风险与未验证项

- **没在真机上跑过 v2 渲染。** 已核实：v2 补丁后的 chunk 通过 `node --check`，往返还原逐字一致，`a2kRowFix` 用桩 jsx 能求值（P21）。还没核实：在 Kiro 1.2.56 里实际打开模型面板，分组卡片和能力徽章的视觉效果；`aria-disabled` 能否让 floating-ui 的列表导航跳过标题行（即使跳不过，writeModel 守卫也兜底）。合并后需要用户装上 4.13.64 的 vsix，重载窗口，打开模型面板确认一次。
- **通道 A（`refreshWithOutcome`）在 1.2.56 上只做了静态核对**（4 处），没有触发过。
- **草稿会话的 Ctx 覆盖**：在 1.2.56 里，`useSessionConfig` 的 setter 遇到草稿会话（`Wd(r)`）只做本地 `applyDraftPick`，不调宿主，所以新会话还没发第一条消息时选 Ctx，不会转发到扩展。1.1.x 是否也这样没有核实，本轮不处理。
- **1.1.x 回归只覆盖到合成夹具（D8）。**
- **session-details 弹层保持原生（D3）**；**`kiro.agentModels.getEffortLevel` 已从 Kiro 里移除**，现有 catch 能容忍。
- **与 `kiro-proxy.kiro-api-proxy` 同时启用**：两套代理争抢 `codewhisperer.config.*Endpoints`，而且都改同一份 chunk 和 `extension.js`。我们的锚点在它的残留下仍然唯一（已核实），但两套代理不应同时开。这一点只告知用户，不在本任务里处理。
