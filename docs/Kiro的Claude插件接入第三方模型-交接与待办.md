# Kiro 的 Claude 插件接入第三方模型（CommandCode）— 交接与待办

> 写于 2026-09-24，宿主 **Kiro**。
> 本文是「会话交接文档」：把这次配置的全部结论、已落地内容、待办与回退手段集中到一处，供你自行接手。
> ⚠️ **本文所在的 `docs/人类文档/` 被 `.gitignore:145` 忽略** —— 不会进提交，也不会触发 pre-commit / 文档同步门槛。
> ⚠️ **本文不得写入任何真实 token**。当前配置里的凭据仍是占位符，所以下面展示的内容是安全的；一旦你填了真 token，**不要再把那段数组贴进本文或任何对话**。
>
> 📌 **更新记录（02:40 修正）**：原稿把 `config.json` 与仓库 `CLAUDE.md` 也列为「冻结哈希」判据 —— 实测两者都会被**本次执行之外**的原因改动（客户端自己的周期/事件落盘；你在做规则迁移并提交），故 §6 与附录 A 已改成**归因判据**。

---

## 0. 一句话现状

**机制已想清、配置已写入一半、客户端零改动。** 卡点只有一个：你用的是 **CommandCode 套餐**而不是官方 DeepSeek key，所以端点、模型名、认证头这三项待你提供；拿到后 5 分钟内可收尾。

---

## 1. 目标

让 **Kiro 里的 Claude Code 扩展**（`anthropic.claude-code-2.1.276`）用第三方后端（DeepSeek 或你的 CommandCode 套餐）推理，同时：

1. **不触碰 Claude 桌面客户端**（`~/Library/Application Support/Claude/**`）；
2. **不改动共享配置文件**（`~/.claude/*`）—— 保住 `hooks` / `enabledPlugins` / `skillOverrides`；
3. 不引入会整段覆写配置的工具（**CC Switch / cswap 不参与写入**）；
4. 每一步可验收、可回退。

---

## 2. 唯一改动点（已落地）

**文件**：`~/Library/Application Support/Kiro/User/settings.json`
**打开方式（Kiro 内）**：`⌘⇧P` → `Preferences: Open User Settings (JSON)`

**新增的键**（当前值如下，其中 key 仍是占位符）：

```jsonc
"claudeCode.environmentVariables": [
  { "name": "ANTHROPIC_CUSTOM_MODEL_OPTION",             "value": "deepseek-flash" },   // ⚠️ 见 §3，需按你的 provider 改
  { "name": "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",        "value": "DeepSeek V4.1 Flash" }, // ⚠️ 同上
  { "name": "ANTHROPIC_BASE_URL",                        "value": "https://api.deepseek.com/anthropic" }, // ⚠️ 需改成 CommandCode 的端点
  { "name": "ANTHROPIC_API_KEY",                         "value": "<PASTE_DEEPSEEK_KEY_HERE>" }, // ⚠️ 待填；认证头见 §3[3]
  { "name": "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",  "value": "1" },
  { "name": "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",          "value": "1" },
  { "name": "CLAUDE_CODE_AUTO_MODE_SERVER",              "value": "0" }
]
```

**文件改动轨迹**：8544 字节（原始）→ 8753 字节（写入前 2 条）→ **9115 字节**（当前 7 条）。
顶层键 36 → 37（只多这一个键）；既有的 `claudeCode.hideOnboarding` / `claudeCode.preferredLocation` **都还在**（合并式编辑，未覆写）。

### 为什么选这个机制

