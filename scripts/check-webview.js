// 把 sidebar.ts 里 webview 的 <script> 模板抠出来做 JS 语法检查——tsc 管不到模板字符串里的 JS。
// 用法：node scripts/check-webview.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");
const tag = '<script nonce="${nonce}">';
const start = src.indexOf(tag);
const end = src.indexOf("</script>", start);
if (start < 0 || end < 0) {
  console.error("webview <script> block not found");
  process.exit(1);
}
// 模板插值 ${...} 是 TS 表达式；换成安全字面量，只查 JS 语法
const raw = src.slice(start + tag.length, end).replace(/\$\{[^}]*\}/g, "null");
// 这段文本在 TS 里是模板字符串的内容：`\n`、`\\` 之类的转义会先被模板字符串吃掉再落到网页里。
// 所以要按模板字符串规则渲染一遍再查，否则写在 JS 字面量里的 '\n' 这类错误查不出来（真实页面里它会变成换行把字符串切断）。
let js = raw;
try {
  js = vm.runInNewContext("`" + raw + "`");
} catch (e) {
  console.warn("webview script: template rendering failed, checking raw text (" + e.message + ")");
}
try {
  new vm.Script(js, { filename: "webview.js" });
  console.log("webview script: syntax OK (" + js.split("\n").length + " lines)");
} catch (e) {
  console.error("webview script syntax error:", e.message);
  const m = /webview\.js:(\d+)/.exec(e.stack || "");
  if (m) {
    const ln = Number(m[1]);
    const lines = js.split("\n");
    for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
      console.error((i + 1 === ln ? ">> " : "   ") + (i + 1) + ": " + lines[i]);
    }
  }
  process.exit(1);
}
// 模板里单反斜杠的正则转义（\s \d \w \b …）会被模板字符串吃成普通字母，语法仍合法但正则语义悄悄变了；必须写成 \\s。
const lostEscapes = [];
raw.split("\n").forEach((line, i) => {
  const m = line.match(/(^|[^\\])\\[sSdDwWbB](?![\w])/g);
  if (m) lostEscapes.push((i + 1) + ": " + line.trim());
});
if (lostEscapes.length) {
  console.error("webview script: single-backslash regex escapes inside the TS template (write \\\\s, \\\\d, ...):\n  " + lostEscapes.join("\n  "));
  process.exit(1);
}
console.log("webview script: no single-backslash regex escapes in template");
const scrollStart = src.indexOf('class="usankey-scroll"');
const svgAt = src.indexOf('id="uSankeySvg"');
const scrollEnd = src.indexOf("</div>", svgAt);
const cardAt = src.indexOf('id="ctxBreakdownCard"');
if (cardAt < 0 || scrollStart < 0 || scrollEnd < 0) {
  console.error("ctx card or sankey scroll missing");
  process.exit(1);
}
if (cardAt > scrollStart && cardAt < scrollEnd) {
  console.error("ctxBreakdownCard must sit outside .usankey-scroll");
  process.exit(1);
}
console.log("ctxBreakdownCard is outside .usankey-scroll");
