/**
 * 极简的只读 SQLite 文件解析器：只做「按表名读出所有行」这一件事，零依赖、按页读取（不把整个库读进内存——
 * cc-switch 的库带着几百 MB 的用量日志，我们只要 providers 表那几页）。
 *
 * 覆盖的格式子集：rowid 表的 B-tree（叶 0x0D / 内部 0x05）、溢出页链、记录的全部 serial type、
 * sqlite_master 里的建表语句（用来把值按列名对上）。不支持 WITHOUT ROWID 表与 WAL 里未落盘的改动
 * （cc-switch 用默认的 DELETE 日志模式，主文件就是全部数据）。
 */
import * as fs from "fs";

export type SqlValue = null | number | bigint | string | Uint8Array;

interface Pager {
  fd: number;
  pageSize: number;
  usable: number;
  pageCount: number;
  page(n: number): Buffer;
}

function openPager(path: string): Pager {
  const fd = fs.openSync(path, "r");
  const header = Buffer.alloc(100);
  fs.readSync(fd, header, 0, 100, 0);
  if (header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") {
    fs.closeSync(fd);
    throw new Error("不是 SQLite 数据库文件");
  }
  let pageSize = header.readUInt16BE(16);
  if (pageSize === 1) {
    pageSize = 65536;
  }
  const reserved = header[20];
  const size = fs.fstatSync(fd).size;
  const cache = new Map<number, Buffer>();
  return {
    fd,
    pageSize,
    usable: pageSize - reserved,
    pageCount: Math.floor(size / pageSize),
    page(n: number) {
      let b = cache.get(n);
      if (!b) {
        b = Buffer.alloc(pageSize);
        fs.readSync(fd, b, 0, pageSize, (n - 1) * pageSize);
        cache.set(n, b);
      }
      return b;
    },
  };
}

/** 读一个 varint（最多 9 字节，大端 7-bit）。返回 [值, 读了几个字节]。 */
function readVarint(b: Buffer, off: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = b[off + i];
    v = (v << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return [v, i + 1];
    }
  }
  v = (v << 8n) | BigInt(b[off + 8]);
  return [v, 9];
}

/** 一个 cell 的完整载荷（含溢出页拼接）。 */
function readPayload(pg: Pager, page: Buffer, off: number, total: number, isLeaf: boolean): Buffer {
  const U = pg.usable;
  const X = isLeaf ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
  const M = Math.floor(((U - 12) * 32) / 255) - 23;
  let local = total;
  if (total > X) {
    const K = M + ((total - M) % (U - 4));
    local = K <= X ? K : M;
  }
  const out = Buffer.alloc(total);
  page.copy(out, 0, off, off + local);
  let got = local;
  if (got < total) {
    let next = page.readUInt32BE(off + local);
    while (next !== 0 && got < total) {
      const op = pg.page(next);
      next = op.readUInt32BE(0);
      const n = Math.min(U - 4, total - got);
      op.copy(out, got, 4, 4 + n);
      got += n;
    }
  }
  return out;
}

/** 解一条记录（record format）成值数组。 */
function decodeRecord(rec: Buffer): SqlValue[] {
  const [hdrSize, n0] = readVarint(rec, 0);
  let hp = n0;
  const types: bigint[] = [];
  while (hp < Number(hdrSize)) {
    const [t, n] = readVarint(rec, hp);
    types.push(t);
    hp += n;
  }
  const out: SqlValue[] = [];
  let p = Number(hdrSize);
  for (const tb of types) {
    const t = Number(tb);
    if (t === 0) {
      out.push(null);
    } else if (t >= 1 && t <= 6) {
      const len = [0, 1, 2, 3, 4, 6, 8][t];
      let v = 0n;
      for (let i = 0; i < len; i++) {
        v = (v << 8n) | BigInt(rec[p + i]);
      }
      // 补符号位
      const bits = BigInt(len * 8);
      if (v & (1n << (bits - 1n))) {
        v -= 1n << bits;
      }
      out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
      p += len;
    } else if (t === 7) {
      out.push(rec.readDoubleBE(p));
      p += 8;
    } else if (t === 8) {
      out.push(0);
    } else if (t === 9) {
      out.push(1);
    } else if (t >= 12) {
      const len = (t - 12) >> 1;
      if (t % 2 === 0) {
        out.push(new Uint8Array(rec.subarray(p, p + len)));
      } else {
        out.push(rec.toString("utf8", p, p + len));
      }
      p += len;
    } else {
      throw new Error("未知的 serial type " + t);
    }
  }
  return out;
}

/** 遍历一棵表 B-tree，逐条回调记录值。 */
function walkTable(pg: Pager, rootPage: number, onRow: (values: SqlValue[], rowid: bigint) => void): void {
  const visit = (pageNo: number) => {
    const page = pg.page(pageNo);
    const base = pageNo === 1 ? 100 : 0;
    const type = page[base];
    const cellCount = page.readUInt16BE(base + 3);
    if (type === 0x0d) {
      const ptrs = base + 8;
      for (let i = 0; i < cellCount; i++) {
        let off = page.readUInt16BE(ptrs + i * 2);
        const [plen, n1] = readVarint(page, off);
        off += n1;
        const [rowid, n2] = readVarint(page, off);
        off += n2;
        const payload = readPayload(pg, page, off, Number(plen), true);
        onRow(decodeRecord(payload), rowid);
      }
    } else if (type === 0x05) {
      const ptrs = base + 12;
      for (let i = 0; i < cellCount; i++) {
        const off = page.readUInt16BE(ptrs + i * 2);
        visit(page.readUInt32BE(off));
      }
      visit(page.readUInt32BE(base + 8));
    } else {
      throw new Error(`页 ${pageNo} 不是表 B-tree 页（类型 0x${type.toString(16)}）`);
    }
  };
  visit(rootPage);
}

/** 从 CREATE TABLE 语句里抠出列名（按顶层逗号切，忽略表级约束）。 */
export function columnsFromCreateSql(sql: string): string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) {
    return [];
  }
  const body = sql.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const cols: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s || /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(s)) {
      continue;
    }
    const m = /^("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/.exec(s);
    if (m) {
      cols.push(m[2] || m[3] || m[4] || m[5]);
    }
  }
  return cols;
}

/**
 * 读出一张表的所有行（按列名组织）。表不存在返回 undefined。
 * 老行可能比当前列少（后来 ALTER 加的列），缺的填 null。
 */
export function readTable(dbPath: string, table: string): Array<Record<string, SqlValue>> | undefined {
  const pg = openPager(dbPath);
  try {
    let root = 0;
    let createSql = "";
    // sqlite_master: type, name, tbl_name, rootpage, sql
    walkTable(pg, 1, (v) => {
      if (v[0] === "table" && typeof v[1] === "string" && v[1].toLowerCase() === table.toLowerCase()) {
        root = Number(v[3]);
        createSql = typeof v[4] === "string" ? v[4] : "";
      }
    });
    if (!root) {
      return undefined;
    }
    const cols = columnsFromCreateSql(createSql);
    const rows: Array<Record<string, SqlValue>> = [];
    walkTable(pg, root, (v, rowid) => {
      const row: Record<string, SqlValue> = {};
      cols.forEach((c, i) => {
        // INTEGER PRIMARY KEY 列在记录里存 NULL，真值是 rowid
        row[c] = i < v.length ? v[i] : null;
      });
      row.__rowid = Number(rowid);
      rows.push(row);
    });
    return rows;
  } finally {
    fs.closeSync(pg.fd);
  }
}