| 事实 | 出处 |
|---|---|
| `claudeCode.environmentVariables` 的 **items 是对象** `{"name","value"}`，**不是** `"KEY=value"` 字符串数组。写错格式会被判无效、静默失效 | 扩展 `package.json` → `contributes.configuration` 的 schema |
| 该键 **`"scope": "machine"`** → 只能写在**用户设置**里，workspace 设置会被忽略；也不进 Settings Sync | 同上 |
| 扩展启动时把 `{...process.env}` 与该数组**合并**后注入子进程 | 扩展打包代码里的 `function y7($){let Q=z$4(K0("environmentVariables")),X={...process.env};…}` |
| 因此它**只影响插件 spawn 的进程**，不写任何共享文件 → 这是目前唯一能区分「插件 vs 其他 Claude Code 会话」的手段 | 由上面两条推出 |

---

## 3. 待办：先补齐三项参数，再改两处值

### 需要你提供（来自 CommandCode 的文档/控制台；或只读看 CC Switch 的预设库）

**[1] base URL** —— 要 **Anthropic 格式**的那个端点（通常以 `/anthropic` 或 `/v1` 结尾），**不是** DeepSeek 的地址。

**[2] 可用模型名列表** —— 并顺带确认：你的目标是「**仍然要 DeepSeek 模型**」还是「**用我已付费的 CommandCode 套餐**（模型是它提供的那些）」？
- 若走 CommandCode → 现在那两条 `ANTHROPIC_CUSTOM_MODEL_OPTION*`（写的是 `deepseek-flash`）**应改写成它实际的模型名，或直接删掉**；
- 若走 DeepSeek（官方端点）→ 保留 `deepseek-flash` 即可。

**[3] 认证方式** —— 决定用哪个变量名：

| 它的 token 走哪个 HTTP 头 | 用哪个变量 |
|---|---|
| `x-api-key`（标准 Anthropic API key 风格） | `ANTHROPIC_API_KEY` ← 当前就是这个位置 |
| `Authorization: Bearer <token>` | `ANTHROPIC_AUTH_TOKEN`（官方文档：该值会以 `Bearer ` 前缀发出） |

### 改之前先确认一件事

**它的文档里有没有直接给 Claude Code 的接入说明（BASE_URL + TOKEN）？**
- 有 → 照抄即可；
- 若只提供**自家客户端**、token 绑死客户端或 UA → 这条路可能不通，**先验证再改配置**，别先改。

### 安全且省事的取值办法

CC Switch（你已装）的 `Add Provider` 预设库有 50+ 家 provider，其赞助商名单里全是这类中转/套餐服务，**很可能就有 CommandCode**。
👉 **只打开看预设、抄 base URL / 认证类型 / 模型名。**

🔴 **绝对不要在那里点「启用 / 切换」** —— 那一步才会整段覆写共享配置文件（CC Switch 官方 FAQ 自述「切换 provider 后插件配置会消失」）。

---

## 4. 三步验收清单

**第 0 步：填完 key/token 先别开会话** —— 那时会拿占位符当凭据发请求，必然报无效凭据。
先做一次**只看结构**的校验（只列变量名、不打印值）：JSON 合法、7 个条目都在。可直接用附录 B 的脚本 `--dry-run` 思路，或用编辑器看有无 JSON 报错。

**第 1 步：在 Kiro 里新开一个 Claude Code 会话**（不要动你正在用的那个）。`environmentVariables` 只对**新 spawn 的会话**生效。

**第 2 步：按结果分支处理**

| 你看到的 | 含义 | 你要做的 |
|---|---|---|
| **能正常对话** | 注入链路通 + provider 已切换 | 跑 `/model` 看有没有自定义模型那一行（⚠️ 看到就按 **Esc**；**别按 Enter**（会写进 `~/.claude/settings.json`）、**也别按 `s`**）；再跑 `/status` 记录 provider / base URL |
| **弹登录页** | 说明扩展**独立于环境变量**要求 Anthropic 认证 | 🔴 **别登**。先加 `claudeCode.disableLoginPrompt: true`（schema 原文：*"never prompt for login/authentication in the extension. Used when authentication is handled externally"*）再试一次 |
| **报错** | 也是信息 | 记录错误文字（有像 token 的片段自己打码） |

**第 3 步：复核这组不变量**

