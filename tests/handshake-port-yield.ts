/**
 * 端口让位握手（src/portBinder.ts + src/proxyIdentity.ts）：真实 TCP，端口 19890–19898。
 *  - 旧版本让位：假「旧实例」服务器持有端口，新版本 PortHolder 请求让位后接管；
 *  - 同版本共享：后到者待机，前者退出后 ≤RETRY_MS 内接管；
 *  - 外部进程只标记冲突，不打扰对方；
 *  - 让位后等待再抢：被更新版本顶掉后释放端口，对方不占则自己再抢回。
 */
import * as http from "http";
import * as vscode from "vscode";
import { initConfig } from "../src/config";
import { PortHolder } from "../src/portBinder";
import { PROXY_ID_PATH, PROXY_ID_TOKEN, compareVersions, probeIdentity, serveIdentity } from "../src/proxyIdentity";
import { check, eq, finish, portFree, sleep, test } from "./lib/harness";

const stub = vscode as unknown as { __makeContext(o?: { version?: string }): vscode.ExtensionContext; __outputLines(): string[]; __clearOutput(): void };
const MY_VERSION = "4.13.30";
initConfig(stub.__makeContext({ version: MY_VERSION }));

const PORT_A = 19890;
const PORT_B = 19891;
const PORT_C = 19892;
const PORT_D = 19893;
const PORT_E = 19894;
const PORT_F = 19895;
const PORT_G = 19896;

