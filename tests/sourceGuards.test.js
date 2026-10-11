"use strict";
// 源码级守卫（不 grep 命令行，直接读文件断言）。这些不变量靠类型系统与运行期行为都守不住，
// 只能靠「谁在什么时候写了什么」这一层断言把它们钉住。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const srcFiles = () => fs.readdirSync(path.join(REPO, "src"), { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".ts")).map((d) => `src/${d.name}`);

test("updateSetting( 的调用点白名单化（新增写入面必须显式登记）", () => {
  const allowed = new Set([
    "src/extension.ts", // enabled 开关
    "src/providers.ts", // providers 注册表（唯一写入漏斗）与旧三项 Key
    "src/config.ts", // contextWindowOverrides
    "src/sidebar.ts", // enabled 开关
  ]);
  const offenders = [];
  for (const rel of [...srcFiles(), ...fs.readdirSync(path.join(REPO, "src/oauth")).filter((f) => f.endsWith(".ts")).map((f) => `src/oauth/${f}`)]) {
    const text = read(rel);
    // 定义处（export async function updateSetting）与注释不算调用点
    text.split("\n").forEach((line, i) => {
      if (!line.includes("updateSetting(")) {
        return;
      }
      if (line.trimStart().startsWith("*") || line.includes("export async function updateSetting")) {
        return;
      }
      if (!allowed.has(rel)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `出现了白名单外的 updateSetting 调用点：${offenders.join(", ")}`);
});

test("I1：api2kiroDual.providers 只在 providers.ts 被写（唯一写入漏斗）", () => {
  const all = [...srcFiles(), ...fs.readdirSync(path.join(REPO, "src/oauth")).filter((f) => f.endsWith(".ts")).map((f) => `src/oauth/${f}`)];
  const writers = [];
  for (const rel of all) {
    const text = read(rel);
    // 写入必走 updateSetting（见上一条白名单），而 providers 的键常量 STORE_KEY 只属于 providers.ts
    if (/updateSetting\(\s*STORE_KEY/.test(text)) {
      writers.push(rel);
    }
  }
  assert.deepEqual(writers, ["src/providers.ts"], `providers 的写入点应只有 providers.ts：${writers.join(", ")}`);
  // 也不允许绕过 updateSetting 直接写配置
  for (const rel of all) {
    if (rel === "src/config.ts") {
      continue;
    }
    assert.ok(!/cfg\(\)\.update\(/.test(read(rel)), `${rel} 不该绕过 updateSetting 直接写配置`);
    assert.ok(!/globalState\.update\(\s*FB_PREFIX/.test(read(rel)), `${rel} 不该直接写 fallback.* 兜底副本`);
  }
});

test("I12：占位常量只在 keyPlaceholder.ts 里被比较/定义", () => {
  const literal = "__API4KIRO_KEYCHAIN__";
  const offenders = [];
  for (const rel of srcFiles()) {
    if (rel === "src/keyPlaceholder.ts") {
      continue;
    }
    const text = read(rel);
    text.split("\n").forEach((line, i) => {
      if (line.includes(literal)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `占位字面量出现在 ${offenders.join(", ")}（应只 import API_KEY_PLACEHOLDER）`);
  // 其余模块只能经 isPlaceholder / API_KEY_PLACEHOLDER 使用它
  assert.ok(read("src/providers.ts").includes("isPlaceholder"));
  assert.ok(read("src/apiKeys.ts").includes("API_KEY_PLACEHOLDER"));
});

test("dist/uninstall.js 不含 require(\"vscode\")（构建期已断言，这里再守一次）", () => {
  const file = path.join(REPO, "dist/uninstall.js");
  if (!fs.existsSync(file)) {
    // 未打包时跳过（npm test 的 pretest 会打包，所以正常路径下这个分支不会走到）
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!/require\(\s*["']vscode["']\s*\)/.test(text), "卸载产物里出现了 require(\"vscode\")");
});

test("updateChecker 的模态按钮顺序：「取消」在「仍要安装」之前（默认取消）", () => {
  const text = read("src/updateChecker.ts");
  assert.ok(/showWarningMessage\([\s\S]*?CANCEL_LABEL\s*,\s*INSTALL_ANYWAY_LABEL/.test(text), "没找到 showWarningMessage(... CANCEL_LABEL, INSTALL_ANYWAY_LABEL) 形态的调用");
  const cancelAt = text.indexOf("const CANCEL_LABEL");
  const anywayAt = text.indexOf("const INSTALL_ANYWAY_LABEL");
  assert.ok(cancelAt >= 0 && anywayAt >= 0 && cancelAt < anywayAt, "「取消」必须在「仍要安装」之前定义（VS Code 里第一个 item 就是回车默认动作）");
  assert.ok(text.includes("resolveInstallAnyway"), "默认取消的判决必须走纯函数 resolveInstallAnyway");
});
