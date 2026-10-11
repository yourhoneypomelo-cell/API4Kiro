/**
 * Key 占位标记的唯一语义入口（**零 import**）。
 *
 * 为什么单独一个叶子模块：`config.ts` 要用 `resolveKeyValue`，而
 * `apiKeys.ts → oauth/tokenStore.ts → log.ts → config.ts` 是一条既有链——把这三个纯函数留在
 * `apiKeys.ts` 就会造出 `config → apiKeys → … → config` 的环。本文件不 import 任何模块，
 * 所以新增的边只有 `config → keyPlaceholder`、`providers → keyPlaceholder / apiKeys`。
 *
 * 占位语义**只依赖值本身**，不依赖任何注册状态：占位 ⇒ 查钥匙串（未注册或查不到 ⇒ 空串）；
 * 空 ⇒ 空串；其余原样。没有「未注册就返回原值」这条分支——那等于把一个不是 key 的字符串当 key：
 * `isAnthropicUsable()` 会因 `!!getApiKey()` 变 true、面板会把占位显示成「已配置」、
 * `authHeaders` 会把占位当 Bearer 发出去。
 */

/** settings.json 里代替真实 API Key 的固定标记。明显不属于任何厂商的 key 形态。 */
export const API_KEY_PLACEHOLDER = "__API4KIRO_KEYCHAIN__";

/** 值是不是占位标记（前后空白容忍，读 settings 时可能带缩进）。 */
export function isPlaceholder(v: unknown): boolean {
  return typeof v === "string" && v.trim() === API_KEY_PLACEHOLDER;
}

/** key 类凭证在钥匙串里的槽位：`key:<providerId>/<credId>`；`key:` 前缀与 OAuth 的裸键物理隔离。 */
export function keySlot(providerId: string, credentialId: string): string {
  return `key:${providerId}/${credentialId}`;
}

/** 旧三项全局配置（apiKey / officialApiKey / openaiApiKey）各占一个独立槽位。 */
export function legacyKeySlot(configKey: string): string {
  return `key:@legacy/${configKey}`;
}

type KeyLookup = (slot: string) => string | undefined;

let lookup: KeyLookup | undefined;
/** 占位在「查找器尚未注册」时被解析的次数（fail-closed 回落次数）。生产路径该值恒为 0。 */
let unregisteredLookups = 0;

/** 由 `apiKeys.ts` 在**导入期**注册：占位 ⇒ 去钥匙串取真值。 */
export function registerKeyLookup(fn: KeyLookup | undefined): void {
  lookup = fn;
}

/** 发生过多少次「占位 + 无查找器」的解析；测试用它证明没有「占位在注册前被解析」的窗口。 */
export function lookupCount(): number {
  return unregisteredLookups;
}

/** 仅测试用：清掉查找器与计数。 */
export function _resetKeyLookupForTest(): void {
  lookup = undefined;
  unregisteredLookups = 0;
}

/**
 * 读一个 key 字段的**最终值**：占位 ⇒ 查钥匙串（查不到 / 未注册 ⇒ 空串，fail-closed），
 * 空 ⇒ 空串，其余原样。**永不返回占位标记本身**。
 */
export function resolveKeyValue(raw: string, slot: string): string {
  const v = typeof raw === "string" ? raw : "";
  if (!v) {
    return "";
  }
  if (!isPlaceholder(v)) {
    return v;
  }
  if (!lookup) {
    unregisteredLookups++;
    return "";
  }
  const found = lookup(slot);
  return typeof found === "string" ? found : "";
}
