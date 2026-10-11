"use strict";
// 自更新完整性的摘要校验（AC-31）：下载 → 摘要 → 结构 → 安装；不一致一律拒绝安装并删掉已下载文件。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const U = require("./.build/updateChecker.js");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------ 纯函数

test("parseSha256：纯 hex / 大写 / sha256sum 行 / * 标记；长度不对与空串一律拒绝", () => {
  const hex = "a".repeat(64);
  assert.equal(U.parseSha256(`${hex}\n`), hex);
  assert.equal(U.parseSha256(hex.toUpperCase()), hex, "大小写不敏感");
  assert.equal(U.parseSha256(`${hex}  api2kiro-dual-4.13.67.vsix\n`), hex);
  assert.equal(U.parseSha256(`${hex} *api2kiro-dual-4.13.67.vsix`), hex);
  assert.equal(U.parseSha256(`\n\n${hex}  x\n`), hex, "跳过空行");
  assert.equal(U.parseSha256("a".repeat(63)), undefined);
  assert.equal(U.parseSha256("a".repeat(65)), undefined);
  assert.equal(U.parseSha256(""), undefined);
  assert.equal(U.parseSha256("   \n"), undefined);
  assert.equal(U.parseSha256("z".repeat(64)), undefined, "必须是 hex");
  assert.equal(U.parseSha256(`${hex}\n${"b".repeat(64)}\n`), hex, "多行取第一行");
});

test("pickSha256Asset：只认「实际要安装的那份资产名 + .sha256」", () => {
  const assets = [
    { name: "api2kiro-dual-4.13.67-custom.vsix", url: "http://x/a", size: 10 },
    { name: "api2kiro-dual-4.13.67-custom.vsix.sha256", url: "http://x/a.sha256", size: 66 },
    { name: "api2kiro-dual-4.13.67-custom.vsix.sha256.asc", url: "http://x/a.asc", size: 66 },
  ];
  // MEDIUM-4 夹具：资产名与版本推导名不一致，但精确同名摘要存在 ⇒ 必须走「下载并比对摘要」
  assert.equal(U.pickSha256Asset(assets, "api2kiro-dual-4.13.67-custom.vsix").url, "http://x/a.sha256");
  // 只传版本推导名 ⇒ 找不到（实际资产名不同，判定必须按实际名来，不能模糊猜测）
  assert.equal(U.pickSha256Asset(assets, "api2kiro-dual-4.13.67.vsix"), undefined);
  assert.equal(U.pickSha256Asset(assets, "api2kiro-dual-4.13.67.vsix.sha256"), undefined, "不得再叠一层后缀");
  // 名字相近的干扰项（.asc / 同名但后缀不同）不会被误选
  assert.equal(U.pickSha256Asset(assets, "api2kiro-dual-4.13.67-custom.vsix.sha256.asc"), undefined);
  assert.equal(U.pickSha256Asset([], "api2kiro-dual-4.13.67.vsix"), undefined);
  assert.equal(U.pickSha256Asset(undefined, "api2kiro-dual-4.13.67.vsix"), undefined);
  assert.equal(U.pickSha256Asset(assets, ""), undefined);
});

test("resolveInstallAnyway：只有「仍要安装」为 true（关闭 / Esc / 取消一律 false）", () => {
  assert.equal(U.resolveInstallAnyway(U.INSTALL_ANYWAY_LABEL), true);
  assert.equal(U.resolveInstallAnyway(U.CANCEL_LABEL), false);
  assert.equal(U.resolveInstallAnyway(undefined), false);
  assert.equal(U.resolveInstallAnyway(""), false);
  assert.equal(U.CANCEL_LABEL, "取消");
  assert.equal(U.INSTALL_ANYWAY_LABEL, "仍要安装");
});

test("sha256File / verifyVsixDigest：一致通过、不一致抛中文错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-sha-"));
  const file = path.join(dir, "x.vsix");
  fs.writeFileSync(file, "hello world");
  const want = sha(Buffer.from("hello world"));
  assert.equal(await U.sha256File(file), want);
  await U.verifyVsixDigest(file, want);
  await U.verifyVsixDigest(file, want.toUpperCase());
  await assert.rejects(() => U.verifyVsixDigest(file, "b".repeat(64)), /摘要不匹配/);
});

// ------------------------------------------------------------------ 集成（127.0.0.1 上的假 GitHub）

