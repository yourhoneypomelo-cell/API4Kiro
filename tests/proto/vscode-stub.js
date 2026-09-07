/**
 * 最小 `vscode` 模块替身：让 src/ 下依赖 vscode 的模块能在纯 Node 里跑。
 *
 * - 配置默认值从仓根 package.json 的 contributes.configuration 读出（与真实扩展同一份来源）；
 * - `__setConfig("openaiThoughtDedupe", "off")` 覆盖某个键（键不带 `api2kiroDual.` 前缀也行）；
 * - `__resetConfig()` 清掉全部覆盖；
 * - `__makeContext(version)` 造一个内存版 ExtensionContext（globalState / extension.packageJSON）。
 *
 * 只实现 src 真正碰到的那几个 API；没实现的属性访问会是 undefined，测试里若踩到就补。
 */
"use strict";

const path = require("path");
const fs = require("fs");

/** 本文件会被 esbuild 内联进 .out/ 下的包，__dirname 不可靠：向上找到扩展自己的 package.json。 */
function findPackageJson(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const j = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (j && j.name === "api2kiro-dual") {
          return { json: j, dir };
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("vscode-stub: cannot locate api2kiro-dual package.json above " + start);
}

const located = findPackageJson(__dirname);
const pkg = located.json;
const repoRoot = located.dir;

const defaults = {};
(function collect() {
  const c = pkg.contributes && pkg.contributes.configuration;
  const blocks = Array.isArray(c) ? c : c ? [c] : [];
  for (const b of blocks) {
    for (const [k, v] of Object.entries(b.properties || {})) {
      defaults[k] = v.default;
    }
  }
})();

const overrides = new Map();

function fullKey(ns, key) {
  return ns ? `${ns}.${key}` : key;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeConfiguration(ns) {
  return {
    get(key, def) {
      const fk = fullKey(ns, key);
      if (overrides.has(fk)) {
        return clone(overrides.get(fk));
      }
      if (Object.prototype.hasOwnProperty.call(defaults, fk)) {
        const d = defaults[fk];
        if (d !== null && d !== undefined) {
          return clone(d);
        }
      }
      return def;
    },
    has(key) {
      const fk = fullKey(ns, key);
      return overrides.has(fk) || Object.prototype.hasOwnProperty.call(defaults, fk);
    },
    inspect(key) {
      const fk = fullKey(ns, key);
      return { key: fk, defaultValue: defaults[fk], globalValue: overrides.get(fk) };
    },
    async update(key, value) {
      const fk = fullKey(ns, key);
      if (value === undefined) {
        overrides.delete(fk);
      } else {
        overrides.set(fk, clone(value));
      }
    },
  };
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }
  fire(v) {
    for (const fn of this.listeners) {
      fn(v);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  dispose() {
    if (this.fn) {
      this.fn();
    }
  }
  static from(...items) {
    return new Disposable(() => items.forEach((d) => d && d.dispose && d.dispose()));
  }
}

const outputChannel = {
  appendLine() {},
  append() {},
  show() {},
  hide() {},
  clear() {},
  dispose() {},
};

const commandHandlers = new Map();

const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  EventEmitter,
  Disposable,
  Uri: {
    parse: (s) => ({ toString: () => s, fsPath: s, scheme: String(s).split(":")[0] }),
    file: (p) => ({ toString: () => "file://" + p, fsPath: p, scheme: "file" }),
    joinPath: (base, ...segs) => ({ toString: () => [String(base), ...segs].join("/"), fsPath: path.join(base.fsPath || String(base), ...segs), scheme: "file" }),
  },
  workspace: {
    getConfiguration: (ns) => makeConfiguration(ns),
    onDidChangeConfiguration: () => new Disposable(),
    workspaceFolders: [],
  },
  window: {
    createOutputChannel: () => outputChannel,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "", command: undefined }),
    registerWebviewViewProvider: () => new Disposable(),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showOpenDialog: async () => undefined,
  },
  commands: {
    registerCommand: (id, fn) => {
      commandHandlers.set(id, fn);
      return new Disposable(() => commandHandlers.delete(id));
    },
    executeCommand: async (id, ...args) => {
      const h = commandHandlers.get(id);
      if (!h) {
        throw new Error(`command not found: ${id}`);
      }
      return h(...args);
    },
  },
  env: {
    appRoot: process.cwd(),
    clipboard: { writeText: async () => undefined, readText: async () => "" },
    openExternal: async () => true,
  },

  // ---- 测试专用扩展 ----
  __setConfig(key, value) {
    const fk = key.includes(".") ? key : `api2kiroDual.${key}`;
    if (value === undefined) {
      overrides.delete(fk);
    } else {
      overrides.set(fk, clone(value));
    }
  },
  __resetConfig() {
    overrides.clear();
  },
  __defaults() {
    return clone(defaults);
  },
  __makeContext(version) {
    const store = new Map();
    const secrets = new Map();
    return {
      extension: { packageJSON: { version: version || pkg.version, name: pkg.name } },
      extensionPath: repoRoot,
      extensionUri: vscode.Uri.file(repoRoot),
      subscriptions: [],
      globalState: {
        get: (k, def) => (store.has(k) ? clone(store.get(k)) : def),
        update: async (k, v) => {
          if (v === undefined) {
            store.delete(k);
          } else {
            store.set(k, clone(v));
          }
        },
        keys: () => [...store.keys()],
        setKeysForSync() {},
      },
      workspaceState: {
        get: (k, def) => def,
        update: async () => undefined,
        keys: () => [],
      },
      secrets: {
        get: async (k) => secrets.get(k),
        store: async (k, v) => void secrets.set(k, v),
        delete: async (k) => void secrets.delete(k),
        onDidChange: () => new Disposable(),
      },
    };
  },
};

module.exports = vscode;
