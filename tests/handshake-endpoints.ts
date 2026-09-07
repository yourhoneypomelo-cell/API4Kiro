/**
 * 端点劫持的 stash / pop（src/endpoints.ts）：与 portBinder 同属 M2「端点 + 端口所有权」。
 * 用 vscode 桩的三层作用域验证：override 时 workspace/workspaceFolder 原值被 stash 并清掉、Global 指到本机；
 * 二次 override 不覆盖已 stash 的原值；restore 时 Global 清掉、原值逐字写回、stash 清空。
 */
import * as vscode from "vscode";
import { applyOverrides, initEndpoints, overrideEndpoint, restoreAll, restoreEndpoint } from "../src/endpoints";
import { check, deepEq, eq, finish, test } from "./lib/harness";

type Stub = typeof vscode & {
  __makeContext(): vscode.ExtensionContext;
  __setConfig(key: string, value: unknown, target?: number): void;
  __resetConfig(): void;
};
const stub = vscode as unknown as Stub;
const CW = "codewhisperer.config";
const T = vscode.ConfigurationTarget;

const ORIGINAL_WS = [
  { region: "us-east-1", endpoint: "https://relay.example/v1?x=1&y=%20z" },
  { region: "eu-central-1", endpoint: "http://10.0.0.7:8080/", extra: { nested: [1, "two", null], flag: false } },
];
const ORIGINAL_WSF = "https://a-plain-string-value.example/odd";

function inspect(key: string) {
  return vscode.workspace.getConfiguration(CW).inspect(key)!;
}

(async () => {
  const ctx = stub.__makeContext();
  initEndpoints(ctx);

  await test("overrideEndpoint：stash 原值、清工作区层、Global 指本机全部 region", async () => {
    stub.__resetConfig();
    stub.__setConfig(`${CW}.krsEndpoints`, ORIGINAL_WS, T.Workspace);
    stub.__setConfig(`${CW}.krsEndpoints`, ORIGINAL_WSF, T.WorkspaceFolder);
    const changed = await overrideEndpoint("krsEndpoints", 19810);
    eq("有效值变化 → true", changed, true);
    const i = inspect("krsEndpoints");
    eq("workspace 层被清", i.workspaceValue, undefined);
    eq("workspaceFolder 层被清", i.workspaceFolderValue, undefined);
    const g = i.globalValue as Array<{ region: string; endpoint: string }>;
    eq("Global 写入 8 个 region", g.length, 8);
    check("全部指向 127.0.0.1:19810", g.every((e) => e.endpoint === "http://127.0.0.1:19810"), g);
    deepEq("region 列表覆盖 gov/iso 分区", g.map((e) => e.region), ["us-east-1", "eu-central-1", "us-gov-east-1", "us-gov-west-1", "us-iso-east-1", "us-isob-east-1", "us-isof-south-1", "us-isof-east-1"]);
    deepEq("workspace 原值进 stash", ctx.globalState.get("endpointStash.krsEndpoints.workspace"), ORIGINAL_WS);
    eq("workspaceFolder 原值进 stash（字符串也原样）", ctx.globalState.get("endpointStash.krsEndpoints.workspaceFolder"), ORIGINAL_WSF);
  });

  await test("二次 override：不用自己的值覆盖已 stash 的原值；Global 已一致时不报变化", async () => {
    stub.__setConfig(`${CW}.krsEndpoints`, [{ region: "x", endpoint: "http://someone-else" }], T.Workspace);
    const changed = await overrideEndpoint("krsEndpoints", 19810);
    eq("清了新出现的 workspace 值 → true", changed, true);
    deepEq("stash 仍是最初的原值", ctx.globalState.get("endpointStash.krsEndpoints.workspace"), ORIGINAL_WS);
    const again = await overrideEndpoint("krsEndpoints", 19810);
    eq("一切已就位 → 无变化 false", again, false);
  });

  await test("restoreEndpoint：Global 清掉、原值逐字写回、stash 清空", async () => {
    const changed = await restoreEndpoint("krsEndpoints");
    eq("有变化 → true", changed, true);
    const i = inspect("krsEndpoints");
    eq("Global 已清", i.globalValue, undefined);
    deepEq("workspace 原值逐字还原（含 query 与嵌套字段）", i.workspaceValue, ORIGINAL_WS);
    eq("workspaceFolder 原值逐字还原（字符串）", i.workspaceFolderValue, ORIGINAL_WSF);
    eq("stash(workspace) 已清", ctx.globalState.get("endpointStash.krsEndpoints.workspace"), undefined);
    eq("stash(workspaceFolder) 已清", ctx.globalState.get("endpointStash.krsEndpoints.workspaceFolder"), undefined);
    const idle = await restoreEndpoint("krsEndpoints");
    eq("再 restore 一次：workspace 有值要清 → 仍 true（只清不还原）", idle, true);
    eq("再 restore 后 workspace 值被清（无 stash 可还原）", inspect("krsEndpoints").workspaceValue, undefined);
  });

  await test("applyOverrides / restoreAll：三键一起，无原值时只动 Global", async () => {
    stub.__resetConfig();
    const changed = await applyOverrides(19810, 19811);
    eq("首次 apply → true", changed, true);
    eq("endpoints → KRS 端口", (inspect("endpoints").globalValue as Array<{ endpoint: string }>)[0].endpoint, "http://127.0.0.1:19810");
    eq("krsEndpoints → KRS 端口", (inspect("krsEndpoints").globalValue as Array<{ endpoint: string }>)[0].endpoint, "http://127.0.0.1:19810");
    eq("cpsEndpoints → CPS 端口", (inspect("cpsEndpoints").globalValue as Array<{ endpoint: string }>)[0].endpoint, "http://127.0.0.1:19811");
    eq("重复 apply → false", await applyOverrides(19810, 19811), false);
    eq("换端口 apply → true", await applyOverrides(19820, 19821), true);
    eq("cps 跟着换", (inspect("cpsEndpoints").globalValue as Array<{ endpoint: string }>)[0].endpoint, "http://127.0.0.1:19821");
    eq("restoreAll → true", await restoreAll(), true);
    for (const k of ["endpoints", "krsEndpoints", "cpsEndpoints"] as const) {
      const i = inspect(k);
      check(`${k} 三层皆空`, i.globalValue === undefined && i.workspaceValue === undefined && i.workspaceFolderValue === undefined, i);
    }
    eq("空配置再 restoreAll → false", await restoreAll(), false);
    eq("globalState 里没有残留 stash", ctx.globalState.keys().filter((k) => k.startsWith("endpointStash.")).length, 0);
  });

  finish();
})();
