/** endpoints：stash / pop 逐字还原 workspace 与 workspaceFolder 原值；Global 指到本机；幂等。 */
import * as vscode from "vscode";
import { test, run, eq, deepEq, ok } from "./harness";
import { applyOverrides, initEndpoints, overrideEndpoint, restoreAll, restoreEndpoint } from "../../src/endpoints";

type Ctx = { globalState: { get<T>(k: string): T | undefined; keys(): string[] } };
const stub = vscode as unknown as {
  __makeContext(): Ctx;
  __reset(): void;
  __setConfig(key: string, value: unknown, target?: number): void;
  ConfigurationTarget: { Global: number; Workspace: number; WorkspaceFolder: number };
};
const T = vscode.ConfigurationTarget;
const CW = "codewhisperer.config";

function fresh(): Ctx {
  stub.__reset();
  const ctx = stub.__makeContext();
  initEndpoints(ctx as never);
  return ctx;
}

function inspect(key: string) {
  return vscode.workspace.getConfiguration(CW).inspect(key)!;
}

const ORIGINAL_WS = [{ region: "us-east-1", endpoint: "https://my-relay.example/ws" }, { region: "eu-central-1", endpoint: "https://eu.example" }];
const ORIGINAL_WSF = [{ region: "us-east-1", endpoint: "http://10.0.0.5:9000/folder", note: "带多余字段" }];

test("applyOverrides：三键 Global 指向 127.0.0.1:<port>，覆盖全部 region；workspace/workspaceFolder 原值被 stash 并清除", async () => {
  const ctx = fresh();
  stub.__setConfig(`${CW}.krsEndpoints`, ORIGINAL_WS, T.Workspace);
  stub.__setConfig(`${CW}.cpsEndpoints`, ORIGINAL_WSF, T.WorkspaceFolder);
  const changed = await applyOverrides(19871, 19872);
  eq(changed, true);
  for (const [key, port] of [["endpoints", 19871], ["krsEndpoints", 19871], ["cpsEndpoints", 19872]] as const) {
    const i = inspect(key);
    ok(Array.isArray(i.globalValue), `${key} global 是数组`);
    const list = i.globalValue as Array<{ region: string; endpoint: string }>;
    eq(list.length, 8, "8 个 region 全映射");
    for (const e of list) {
      eq(e.endpoint, `http://127.0.0.1:${port}`);
    }
    eq(i.workspaceValue, undefined, `${key} workspace 已清`);
    eq(i.workspaceFolderValue, undefined, `${key} workspaceFolder 已清`);
  }
  deepEq(ctx.globalState.get("endpointStash.krsEndpoints.workspace"), ORIGINAL_WS);
  deepEq(ctx.globalState.get("endpointStash.cpsEndpoints.workspaceFolder"), ORIGINAL_WSF);
  eq(ctx.globalState.get("endpointStash.endpoints.workspace"), undefined, "没有原值就不 stash");
});

test("restoreAll：Global 清掉，stash 的原值逐字写回原作用域，stash 键清空", async () => {
  const ctx = fresh();
  stub.__setConfig(`${CW}.krsEndpoints`, ORIGINAL_WS, T.Workspace);
  stub.__setConfig(`${CW}.cpsEndpoints`, ORIGINAL_WSF, T.WorkspaceFolder);
  stub.__setConfig(`${CW}.endpoints`, null, T.Workspace); // JSON null 也是一个"值"，要原样还原
  await applyOverrides(19871, 19872);
  const changed = await restoreAll();
  eq(changed, true);
  eq(inspect("krsEndpoints").globalValue, undefined);
  eq(inspect("cpsEndpoints").globalValue, undefined);
  eq(inspect("endpoints").globalValue, undefined);
  deepEq(inspect("krsEndpoints").workspaceValue, ORIGINAL_WS, "workspace 原值逐字还原");
  deepEq(inspect("cpsEndpoints").workspaceFolderValue, ORIGINAL_WSF, "workspaceFolder 原值逐字还原");
  eq(inspect("krsEndpoints").workspaceFolderValue, undefined, "不串作用域");
  eq(inspect("endpoints").workspaceValue, null, "null 原值也还原");
  eq(ctx.globalState.keys().filter((k) => k.startsWith("endpointStash.")).length, 0, "stash 全部弹出");
});

test("重复 override 不会用自己的值覆盖 stash；换端口后仍还原用户原值", async () => {
  const ctx = fresh();
  stub.__setConfig(`${CW}.krsEndpoints`, ORIGINAL_WS, T.Workspace);
  await applyOverrides(19871, 19872);
  // 用户（或另一个窗口）在启用期间又往 workspace 写了别的值：再次 override 会清掉它但不能顶掉最初 stash
  stub.__setConfig(`${CW}.krsEndpoints`, [{ region: "x", endpoint: "http://later" }], T.Workspace);
  const changed = await applyOverrides(19899, 19898);
  eq(changed, true, "端口变了 → Global 改写");
  deepEq(ctx.globalState.get("endpointStash.krsEndpoints.workspace"), ORIGINAL_WS, "stash 仍是最初原值");
  const g = inspect("krsEndpoints").globalValue as Array<{ endpoint: string }>;
  eq(g[0].endpoint, "http://127.0.0.1:19899");
  await restoreAll();
  deepEq(inspect("krsEndpoints").workspaceValue, ORIGINAL_WS);
});

test("幂等：同端口第二次 applyOverrides 返回 false；无任何值时 restore 返回 false", async () => {
  fresh();
  eq(await applyOverrides(19871, 19872), true);
  eq(await applyOverrides(19871, 19872), false);
  eq(await restoreAll(), true);
  eq(await restoreAll(), false);
  eq(await restoreEndpoint("krsEndpoints"), false);
  eq(await overrideEndpoint("krsEndpoints", 19871), true);
});

run();
