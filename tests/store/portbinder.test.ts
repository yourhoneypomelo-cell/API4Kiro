/** portBinder + proxyIdentity：固定端口所有权、同版本待机、外部进程冲突、版本让位握手（真实 127.0.0.1 端口 19877/19878）。 */
import * as vscode from "vscode";
import * as http from "http";
import { test, run, eq, ok, waitFor, sleep } from "./harness";
import { PortHolder } from "../../src/portBinder";
import { PROXY_ID_PATH, PROXY_ID_TOKEN, compareVersions, probeIdentity, serveIdentity } from "../../src/proxyIdentity";
import { getExtensionVersion, initConfig } from "../../src/config";

const stub = vscode as unknown as { __makeContext(o?: { version?: string }): unknown; __reset(): void };
const PORT = 19877;
const FOREIGN_PORT = 19878;

function makeServer(role: string): http.Server {
  return http.createServer((req, res) => {
    if (serveIdentity(req.url || "/", res, role)) {
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok " + role);
  });
}

test("setup", () => {
  stub.__reset();
  initConfig(stub.__makeContext({ version: "4.13.30" }) as never);
  eq(getExtensionVersion(), "4.13.30");
});

test("compareVersions：只比数字段", () => {
  eq(compareVersions("4.13.30", "4.13.29"), 1);
  eq(compareVersions("4.13.30", "4.13.30"), 0);
  eq(compareVersions("4.9.0", "4.13.0"), -1);
  eq(compareVersions("5.0.0-beta", "4.99.99"), 1);
  eq(compareVersions("4.13", "4.13.0"), 0);
  eq(compareVersions("", "0.0.1"), -1);
});

let owner: PortHolder;
const ownerChanges: boolean[] = [];

test("第一个实例绑上端口成为 OWNER；身份探测返回 proxy/role/version/pid", async () => {
  owner = new PortHolder(PORT, "KRS", () => makeServer("krs"), (o) => ownerChanges.push(o));
  await owner.start();
  eq(owner.isOwner(), true);
  eq(owner.hadForeignConflict(), false);
  eq(owner.getPort(), PORT);
  const id = await probeIdentity(PORT);
  ok(id, "有应答");
  eq(id!.proxy, PROXY_ID_TOKEN);
  eq(id!.role, "krs");
  eq(id!.version, "4.13.30");
  eq(id!.pid, process.pid);
  eq(id!.yielding, false);
  ok(PROXY_ID_PATH.includes("dual"), "身份路径与原版不同");
});

test("同版本第二个实例：探到自己人 → 待机（不 owner、不 foreign），停掉后不影响 OWNER", async () => {
  const standby = new PortHolder(PORT, "KRS", () => makeServer("krs"));
  await standby.start();
  eq(standby.isOwner(), false);
  eq(standby.hadForeignConflict(), false);
  await standby.stop();
  eq(owner.isOwner(), true);
});

test("外部进程占着端口：不是自己人 → foreign 冲突，不去动它", async () => {
  const foreign = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("not ours");
  });
  await new Promise<void>((r) => foreign.listen(FOREIGN_PORT, "127.0.0.1", () => r()));
  eq(await probeIdentity(FOREIGN_PORT), null);
  const h = new PortHolder(FOREIGN_PORT, "CPS", () => makeServer("cps"));
  await h.start();
  eq(h.isOwner(), false);
  eq(h.hadForeignConflict(), true);
  await h.stop();
  await new Promise<void>((r) => foreign.close(() => r()));
  eq(await probeIdentity(FOREIGN_PORT), null, "没人监听 → null");
});

test("让位握手：更旧版本请求 → 不让；更新版本请求 → yielding=true 并释放端口；随后重试接回", async () => {
  const older = await probeIdentity(PORT, "4.13.29");
  eq(older!.yielding, false);
  eq(owner.isOwner(), true);
  const newer = await probeIdentity(PORT, "4.14.0");
  eq(newer!.yielding, true, "应答里声明让位");
  await waitFor(() => !owner.isOwner(), 2000);
  eq(ownerChanges[ownerChanges.length - 1], false, "onChange(false)");
  // 端口已释放：一个"新版本"实例现在能直接绑上
  const taker = http.createServer((_q, r) => r.end("taker"));
  await new Promise<void>((resolve, reject) => {
    taker.once("error", reject);
    taker.listen(PORT, "127.0.0.1", () => resolve());
  });
  await sleep(200);
  eq(owner.isOwner(), false, "对方占着时旧实例持续待机");
  await new Promise<void>((r) => taker.close(() => r()));
  // 对方退出后，让位的实例按重试周期（2.5s）接回
  await waitFor(() => owner.isOwner(), 6000, 50);
  eq(ownerChanges[ownerChanges.length - 1], true, "onChange(true)");
  const id = await probeIdentity(PORT);
  eq(id!.role, "krs");
}, 15_000);

test("stop：释放端口且不再重试", async () => {
  await owner.stop();
  eq(owner.isOwner(), false);
  await sleep(100);
  eq(await probeIdentity(PORT), null);
  await sleep(2800);
  eq(await probeIdentity(PORT), null, "stop 后不会重新抢回");
}, 10_000);

run();