/**
 * 造一个最小可安装的 vsix：一个 deflate 条目 `extension/package.json`，
 * 带完整的本地头 + 中央目录 + EOCD（`verifyVsix` 走中央目录找条目）。
 */
function makeVsix(version) {
  const manifest = Buffer.from(JSON.stringify({ name: U.EXTENSION_NAME, version }), "utf8");
  const deflated = zlib.deflateRawSync(manifest);
  const name = Buffer.from("extension/package.json", "utf8");
  const crc = crc32(manifest);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(manifest.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(manifest.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // 本地头偏移
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + deflated.length, 16);
  return Buffer.concat([local, deflated, central, eocd]);
}

/** 最小 CRC32（zip 条目头里用，readZipEntry 不校验，写对便于其它工具读）。 */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/**
 * 起一个只服务本测试的假 GitHub：`/releases/latest` + 资产下载。
 * `files` = { 路径: Buffer }，`release` 由用例给出。
 * 返回对象上的 `onRequest(url)` 可挂一个观察回调（用例用它制造「下载中途取消」的时机）。
 */
async function startFakeGitHub(files, release) {
  const g = { hits: [], onRequest: undefined, base: "", close: async () => {} };
  const server = http.createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    g.hits.push(url);
    if (g.onRequest) {
      g.onRequest(url);
    }
    if (url === "/releases/latest") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(release));
      return;
    }
    const body = files[url];
    if (!body) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  g.base = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => server.close(r));
  return g;
}

function makeContext(version = "4.13.60") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2k-upd-"));
  return {
    ctx: {
      extension: { packageJSON: { version } },
      globalStorageUri: { fsPath: path.join(dir, "storage") },
      globalState: { get: () => undefined, update: async () => undefined },
    },
    dir,
  };
}

/** 从 withProgress 回调里记录下来的安装调用。 */
const installCalls = () => (globalThis.__a2kCommands || []).filter((a) => a[0] === "workbench.extensions.installExtension");

async function withFakeGitHub(files, release, fn) {
  const g = await startFakeGitHub(files, release);
  globalThis.__a2kCommands = [];
  globalThis.__a2kUiCalls = [];
  try {
    return await fn(g);
  } finally {
    await g.close();
  }
}

/** 组装一份「同 Release 带摘要」的资产清单与文件表。 */
function releaseWithSha(version, vsix, shaText, extra = {}) {
  const name = `${U.EXTENSION_NAME}-${version}.vsix`;
  const files = { [`/${name}`]: vsix, [`/${name}.sha256`]: Buffer.from(shaText, "utf8"), ...extra.files };
  const release = {
    tag_name: `v${version}`,
    html_url: "https://github.com/example/releases/tag/v" + version,
    name: `v${version}`,
    assets: [
      { name, browser_download_url: `/${name}`, size: vsix.length },
      { name: `${name}.sha256`, browser_download_url: `/${name}.sha256`, size: Buffer.byteLength(shaText) },
      ...(extra.assets || []),
    ],
  };
  return { files, release, name };
}

test.beforeEach(() => U._resetUpdateStateForTest());

async function run(version, vsix, shaText, opts = {}) {
  const { files, release, name } = releaseWithSha(version, vsix, shaText, opts.extra);
  return withFakeGitHub(files, release, async (g) => {
    // 资产 URL 换成假服务的真实地址（browser_download_url 是相对路径，这里补齐主机）
    for (const a of release.assets) a.browser_download_url = `${g.base}/${a.name}`;
    const { ctx, dir } = makeContext(opts.current || "4.13.60");
    const res = await U.installLatestFromGitHub(ctx, {
      apiUrl: `${g.base}/releases/latest`,
      fetchTimeoutMs: 3000,
      download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
      confirm: opts.confirm,
    });
    return { res, dir, name, hits: g.hits, vsixPath: path.join(ctx.globalStorageUri.fsPath, "updates", name) };
  });
}

test("AC-31 一致：摘要匹配 ⇒ 走结构校验并安装", async () => {
  const vsix = makeVsix("4.13.67");
  const { res, vsixPath } = await run("4.13.67", vsix, sha(vsix));
  assert.equal(res.status, "installed", JSON.stringify(res));
  assert.equal(installCalls().length, 1, "应调用安装命令");
  assert.ok(fs.existsSync(vsixPath), "已安装时应留下安装包（清理目录时保留刚装的那份）");
  assert.ok(!fs.existsSync(`${vsixPath}.sha256`), "临时摘要文件读完即删");
});

