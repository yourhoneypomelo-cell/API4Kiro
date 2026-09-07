/**
 * R21：工具 JSON Schema 本地 $ref 内联、$defs 去除、循环引用截断，四协议都经 parseToolSpec 拿 schema。
 */
import { inlineLocalRefs } from "../../src/schemaUtil";
import { buildAnthropicRequest, parseToolSpec } from "../../src/translate";
import { buildOpenaiRequest } from "../../src/openaiTranslate";
import { buildResponsesRequest } from "../../src/responsesTranslate";
import { buildGeminiRequest, cleanSchemaForGemini } from "../../src/geminiTranslate";
import { cwRequest, provider, toolSpec } from "./fixtures";
import { eq, notIncludes, ok, run, test } from "./harness";

const withDefs = {
  type: "object",
  properties: {
    task: { $ref: "#/$defs/Task", description: "the task" },
    tasks: { type: "array", items: { $ref: "#/definitions/Task2" } },
  },
  required: ["task"],
  $defs: { Task: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  definitions: { Task2: { type: "string", enum: ["a", "b"] } },
};

test("schemaUtil: $defs/definitions 内联并去除；兄弟键覆盖被引用体", () => {
  const out = inlineLocalRefs(withDefs as never) as Record<string, unknown>;
  const s = JSON.stringify(out);
  notIncludes(s, "$ref", "no $ref left");
  notIncludes(s, "$defs", "no $defs left");
  notIncludes(s, "definitions", "no definitions left");
  const props = out.properties as Record<string, Record<string, unknown>>;
  eq(props.task.type, "object", "task inlined");
  eq(props.task.description, "the task", "sibling description kept");
  eq((props.task.properties as Record<string, unknown>).id, { type: "string" }, "nested inlined");
  eq((props.tasks.items as Record<string, unknown>).enum, ["a", "b"], "items ref via definitions inlined");
});

test("schemaUtil: 指向自身其它位置的 JSON Pointer（Kiro 内置工具形态）", () => {
  const schema = {
    type: "object",
    properties: {
      tasks: { type: "array", items: { anyOf: [{ type: "object", properties: { name: { type: "string" } } }, { type: "null" }] } },
      one: { $ref: "#/properties/tasks/items/anyOf/0" },
    },
  };
  const out = inlineLocalRefs(schema as never) as Record<string, unknown>;
  const props = out.properties as Record<string, Record<string, unknown>>;
  eq(props.one.type, "object", "pointer into properties path resolved");
  notIncludes(JSON.stringify(out), "$ref", "no $ref");
});

test("schemaUtil: 循环引用（A→B→A）截断为任意值且不栈溢出", () => {
  const cyc = {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/$defs/A" }, leaf: { type: "number" } } },
    },
  };
  const out = inlineLocalRefs(cyc as never) as Record<string, unknown>;
  const s = JSON.stringify(out);
  notIncludes(s, "$ref", "no $ref");
  const a = (out.properties as Record<string, Record<string, unknown>>).a;
  const b = (a.properties as Record<string, Record<string, unknown>>).b;
  const a2 = (b.properties as Record<string, Record<string, unknown>>).a;
  eq(a2, {}, "cycle truncated to {}");
  eq((b.properties as Record<string, Record<string, unknown>>).leaf, { type: "number" }, "non-cyclic sibling survives");
});

test("schemaUtil: 自引用 $ref:'#' 截断；无引用时原对象返回（省拷贝）；有 $defs 无引用也去掉 $defs", () => {
  const self = { type: "object", properties: { me: { $ref: "#" } } };
  const out = inlineLocalRefs(self as never) as Record<string, unknown>;
  notIncludes(JSON.stringify(out), "$ref", "self ref gone");
  const plain = { type: "object", properties: { x: { type: "string" } } };
  ok(inlineLocalRefs(plain as never) === plain, "same reference when nothing to do");
  const defsOnly = { type: "object", properties: {}, $defs: { X: {} } };
  const o2 = inlineLocalRefs(defsOnly as never) as Record<string, unknown>;
  ok(!("$defs" in o2), "$defs stripped even without refs");
  eq(inlineLocalRefs(undefined), undefined, "undefined passthrough");
});

