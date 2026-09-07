import * as vscode from "vscode";
import {
  CONFIG_NS,
  isEnabled,
  getPort,
  getCpsPort,
  getGroupHeaderStyle,
  initConfig,
  updateSetting,
} from "./config";
import { syncGroupHeaderStyle, triggerKiroModelRefresh, type StyleSyncResult } from "./selectorStyle";
import { checkForUpdate } from "./updateChecker";
import { getActiveProviders } from "./providers";
import { initLog, showLog, info, error } from "./log";
import { KrsProxyServer } from "./krsServer";
import { CpsProxyServer } from "./cpsServer";
import { applyOverrides, restoreAll, initEndpoints } from "./endpoints";
import { SidebarProvider } from "./sidebar";
import { clearLearned, initImagePolicy, learnedTextOnlyModels } from "./imagePolicy";
import { initModelCatalog } from "./modelCatalog";
import { flush as flushUsage, initUsageStore } from "./usageStore";
import { initPromptStore } from "./promptStore";
import { flushTokens, initTokenStore } from "./oauth/tokenStore";
import { setOAuthClientVersion } from "./oauth/vendors";
import { cancelAllLogins } from "./oauth";

let krsServer: KrsProxyServer | undefined;
let cpsServer: CpsProxyServer | undefined;
let krsPort = 0;
let cpsPort = 0;
let statusBar: vscode.StatusBarItem | undefined;
let sidebar: SidebarProvider | undefined;
let reloadPrompted = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog();
  initConfig(context);
  // 本地改动：endpoints 需要 globalState 来暂存被覆盖前的 workspace 端点原值。
  initEndpoints(context);
  // 学到的"纯文本模型"名单也落 globalState，重启后不必再被 400 一次。
  initImagePolicy(context);
  // 模型能力目录（models.dev）：后台异步拉取，不阻塞激活。
  initModelCatalog(context);
  // 本地用量账本（用量页数据源）。
  initUsageStore(context);
  context.subscriptions.push({ dispose: () => void flushUsage() });
  // 用户侧系统提示词（「提示词」页），翻译层每次请求读它注入 system。
  initPromptStore(context);
  // 第三方账号登录（Kimi / Codex / xAI / Antigravity / Anthropic）的 token：钥匙串里按 provider id 存，先于 provider 可用性判定加载。
  await initTokenStore(context);
  setOAuthClientVersion(String(context.extension.packageJSON.version || "0.0.0"));
  context.subscriptions.push({
    dispose: () => {
      cancelAllLogins();
      void flushTokens();
    },
  });
  info("activating, version", context.extension.packageJSON.version);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "api2kiroDual.focusSidebar";
  context.subscriptions.push(statusBar);

  sidebar = new SidebarProvider(context, () => ({ krsPort, cpsPort }));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  registerCommands(context);

  // 启动后静默查一次 GitHub 最新 Release（24h 一次、同版本不重复弹）；异步不阻塞激活，失败静默。
  void checkForUpdate(context, { manual: false });

  if (isEnabled()) {
    await startAndOverride(context, false);
    void syncGroupHeaderStyle(getGroupHeaderStyle()).then(afterStyleSync);
  } else {
    await restoreAll();
    void syncGroupHeaderStyle(false).then(notifyStyleSync);
    updateStatusBar();
  }

  // React to config changes. 回调串行执行：enabled 在 1 秒内 true→false→true 时，两个 async 回调
  // 交错会出现「stopServers 已跑完、晚到的 startAndOverride 又把端点劫持到无人监听的端口」。
  // 上一条没处理完，下一条就排队；处理器抛错只记日志，不让链断掉。
  const watcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(CONFIG_NS)) {
      return;
    }
    configChain = configChain.then(() => onConfigChanged(context, e)).catch((err) => error("config change handler failed:", (err as Error).message));
  });
  context.subscriptions.push(watcher);

  updateStatusBar();
}

/** onDidChangeConfiguration 处理链的尾巴；测试用它等待所有排队的回调跑完。 */
let configChain: Promise<void> = Promise.resolve();

export function _configChangesSettledForTest(): Promise<void> {
  return configChain;
}

