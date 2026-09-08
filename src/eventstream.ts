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

/** 前导（totalLength + headersLength + preludeCRC）字节数。 */
const PRELUDE_BYTES = 12;
/** 最小合法帧：前导 12 + 尾部 message CRC 4。 */
const MIN_FRAME_BYTES = 16;
const HEADER_TYPE_BYTES = 6;
/**
 * 单帧总长上限：AWS 规范 headers ≤ 128 KiB、payload ≤ 16 MiB，再加前导与尾 CRC。
 * 前导 CRC 自洽却超过它的帧按损坏处理，不为它攒缓冲（长度字段可信，按长度精确跳过）。
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024 + 128 * 1024 + MIN_FRAME_BYTES;

export type EventStreamDecodeErrorCode = "BAD_PRELUDE" | "FRAME_TOO_LARGE" | "BAD_HEADERS";

/**
 * 解码器遇到损坏帧时抛出。抛出之前解码器已把损坏字节丢掉并把内部状态推进到下一帧候选位置，
 * 同一实例继续 feed() 即可；`events` 是本次 feed() 在撞到损坏帧之前已解出的完整帧（不会在下一次重复给出）。
 */
export class EventStreamDecodeError extends Error {
  readonly code: EventStreamDecodeErrorCode;
  readonly events: DecodedEvent[];

  constructor(code: EventStreamDecodeErrorCode, message: string, events: DecodedEvent[]) {
    super(message);
    this.name = "EventStreamDecodeError";
    this.code = code;
    this.events = events;
  }
}

/**
 * 流式解码器：Kiro 官方直通时上游的 event-stream 字节原样转给 Kiro，这里顺带解一遍帧，
 * 抠 metadataEvent 的用量与 exception 帧的错误文本（记账 / 日志）。
 * feed() 返回本次新凑齐的完整帧；不完整的尾巴留到下次。
 *
 * 健壮性合同（2026-09-08）：
 * - 只信任前导 CRC 校验通过、`total ≥ 16`、`headersLen ≤ total − 16` 且 `total ≤ MAX_FRAME_BYTES` 的长度字段；
 *   前导不自洽 → 抛 `EventStreamDecodeError("BAD_PRELUDE")`，并向后扫描下一处 CRC 自洽的前导重同步
 *   （找不到就只留 < 12 字节可能是半个前导的尾巴），同一段垃圾只报一次；
 * - 前导自洽但超上限 → 抛 `FRAME_TOO_LARGE`，随后按声明长度精确跳过该帧的剩余字节，不攒缓冲；
 * - 帧内 header 越界 / 未知类型 → 抛 `BAD_HEADERS`，跳过整帧（长度可信），后续帧照常；
 * - 等待大帧凑齐期间 chunk 只入队不拼接，缓冲上限 ≈ MAX_FRAME_BYTES + 一个 chunk，无 O(n²) 重拼 / 重解。
 * 不校验尾部 message CRC（payload 解不成 JSON 时 payload=undefined，记账层自会忽略）。
 */
export class EventStreamDecoder {
  private parts: Buffer[] = [];
  private size = 0;
  /** 前导已验过但帧未到齐时的帧总长；凑够之前不拼接。0 = 未知。 */
  private need = 0;
  /** 超上限帧还需丢弃的字节数（按声明长度跳过即精确落到下一帧）。 */
  private skip = 0;
  /** 上一次因前导损坏丢过字节且还没重新对上帧：继续跳垃圾时不再重复抛错。 */
  private desynced = false;