1. `~/Library/Application Support/Claude/claude_desktop_config.json` **哈希不变**（客户端真正的配置文件）；
2. `~/.claude/settings.json` **哈希不变**；
3. 仓库 `CLAUDE.md` **哈希不变**；
4. 客户端容器关键文件 mtime **不早于本次操作的时刻**；
5. `SUBPROCESS_ENV_SCRUB` 生效判据：**只判变量在不在**，例如在插件会话里执行等价于「该变量是否已定义」的检查，**输出只能是 OK / LEAK 之类的字面结论** —— 🔴 绝不可 `echo` 它的值（万一 scrub 没生效，token 会当场落进 transcript）。

基准哈希见附录 A。

---

## 5. 回退方法（三选一）

```bash
# 方式 1：整份还原到动手前（最彻底）
cp "${HOME}/Library/Application Support/Kiro/User/settings.json.bak-20260924-021954" \
   "${HOME}/Library/Application Support/Kiro/User/settings.json"

# 方式 2：只回退到某一步
cp "/tmp/rb-deepseek-ext/settings-before-<时间戳>.json" \
   "${HOME}/Library/Application Support/Kiro/User/settings.json"

# 方式 3：手工 —— 直接删掉 "claudeCode.environmentVariables" 这一个键（保留其余设置）
```

回退后**重启一个新的插件会话**即恢复原状（环境变量在进程启动时读取）。

⚠️ `/tmp/rb-deepseek-ext/` 可能被系统清理，重要快照请另存。

---

## 6. 安全边界与已有证据

**写入白名单（本次执行只写过这两个路径）**
1. `/tmp/rb-deepseek-ext/*`
2. `~/Library/Application Support/Kiro/User/settings.json`（+ 它自己的 `.bak`）

**客户端与仓库的核查读数**

| 检查项 | 读数 | 结论 |
|---|---|---|
| `claude_desktop_config.json` mtime | **01:59:38**（早于全部操作，此后未变） | ✅ 未触碰（它才是客户端真正的配置文件） |
| `~/.claude/settings.json` | 哈希 **OK** | ✅ 未触碰 |
| 客户端 `config.json` | 02:19:56 → **02:35:03** 两次变化 | ⚠️ **应用自己写的**（见下） |
| 仓库 `CLAUDE.md` | 02:30:55 被改，已由 **`2c098e21` @ 02:33:25** 提交 | ⚠️ **你自己改并提交的**（施工单 17 C）→ 基线作废 |
| 仓库工作区 | `git status --porcelain` = **0 条** | ✅ 本文档被 gitignore，未弄脏仓库 |

**归因结论：这两个文件都不适合用「冻结哈希」当判据**

- **`config.json`（客户端侧）** —— 02:19:56 与 02:35:03 各变一次。证据：
  ① 15–20 秒静置期内哈希**不变** → 不是持续自写，是**事件/周期触发的成批落盘**；
  ② 每次变化都与同容器内一批文件同时发生 —— 02:19 那批是 `git-worktrees.json` / `extensions-blocklist.json` / `plan-usage-history.json`；02:35 那批是 `Cookies` / `Preferences` / `DIPS-wal` / `buddy-tokens.json`，且 `plan-usage-history.json` 在 02:34 被改（**正是「当时有人在用」的痕迹**）；
  ③ 我历次写入（02:19:54 / 02:20:58 / 02:27:08 / 写本文档）都没有在它身上留下对应的 mtime 变化。
- **`CLAUDE.md`（仓库侧）** —— 属于**你正在编辑并提交**的文件，冻结哈希必然失效。

👉 **正确判据 = 归因，而不是冻结哈希**：

1. 我的写入白名单只有上面两个路径（可逐条核对命令记录）；
2. **客户端侧**硬断言改用 `claude_desktop_config.json` 的**哈希 + mtime**（稳定文件）；
3. **仓库侧**硬断言改用 **`git status --porcelain` = 0**（我的产出必须落在被忽略的位置）；
4. 其它任何变化都必须能对上「谁做的」（你 / 应用 / 我）——**对不上就停下来查**。