async function onConfigChanged(context: vscode.ExtensionContext, e: vscode.ConfigurationChangeEvent): Promise<void> {
  if (e.affectsConfiguration(`${CONFIG_NS}.groupHeaderStyle`)) {
    void syncGroupHeaderStyle(isEnabled() && getGroupHeaderStyle()).then(afterStyleSync);
  }
  const enableChanged = e.affectsConfiguration(`${CONFIG_NS}.enabled`);
  if (enableChanged) {
    if (isEnabled()) {
      await startAndOverride(context, true);
      void syncGroupHeaderStyle(getGroupHeaderStyle()).then(notifyStyleSync);
    } else {
      await stopServers();
      const changed = await restoreAll();
      notifyStyleSync(await syncGroupHeaderStyle(false));
      updateStatusBar();
      if (changed) {
        promptReload("已关闭代理", "IDE 恢复官方原生外观");
      }
    }
  }
  // provider 注册表改动会改变对外广播的模型列表。先走通道 A（钩子强刷 Kiro 模型注册中心，聊天保留），
  // 成功就不打扰用户；只有钩子不可达 / 刷新失败才退回「重载窗口」提示。
  // 面板自写路径（sidebar.persist）已经对这次变更触发过一次通道 A，这里只拿它的结果、不再刷第二次；
  // 外部改动（手改 settings.json / Settings Sync）才由这里触发。
  // 不 await：Kiro 重拉列表要 1–3 秒，卡住配置回调链会让下一次勾选的 1.5 秒自写窗口过期，
  // 被误判成外部改动而多做一轮全量 /models 拉取。promptReload 自带 2 秒防抖，异步结算即可。
  const listAffecting = e.affectsConfiguration(`${CONFIG_NS}.providers`);
  if (listAffecting && !enableChanged && isEnabled()) {
    const pending = sidebar?.channelAResult() ?? triggerKiroModelRefresh();
    void pending.then((refreshed) => {
      if (!refreshed) {
        promptReload("已更新 provider");
      }
    });
  }
  updateStatusBar();
  // 面板自己刚写的 settings 会立刻触发本回调。它已经按需刷过了（勾选走轻量、改
  // 地址走全量），这里再来一轮全量会白白多拉一次所有 provider 的 /models + 两次用量。
  // 只有外部改动（用户手改 settings.json / Settings Sync）才需要我们全量同步。
  if (sidebar?.isSelfWrite()) {
    sidebar.postDerived();
  } else {
    sidebar?.postAll();
  }
}

export async function deactivate(): Promise<void> {
  await stopServers();
  // 宿主关闭（Reload Window / 换工作区 / 关 Kiro / 停用扩展）：三份 Kiro 文件一律不动。
  // kiro-agent 是本扩展的 extensionDependencies，同宿主里总比本扩展早激活并加载磁盘上的 style.css /
  // mermaid chunk / dist/extension.js；在这里还原过，新宿主里它必然读到出厂文件，等本扩展 5 秒后重打补丁
  // 时 webview 已经拿着出厂 CSS、懒加载的 mermaid 却是补丁版——就是 2026-09-07 实拍的「有结构没样式」
  // 弹层与 `SSnaillmou9` 组头，后端钩子也永远「不可达」（每次 Reload 前一行 restored …，13 次 Channel A 全败）。
  // 还原只走用户动作：关闭代理 / 关闭卡片样式（onConfigChanged 完整还原并提示重载）、代理关闭状态下激活（activate
  // 里 restoreAll + syncGroupHeaderStyle(false)）。停用 / 卸载扩展时文件保留补丁态：三处都只在有 CPS 私有
  // description 或 a2k 类名时改变外观，没有本扩展在跑时就是 Kiro 原生行为；卸载钩子还原在想法池待拍板。
  info("left Kiro selector / popover / backend patches untouched on host shutdown (next host loads what is on disk)");
  statusBar?.dispose();
}

/**
 * 激活 / 样式开关打开后的收尾：先做 unavailable 提示；若三份文件里任何一份是这一次才写进磁盘的（首次安装、
 * Kiro 升级替换了文件、或用户刚从关闭代理切回），当前宿主里的 kiro-agent 已经用出厂文件启动：webview 拿的是
 * 出厂 CSS / JS、后端读不到钩子，通道 A 在本次会话里必然「钩子不可达」——与其等用户第一次悬停或改模型时才发现，
 * 不如现在就说清楚要重载一次。重载后 deactivate 不再还原，新宿主里 kiro-agent 加载到补丁版文件，
 * 之后外观与静默刷新都不再需要任何提示。
 */
