/**
 * 工具参数 JSON Schema 的通用整理：把本地 `$ref`（`#/...` JSON Pointer）内联成实体。
 *
 * Kiro 内置工具（任务管理等）的 inputSchema 会用 `$ref: "#/properties/tasks/anyOf/0/..."` 这种
 * 指向自身其它位置的引用。多数上游宽容，但 xAI 一类做严格校验的会报
 * "Schema validation failed: unresolvable $ref"，尤其在它们先归一化了被引用的分支之后。
 * 我们发出去之前统一展开引用、去掉 $defs/definitions，所有协议共用。
 *
 * 循环引用（A 引 B、B 引 A）用当前路径上的引用集合截断，落成 `{}`（任意值）。
 */

import { AnthropicJsonSchema } from "./cwTypes";

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  const path = ref.slice(1);
  if (path === "" || path === "/") {
    return root;
  }
  let cur: unknown = root;
  for (const seg of path.replace(/^\//, "").split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      cur = cur[Number(key)];
    } else if (isObj(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
    if (cur === undefined) {
      return undefined;
    }
  }
  return cur;
}

function walk(node: unknown, root: Json, active: Set<string>, depth: number): unknown {
  if (depth > 40) {
    return isObj(node) ? {} : node;
  }
  if (Array.isArray(node)) {
    return node.map((v) => walk(v, root, active, depth + 1));
  }
  if (!isObj(node)) {
    return node;
  }
  if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
    const ref = node.$ref;
    const { $ref: _r, ...siblings } = node;
    void _r;
    if (active.has(ref)) {
      return { ...walk(siblings, root, active, depth + 1) as Json }; // 环：截断成任意值
    }
    const target = resolvePointer(root, ref);
    if (!isObj(target)) {
      // 解析不了的引用：与其把 $ref 原样送出去被拒，不如退成任意值并把路径记在描述里
      const rest = walk(siblings, root, active, depth + 1) as Json;
      return { ...rest, description: [rest.description, `(ref ${ref})`].filter(Boolean).join(" ") };
    }
    active.add(ref);
    const inlined = walk(target, root, active, depth + 1) as Json;
    active.delete(ref);
    // 引用旁边的兄弟键（description 等）覆盖被引用体
    return { ...inlined, ...(walk(siblings, root, active, depth + 1) as Json) };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$defs" || k === "definitions") {
      continue; // 内联之后不再需要；留着有的上游会报未知字段
    }
    out[k] = walk(v, root, active, depth + 1);
  }
  return out;
}

/** 是否含本地 $ref（不含就原样返回，省一次深拷贝）。 */
function hasLocalRef(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasLocalRef);
  }
  if (!isObj(node)) {
    return false;
  }
  if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
    return true;
  }
  return Object.values(node).some(hasLocalRef);
}

/** 展开 schema 里的本地 $ref 并去掉 $defs/definitions；没有引用时返回原对象。 */
export function inlineLocalRefs(schema: AnthropicJsonSchema | undefined): AnthropicJsonSchema | undefined {
  if (!isObj(schema)) {
    return schema;
  }
  if (!hasLocalRef(schema)) {
    if ("$defs" in schema || "definitions" in schema) {
      const { $defs: _d, definitions: _e, ...rest } = schema as Json;
      void _d;
      void _e;
      return rest as AnthropicJsonSchema;
    }
    return schema;
  }
  return walk(schema, schema as Json, new Set<string>(), 0) as AnthropicJsonSchema;
}
