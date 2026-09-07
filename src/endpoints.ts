import * as vscode from "vscode";
import { info, error } from "./log";

/**
 * 本地改动：保存 / 还原被本扩展清掉的 workspace 级端点配置。
 *
 * 上游 overrideEndpoint() 为了让 Global 生效，会主动删掉 workspace 与
 * workspaceFolder 层的同名键，但 restoreEndpoint() 只删不还原——原值没有任何地方
 * 存过，停用代理后是回落到 Kiro 内置默认，而不是回到用户原来的工作区设置。
 * 这里在清除前把原值存进 globalState，还原时写回。
 */
let extCtx: vscode.ExtensionContext | undefined;

export function initEndpoints(context: vscode.ExtensionContext): void {
  extCtx = context;
}

const STASH_PREFIX = "endpointStash.";

function stashKey(key: EndpointKey, scope: "workspace" | "workspaceFolder"): string {
  return `${STASH_PREFIX}${key}.${scope}`;
}

async function stashValue(
  key: EndpointKey,
  scope: "workspace" | "workspaceFolder",
  value: unknown
): Promise<void> {
  if (!extCtx || value === undefined) {
    return;
  }
  // 只在还没存过时写入，避免第二次 override 用我们自己的值覆盖掉用户的原值。
  if (extCtx.globalState.get(stashKey(key, scope)) === undefined) {
    await extCtx.globalState.update(stashKey(key, scope), value);
    info(`stashed original ${scope} ${key}`);
  }
}

async function popStashed(
  key: EndpointKey,
  scope: "workspace" | "workspaceFolder"
): Promise<unknown> {
  if (!extCtx) {
    return undefined;
  }
  const v = extCtx.globalState.get(stashKey(key, scope));
  if (v !== undefined) {
    await extCtx.globalState.update(stashKey(key, scope), undefined);
  }
  return v;
}

/**
 * All AWS regions Kiro may try. We map every region to our local proxy so that
 * whichever region Kiro selects, the request lands on us.
 */
const KIRO_ALL_REGIONS = [
  "us-east-1",
  "eu-central-1",
  "us-gov-east-1",
  "us-gov-west-1",
  "us-iso-east-1",
  "us-isob-east-1",
  "us-isof-south-1",
  "us-isof-east-1",
];

const CW_CONFIG = "codewhisperer.config";

export type EndpointKey = "krsEndpoints" | "cpsEndpoints" | "endpoints";

function buildEndpointList(port: number) {
  return KIRO_ALL_REGIONS.map((region) => ({
    region,
    endpoint: `http://127.0.0.1:${port}`,
  }));
}

/**
 * Point a codewhisperer endpoint key at the local proxy (Global scope).
 * Clears any workspace/workspaceFolder overrides first so Global wins.
 * Returns true if the effective (global) value actually changed.
 */
export async function overrideEndpoint(key: EndpointKey, port: number): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration(CW_CONFIG);
  const inspected = conf.inspect(key);
  const desired = buildEndpointList(port);
  let changed = false;

  if (inspected?.workspaceValue !== undefined) {
    try {
      await stashValue(key, "workspace", inspected.workspaceValue);
      await conf.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      changed = true;
    } catch (e) {
      error(`clear workspace ${key} failed:`, (e as Error)?.message);
    }
  }
  if (inspected?.workspaceFolderValue !== undefined) {
    try {
      await stashValue(key, "workspaceFolder", inspected.workspaceFolderValue);
      await conf.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      changed = true;
    } catch (e) {
      error(`clear workspaceFolder ${key} failed:`, (e as Error)?.message);
    }
  }

  const current = conf.inspect(key)?.globalValue ?? [];
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    try {
      await conf.update(key, desired, vscode.ConfigurationTarget.Global);
      info(`${key} -> 127.0.0.1:${port}`);
      changed = true;
    } catch (e) {
      error(`override ${key} failed:`, (e as Error)?.message);
      void vscode.window.showErrorMessage(
        `API4Kiro 无法写入 codewhisperer.config.${key}，请手动在 settings.json 添加：\n"codewhisperer.config.${key}": ${JSON.stringify(
          desired
        )}`
      );
    }
  }
  return changed;
}

/**
 * Remove an endpoint override at every scope so Kiro falls back to built-ins.
 *
 * 注意（双开限制）：这三个键是 Kiro 的全局设置，本扩展与原版 API2Kiro 共用同一组。
 * 停用本扩展时这里会把 Global 值清掉，Kiro 回落到内置默认——如果原版此时正开着，
 * 需要在原版面板里重新开一次开关，让它把端点重新指回自己。
 *
 * 本地改动：清完之后，把 override 时暂存的 workspace / workspaceFolder 原值写回，
 * 让停用代理真正回到用户原来的配置，而不是 Kiro 内置默认。
 */
export async function restoreEndpoint(key: EndpointKey): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration(CW_CONFIG);
  const inspected = conf.inspect(key);
  const targets: Array<[vscode.ConfigurationTarget, unknown, string]> = [
    [vscode.ConfigurationTarget.WorkspaceFolder, inspected?.workspaceFolderValue, "workspaceFolder"],
    [vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue, "workspace"],
    [vscode.ConfigurationTarget.Global, inspected?.globalValue, "global"],
  ];
  let changed = false;
  for (const [target, value, label] of targets) {
    if (value === undefined) {
      continue;
    }
    try {
      await conf.update(key, undefined, target);
      info(`${key} removed at ${label}`);
      changed = true;
    } catch (e) {
      error(`restore ${key} at ${label} failed:`, (e as Error)?.message);
    }
  }

  const restores: Array<[vscode.ConfigurationTarget, "workspace" | "workspaceFolder"]> = [
    [vscode.ConfigurationTarget.Workspace, "workspace"],
    [vscode.ConfigurationTarget.WorkspaceFolder, "workspaceFolder"],
  ];
  for (const [target, scope] of restores) {
    const original = await popStashed(key, scope);
    if (original === undefined) {
      continue;
    }
    try {
      await conf.update(key, original, target);
      info(`${key} restored original ${scope} value`);
      changed = true;
    } catch (e) {
      error(`re-apply original ${scope} ${key} failed:`, (e as Error)?.message);
    }
  }
  return changed;
}

/**
 * Detect Kiro >= 1.0, which also honors the generic "endpoints" key. On older
 * builds we simply clear it. We can't read Kiro's version reliably from the
 * extension host, so we always override all three keys defensively.
 * Returns true if any effective value changed (a window reload is then needed).
 */
export async function applyOverrides(krsPort: number, cpsPort: number): Promise<boolean> {
  const a = await overrideEndpoint("endpoints", krsPort);
  const b = await overrideEndpoint("krsEndpoints", krsPort);
  const c = await overrideEndpoint("cpsEndpoints", cpsPort);
  return a || b || c;
}

export async function restoreAll(): Promise<boolean> {
  const a = await restoreEndpoint("endpoints");
  const b = await restoreEndpoint("krsEndpoints");
  const c = await restoreEndpoint("cpsEndpoints");
  return a || b || c;
}
