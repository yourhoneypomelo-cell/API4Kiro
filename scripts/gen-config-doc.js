#!/usr/bin/env node
// Generate docs/CONFIGURATION.md from package.json `contributes.configuration.properties`.
// Zero dependencies. Run from the repo root: `node scripts/gen-config-doc.js`
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props = pkg.contributes.configuration.properties;

function cell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

function fmtType(p) {
  const t = Array.isArray(p.type) ? p.type.join(" \\| ") : p.type;
  return `\`${t}\``;
}

function fmtDefault(p) {
  if (!("default" in p)) return "—";
  const d = p.default;
  if (d === null) return "`null`";
  if (typeof d === "object") {
    const s = JSON.stringify(d);
    return s.length > 60 ? "见说明" : `\`${cell(s)}\``;
  }
  if (d === "") return "`\"\"`";
  return `\`${cell(String(d))}\``;
}

function fmtDesc(p) {
  let d = cell(p.description || p.markdownDescription || "");
  if (p.enum) {
    const parts = p.enum.map((v, i) => {
      const label = (p.enumDescriptions || p.markdownEnumDescriptions || [])[i];
      return label ? `\`${v}\` = ${cell(label)}` : `\`${v}\``;
    });
    d += `<br>取值：${parts.join("；")}`;
  }
  if (typeof p.default === "object" && p.default !== null && JSON.stringify(p.default).length > 60) {
    d += `<br>默认值：\`${cell(JSON.stringify(p.default))}\``;
  }
  return d;
}

const own = Object.keys(props).filter((k) => k.startsWith("api2kiroDual."));
const internal = Object.keys(props).filter((k) => !k.startsWith("api2kiroDual."));

const lines = [];
lines.push("# 配置项参考");
lines.push("");
lines.push(`> 本文由 \`node scripts/gen-config-doc.js\` 从 \`package.json\` 生成（版本 ${pkg.version}），请勿手改；改设置项后重新生成。`);
lines.push("");
lines.push(`共 ${Object.keys(props).length} 项：\`api2kiroDual.*\` ${own.length} 项 + 由扩展自动管理的 Kiro 内部端点 ${internal.length} 项。所有设置都在 VS Code / Kiro 的 settings.json 里生效；渠道相关的项一般在侧边栏面板里维护，无需手填。`);
lines.push("");
lines.push("## api2kiroDual.*");
lines.push("");
lines.push("| 设置项 | 类型 | 默认值 | 说明 |");
lines.push("| --- | --- | --- | --- |");
for (const k of own) {
  const p = props[k];
  lines.push(`| \`${k}\` | ${fmtType(p)} | ${fmtDefault(p)} | ${fmtDesc(p)} |`);
}
lines.push("");
lines.push("## 由扩展自动管理（请勿手动编辑）");
lines.push("");
lines.push("| 设置项 | 类型 | 默认值 | 说明 |");
lines.push("| --- | --- | --- | --- |");
for (const k of internal) {
  const p = props[k];
  lines.push(`| \`${k}\` | ${fmtType(p)} | ${fmtDefault(p)} | ${fmtDesc(p)} |`);
}
lines.push("");

// providers item schema
const items = props["api2kiroDual.providers"] && props["api2kiroDual.providers"].items;
if (items && items.properties) {
  lines.push("## `api2kiroDual.providers[]` 字段");
  lines.push("");
  lines.push("| 字段 | 类型 | 说明 |");
  lines.push("| --- | --- | --- |");
  for (const [k, p] of Object.entries(items.properties)) {
    lines.push(`| \`${k}\` | ${fmtType(p)} | ${fmtDesc(p) || "—"} |`);
  }
  const cred = items.properties.credentials && items.properties.credentials.items;
  if (cred && cred.properties) {
    lines.push("");
    lines.push("### `credentials[]` 字段");
    lines.push("");
    lines.push("| 字段 | 类型 | 说明 |");
    lines.push("| --- | --- | --- |");
    for (const [k, p] of Object.entries(cred.properties)) {
      lines.push(`| \`${k}\` | ${fmtType(p)} | ${fmtDesc(p) || "—"} |`);
    }
  }
  lines.push("");
}

const out = path.join(root, "docs", "CONFIGURATION.md");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`wrote ${path.relative(root, out)} (${Object.keys(props).length} settings, v${pkg.version})`);
