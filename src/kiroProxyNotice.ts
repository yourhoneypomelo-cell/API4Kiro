/**
 * kiro-proxy 前置闸的用户可见提示（纯函数，不 import vscode）。
 *
 * 为什么单独一个模块：提示文案由「本轮是不是全部跳过」「跳过哪几份」「哪几份旁边有出厂备份」共同决定，
 * 混在 `extension.ts#notifyStyleSync` 的 `showWarningMessage` 调用里就只能靠人读；抽成纯函数后单测能直接
 * 断言两种分支的输出（4.13.66 之前的缺陷正是「部分跳过」被说成「本次未写入任何 Kiro 文件」）。
 */
import type { StyleSyncResult } from "./selectorStyle";

/** kiro-proxy 自己留下的出厂备份名后缀（与 `selectorStyle.ts` 的 KIRO_PROXY_BAK 同源：`<文件名>.kiroproxy-bak-<版本>`）。 */
const BAK = ".kiroproxy-bak-";

/** 提示正文三段：head 说这次写了什么、why 说为什么不能动、hint 说用户能做什么。 */
export type KiroProxyNotice = { head: string; why: string; hint: string };

/**
 * 本轮是不是「所有目标文件都带残留、一个字节都没写」。
 *
 * 以 `result.allSkipped`（`selectorStyle.ts` 逐文件判定后显式传出）为准。**不得**再用 `targets` 三个字段反推：
 * 逐文件粒度下部分跳过时，被跳过的 chunk 与后端同样报 `unavailable`，反推会把「跳过 3 份、另外 2 份照常打补丁」
 * 说成「什么也没写」。字段缺失（旧数据 / 测试桩）时才退回旧反推——那时三个字段全 unavailable 确实等价于整轮拒绝。
 */
export function isAllSkipped(result: StyleSyncResult): boolean {
  if (typeof result.allSkipped === "boolean") {
    return result.allSkipped;
  }
  const t = result.targets;
  return t.style === "unavailable" && t.selectorScript === "unavailable" && t.backend === "unavailable";
}

/** 某个被跳过文件旁边有没有**它自己**的出厂备份（备份路径形如 `<该文件路径>.kiroproxy-bak-<版本>`）。 */
function backupFor(backups: string[], file: string): string | undefined {
  return backups.find((b) => b.includes(`${file}${BAK}`));
}

/**
 * 补救指引：把被跳过的文件逐份对应到「有出厂备份 / 没有出厂备份」，并说明成对规则的后果。
 *
 * 为什么必须逐份说明：`findKiroProxyBackups` 只列「被跳过文件所在目录下所有 `.kiroproxy-bak-*`」，
 * 不保证每份都有（真机 `agent-chat` 的 style.css 就没有）。而闸门对同一 package 是**成对**跳过
 * （chunk 与 style.css 必须成对，见 `syncGroupHeaderStyleUnlocked`），所以「有备份的那几份还原回去」
 * 并不一定能解开这一对——不写清楚的话用户照做一遍仍然不生效，也不知道该看哪里。
 */
function buildHint(skipped: string[], backups: string[]): string {
  const paired = skipped.map((file) => ({ file, backup: backupFor(backups, file) }));
  const withBackup = paired.filter((p) => p.backup);
  const without = paired.filter((p) => !p.backup);
  const parts: string[] = [];
  if (withBackup.length > 0) {
    parts.push(
      "本机检测到 kiro-proxy 自己留下的出厂备份，可用它覆盖回对应文件（先退出 Kiro 以免文件被占用，备份名去掉 .kiroproxy-bak-<版本> 后缀就是原文件名）：" +
        withBackup.map((p) => `${p.file} ← ${p.backup}`).join("；") +
        "。"
    );
  }
  if (without.length > 0) {
    parts.push(
      `没有出厂备份的被跳过文件：${without.map((p) => p.file).join("、")}——` +
        (withBackup.length > 0
          ? "这几份只能到 kiro-proxy 一侧还原它的补丁（或手工删掉文件里的 kiroproxy- 标记段）。"
          : "请先到 kiro-proxy 一侧还原它的补丁（或恢复 Kiro 出厂文件）后重新打开本扩展的卡片样式。")
    );
  }
  if (withBackup.length > 0) {
    parts.push(
      "注意：同一 package 的选择器 chunk 与 style.css 必须成对打补丁，还原备份不一定能解开一对——" +
        "同一 package 的另一份（通常是 style.css）只要仍带残留，这一对就继续被跳过。"
    );
  }
  return parts.join("");
}

/** 由前置闸结果拼出提示正文（head + why + hint）。调用方只在 `blockedBy === "kiro-proxy"` 时调用。 */
export function buildKiroProxyNotice(result: StyleSyncResult): KiroProxyNotice {
  const skipped = result.skippedBy || [];
  const backups = result.kiroProxyBackups || [];
  const all = isAllSkipped(result);
  const multi = skipped.length > 1;
  const head = all
    ? "API4Kiro 检测到 Kiro 目录里有 kiro-proxy 的补丁残留（kiroproxy-），为避免两套补丁互相覆盖，本次未写入任何 Kiro 文件。"
    : `API4Kiro 检测到 kiro-proxy 的补丁残留（kiroproxy-），本次跳过这些文件：${skipped.join("、")}；其余干净文件已照常打补丁。`;
  const why = multi
    ? "两套补丁落在同一个文件里会互相覆盖（双方的段落标记都可能认不出来），所以带残留的那几份不能动。" +
      "被跳过的那几份文件里，模型选择器会原样显示 __A2K_GRP__|… 这类内部标记、分组标题也可能被选中。"
    : "两套补丁落在同一个文件里会互相覆盖（双方的段落标记都可能认不出来），所以带残留的那一份不能动。" +
      "被跳过的那一处，模型选择器会原样显示 __A2K_GRP__|… 这类内部标记、分组标题也可能被选中。";
  return { head, why, hint: buildHint(skipped, backups) };
}
