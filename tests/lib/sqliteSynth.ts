/**
 * 合成 SQLite 文件（只写 rowid 表 B-tree 的子集）：给 sqliteReader / ccSwitchImport 的只读解析器喂料。
 * 支持：多表、叶页（0x0D）、按需拆成多叶 + 内部页根（0x05）、溢出页链、全部常用 serial type。
 * 不是完整的 SQLite 写入器；只保证产物符合文件格式规范里解析器会读的那些字段。
 */
import * as fs from "fs";

export type SynthValue = null | number | bigint | string | Uint8Array | boolean;

export interface SynthTable {
  name: string;
  createSql: string;
  rows: SynthValue[][];
  /** 每个叶页最多放几行（不填 = 尽量塞满）；填小值可强制出现内部页。 */
  maxRowsPerLeaf?: number;
}

export interface SynthOptions {
  pageSize?: number;
}

function varint(v: bigint | number): Buffer {
  let n = BigInt(v);
  if (n < 0n) {
    n = (1n << 64n) + n;
  }
  if (n >> 56n !== 0n) {
    // 9 字节形式：前 8 字节各 7 位（高位 1），最后一字节 8 位
    const out = Buffer.alloc(9);
    out[8] = Number(n & 0xffn);
    n >>= 8n;
    for (let i = 7; i >= 0; i--) {
      out[i] = Number((n & 0x7fn) | 0x80n);
      n >>= 7n;
    }
    return out;
  }
  const parts: number[] = [];
  do {
    parts.unshift(Number(n & 0x7fn));
    n >>= 7n;
  } while (n > 0n);
  for (let i = 0; i < parts.length - 1; i++) {
    parts[i] |= 0x80;
  }
  return Buffer.from(parts);
}

function encodeInt(v: bigint): { type: number; bytes: Buffer } {
  if (v === 0n) {
    return { type: 8, bytes: Buffer.alloc(0) };
  }
  if (v === 1n) {
    return { type: 9, bytes: Buffer.alloc(0) };
  }
  const fits = (bits: number) => v >= -(1n << BigInt(bits - 1)) && v < 1n << BigInt(bits - 1);
  const sizes: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [6, 5],
    [8, 6],
  ];
  for (const [len, type] of sizes) {
    if (fits(len * 8)) {
      const b = Buffer.alloc(len);
      let x = v < 0n ? (1n << BigInt(len * 8)) + v : v;
      for (let i = len - 1; i >= 0; i--) {
        b[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return { type, bytes: b };
    }
  }
  throw new Error("integer out of range");
}

export function encodeRecord(values: SynthValue[]): Buffer {
  const types: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const v of values) {
    if (v === null || v === undefined) {
      types.push(varint(0));
      bodies.push(Buffer.alloc(0));
    } else if (typeof v === "boolean") {
      const e = encodeInt(v ? 1n : 0n);
      types.push(varint(e.type));
      bodies.push(e.bytes);
    } else if (typeof v === "bigint") {
      const e = encodeInt(v);
      types.push(varint(e.type));
      bodies.push(e.bytes);
    } else if (typeof v === "number") {
      if (Number.isInteger(v)) {
        const e = encodeInt(BigInt(v));
        types.push(varint(e.type));
        bodies.push(e.bytes);
      } else {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(v);
        types.push(varint(7));
        bodies.push(b);
      }
    } else if (typeof v === "string") {
      const b = Buffer.from(v, "utf8");
      types.push(varint(13 + 2 * b.length));
      bodies.push(b);
    } else {
      const b = Buffer.from(v);
      types.push(varint(12 + 2 * b.length));
      bodies.push(b);
    }
  }
  const typesBuf = Buffer.concat(types);
  // 头长度 varint 自身也算在头里：先按 1 字节估，不够再扩
  let hdrLen = typesBuf.length + 1;
  if (varint(hdrLen).length > 1) {
    hdrLen = typesBuf.length + varint(typesBuf.length + 2).length;
  }
  return Buffer.concat([varint(hdrLen), typesBuf, ...bodies]);
}

interface Page {
  no: number;
  buf: Buffer;
}

