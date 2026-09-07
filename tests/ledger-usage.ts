/**
 * ledger-usage：用量账本口径（StreamConverter.ledgerUsage）与页脚计费口径（meteringUsage）并存且自洽。
 *  - 单元：四个转换器喂带缓存命中的 usage，ledgerUsage 的 inputTokens 只算未命中、cacheRead / cacheWrite 单列，
 *    四项之和 === meteringUsage 的总量（inputTokens + outputTokens + cacheRead + cacheCreation）；
 *    meteringUsage 语义不变（OpenAI / Responses / Gemini 仍清零缓存，Anthropic 原样）。
 *  - 端到端：真实 KrsProxyServer + 假上游，四协议各打一次，usageStore 落账的 cacheReadTokens 不再恒 0，
 *    且 inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 回给 Kiro 的 meteringEvent.usage。
 * 全程只打 127.0.0.1，不碰任何真实 Key。
 */
import * as vscode from "vscode";
import { AnthropicStreamConverter } from "../src/anthropicStream";
import { OpenaiStreamConverter } from "../src/openaiStream";
import { ResponsesStreamConverter } from "../src/responsesStream";
import { GeminiStreamConverter } from "../src/geminiStream";
import { CapturedUsage, StreamConverter, splitCachedInput } from "../src/streamShared";
import { KrsProxyServer } from "../src/krsServer";
import { initConfig } from "../src/config";
import { _resetPoolForTest } from "../src/credentialPool";
import { ProviderConfig } from "../src/providers";
import { _resetForTest as resetUsage, initUsageStore, recentRecords, UsageRecord } from "../src/usageStore";
import { check, eq, run, feedAll, sse, startFakeUpstream, writeSse, postRaw, pickPort, decodeEventStream, framesToCwEvents, meterings, texts, cwRequest, FakeUpstream } from "./lib/cw";

const stub = vscode as unknown as {
  __setConfig(k: string, v: unknown): void;
  __resetConfig(): void;
  __makeContext(o?: { version?: string }): unknown;
};

