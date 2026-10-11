<p align="center">
  <img src="assets/icon.png" width="112" alt="API4Kiro">
</p>

<h1 align="center">API4Kiro</h1>

<p align="center">
  <a href="https://github.com/yourhoneypomelo-cell/API4Kiro/releases/latest"><img src="https://img.shields.io/github/v/release/yourhoneypomelo-cell/API4Kiro?label=release&color=7c3aed" alt="Release"></a>
  <a href="https://github.com/yourhoneypomelo-cell/API4Kiro/actions/workflows/ci.yml"><img src="https://github.com/yourhoneypomelo-cell/API4Kiro/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/yourhoneypomelo-cell/API4Kiro/releases"><img src="https://img.shields.io/github/downloads/yourhoneypomelo-cell/API4Kiro/total?color=7c3aed" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Kiro-1.0.411%20%E2%80%93%201.2.56-7c3aed" alt="Kiro">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yourhoneypomelo-cell/API4Kiro" alt="License"></a>
</p>

把多家 API 聚合接入 [Kiro](https://kiro.dev) IDE：厂商账号登录（Kimi / Codex / xAI / Antigravity / Anthropic / Kiro 官方多账号）、第三方 Key、自定义端点（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses / Gemini 四种格式）；所有渠道的模型合并进 Kiro 的模型选择器、按模型自动路由，支持 Key 池轮换与冷却、思考档位、模型测活、本地用量账本、Context Usage 真实窗口、提示词注入，改动无需重载即静默同步到 Kiro。

> 本项目是 [SunNorthGod/API2Kiro](https://github.com/SunNorthGod/API2Kiro) 的多渠道演进版（"dual" 起步，现为 N 渠道聚合），MIT 许可。

---

## 目录

- [快速开始](#快速开始)
- [接入方式](#接入方式)
- [侧边栏面板](#侧边栏面板)
- [多渠道路由与 Key 池](#多渠道路由与-key-池)
- [思考档位](#思考档位)
- [用量与上下文](#用量与上下文)
- [稳健性](#稳健性)
- [Kiro 前端补丁（重要）](#kiro-前端补丁重要)
- [命令面板](#命令面板)
- [配置项](#配置项)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [文档](#文档)
- [从源码构建](#从源码构建)
- [致谢](#致谢)
- [许可证](#许可证)
- [重要免责声明](#重要免责声明)

## 快速开始

```bash
# 1. 到 Releases 下载最新 api2kiro-dual-<version>.vsix
#    https://github.com/yourhoneypomelo-cell/API4Kiro/releases/latest
# 2. 安装（也可在 Kiro 扩展面板右上角 ··· → 「从 VSIX 安装」）
kiro --install-extension api2kiro-dual-<version>.vsix --force
# 3. Kiro 内 Ctrl/Cmd+Shift+P → Developer: Reload Window
```

> 装过原版 API2Kiro 的用户：两者共用 Kiro 的 `codewhisperer.config.*Endpoints`，同一时间只能有一个生效。请在扩展视图里**禁用或卸载**原版，再启用本扩展——仅把原版的 `api2kiro.enabled` 设为 `false` 不够：原版在关闭状态下每次激活仍会清掉本扩展写入的端点（对称问题：本扩展 4.13.53 起只清自己写的端点，不再碰原版或手写的）。端口已错开（本扩展 19810 / 19811，原版 19800 / 19801）。
>
> 禁用或卸载本扩展前，请先在「设置」页关闭「启用代理」，否则 Kiro 会保留指向已停止本地服务的端点；若已经停用，重新启用本扩展后关闭代理，或手动删除 `settings.json` 里 `codewhisperer.config.endpoints` / `krsEndpoints` / `cpsEndpoints` 三键即可。

三步接入：

1. 点击活动栏的 API4Kiro 图标 → **提供商** 页 → 添加渠道（账号登录 / API Key / 自定义端点，或从 CC Switch 一键导入）
2. **模型** 页勾选要进入 Kiro 的模型（严格 opt-in，未勾选的不会出现在 Kiro 里）
3. **设置** 页打开「启用代理」→ 按提示重载窗口一次

之后增删模型、调整顺序都会静默同步到 Kiro 右侧的模型选择器，不再需要重载。

> 需要 Kiro IDE（本扩展声明依赖内置的 `kiro.kiroAgent`），纯 VS Code 中不会激活。已在 Kiro 1.0.411 / 1.0.437 / 1.1.14 / 1.2.56 上验证（1.1.14 起 Kiro 把聊天界面拆到 `kiro-ui-session-details`，两份 chunk 各自独立压缩，补丁逐份覆盖；1.2 起模型选择器改为带搜索的模型面板，补丁按两代结构分别适配）。

## 接入方式

| 方式 | 适用 | 凭证存放 |
| --- | --- | --- |
| **厂商账号登录（OAuth）** | Kimi、Codex（OpenAI）、xAI、Antigravity（Google）、Anthropic（Claude）、Kiro 官方多账号 | 系统钥匙串（VS Code SecretStorage），不落盘到设置文件 |
| **第三方 API Key** | 中转站、官方 Key；同一渠道可放多把 Key 组成 Key 池 | `api2kiroDual.providers` 设置项 |
| **自定义端点** | 任意 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses / Gemini generateContent 兼容服务 | 同上 |
| **从 CC Switch 导入** | 只读解析 `~/.cc-switch/cc-switch.db`，把 [CC Switch](https://github.com/farion1231/cc-switch) 里配好的供应商一键转成渠道 | 同上 |

每个渠道可单独设置：协议与子模式（`anthropic` 的 kiro 深度兼容 / official 直通；`openai` 的 chat / responses）、精确前缀 `exactBase`、模型 ID 映射 `modelMapping`、能力覆盖 `modelOverrides`（图片 / 推理）、白名单 `enabledModels`、兜底模型、Logo。面板里还能对草稿渠道**测延迟 / 拉取模型 / 测活**（并发 3，可达但报错的用黄色标出）。

少数渠道还要求客户端自带特定请求头，本扩展自动补上、无需手配 —— **OpenCode Go**（`opencode.ai/zen/go`）要求 `x-opencode-session`，否则一律 400 `Request is missing x-opencode-session and cannot be routed efficiently`，于是填对 Key 也连不上（**4.13.62** 修）。会话 id 由「安装级随机前缀 + Kiro 的会话 id」拼成：同一会话每轮一致（上游靠它做路由亲和与提示缓存），不同会话 / 不同安装互不相同；同时在发往该通道的请求上补一个自报家门的 `User-Agent`（Node 的 `http` 默认不发 UA，之前在上游眼里是匿名客户端）。同域另一条通道 Zen 本体（`opencode.ai/zen/v1`）不需要这个头，不会被顺带发过去。命中判断认端点（预设 `md:opencode-go`，或 host 为 `opencode.ai` 且路径为 `/zen/go`），所以预设地址被改到自建中转时同样生效；纯手填的**其它域名**中转不在命中范围内。

> **凭据去向受控**：代理开关与含 Key / 端点的设置项（`enabled`、`providers`、`apiKey`、`baseUrl`、`officialBaseUrl`、`officialApiKey`、`openaiBaseUrl`、`openaiApiKey`、`usagePath`）只在**用户设置**里生效，仓库里的 `.vscode/settings.json` 不能覆盖它们，也不参与 Settings Sync。OAuth 渠道的账号 token 默认只发往厂商规格地址（登录时写入的 `baseUrl` 所在主机，如 `api.anthropic.com`、`chatgpt.com`、`runtime.<region>.kiro.dev`）；`baseUrl` 被改到别的主机时不发 token、该渠道显示为不可用并说明原因。确需经自建中转转发，在用户设置里给该渠道加 `"allowCustomHost": true`。本扩展不支持受限模式（未信任）工作区——信任工作区后才会激活。

## 侧边栏面板

| 页面 | 说明 |
| --- | --- |
| **提供商** | 渠道增删改、拖拽排序（支持滚轮与边缘自动滚动）、连接测试、Key 池管理、从 CC Switch 导入、Logo 图库 |
| **模型** | 各渠道模型勾选进 Kiro、能力覆盖（图片 / 推理）、每行上下文挡位下拉、拖拽排序；改动经「通道 A」静默刷新 Kiro 选择器 |
| **用量** | 趋势图（Token / 请求两个维度；「今天」按 10 分钟粒度显示消耗尖峰，标题为「今日」，曲线自 00:00 起满轴）、Sankey 流向图（Token 六层守恒：渠道 › 凭证 › 模型 › 状态 › Token 类型 › 上下文类别；非输入类各一直通；路径节点条可逐层显隐）、按渠道 / 模型汇总、缓存命中率 |
| **设置** | 启用代理、路由 / 思考 / 重试 / 显示选项、提示词库（单条启用，作为 system 注入）、**MCP 服务器**（直管 Kiro 两份 `mcp.json`）、**子代理 / Agent**（直管 `~/.kiro/agents` 与工作区 `.kiro/agents`）、**上下文**（各模型挡位总览与一键重置）、「关于」卡（版本、GitHub 项目主页、检查更新） |

Kiro 视图标题栏最右侧有两枚命令图标（4.13.56）：**GitHub 标**直达本项目主页；其右侧的**云朵下载标**即「检查更新」。有新版时该图标切成「安装更新」。面板 webview 顶栏改为左侧「启用代理」开关、右侧提供商 / 模型计数胶囊。设置页「关于」卡的两个按钮保留，与标题栏命令共用同一处理——比对本仓库最新 Release，有新版就把 Release 里的 `api2kiro-dual-<版本>.vsix` 下载到扩展存储目录、校验（zip 结构、大小、包内 `package.json` 的 name / version）后调用 Kiro 的「从 VSIX 安装」命令装好，再提示重新加载窗口；已是最新会直接告知，下载 / 校验 / 安装任一失败都会给出原因并附「打开 Release 页」按钮（安装包已下载时保留在本地供手动安装）。启动时的静默检查（24 小时一次）发现新版会把标题栏切到「安装更新」，通知里也带「立即更新」。下载只走 `github.com` 与 GitHub 资产域，不带任何凭据。

## 多渠道路由与 Key 池

- **合并与路由**：所有启用且配置完整的渠道，其勾选的模型合并进 Kiro 模型选择器；请求按所选模型 ID 路由到拥有该模型的渠道（同名模型优先 Anthropic 通道）。
- **分组显示**（`api2kiroDual.modelListStyle`）：`grouped` 按渠道分节并加标题行（默认）/ `suffix` 模型名加「(渠道名)」/ `plain` 只显示模型名；只有一个渠道时不加任何标记。
- **Key 池**（`poolStrategy`）：`priority` 主备（固定用最优先的一把，挂了才切；同一会话粘住同一把，粘性 2 小时）/ `least-used` 均衡（新会话选累计使用最少的一把）。
- **失败分类与冷却**：鉴权失败 15 分钟、额度用尽 30 分钟、403 15 分钟、限流按上游 `Retry-After`（无该头时 1 分钟）且不超过 10 分钟；冷却是「避让」而非「封锁」——到点自动回池，池里其它 Key 照常服务。

## 思考档位

**Anthropic 通道**

- `thinking` `auto / enabled / disabled`：extended thinking 开关，`auto` 按模型名是否含 `thinking` 决定；`thinkingBudget` 未选档位时的预算。
- `effortMode` `auto / modelVariant / thinkingBudget / off`：决定 Kiro 档位选择器显示哪些档。`auto` 只显示**有证据支持**的档位——上游声明的官方档位，或模型列表里真实存在的 `model-档位` 变体（如 `deepseek-v4-pro` 的 none / max），都没有就不显示，避免臆造上游不认的档位。
- `reasoningMode` `auto / standard / pro`：GPT 5.6 系列（sol / terra / luna）的思考模式。

**OpenAI 通道**

- `openaiReasoningEffort`：把 Kiro 选的档位发给上游。models.dev 声明了 effort 取值的模型原样透传，否则折成 low / medium / high，且只对推理模型发送（非推理模型收到该字段可能 400）。
- `openaiReasoningEcho`：是否把上一轮 `reasoning_content` 随历史带回（Preserved / Interleaved Thinking）。`auto` 只对要求回传的家族（GLM-4.7+ / 5.x、DeepSeek V3.2+ / V4、Kimi K2 / K3）。
- `openaiThoughtDedupe`：模型把回答先写进思考通道、正文再答一遍时（GLM-5.3 常见）的去重策略，`exact` 默认只在正文与思考开头一致时丢弃思考，不丢任何文字。
- `openaiMaxTokensField`：`max_tokens / max_completion_tokens / both / none`，适配不同网关对输出长度字段的要求。

## 用量与上下文

- **每轮页脚**（`showTokenUsage`）：在 Kiro 回答页脚标注本轮消耗的 Est. Input / Output Tokens；工具循环里的多次请求会累计成一轮后再上报，避免 Kiro 重复聚合。
- **本地账本**：每个请求的 token 由本扩展自己记账，不依赖中转站的用量接口；用量页的趋势、Sankey、汇总都来自这份账本。也可填 `usagePath` 走中转站的额度接口（kiro2cc-proxy 风格或 New-API 风格）。
- **Context Usage 弹层**：Kiro 底栏的 Context Usage 悬停弹层显示**真实模型窗口**（来自 CPS 报给 Kiro 的 `tokenLimits.maxInputTokens`，例如 1M）与六类分项占用（Your prompts / Kiro responses / Session files / Built-in tools / MCP tools / Steering files），不再是反推出来的假窗口。
- **上下文挡位**（4.13.55）：每个已勾选模型按渠道字段 / 厂商目录 / models.dev / 用户覆盖算出「已知最大 / 候选挡位 / 当前生效」。聊天框 Effort 右侧（Kiro 1.2 起在模型触发器右侧）有「Ctx」下拉，面板模型页每行、设置页「上下文」卡是同一套数据；选小一档后 Kiro 按新窗口算 80% / 95% 压缩阈值。覆盖写在用户级设置 `api2kiroDual.contextWindowOverrides`。
  - **（4.13.61）修一处口径分歧**：原先 CPS 广播、侧边栏下拉、流式占用百分比三条路径各算各的窗口 —— 流式那条只查 models.dev，**不看**用户覆盖 / 厂商目录 / Codex 订阅口径。于是 Codex 系模型上 CPS 报 272K、百分比却按目录的 1.05M 算（差 3.86 倍），永远到不了 80% 阈值 → 上下文无界增长。现在三条路径统一走 `modelStore.resolveWindowForGroup()`，同名重复函数已删除。
  - **（4.13.63）修「某些视图没有 Ctx 下拉」**：1.1.14 把聊天界面拆到 `kiro-ui-session-details`，那份 bundle 独立压缩，两个锚点写死在旧压缩名上 —— 该 chunk 的名字助手是 `o(` 而不是 `a(`（`useSessionConfig` 恒判未命中），且模板自带局部 `const k` 恰好撞上那份的 jsx 运行时名 `k`。两个原因都会让整条注入被拒，于是那个视图的聊天框**完全没有**「上下文」下拉。现在反查助手名按结构走、模板自有标识符全部 `a2k` 前缀化，两份 chunk 都能注入（`dev/verify-selector-patch.js` P15 逐份守卫，含「注入段真能渲染」）。
  - **（4.13.63）补丁状态逐 package 记账**：同一份 chunk 在各 package 各一份、各自独立压缩，所以「成没成」逐份回答 —— 任一承载 package 没打上就报 `unavailable` 并点名落地 / 漏掉的 package（不再出现「一个视图有、另一个没有」却报成功），`CARD_CSS` 也只给拿到补丁的那份加；弹层的 displayName 助手名改为按结构捕获（此前写死 `a`，真机叫 `o` 时整条弹层补丁静默失效）；调用处的 store 名改成 `typeof` 兜底（被压缩器改名时退回原生三项视图，而不是让弹层崩掉）。
  - Kiro 侧机制（**1.1.14 bundle 复核**）：`SummarizationDetectionNode` 把流式响应里的 `contextUsageEvent.contextUsagePercentage` 交给阈值函数 —— **≥ 80% 摘要、≥ 95% 即时截断**；若末尾有待回灌的工具结果，再把它的估算 token 按 `maxInputTokens` 折成百分比**叠加**上去（`Pxo`）。报多大的窗口，Kiro 就在多大的上下文处压缩。所以窗口最小的模型最先压缩：同一批会话里 1M 窗口的模型要 800K tokens 才到阈值，而 Codex / GPT 系（272K）**约 217.6K tokens 就压缩**——这是「GPT 模型动不动就压缩上下文」的全部原因，不是百分比算错（可用插件自己的账本与 Kiro 的 `Request payload: N chars` 互验，3.0–3.4 字符/token）。
- **爆窗口压缩**（4.13.55）：上游因输入过长返回 400 / 413 / 422 时，本机代理回给 Kiro 官方溢出异常，触发 Kiro 自己的截断式摘要而不是红字 `Upstream 400`。
- **Sankey 第 6 层**（4.13.57）：Token 维把输入再分到六类上下文；缓存读 / 缓存写 / 输出各一直通到最后一层。图下有路径节点条，可逐层显隐（至少保留两层）。
- **MCP / 子代理**（4.13.57）：设置页直接读写 Kiro 的 `mcp.json` 与自定义 agent 文件（`~/.kiro/agents`、工作区 `.kiro/agents`），不另存副本；写前备份、原子替换，外部改动约 300 ms 回推到面板。
  - **（4.13.63 提示）Kiro 1.1 的 Trust v2 迁移**：1.1.14 首次激活时会把 `mcp.json` 里的 `autoApprove`（用户级 / 工作区级 / powers 各一份）**一次性翻译**成 Kiro 新的权限规则（`capability:"mcp"` 的 allow 项，写进权限文件，入口是命令 `kiroAgent.openPermissionsUser`，并落一个 `.kiro/` 下的迁移标记），此后 Kiro 的批准判据以权限文件为准。mcp.json 的 `autoApprove` 字段仍被 Kiro 解析（schema 里还在、也仍会带进 MCP 连接配置），但**迁移之后再改 mcp.json 不一定改变实际批准行为**——遇到「改了免确认却没生效」，先看 Kiro 的权限文件。

## 稳健性

- **自动重试**（`autoRetry` / `maxRetries`）：上游流在**尚未吐出任何内容**时中断则透明重发；已开始输出正文或思考后中断不重试，避免重复内容。
- **纯文本模型剥图**（`textOnlyModels`）：Kiro 的附件按钮不按模型能力禁用，发往不支持图片的模型时自动剥离图片（包括历史消息里的，否则一张图会让整个对话永久 400）；某模型因图片被上游拒绝时会被自动记住。
- **意图分类本地拦截**（`interceptIntentClassifier`）：Kiro 每轮的 simple-task 分类请求在本地应答，省一次上游调用。
- **多窗口**：多个 Kiro 窗口共用同一对端口，先启动的窗口作主实例服务所有窗口；扩展升级后旧实例会被识别并让位。
- **本地服务只接受本机非浏览器客户端的请求**（校验 Host 与浏览器来源头 `Origin` / `Sec-Fetch-Site`，不符一律 403 且不带 CORS 头），网页无法借用你的凭据调用；Kiro 自身的请求不受影响。
- **端点只清自己写的**：关闭代理或关闭状态下激活时，只复原本扩展写入的 `codewhisperer.config.*Endpoints`（按写入记录或「指向本扩展端口」判断），原版 API2Kiro 或手写的端点原样保留；窗口关闭 / 停用扩展时不复原端点（其它窗口仍在用），所以**禁用或卸载前请先关闭代理**。
- **调试日志**（`debug`，默认关）：开启后把每次上游请求的**完整请求正文**（系统提示、整段对话与编辑器代码上下文、工具 schema）和上游响应流片段写进「API4Kiro」输出通道，由 Kiro 落在其日志目录（`logs/<会话>/window*/exthost/output_logging_*/*-API4Kiro.log`，随会话轮转）。已知形态的 API Key / token / Bearer 会自动打码，**正文里的其它内容不会**；单行超过 64 KiB 截断；开启时输出通道会先打一条提醒。仅排障时开启、用完关闭；命令面板 **API4Kiro: 打开调试日志** 直达。

## Kiro 前端补丁（重要）

为了让渠道分组标题有样式、Context Usage 弹层显示真实窗口、模型列表改动不重载即同步，本扩展会在 **Kiro 安装目录**的 kiro-agent 文件末尾追加带标记的补丁：

| 靶文件 | 作用 |
| --- | --- |
| `extensions/kiro.kiro-agent/packages/*/dist/style.css` | 模型选择器分组标题 / 卡片样式、弹层样式、Ctx 下拉样式（逐份：CSS 只作用于同一个 webview 文档） |
| `extensions/kiro.kiro-agent/packages/*/dist/assets/mermaid-*.js` | 模型选择器组头 / 能力徽章（1.1 选项行；1.2 模型面板行）、Context Usage 弹层、Ctx 下拉（1.1 在 Effort 旁，1.2 在模型触发器旁） |
| `extensions/kiro.kiro-agent/dist/extension.js` | 模型刷新钩子（「通道 A」静默刷新）、`a2k:ctx` 挡位转发钩子、usage-limits 启动重试钩子（本地端口 ECONNREFUSED 时重试并不弹 toast） |

> **（4.13.64）适配 Kiro 1.2.56**：后端钩子、端点重定向、CPS / KRS 在 1.2.56 上照常工作，坏的全在 webview 补丁，三个成因互相独立：① 模型选择器被整个重写成带搜索框 / 勾选列 / Effort 滑条的模型面板（`ModelPanel` / `ModelOptionRow`），1.1 代的选项行 / 菜单 / ref 锚点全部消失，补丁全有或全无地放弃，于是 `__A2K_GRP__|…` / `__A2K_MDL__|…` 微格式直接显示在面板的描述行里；现在新增 1.2 代路径，只改行组件的 props（分组标题不可选中、描述换成卡片头 / 能力徽章），并在 `writeModel` 入口拦下分组标题。② `EffortSelector` 组件被删（Effort 挪进面板），「Ctx」下拉改挂在模型触发器右边。③ 结构匹配器把成员访问的属性名（`ne.c(30)` 的 `.c`）也当成可改名标识符，1.2.56 恰好把局部 `c` / `u` 对调，弹层函数 0 命中；属性名现按字面量处理。**session-details 那份的 Context Usage 弹层在 1.2.56 上保持原生**（jsx 运行时名不是 `b`，见 ARCHITECTURE「已知限制」）。**与 `kiro-proxy.kiro-api-proxy` 同时启用会争抢 `codewhisperer.config.*Endpoints`，两者也改同一份 chunk 与 `extension.js`**，请只开一个。

> **1.1.14 起是「按内容认靶点、逐 package 覆盖」**：聊天界面被拆到 `kiro-ui-session-details`，承载模型选择器的同一个 chunk（同名 base `mermaid-GHXKKRXX`、不同 hash）在各 package 下各有一份，而且**各自独立压缩**。所以：① 用类名字面量 `chat-input-popup-option` 按**内容**挑 chunk，不按文件名（`mermaid-*` 优先，一份都不命中时回退扫该 package 的全部 `assets/*.js`）；② 每个 package 的 chunk 与它自己的 `style.css` 逐份处理，任一份漏掉就是「用户看到的那份没有补丁」。

设计约束：

- **可逆**：每段补丁带 `a2k` 标记；被替换的函数原文以 base64 随身携带，复原时精确回填；插入型钩子用 `/*a2k-…:start*/…/*a2k-…:end*/` 定界、删段复原。关闭代理或关闭 `api2kiroDual.groupHeaderStyle` 即移除。
- **不写死压缩名，也不写死名字助手**：Kiro 自动升级会改变压缩后的函数名，补丁按代码结构匹配、名字用正则捕获，全有或全无——任一靶点漂移则三处都不写（Ctx 下拉 / 宿主转发 / usage 重试为可选组，漂移只跳过自身），绝不留下半套。1.1.14 的两个实例说明这条要贯彻到底：`useSessionConfig` 的反查原先把名字助手写死成 `a(`，而 session-details 那份是 `o(`；注入段的模板自带短局部名（`const k`）又撞上那份的 jsx 运行时名 `k` —— 两者都会让整条补丁被拒。
- **升级自愈**：Kiro 升级覆盖了靶文件后，下次激活自动重新打补丁并提示重载一次。
- **停用后的状态**：为避免每次重载都把钩子抹掉（kiro-agent 先于本扩展加载磁盘文件），窗口关闭时三份文件保持补丁态；此时没有本扩展运行，补丁对 Kiro 原生行为无可见影响。
- **验证**：`node dev/verify-selector-patch.js [Kiro appRoot]` 用**真机安装目录的只读副本**跑结构命中 / 唯一性 / 改名守卫 / 幂等 / 往返复原 / 多 package 覆盖 / Ctx 下拉逐份「能注入且真能渲染」（当前 100+ 项全过，脚本自报数字为准）。

## 命令面板

| 命令 | 说明 |
| --- | --- |
| `API4Kiro: 打开控制面板` | 聚焦侧边栏 |
| `API4Kiro: 启用 / 关闭代理` | 切换 `api2kiroDual.enabled` |
| `API4Kiro: 管理 Providers（打开面板）` | 打开提供商页 |
| `API4Kiro: 刷新活跃会话模型列表` | 手动触发「通道 A」刷新 Kiro 选择器 |
| `API4Kiro: 刷新用量 / 缓存命中率` | 重新拉取用量 |
| `API4Kiro: 清除"不支持图片"的模型记录` | 清空自动学习到的纯文本模型名单 |
| `API4Kiro: 打开调试日志` | 打开日志文件 |

## 配置项

常用项（完整 41 项见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)，由 `package.json` 自动生成）：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `api2kiroDual.enabled` | `false` | 启用代理；与原版 API2Kiro 互斥 |
| `api2kiroDual.providers` | `[]` | 渠道注册表，一般在面板里维护 |
| `api2kiroDual.modelListStyle` | `grouped` | 多渠道时模型来源的标记方式 |
| `api2kiroDual.groupHeaderStyle` | `true` | 分组标题样式（Kiro 前端补丁总开关） |
| `api2kiroDual.port` / `cpsPort` | `19810` / `19811` | 本地运行时 / 控制面端口 |
| `api2kiroDual.maxTokens` | `32000` | 向上游请求的最大输出 token |
| `api2kiroDual.thinking` / `thinkingBudget` / `effortMode` | `auto` / `8192` / `auto` | Anthropic 通道思考策略 |
| `api2kiroDual.openaiReasoningEffort` / `openaiReasoningEcho` / `openaiThoughtDedupe` | `auto` / `auto` / `exact` | OpenAI 通道思考策略 |
| `api2kiroDual.autoRetry` / `maxRetries` | `true` / `2` | 流中断自动重试 |
| `api2kiroDual.showTokenUsage` | `true` | 每轮页脚标注 token |
| `api2kiroDual.textOnlyModels` | `[]` | 不支持图片的模型（自动学习） |
| `api2kiroDual.interceptIntentClassifier` | `true` | 本地拦截意图分类请求 |
| `api2kiroDual.debug` | `false` | 写调试日志：含完整请求正文（对话、代码上下文、工具 schema）与响应流，只有已知形态的 Key / token 打码；排障后关闭 |

`codewhisperer.config.*Endpoints` 三项由扩展自动管理（把 Kiro 的请求重定向到本地代理），请勿手动编辑。

含凭据与端点的设置项声明为 `scope: machine`：只在用户设置里生效，工作区设置不覆盖、不随 Settings Sync 同步；OAuth 渠道默认只向厂商地址发送凭据，自定义中转需在渠道条目里显式写 `"allowCustomHost": true`。

## 项目结构

### 思维导图

```mermaid
mindmap
  root((API4Kiro))
    宿主层
      extension.ts 激活 · 命令 · 配置监听
      endpoints.ts 端点重定向与复原
      portBinder.ts 端口所有权
      proxyIdentity.ts 实例身份握手
      updateChecker.ts Release 更新检查与自更新
      config.ts 设置读取与旧配置迁移
    本地代理
      krsServer.ts 运行时反代 19810
      cpsServer.ts 控制面 19811
      intentClassifier.ts 意图分类本地应答
      upstream.ts 上游 HTTP 请求
    协议译码
      Anthropic Messages
        translate.ts
        anthropicStream.ts
      OpenAI Chat Completions
        openaiTranslate.ts
        openaiStream.ts
      OpenAI Responses
        responsesTranslate.ts
        responsesStream.ts
      Gemini generateContent
        geminiTranslate.ts
        geminiStream.ts
      公共策略
        streamShared.ts
        thinkingPolicy.ts
        effort.ts
        imagePolicy.ts
        schemaUtil.ts
      CodeWhisperer 协议
        eventstream.ts
        cwEvents.ts
        cwTypes.ts
    渠道与凭证
      providers.ts 注册表与路由
      credentialPool.ts Key 池调度与冷却
      providerProbe.ts 测延迟 · 拉模型 · 测活
      oauth 目录
        core.ts PKCE · 回调 · 设备码
        vendors.ts 六家厂商规格
        index.ts token 运行时
        tokenStore.ts 钥匙串
      ccSwitchImport.ts
      sqliteReader.ts
    模型
      modelStore.ts 聚合与路由表
      modelCatalog.ts models.dev 能力目录
      codexCatalog.ts Codex 订阅口径窗口目录
      contextWindow.ts 挡位解析
      contextOverflow.ts 爆窗口判定
    用量
      usageStore.ts 账本 · 趋势 · Sankey
      turnLedger.ts 整轮累计
      contextParser.ts 六桶上下文分项
    界面
      sidebar.ts Webview 四页
      selectorStyle.ts Kiro 补丁与复原
      mcpConfig.ts MCP 直管
      agentConfig.ts 子代理直管
      promptStore.ts 提示词库
      openBrowser.ts
      log.ts
    资产
      icon.png · icon.svg
      providers 厂商 Logo
      glyphs 几何线稿
    工程
      esbuild.js 单文件打包
      tsconfig.json
      GitHub Actions CI
      docs
```

### 目录树

```
API4Kiro/
├── src/
│   ├── extension.ts            激活 / 停用、命令注册、配置监听；启停本地代理与 Kiro 补丁；启动时静默检查更新
│   ├── config.ts               读取并规范化 api2kiroDual.* 设置（含旧版双通道配置自动迁移）
│   ├── endpoints.ts            Kiro codewhisperer.config.*Endpoints 的备份 / 重定向 / 复原
│   ├── portBinder.ts           多窗口固定端口所有权：让位 / 接管
│   ├── proxyIdentity.ts        本地代理身份握手（识别同类实例与升级后的旧实例）
│   ├── requestGuard.ts         本地服务请求来源守卫：只放行本机非浏览器客户端（Host 回环、无 Origin / Sec-Fetch-Site）
│   ├── updateChecker.ts        GitHub Release 更新检查与自更新（启动静默 24h 节流；手动：下载 vsix → 校验 → installExtension → 提示重载）
│   │
│   ├── krsServer.ts            运行时反代：Kiro 请求 → 路由 → 译码 → 上游 → 流式回写 CW 事件；重试、剥图
│   ├── cpsServer.ts            控制面：模型列表广播（含能力 / 窗口 description）、测活、用量查询
│   ├── intentClassifier.ts     Kiro simple-task 意图分类请求的本地应答
│   ├── upstream.ts             上游 HTTP(S) 请求与流式读取
│   │
│   ├── translate.ts            CW → Anthropic Messages 请求体
│   ├── anthropicStream.ts      Anthropic SSE → CW 事件
│   ├── openaiTranslate.ts      CW → OpenAI Chat Completions 请求体
│   ├── openaiStream.ts         Chat Completions SSE → CW 事件
│   ├── responsesTranslate.ts   CW → OpenAI Responses 请求体
│   ├── responsesStream.ts      Responses 类型化事件流 → CW 事件
│   ├── geminiTranslate.ts      CW → Gemini generateContent（Gemini 官方 / Antigravity 共用内层请求）
│   ├── geminiStream.ts         Gemini SSE → CW 事件
│   ├── streamShared.ts         各协议流回写共用的事件合成与状态
│   ├── thinkingPolicy.ts       OpenAI 兼容通路各家「思考」方言（强制思考、回传、去重）
│   ├── effort.ts               思考档位与 thinking 预算的映射
│   ├── imagePolicy.ts          纯文本模型的图片剥离与自学习
│   ├── schemaUtil.ts           工具参数 JSON Schema 整理（内联本地 $ref）
│   ├── eventstream.ts          AWS application/vnd.amazon.eventstream 二进制编解码
│   ├── cwEvents.ts             CodeWhisperer 事件构造
│   ├── cwTypes.ts              CodeWhisperer 请求 / 事件类型
│   │
│   ├── providers.ts            Provider 注册表：N 个上游接入点的模型合并与按模型 ID 路由
│   ├── credentialPool.ts       Key 池调度：主备 / 均衡、失败分类与冷却、会话粘性
│   ├── providerProbe.ts        草稿渠道的测延迟 / 拉取模型 / 测活
│   ├── ccSwitchImport.ts       从 CC Switch 只读导入渠道
│   ├── sqliteReader.ts         零依赖只读 SQLite 页解析器
│   ├── oauth/
│   │   ├── core.ts             PKCE、state、本机回调服务器、设备码轮询、JWT 载荷解析
│   │   ├── vendors.ts          厂商登录规格：Kimi / Codex / xAI / Antigravity / Anthropic / Kiro
│   │   ├── index.ts            OAuth 运行时：请求前取新鲜 token（并发只刷一次）、登录会话
│   │   └── tokenStore.ts       token 仓（系统钥匙串，按 provider / credential 键）
│   │
│   ├── modelStore.ts           模型聚合与「模型 ID → provider」路由表；学到的模型名单
│   ├── modelCatalog.ts         models.dev 模型能力目录缓存（图片 / 思考形态 / 上下文窗口）
│   ├── codexCatalog.ts         Codex 订阅口径窗口目录（models.json 两来源取保守下限）
│   ├── contextWindow.ts        每模型上下文挡位：四来源解析、候选梯子、CPS description 往返
│   ├── contextOverflow.ts      上游超长判定；回 Kiro ValidationException 触发被动压缩
│   │
│   ├── usageStore.ts           本地用量账本：趋势、Sankey（含第 6 层折叠）、分项聚合
│   ├── turnLedger.ts           一轮对话（工具循环多请求）的用量累计与轮末上报
│   ├── contextParser.ts        请求上下文六桶解析与 token 无损分配
│   │
│   ├── sidebar.ts              侧边栏 Webview：提供商 / 模型 / 用量 / 设置四页与图表
│   ├── selectorStyle.ts        Kiro 模型选择器样式、Ctx 下拉、Context Usage 弹层、模型刷新钩子的补丁与复原
│   ├── mcpConfig.ts            直管 Kiro 两份 mcp.json（列表 / 编辑 / 导入 / 监听）
│   ├── agentConfig.ts          直管两级自定义 agent 文件（md / json）
│   ├── promptStore.ts          提示词库（单条启用，注入 system）
│   ├── openBrowser.ts          系统浏览器打开链接（绕开 Kiro 的二次确认）
│   └── log.ts                  输出通道与调试日志（已知形态 Key / token 脱敏、单行 64 KiB 截断、debug 开启提醒）
│
├── assets/
│   ├── icon.png / icon.svg     扩展图标 / 活动栏单色图标
│   ├── icon-source.svg         彩色图标源；scripts/render-icon.py 渲染为 icon.png（不进 vsix）
│   ├── providers/              厂商 Logo（SVG + PNG 剪影）+ LICENSE.md
│   ├── glyphs/                 自绘几何线稿 Logo（自定义渠道可选）
│   ├── ccswitch.png            CC Switch 标识（导入入口）
│   └── ICON-LICENSE.md         图标与第三方标识的许可说明
│
├── docs/
│   ├── ARCHITECTURE.md         架构概览：请求流程、模块边界、Key 池状态机、Kiro 补丁机制
│   └── CONFIGURATION.md        全部配置项参考（由 package.json 生成）
├── scripts/
│   ├── gen-config-doc.js       生成 docs/CONFIGURATION.md
│   └── render-icon.py          从 assets/icon-source.svg 渲染并像素级校验 assets/icon.png（Playwright + Pillow）
├── .github/
│   ├── workflows/ci.yml        push / PR：npm ci → tsc → 打包并上传 vsix；v* tag：挂到 Release
│   └── ISSUE_TEMPLATE/         Bug 报告 / 功能建议表单
│
├── esbuild.js                  打包为单文件 dist/extension.js（含可选 client secret 注入）
├── tsconfig.json
├── package.json                扩展清单：命令、视图、配置项（含 contextWindowOverrides）、extensionDependencies
├── .vscodeignore               vsix 只含 dist/、assets/、package.json、LICENSE、README
├── CONTRIBUTING.md
├── LICENSE                     MIT
└── README.md
```

## 技术栈

- **语言与构建**：TypeScript 5.5 · esbuild 0.23 打成单文件 CommonJS（`dist/extension.js`，≈ 0.9 MB）· `@vscode/vsce` 打包 · **零运行时 npm 依赖**
- **宿主**：VS Code Extension API `^1.90`（Kiro）· Webview 用原生 HTML / CSS / JS，不引前端框架 · `SecretStorage` 存 OAuth token
- **网络**：Node `http` / `https` / `net` 实现本地反代与多窗口端口协商 · 自实现 AWS eventstream 二进制编解码 · SSE 解析
- **协议**：Anthropic Messages · OpenAI Chat Completions / Responses · Gemini generateContent · Kiro CodeWhisperer
- **认证**：OAuth 2.0 授权码 + PKCE / 设备码；Kimi、OpenAI（Codex）、xAI、Google（Antigravity）、Anthropic、Kiro 六家
- **数据**：零依赖 SQLite 页解析器（CC Switch 导入）· `globalState` 持久化账本与模型名单 · [models.dev](https://models.dev) 公共模型目录（可缺席）· Codex 订阅口径窗口目录（[router-for-me/models](https://github.com/router-for-me/models)，可缺席）
- **工程**：GitHub Actions CI（Node 22，构建 + 打包 + 产物上传，tag 自动发 Release）· Conventional Commits

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构图、一次请求的完整流程、模块边界、Key 池状态机、Kiro 前端补丁机制与复原、多窗口协商、已知限制 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 全部配置项：类型、默认值、取值与说明（`node scripts/gen-config-doc.js` 从 `package.json` 生成） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 环境搭建、Issue / PR 约定、发布流程 |
| [assets/ICON-LICENSE.md](assets/ICON-LICENSE.md) · [assets/providers/LICENSE.md](assets/providers/LICENSE.md) | 图标与第三方标识的来源与许可 |

## 从源码构建

```bash
git clone https://github.com/yourhoneypomelo-cell/API4Kiro.git
cd API4Kiro
npm ci
npm run compile          # tsc 类型检查
npm run package          # esbuild 打包 + vsce 生成 api2kiro-dual-<version>.vsix
kiro --install-extension api2kiro-dual-<version>.vsix --force
```

需要 Node.js 18 或更高版本（CI 使用 Node 22）。

- **Antigravity 登录的 client secret 不在仓库里，也不进公开 Release。** Google 会自动吊销出现在公开仓库的 `GOCSPX-` 密钥。默认 `npm run package`（含 CI）不读 `antigravity.secret`，得到的 vsix 里 `client_secret` 为空串，Antigravity 登录不可用，其余功能不受影响。本机自用包若要带密钥：设 `A2K_EMBED_ANTIGRAVITY_SECRET=1` 再 `npm run package`（或设环境变量 `A2K_ANTIGRAVITY_CLIENT_SECRET`）。**带密钥的包禁止 `gh release upload`、禁止推进公开仓。**
- 回归测试套件（约 1,700 项，覆盖译码、路由、Key 池、握手、补丁可逆性等）在作者本地维护，因其中包含 Kiro 编译产物的只读副本，未随公开仓发布；CI 只做类型检查与打包。

## 致谢

- [SunNorthGod/API2Kiro](https://github.com/SunNorthGod/API2Kiro) — 本项目的起点，MIT
- 设计参考：kiro.rs（[hank9999](https://github.com/hank9999/kiro.rs) / [ZyphrZero](https://github.com/ZyphrZero/kiro.rs)）的 `MultiTokenManager` 与 [kiro.qizhu](https://github.com/chenjie897532119/kiro.qizhu) 的 `pool/scheduler.go`（凭证池调度）、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 OAuth 流程、[cc-switch](https://github.com/farion1231/cc-switch) 的提示词管理与供应商模型、[Kilo Code](https://github.com/Kilo-Org/kilocode) / [OpenCode](https://github.com/anomalyco/opencode) 采用的 [models.dev](https://models.dev) 目录
- 图标：Kiro 幽灵标记来自 Kiro IDE 自带的 kiricons；钥匙串 "House keys" by Delapouite（[game-icons.net](https://game-icons.net)，CC BY 3.0）；GitHub 标记为 [Octicons](https://primer.style/octicons)；CC Switch 标识属 CC Switch 项目

## 许可证

代码以 [MIT](LICENSE) 许可发布，保留上游 API2Kiro 的版权声明。

图标与面板中使用的第三方标识（Kiro、各 AI 厂商、CC Switch、game-icons.net）各归其所有者，许可与来源见 [`assets/ICON-LICENSE.md`](assets/ICON-LICENSE.md) 与 [`assets/providers/LICENSE.md`](assets/providers/LICENSE.md)。

## 重要免责声明

本仓库仅供学习、研究、个人实验和内部验证使用，不提供任何形式的商业授权、适用性保证或结果保证。

本项目与 Kiro / Amazon、Anthropic、OpenAI、Google、xAI、Moonshot 等任何厂商均无关联、亦未获其背书；文中出现的商标与产品名归各自所有者。

本扩展会修改 Kiro 安装目录内 kiro-agent 的三个前端文件（见[「Kiro 前端补丁」](#kiro-前端补丁重要)），补丁可逆但属于对第三方软件的运行时修改；Kiro 升级后的兼容性无法事先保证。使用前请确认你理解并接受这一点。

开启 `api2kiroDual.debug` 后，本机日志会包含你与模型的完整对话、编辑器里的代码上下文与工具 schema，只有已知形态的 API Key / token 会自动打码；日志文件由 Kiro 保存在本机日志目录、随会话轮转，其权限与保留期由操作系统和 Kiro 决定。请只在排障时开启、用完关闭，对外分享日志前自行检查内容。

通过本扩展接入的各家 API、账号与中转服务，其服务条款、配额与计费由你与对应服务方之间的协议约束。作者及仓库维护者不对因使用、修改、分发或依赖本项目而产生的任何直接或间接损失、账号封禁、额度消耗、数据丢失、法律风险或第三方索赔负责。

请勿将本项目用于违反服务条款、协议、法律法规或平台规则的场景。商业使用前请自行确认 LICENSE、相关协议以及你是否获得了作者的书面许可。
