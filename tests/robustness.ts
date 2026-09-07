/**
 * robustness：译码层的边界与健壮性（单元级；网络层分片边界见 routing）。
 *  - 超大工具参数（数百 KB）在四个转换器里分片重组不丢字、可解析
 *  - 非法 JSON 增量 / 半截 data: 行 / 注释行 / event: 行 不抛、不影响后续
 *  - $ref 内联四协议共用（parseToolSpec 一处做）；环引用截断；$defs 去掉
 *  - imagePolicy.stripImages 返回副本，不改原对象；占位文案；looksLikeImageRejection 只认 400/415/422
 *  - turnLedger：以 toolResults 判轮次边界（krsServer 调 beginTurn）；30 分钟超时兜底；64 条上限
 *  - eventstream 编解码：帧被切两半可拼回；坏帧头不炸
 *  - 转换器 flush 幂等性：每条流恰好一个 stopReason
 *  - upstream.getJson：竞速超时定时器随结果清掉，不留活定时器（超时路径仍拒绝）
 */
import { AnthropicStreamConverter } from "../src/anthropicStream";
import { OpenaiStreamConverter } from "../src/openaiStream";
import { ResponsesStreamConverter } from "../src/responsesStream";
import { GeminiStreamConverter } from "../src/geminiStream";
import { inlineLocalRefs } from "../src/schemaUtil";
import { parseToolSpec, buildAnthropicRequest } from "../src/translate";
import { buildOpenaiRequest } from "../src/openaiTranslate";
import { buildResponsesRequest } from "../src/responsesTranslate";
import { buildGeminiRequest } from "../src/geminiTranslate";
import { countImages, looksLikeImageRejection, stripImages, strippedNotice } from "../src/imagePolicy";
import { addRequestUsage, beginTurn, resetAll, takeTurnTotals } from "../src/turnLedger";
import { EventStreamDecoder, encodeEvent, encodeException } from "../src/eventstream";
import { getJson } from "../src/upstream";
import { ProviderConfig } from "../src/providers";
import { CwRequest } from "../src/cwTypes";
import { check, eq, feedAll, run, sse, stopReasons, texts, toolUses, cwRequest, toolSpec, startFakeUpstream, sleep } from "./lib/cw";

const anth: ProviderConfig = { id: "pa", name: "a", protocol: "anthropic", anthropicMode: "kiro", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };
const oai: ProviderConfig = { id: "po", name: "o", protocol: "openai", openaiApi: "chat", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };
const rsp: ProviderConfig = { ...oai, id: "pr", openaiApi: "responses" };
const gem: ProviderConfig = { id: "pg", name: "g", protocol: "gemini", baseUrl: "http://127.0.0.1:1", apiKey: "k", enabled: true };

function bigArgs(): { obj: Record<string, unknown>; json: string } {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) {
    lines.push(`line ${i}: ${"x".repeat(60)} 中文测试 "quoted" \\ backslash \t tab`);
  }
  const obj = { path: "src/huge.ts", content: lines.join("\n"), meta: { n: 4000, tags: ["a", "b"] } };
  return { obj, json: JSON.stringify(obj) };
}

function chunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out;
}

