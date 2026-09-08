import { ServerResponse } from "http";
import { CwEvent } from "./cwTypes";
import { encodeEvent } from "./eventstream";

/**
 * Serialize a single internal CwEvent to its binary event-stream frame and
 * write it to the response. Mirrors the reference plugin's `writeEvent`.
 */
export function writeEvent(res: ServerResponse, ev: CwEvent): void {
  if (ev.assistantResponseEvent) {
    res.write(encodeEvent("assistantResponseEvent", ev.assistantResponseEvent));
  } else if (ev.messageMetadataEvent) {
    res.write(encodeEvent("messageMetadataEvent", ev.messageMetadataEvent));
  } else if (ev.toolUseEvent) {
    // stop 默认 true（参数已收全，Kiro 据此关闭该工具的参数流并执行）。转换器只在参数**没收全**时显式给 stop:false：
    // Kiro 的 ProcessChunkStream 看到「末尾工具有参数却没收到 stop」即判截断（OutputTruncatedError，工具不执行），
    // 与 stopReason=MAX_TOKENS 互为双保险——只发 MAX_TOKENS 时 Kiro 侧 close 与 error 之间有微任务竞态。
    res.write(encodeEvent("toolUseEvent", { ...ev.toolUseEvent, stop: ev.toolUseEvent.stop !== false }));
  } else if (ev.reasoningContentEvent) {
    res.write(encodeEvent("reasoningContentEvent", ev.reasoningContentEvent));
  } else if (ev.contextUsageEvent) {
    res.write(encodeEvent("contextUsageEvent", ev.contextUsageEvent));
  } else if (ev.meteringEvent) {
    res.write(encodeEvent("meteringEvent", ev.meteringEvent));
  } else if (ev.metadataEvent) {
    res.write(encodeEvent("metadataEvent", ev.metadataEvent));
  }
}