function krsLikeServer(): http.Server {
  return http.createServer((req, res) => {
    if (serveIdentity(req.url || "/", res, "krs")) {
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
}

interface FakeInstance {
  probes: string[];
  close(): Promise<void>;
  alive(): boolean;
}

/** 模拟另一个进程里的实例：按给定版本应答身份探测；supportsYield 时对更新的 yieldTo 让位（50ms 后关服）。 */
function fakeInstance(port: number, version: string, opts: { supportsYield?: boolean; body?: string } = {}): Promise<FakeInstance> {
  return new Promise((resolve) => {
    const probes: string[] = [];
    let open = true;
    const server = http.createServer((req, res) => {
      probes.push(req.url || "/");
      if (opts.body !== undefined) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(opts.body);
        return;
      }
      const [path, query] = (req.url || "/").split("?");
      if (path !== PROXY_ID_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }
      const yieldTo = new URLSearchParams(query || "").get("yieldTo");
      const yielding = !!opts.supportsYield && !!yieldTo && compareVersions(yieldTo, version) > 0;
      const body: Record<string, unknown> = { proxy: PROXY_ID_TOKEN, role: "krs", version, pid: 424242 };
      if (opts.supportsYield) {
        body.yielding = yielding;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      if (yielding) {
        setTimeout(() => {
          open = false;
          (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close();
        }, 50);
      }
    });
    server.listen(port, "127.0.0.1", () =>
      resolve({
        probes,
        alive: () => open,
        close: () =>
          new Promise<void>((r) => {
            open = false;
            (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
          }),
      })
    );
  });
}

(async () => {
  await test("compareVersions：数字段比较、忽略预发布后缀、长短不齐", () => {
    eq("4.13.30 > 4.13.29", compareVersions("4.13.30", "4.13.29"), 1);
    eq("4.13.30 < 4.14.0", compareVersions("4.13.30", "4.14.0"), -1);
    eq("相等", compareVersions("4.13.30", "4.13.30"), 0);
    eq("4.13 == 4.13.0", compareVersions("4.13", "4.13.0"), 0);
    eq("5 > 4.99.99", compareVersions("5", "4.99.99"), 1);
    eq("预发布后缀忽略：4.13.30-beta == 4.13.30", compareVersions("4.13.30-beta", "4.13.30"), 0);
    eq("空串当 0.0.0", compareVersions("", "0.0.1"), -1);
    eq("非数字段当 0", compareVersions("x.y", "0.0"), 0);
  });

  await test("持有者应答身份；不让位给更旧的请求者", async () => {
    const holder = new PortHolder(PORT_A, "KRS", krsLikeServer);
    await holder.start();
    eq("首个绑定者成为 OWNER", holder.isOwner(), true);
    eq("非外部冲突", holder.hadForeignConflict(), false);
    const id = await probeIdentity(PORT_A);
    eq("身份 proxy 标记", id?.proxy, PROXY_ID_TOKEN);
    eq("身份 role", id?.role, "krs");
    eq("身份 version 来自扩展 packageJSON", id?.version, MY_VERSION);
    eq("身份 pid 是本进程", id?.pid, process.pid);
    eq("无 yieldTo → yielding=false", id?.yielding, false);
    const older = await probeIdentity(PORT_A, "4.0.0");
    eq("更旧的请求者 → 不让位", older?.yielding, false);
    const same = await probeIdentity(PORT_A, MY_VERSION);
    eq("同版本请求者 → 不让位", same?.yielding, false);
    await sleep(120);
    eq("仍是 OWNER", holder.isOwner(), true);
    await holder.stop();
    eq("stop 后端口释放", await portFree(PORT_A), true);
  });

  await test("让位后等待再抢：被更新版本要求让位 → 释放端口 → 对方没占 → RETRY_MS 内抢回", async () => {
    const changes: boolean[] = [];
    const holder = new PortHolder(PORT_B, "KRS", krsLikeServer, (o) => changes.push(o));
    await holder.start();
    eq("先成为 OWNER", holder.isOwner(), true);
    const ans = await probeIdentity(PORT_B, "99.0.0");
    eq("更新版本请求让位 → yielding=true", ans?.yielding, true);
    eq("让位应答里仍带本实例版本", ans?.version, MY_VERSION);
    await sleep(250);
    eq("让位后不再是 OWNER", holder.isOwner(), false);
    eq("让位后端口已释放", await portFree(PORT_B), true);
    check("onChange(false) 已回调", changes.length === 1 && changes[0] === false, changes);
    // 对方没来占：RETRY_MS(2500ms) 后自己抢回
    await sleep(3200);
    eq("对方未占用 → 重新成为 OWNER", holder.isOwner(), true);
    check("onChange(true) 已回调", changes.length === 2 && changes[1] === true, changes);
    const again = await probeIdentity(PORT_B);
    eq("抢回后身份可探", again?.proxy, PROXY_ID_TOKEN);
    await holder.stop();
  });

  await test("同版本共享：后到者待机、不视为冲突；前者退出后 ≤RETRY_MS 接管", async () => {
    const first = new PortHolder(PORT_C, "KRS", krsLikeServer);
    await first.start();
    const changes: boolean[] = [];
    const second = new PortHolder(PORT_C, "KRS", krsLikeServer, (o) => changes.push(o));
    await second.start();
    eq("后到者不是 OWNER", second.isOwner(), false);
    eq("同版本不算外部冲突", second.hadForeignConflict(), false);
    eq("前者仍是 OWNER", first.isOwner(), true);
    await first.stop();
    await sleep(3200);
    eq("前者退出后后到者接管", second.isOwner(), true);
    check("接管触发 onChange(true)", changes.length === 1 && changes[0] === true, changes);
    await second.stop();
    eq("双双 stop 后端口空闲", await portFree(PORT_C), true);
  });

  await test("旧版本让位：假旧实例 v4.0.0 支持让位 → 新版本发 yieldTo 并接管", async () => {
    stub.__clearOutput();
    const old = await fakeInstance(PORT_D, "4.0.0", { supportsYield: true });
    const holder = new PortHolder(PORT_D, "KRS", krsLikeServer);
    await holder.start();
    eq("接管成功成为 OWNER", holder.isOwner(), true);
    eq("非外部冲突", holder.hadForeignConflict(), false);
    eq("旧实例已被让位关闭", old.alive(), false);
    eq("向旧实例发了 2 次探测（先问身份，再请求让位）", old.probes.length, 2);
    eq("第一次是纯身份探测", old.probes[0], PROXY_ID_PATH);
    eq("第二次带 yieldTo=本版本", old.probes[1], `${PROXY_ID_PATH}?yieldTo=${encodeURIComponent(MY_VERSION)}`);
    const log = stub.__outputLines().join("\n");
    check("日志记录接管", /已从 v4\.0\.0 接管/.test(log), log.split("\n").slice(-4));
    const id = await probeIdentity(PORT_D);
    eq("接管后端口上是新版本", id?.version, MY_VERSION);
    await holder.stop();
  });

  await test("旧版本不支持让位：标记待机，不冲突，不打扰对方", async () => {
    stub.__clearOutput();
    const old = await fakeInstance(PORT_E, "4.0.0", { supportsYield: false });
    const holder = new PortHolder(PORT_E, "KRS", krsLikeServer);
    await holder.start();
    eq("不能接管 → 不是 OWNER", holder.isOwner(), false);
    eq("不算外部冲突", holder.hadForeignConflict(), false);
    eq("旧实例仍在", old.alive(), true);
    eq("发了身份探测 + 让位请求各一次", old.probes.length, 2);
    const log = stub.__outputLines().join("\n");
    check("日志提示需完全退出所有 Kiro 窗口", /不支持让位/.test(log) && /完全退出所有 Kiro 窗口/.test(log), log.split("\n").slice(-3));
    await holder.stop();
    await old.close();
  });

  await test("更新版本持有端口：本实例待机，不发让位请求", async () => {
    const newer = await fakeInstance(PORT_F, "99.0.0", { supportsYield: true });
    const holder = new PortHolder(PORT_F, "KRS", krsLikeServer);
    await holder.start();
    eq("待机", holder.isOwner(), false);
    eq("不冲突", holder.hadForeignConflict(), false);
    eq("只探了一次身份，没有 yieldTo", newer.probes.length, 1);
    eq("探测路径不带 query", newer.probes[0], PROXY_ID_PATH);
    eq("对方仍在", newer.alive(), true);
    await holder.stop();
    await newer.close();
  });

  await test("外部进程占用：只标记冲突，不试图让位，不再重试打扰", async () => {
    const foreign = await fakeInstance(PORT_G, "0", { body: "<html>not ours</html>" });
    const holder = new PortHolder(PORT_G, "KRS", krsLikeServer);
    await holder.start();
    eq("不是 OWNER", holder.isOwner(), false);
    eq("标记为外部冲突", holder.hadForeignConflict(), true);
    eq("只发了一次探测", foreign.probes.length, 1);
    eq("外部服务仍在", foreign.alive(), true);
    // 外部占用会持续重试探测（每 RETRY_MS 一次）——确认重试只是探测而不是别的
    await sleep(2800);
    check("重试仍只是身份探测", foreign.probes.every((p) => p.startsWith(PROXY_ID_PATH)), foreign.probes);
    await holder.stop();
    await foreign.close();
    // 外部进程退出后本实例并未继续运行（已 stop），端口应空闲
    eq("端口空闲", await portFree(PORT_G), true);
  });

  await test("probeIdentity：无人监听 → null；非 JSON → null", async () => {
    eq("空端口 → null", await probeIdentity(19898), null);
    const junk = await fakeInstance(19897, "0", { body: "not json" });
    eq("非 JSON 应答 → null", await probeIdentity(19897), null);
    await junk.close();
  });

  finish();
})();
