import { encodeEvent, encodeException, EventStreamDecoder } from "../../src/eventstream";
import { eq, ok, run, test } from "./harness";

/** 独立实现的 CRC32（IEEE 802.3，与 zlib.crc32 一致），用来对拍编码器。 */
function crc32(buf: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("eventstream: 帧布局与 prelude/message CRC 与独立实现一致", () => {
  const frame = encodeEvent("assistantResponseEvent", { content: "你好", modelId: "m" });
  const total = frame.readUInt32BE(0);
  const headersLen = frame.readUInt32BE(4);
  eq(total, frame.length, "totalLength == buffer length");
  eq(frame.readUInt32BE(8), crc32(frame, 0, 8), "prelude CRC");
  eq(frame.readUInt32BE(total - 4), crc32(frame, 0, total - 4), "message CRC");
  ok(headersLen > 0 && headersLen < total - 16, "headersLen sane");
  const payload = frame.subarray(12 + headersLen, total - 4).toString("utf8");
  eq(JSON.parse(payload), { content: "你好", modelId: "m" }, "payload JSON（UTF-8 中文长度按字节算）");
});

test("eventstream: 单帧编解码往返，headers 解出 event-type", () => {
  const dec = new EventStreamDecoder();
  const evs = dec.feed(encodeEvent("metadataEvent", { stopReason: "END_TURN" }));
  eq(evs.length, 1, "one event");
  eq(evs[0].messageType, "event", "message-type");
  eq(evs[0].type, "metadataEvent", "event-type");
  eq(evs[0].payload, { stopReason: "END_TURN" }, "payload");
});

test("eventstream: exception 帧解出 exception-type", () => {
  const dec = new EventStreamDecoder();
  const evs = dec.feed(encodeException("InternalServerException", { message: "boom" }));
  eq(evs.length, 1, "one");
  eq(evs[0].messageType, "exception", "type");
  eq(evs[0].type, "InternalServerException", "exception-type header");
  eq((evs[0].payload as { message: string }).message, "boom", "payload");
});

test("eventstream: 半帧拼接——逐字节喂入仍按帧边界产出", () => {
  const frames = [
    encodeEvent("messageMetadataEvent", { conversationId: "c1" }),
    encodeEvent("assistantResponseEvent", { content: "a".repeat(3000), modelId: "m" }),
    encodeEvent("metadataEvent", { stopReason: "END_TURN" }),
  ];
  const all = Buffer.concat(frames);
  const dec = new EventStreamDecoder();
  const got: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (const ev of dec.feed(all.subarray(i, i + 1))) {
      got.push(ev.type);
    }
  }
  eq(got, ["messageMetadataEvent", "assistantResponseEvent", "metadataEvent"], "three frames in order");
});

test("eventstream: 一个 chunk 含多帧 + 尾巴半帧，尾巴留到下一次", () => {
  const a = encodeEvent("assistantResponseEvent", { content: "x", modelId: "m" });
  const b = encodeEvent("assistantResponseEvent", { content: "y", modelId: "m" });
  const c = encodeEvent("metadataEvent", { stopReason: "TOOL_USE" });
  const cut = 7;
  const dec = new EventStreamDecoder();
  const first = dec.feed(Buffer.concat([a, b, c.subarray(0, cut)]));
  eq(first.map((e) => e.type), ["assistantResponseEvent", "assistantResponseEvent"], "two complete frames");
  const second = dec.feed(c.subarray(cut));
  eq(second.map((e) => e.type), ["metadataEvent"], "tail completes");
  eq((second[0].payload as { stopReason: string }).stopReason, "TOOL_USE", "payload intact");
});

test("eventstream: 非 JSON payload 不抛，payload=undefined", () => {
  // 手工造一个 payload 不是 JSON 的帧：复用 encodeEvent 再改 payload 字节太麻烦，直接拼一份
  const frame = encodeEvent("x", "not-json");
  // encodeEvent 会把字符串 JSON.stringify 成 "\"not-json\""，仍是合法 JSON，所以这里改成破坏 payload 首字节
  const headersLen = frame.readUInt32BE(4);
  const mutated = Buffer.from(frame);
  mutated[12 + headersLen] = 0x7b; // '{' → 变成非法 JSON `{not-json"`
  const dec = new EventStreamDecoder();
  const evs = dec.feed(mutated);
  eq(evs.length, 1, "still one frame");
  eq(evs[0].payload, undefined, "payload undefined");
});

void run();
