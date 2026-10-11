# Kiro 1.2.56 模型面板（v2）补丁、Ctx 下拉改挂 ModelSelector、属性名不参与结构匹配改名

Kiro 1.2.56 把模型选择器重写成 `ModelPanel` / `ModelOptionRow` / `useModelSelector`，并删掉了 `EffortSelector`。结构匹配器还有个潜伏 bug 这次被触发：成员属性 `.c` 被当成可改名标识符。三件事叠在一起，webview 补丁在 1.2.56 上整个放弃。这次改动新增了第二代（v2）选择器补丁，只往行组件的 props 和 `writeModel` 入口里插代码。Ctx 下拉在 `EffortSelector` 标签 0 命中时回退到 `ModelSelector` 标签。分词器把 `.` 后面的属性名当字面量处理。v1 的函数体逐字搬进了 `applyOptionRowV1`，按「v1 优先、v2 兜底」调用，1.1.x 的行为不变。版本号已升到 4.13.64，文档已同步，验证证据完整。

Watch for：降级到 4.13.63 会把 v2 段留在 Kiro 文件里，关也关不掉（confirmed，非阻塞）。分组标题的键盘导航和视觉效果只做了静态验证，需要在运行中的 Kiro 里手动确认（likely 会有小偏差，非阻塞）。

**Verdict**: APPROVED

## High-level view

v2 只改 props，不碰 React Compiler 的记忆化组件体。三处纯插入都用 `/*a2k-row:*/` 定界：`ModelOptionRow` 函数头之后、标签之后（放 `a2kRowFix` 定义）、`writeModel` 回调头。三处要么全打要么全不打，还原就是删段。锚点只用 displayName 字面量、函数头和唯一字面量 `},"writeModel")`。我在真机 1.2.56 bundle 上抽查过，锚点都与计划引用的字符串一致。

分组标题的不可选中靠两层保护。第一层是行级的 `aria-disabled` 加点击阻断。第二层是 `writeModel` 守卫，它才是真正的兜底：行级替换丢掉了 floating-ui 的列表导航处理器，键盘大概率仍能停在标题行上。

Ctx 回退只在 `EffortSelector` 恰好 0 命中时触发，所以 1.1.x 不会走新分支。分词修正对所有代生效，是这次唯一改到 v1 路径的地方。1.1.x 只有 P23 合成夹具回归，这一点已经如实写进了文档。

<details>
<summary>Issues (3)</summary>

1. **降级残留 v2 段**：4.13.63 的 `restoreSelectorScript` 不删 `/*a2k-row:*/` 段，而它的 `SELECTOR_PATCH_MARKS` 里有 `a2k-card-head`，`a2kRowFix` 模板正好含这个字符串。结果是旧版会把文件当成已打补丁，关闭开关也清不掉。可以在 README 的 4.13.64 说明里加一句「回退旧版前先在本版关闭补丁」，或者接受现状（这些段能自洽运行）。（confirmed，非阻塞）
2. **运行时行为未实测**：以下几项只做了静态验证：分组标题的键盘导航、卡片头和徽章样式、Ctx 下拉的布局与转发链路。装上 4.13.64 vsix 后，在 1.2.56 里打开模型面板，用方向键、Home 和 Enter 各试一次。（likely，非阻塞）
3. **README「已验证」措辞偏强**：README 第 63 行写「已在 … 1.2.56 上验证」，实际只做了文件结构验证。建议改成「按 1.2.56 文件结构验证」，或者手动确认后再保留原句。（confirmed，非阻塞）

</details>

<details><summary>Details</summary>

### v2 锚点与真机 1.2.56 的对照

对 `/Applications/Kiro.app` 的 agent-chat chunk 做了一次只读抽查，结果如下：

- `"ModelOptionRow");` 恰好 1 处，`function Xke(t){` 在它之前约 2.3 KB。
- 函数体里的 jsx 接收者只有 `b`。
- `},"writeModel")` 恰好 1 处，形如 `D=a(At=>{At!==R&&(…)},"writeModel")`。守卫正则取到最后一个 `a(At=>{`，后面紧跟 `At!==`。
- `"EffortSelector");` 0 处，`"ModelSelector");` 1 处，与 D5 的前提一致。

session-details 那份的命中（`Nje` / `x` / `Ze`）以验证脚本自报为准，没有逐字核对。

