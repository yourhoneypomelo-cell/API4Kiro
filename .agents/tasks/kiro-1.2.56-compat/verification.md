# Kiro 1.2.56 兼容：验证记录（4.13.64，第 1 轮）

worktree：`/Users/macbkkopro/Documents/API4Kiro/.worktrees/kiro-1.2.56-compat`（分支 `fix/kiro-1.2.56-compat`，基于 `ac64f04`）
目标：Kiro 1.2.56（`/Applications/Kiro.app` product.json：`1.2.56 a9f293869e317e8f9e195227dffceb57fe52a847`）
本轮没有 review.json，是第一轮，按 findings.md §4 第 1–8 项从头实现。

## 跑了什么、结果如何

package.json 的 scripts 只有 `compile`（`tsc --noEmit`）、`bundle`、`package`、`watch`，**没有 lint / test 脚本**。仓库的测试就是 `dev/` 下的验证脚本。

| # | 命令（在 worktree 根目录） | 结果 |
| --- | --- | --- |
| 0 | `npm ci` | 依赖按 lockfile 装好（`node_modules/` 已被 gitignore） |
| 1 | 基线：改代码前跑 `node dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory` | 如预期失败：P14 选项行 0 命中，P15 两份 Ctx 都注入不了，P16 弹层 0 命中，然后在 P16 `fac.start` 崩掉（`verification crashed`） |
| 2 | `npm run compile` | exit 0 |
| 3 | `npm_config_yes=true npm run package` | exit 0，生成 `api2kiro-dual-4.13.64.vsix`（244 个文件，915.39 KB；`*.vsix` 已被 gitignore，没提交） |
| 4 | 复刻 CI 的密钥检查（python 扫 vsix 里的 `GOCSPX-…`） | 244 个条目，`hits []`，exit 0 |
| 5 | `node dev/verify-selector-patch.js /tmp/kiro-1.2.56-factory`（纯出厂 1.2.56 副本） | **175 passed, 0 failed**，exit 0 |
| 6 | `node dev/verify-selector-patch.js`（读真机 `/Applications/Kiro.app`，复制到 /tmp，带着 kiro-proxy 的残留） | **175 passed, 0 failed**，exit 0；两次跑的 PASS 列表逐行相同 |
| 7 | `node dev/verify-opencode-session.js`（无关模块的回归） | `VERIFY OK`，结构断言 6 passed / 0 failed |
| 8 | 只读核对真机：两份 chunk、两份 style.css、`dist/extension.js` | `a2kRowFix` / `a2kCtxSel` / `a2k-model-row` / `__kiroModelConfigProvider` 都是 0 处，mtime 仍是 Oct 8 / Oct 10（改动早于本轮）。**真机没被写过** |

`dev/measure-latency.mjs` 是只读的账本测量工具，与本任务无关，按计划没跑。

### 脚本自报的关键事实（1.2.56）

- 两个 package 的选择器都判为 **v2**（1.2 代模型面板）。
- v2 插入点：agent-chat 是 `fn=Xke param=t jsx=b guard=At`，session-details 是 `fn=Nje param=t jsx=x guard=Ze`。
- 弹层：agent-chat 命中，`{"fn":"Ake","warn":"Cke","local":"O"} tagger=a`。session-details 未命中，按 D3 保持原生（P16 断言「工厂未命中 ⇒ 不注入」）。
- Ctx 下拉：两份都能注入，并且用桩 jsx 和桩 useSessionConfig 真跑过一遍（P15：6 档候选、272K/128K 文案、onChange 发出 `a2k:ctx`、disabled 透传、官方列表不渲染）。
- 打完补丁的两份 chunk 都通过 `node --check`（P13）。`restore(apply(x)) === x` 逐字成立，`apply` 幂等（P5/P6/P9）。
- P21：`a2kRowFix` 用桩 jsx 求值。普通行原样返回同一个对象。分组标题带 `aria-disabled`、`data-a2k-grp`，点击被阻断，HTML 已转义（`&lt;img`，没有 `<img onerror`）。推理徽章正确；没有徽章时 description 为 `undefined`。
- P22：writeModel 守卫紧贴回调头，往返一致。`a2k-group:` 前缀的 id 被拦下，普通模型 id 放行。
- P23：合成的 1.1.x 夹具（按 1.1.14 实测改名表渲染）判为 v1。补丁含 `a2k-model-name-box` / `a2k-model-selector-menu` / `a2kScrolled` / `a2k-cu-head` / `a2kCtxSel`，不含 `a2kRowFix`。往返逐字一致，二次 apply 结果相同。1.2.56 形态的回归（`ne.c(30)` 保持不变、`style:u`）下弹层命中 `fn=Ake`。

