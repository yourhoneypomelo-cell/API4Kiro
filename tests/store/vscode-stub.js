/**
 * 测试用的 `vscode` 模块替身（esbuild 把 `import * as vscode from "vscode"` 指到这里）。
 *
 * 只实现数据层 / 授权层模块会碰到的那一小片 API：
 *  - workspace.getConfiguration(section)：内存三层作用域（global / workspace / workspaceFolder），
 *    默认值从 package.json 的 contributes.configuration.properties 读；
 *  - ExtensionContext：内存 globalState / secrets，`__makeContext()` 造一个；
 *  - window.createOutputChannel / showErrorMessage、env.openExternal、Uri.parse：只记录不做事。
 *
 * 测试通过 `__setConfig(key, value, target?)` 改配置、`__reset()` 清场。
 */
"use strict";
const fs = require("fs");
const path = require("path");

// 本文件会被 esbuild 打进 .build/ 下的套件里，__dirname 不固定：向上找到扩展的 package.json
function findRoot(from) {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, "package.json");
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (j && j.name === "api2kiro-dual") {
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("vscode-stub: cannot locate extension package.json above " + from);
}
const ROOT = findRoot(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DEFAULTS = {};
for (const [k, v] of Object.entries((pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) || {})) {
  DEFAULTS[k] = v.default;
}

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

/** 全键（含命名空间）→ 值，三层。 */
const layers = { global: new Map(), workspace: new Map(), workspaceFolder: new Map() };
const configListeners = new Set();

function layerOf(target) {
  if (target === ConfigurationTarget.Workspace) return layers.workspace;
  if (target === ConfigurationTarget.WorkspaceFolder) return layers.workspaceFolder;
  return layers.global;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function effective(full) {
  if (layers.workspaceFolder.has(full)) return layers.workspaceFolder.get(full);
  if (layers.workspace.has(full)) return layers.workspace.get(full);
  if (layers.global.has(full)) return layers.global.get(full);
  return DEFAULTS[full];
}

function getConfiguration(section) {
  const prefix = section ? section + "." : "";
  return {
    get(key, def) {
      const v = effective(prefix + key);
      return v === undefined ? def : clone(v);
    },
    has(key) {
      return effective(prefix + key) !== undefined;
    },
    inspect(key) {
      const full = prefix + key;
      return {
        key: full,
        defaultValue: clone(DEFAULTS[full]),
        globalValue: clone(layers.global.get(full)),
        workspaceValue: clone(layers.workspace.get(full)),
        workspaceFolderValue: clone(layers.workspaceFolder.get(full)),
      };
    },
    async update(key, value, target) {
      const full = prefix + key;
      const layer = layerOf(target === true ? ConfigurationTarget.Global : target === undefined || target === false ? ConfigurationTarget.Workspace : target);
      if (value === undefined) {
        layer.delete(full);
      } else {
        layer.set(full, clone(value));
      }
      for (const l of configListeners) {
        try {
          l({ affectsConfiguration: (s) => full.startsWith(s) });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function __setConfig(fullKey, value, target = ConfigurationTarget.Global) {
  const layer = layerOf(target);
  if (value === undefined) layer.delete(fullKey);
  else layer.set(fullKey, clone(value));
}

function __getConfigLayers() {
  return layers;
}

function __reset() {
  for (const l of Object.values(layers)) l.clear();
  outputLines.length = 0;
  shownMessages.length = 0;
  openedUrls.length = 0;
}

class Memento {
  constructor() {
    this.map = new Map();
    this.updates = 0;
  }
  get(key, def) {
    return this.map.has(key) ? clone(this.map.get(key)) : def;
  }
  async update(key, value) {
    this.updates++;
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, clone(value));
  }
  keys() {
    return [...this.map.keys()];
  }
  setKeysForSync() {}
}

class Secrets {
  constructor() {
    this.map = new Map();
    this.stores = 0;
  }
  async get(key) {
    return this.map.get(key);
  }
  async store(key, value) {
    this.stores++;
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  onDidChange() {
    return { dispose() {} };
  }
}

function __makeContext(opts = {}) {
  return {
    globalState: new Memento(),
    workspaceState: new Memento(),
    secrets: opts.secrets === false ? undefined : new Secrets(),
    subscriptions: [],
    extensionPath: ROOT,
    extensionUri: { fsPath: ROOT },
    extension: { packageJSON: { version: opts.version || pkg.version } },
    globalStorageUri: { fsPath: path.join(ROOT, "tests", "store", ".build", "globalStorage") },
  };
}

const outputLines = [];
const shownMessages = [];
const openedUrls = [];

const window = {
  createOutputChannel(name) {
    return {
      name,
      appendLine(s) {
        outputLines.push(s);
      },
      append(s) {
        outputLines.push(s);
      },
      show() {},
      hide() {},
      clear() {},
      dispose() {},
    };
  },
  showErrorMessage(msg) {
    shownMessages.push({ level: "error", msg });
    return Promise.resolve(undefined);
  },
  showWarningMessage(msg) {
    shownMessages.push({ level: "warn", msg });
    return Promise.resolve(undefined);
  },
  showInformationMessage(msg) {
    shownMessages.push({ level: "info", msg });
    return Promise.resolve(undefined);
  },
};

const Uri = {
  parse(s) {
    return { toString: () => s, fsPath: s };
  },
  file(p) {
    return { toString: () => "file://" + p, fsPath: p };
  },
};

const env = {
  appRoot: path.join(ROOT, "tests", "store", ".build", "appRoot"),
  async openExternal(uri) {
    openedUrls.push(String(uri));
    return true;
  },
};

const workspace = {
  getConfiguration,
  onDidChangeConfiguration(l) {
    configListeners.add(l);
    return { dispose: () => configListeners.delete(l) };
  },
  workspaceFolders: undefined,
};

module.exports = {
  ConfigurationTarget,
  workspace,
  window,
  env,
  Uri,
  __setConfig,
  __getConfigLayers,
  __reset,
  __makeContext,
  __outputLines: outputLines,
  __shownMessages: shownMessages,
  __openedUrls: openedUrls,
};
