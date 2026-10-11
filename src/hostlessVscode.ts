/**
 * 宿主外的 `vscode` 桩（**只被 esbuild 的别名用到**，产品代码不 import 它）。
 *
 * 背景：`vscode:uninstall` 钩子跑在扩展宿主之外，那里没有 `vscode` 模块，但卸载脚本要复用
 * `selectorStyle.syncGroupHeaderStyle(false)` 这套既有还原管线（还原逻辑全仓库只能有一份）。
 * 做法是在打包卸载入口时把裸模块名 `vscode` 别名到本文件，于是 `selectorStyle.ts` / `log.ts` /
 * `config.ts` 一行都不用改。
 *
 * 设计原则：**只实现卸载路径真的会触达的那一小块，其余成员一律抛错**。静默返回垃圾会让
 * 「将来有人让卸载入口传递依赖到别的模块」在用户机器上做错事；抛错则会在 tests/uninstall.test.js
 * 里立刻变红。明确实现的三个：`env`、`window.createOutputChannel`、`workspace.getConfiguration`。
 */

let appRootOverride: string | undefined;

/** 由 `uninstall.ts` 探测出 Kiro 的 appRoot 之后注入（优先级最高）。 */
export function setHostAppRoot(root: string): void {
  appRootOverride = root;
}

/** 宿主外没有真实的配置源：`get` 给默认值，`inspect` 给 undefined，`update` 直接拒绝。 */
function emptyConfiguration() {
  return {
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    inspect: () => undefined,
    update: async (): Promise<void> => {
      throw new Error("hostless vscode stub: 卸载钩子里不能写配置");
    },
  };
}

function unavailable(member: string): never {
  throw new Error(`hostless vscode stub: ${member} 在卸载钩子里不可用`);
}

export const env = {
  /** 优先 `setHostAppRoot()`，其次环境变量，最后空串（fail-closed）。 */
  get appRoot(): string {
    return appRootOverride || process.env.A2K_KIRO_APP_ROOT || "";
  },
  appName: "Kiro",
};

export const window = {
  /**
   * 卸载脚本没有输出通道，日志直接转 stdout——否则 `selectorStyle` 内部的 info / error 全丢，
   * 用户看不到还原结果（脚本会在结束时打印摘要，但逐步日志也有用）。
   */
  createOutputChannel(name: string) {
    const write = (line: string, withNewline: boolean) => {
      process.stdout.write(withNewline ? `${line}\n` : line);
    };
    void name;
    return {
      appendLine: (line: string) => write(line, true),
      append: (line: string) => write(line, false),
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    };
  },
  showWarningMessage: (..._a: unknown[]): never => unavailable("window.showWarningMessage"),
  showErrorMessage: (..._a: unknown[]): never => unavailable("window.showErrorMessage"),
  showInformationMessage: (..._a: unknown[]): never => unavailable("window.showInformationMessage"),
};

export const workspace = {
  getConfiguration: (..._a: unknown[]) => emptyConfiguration(),
};

export const ConfigurationTarget = { Global: true, Workspace: false, WorkspaceFolder: false };

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => String(p) }),
};

export const commands = {
  executeCommand: (..._a: unknown[]): never => unavailable("commands.executeCommand"),
};

export const extensions = {
  getExtension: (..._a: unknown[]): never => unavailable("extensions.getExtension"),
};

export const Disposable = { from: (..._a: unknown[]): never => unavailable("Disposable.from") };

export const EventEmitter = class {
  constructor() {
    unavailable("EventEmitter");
  }
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const ThemeColor = class {
  constructor() {
    unavailable("ThemeColor");
  }
};

export const MarkdownString = class {
  constructor() {
    unavailable("MarkdownString");
  }
};

export const Range = class {
  constructor() {
    unavailable("Range");
  }
};

export const Position = class {
  constructor() {
    unavailable("Position");
  }
};
