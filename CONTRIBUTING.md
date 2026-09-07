# 参与贡献

感谢你关注 API4Kiro。本文说明如何搭环境、提问题、提 PR。

## 环境

- Node.js 18 或更高版本；Kiro IDE（用于真机验证）
- 克隆后执行：

  ```bash
  npm ci
  npm run compile   # 类型检查
  npm run package   # 生成 .vsix
  kiro --install-extension api2kiro-dual-<version>.vsix --force
  ```

- Antigravity 登录用到的 client secret 不在仓库中，构建时按 [README「从源码构建」](README.md#从源码构建) 注入；没有它也能构建与运行其余功能

## 提 Issue

- 用仓库提供的 Issue 表单（Bug / 功能建议）
- Bug 请附上：Kiro 版本、扩展版本、渠道协议（Anthropic / OpenAI Chat / Responses / Gemini）、复现步骤
- 需要日志时先在设置里打开 `api2kiroDual.debug`，复现后用命令面板的 **API4Kiro: 打开调试日志** 导出；日志已对 Key 脱敏，贴出前请再自查一遍

## 提 Pull Request

1. 从 `main` 开分支，一个 PR 只做一件事
2. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:` 等
3. 提交前确认 `npm run compile` 与 `npm run package` 通过；CI 会在 PR 上再跑一遍
4. 改动涉及 Kiro 前端补丁（`src/selectorStyle.ts`）时，请在 PR 描述中写明验证过的 Kiro 版本
5. 改了 `package.json` 里的配置项后运行 `node scripts/gen-config-doc.js` 重新生成 `docs/CONFIGURATION.md`，一并提交
6. 不要提交任何密钥、token、个人端点地址

## 版本与发布

- 版本号在 `package.json`，遵循语义化版本
- 推送 `v<version>` 标签会触发 CI 打包并挂到对应 GitHub Release