test("AC-31 不一致：摘要不匹配 ⇒ 拒绝安装 + 删掉已下载文件 + 文案不含「可手动安装」", async () => {
  const vsix = makeVsix("4.13.67");
  const { res, vsixPath } = await run("4.13.67", vsix, "b".repeat(64));
  assert.equal(res.status, "failed", JSON.stringify(res));
  assert.equal(installCalls().length, 0, "不得调用安装命令");
  assert.ok(!fs.existsSync(vsixPath), "已下载的文件必须被删掉");
  assert.ok(!fs.existsSync(`${vsixPath}.sha256`), "临时摘要文件也必须删掉");
  assert.equal(res.vsixPath, undefined, "拒绝后不得给出「手动安装」路径");
  assert.ok(!String(res.error || "").includes("可手动安装"), String(res.error));
  assert.ok(/摘要校验不通过/.test(res.error || ""), String(res.error));
});

test("AC-31 边界：摘要文件下载失败 / 畸形 / 长度不对 ⇒ 一律拒绝安装", async () => {
  const vsix = makeVsix("4.13.67");
  // ① 畸形（不是 hex）
  let r = await run("4.13.67", vsix, "not-a-hex-digest\n");
  assert.equal(r.res.status, "failed", JSON.stringify(r.res));
  assert.equal(installCalls().length, 0);
  assert.ok(!fs.existsSync(r.vsixPath));

  // ② 长度不对（63 位）
  r = await run("4.13.67", vsix, "a".repeat(63));
  assert.equal(r.res.status, "failed");
  assert.equal(installCalls().length, 0);

  // ③ 摘要资产存在但下载 404
  const { files, release, name } = releaseWithSha("4.13.67", vsix, sha(vsix));
  delete files[`/${name}.sha256`];
  await withFakeGitHub(files, release, async (g) => {
    U._resetUpdateStateForTest();
    for (const a of release.assets) if (a.name.endsWith(".sha256")) a.browser_download_url = `${g.base}/missing.sha256`;
    for (const a of release.assets) if (!a.name.endsWith(".sha256")) a.browser_download_url = `${g.base}/${name}`;
    const { ctx } = makeContext();
    const res = await U.installLatestFromGitHub(ctx, {
      apiUrl: `${g.base}/releases/latest`,
      fetchTimeoutMs: 3000,
      download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
    });
    assert.equal(res.status, "failed", JSON.stringify(res));
    assert.equal(installCalls().length, 0, "摘要下不下来就不能安装");
    assert.ok(!fs.existsSync(path.join(ctx.globalStorageUri.fsPath, "updates", name)));
  });
});

test("LOW-4：在 `.sha256` 下载期间点「取消」⇒ 报「已取消更新」，不得报成摘要校验失败（安全告警 + Release 页）", async () => {
  const vsix = makeVsix("4.13.67");
  const { files, release, name } = releaseWithSha("4.13.67", vsix, sha(vsix));
  await withFakeGitHub(files, release, async (g) => {
    U._resetUpdateStateForTest();
    for (const a of release.assets) a.browser_download_url = `${g.base}/${a.name}`;
    const { ctx } = makeContext();
    // 可取消的 token：假 GitHub 一收到 `.sha256` 请求就取消（正好落在那个下载的 I/O 窗口里）
    const listeners = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(cb) {
        listeners.push(cb);
        return { dispose() {} };
      },
    };
    const cancel = () => {
      token.isCancellationRequested = true;
      for (const cb of listeners) cb();
    };
    g.onRequest = (url) => {
      if (url === `/${name}.sha256`) cancel();
    };
    globalThis.__a2kProgressToken = token;
    try {
      const res = await U.installLatestFromGitHub(ctx, {
        apiUrl: `${g.base}/releases/latest`,
        fetchTimeoutMs: 3000,
        download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
      });
      assert.equal(res.status, "cancelled", JSON.stringify(res));
      assert.equal(installCalls().length, 0, "取消不得安装");
      const ui = globalThis.__a2kUiCalls || [];
      assert.ok(
        ui.some((c) => c.kind === "info" && String(c.args[0]).includes("已取消更新")),
        `应提示「已取消更新」：${JSON.stringify(ui)}`
      );
      assert.ok(
        !ui.some((c) => /摘要校验/.test(String(c.args[0] || ""))),
        `取消不得被报成摘要校验失败：${JSON.stringify(ui)}`
      );
      assert.ok(!String(res.error || "").includes("摘要"), String(res.error));
      // 下载目录里的半成品被清掉（与其它取消路径一致）
      assert.ok(!fs.existsSync(path.join(ctx.globalStorageUri.fsPath, "updates", name)), "取消后删掉已下载的文件");
    } finally {
      globalThis.__a2kProgressToken = undefined;
    }
  });
});

