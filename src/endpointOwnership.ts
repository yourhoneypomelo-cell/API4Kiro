/**
 * 「这组 codewhisperer 端点是本插件写的」的唯一判定实现（零依赖）。
 *
 * 宿主内的 `endpoints.ts`（清端点时判断所有权）与宿主外的卸载脚本
 * （`src/uninstall.ts`）共用它，两端不会漂移。规则：值必须是**非空数组**，
 * 且**每一项**都是对象、其 `endpoint` 字符串逐字等于 `http://127.0.0.1:<port>`
 * （port ∈ 端口集合）。原版 API2Kiro 的 19800/19801、用户手写的 https 中转、
 * null / 字符串 / 混有别的项一律 false。
 */
export function endpointListPointsAt(value: unknown, ports: readonly number[]): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const ours = new Set(ports.map((p) => `http://127.0.0.1:${p}`));
  return value.every(
    (e) => !!e && typeof e === "object" && ours.has(String((e as { endpoint?: unknown }).endpoint))
  );
}
