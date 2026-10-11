/**
 * 顶层 JSONC 属性的读取与删除（零依赖）。
 *
 * 为什么自研：卸载钩子跑在扩展宿主之外，不能依赖 `node_modules`（vsix 用 `--no-dependencies`），
 * 而 Kiro 的 `settings.json` 是人手改过的 JSONC——带行注释、块注释、尾逗号，注释与键序必须留住。
 * `JSON.parse` + `JSON.stringify` 会把注释与格式全抹掉，所以这里做**文本级**编辑。
 *
 * 容忍：BOM、行注释、块注释、尾逗号、CRLF、单行压缩（无任何空白）的 JSONC。
 * 删除时按「后面还有成员就连带其后一个逗号，否则连带前一个逗号」处理，
 * 删完必须能用同一解析器重新解析成功，否则原样返回、不写盘。
 */

export interface JsoncMember {
  /** 键名（已解转义）。 */
  key: string;
  /** 该成员第一个非空白字符（键的左引号）在原文本里的下标。 */
  memberStart: number;
  /** 值的最后一个字符之后的下标（不含尾随空白）。 */
  memberEnd: number;
  /** 值本身。 */
  value: unknown;
}

interface ValueSpan {
  value: unknown;
  /** 值的第一个字符下标。 */
  start: number;
  /** 值的最后一个字符之后的下标。 */
  end: number;
}

const TRIVIA = " \t\r\n\uFEFF";

/** 跳过空白与注释，返回下一个有效字符的下标。 */
function skipTrivia(s: string, i: number): number {
  for (;;) {
    while (i < s.length && TRIVIA.indexOf(s[i]) >= 0) {
      i++;
    }
    if (s[i] === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? s.length : e + 2;
      continue;
    }
    return i;
  }
}

/** 读一个双引号字符串（JSON 转义），返回解出的值与闭引号之后的下标。 */
function readString(s: string, i: number): { value: string; end: number } | undefined {
  if (s[i] !== '"') {
    return undefined;
  }
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      return { value: out, end: j + 1 };
    }
    if (c === "\\") {
      const esc = s[j + 1];
      if (esc === undefined) {
        return undefined;
      }
      switch (esc) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "u": {
          const hex = s.slice(j + 2, j + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return undefined;
          }
          out += String.fromCharCode(parseInt(hex, 16));
          j += 4;
          break;
        }
        default: out += esc;
      }
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  return undefined;
}

/** 读一个 JSONC 值（对象 / 数组 / 字符串 / 数字 / true / false / null）。 */
function readValue(s: string, i: number): ValueSpan | undefined {
  const start = skipTrivia(s, i);
  const c = s[start];
  if (c === undefined) {
    return undefined;
  }
  if (c === '"') {
    const r = readString(s, start);
    return r ? { value: r.value, start, end: r.end } : undefined;
  }
  if (c === "{") {
    const o = readObject(s, start);
    return o ? { value: o.members.reduce<Record<string, unknown>>((acc, m) => ((acc[m.key] = m.value), acc), {}), start, end: o.end } : undefined;
  }
  if (c === "[") {
    const a = readArray(s, start);
    return a ? { value: a.items.map((x) => x.value), start, end: a.end } : undefined;
  }
  for (const [lit, v] of [["true", true], ["false", false], ["null", null]] as Array<[string, unknown]>) {
    if (s.startsWith(lit, start)) {
      return { value: v, start, end: start + lit.length };
    }
  }
  const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(start));
  if (m && m[0]) {
    return { value: Number(m[0]), start, end: start + m[0].length };
  }
  return undefined;
}

interface ObjectScan {
  members: JsoncMember[];
  end: number;
}

/** 读 `{ … }`（允许尾逗号）。 */
function readObject(s: string, i: number): ObjectScan | undefined {
  if (s[i] !== "{") {
    return undefined;
  }
  let j = skipTrivia(s, i + 1);
  const members: JsoncMember[] = [];
  for (;;) {
    if (s[j] === "}") {
      return { members, end: j + 1 };
    }
    if (j >= s.length) {
      return undefined;
    }
    const keyStart = j;
    const k = readString(s, j);
    if (!k) {
      return undefined;
    }
    j = skipTrivia(s, k.end);
    if (s[j] !== ":") {
      return undefined;
    }
    const v = readValue(s, j + 1);
    if (!v) {
      return undefined;
    }
    members.push({ key: k.value, memberStart: keyStart, memberEnd: v.end, value: v.value });
    j = skipTrivia(s, v.end);
    if (s[j] === ",") {
      j = skipTrivia(s, j + 1);
      continue;
    }
    if (s[j] === "}") {
      return { members, end: j + 1 };
    }
    return undefined;
  }
}