---

## 7. 已核实的事实与未核实项

### 已核实（有出处）

| # | 事实 |
|---|---|
| 1 | 扩展自带 CLI 二进制：`~/.kiro/extensions/anthropic.claude-code-2.1.276-darwin-arm64/resources/native-binary/claude`；**本机未安装 `claude` 命令**（登录 shell 里也找不到） |
| 2 | `~/.claude/settings.json` 当前**不含任何 `ANTHROPIC_*` / `CLAUDE_*` 变量** → 与本次设置无冲突 |
| 3 | `~/.claude/settings.json` 含 `hooks` / `enabledPlugins` / `skillOverrides` → **所以不能换 config dir**（换掉会丢插件与 hooks 接线） |
| 4 | 客户端容器里 `claude-code/` 下只有 `2.1.266` / `2.1.280` 两个版本目录（像自带二进制，不是配置落点）；登录态在 Chromium 存储（Cookies / Local Storage / IndexedDB） |
| 5 | 官方文档：**只设 `ANTHROPIC_BASE_URL` 不设凭据时，已保存的 claude.ai 登录仍会是生效凭据** → 所以 URL 与凭据**必须成对写入**（这就是我们没单独写 URL 的原因） |
| 6 | DeepSeek 官方：端点 `https://api.deepseek.com/anthropic`；`claude-opus*` 会被映射到 `deepseek-v4-pro`（**按 pro 计费**），其余映射到 `deepseek-flash` |
| 7 | CC Switch 是「整段覆写配置」的模型（其 FAQ 自述切换后插件配置会消失，并让你用 Shared Config Snippet 兜） |
| 8 | 官方开关存在且可用：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`（一次覆盖自动更新/遥测/错误上报/`/feedback`/release notes/徽章检查，并关掉 feature-flag 拉取）、`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`、`CLAUDE_CODE_AUTO_MODE_SERVER=0` |

### 未核实（不要当成结论）

| # | 项 | 处置 |
|---|---|---|
| A | **扩展宿主是否设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`** —— 若设了，settings 文件里的 provider 变量会被忽略 | 静态读不出（打包代码 3.6MB 单行、grep 被截断）。**用 `/status` 判定**；不生效 → 走附录 C 的 wrapper 分支 |
| B | 桌面客户端里的 Claude Code 是否与 `~/.claude` 同一份配置 | 只有间接线索。**不改共享配置，故不影响本方案** |
| C | settings 的 `env` 块 vs 真实进程环境变量，同一变量谁赢 | 无明确规定 → **本方案只用进程环境变量一处，不两处都配** |
| D | 你说的「插件没登录」具体表现（登录页挡死 / 能进对话但报错） | 待你实测反馈 |
| E | 扩展热重载是否覆盖 `environmentVariables` | 一律按「重启**新**会话后生效」处理（最保守） |
| F | CommandCode 的端点 / 模型名 / 认证头格式 | **本文的主要待办**（§3） |

---

## 8. 中转/套餐类 provider 的排障开关

