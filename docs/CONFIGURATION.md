# 配置项参考

> 本文由 `node scripts/gen-config-doc.js` 从 `package.json` 生成（版本 4.13.51），请勿手改；改设置项后重新生成。

共 41 项：`api2kiroDual.*` 38 项 + 由扩展自动管理的 Kiro 内部端点 3 项。所有设置都在 VS Code / Kiro 的 settings.json 里生效；渠道相关的项一般在侧边栏面板里维护，无需手填。

## api2kiroDual.*

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `api2kiroDual.enabled` | `boolean` | `false` | 启用代理。默认关闭：本扩展与原版 API2Kiro 共用 codewhisperer.config.*Endpoints，同一时间只能有一个生效。启用本扩展前请先关闭原版（原版设置里把 api2kiro.enabled 设为 false）。 |
| `api2kiroDual.providers` | `array` | `[]` | Provider 注册表：多个上游接入点（第三方中转 / 官方 Key / 任意 Anthropic\|OpenAI 兼容端点）。所有启用且配置完整的 provider，其模型合并进 Kiro 模型选择器，按模型 ID 自动路由。一般在侧边栏面板里增删改，无需手动编辑。为空时会自动从旧版双通道配置（baseUrl/openaiBaseUrl 等）迁移读取。 |
| `api2kiroDual.routing` | `string` | `merge` | 双协议路由策略。merge=两个通道同时生效，模型列表取并集，按 Kiro 选中的模型 ID 自动路由到拥有该模型的通道（ID 同时存在于两侧时优先 Anthropic 通道）；anthropicOnly=只用 Anthropic 通道（等同原版行为）；openaiOnly=所有请求走 OpenAI 通道。切换后需重载窗口。<br>取值：`merge` = 两通道并存，按模型自动路由（推荐）；`anthropicOnly` = 只用 Anthropic 通道；`openaiOnly` = 只用 OpenAI 通道 |
| `api2kiroDual.mode` | `string` | `kiro` | Anthropic 通道的子模式。kiro=深度兼容（走 kiro2cc-proxy 类中转站，保留 Kiro 私有字段 / effort / thinking 与计费显示）；anthropic=官方 Anthropic 直通（翻成纯 Anthropic /v1/messages，不注入私有字段、不显示计费）。切换后需重载窗口。<br>取值：`kiro`；`anthropic` |
| `api2kiroDual.baseUrl` | `string` | `""` | 【Anthropic 通道 · 深度兼容】中转站地址。例如 https://your-relay.com/v1 或 https://your-relay.com（会自动补 /v1）。 |
| `api2kiroDual.apiKey` | `string` | `""` | 【Anthropic 通道 · 深度兼容】中转站 API Key（形如 sk-xxxx）。 |
| `api2kiroDual.officialBaseUrl` | `string` | `""` | 【Anthropic 通道 · 官方直通】地址，例如 https://api.anthropic.com。必填：留空则不发出任何请求。仅 mode=anthropic 时生效。 |
| `api2kiroDual.officialApiKey` | `string` | `""` | 【Anthropic 通道 · 官方直通】API Key。仅 mode=anthropic 时生效。 |
| `api2kiroDual.officialModelMapping` | `object` | `{}` | 官方直通模式下 Kiro 内部模型 ID → 上游模型 ID 的映射。留空则原样透传。 |
| `api2kiroDual.officialDefaultModel` | `string` | `""` | 官方直通模式下映射表未命中时的兜底模型 ID。留空则透传原始 ID。 |
| `api2kiroDual.openaiEnabled` | `boolean` | `false` | 启用 OpenAI 协议通道（/v1/chat/completions）。开启并填好地址与 Key 后，该端点的模型会出现在 Kiro 的模型选择器里，与 Anthropic 通道的模型并列。 |
| `api2kiroDual.openaiBaseUrl` | `string` | `""` | 【OpenAI 通道】地址。例如 https://api.openai.com/v1、https://your-relay.com/v1，或 https://your-relay.com（会自动补 /v1）。留空则不发出任何请求。 |
| `api2kiroDual.openaiApiKey` | `string` | `""` | 【OpenAI 通道】API Key。以 Authorization: Bearer 发送。 |
| `api2kiroDual.openaiModelMapping` | `object` | `{}` | OpenAI 通道下 Kiro 内部模型 ID → 上游模型 ID 的映射。留空则原样透传（模型选择器展示的即为该端点 /models 返回的 ID，天然一一对应）。 |
| `api2kiroDual.openaiDefaultModel` | `string` | `""` | OpenAI 通道下映射表未命中时的兜底模型 ID（例如 gpt-4o）。留空则透传原始 ID。 |
| `api2kiroDual.openaiMaxTokensField` | `string` | `max_tokens` | OpenAI 通道用哪个字段限制输出长度。max_tokens=兼容绝大多数中转站；max_completion_tokens=OpenAI 新版推理模型要求的字段；both=两个都发（少数网关会因未知字段报错）；none=不发，用上游默认。<br>取值：`max_tokens`；`max_completion_tokens`；`both`；`none` |
| `api2kiroDual.openaiReasoningEffort` | `string` | `auto` | OpenAI 通道的 reasoning_effort 处理方式。auto=把 Kiro 选的思考档位发给上游：模型在 models.dev 目录里声明了 effort 取值（如 GLM-5.3 的 low/high/max、DeepSeek 的 none/max）就原样透传，否则折成 low/medium/high（xhigh/max→high），且仅对推理模型发送；off=从不发送；low/medium/high=固定档位。非推理模型收到该字段可能 400，故默认只对推理模型（o1/o3/o4/gpt-5/reasoner/thinking 等）发送。GLM-5.3 系思考不可关闭，选 none 或把「推理」设为不支持时改发 reasoning_effort:low。<br>取值：`auto`；`off`；`low`；`medium`；`high` |
| `api2kiroDual.openaiReasoningEcho` | `string` | `auto` | OpenAI 通道是否把上一轮的思考（reasoning_content）随历史带回给上游（Preserved / Interleaved Thinking）。auto=只对要求回传的家族（GLM-4.7+/5.x、DeepSeek V3.2+/V4、Kimi K2/K3）；off=从不；always=所有模型都带（OpenAI 官方等严格网关会 400，慎用）。GLM-5.3 的 clear_thinking 默认 false，不回传会在多轮/工具循环里丢推理状态。<br>取值：`auto`；`off`；`always` |
| `api2kiroDual.openaiThoughtDedupe` | `string` | `exact` | OpenAI 通道：模型把回答先写进思考通道、正文再答一遍时（GLM-5.3 在闲聊式问题上的习惯，Kiro 里表现为「Thought complete」折叠里是完整回答、下面又一份）怎么处理。思考开头像一份回答（问候语 / 我是 Kiro / markdown / emoji）时先扣住不发，等正文到了比对：exact（默认）=正文与思考开头一致就丢掉思考、只留正文，不一致则原样补发思考，不丢任何文字；aggressive=开头像回答的思考一律丢弃（若上游解析器把一份回答切成了思考+正文两半会丢前半，慎用）；off=思考一律直播（旧行为）。三种模式下，只有思考、没有正文的流都会把这段回答提升为正文。<br>取值：`off`；`exact`；`aggressive` |
| `api2kiroDual.port` | `number` | `19810` | 本地运行时代理端口（KRS）。已与原版 API2Kiro 的 19800 错开，两个扩展可同时安装。多个 Kiro 窗口共用同一端口：先启动的窗口作为主实例服务所有窗口。 |
| `api2kiroDual.cpsPort` | `number` | `19811` | 本地控制面代理端口（CPS）。已与原版的 19801 错开，规则同上。 |
| `api2kiroDual.maxTokens` | `number` | `32000` | 向上游请求的最大输出 token 数。 |
| `api2kiroDual.thinking` | `string` | `auto` | Anthropic 通道的扩展思考（extended thinking）模式。auto 表示按模型名是否含 thinking 自动决定。<br>取值：`auto`；`enabled`；`disabled` |
| `api2kiroDual.thinkingBudget` | `number` | `8192` | 开启扩展思考时的 token 预算（未选择 effort 档位时使用）。 |
| `api2kiroDual.effortMode` | `string` | `auto` | 思考档位在 Anthropic 通道的处理方式，同时决定 Kiro 档位选择器显示哪些档（选择器完全由本扩展广播的 schema 驱动）。auto（推荐）：只显示有证据支持的档位——中转站声明的官方档位，或列表里真实存在的 model-档位 变体（如 deepseek-v4-pro 的 none/max）；都没有就不显示选择器，避免臆造出上游根本不认的档位。modelVariant：同 auto，但更倾向切换到变体模型。thinkingBudget：无视上游能力，始终显示 low/medium/high/xhigh/max 并映射为 thinking 预算（适合中转站转发的是原生 Claude 且支持扩展思考）。off：关闭档位选择器。<br>取值：`auto`；`modelVariant`；`thinkingBudget`；`off` |
| `api2kiroDual.effortBudgets` | `object` | 见说明 | 各思考档位对应的 thinking 预算（token），会被自动限制在 max_tokens 以内。仅在按预算映射时使用。<br>默认值：`{"low":2048,"medium":4096,"high":8192,"xhigh":16384,"max":24576}` |
| `api2kiroDual.reasoningMode` | `string` | `auto` | GPT 5.6 系列（sol/terra/luna）在 Anthropic 通道的思考模式。auto：跟随 Kiro 请求或上游默认；standard / pro：强制该模式。仅对 reasoning 模型生效。<br>取值：`auto`；`standard`；`pro` |
| `api2kiroDual.defaultModel` | `string` | `""` | Anthropic 通道映射表未命中时的兜底上游模型 ID（例如 claude-opus-4-8）。留空则透传原始 ID。 |
| `api2kiroDual.modelMapping` | `object` | `{}` | Anthropic 通道下 Kiro 内部模型 ID → 上游模型 ID 的映射。例如 {"CLAUDE_SONNET_4_5_20250929_V1_0": "claude-sonnet-4-5"}。 |
| `api2kiroDual.interceptIntentClassifier` | `boolean` | `true` | 本地拦截 Kiro 的意图分类（simple-task）请求，节省一次上游调用。 |
| `api2kiroDual.modelListStyle` | `string` | `grouped` | 多个渠道时，Kiro 模型选择器里如何区分模型来源。只有一个渠道时不加任何标记。改动后需重载窗口。<br>取值：`grouped` = 按渠道分组：每组前一条小号淡色的渠道名标题行（像原生菜单的分节标题），模型名保持原样（标题行被误选时会提示改选具体模型）；`suffix` = 模型名后缀「(渠道名)」，不分组；`plain` = 只显示模型名 |
| `api2kiroDual.groupHeaderStyle` | `boolean` | `true` | 给 Kiro 模型选择器里的渠道分组标题行加上浅色填充与光晕，让渠道层级更醒目（仅 modelListStyle 为 grouped 时有标题行）。原理：Kiro 的选择器本身不支持分组样式，这里会在 Kiro 安装目录的 kiro-agent 前端样式文件（extensions/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/style.css）末尾追加一段带标记的 CSS；关闭即移除，Kiro 升级覆盖后会自动补回。改动后需重载窗口。 |
| `api2kiroDual.autoRetry` | `boolean` | `true` | 上游流中断自动重试。仅在「尚未吐出任何回复内容」时透明重发；已开始输出正文/思考后中断则不重试（避免重复内容）。 |
| `api2kiroDual.maxRetries` | `number` | `2` | 自动重试的最大重试次数（不含首次尝试，范围 0-5）。 |
| `api2kiroDual.usagePath` | `string` | `""` | 留空（推荐）：使用 kiro2cc-proxy 面板接口 /api/user/usage 拉取真实用量。若中转站是 OpenAI/New-API 风格，可填其额度接口路径（如 /v1/dashboard/billing/subscription）走计费查询。 |
| `api2kiroDual.debug` | `boolean` | `false` | 把请求/响应写入调试日志文件（Key 会脱敏）。 |
| `api2kiroDual.showTokenUsage` | `boolean` | `true` | 在每轮回答的页脚（Elapsed time 那一行）标注本轮消耗的 token（Est. Input Tokens Used / Est. Output Tokens Used）。两个协议通道都支持。 |
| `api2kiroDual.textOnlyModels` | `array` | `[]` | 已知不支持图片输入的模型 ID。发往这些模型的请求会自动剥离图片（包括对话历史里的，否则一张图会让整个对话永久 400），并在回复前提示。此外扩展会自动学习：某模型因图片被上游拒绝时会被记住，无需手填。Kiro 的附件按钮不按模型能力禁用，所以只能在代理层兜底。 |