## 改了哪些文件

- `src/selectorStyle.ts`
  - D6：`codeTokens` 把成员属性名按字面量处理。
  - D5：`CTX_MODEL_SELECTOR_TAG_RE`，`findEffortSelector` 在 EffortSelector 0 命中时回退到 ModelSelector。
  - D1/D2/D4/D7：v2 常量、`ROW_FIX_TEMPLATE`、`findModelPanelRow`、`applyModelPanelRow`、`restoreModelPanelRow`、`modelPanelGuardText`。`applySelectorScript` 拆出 `applyOptionRowV1`（函数体逐字搬过去），改成 `v1 ?? v2`。`restoreSelectorScript` 末尾删 `a2k-row` 段。`SELECTOR_PATCH_MARKS` 加 `a2kRowFix`。CARD_CSS 追加 1.2 面板样式块。unavailable 的提示文案改成说明两代都没命中。新函数都加进 `__selectorStyleInternals` 导出。
- `dev/verify-selector-patch.js`：按代判定（`gen` / `isPatched`），P1、P1b、P4、P11、P12、P13、P14、P16、P18、P20 随之调整；新增 P21、P22、P23。
- `src/krsServer.ts`：`KRS unhandled` 日志有 `x-amz-target` / `x-amzn-target` 时一并输出，响应不变。
- `package.json`、`package-lock.json`：4.13.63 → 4.13.64。
- `README.md`：徽章改为 1.0.411 – 1.2.56，验证版本加上 1.2.56，靶文件表更新，加 4.13.64 说明（三个成因、session-details 弹层保持原生、与 kiro-proxy 不要同时启用）。
- `docs/ARCHITECTURE.md`：靶文件表更新；新增「1.2.56 起两代靶点」段；结构匹配条目补上属性名规则；已知限制更新（1.2.56 / 175 项、session-details 弹层保持原生、1.1.x 只有合成夹具回归）。

没有单独的 CHANGELOG 文件。版本说明按惯例写在 README 里。

## 实施时偏离计划的地方

- **P23 夹具的拼接顺序**：计划写的是 `…;a(E0,"useSessionConfig");a(x2e,"EffortSelector");b.jsx(x2e,{disabled:K})`，调用处紧贴在 EffortSelector 标签后面。`applyCtxSelector` 会在标签末尾插函数、在调用处做替换，两段起点相同就互相踩，还原后多出半截函数。真机 bundle 里两者相隔很远，不会碰上。所以把调用处挪到标签之前，产品代码不动。
- **P12**（计划里没提）：v2 的锚点不是 `"chat-input-popup-option"` 选项行，所以破坏夹具时同时把 `"ModelOptionRow"` 改名，不然场景构造不出来。
- **P1**：计划要求去掉 1.1.14 写死的 `n2e/t2e` 名字断言，改成打印真机名。照做了。
- **P23 里 1.2.56 弹层那条回归**：计划说这一条在修匹配器之前必然失败。实际上，旧分词下 `renderTemplate` 会把 `.c` 也一并改成 `.u`，合成文本自洽，`findPopoverFactory` 照样能命中，单靠这一条拦不住回归。所以加了一条断言：渲染结果必须含 `ne.c(30)` 和 `style:u,`，也就是真机 1.2.56 的实际形态。旧分词会产出 `ne.u(30)`，这条断言就会失败。真实 bundle 上的证据是基线第 1 步：修之前 P16 在出厂 1.2.56 上 0 命中。

## 只能在运行中的 Kiro 里验证的项（本轮没有覆盖）

- 在 Kiro 1.2.56 里真正打开模型面板，看分组卡片头和能力徽章的视觉效果。依赖的 1.2 面板 CSS 规则只在静态层面核对过。
- `aria-disabled` 能不能让面板的键盘列表导航跳过分组标题行。跳不过也有 writeModel 守卫兜底，P22 只证明了守卫语义。
- Ctx 下拉挂在 ModelSelector 旁边的实际布局，以及选择后经宿主钩子转发到扩展的整条链路。
- 通道 A（`refreshWithOutcome`）在 1.2.56 上只做了静态核对。
- 草稿会话（还没发第一条消息）里选 Ctx 不会转发到宿主（findings §6），本轮不处理。
- 真实 1.1.14 bundle 上的回归没跑（本机没有 1.1.x 副本），只有 P23 合成夹具。
- 与 `kiro-proxy.kiro-api-proxy` 同时启用会争抢端点，也会改同一份 chunk。只在 README 里告知用户，不处理。

需要用户安装 `api2kiro-dual-4.13.64.vsix`，重载窗口，打开模型面板和聊天框确认一次。
