<p align="center">
  <img src="assets/icon.png" width="112" alt="API4Kiro">
</p>

<h1 align="center">API4Kiro</h1>

<p align="center">
  把多家 API 聚合接入 <a href="https://kiro.dev">Kiro</a>：厂商账号登录、第三方 Key、自定义端点；按模型自动路由，用量与上下文一目了然。<br>
  <sub>Bring any Anthropic / OpenAI / Gemini-compatible API into the Kiro IDE.</sub>
</p>

<p align="center">
  <a href="https://github.com/yourhoneypomelo-cell/API4Kiro/releases/latest"><img src="https://img.shields.io/github/v/release/yourhoneypomelo-cell/API4Kiro?label=release" alt="Release"></a>
  <a href="https://github.com/yourhoneypomelo-cell/API4Kiro/actions/workflows/ci.yml"><img src="https://github.com/yourhoneypomelo-cell/API4Kiro/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yourhoneypomelo-cell/API4Kiro" alt="License"></a>
</p>

---

## 功能

- **多渠道接入**
  - 厂商账号登录（OAuth）：Kimi、Codex、xAI、Antigravity、Anthropic，以及 Kiro 官方多账号；token 存系统钥匙串，不落盘到设置文件
  - 第三方 API Key：中转站、官方 Key 均可，同一渠道可放多把 Key
  - 自定义端点：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini generateContent 四种上游格式
- **按模型自动路由**：所有启用渠道的模型合并进 Kiro 的模型选择器（可按渠道分组显示），按所选模型 ID 路由到对应渠道；支持模型 ID 映射、按模型手动覆盖图片 / 推理能力、严格 opt-in 的模型白名单
- **Key 池**：主备（`priority`）或均衡（`least-used`）两种调度；限流、额度用尽、鉴权失败按类型冷却后自动回池，同一会话粘住同一把 Key
- **思考档位**
  - Anthropic 通道：extended thinking 与 effort 档位；选择器里只显示有证据支持的档位（上游声明或模型变体真实存在）
  - OpenAI 通道：`reasoning_effort` 透传或折算，`reasoning_content` 按模型家族回传，思考 / 正文重复内容去重
- **用量与上下文**：每轮回答页脚标注本轮 token；侧边栏用量页有趋势图与 Sankey 流向图；Kiro 的 Context Usage 弹层显示真实模型窗口与分项占用
- **稳健性**：上游流在未吐出任何内容前中断时透明重试；不支持图片的模型自动剥离图片（含历史消息）并自学习；本地拦截 Kiro 的意图分类请求省一次上游调用
- **提示词库**：可在侧边栏维护并单条启用的系统提示词注入
- **模型测活与导入**：草稿渠道测延迟 / 拉模型列表 / 测活；一键从 [CC Switch](https://github.com/farion1231/cc-switch) 只读导入渠道
- **更新检查**：启动时静默检查 GitHub 最新 Release，设置页可手动检查并跳转

## 安装

1. 到 [Releases](https://github.com/yourhoneypomelo-cell/API4Kiro/releases/latest) 下载 `api2kiro-dual-<version>.vsix`
2. Kiro → 扩展面板 → 右上角 `···` → **从 VSIX 安装**，或命令行：

   ```bash
   kiro --install-extension api2kiro-dual-<version>.vsix --force
   ```

3. 若装过原版 API2Kiro：两者共用 Kiro 的 `codewhisperer.config.*Endpoints`，同一时间只能有一个生效，先在原版设置里把 `api2kiro.enabled` 设为 `false`
4. 点击活动栏的 API4Kiro 图标 → 添加渠道 → 勾选要进 Kiro 的模型 → 在设置页启用代理，按提示重载窗口

> 需要 Kiro IDE（本扩展依赖内置的 `kiro.kiroAgent`），纯 VS Code 中不会激活。

## 工作原理

- **本地代理**：扩展在本机起两个回环端口（运行时 `19810`、控制面 `19811`，与原版的 `19800/19801` 错开），并把 Kiro 的 AI 请求重定向到本地，翻译成各上游协议后转发。多个 Kiro 窗口共用端口，先启动的窗口作主实例
- **Kiro 前端补丁**：渠道分组标题样式与 Context Usage 弹层需要在 Kiro 安装目录的 kiro-agent 前端文件末尾追加带标记的补丁。补丁可逆：内含被替换函数的原文编码副本用于精确复原；关闭 `api2kiroDual.groupHeaderStyle` 即移除，Kiro 升级覆盖后自动补回并提示重载
- **凭证存储**：API Key 保存在 `api2kiroDual.providers` 设置中；OAuth token 保存在系统钥匙串

## 从源码构建

需要 Node.js 18 或更高版本（CI 使用 Node 22）。

```bash
npm ci
npm run compile   # tsc 类型检查
npm run package   # esbuild 打包 dist/extension.js 并生成 .vsix
```

Antigravity（Google Cloud Code）登录用到的 OAuth client secret 不在仓库里。构建时通过环境变量 `A2K_ANTIGRAVITY_CLIENT_SECRET` 或仓库根目录的 `antigravity.secret` 文件（已 gitignore）注入；缺省时构建照常完成，只是 Antigravity 登录不可用，其余功能不受影响。

## 目录结构

```
src/
  extension.ts            激活 / 停用、命令、配置监听
  krsServer.ts            运行时反代（Kiro → 上游）
  cpsServer.ts            控制面：模型列表、测活、用量
  providers.ts            渠道注册表与路由
  credentialPool.ts       Key 池调度与冷却
  translate.ts / *Stream.ts / *Translate.ts
                          Anthropic / OpenAI Chat / Responses / Gemini 译码与流式转发
  thinkingPolicy.ts / effort.ts
                          思考档位策略
  sidebar.ts              侧边栏 Webview（渠道 / 模型 / 用量 / 设置）
  selectorStyle.ts        Kiro 选择器样式与 Context Usage 弹层补丁
  usageStore.ts / turnLedger.ts / contextParser.ts
                          用量账本、趋势、上下文分项
  updateChecker.ts        GitHub Release 更新检查
  oauth/                  各厂商登录与 token 存储
assets/                   图标、渠道 Logo、几何线稿
esbuild.js                打包脚本（含 client secret 注入）
```

## 贡献

欢迎 Issue 与 Pull Request，流程与约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

代码以 [MIT](LICENSE) 许可发布。图标与面板中使用的第三方标识（Kiro 幽灵、CC Switch、game-icons.net 钥匙串、各厂商 Logo）的归属与许可见 [`assets/ICON-LICENSE.md`](assets/ICON-LICENSE.md) 与 [`assets/providers/LICENSE.md`](assets/providers/LICENSE.md)。
