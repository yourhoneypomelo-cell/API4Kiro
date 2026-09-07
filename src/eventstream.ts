/**
 * AWS `application/vnd.amazon.eventstream` binary encoder.
 *
 * Frame layout (all integers big-endian):
 *   [totalLength u32][headersLength u32][preludeCRC u32]
 *   [headers...][payload...][messageCRC u32]
 *
 * Header layout:
 *   [nameLen u8][name][valueType u8=7 (string)][valueLen u16][value]
 *
 * Kiro's bundled CodeWhisperer client parses exactly this format for the
 * streaming AI response, so the proxy must emit it verbatim.
 */

export const EVENT_STREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";

const HEADER_TYPE_STRING = 7;

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function encodeHeader(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const valBuf = Buffer.from(value, "utf8");
  const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
  let off = 0;
  buf.writeUInt8(nameBuf.length, off);
  off += 1;
  nameBuf.copy(buf, off);
  off += nameBuf.length;
  buf.writeUInt8(HEADER_TYPE_STRING, off);
  off += 1;
  buf.writeUInt16BE(valBuf.length, off);
  off += 2;
  valBuf.copy(buf, off);
  return buf;
}

function encodeFrame(headers: Buffer, payload: Buffer): Buffer {
  const headersLen = headers.length;
  const total = 12 + headersLen + payload.length + 4;
  const buf = Buffer.alloc(total);
  let off = 0;
  buf.writeUInt32BE(total, off);
  off += 4;
  buf.writeUInt32BE(headersLen, off);
  off += 4;
  buf.writeUInt32BE(crc32(buf, 0, 8), off);
  off += 4;
  headers.copy(buf, off);
  off += headersLen;
  payload.copy(buf, off);
  off += payload.length;
  buf.writeUInt32BE(crc32(buf, 0, off), off);
  return buf;
}

/** Encode a normal `event` message with a JSON payload. */
export function encodeEvent(eventType: string, payload: unknown): Buffer {
  const headers = Buffer.concat([
    encodeHeader(":message-type", "event"),
    encodeHeader(":event-type", eventType),
    encodeHeader(":content-type", "application/json"),
  ]);
  return encodeFrame(headers, Buffer.from(JSON.stringify(payload), "utf8"));
}

export interface DecodedEvent {
  /** `:message-type`：event / exception / error。 */
  messageType: string;
  /** `:event-type`（event）或 `:exception-type`（exception）。 */
  type: string;
  /** payload 解成的 JSON；不是 JSON 时为 undefined。 */
  payload: unknown;
}

/**
 * 流式解码器：Kiro 官方直通时上游的 event-stream 字节原样转给 Kiro，这里顺带解一遍帧，
 * 抠 metadataEvent 的用量与 exception 帧的错误文本（记账 / 日志），不校验 CRC。
 * feed() 返回本次新凑齐的完整帧；不完整的尾巴留到下次。
 */
export class EventStreamDecoder {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): DecodedEvent[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: DecodedEvent[] = [];
    let off = 0;
    while (this.buf.length - off >= 16) {
      const total = this.buf.readUInt32BE(off);
      const headersLen = this.buf.readUInt32BE(off + 4);
      if (total < 16 || headersLen > total - 16) {
        // 帧头不合法：放弃剩余字节（透传本身不受影响）
        off = this.buf.length;
        break;
      }
      if (this.buf.length - off < total) {
        break;
      }
      const headers = this.readHeaders(off + 12, off + 12 + headersLen);
      const payloadBuf = this.buf.subarray(off + 12 + headersLen, off + total - 4);
      let payload: unknown;
      try {
        payload = payloadBuf.length ? JSON.parse(payloadBuf.toString("utf8")) : undefined;
      } catch {
        payload = undefined;
      }
      const messageType = headers[":message-type"] || "event";
      out.push({
        messageType,
        type: messageType === "exception" ? headers[":exception-type"] || "" : headers[":event-type"] || headers[":error-code"] || "",
        payload,
      });
      off += total;
    }
    this.buf = off ? this.buf.subarray(off) : this.buf;
    return out;
  }

  private readHeaders(start: number, end: number): Record<string, string> {
    const h: Record<string, string> = {};
    let p = start;
    while (p < end) {
      const nameLen = this.buf[p];
      p += 1;
      const name = this.buf.subarray(p, p + nameLen).toString("utf8");
      p += nameLen;
      const type = this.buf[p];
      p += 1;
      if (type === HEADER_TYPE_STRING) {
        const len = this.buf.readUInt16BE(p);
        p += 2;
        h[name] = this.buf.subarray(p, p + len).toString("utf8");
        p += len;
      } else {
        // 其它类型（bool / int / timestamp / uuid / bytes）按 AWS 规范长度跳过
        p += headerValueLength(type, this.buf, p);
      }
    }
    return h;
  }
}

function headerValueLength(type: number, buf: Buffer, p: number): number {
  switch (type) {
    case 0: // bool true
    case 1: // bool false
      return 0;
    case 2:
      return 1;
    case 3:
      return 2;
    case 4:
      return 4;
    case 5: // int64
    case 8: // timestamp
      return 8;
    case 6: // byte array
      return 2 + buf.readUInt16BE(p);
    case 9: // uuid
      return 16;
    default:
      return 0;
  }
}

/** Encode an `exception` message (used for error surfacing to Kiro). */
export function encodeException(exceptionType: string, payload: unknown): Buffer {
  const headers = Buffer.concat([
    encodeHeader(":message-type", "exception"),
    encodeHeader(":exception-type", exceptionType),
    encodeHeader(":content-type", "application/json"),
  ]);
  return encodeFrame(headers, Buffer.from(JSON.stringify(payload), "utf8"));
}
