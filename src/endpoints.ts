import * as vscode from "vscode";
import { info, error } from "./log";
import { getCpsPort, getPort } from "./config";

/**
 * 本地改动：保存 / 还原被本扩展清掉的 workspace 级端点配置。
 *
 * 上游 overrideEndpoint() 为了让 Global 生效，会主动删掉 workspace 与
 * workspaceFolder 层的同名键，但 restoreEndpoint() 只删不还原——原值没有任何地方
 * 存过，停用代理后是回落到 Kiro 内置默认，而不是回到用户原来的工作区设置。
 * 这里在清除前把原值存进 globalState，还原时写回。
 *
 * 本地改动（所有权）：这三个键是 Kiro 的全局设置，原版 API2Kiro、用户手写的企业代理地址都可能
 * 是写入者。本扩展 activationEvents 为 `*` 且 enabled 默认 false，每次关闭态激活都会走一遍
 * restoreAll()——以前是「有值就删」，会把别人的端点一并清掉。现在 Global 层只删本扩展写入的值
 * （写入时在 globalState 记 endpointWritten.<key>；升级前的版本没有记录，则退回「指向本扩展端口」
 * 的形状判断），workspace / workspaceFolder 层只在有本扩展 stash 时才动。
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

/** 所有权记录：本扩展最后一次写入（或接管）的 Global 值，restoreEndpoint 只删与之一致的值。 */
const WRITTEN_PREFIX = "endpointWritten.";

function writtenKey(key: EndpointKey): string {
  return `${WRITTEN_PREFIX}${key}`;
}

async function recordWritten(key: EndpointKey, value: unknown): Promise<void> {
  if (!extCtx) {
    return;
  }
  if (JSON.stringify(extCtx.globalState.get(writtenKey(key))) !== JSON.stringify(value)) {
    await extCtx.globalState.update(writtenKey(key), value);
  }
}

async function clearWritten(key: EndpointKey): Promise<void> {
  if (extCtx && extCtx.globalState.get(writtenKey(key)) !== undefined) {
    await extCtx.globalState.update(writtenKey(key), undefined);
  }
}

/**
 * 形状判断：非空数组且每一项都指向本扩展当前配置的 KRS / CPS 端口（`http://127.0.0.1:<port>`）。
 * 原版 API2Kiro 的 19800/19801、用户手写的 https 中转、null / 字符串等一律 false。
 * 用于升级前版本留下的 Global 值（那时还没有 endpointWritten 记录）。
 */
function pointsAtOurPorts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const ours = new Set([`http://127.0.0.1:${getPort()}`, `http://127.0.0.1:${getCpsPort()}`]);
  return value.every(
    (e) => !!e && typeof e === "object" && ours.has(String((e as { endpoint?: unknown }).endpoint))
  );
}

/** Global 层的这份值是不是本扩展写的：与记录逐字一致，或（无记录 / 记录已过期）指向本扩展端口。 */
function ownsGlobalValue(key: EndpointKey, value: unknown): boolean {
  const written = extCtx?.globalState.get(writtenKey(key));
  if (written !== undefined && JSON.stringify(written) === JSON.stringify(value)) {
    return true;
  }
  return pointsAtOurPorts(value);
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
      return changed;
    }
  }
  // Global 现在就是本扩展的目标值（刚写入，或升级 / 另一窗口早已写好而由本窗口接管）：记下所有权，
  // 之后 restoreEndpoint 只删与这条记录一致的值，别的写入者的端点不动。
  await recordWritten(key, desired);
  return changed;
}

/**
 * Undo this extension's endpoint override so Kiro falls back to built-ins (or to whatever the
 * user / another writer had configured).
 *
 * 注意（双开限制）：这三个键是 Kiro 的全局设置，本扩展与原版 API2Kiro 共用同一组。
 * 关闭本扩展的代理时这里会把本扩展写的 Global 值清掉，Kiro 回落到内置默认——如果原版此时正开着，
 * 需要在原版面板里重新开一次开关，让它把端点重新指回自己。
 *
 * 本地改动：清完之后，把 override 时暂存的 workspace / workspaceFolder 原值写回，
 * 让停用代理真正回到用户原来的配置，而不是 Kiro 内置默认。
 *
 * 本地改动（所有权）：Global 层只删本扩展写的值（ownsGlobalValue）；不是本扩展写的（原版 API2Kiro、
 * 手写地址）只记一条日志、原样保留。workspace / workspaceFolder 层只在有本扩展 stash 时才写回原值，
 * 没有 stash 说明这一层从未被本扩展清过，不动。于是「从未接管过端点」的关闭态激活是 no-op。
 */
export async function restoreEndpoint(key: EndpointKey): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration(CW_CONFIG);
  const globalValue = conf.inspect(key)?.globalValue;
  let changed = false;

  // 只在「本扩展的值仍在 Global 且删除失败」时保留记录，其余情况（已删 / 早已不在 / 被别人覆盖）记录都过期了。
  let keepRecord = false;
  if (globalValue !== undefined) {
    if (ownsGlobalValue(key, globalValue)) {
      try {
        await conf.update(key, undefined, vscode.ConfigurationTarget.Global);
        info(`${key} removed at global`);
        changed = true;
      } catch (e) {
        error(`restore ${key} at global failed:`, (e as Error)?.message);
        keepRecord = true;
      }
    } else {
      info(`${key} at global was set by another writer (not this extension); left untouched`);
    }
  }
  if (!keepRecord) {
    await clearWritten(key);
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