## 由扩展自动管理（请勿手动编辑）

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `codewhisperer.config.krsEndpoints` | `array \| null` | `null` | 内部项：由 API4Kiro 自动管理，用于把 Kiro 的 AI 运行时请求重定向到本地代理。请勿手动编辑。 |
| `codewhisperer.config.cpsEndpoints` | `array \| null` | `null` | 内部项：由 API4Kiro 自动管理的控制面端点重定向。请勿手动编辑。 |
| `codewhisperer.config.endpoints` | `array \| null` | `null` | 内部项：由 API4Kiro 自动管理的通用端点重定向（Kiro 1.0+）。请勿手动编辑。 |

## `api2kiroDual.providers[]` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 稳定唯一 id |
| `name` | `string` | 展示名 |
| `protocol` | `string` | 上游协议：anthropic=/v1/messages；openai=/chat/completions 或 /responses；gemini=generateContent（Gemini 官方 / Antigravity）<br>取值：`anthropic`；`openai`；`gemini` |
| `anthropicMode` | `string` | 仅 anthropic：kiro=深度兼容 / official=官方直通<br>取值：`kiro`；`official` |
| `openaiApi` | `string` | 仅 openai：chat=/chat/completions（缺省） / responses=/responses<br>取值：`chat`；`responses` |
| `auth` | `string` | 鉴权方式：key=API Key（缺省）；oauth=第三方账号登录（token 存在系统钥匙串，不在此文件）<br>取值：`key`；`oauth` |
| `oauthVendor` | `string` | auth=oauth 时的厂商：kimi / codex / xai / antigravity / anthropic<br>取值：`kimi`；`codex`；`xai`；`antigravity`；`anthropic` |
| `baseUrl` | `string` | — |
| `exactBase` | `boolean` | baseUrl 是精确前缀（直接拼 /chat/completions、/messages），不再自动补 /v1。models.dev 预设自动为 true |
| `icon` | `string` | 手选 Logo：glyph:<名称>（面板「Logo」图库里挑的科技风线稿）。留空 = 自动（厂商官方 Logo / 首字母） |
| `apiKey` | `string` | 首条凭证的 Key（与 credentials[0].apiKey 镜像，两处保持一致） |
| `credentials` | `array` | key 池：同一渠道的多把凭证，对 Kiro 表现为一个条目。不写 = 只有 apiKey 那一把。首条固定 id=c1。key 类填 apiKey；oauth 类 apiKey 留空，token 在钥匙串按 <providerId>/<id> 存。 |
| `poolStrategy` | `string` | 多把凭证时的调度：priority=主备（缺省，固定用最优先的一把，挂了才切；同一会话粘住同一把）；least-used=均衡（新会话选累计使用最少的）。被限流 / 额度用尽 / 鉴权失败的凭证按类型冷却后自动回池。<br>取值：`priority`；`least-used` |
| `enabled` | `boolean` | — |
| `modelMapping` | `object` | Kiro 模型 id → 上游真实 id |
| `modelOverrides` | `object` | 每个模型的能力手动覆盖：{ [modelId]: { image?: boolean, reasoning?: boolean } }，优先级高于 models.dev 目录与名字推断 |
| `enabledModels` | `array` | 进入 Kiro 模型列表的模型 id（严格 opt-in）。不写=全部；[]=一个都不进；非空=只有这些。一般在面板「模型」页勾选，无需手填。 |
| `defaultModel` | `string` | — |
| `presetId` | `string` | — |

### `credentials[]` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | c1 / c2 … |
| `label` | `string` | 备注名 |
| `apiKey` | `string` | — |
| `priority` | `number` | 越小越优先 |
| `enabled` | `boolean` | 停用则不参与调度 |