export function buildSqlite(tables: SynthTable[], opts: SynthOptions = {}): Buffer {
  const pageSize = opts.pageSize || 4096;
  const U = pageSize; // reserved = 0
  const X = U - 35;
  const M = Math.floor(((U - 12) * 32) / 255) - 23;
  const pages: Page[] = [];
  let nextPage = 2; // page 1 留给 sqlite_master

  const alloc = (): Page => {
    const p = { no: nextPage++, buf: Buffer.alloc(pageSize) };
    pages.push(p);
    return p;
  };

  /** 组一个叶 cell（含溢出页分配）。 */
  const leafCell = (rowid: number, payload: Buffer): Buffer => {
    const P = payload.length;
    let local = P;
    if (P > X) {
      const K = M + ((P - M) % (U - 4));
      local = K <= X ? K : M;
    }
    const head = Buffer.concat([varint(P), varint(rowid)]);
    if (local === P) {
      return Buffer.concat([head, payload]);
    }
    // 溢出链
    const chunks: Buffer[] = [];
    let off = local;
    while (off < P) {
      chunks.push(payload.subarray(off, Math.min(P, off + (U - 4))));
      off += U - 4;
    }
    const ovPages = chunks.map(() => alloc());
    chunks.forEach((c, i) => {
      const pg = ovPages[i];
      pg.buf.writeUInt32BE(i + 1 < ovPages.length ? ovPages[i + 1].no : 0, 0);
      c.copy(pg.buf, 4);
    });
    const ptr = Buffer.alloc(4);
    ptr.writeUInt32BE(ovPages[0].no, 0);
    return Buffer.concat([head, payload.subarray(0, local), ptr]);
  };

  /** 把 cells 写进一个叶页（base=页头偏移，page 1 为 100）。 */
  const writeLeaf = (page: Page, base: number, cells: Buffer[]): void => {
    const b = page.buf;
    b[base] = 0x0d;
    b.writeUInt16BE(0, base + 1);
    b.writeUInt16BE(cells.length, base + 3);
    let contentStart = pageSize;
    const ptrs: number[] = [];
    for (const c of cells) {
      contentStart -= c.length;
      c.copy(b, contentStart);
      ptrs.push(contentStart);
    }
    b.writeUInt16BE(contentStart, base + 5);
    b[base + 7] = 0;
    ptrs.forEach((p, i) => b.writeUInt16BE(p, base + 8 + i * 2));
    if (base + 8 + ptrs.length * 2 > contentStart) {
      throw new Error("leaf page overflow: too many rows per leaf");
    }
  };

  const writeInterior = (page: Page, children: Array<{ pageNo: number; maxRowid: number }>): void => {
    const b = page.buf;
    b[0] = 0x05;
    b.writeUInt16BE(0, 1);
    const cells = children.slice(0, -1).map((c) => {
      const left = Buffer.alloc(4);
      left.writeUInt32BE(c.pageNo, 0);
      return Buffer.concat([left, varint(c.maxRowid)]);
    });
    b.writeUInt16BE(cells.length, 3);
    let contentStart = pageSize;
    const ptrs: number[] = [];
    for (const c of cells) {
      contentStart -= c.length;
      c.copy(b, contentStart);
      ptrs.push(contentStart);
    }
    b.writeUInt16BE(contentStart, 5);
    b[7] = 0;
    b.writeUInt32BE(children[children.length - 1].pageNo, 8);
    ptrs.forEach((p, i) => b.writeUInt16BE(p, 12 + i * 2));
  };

  /** 建一张表：返回根页号。 */
  const buildTable = (rows: SynthValue[][], maxRowsPerLeaf: number | undefined, base = 0, fixedPage?: Page): number => {
    const cells = rows.map((r, i) => leafCell(i + 1, encodeRecord(r)));
    // 贪心分叶
    const leaves: Array<{ cells: Buffer[]; maxRowid: number }> = [];
    let cur: Buffer[] = [];
    let used = base + 8;
    cells.forEach((c, i) => {
      const need = c.length + 2;
      if (cur.length && (used + need > pageSize || (maxRowsPerLeaf && cur.length >= maxRowsPerLeaf))) {
        leaves.push({ cells: cur, maxRowid: i });
        cur = [];
        used = 8;
      }
      cur.push(c);
      used += need;
    });
    leaves.push({ cells: cur, maxRowid: cells.length });
    if (leaves.length === 1) {
      const page = fixedPage || alloc();
      writeLeaf(page, base, leaves[0].cells);
      return page.no;
    }
    const leafPages = leaves.map((l) => {
      const page = alloc();
      writeLeaf(page, 0, l.cells);
      return { pageNo: page.no, maxRowid: l.maxRowid };
    });
    const root = fixedPage || alloc();
    writeInterior(root, leafPages);
    return root.no;
  };

  // 先建业务表（从第 2 页起），再写 sqlite_master 到第 1 页
  const masterRows: SynthValue[][] = [];
  for (const t of tables) {
    const root = buildTable(t.rows, t.maxRowsPerLeaf);
    masterRows.push(["table", t.name, t.name, root, t.createSql]);
  }
  const page1: Page = { no: 1, buf: Buffer.alloc(pageSize) };
  buildTable(masterRows, undefined, 100, page1);
  const total = nextPage - 1;
  const h = page1.buf;
  h.write("SQLite format 3\u0000", 0, "latin1");
  h.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  h[18] = 1;
  h[19] = 1;
  h[20] = 0;
  h[21] = 64;
  h[22] = 32;
  h[23] = 32;
  h.writeUInt32BE(1, 24);
  h.writeUInt32BE(total, 28);
  h.writeUInt32BE(1, 40);
  h.writeUInt32BE(4, 44);
  h.writeUInt32BE(1, 56);
  h.writeUInt32BE(1, 92);
  h.writeUInt32BE(3045001, 96);
  const ordered = [page1, ...pages].sort((a, b) => a.no - b.no);
  return Buffer.concat(ordered.map((p) => p.buf));
}

export function writeSqlite(file: string, tables: SynthTable[], opts: SynthOptions = {}): { pages: number } {
  const buf = buildSqlite(tables, opts);
  fs.writeFileSync(file, buf);
  return { pages: buf.length / (opts.pageSize || 4096) };
}
