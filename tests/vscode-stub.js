/**
 * `vscode` 模块桩：给 tests/*.ts 打包时替代真实扩展宿主。
 *
 *  - 配置：默认值来自 package.json 的 contributes.configuration.properties；三层作用域
 *    （Global / Workspace / WorkspaceFolder）各一张表，get 取最具体的一层，inspect 原样给出三层值。
 *    `__setConfig(key, value, target?)` 写覆盖值（key 可写 "enabled" 或 "api2kiroDual.enabled"）；
 *    `__resetConfig()` 清空；`__fireConfigChange(keys)` 触发 onDidChangeConfiguration。
 *  - 输出通道：所有 appendLine 落到 `__outputLines()`，可断言日志脱敏。
 *  - `__makeContext({ version?, secrets? })` 造一个 ExtensionContext（globalState 内存 Memento；
 *    secrets 缺省不提供，tokenStore 会退到 globalState；传 secrets:true 则给一个内存 SecretStorage）。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

// 打包后本文件被内联进 tests/.out/<suite>.js，__dirname 随之变化：向上找到扩展的 package.json 为止。
function findRoot(from) {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, "package.json");
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (j && j.contributes && j.contributes.configuration) {
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) {
      break;
    }
    dir = up;
  }
  return path.resolve(from, "..", "..");
}
const root = findRoot(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const defaults = {};
for (const [k, v] of Object.entries((pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) || {})) {
  defaults[k] = v && Object.prototype.hasOwnProperty.call(v, "default") ? v.default : undefined;
}

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const scopes = { 1: new Map(), 2: new Map(), 3: new Map() };
const configListeners = new Set();
const outputLines = [];
const messages = [];
const commands = new Map();

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function normalizeKey(key) {
  if (Object.prototype.hasOwnProperty.call(defaults, key)) {
    return key;
  }
  const ns = "api2kiroDual." + key;
  if (Object.prototype.hasOwnProperty.call(defaults, ns)) {
    return ns;
  }
  return key.includes(".") ? key : ns;
}

function effective(fullKey) {
  for (const t of [3, 2, 1]) {
    if (scopes[t].has(fullKey)) {
      return scopes[t].get(fullKey);
    }
  }
  return defaults[fullKey];
}

function targetOf(target) {
  if (target === undefined || target === null || target === true) {
    return 1;
  }
  if (target === false) {
    return 2;
  }
  return target;
}

function fire(keys) {
  const e = {
    affectsConfiguration(section) {
      return keys.some((k) => k === section || k.startsWith(section + "."));
    },
  };
  for (const l of Array.from(configListeners)) {
    try {
      l(e);
    } catch {
      /* ignore */
    }
  }
}

function getConfiguration(section) {
  const full = (key) => (section ? `${section}.${key}` : key);
  return {
    get(key, def) {
      const v = effective(full(key));
      return v === undefined ? def : clone(v);
    },
    has(key) {
      return effective(full(key)) !== undefined;
    },
    inspect(key) {
      const fk = full(key);
      return {
        key: fk,
        defaultValue: clone(defaults[fk]),
        globalValue: clone(scopes[1].get(fk)),
        workspaceValue: clone(scopes[2].get(fk)),
        workspaceFolderValue: clone(scopes[3].get(fk)),
      };
    },
    async update(key, value, target) {
      const fk = full(key);
      const t = targetOf(target);
      if (value === undefined) {
        scopes[t].delete(fk);
      } else {
        scopes[t].set(fk, clone(value));
      }
      if (stub.__fireOnUpdate) {
        fire([fk]);
      }
    },
  };
}

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) {
      this._fn();
      this._fn = undefined;
    }
  }
  static from(...items) {
    return new Disposable(() => items.forEach((d) => d && d.dispose && d.dispose()));
  }
}

class EventEmitter {
  constructor() {
    this._ls = new Set();
    this.event = (l) => {
      this._ls.add(l);
      return new Disposable(() => this._ls.delete(l));
    };
  }
  fire(v) {
    for (const l of Array.from(this._ls)) {
      l(v);
    }
  }
  dispose() {
    this._ls.clear();
  }
}

class Memento {
  constructor() {
    this.map = new Map();
  }
  get(key, def) {
    return this.map.has(key) ? clone(this.map.get(key)) : def;
  }
  async update(key, value) {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, clone(value));
    }
  }
  keys() {
    return Array.from(this.map.keys());
  }
  setKeysForSync() {}
}