| 症状 | 加哪个变量 | 官方说明要点 |
|---|---|---|
| 400 报 `Unexpected value(s) for the anthropic-beta header` | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | 官方原文即针对 *"a proxy gateway rejects requests with errors like…"* |
| 需要额外/自定义请求头 | `ANTHROPIC_CUSTOM_HEADERS` | *"Custom headers to add to requests (Name: Value format, newline-separated)"* |
| 想自动填满 `/model` 选择器 | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` | 从网关的 `/v1/models` 拉取 —— **也是查出模型名的省事办法** |
| 长会话自动压缩时机不对 | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 用于纠正「不认识的自定义模型 ID 的上下文窗口」 |

也在预期内的降级（非 bug）：`ANTHROPIC_BASE_URL` 指向非一方主机时，**MCP tool search 默认关闭**、**Remote Control 被禁用**；第三方端点上提示缓存通常无效（DeepSeek 兼容表明确忽略 `cache_control`），长会话成本/延迟会高于预期。

---

## 9. 明确不给担保的部分

- 我不掌握任何关于 **CommandCode** 的可核实信息，因此**不评论其合规性**，也不对你之前的「风控」顾虑给任何担保。
- 已核实的只有一条：Claude Code 官方文档对「经网关接**非 Claude** 模型」的立场是 **doesn't support**（「不提供支持」，不是「禁止」）。
- 本文里的那些开关是 **Anthropic 自己文档化的隐私开关**，不是规避手段。
- 走中转时，**推理流量不经过你的 Anthropic 账号**；残留的 Anthropic 侧外呼就是那几条遥测，而这些**已经关掉了**。

---

## 10. 附录

### A. 基线哈希与快照路径

基线文件：`/tmp/rb-deepseek-ext/baseline-1.sha256`（两组独立采样一致，可复现）

| 文件 | sha256 | 有效性 |
|---|---|---|
| `~/Library/Application Support/Claude/claude_desktop_config.json` | `004addaa…0eb1f` | ✅ **有效硬断言**（客户端真正的配置文件） |
| `~/.claude/settings.json` | `435e44b7…160d5` | ✅ **有效硬断言** |
| `~/Library/Application Support/Claude/config.json` | `20208c9c…73cca` | ⚠️ **作废** —— 应用自己会改它（02:19:56 → 02:35:03），不要当判据（见 §6） |
| 仓库 `CLAUDE.md` | `08fb958f…2ce80` | ⚠️ **作废** —— 你已改并提交（`2c098e21` @ 02:33:25）；仓库侧请改用 `git status --porcelain` 判据 |

快照与回退点：

- `~/Library/Application Support/Kiro/User/settings.json.bak-20260924-021954` ← **原始文件**
- `/tmp/rb-deepseek-ext/settings-before-20260924-022058.json` ← 写入前 2 条之前
- `/tmp/rb-deepseek-ext/settings-before-20260924-022708.json` ← 写入前 7 条之前
- `/tmp/rb-deepseek-ext/spec-task2.json` / `spec-task3.json` ← 两次写入的条目清单
- `/tmp/rb-deepseek-ext/patch_env_vars.py` ← 写入脚本（源码见附录 B）

### B. 写入脚本（`patch_env_vars.py`）

用途：把条目**合并**进 `claudeCode.environmentVariables`，只做文本级最小插入/替换（不用 `json.dump` 整体重写，保留原格式与键顺序），并在写入前后做 `json.loads` + 顶层键数量校验。**全程不打印任何 value。**

踩过的坑（已修）：插入分支最初在块尾多留了一个逗号 → 造出 `],}` 这种尾随逗号、JSON 非法。**所以务必先 `--dry-run`。**

```python
#!/usr/bin/env python3
"""把环境变量条目合并进 Kiro 用户设置的 claudeCode.environmentVariables。
用法：python3 patch_env_vars.py <spec.json> [--dry-run]
spec.json: {"ensure": [{"name": "...", "value": "..."}, ...]}
"""
import json, os, re, shutil, sys, time

PATH = os.path.expanduser("~/Library/Application Support/Kiro/User/settings.json")
KEY = "claudeCode.environmentVariables"
SNAP_DIR = "/tmp/rb-deepseek-ext"

def find_array_span(text, key):
    ki = text.index('"%s"' % key)
    ci = text.index(":", ki)
    i = text.index("[", ci)
    depth, in_str, esc = 0, False, False
    for j in range(i, len(text)):
        c = text[j]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "[": depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0: return i, j + 1
    raise ValueError("unbalanced brackets")

