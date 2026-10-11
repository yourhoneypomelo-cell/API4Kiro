"use strict";
// .github/workflows/*.yml 的守卫。
//
// 为什么需要：GitHub 在**启动工作流之前**先按自己的 schema 校验文件，不通过就是
// 「workflow file issue」—— 运行 0 秒、一个 job 都不建、日志里也没有可看的东西。
// 这类错误用宽松的 YAML 解析器（如 Python 的 yaml.safe_load）**发现不了**，因为
// `env:` 后面只跟注释时它解析成 null，而 GitHub 要求它是映射。
//
// 实例：4.13.66 把「Bundle & package VSIX」那一步的 `npm_config_yes` 删掉后（vsce 已改本地
// 依赖、不再走 npx），`env:` 只剩两行注释 ⇒ 空映射 ⇒ main 上连续 4 次 CI 全部 0 秒失败，
// 而当时的验收报告用 python 解析 YAML 后断言「都合法」。这条守卫把那类漏网钉住。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

/** 只认「键:」（冒号后没有值）的行；`key: value`、`- key:`、`key:` 出现在引号里都不算。 */
const EMPTY_KEY_RE = /^(\s*)([A-Za-z_][\w.-]*):\s*$/;

/**
 * 找出「声明了映射但一个真实键都没有」的块。注释与空行不算子项 —— 这正是 GitHub 判非法的情形。
 * 返回 [{ line, key }]（line 为 1 起）。
 */
function emptyMappings(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EMPTY_KEY_RE.exec(lines[i]);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    let hasChild = false;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === "") {
        continue;
      }
      const ind2 = raw.length - raw.trimStart().length;
      if (ind2 <= indent) {
        break;
      }
      const body = raw.trim();
      // 注释（含 `#`）、纯列表项都可能是子项；YAML 里它们不构成映射键，
      // 但 `- ...` 说明这是序列而不是空映射，交给别的检查。
      if (body.startsWith("#")) {
        continue;
      }
      hasChild = true;
      break;
    }
    if (!hasChild) {
      out.push({ line: i + 1, key: m[2] });
    }
  }
  return out;
}

test("工作流文件不得有空映射（env: / with: 后只跟注释 ⇒ GitHub 启动即失败）", () => {
  const files = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(files.length > 0, "至少应有一个工作流文件");
  const bad = [];
  for (const f of files) {
    for (const hit of emptyMappings(fs.readFileSync(path.join(WORKFLOWS, f), "utf8"))) {
      bad.push(`.github/workflows/${f}:${hit.line} 空映射「${hit.key}:」`);
    }
  }
  assert.deepEqual(bad, [], `以下位置声明了映射却没有子项（GitHub 会判工作流非法）：\n${bad.join("\n")}`);
});

test("守卫自身的判别力：只跟注释的 env / 有子项的 env 必须能区分开", () => {
  const badText = ["jobs:", "  a:", "    steps:", "      - name: x", "        env:", "          # 只是注释", "        run: x", ""].join("\n");
  const okText = ["jobs:", "  a:", "    steps:", "      - name: x", "        env:", "          # 注释", "          A: b", "        run: x", ""].join("\n");
  assert.deepEqual(emptyMappings(badText).map((h) => h.key), ["env"], "只跟注释的 env 必须被判为空映射");
  assert.deepEqual(emptyMappings(okText), [], "有真实键的 env 不得误报");
});

test("构建步骤不得重新引入 npx 版的 vsce（本地依赖 + 锁版本）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.ok(!/npx\s+@vscode\/vsce/.test(pkg.scripts.package), "package 脚本不应再用 npx 安装 vsce");
  assert.ok(pkg.devDependencies["@vscode/vsce"], "@vscode/vsce 应在 devDependencies 里锁版本");
});