test("AC-31 旧 Release（无 .sha256）：模态二次确认，默认取消", async () => {
  const vsix = makeVsix("4.13.67");
  const name = `${U.EXTENSION_NAME}-4.13.67.vsix`;
  const files = { [`/${name}`]: vsix };
  const release = {
    tag_name: "v4.13.67",
    html_url: "https://github.com/example/releases/tag/v4.13.67",
    assets: [{ name, browser_download_url: `/${name}`, size: vsix.length }],
  };
  // ① 用户取消（confirm 返回 false）⇒ 删掉已下载文件、返回 cancelled、不安装
  await withFakeGitHub(files, release, async (g) => {
    U._resetUpdateStateForTest();
    release.assets[0].browser_download_url = `${g.base}/${name}`;
    const { ctx } = makeContext();
    let asked = "";
    const res = await U.installLatestFromGitHub(ctx, {
      apiUrl: `${g.base}/releases/latest`,
      fetchTimeoutMs: 3000,
      download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
      confirm: async (msg) => {
        asked = msg;
        return false;
      },
    });
    assert.equal(res.status, "cancelled", JSON.stringify(res));
    assert.equal(installCalls().length, 0, "取消时不得安装");
    assert.ok(asked.includes("sha256"), `确认文案应说明缺了什么：${asked}`);
    assert.ok(asked.includes("只防传输损坏"), "文案要写清摘要的能力边界");
    const dir = path.join(ctx.globalStorageUri.fsPath, "updates");
    assert.ok(!fs.existsSync(path.join(dir, name)), "取消后删掉已下载的文件");

    // ② 用户选择「仍要安装」⇒ 正常安装
    globalThis.__a2kCommands = [];
    const res2 = await U.installLatestFromGitHub(ctx, {
      apiUrl: `${g.base}/releases/latest`,
      fetchTimeoutMs: 3000,
      download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
      confirm: async () => true,
    });
    assert.equal(res2.status, "installed", JSON.stringify(res2));
    assert.equal(installCalls().length, 1);
  });
});

test("MEDIUM-4 端到端：资产名与版本推导名不一致 + 同名 .sha256 ⇒ 走摘要校验（不是旧 Release 确认框）", async () => {
  const vsix = makeVsix("4.13.67");
  const custom = `${U.EXTENSION_NAME}-4.13.67-custom.vsix`;
  const files = { [`/${custom}`]: vsix, [`/${custom}.sha256`]: Buffer.from(sha(vsix), "utf8") };
  const release = {
    tag_name: "v4.13.67",
    html_url: "https://github.com/example/releases/tag/v4.13.67",
    assets: [
      { name: custom, browser_download_url: `/${custom}`, size: vsix.length },
      { name: `${custom}.sha256`, browser_download_url: `/${custom}.sha256`, size: Buffer.byteLength(sha(vsix)) },
    ],
  };
  await withFakeGitHub(files, release, async (g) => {
    U._resetUpdateStateForTest();
    for (const a of release.assets) a.browser_download_url = `${g.base}/${a.name}`;
    const { ctx } = makeContext();
    let confirmAsked = false;
    const res = await U.installLatestFromGitHub(ctx, {
      apiUrl: `${g.base}/releases/latest`,
      fetchTimeoutMs: 3000,
      download: { idleTimeoutMs: 3000, totalTimeoutMs: 3000 },
      confirm: async () => {
        confirmAsked = true;
        return false;
      },
    });
    assert.equal(res.status, "installed", JSON.stringify(res));
    assert.equal(confirmAsked, false, "有同名摘要就必须走校验，不能降级成「没有 .sha256」的确认框");
    assert.equal(installCalls().length, 1);
    // 本地落盘名仍是版本推导名（既有行为不动）
    assert.ok(fs.existsSync(path.join(ctx.globalStorageUri.fsPath, "updates", `${U.EXTENSION_NAME}-4.13.67.vsix`)));
  });
});
