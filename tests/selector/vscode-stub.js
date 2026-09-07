// 最小 vscode stub：selectorStyle.ts 只用到 env.appRoot 与 window.createOutputChannel（经 log.ts）。
// appRoot 每次访问都读环境变量 A2K_TEST_APP_ROOT，测试用例可随时切换到不同的临时 Kiro 树。
"use strict";

const lines = [];

module.exports = {
  env: {
    get appRoot() {
      return process.env.A2K_TEST_APP_ROOT || "";
    },
  },
  window: {
    createOutputChannel() {
      return {
        appendLine(l) {
          lines.push(l);
        },
        show() {},
        dispose() {},
      };
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(_key, dflt) {
          return dflt;
        },
      };
    },
  },
  __logLines: lines,
};