run("robustness", async () => {
  // ---------- 1. 超大工具参数 ----------
  {
    const { obj, json } = bigArgs();
    check("big: 夹具 ≥ 300KB", json.length >= 300_000, json.length);
    // Anthropic
    const a = new AnthropicStreamConverter("c", "m");
    const evA = feedAll(a, [
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "fsWrite" } }),
      ...chunks(json, 1024).map((f) => sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: f } })),
      sse({ type: "content_block_stop", index: 0 }),
    ]);
    eq("big-anth: 重组后与原文逐字节相等", toolUses(evA)[0].input === json, true);
    eq("big-anth: 可解析且字段一致", (JSON.parse(toolUses(evA)[0].input) as typeof obj).meta.n, 4000);
    // OpenAI Chat
    const o = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const evO = feedAll(o, [
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "fsWrite", arguments: "" } }] } }] }),
      ...chunks(json, 1024).map((f) => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: f } }] } }] })),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    eq("big-oai: 重组相等", toolUses(evO)[0].input === json, true);
    eq("big-oai: 只发一次", toolUses(evO).length, 1);
    // Responses
    const r = new ResponsesStreamConverter("c", "m");
    const evR = feedAll(r, [
      sse({ type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call_r", name: "fsWrite" } }),
      ...chunks(json, 1024).map((f) => sse({ type: "response.function_call_arguments.delta", item_id: "fc", delta: f })),
      sse({ type: "response.output_item.done", item: { type: "function_call", id: "fc", call_id: "call_r", name: "fsWrite" } }),
      sse({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]);
    eq("big-resp: 重组相等", toolUses(evR)[0].input === json, true);
    eq("big-resp: 只发一次", toolUses(evR).length, 1);
    // Gemini（一次给全，不分片；确认大对象序列化无损）
    const g = new GeminiStreamConverter("c", "m");
    const evG = feedAll(g, [sse({ candidates: [{ content: { parts: [{ functionCall: { id: "fc", name: "fsWrite", args: obj } }] }, finishReason: "STOP" }] })]);
    eq("big-gem: args 对象 → 字符串与原 JSON 相等", toolUses(evG)[0].input === json, true);
    // 两个交错的大调用（OpenAI index 0/1 交错分片）
    const o2 = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const j1 = JSON.stringify({ a: "1".repeat(50_000) });
    const j2 = JSON.stringify({ b: "2".repeat(50_000) });
    const c1 = chunks(j1, 700);
    const c2 = chunks(j2, 700);
    const lines: string[] = [
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "A", function: { name: "one", arguments: "" } }, { index: 1, id: "B", function: { name: "two", arguments: "" } }] } }] }),
    ];
    for (let i = 0; i < Math.max(c1.length, c2.length); i++) {
      const tc: unknown[] = [];
      if (c1[i] !== undefined) {
        tc.push({ index: 0, function: { arguments: c1[i] } });
      }
      if (c2[i] !== undefined) {
        tc.push({ index: 1, function: { arguments: c2[i] } });
      }
      lines.push(sse({ choices: [{ index: 0, delta: { tool_calls: tc } }] }));
    }
    lines.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    const evO2 = feedAll(o2, lines);
    eq("big-oai: 交错两路分片各自重组", toolUses(evO2).map((t) => [t.toolUseId, t.input === j1 || t.input === j2]), [["A", true], ["B", true]]);
    eq("big-oai: 顺序按 index", toolUses(evO2).map((t) => t.name), ["one", "two"]);
  }

  // ---------- 2. 非法 JSON / 杂行 ----------
  {
    const junk = ["data: {not json", "data: ", "data:", ": ping", "event: message", "id: 7", "retry: 1000", "", "   ", "data: [DONE]", "garbage line without prefix", 'data: {"type":"unknown_event_type","x":1}'];
    const a = new AnthropicStreamConverter("c", "m");
    let threw = false;
    try {
      for (const l of junk) {
        a.processLine(l);
      }
    } catch {
      threw = true;
    }
    check("junk-anth: 不抛", !threw);
    const evA = feedAll(a, [sse({ type: "content_block_start", index: 0, content_block: { type: "text" } }), sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "still works" } })]);
    eq("junk-anth: 之后仍正常", texts(evA), "still works");
    eq("junk-anth: 恰好一个 stopReason", stopReasons(evA).length, 1);
    for (const [name, mk] of [
      ["oai", () => new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" })],
      ["resp", () => new ResponsesStreamConverter("c", "m")],
      ["gem", () => new GeminiStreamConverter("c", "m")],
    ] as const) {
      const c = mk();
      let t = false;
      try {
        for (const l of junk) {
          c.processLine(l);
        }
      } catch {
        t = true;
      }
      check(`junk-${name}: 不抛`, !t);
      const ev = c.flush();
      eq(`junk-${name}: 杂行不产生正文`, texts(ev), "");
      eq(`junk-${name}: flush 仍恰好一个 stopReason`, stopReasons(ev).length, 1);
    }
    // 非法 JSON 工具参数：四个转换器都退 {}
    const oa = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const evOa = feedAll(oa, [sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "x", function: { name: "f", arguments: '{"a":' } }] } }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })]);
    eq("badargs-oai: 截断参数 → {}", toolUses(evOa)[0].input, "{}");
    const an = new AnthropicStreamConverter("c", "m");
    const evAn = feedAll(an, [sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "f" } }), sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } }), sse({ type: "content_block_stop", index: 0 })]);
    check("badargs-anth: 截断参数原样透传（Anthropic 侧不校验，交给 Kiro）", toolUses(evAn)[0].input === '{"a":');
    const ge = new GeminiStreamConverter("c", "m");
    const evGe = feedAll(ge, [sse({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: "not-an-object" } }] } }] })]);
    eq("badargs-gem: 非对象 args → {}", toolUses(evGe)[0].input, "{}");
    // 非流式 JSON 里混一段坏文本：不炸、有 stopReason
    const ob = new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" });
    const evOb = feedAll(ob, ["<html>502 Bad Gateway</html>"]);
    eq("junk-oai: HTML 错误页不炸且带 stopReason", stopReasons(evOb), ["END_TURN"]);
  }

  // ---------- 3. $ref 内联四协议共用 ----------
  {
    const schema = {
      type: "object",
      properties: {
        tasks: { type: "array", items: { $ref: "#/$defs/Task" } },
        primary: { $ref: "#/properties/tasks/items", description: "主任务" },
        loop: { $ref: "#/$defs/Node" },
        missing: { $ref: "#/$defs/Nope" },
      },
      required: ["tasks"],
      $defs: {
        Task: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["todo", "done"] } }, required: ["id"] },
        Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" }, v: { type: "number" } } },
      },
    };
    const out = inlineLocalRefs(schema as never) as Record<string, unknown>;
    const props = out.properties as Record<string, Record<string, unknown>>;
    check("ref: $defs 去掉", !("$defs" in out));
    eq("ref: items $ref 内联", ((props.tasks.items as Record<string, unknown>).properties as Record<string, unknown>).id, { type: "string" });
    check("ref: 指向 properties 路径的 $ref 内联且兄弟键 description 保留", (props.primary.properties as Record<string, unknown>).id !== undefined && props.primary.description === "主任务");
    const loop = props.loop as { properties: { next: Record<string, unknown> } };
    check("ref: 环引用截断为任意值（不递归到死）", loop.properties && typeof loop.properties.next === "object" && !("$ref" in loop.properties.next));
    check("ref: 解析不了的引用退成带说明的任意值，不留 $ref", !("$ref" in props.missing) && String(props.missing.description).includes("#/$defs/Nope"));
    check("ref: 无 $ref 的 schema 原对象返回（省拷贝）", inlineLocalRefs(schema.$defs.Task as never) === (schema.$defs.Task as never));
    const onlyDefs = { type: "object", properties: { a: { type: "string" } }, $defs: { X: {} } };
    check("ref: 只有 $defs 无 $ref 也去 $defs", !("$defs" in (inlineLocalRefs(onlyDefs as never) as Record<string, unknown>)));
    check("ref: 原 schema 未被修改", "$defs" in schema && typeof (schema.properties.tasks.items as { $ref: string }).$ref === "string");
    // 四协议共用：parseToolSpec 一处内联，四个 build 出去都没有 $ref/$defs
    const spec = toolSpec("taskTool", schema, "manage tasks");
    const parsed = parseToolSpec(spec as never);
    check("ref: parseToolSpec 已内联", !/"\$(ref|defs|definitions)":/.test(JSON.stringify(parsed.schema)));
    const req = cwRequest({ modelId: "m", tools: [spec] }) as unknown as CwRequest;
    const bodies = {
      anthropic: JSON.stringify(buildAnthropicRequest(req, anth).tools),
      chat: JSON.stringify(buildOpenaiRequest(req, oai).tools),
      responses: JSON.stringify(buildResponsesRequest(req, rsp).tools),
      gemini: JSON.stringify(buildGeminiRequest(req, gem).request.tools),
    };
    for (const [k, v] of Object.entries(bodies)) {
      // 只查键名：解析不了的引用会把路径写进 description 文本，那不是问题
      check(`ref: ${k} 出站工具声明无 $ref / $defs 键`, !/"\$(ref|defs|definitions)":/.test(v));
    }
  }

  // ---------- 4. imagePolicy ----------
  {
    const req = cwRequest({
      modelId: "m",
      content: "look",
      history: [{ userInputMessage: { content: "earlier", modelId: "m", userInputMessageContext: {}, images: [{ format: "png", source: { bytes: "H1" } }] } }],
      images: [{ format: "png", bytes: "C1" }, { format: "jpg", bytes: "C2" }],
    }) as unknown as CwRequest;
    const snapshot = JSON.stringify(req);
    const count = countImages(req);
    eq("img: 计数 total/inCurrent", count, { total: 3, inCurrent: 2 });
    const stripped = stripImages(req);
    eq("img: 原对象未被修改", JSON.stringify(req), snapshot);
    check("img: 返回的是新对象", stripped !== req && stripped.conversationState !== req.conversationState);
    check("img: 副本无 images", countImages(stripped).total === 0 && !stripped.conversationState.currentMessage?.userInputMessage?.images);
    const cur = stripped.conversationState.currentMessage!.userInputMessage!.content!;
    check("img: 当前消息占位文案带张数", cur.startsWith("look") && cur.includes("2 张图片已省略"));
    check("img: 历史消息占位（单张）", stripped.conversationState.history![0].userInputMessage!.content!.includes("[图片已省略"));
    const onlyImg = cwRequest({ modelId: "m", content: "", images: [{ format: "png", bytes: "X" }] }) as unknown as CwRequest;
    check("img: 纯图消息剥后 content 非空（Anthropic 拒收空内容）", !!stripImages(onlyImg).conversationState.currentMessage!.userInputMessage!.content);
    const noImg = cwRequest({ modelId: "m" }) as unknown as CwRequest;
    check("img: 无图消息的 item 原引用复用", stripImages(noImg).conversationState.currentMessage === noImg.conversationState.currentMessage);
    check("img: 提示只在当前消息有图时", strippedNotice("m", { total: 1, inCurrent: 0 }) === undefined && String(strippedNotice("m", { total: 3, inCurrent: 2 })).includes("2 张"));
    check("img: 400 + image 字样 → 判定拒图", looksLikeImageRejection(400, '{"error":"image input not supported"}'));
    check("img: 422 多模态", looksLikeImageRejection(422, "该模型不支持多模态输入"));
    check("img: 500 不判", !looksLikeImageRejection(500, "image"));
    check("img: 400 无关报文不判", !looksLikeImageRejection(400, "invalid api key"));
  }

  // ---------- 5. turnLedger 边界与兜底 ----------
  {
    resetAll();
    beginTurn("c");
    addRequestUsage("c", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
    // 未 beginTurn 的会话也能累加（工具续跑轮不重置）
    addRequestUsage("fresh", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    addRequestUsage("fresh", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    eq("ledger: 未 beginTurn 也累加", takeTurnTotals("fresh").inputTokens, 10);
    eq("ledger: take 后为空", takeTurnTotals("fresh").inputTokens, 0);
    // 超时兜底：30 分钟未动的账本在下一次 beginTurn 的 sweep 里被清
    const realNow = Date.now;
    try {
      let t = 1_000_000_000_000;
      Date.now = () => t;
      resetAll();
      beginTurn("stale");
      addRequestUsage("stale", { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 });
      t += 31 * 60_000;
      beginTurn("other");
      eq("ledger: 30 分钟超时的会话被 sweep", takeTurnTotals("stale").inputTokens, 0);
      // 64 条上限：淘汰最旧
      resetAll();
      for (let i = 0; i < 70; i++) {
        t += 1;
        beginTurn("s" + i);
        addRequestUsage("s" + i, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
      }
      eq("ledger: 超过 64 条时最旧的被淘汰", takeTurnTotals("s0").inputTokens, 0);
      eq("ledger: 最新的仍在", takeTurnTotals("s69").inputTokens, 1);
    } finally {
      Date.now = realNow;
      resetAll();
    }
  }

  // ---------- 6. eventstream 编解码 ----------
  {
    const f1 = encodeEvent("assistantResponseEvent", { content: "你好", modelId: "m" });
    const f2 = encodeEvent("metadataEvent", { stopReason: "END_TURN" });
    const fx = encodeException("InternalServerException", { message: "boom" });
    const all = Buffer.concat([f1, f2, fx]);
    const d = new EventStreamDecoder();
    const got = [...d.feed(all.subarray(0, 7)), ...d.feed(all.subarray(7, f1.length + 3)), ...d.feed(all.subarray(f1.length + 3))];
    eq("es: 帧被切三段仍全部解出", got.map((g) => [g.messageType, g.type]), [["event", "assistantResponseEvent"], ["event", "metadataEvent"], ["exception", "InternalServerException"]]);
    eq("es: payload UTF-8 正确", (got[0].payload as { content: string }).content, "你好");
    const bad = new EventStreamDecoder();
    let threw = false;
    try {
      bad.feed(Buffer.from([0, 0, 0, 5, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    } catch {
      threw = true;
    }
    check("es: 非法帧头不抛", !threw);
    // CRC 与长度字段自洽
    eq("es: totalLength 字段 = 实际长度", f1.readUInt32BE(0), f1.length);
  }

  // ---------- 7. flush 幂等：每条流恰好一个 stopReason，flush 两次不重复发 ----------
  {
    for (const [name, mk] of [
      ["anth", () => new AnthropicStreamConverter("c", "m")],
      ["oai", () => new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" })],
      ["resp", () => new ResponsesStreamConverter("c", "m")],
      ["gem", () => new GeminiStreamConverter("c", "m")],
    ] as const) {
      const c = mk();
      const first = c.flush();
      eq(`flush-${name}: 空流恰好一个 stopReason`, stopReasons(first), ["END_TURN"]);
      check(`flush-${name}: 空流没有 tokenUsage`, !first.some((e) => e.metadataEvent?.tokenUsage));
    }
  }

  // ---------- 8. upstream.getJson：竞速超时定时器不悬空 ----------
  {
    // 只数 ref 住事件循环的 Timeout（getActiveResourcesInfo 不含 unref 的 socket 超时）。
    // 修复前 getJson 成功返回后仍留一个 timeoutMs 的活定时器；修复后 finally 里 clearTimeout。
    const activeTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const fake = await startFakeUpstream(async (req, res) => {
      if (req.url === "/hang") {
        // 不应答：让竞速超时兜底
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    try {
      const before = activeTimeouts();
      const j = (await getJson(`${fake.base}/v1/models`, {}, 60_000)) as { ok: boolean };
      eq("getJson: 正常返回并解析", j.ok, true);
      // 让 finally 与 socket 归还有机会跑完
      await sleep(20);
      const after = activeTimeouts();
      check("getJson: 成功后不留 60s 的活定时器", after <= before, { before, after });
      // 超时路径仍要拒绝（定时器清理不能把超时也清掉）
      let rejected = "";
      try {
        await getJson(`${fake.base}/hang`, {}, 120);
      } catch (e) {
        rejected = (e as Error).message;
      }
      check("getJson: 不应答 → 仍以 timeout 拒绝", /timeout/.test(rejected), rejected);
    } finally {
      await fake.close();
    }
  }
});
