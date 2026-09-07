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
    res.write(encodeEvent("toolUseEvent", { ...ev.toolUseEvent, stop: true }));
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