test("schemaUtil: 解析不了的引用退成任意值并把路径写进 description", () => {
  const schema = { type: "object", properties: { x: { $ref: "#/$defs/Missing", description: "d" } } };
  const out = inlineLocalRefs(schema as never) as Record<string, unknown>;
  const x = (out.properties as Record<string, Record<string, unknown>>).x;
  notIncludes(JSON.stringify(out), "$ref", "no $ref");
  ok(String(x.description).includes("(ref #/$defs/Missing)"), "path recorded");
});

test("parseToolSpec: toolSpecification.inputSchema.json 与裸 inputSchema 两种形态都内联", () => {
  const a = parseToolSpec(toolSpec("t", withDefs));
  notIncludes(JSON.stringify(a.schema), "$ref", "nested json form");
  const b = parseToolSpec({ name: "t2", inputSchema: withDefs as never });
  notIncludes(JSON.stringify(b.schema), "$ref", "bare form");
  eq(b.name, "t2", "name");
});

test("四协议请求体里都没有 $ref / $defs", () => {
  const req = cwRequest("hi", { tools: [toolSpec("taskTool", withDefs)] });
  const pa = provider({ protocol: "anthropic" });
  const po = provider({ protocol: "openai" });
  const pr = provider({ protocol: "openai", openaiApi: "responses" });
  const pg = provider({ protocol: "gemini" });

  const bodies = {
    anthropic: buildAnthropicRequest(req, pa),
    openai: buildOpenaiRequest(req, po),
    responses: buildResponsesRequest(req, pr),
    gemini: buildGeminiRequest(req, pg).request,
  };
  for (const [k, body] of Object.entries(bodies)) {
    const s = JSON.stringify(body);
    notIncludes(s, '"$ref"', `${k}: no $ref`);
    notIncludes(s, '"$defs"', `${k}: no $defs`);
    notIncludes(s, '"definitions"', `${k}: no definitions`);
    ok(s.includes("taskTool"), `${k}: tool present`);
  }
  // anthropic 形态：tools[].input_schema；openai：tools[].function.parameters；responses：tools[].parameters；gemini：functionDeclarations
  eq((bodies.anthropic.tools![0].input_schema.properties as Record<string, Record<string, unknown>>).task.type, "object", "anthropic inlined");
  eq((bodies.openai.tools![0].function.parameters.properties as Record<string, Record<string, unknown>>).task.type, "object", "openai inlined");
  eq((bodies.responses.tools![0].parameters.properties as Record<string, Record<string, unknown>>).task.type, "object", "responses inlined");
  const gp = bodies.gemini.tools![0].functionDeclarations[0].parameters as Record<string, unknown>;
  eq((gp.properties as Record<string, Record<string, unknown>>).task.type, "object", "gemini inlined");
});

test("cleanSchemaForGemini: 去 $schema/additionalProperties，anyOf 摊平，非字符串枚举进 description，array 缺 items 补", () => {
  const out = cleanSchemaForGemini(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { anyOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] },
        n: { type: "integer", enum: [1, 2] },
        opt: { type: ["string", "null"] },
        list: { type: "array" },
        free: { type: "object" },
      },
      required: ["mode", "ghost"],
    } as never,
    { placeholder: false }
  ) as Record<string, unknown>;
  const s = JSON.stringify(out);
  notIncludes(s, "$schema", "no $schema");
  notIncludes(s, "additionalProperties", "no additionalProperties");
  notIncludes(s, "anyOf", "anyOf flattened");
  const props = out.properties as Record<string, Record<string, unknown>>;
  eq(props.mode.enum, ["a", "b"], "string enums merged");
  ok(!("enum" in props.n) && String(props.n.description).includes("allowed: 1, 2"), "numeric enum → description");
  eq(props.opt.nullable, true, "null in type array → nullable");
  eq(props.opt.type, "string", "type picked");
  eq(props.list.items, { type: "string" }, "array items defaulted");
  eq(props.free.type, "string", "nested empty object → string (JSON text)");
  eq(out.required, ["mode"], "required filtered to existing props");
});

void run();
