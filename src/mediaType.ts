/**
 * Kiro 请求里 `images[].format` → 标准图片 MIME。四条译码通路共用的纯函数（不依赖 vscode）。
 *
 * Kiro 发的是裸子类型（"png" / "jpeg" / "gif" / "webp"），个别来源写成 "jpg" 或大写，极少数缺失。
 *  - "jpg" → image/jpeg：Anthropic 只认 image/jpeg（image/png / image/gif / image/webp），image/jpg 直接 400；
 *  - 缺失 / 空 → image/png：与 Chat / Responses / Gemini 通路既有的默认一致（都不嗅探 magic bytes）；
 *  - 其余小写后原样拼上 "image/"。
 */
export function imageMediaType(format: string | undefined | null): string {
  const f = String(format || "")
    .trim()
    .toLowerCase();
  if (!f) {
    return "image/png";
  }
  return "image/" + (f === "jpg" ? "jpeg" : f);
}