```
ModelOptionRow(t)                      useModelSelector
  ├─ [a2k-row] t=a2kRowFix(t);           D=a(At=>{ [a2k-row] if(a2k-group:…)return; At!==R&&… },"writeModel")
  ├─ … ne.c(47) 记忆化体不动 …
  └─ jsxs("div",{…,role:"option",…,...l})   ← l = itemProps，展开在显式属性之后
a(Xke,"ModelOptionRow"); [a2k-row] function a2kRowFix(…){…}
```

根 div 在 `role:"option"` 之后才展开 `...l`。所以替换后的 `itemProps` 会覆盖原有的 `onClick`，`data-a2k-grp` 也会落到 CSS 选择器能命中的节点上。

### 分组标题的选中防线

v1 在行级的 `onClick` 和 `onKeyDown` 里都做了拦截。v2 把 floating-ui 的 `itemProps` 整个换成三个键，`onMouseMove`、`onFocus` 这类列表导航处理器随之丢失。悬停标题行不会更新 active index，但用 Home 或方向键大概率仍能落到标题行上（likely）。这时按 Enter 会走 `writeModel`，被守卫拦下，什么都不写。万一守卫也漏了，krsServer 原有的 `isGroupHeaderId` 回落是第三层兜底。

v1 还会阻断「`__A2K_` 且名字为空」的模型行，v2 没有对应逻辑。CPS 生成的 MDL 行总带名字，所以这个差异实际不会触发。这部分只有 P21、P22 的桩测试覆盖。

v2 对分组名和数量做了 HTML 转义，v1 的 `p[1]` 是直接拼进 `__html` 的，这一点比旧路径更稳。base64 图标经 `atob` 解码后不转义，信任模型与 v1 相同：图标来自扩展自己的 CPS。

### 降级与跨版本还原

`planModelSelectorScript` 总是先 `restoreSelectorScript` 再 `apply`，所以 4.13.64 及以后的版本都能清掉旧段。反方向就不行了：4.13.63 及更早的版本不认识 `a2k-row` 段，而它们的 `SELECTOR_PATCH_MARKS` 里有 `a2k-card-head`，`ROW_FIX_TEMPLATE` 正好含这个字符串。结果是旧版认为补丁在位，关闭开关也删不掉这三段（confirmed）。好在这些段自洽，也不依赖扩展进程，后果是关不掉，不会让 Kiro 坏掉。

### 验证证据

verification.md 与提交信息里的结果都具体可查：

- `compile` 和 `package` 退出码均为 0，vsix 密钥扫描 `hits []`。
- 出厂副本和真机副本都是 175 项通过、0 项失败。
- `verify-opencode-session` 输出 VERIFY OK。
- 改动前的基线确实失败。

偏离计划的几处（P23 拼接顺序、P12 破坏方式、P23 新增的 `ne.c(30)` / `style:u,` 断言）都写了理由，而且只动测试夹具。工作区干净，只有计划内的 7 个文件。4.13.64 的说明按惯例写在 README 里，提交信息符合 Conventional Commits。

README 第 63 行把 1.2.56 和其他版本并列为「已验证」，而上面这些证据全部是静态的。ARCHITECTURE 的措辞（「文件结构验证」）是准确的，README 应该与它一致。

Not tested：运行中的 Kiro 1.2.56 里的面板视觉和键盘导航、Ctx 下拉到宿主的完整转发链路、通道 A 的实际触发、真实的 1.1.x bundle。

</details>

<details>
<summary>File map</summary>

- `src/selectorStyle.ts`：v2 常量、模板与查找 / 应用 / 还原；`applyOptionRowV1` 拆分；`codeTokens` 属性名处理；Ctx 的 ModelSelector 回退；1.2 面板 CSS；`SELECTOR_PATCH_MARKS`；unavailable 文案；导出。
- `src/krsServer.ts`：`KRS unhandled` 日志附带 `x-amz(n)-target`。
- `dev/verify-selector-patch.js`：按代判定；调整 P1/P1b/P4/P11–P14/P16/P18/P20；新增 P21–P23。
- `README.md`：徽章、验证版本、靶文件表、4.13.64 说明。
- `docs/ARCHITECTURE.md`：两代靶点一节、结构匹配规则、已知限制。
- `package.json`、`package-lock.json`：4.13.63 → 4.13.64。

完整 diff：`git -C <repo>/.worktrees/kiro-1.2.56-compat diff main...HEAD`

</details>
