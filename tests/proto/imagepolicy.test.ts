/**
 * model-gating 2.x：剥图返回副本不改原对象；学习触发条件（状态码 + 报文特征）。
 */
import * as vscode from "vscode";
import { countImages, initImagePolicy, isTextOnly, learnedTextOnlyModels, looksLikeImageRejection, markTextOnly, stripImages, strippedNotice, clearLearned } from "../../src/imagePolicy";
import { assistant, cwRequest, image, user } from "./fixtures";
import { eq, ok, run, test } from "./harness";

const stub = vscode as unknown as { __setConfig(k: string, v: unknown): void; __resetConfig(): void; __makeContext(v?: string): unknown };

test("stripImages: 返回副本，原对象不动；纯图消息占位符落进 content；历史里的图也剥", () => {
  const req = cwRequest("", {
    images: [image("png"), image("jpg")],
    history: [user("看图", { images: [image()] }), assistant("好的")],
  });
  const before = JSON.stringify(req);
  const out = stripImages(req);
  eq(JSON.stringify(req), before, "original untouched");
  ok(out !== req && out.conversationState !== req.conversationState, "new objects");
  const cur = out.conversationState.currentMessage!.userInputMessage!;
  ok(!cur.images, "current images removed");
  ok(cur.content!.includes("2 张图片已省略"), "placeholder with count");
  const h0 = out.conversationState.history![0].userInputMessage!;
  ok(!h0.images, "history images removed");
  ok(h0.content!.startsWith("看图") && h0.content!.includes("图片已省略"), "history content + placeholder");
  // 无图的历史项按引用复用
  ok(out.conversationState.history![1] === req.conversationState.history![1], "image-free item reused by reference");
});

test("countImages / strippedNotice: 只对当前消息里的图提示", () => {
  const req = cwRequest("x", { images: [image()], history: [user("h", { images: [image(), image()] })] });
  const c = countImages(req);
  eq(c, { total: 3, inCurrent: 1 }, "count");
  ok(String(strippedNotice("m", c)).includes("1 张图片"), "notice for current");
  eq(strippedNotice("m", { total: 2, inCurrent: 0 }), undefined, "history-only → no notice");
});

test("looksLikeImageRejection: 仅 400/415/422 且报文提到图片/多模态", () => {
  ok(looksLikeImageRejection(400, '{"error":"model does not support image input"}'), "400 + image");
  ok(looksLikeImageRejection(422, "多模态输入不受支持"), "422 + 多模态");
  ok(looksLikeImageRejection(415, "unsupported content type"), "415 + unsupported content type");
  ok(looksLikeImageRejection(400, "content must be a string"), "content must be a string");
  ok(!looksLikeImageRejection(500, "image"), "5xx not learning");
  ok(!looksLikeImageRejection(400, "invalid api key"), "unrelated 400");
  ok(!looksLikeImageRejection(400, "imaging pipeline"), "\\bimages?\\b word boundary: 'imaging' does not match");
});

test("isTextOnly: 配置 ∪ 学习；markTextOnly 落 globalState 并只在首次返回 true", async () => {
  stub.__resetConfig();
  const ctx = stub.__makeContext() as never;
  initImagePolicy(ctx);
  await clearLearned();
  stub.__setConfig("textOnlyModels", ["Configured-Model"]);
  ok(isTextOnly("configured-model"), "configured (case-insensitive)");
  ok(!isTextOnly("glm-5.2"), "unknown not text-only");
  eq(await markTextOnly("GLM-5.2"), true, "first learn → true");
  eq(await markTextOnly("glm-5.2"), false, "second → false");
  ok(isTextOnly("glm-5.2"), "learned");
  eq(learnedTextOnlyModels(), ["glm-5.2"], "learned list");
  // 重新 init 同一个 context → 从 globalState 读回
  initImagePolicy(ctx);
  ok(isTextOnly("glm-5.2"), "persisted in globalState");
  await clearLearned();
  ok(!isTextOnly("glm-5.2"), "cleared");
  stub.__resetConfig();
});

void run();