def fmt_array(entries, base_indent):
    inner = base_indent + "  "
    out = ["["]
    for idx, e in enumerate(entries):
        comma = "," if idx < len(entries) - 1 else ""
        out.append('%s{"name": %s, "value": %s}%s' % (
            inner, json.dumps(e["name"], ensure_ascii=False),
            json.dumps(e["value"], ensure_ascii=False), comma))
    out.append(base_indent + "]")
    return "\n".join(out)

def main():
    if len(sys.argv) < 2:
        print("usage: patch_env_vars.py <spec.json> [--dry-run]"); return 2
    dry = "--dry-run" in sys.argv
    want = json.load(open(sys.argv[1], encoding="utf-8"))["ensure"]
    text = open(PATH, encoding="utf-8").read()
    top_before = len(json.loads(text))
    print("bytes_before =", len(text), " top_level_keys_before =", top_before)

    if KEY in text:
        start, end = find_array_span(text, KEY)
        merged = list(json.loads(text).get(KEY, []))
        have = {e.get("name") for e in merged if isinstance(e, dict)}
        merged.extend([e for e in want if e["name"] not in have])
        ls = text.rfind("\n", 0, text.index('"%s"' % KEY)) + 1
        indent = re.match(r"\s*", text[ls:]).group(0)
        new = text[:start] + fmt_array(merged, indent) + text[end:]
        mode = "appended_to_existing"
    else:
        m = re.search(r'\n(\s+)"', text)
        indent = m.group(1) if m else "  "
        # 注意：块尾**不能**带逗号（这个键插在根对象最后的 } 之前，带逗号会变成 ],}）
        block = '%s"%s": %s' % (indent, KEY, fmt_array(want, indent))
        i = text.rfind("}")
        head, tail = text[:i].rstrip(), text[i:]
        head = head + (",\n" if head[-1:] not in "{," else "\n")
        new = head + block + "\n" + tail
        mode = "inserted_new_key"

    parsed = json.loads(new)
    arr = parsed.get(KEY, [])
    if not isinstance(arr, list) or any(
            not isinstance(e, dict) or "name" not in e or "value" not in e for e in arr):
        print("VALIDATION_FAILED: array shape"); return 4
    if len(parsed) not in (top_before, top_before + 1):
        print("VALIDATION_FAILED: top level key count"); return 5
    print("mode =", mode, " entry_count_after =", len(arr))
    print("entry_names =", [e["name"] for e in arr])   # 只打名字，绝不打 value
    if dry:
        print("dry_run = yes (未写入)"); return 0

    os.makedirs(SNAP_DIR, exist_ok=True)
    snap = os.path.join(SNAP_DIR, "settings-before-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
    shutil.copyfile(PATH, snap)
    open(PATH, "w", encoding="utf-8").write(new)
    print("snapshot =", snap, " written = yes"); return 0

if __name__ == "__main__":
    sys.exit(main())
```

### C. 条件分支：若 `/status` 显示 provider 未生效

说明未核实项 A 成立（宿主托管了 provider 路由）。此时**不要去改 `~/.claude/settings.json`**，改用包装脚本：

- 写一个脚本，在**更外层**注入环境变量后 `exec` 真正的二进制；
- 把设置项 `claudeCode.claudeProcessWrapper`（schema 原文：*"Executable path used to launch the Claude process"*）指向它；
- 验收同 §4 第 2 步；并确认它不影响其他会话。

### D. 与本次无关、但顺带确认过的两件事

1. **CC Switch 你已装且用过**：`/Applications/CC Switch.app`、`~/.cc-switch/`（SQLite + backups，最近一批 db 备份停在 2026-08-10）；`~/.claude/` 里留有 `settings.json.pre-ccswitch-20260807` / `pre-cswap-20260914` 等备份 → 这类工具改写过你那份共享设置。**本次没有使用它。**
2. **`.zshrc` 里的 `claude-account2()` 目前是坏的**：它调用 `command claude`，但本机**没有安装** `claude` 命令（登录 shell 里也找不到），目录 `~/.claude-account2` 仍在。若要恢复多账户用法，需要先装 CLI。
