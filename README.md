# 工作区公约（可复制包）

把本目录内容复制到目标仓库根（与 `AGENTS.md` 同级）。复制后按本包 `AGENTS.md` 执行，不要另写第二份根公约。

内核：T0 打开完整 `docs/state/REQUIREMENTS.md`；八份最新版分文件；五类日志分文件；短公约；功能变化真建 `docs/specs/<slug>/`。本包另含跨工具薄指针与校验脚本。

## 复制后立刻做

1. 填写 `docs/state/` 八份最新版（先写 `REQUIREMENTS.md` 一句话与范围，再填接手卡，含停止点）。
2. 新窗按 `AGENTS.md` 读取阶梯开工：T0 必须含**完整** `docs/state/REQUIREMENTS.md`，不能只读接手卡。「本批加读」只补充 T1。
3. 有行为变化时从 `docs/specs/_template/` 复制出 `docs/specs/<slug>/`，禁止只把路径写在公约里。
4. 自检：`python scripts/handoff.py` 打印接手卡；`python scripts/validate_workspace.py` 检查文件树与适配器；`python scripts/test_validate_workspace.py` 跑校验器行为测试。不可逆操作前：`python scripts/create_baseline.py --label <短名>`。

## 本包含什么

- 短公约 `AGENTS.md`（文首 5 条门闩 + 读取阶梯 + 用户模式 + 规格落盘 + 目录级 overlay）
- 薄适配器：`CLAUDE.md`（`@AGENTS.md`）、`.github/copilot-instructions.md`（一行 NL）、`.gemini/settings.json`（`context.fileName`）
- alwaysApply 规则两份：完成门、接手门
- 三个 Skill：规格链 / 状态维护 / 聊天落盘
- `docs/state` 八份、`docs/logs` 五类（`CHANGE.md` 名冻结）、`docs/chats/CURRENT.md`
- 功能规格模板 `docs/specs/_template/`
- 目录级 overlay 模板 `docs/overlays/_template/AGENTS.md`
- `scripts/handoff.py`、`validate_workspace.py`、`create_baseline.py`、`test_validate_workspace.py`
- 快照目录 `docs/archive/baselines/`（按需，不是第六类日志）

取舍说明见 `来源.md`。补了什么、砍了什么见 `补或砍.md`。

## 明确不是什么

- 不是第二份根公约；复制后本目录的 `AGENTS.md` 就是目标仓根公约。
- 不把外部打分标题写入常驻文件。
- 复制进业务仓后仍须新窗口按读取阶梯接手验收。