function afterStyleSync(result: StyleSyncResult): void {
  notifyStyleSync(result);
  const t = result.targets;
  if (t.style === "applied" || t.selectorScript === "applied" || t.backend === "applied") {
    promptReload("已写入 Kiro 外观补丁与模型刷新钩子", "Kiro 才会加载新外观，左侧改模型才会即时同步到右侧选择器");
  }
}

const styleSyncWarned = new Set<string>();

/**
 * Kiro 本体补丁写入 / 还原失败（只读、被占用、权限不足）或 Kiro 升级后靶点漂移时提示用户一次。
 * detail 为 ENOENT 表示根本不在 Kiro 里（普通 VS Code 宿主），不是故障，不提示。
 */
function notifyStyleSync(result: StyleSyncResult): void {
  if (result.status !== "unavailable" || !result.detail || /\bENOENT\b/.test(result.detail)) {
    return;
  }
  if (styleSyncWarned.has(result.detail)) {
    return;
  }
  styleSyncWarned.add(result.detail);
  error("selector patch sync unavailable:", result.detail);
  void vscode.window.showWarningMessage(
    `API4Kiro 未能同步 Kiro 选择器补丁（${result.detail}）。关闭代理或停用插件后请检查 Kiro 安装目录是否可写；重装 / 更新 Kiro 会恢复出厂文件。`
  );
}

async function startAndOverride(context: vscode.ExtensionContext, fromToggle: boolean): Promise<void> {
  try {
    krsPort = getPort();
    cpsPort = getCpsPort();
    if (!krsServer) {
      krsServer = new KrsProxyServer(context, krsPort, () => onOwnershipChanged());
      await krsServer.start();
    }
    if (!cpsServer) {
      cpsServer = new CpsProxyServer(cpsPort, () => onOwnershipChanged());
      await cpsServer.start();
    }
  } catch (e) {
    error("failed to start servers:", (e as Error).message);
    void vscode.window.showErrorMessage("API4Kiro 启动本地代理失败：" + (e as Error).message);
    updateStatusBar();
    return;
  }

  // 起服务器期间用户可能又把 enabled 关掉了（排队中的下一条回调会 stop + restore）：
  // 收尾前复核，别把端点劫持到一个马上就要停的服务器上。
  if (!isEnabled()) {
    info("enabled turned off while starting servers; skipping endpoint override");
    await stopServers();
    updateStatusBar();
    return;
  }

  // Warn only if a NON-API2Kiro-Dual process squats our ports (can't share).
  // 注意：原版 API2Kiro 默认用 19800/19801，本扩展用 19810/19811，正常不冲突；
  // 会走到这里说明端口被第三方程序（或改过端口的原版）占了。
  if (krsServer?.hadForeignConflict() || cpsServer?.hadForeignConflict()) {
    void vscode.window.showWarningMessage(
      `API4Kiro 端口 ${krsPort}/${cpsPort} 被其他程序占用，无法启动代理。请在设置里改用其它端口，或关闭占用程序。`
    );
  }

  // Endpoint overrides use FIXED ports, so every Kiro window writes the SAME
  // Global config — no clobbering. The first window to bind the ports serves
  // all windows; the rest are warm standbys that take over if it exits.
  let changed = false;
  try {
    changed = await applyOverrides(krsPort, cpsPort);
  } catch (e) {
    error("failed to override endpoints:", (e as Error).message);
  }

  updateStatusBar();
  sidebar?.postAll();

  if (changed || fromToggle) {
    promptReload("代理已启用");
  }
}

/** Called when this window's PortHolder gains ownership (a former owner exited). */
function onOwnershipChanged(): void {
  info("ownership changed; this window is now (or still) serving requests");
  updateStatusBar();
  sidebar?.postAll();
}

async function stopServers(): Promise<void> {
  if (krsServer) {
    await krsServer.stop();
    krsServer = undefined;
  }
  if (cpsServer) {
    await cpsServer.stop();
    cpsServer = undefined;
  }
}

let reloadTimer: NodeJS.Timeout | undefined;

/**
 * 提示重载窗口。做了防抖：勾选十个模型只弹一次，而不是十次；且在用户连续操作时
 * 一直后延，等他停手 2 秒再弹。之前每点一次复选框就立刻弹一条，通知自己就是
 * "响应慢"观感的一大来源。
 */
function promptReload(reason: string, effect = "Kiro 才会刷新模型列表"): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    if (reloadPrompted) {
      return;
    }
    reloadPrompted = true;
    void vscode.window
      .showInformationMessage(
        `${reason}。重载窗口后${effect}。`,
        "重新加载窗口",
        "稍后"
      )
      .then((choice) => {
        reloadPrompted = false;
        if (choice === "重新加载窗口") {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  }, 2000);
}

function updateStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const enabled = isEnabled();
  const active = getActiveProviders();
  const configured = active.length > 0;
  const owner = krsServer?.isOwner() || cpsServer?.isOwner();
  const foreign = krsServer?.hadForeignConflict() || cpsServer?.hadForeignConflict();
  const suffix = configured ? ` ${active.length}` : "";
  if (!enabled) {
    statusBar.text = "$(circle-slash) API4Kiro 关闭";
    statusBar.tooltip = "API4Kiro 代理已关闭，Kiro 使用官方服务（或原版 API2Kiro 的端点）";
  } else if (!configured) {
    statusBar.text = "$(warning) API4Kiro 未配置";
    statusBar.tooltip = "点击打开控制面板，添加并启用至少一个 provider";
  } else if (foreign) {
    statusBar.text = "$(error) API4Kiro 端口冲突";
    statusBar.tooltip = `端口 ${krsPort}/${cpsPort} 被其他程序占用，请更换端口`;
  } else if (owner) {
    statusBar.text = "$(rocket) API4Kiro" + suffix;
    statusBar.tooltip =
      `代理运行中（本窗口为主实例）· KRS ${krsPort} / CPS ${cpsPort}\n` +
      active.map((p) => `· ${p.name}（${p.protocol}）`).join("\n");
  } else {
    statusBar.text = "$(rocket) API4Kiro 待命" + suffix;
    statusBar.tooltip = `已连接到本机主实例 · KRS ${krsPort} / CPS ${cpsPort}（本窗口待命，主实例退出后自动接管）`;
  }
  statusBar.show();
}

function registerCommands(context: vscode.ExtensionContext): void {
  const warnIfFailed = (r: { settingsOk: boolean; error?: string }) => {
    if (!r.settingsOk) {
      void vscode.window.showErrorMessage(
        "API4Kiro 写入 Kiro 设置失败(已本地兜底):" + (r.error || "未知错误") +
          "。若代理不生效,请检查用户 settings.json 是否可写、格式是否正确。"
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("api2kiroDual.focusSidebar", () => {
      void vscode.commands.executeCommand("api2kiroDual.panel.focus");
    }),
    vscode.commands.registerCommand("api2kiroDual.refreshUsage", () => {
      void sidebar?.refresh();
    }),
    vscode.commands.registerCommand("api2kiroDual.openLog", () => showLog()),
    vscode.commands.registerCommand("api2kiroDual.clearTextOnlyModels", async () => {
      const list = learnedTextOnlyModels();
      if (list.length === 0) {
        vscode.window.showInformationMessage("API4Kiro：没有学习到的纯文本模型记录。");
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `清除 ${list.length} 条"不支持图片"记录？（${list.join(", ")}）\n之后这些模型再收到图片会重新照发，被拒绝时再学习。`,
        { modal: true },
        "清除"
      );
      if (ok === "清除") {
        await clearLearned();
        vscode.window.showInformationMessage("API4Kiro：已清除。");
      }
    }),
    vscode.commands.registerCommand("api2kiroDual.toggleEnabled", async () => {
      warnIfFailed(await updateSetting("enabled", !isEnabled()));
    }),
    vscode.commands.registerCommand("api2kiroDual.manageProviders", async () => {
      // provider 的增删改在侧边栏卡片里完成，这里只负责把面板打开。
      sidebar?.reveal();
      await vscode.commands.executeCommand("api2kiroDual.panel.focus");
    }),
    vscode.commands.registerCommand("api2kiroDual.refreshActiveSession", async (): Promise<boolean> => {
      // 通道 A：通过后端 setter 钩子暴露的 modelConfigProvider 强刷 Kiro 模型注册中心（聊天内容保留）。
      // 钩子不在（未与 kiro-agent 并组 / Kiro 未打补丁 / 尚未 Reload）时退回 focusChatInput 的软刷新，
      // 并把 false 返回给调用方（sidebar.persist → onConfigChanged 据此决定是否提示重载）。
      const refreshed = await triggerKiroModelRefresh();
      if (!refreshed) {
        try {
          await vscode.commands.executeCommand("kiroAgent.focusChatInput");
        } catch {
          // 静默兜底
        }
      }
      return refreshed;
    })
  );
}
