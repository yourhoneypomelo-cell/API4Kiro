/** updateChecker：版本比较纯函数（GitHub Release 更新检查靠它判断新旧）。 */
import { test, run, eq, ok } from "./harness";
import { compareVersions, parseVersion, GITHUB_OWNER, GITHUB_REPO, GITHUB_URL } from "../../src/updateChecker";

test("parseVersion：去 v 前缀、按 . + - 分段、非数字段归 0", () => {
  eq(parseVersion("v4.13.51").join(","), "4,13,51");
  eq(parseVersion("4.13.51").join(","), "4,13,51");
  eq(parseVersion("4.13.51-beta.2").join(","), "4,13,51,0,2");
  eq(parseVersion("v4.13").join(","), "4,13");
  eq(parseVersion("garbage").join(","), "0");
});

test("compareVersions：新 →1 等 →0 旧 →-1，缺段补 0", () => {
  eq(compareVersions("4.13.51", "4.13.50"), 1, "51 新于 50");
  eq(compareVersions("v4.13.51", "4.13.51"), 0, "带 v 前缀视为相等");
  eq(compareVersions("4.13.50", "4.13.51"), -1, "50 旧于 51");
  eq(compareVersions("4.14.0", "4.13.99"), 1, "次版本进位");
  eq(compareVersions("5.0.0", "4.99.99"), 1, "主版本进位");
  eq(compareVersions("4.13", "4.13.0"), 0, "缺段补 0：4.13 == 4.13.0");
  eq(compareVersions("4.13.1", "4.13"), 1, "4.13.1 新于 4.13");
  ok(compareVersions("4.13.51", "4.13.51") === 0, "同版本不提示更新");
});

test("常量：owner/repo/url 指向 GitHub 仓库", () => {
  eq(GITHUB_OWNER, "yourhoneypomelo-cell");
  eq(GITHUB_REPO, "API4Kiro");
  eq(GITHUB_URL, "https://github.com/yourhoneypomelo-cell/API4Kiro");
});

run();