function total(u: CapturedUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

function recordTotal(r: UsageRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

/** 四协议共用的账本 / 页脚不变量。 */
function assertLedger(name: string, c: StreamConverter, expectLedger: CapturedUsage, expectMetering: CapturedUsage): void {
  const ledger = c.ledgerUsage();
  const metering = c.meteringUsage();
  eq(`${name}: ledgerUsage 未命中 + 缓存单列`, ledger, expectLedger);
  eq(`${name}: meteringUsage 页脚语义不变`, metering, expectMetering);
  eq(`${name}: ledger 四项之和 = metering 总量`, total(ledger), total(metering));
  check(`${name}: ledger cacheRead 不为 0`, ledger.cacheReadTokens > 0, ledger);
  check(`${name}: ledger 各项非负`, Object.values(ledger).every((v) => v >= 0), ledger);
}

run("ledger-usage", async () => {
  // ---------- 1. 单元：四个转换器 ----------
  {
    // Anthropic：input_tokens 本就是未命中，cache_read / cache_creation 并列 → ledger === metering
    const a = new AnthropicStreamConverter("c", "claude-x");
    feedAll(a, [
      sse({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }),
      sse({ type: "message_stop" }),
    ]);
    assertLedger("anth", a, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 5 }, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 5 });

    // OpenAI Chat：prompt_tokens 含 cached_tokens → ledger 扣出来；metering 仍清零缓存
    const o = new OpenaiStreamConverter("c", "gpt-x", { thoughtDedupe: "off" });
    feedAll(o, [
      sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } } }),
    ]);
    assertLedger("oai", o, { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 0 }, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });

    // OpenAI Chat 经中转透出 Anthropic 口径的 cache_* 字段（New API 把 prompt_tokens 记为 input + read + creation）
    const o2 = new OpenaiStreamConverter("c", "claude-via-oai", { thoughtDedupe: "off" });
    feedAll(o2, [
      sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }),
      sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } }),
    ]);
    assertLedger("oai-relay", o2, { inputTokens: 60, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 10 }, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });

    // Responses：input_tokens 含 input_tokens_details.cached_tokens
    const r = new ResponsesStreamConverter("c", "gpt-5-x");
    feedAll(r, [
      sse({ type: "response.output_text.delta", delta: "hi" }),
      sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } } } }),
    ]);
    assertLedger("resp", r, { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 0 }, { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 });

    // Gemini：promptTokenCount 含 cachedContentTokenCount；输出 = candidates + thoughts
    const g = new GeminiStreamConverter("c", "gemini-x");
    feedAll(g, [
      sse({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 200, candidatesTokenCount: 80, thoughtsTokenCount: 20 } }),
    ]);
    assertLedger("gem", g, { inputTokens: 300, outputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 0 }, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });

    // 无缓存字段：ledger === metering（不引入负数，不凭空造缓存）
    const o3 = new OpenaiStreamConverter("c", "gpt-x", { thoughtDedupe: "off" });
    feedAll(o3, [sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }), sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } })]);
    eq("oai-nocache: ledger === metering", o3.ledgerUsage(), o3.meteringUsage());
    eq("oai-nocache: cacheRead 为 0", o3.ledgerUsage().cacheReadTokens, 0);

    // 空流：全零，不抛
    for (const [name, c] of [
      ["anth", new AnthropicStreamConverter("c", "m")],
      ["oai", new OpenaiStreamConverter("c", "m", { thoughtDedupe: "off" })],
      ["resp", new ResponsesStreamConverter("c", "m")],
      ["gem", new GeminiStreamConverter("c", "m")],
    ] as const) {
      c.flush();
      eq(`empty-${name}: ledgerUsage 全零`, c.ledgerUsage(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    }

    // splitCachedInput 边界：缓存字段大于输入总量（异常中转）→ 夹到总量以内，四项之和仍 = 总量
    const weird = splitCachedInput({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 50, cacheCreationTokens: 7 });
    eq("split: 缓存超过总量时夹紧", weird, { inputTokens: 0, outputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 0 });
    eq("split: 夹紧后四项之和 = 原 input + output", total(weird), 13);
    const partial = splitCachedInput({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 90, cacheCreationTokens: 30 });
    eq("split: read 占满后 write 只拿剩余", partial, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 90, cacheCreationTokens: 10 });
  }

  // ---------- 2. 端到端：真实 KRS → 假上游 → usageStore ----------
  {
    const fake: FakeUpstream = await startFakeUpstream(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"data":[],"models":[]}');
        return;
      }
      if (req.url === "/v1/messages") {
        writeSse(res, [
          { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
          { type: "message_stop" },
        ]);
        return;
      }
      if (req.url === "/v1/chat/completions") {
        writeSse(res, [
          { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "O" }, finish_reason: null }] },
          { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } } },
        ]);
        return;
      }
      if (req.url === "/v1/responses") {
        writeSse(res, [
          { type: "response.output_text.delta", delta: "R" },
          { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } } } },
        ]);
        return;
      }
      if (req.url.startsWith("/v1beta/models/") && req.url.includes(":streamGenerateContent")) {
        writeSse(res, [{ candidates: [{ content: { parts: [{ text: "G" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 200, candidatesTokenCount: 80, thoughtsTokenCount: 20 } }]);
        return;
      }
      res.writeHead(404);
      res.end("no route " + req.url);
    });

    const providers: Record<string, ProviderConfig> = {
      anth: { id: "pa", name: "Anth", protocol: "anthropic", anthropicMode: "kiro", baseUrl: fake.base + "/v1", apiKey: "sk-fake", enabled: true, enabledModels: ["claude-test"] },
      oai: { id: "po", name: "Oai", protocol: "openai", openaiApi: "chat", baseUrl: fake.base + "/v1", apiKey: "sk-fake", enabled: true, enabledModels: ["gpt-test"] },
      resp: { id: "pr", name: "Resp", protocol: "openai", openaiApi: "responses", baseUrl: fake.base + "/v1", apiKey: "sk-fake", enabled: true, enabledModels: ["gpt-5-test"] },
      gem: { id: "pg", name: "Gem", protocol: "gemini", baseUrl: fake.base + "/v1beta", apiKey: "AIza-fake", enabled: true, enabledModels: ["gemini-test"] },
    };
    const expected: Record<string, { model: string; ledger: [number, number, number, number]; path: string }> = {
      anth: { model: "claude-test", ledger: [100, 20, 10, 5], path: "/v1/messages" },
      oai: { model: "gpt-test", ledger: [70, 20, 30, 0], path: "/v1/chat/completions" },
      resp: { model: "gpt-5-test", ledger: [60, 30, 40, 0], path: "/v1/responses" },
      gem: { model: "gemini-test", ledger: [300, 100, 200, 0], path: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse" },
    };

    stub.__resetConfig();
    stub.__setConfig("enabled", true);
    stub.__setConfig("autoRetry", false);
    const port = await pickPort();
    const ctx = stub.__makeContext({ version: "4.13.30" }) as never;
    initConfig(ctx);
    initUsageStore(ctx);
    resetUsage();
    const krs = new KrsProxyServer(ctx, port);
    await krs.start();
    check(`krs: 在 ${port} 成为 OWNER`, krs.isOwner());
    const krsBase = `http://127.0.0.1:${port}`;

    try {
      for (const key of ["anth", "oai", "resp", "gem"] as const) {
        stub.__setConfig("providers", [providers[key]]);
        _resetPoolForTest();
        fake.requests.length = 0;
        const before = recentRecords(1)[0]?.ts || 0;
        const r = await postRaw(krsBase + "/generateAssistantResponse", JSON.stringify(cwRequest({ convId: "lg-" + key, modelId: expected[key].model, content: "hi" })));
        const events = framesToCwEvents(decodeEventStream(r.buf));
        const post = fake.requests.find((q) => q.method === "POST");
        eq(`e2e-${key}: 打到 ${expected[key].path}`, post?.url, expected[key].path);
        check(`e2e-${key}: 正文回流`, texts(events).length > 0, texts(events));
        const m = meterings(events);
        eq(`e2e-${key}: 恰好一条 metering`, m.length, 1);
        const rec = recentRecords(1)[0];
        check(`e2e-${key}: 落了一笔新账`, !!rec && rec.ts >= before && rec.providerId === providers[key].id, rec);
        const [inp, out, cr, cw] = expected[key].ledger;
        eq(`e2e-${key}: 账本 inputTokens 为未命中`, rec?.inputTokens, inp);
        eq(`e2e-${key}: 账本 outputTokens`, rec?.outputTokens, out);
        eq(`e2e-${key}: 账本 cacheReadTokens 不为 0`, rec?.cacheReadTokens, cr);
        eq(`e2e-${key}: 账本 cacheWriteTokens`, rec?.cacheWriteTokens, cw);
        eq(`e2e-${key}: 账本四项之和 = 页脚 metering.usage`, rec ? recordTotal(rec) : -1, m[0]?.usage);
        eq(`e2e-${key}: 账本 protocol`, rec?.protocol, key === "anth" ? "anthropic" : key === "gem" ? "gemini" : "openai");
        eq(`e2e-${key}: ok`, rec?.ok, true);
      }
    } finally {
      await krs.stop();
      await fake.close();
    }
  }
});