/** 读 `[ … ]`（允许尾逗号）。 */
function readArray(s: string, i: number): { items: ValueSpan[]; end: number } | undefined {
  if (s[i] !== "[") {
    return undefined;
  }
  let j = skipTrivia(s, i + 1);
  const items: ValueSpan[] = [];
  for (;;) {
    if (s[j] === "]") {
      return { items, end: j + 1 };
    }
    if (j >= s.length) {
      return undefined;
    }
    const v = readValue(s, j);
    if (!v) {
      return undefined;
    }
    items.push(v);
    j = skipTrivia(s, v.end);
    if (s[j] === ",") {
      j = skipTrivia(s, j + 1);
      continue;
    }
    if (s[j] === "]") {
      return { items, end: j + 1 };
    }
    return undefined;
  }
}

/** 解析一段顶层 JSONC 对象；不是「单个对象 + 尾随空白」就返回 undefined。 */
function parseDocument(text: string): { members: JsoncMember[] } | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const start = skipTrivia(text, 0);
  if (text[start] !== "{") {
    return undefined;
  }
  const o = readObject(text, start);
  if (!o) {
    return undefined;
  }
  if (skipTrivia(text, o.end) !== text.length) {
    return undefined;
  }
  return { members: o.members };
}

/**
 * 整份文本是不是「单个 JSONC 对象 + 尾随空白」。
 *
 * 专门给调用方做「解析失败就整份不动」的闸门用：判据必须走解析器本身，
 * 不能只看第一个非空白字符是不是 `{` —— 文件开头的一行注释也是合法 JSONC（`skipTrivia` 会跳过），
 * 把它当成解析失败会让整份 settings 的清理静默失效。
 */
export function parsesAsObject(text: string): boolean {
  return parseDocument(text) !== undefined;
}

/** 顶层成员的键名列表（解析失败 → 空数组）。 */
export function topLevelKeys(text: string): string[] {
  const doc = parseDocument(text);
  return doc ? doc.members.map((m) => m.key) : [];
}

/** 读顶层某个键的值；键不存在或整份文本解析失败 → undefined。 */
export function readTopLevel(text: string, key: string): unknown {
  const doc = parseDocument(text);
  if (!doc) {
    return undefined;
  }
  const m = doc.members.find((x) => x.key === key);
  return m ? m.value : undefined;
}

/**
 * 删除顶层某个键（文本级，保留注释与格式）。删完自校验：必须能用同一解析器重新解析成功，
 * 否则返回原文 + `removed: false`（宁可不删，也不把 settings.json 弄坏）。
 */
export function removeTopLevelProperty(text: string, key: string): { text: string; removed: boolean } {
  const doc = parseDocument(text);
  if (!doc) {
    return { text, removed: false };
  }
  const idx = doc.members.findIndex((m) => m.key === key);
  if (idx < 0) {
    return { text, removed: false };
  }
  const m = doc.members[idx];
  let from: number;
  let to: number;
  if (idx + 1 < doc.members.length) {
    // 后面还有成员：连它后面的逗号一起删（这里的逗号必然是它与下一项之间的分隔符）
    from = m.memberStart;
    to = doc.members[idx + 1].memberStart;
  } else if (idx > 0) {
    // 最后一个成员（且不是唯一成员）：连带前一个逗号
    const comma = text.indexOf(",", doc.members[idx - 1].memberEnd);
    from = comma >= 0 && comma < m.memberStart ? comma : m.memberStart;
    to = m.memberEnd;
  } else {
    from = m.memberStart;
    to = m.memberEnd;
  }
  const out = text.slice(0, from) + text.slice(to);
  if (!parseDocument(out)) {
    return { text, removed: false };
  }
  return { text: out, removed: true };
}