class SecretStorage {
  constructor() {
    this.map = new Map();
    this._em = new EventEmitter();
    this.onDidChange = this._em.event;
  }
  async get(k) {
    return this.map.get(k);
  }
  async store(k, v) {
    this.map.set(k, v);
    this._em.fire({ key: k });
  }
  async delete(k) {
    this.map.delete(k);
    this._em.fire({ key: k });
  }
}

const Uri = {
  file(p) {
    return { scheme: "file", fsPath: p, path: p.replace(/\\/g, "/"), toString: () => "file://" + p.replace(/\\/g, "/") };
  },
  parse(s) {
    return { scheme: String(s).split(":")[0], fsPath: s, path: s, toString: () => s };
  },
  joinPath(base, ...parts) {
    return Uri.file(path.join(base.fsPath, ...parts));
  },
};

const window = {
  createOutputChannel(name) {
    return {
      name,
      appendLine(line) {
        outputLines.push(String(line));
      },
      append(text) {
        outputLines.push(String(text));
      },
      show() {},
      hide() {},
      clear() {},
      dispose() {},
    };
  },
  showErrorMessage(...a) {
    messages.push({ level: "error", args: a });
    return Promise.resolve(undefined);
  },
  showWarningMessage(...a) {
    messages.push({ level: "warning", args: a });
    return Promise.resolve(undefined);
  },
  showInformationMessage(...a) {
    messages.push({ level: "info", args: a });
    return Promise.resolve(undefined);
  },
  showOpenDialog() {
    return Promise.resolve(undefined);
  },
  createStatusBarItem() {
    return { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };
  },
  registerWebviewViewProvider() {
    return new Disposable();
  },
  activeTextEditor: undefined,
};

const workspace = {
  getConfiguration,
  onDidChangeConfiguration(l) {
    configListeners.add(l);
    return new Disposable(() => configListeners.delete(l));
  },
  workspaceFolders: [],
  fs: {
    readFile: async (uri) => fs.readFileSync(uri.fsPath),
  },
};

const stub = {
  version: "1.90.0",
  ConfigurationTarget,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ViewColumn: { One: 1, Two: 2, Active: -1 },
  Disposable,
  EventEmitter,
  Uri,
  window,
  workspace,
  commands: {
    registerCommand(id, fn) {
      commands.set(id, fn);
      return new Disposable(() => commands.delete(id));
    },
    executeCommand(id, ...a) {
      const fn = commands.get(id);
      return Promise.resolve(fn ? fn(...a) : undefined);
    },
  },
  env: {
    appRoot: "",
    appName: "stub",
    machineId: "stub-machine",
    openExternal: async () => true,
  },
  // ---- 测试钩子 ----
  __fireOnUpdate: false,
  __defaults: defaults,
  __setConfig(key, value, target) {
    const fk = normalizeKey(key);
    const t = targetOf(target);
    if (value === undefined) {
      scopes[t].delete(fk);
    } else {
      scopes[t].set(fk, clone(value));
    }
  },
  __getConfig(key) {
    return clone(effective(normalizeKey(key)));
  },
  __resetConfig() {
    for (const t of [1, 2, 3]) {
      scopes[t].clear();
    }
  },
  __fireConfigChange(keys) {
    fire((Array.isArray(keys) ? keys : [keys]).map(normalizeKey));
  },
  __outputLines() {
    return outputLines.slice();
  },
  __clearOutput() {
    outputLines.length = 0;
  },
  __messages() {
    return messages.slice();
  },
  __makeContext(opts) {
    const o = opts || {};
    const packageJSON = JSON.parse(JSON.stringify(pkg));
    if (o.version) {
      packageJSON.version = o.version;
    }
    const storage = o.storageDir || fs.mkdtempSync(path.join(os.tmpdir(), "a2kd-ctx-"));
    const ctx = {
      subscriptions: [],
      globalState: new Memento(),
      workspaceState: new Memento(),
      extension: { id: `${pkg.publisher}.${pkg.name}`, packageJSON },
      extensionPath: root,
      extensionUri: Uri.file(root),
      globalStorageUri: Uri.file(storage),
      storageUri: Uri.file(storage),
      logUri: Uri.file(storage),
      extensionMode: 3,
      asAbsolutePath: (p) => path.join(root, p),
    };
    if (o.secrets) {
      ctx.secrets = new SecretStorage();
    }
    return ctx;
  },
};

module.exports = stub;