  feed(chunk: Buffer): DecodedEvent[] {
    let data = chunk;
    if (this.skip > 0) {
      if (data.length <= this.skip) {
        this.skip -= data.length;
        return [];
      }
      data = data.subarray(this.skip);
      this.skip = 0;
    }
    if (data.length) {
      this.parts.push(data);
      this.size += data.length;
    }
    if (this.size < PRELUDE_BYTES || (this.need > 0 && this.size < this.need)) {
      return [];
    }
    const buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.need = 0;

    const out: DecodedEvent[] = [];
    let off = 0;
    while (buf.length - off >= PRELUDE_BYTES) {
      const total = buf.readUInt32BE(off);
      const headersLen = buf.readUInt32BE(off + 4);
      if (!preludeValid(buf, off)) {
        // 长度字段不可信：往后找下一处 CRC 自洽的前导；找不到就只留可能是半个前导的尾巴
        const next = findPrelude(buf, off + 1);
        const resume = next >= 0 ? next : Math.max(off + 1, buf.length - (PRELUDE_BYTES - 1));
        const dropped = resume - off;
        if (this.desynced) {
          off = resume;
          continue;
        }
        this.desynced = true;
        this.keep(buf, resume);
        throw new EventStreamDecodeError("BAD_PRELUDE", `eventstream 帧前导损坏（total=${total} headersLen=${headersLen} CRC 不符）：丢弃 ${dropped} 字节后重同步`, out);
      }
      if (total > MAX_FRAME_BYTES) {
        const have = buf.length - off;
        if (have >= total) {
          this.keep(buf, off + total);
        } else {
          this.skip = total - have;
        }
        throw new EventStreamDecodeError("FRAME_TOO_LARGE", `eventstream 帧声明长度 ${total} 字节超过上限 ${MAX_FRAME_BYTES}：整帧丢弃`, out);
      }
      if (buf.length - off < total) {
        this.need = total;
        break;
      }
      const headers = readHeaders(buf, off + PRELUDE_BYTES, off + PRELUDE_BYTES + headersLen);
      if (!headers) {
        this.keep(buf, off + total);
        throw new EventStreamDecodeError("BAD_HEADERS", `eventstream 帧 header 越界或类型未知（total=${total} headersLen=${headersLen}）：整帧丢弃`, out);
      }
      const payloadBuf = buf.subarray(off + PRELUDE_BYTES + headersLen, off + total - 4);
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
      this.desynced = false;
    }
    this.keep(buf, off);
    return out;
  }

  /** 把 buf[from..] 留作下次 feed() 的开头（from 到尾即空）。 */
  private keep(buf: Buffer, from: number): void {
    if (from < buf.length) {
      this.parts = [buf.subarray(from)];
      this.size = buf.length - from;
    }
  }
}

/** 前导自洽：CRC 对得上且两个长度字段落在合法范围（上限另判，好让超大帧能按长度精确跳过）。 */
function preludeValid(buf: Buffer, off: number): boolean {
  const total = buf.readUInt32BE(off);
  const headersLen = buf.readUInt32BE(off + 4);
  return total >= MIN_FRAME_BYTES && headersLen <= total - MIN_FRAME_BYTES && buf.readUInt32BE(off + 8) === crc32(buf, off, off + 8);
}

/** 从 from 起逐字节找下一处自洽前导；找不到返回 -1。误判概率约 2^-32 / 位置。 */
function findPrelude(buf: Buffer, from: number): number {
  for (let i = from; i + PRELUDE_BYTES <= buf.length; i++) {
    if (preludeValid(buf, i)) {
      return i;
    }
  }
  return -1;
}

/** 解 headers 区；任何越界或未知类型返回 undefined（调用方按损坏帧处理）。 */
function readHeaders(buf: Buffer, start: number, end: number): Record<string, string> | undefined {
  const h: Record<string, string> = {};
  let p = start;
  while (p < end) {
    const nameLen = buf[p];
    p += 1;
    if (p + nameLen + 1 > end) {
      return undefined;
    }
    const name = buf.toString("utf8", p, p + nameLen);
    p += nameLen;
    const type = buf[p];
    p += 1;
    let len: number;
    if (type === HEADER_TYPE_STRING || type === HEADER_TYPE_BYTES) {
      if (p + 2 > end) {
        return undefined;
      }
      len = 2 + buf.readUInt16BE(p);
    } else {
      len = fixedHeaderValueLength(type);
      if (len < 0) {
        return undefined;
      }
    }
    if (p + len > end) {
      return undefined;
    }
    if (type === HEADER_TYPE_STRING) {
      h[name] = buf.toString("utf8", p + 2, p + len);
    }
    p += len;
  }
  return h;
}

/** 定长 header 值类型的字节数（AWS 规范）；变长（string / bytes）与未知类型返回 -1。 */
function fixedHeaderValueLength(type: number): number {
  switch (type) {
    case 0: // bool true
    case 1: // bool false
      return 0;
    case 2: // byte
      return 1;
    case 3: // short
      return 2;
    case 4: // int
      return 4;
    case 5: // int64
    case 8: // timestamp
      return 8;
    case 9: // uuid
      return 16;
    default:
      return -1;
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
