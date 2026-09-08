# 安全政策 · Security Policy

本文说明 API4Kiro 接受哪些版本的安全报告、如何私下报告漏洞、哪些内容在范围内，以及几个与安全直接相关、可在源码中核对的设计事实。威胁模型、信任边界、资产清单与已知攻击面的逐项状态维护在 [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)。

This document describes which versions receive security fixes, how to report a vulnerability privately, what is in scope, and the security-relevant design facts of API4Kiro. The threat model and the status of known attack surfaces live in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## 支持的版本 · Supported Versions

只有 **最新 Release** 接受安全报告并获得修复。发现问题时请先升级到 [Releases 页](https://github.com/yourhoneypomelo-cell/API4Kiro/releases/latest)的最新版本再复现。扩展启动时会静默检查最新 Release（24 小时一次）；面板头部的「检查更新」图标与设置页「关于」卡可手动检查，有新版时直接从 Release 下载、校验并安装（4.13.54 起，见 README「侧边栏面板」）。

| 版本 | 是否支持 |
| --- | --- |
| 最新 Release | 支持：接受报告并修复 |
| 更早的任何版本 | 不支持：请升级到最新 Release |

Only the latest release is supported. Please upgrade to the latest release before reporting.

## 报告漏洞 · Reporting a Vulnerability

**请不要在公开 Issue、Pull Request 或评论里贴出可利用的细节、API Key、token、`settings.json` 片段或未自查的日志原文。**
Please do not disclose exploit details, keys, tokens or raw logs in public issues.

1. **首选：GitHub Private Vulnerability Reporting（本仓库已开启）。** 打开仓库的 [**Security** 页](https://github.com/yourhoneypomelo-cell/API4Kiro/security) → **Report a vulnerability**，填写表单；报告只有维护者可见，后续讨论也在该私有通道进行。
2. **备选：带 `security` 标签的 Issue。** 只写「哪个模块、什么类型的问题、大致影响范围」，**不要**写复现步骤、payload、任何凭据或端点地址。维护者会在 Issue 里给出私下联系方式，细节走私下通道。

报告里请包含：扩展版本、Kiro 版本、涉及的渠道协议（Anthropic / OpenAI Chat / OpenAI Responses / Gemini / Kiro 官方）、问题描述与你判断的影响、复现步骤（仅私下通道）。

**响应时间 · Response time**：维护者会在 **7 天内** 确认收到并给出初步判断（是否属于漏洞、大致严重度）。确认为漏洞后，修复随下一个 Release 发布，Release 说明中列出安全条目。本项目由个人维护，涉及协议译码或 Kiro 补丁的复杂问题修复周期可能更长，会在私下通道同步进展。
We aim to acknowledge reports within 7 days. Fixes ship with the next release and are listed in the release notes.

**披露原则 · Disclosure**：协调披露。修复版本发布后再公开细节；报告者如愿意会在 Release 说明中致谢。出于善意、不触碰他人数据与账号、不影响他人服务的安全研究，不会被视为违反本项目规则。

## 范围 · Scope

**范围内 · In scope**

- 本扩展的代码（`src/`）与 Release 中发布的 vsix
- 构建与 CI 配置（`esbuild.js`、`.github/workflows/ci.yml`）
- 文档中会把用户引向不安全用法的错误指引

**范围外 · Out of scope**

- 上游厂商的 API 与账号体系（Anthropic、OpenAI、Google、xAI、Moonshot、Kiro 官方等）
- Kiro IDE 本体及其内置的 kiro-agent 扩展（请报给 Kiro）
- 用户自建或第三方运营的中转站 / 网关
- 被本扩展只读引用的第三方数据源（models.dev 公共目录、CC Switch 数据库）

关于「同一操作系统账户下的其它进程」：本扩展的威胁模型把它们视为可信（这是 VS Code 扩展模型本身的边界，见 [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) 第 3 节）。即便如此，若你发现可以**降低这一前提**的路径——例如无需该用户权限、可由网页 / 不可信工作区 / 远程方触发——请报告。此前多窗口让位协议对同机进程无鉴权的问题已在 4.13.53 修复（同用户共享密钥 HMAC，见该文第 4 节第 1 行）。

## 安全相关的设计事实 · Security-relevant design facts

以下每条都可在源码中核对，文件名指向 `src/`：

- **凭据存放与去向。** 第三方 API Key 明文存于用户级设置 `api2kiroDual.providers`（即 `settings.json`）。4.13.53 起该项与其它含凭据 / 端点的设置项（`enabled`、`apiKey`、`baseUrl`、`officialBaseUrl`、`officialApiKey`、`openaiBaseUrl`、`openaiApiKey`、`usagePath`）声明 `scope: machine`——工作区 `.vscode/settings.json` 不能覆盖、不参与 Settings Sync；读取 `providers` 时再经 `inspect()` 只取用户级值（`providers.ts` `getProviders`）。厂商账号登录得到的 OAuth token 存于 VS Code SecretStorage（系统钥匙串，`oauth/tokenStore.ts`），仅在宿主不提供 SecretStorage 时退到 `globalState`；refresh token 等价于账号本身，不放进设置文件。OAuth token 只发往厂商规格宿主（`providers.ts` `allowedOAuthHosts`），`baseUrl` 被改到别处时不发 token、该渠道不可用；`allowCustomHost: true` 是唯一放行途径，只能写在用户设置。
- **本地服务只绑回环，且只接受本机非浏览器客户端。** KRS / CPS 监听 `127.0.0.1`（默认 19810 / 19811，`portBinder.ts`）。4.13.53 起两个服务入口第一行经 `requestGuard.ts` 校验：`Host` 必须是回环地址、不得带 `Origin`、`Sec-Fetch-Site` 若存在必须是 `none`、TCP 远端必须是回环，不符一律 403（`text/plain`，不带任何 CORS 头）——浏览器网页无法借你的凭据经本地代理调用；Kiro 自身与命令行客户端不受影响。多窗口让位与身份探测经同用户共享的随机密钥做 HMAC-SHA256 校验（`identityKey.ts` / `proxyIdentity.ts`）。登录时临时起的 OAuth 回调服务器绑 `127.0.0.1` 与 `::1`、校验 `state`、拿到结果即关闭（`oauth/core.ts`）。注意：回环端口对本机所有进程可达，TCP 回环不区分操作系统用户；守卫挡的是浏览器与远端，不是本机进程。
- **Kiro 文件补丁可逆。** 三处补丁都带标记：CSS 块用 `/* api4kiro:group-header:start */` 与 `/* api4kiro:group-header:end */` 包裹，被整体替换的函数随身携带 `a2k-orig:<base64 出厂原文>` 注释，写盘走临时文件 + 原子改名（`selectorStyle.ts` `writeAtomic`）。4.13.53 起三处写入先算计划再按顺序提交，任一写失败回滚本轮已写文件（`commitPlans`）；选择器渲染补丁自带标记门，只对本扩展模型列表（description 以 `__A2K_GRP__|` / `__A2K_MDL__|` 开头）生效，Kiro 官方列表或本扩展未运行时渲染结果与出厂表达式逐字等价。关闭代理或关闭 `api2kiroDual.groupHeaderStyle` 即复原；窗口关闭与卸载扩展时**不**复原，原因见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)「Kiro 前端补丁」。
- **Antigravity（Google）登录的 client secret 编译进 Release vsix，不在源码。** 它属于 Google OAuth「已安装应用（Installed application）」类型的客户端密钥——[Google 的 OAuth 2.0 文档](https://developers.google.com/identity/protocols/oauth2)明确写道，此类密钥嵌在应用里分发，"in this context, the client secret is obviously not treated as a secret"。它泄露只影响该 OAuth client 本身（可能被 Google 吊销、需要换一个），不等于任何用户 token 泄露。从源码构建者需自备 Google OAuth client，经环境变量 `A2K_ANTIGRAVITY_CLIENT_SECRET` 或仓库根目录已 gitignore 的 `antigravity.secret` 在构建期注入（`esbuild.js`）。
- **调试日志默认关闭。** 打开 `api2kiroDual.debug` 后，输出通道会记录发往上游的完整请求体与原始 SSE 片段（含对话内容）；日志对 Key / token 按字段名与常见形态脱敏（`log.ts` `SENSITIVE_KEY_RE` / `KEY_SHAPES`），单行超过 64 KiB 截断，打开时输出通道先打一条提醒；形态未知的密钥不会被识别。贴日志前请自查。
- **上游连接。** 按渠道 `baseUrl` 的协议走 HTTPS（Node 默认证书校验）或 HTTP（`upstream.ts`）。填写 `http://` 地址意味着对话明文离开本机。

## 已知问题与加固状态 · Known issues

一份外部审查（2026-09-07）提出了五项问题：多窗口让位协议无鉴权；provider `baseUrl` 与 OAuth token 未绑定、配置作用域可能允许工作区覆盖；上游流在工具参数中断时的工具调用与 SSE 错误帧的处理；端点接管 / 复原缺所有权判断、卸载后端点可能残留；取消后仍重试、禁用 provider 的路由缓存。加上维护者自查发现的「KRS 对任意来源放行 CORS」，六项均已在 **4.13.53** 处理并各有回归测试；逐项的前提、影响、修法与残余边界见 [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) 第 4 节。其中「窗口关闭 / 卸载时不复原端点」保留为设计决策——禁用或卸载前先关闭代理，理由见该表第 4 行。

---

相关文档：[README](README.md) · [架构概览](docs/ARCHITECTURE.md) · [配置项参考](docs/CONFIGURATION.md) · [参与贡献](CONTRIBUTING.md) · [威胁模型](docs/SECURITY-MODEL.md)

最后更新：2026-09-08（对应 4.13.54）
