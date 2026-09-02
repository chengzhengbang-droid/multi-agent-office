import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  Tray,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
} from "electron";
import electronUpdater from "electron-updater";
import {
  AppUpdaterController,
  appUpdateSupport,
  updateMenuPresentation,
  type AppUpdateState,
  type UpdateClient,
} from "./desktop/app-updater.js";
import {
  describeGraphicsMode,
  GRAPHICS_MODE_FILE,
  graphicsModeSwitches,
  nextGraphicsMode,
  parseGraphicsMode,
  readGraphicsModeState,
  resolveGraphicsMode,
  writeGraphicsModeState,
  type GraphicsMode,
} from "./desktop/graphics-mode.js";
import {
  isDeveloperIdSignedMacApp,
  macApplicationBundlePath,
} from "./desktop/mac-signature.js";
import {
  DESKTOP_UPDATE_GET_STATE,
  DESKTOP_UPDATE_PERFORM_ACTION,
  DESKTOP_UPDATE_STATE_CHANGED,
  type DesktopUpdateSnapshot,
} from "./desktop/update-contract.js";
import {
  APP_NAME,
  migrateLegacyUserData,
  selectUserDataDirectory,
} from "./desktop/user-data.js";

const CONFIG_TEMPLATE = `# Multi-Agent Office local configuration
# Keep this file private. Restart the app after changing it.
# The first-start screen fills these values for you.

# Z.AI / GLM Coding Plan (mainland China)
ZAI_CODING_CN_API_KEY=
MAO_PI_PROVIDER=zai-coding-cn
MAO_PI_MODEL=glm-5.2
MAO_PI_THINKING=medium
MAO_DEFAULT_AGENT=pi
MAO_SETUP_COMPLETED=0

# Alternative providers (uncomment and update MAO_PI_PROVIDER / MAO_PI_MODEL above)
# ZAI_API_KEY=
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=

# Codex Agents use a locally installed Codex CLI. An absolute path is safest.
# MAO_CODEX_COMMAND=/absolute/path/to/codex

# Maximum concurrent read-only Agent runs.
MAO_MAX_PARALLEL_READ_RUNS=4

# Composer opens in plan mode (read-only, plan first). Set to off to start in
# ordinary execution mode.
MAO_PLAN_MODE_DEFAULT=on
`;

const LOADING_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Multi-Agent Office</title><style>
html,body{height:100%;margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f5f1e8;color:#3f3a33;display:flex;align-items:center;justify-content:center}
main{text-align:center}
.spinner{width:36px;height:36px;border:3px solid #d8d0c0;border-top-color:#7a6f5d;border-radius:50%;margin:0 auto 16px;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
h1{font-size:18px;font-weight:600;margin:0 0 8px}
p{font-size:13px;margin:0;color:#6f675a}
</style></head><body><main><div class="spinner"></div><h1>Multi-Agent Office 正在启动</h1><p>正在启动本地服务，首次启动或磁盘较慢时可能需要一分钟左右…</p></main></body></html>`;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let serverUrl: string | undefined;
let quitting = false;
let fatalErrorShown = false;
let desktopPaths: DesktopPaths | undefined;
let desktopUpdater: AppUpdaterController | undefined;
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const isSmokeTest = process.argv.includes("--smoke-test");
const isWindowSmokeTest = process.argv.includes("--smoke-test-window");
const RELEASE_DOWNLOAD_URL =
  "https://github.com/chengzhengbang-droid/multi-agent-office/releases/latest";
const macDeveloperIdSigned =
  !isMac ||
  !app.isPackaged ||
  isDeveloperIdSignedMacApp(macApplicationBundlePath(process.execPath));
const updateSupport = appUpdateSupport(
  process.platform,
  app.isPackaged,
  macDeveloperIdSigned,
);
const automaticUpdatesSupported = updateSupport.supported;
const manualUpdateUrl = updateSupport.manualDownloadAvailable
  ? RELEASE_DOWNLOAD_URL
  : undefined;
const appDataRoot = app.getPath("appData");
const userDataDirectory = selectUserDataDirectory(appDataRoot, process.argv);
mkdirSync(userDataDirectory.path, { recursive: true });
app.setName(APP_NAME);
app.setPath("userData", userDataDirectory.path);
const desktopLogPath = join(userDataDirectory.path, "desktop.log");

// Graphics mode is decided before anything is drawn: the switches it appends
// only take effect while the application is not ready yet.
const graphicsStatePath = join(userDataDirectory.path, GRAPHICS_MODE_FILE);
const graphicsOverride = parseGraphicsMode(process.argv, process.env);
const graphicsDecision = resolveGraphicsMode(
  readGraphicsModeState(graphicsStatePath),
  graphicsOverride,
);
const graphicsMode = graphicsDecision.mode;
let graphicsModeConfirmed = graphicsDecision.overridden;
let graphicsRestartScheduled = false;
applyGraphicsMode(graphicsMode);

// A double-click on the shortcut must never be silently swallowed: any crash the
// launcher itself did not anticipate is logged and surfaced before exiting.
process.on("uncaughtException", (error) => {
  void reportFatalError("Uncaught exception", error, true);
});
process.on("unhandledRejection", (reason) => {
  void reportFatalError("Unhandled rejection", reason, false);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
// Only the instance that owns the window records graphics attempts; a second
// double-click must not leave a trial marker behind for the running one.
if (hasSingleInstanceLock) beginGraphicsModeTrial();
else graphicsModeConfirmed = true;

app.on("second-instance", () => {
  showMainWindow();
});

// A GPU process that dies on its own is the failure this launcher recovers
// from: Electron kills the whole application after a handful of those.
app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") return;
  recoverFromGraphicsFailure(
    `GPU process gone (${details.reason}, exit ${details.exitCode})`,
  );
});

app.on("before-quit", () => {
  quitting = true;
  confirmGraphicsMode();
  desktopUpdater?.dispose();
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isWindows) app.quit();
});

app.on("activate", () => {
  showMainWindow();
});

ipcMain.handle(DESKTOP_UPDATE_GET_STATE, (event) => {
  assertTrustedUpdateSender(event.sender);
  return desktopUpdateSnapshot();
});

ipcMain.handle(DESKTOP_UPDATE_PERFORM_ACTION, async (event) => {
  assertTrustedUpdateSender(event.sender);
  await handleUpdateMenuAction();
  return desktopUpdateSnapshot();
});

if (hasSingleInstanceLock) {
  void app.whenReady().then(startDesktopApp).catch(async (error: unknown) => {
    await writeDesktopLog(`Desktop startup failed: ${errorStack(error)}`);
    await dialog.showMessageBox({
      type: "error",
      title: "Multi-Agent Office 启动失败",
      message: errorMessage(error),
      detail: `请查看运行日志：${desktopLogPath}`,
    });
    app.quit();
  });
}

async function startDesktopApp(): Promise<void> {
  if (isWindows) app.setAppUserModelId("com.multiagentoffice.desktop");
  const userDataRoot = userDataDirectory.path;
  const dataRoot = join(userDataRoot, "data");
  const configPath = join(userDataRoot, "config.env");
  const logPath = desktopLogPath;
  if (!userDataDirectory.overridden) {
    try {
      const migrated = await migrateLegacyUserData(appDataRoot, userDataRoot);
      if (migrated.length > 0) {
        await writeDesktopLog(
          `Migrated legacy user data: ${migrated.join(", ")}`,
        );
      }
    } catch (error) {
      await writeDesktopLog(
        `Legacy user data migration failed: ${errorStack(error)}`,
      );
    }
  }
  await writeDesktopLog(
    `Desktop launcher starting (graphics mode: ${graphicsMode})`,
  );
  await ensureConfigFile(configPath);
  await mkdir(dataRoot, { recursive: true });

  // Show feedback immediately: the local server may need a while on a cold
  // disk or behind antivirus scanning, and an invisible launch reads as "the
  // app does not start" on end-user machines.
  if (!isSmokeTest) mainWindow = createMainWindow();

  const port = await findAvailablePort();
  serverUrl = `http://127.0.0.1:${port}`;
  serverProcess = startServerProcess({
    port,
    configPath,
    dataRoot,
    logPath,
  });
  await waitForServer(serverUrl, serverProcess);
  await writeDesktopLog(`Local server ready at ${serverUrl}`);

  if (isSmokeTest) {
    app.quit();
    return;
  }

  desktopPaths = { configPath, dataRoot, logPath };
  installApplicationMenu(desktopPaths);
  if (isWindows) installWindowsTray(desktopPaths);
  await writeDesktopLog(
    `Update support: ${updateSupport.reason}${manualUpdateUrl ? "; manual download fallback enabled" : ""}`,
  );
  if (!isWindowSmokeTest) initializeDesktopUpdater();
  const window = mainWindow ?? createMainWindow();
  mainWindow = window;
  void window.loadURL(serverUrl);
  if (isWindowSmokeTest) {
    await waitForMainWindow(window, serverUrl);
    await writeDesktopLog("Main window ready");
    app.quit();
  }
}

function startServerProcess(input: {
  port: number;
  configPath: string;
  dataRoot: string;
  logPath: string;
}): ChildProcessWithoutNullStreams {
  const appRoot = app.getAppPath();
  const entryPath = join(appRoot, "dist", "src", "server.js");
  const log = createWriteStream(input.logPath, { flags: "a" });
  const child = spawn(process.execPath, [entryPath], {
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: desktopPath(),
      PORT: String(input.port),
      MAO_APP_ROOT: appRoot,
      MAO_CONFIG_FILE: input.configPath,
      MAO_DATA_DIR: input.dataRoot,
      MAO_DEFAULT_WORKSPACE: app.getPath("documents"),
      MAO_WEB_ROOT: join(appRoot, "dist-web"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  log.write(`\n[${new Date().toISOString()}] Starting local server\n`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("exit", (code, signal) => {
    log.write(
      `[${new Date().toISOString()}] Server exited (${code ?? signal ?? "unknown"})\n`,
    );
    log.end();
    if (!quitting) {
      void dialog.showMessageBox({
        type: "error",
        title: "本地服务已停止",
        message: "Multi-Agent Office 的本地服务意外退出。",
        detail: `退出状态：${code ?? signal ?? "unknown"}\n日志：${input.logPath}`,
      });
    }
  });
  return child;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Multi-Agent Office",
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#f5f1e8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(
        app.getAppPath(),
        "dist",
        "src",
        "desktop",
        "preload.js",
      ),
    },
  });
  window.once("ready-to-show", () => {
    // A visible window is the proof that this graphics mode works on this
    // machine, so the next launch can start in the very same mode.
    confirmGraphicsMode();
    window.show();
  });
  window.on("close", (event) => {
    // On Windows the tray owns the lifecycle: closing the window hides it and
    // keeps the local server running, matching the documented behavior.
    if (isWindows && !quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!serverUrl || !target.startsWith(serverUrl)) event.preventDefault();
  });
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_PAGE)}`,
  );
  return window;
}

function showMainWindow(): void {
  let window = mainWindow;
  if (!window || window.isDestroyed()) {
    if (!serverUrl) return;
    window = createMainWindow();
    mainWindow = window;
    void window.loadURL(serverUrl);
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function waitForMainWindow(
  window: BrowserWindow,
  url: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      !window.isDestroyed() &&
      window.webContents.getURL().startsWith(url) &&
      !window.webContents.isLoadingMainFrame()
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error("等待主窗口加载超时");
}

async function openFrontendInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url);
  } catch (error) {
    await writeDesktopLog(`Could not open the default browser: ${errorStack(error)}`);
    await dialog.showMessageBox({
      type: "error",
      title: "无法打开浏览器",
      message: "Multi-Agent Office 已启动，但无法打开系统默认浏览器。",
      detail: `请手动打开：${url}`,
    });
  }
}

interface DesktopPaths {
  configPath: string;
  dataRoot: string;
  logPath: string;
}

function installWindowsTray(paths: DesktopPaths): void {
  if (!tray) {
    tray = new Tray(join(app.getAppPath(), "build", "icon.png"));
    tray.on("double-click", () => showMainWindow());
  }
  tray.setToolTip(updateTrayTooltip(desktopUpdater?.state));
  const updateItem = updateMenuPresentation(
    desktopUpdater?.state,
    automaticUpdatesSupported,
    Boolean(manualUpdateUrl),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Multi-Agent Office",
        click: () => showMainWindow(),
      },
      {
        label: "在默认浏览器中打开",
        click: () => {
          if (serverUrl) void openFrontendInBrowser(serverUrl);
        },
      },
      { type: "separator" },
      {
        label: "打开 config.env",
        click: () => void openLocalFile(paths.configPath),
      },
      {
        label: "打开用户数据目录",
        click: () => void shell.openPath(paths.dataRoot),
      },
      {
        label: "打开运行日志",
        click: () => void openLocalFile(paths.logPath),
      },
      graphicsMenuItem(),
      { type: "separator" },
      {
        label: updateItem.label,
        enabled: updateItem.enabled,
        click: () => void handleUpdateMenuAction(),
      },
      {
        label: `当前版本 v${app.getVersion()}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
}

function installApplicationMenu(paths: DesktopPaths): void {
  const updateItem = updateMenuPresentation(
    desktopUpdater?.state,
    automaticUpdatesSupported,
    Boolean(manualUpdateUrl),
  );
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    {
      label: "配置",
      submenu: [
        {
          label: "打开 config.env",
          accelerator: "CmdOrCtrl+,",
          click: () => void openLocalFile(paths.configPath),
        },
        {
          label: "打开用户数据目录",
          click: () => void shell.openPath(paths.dataRoot),
        },
        {
          label: "打开运行日志",
          click: () => void openLocalFile(paths.logPath),
        },
        { type: "separator" },
        graphicsMenuItem(),
        {
          label: "重启以应用配置",
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: updateItem.label,
          enabled: updateItem.enabled,
          click: () => void handleUpdateMenuAction(),
        },
        { type: "separator" },
        {
          label: `当前版本 v${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function initializeDesktopUpdater(): void {
  if (!automaticUpdatesSupported || desktopUpdater) return;
  try {
    desktopUpdater = new AppUpdaterController({
      updater: electronUpdater.autoUpdater as unknown as UpdateClient,
      currentVersion: app.getVersion(),
      onStateChange: (state) => updateDesktopUpdateState(state),
      log: (message) => void writeDesktopLog(message),
      askToDownload: async (version) => {
        if (quitting) return false;
        const result = await showDesktopMessage({
          type: "info",
          title: "发现新版本",
          message: `Multi-Agent Office v${version} 已发布`,
          detail: `当前版本为 v${app.getVersion()}。下载完成后可以直接重启安装，现有配置、Agent 和任务记录都会保留。`,
          buttons: ["下载更新", "稍后"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
      askToInstall: async (version) => {
        if (quitting) return false;
        const result = await showDesktopMessage({
          type: "info",
          title: "更新已下载",
          message: `v${version} 已准备好安装`,
          detail:
            "立即安装会重启应用并停止当前正在运行的 Agent 任务。选择稍后时，更新会在退出应用时自动安装。",
          buttons: ["立即重启并安装", "退出应用时安装"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
      showNoUpdate: async (version) => {
        if (quitting) return;
        await showDesktopMessage({
          type: "info",
          title: "检查更新",
          message: "当前已是最新版本",
          detail: `Multi-Agent Office v${version}`,
          buttons: ["确定"],
          defaultId: 0,
          noLink: true,
        });
      },
      showError: async (message) => {
        if (quitting) return;
        await showDesktopMessage({
          type: "error",
          title: "更新失败",
          message: "无法完成更新操作",
          detail: `${message}\n\n详细信息已写入：${desktopLogPath}`,
          buttons: ["确定"],
          defaultId: 0,
          noLink: true,
        });
      },
      prepareToInstall: () => {
        quitting = true;
        desktopUpdater?.dispose();
        stopServer();
        void writeDesktopLog("Stopping local server before update installation");
      },
    });
    desktopUpdater.initialize();
    desktopUpdater.scheduleBackgroundChecks();
    void writeDesktopLog("Automatic updater initialized");
  } catch (error) {
    void writeDesktopLog(`Could not initialize automatic updater: ${errorStack(error)}`);
  }
}

async function handleUpdateMenuAction(): Promise<void> {
  if (desktopUpdater) {
    await desktopUpdater.performMenuAction();
    return;
  }
  if (manualUpdateUrl) {
    const unsignedMac = updateSupport.reason === "unsigned-macos";
    const result = await showDesktopMessage({
      type: "warning",
      title: "手动下载更新",
      message: unsignedMac
        ? "此 macOS 安装包无法执行自动更新"
        : "当前系统需要手动下载安装更新",
      detail: unsignedMac
        ? "当前应用没有有效的 Developer ID 签名。请从 GitHub Releases 手动安装下一版已签名安装包；完成这次迁移后，应用内自动更新即可恢复。"
        : "请从 GitHub Releases 下载适合当前系统的最新安装包。",
      buttons: ["打开下载页", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      try {
        await shell.openExternal(manualUpdateUrl);
      } catch (error) {
        await writeDesktopLog(
          `Could not open release download page: ${errorStack(error)}`,
        );
        await showDesktopMessage({
          type: "error",
          title: "无法打开下载页",
          message: "请在浏览器中手动打开 GitHub Releases",
          detail: manualUpdateUrl,
          buttons: ["确定"],
          defaultId: 0,
          noLink: true,
        });
      }
    }
    return;
  }
  const detail = app.isPackaged
    ? "当前安装包没有可用的自动更新通道。"
    : "源码开发模式不会连接发布更新服务；请在 Windows 或 macOS 安装版中使用此功能。";
  await showDesktopMessage({
    type: "info",
    title: "检查更新",
    message: "当前运行方式不支持自动更新",
    detail,
    buttons: ["确定"],
    defaultId: 0,
    noLink: true,
  });
}

function updateDesktopUpdateState(state: AppUpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(
      state.phase === "downloading" ? (state.percent ?? 0) / 100 : -1,
    );
    mainWindow.webContents.send(
      DESKTOP_UPDATE_STATE_CHANGED,
      desktopUpdateSnapshot(state),
    );
  }
  refreshDesktopMenus();
}

function desktopUpdateSnapshot(
  state: AppUpdateState = desktopUpdater?.state ?? {
    phase: "idle",
    currentVersion: app.getVersion(),
  },
): DesktopUpdateSnapshot {
  return {
    mode: "desktop",
    platform: process.platform,
    packaged: app.isPackaged,
    supported: automaticUpdatesSupported,
    supportReason: updateSupport.reason,
    manualDownloadUrl: manualUpdateUrl,
    state,
  };
}

function assertTrustedUpdateSender(sender: Electron.WebContents): void {
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents) {
    throw new Error("拒绝来自未知窗口的更新请求");
  }
}

function refreshDesktopMenus(): void {
  if (!desktopPaths) return;
  installApplicationMenu(desktopPaths);
  if (isWindows && tray) installWindowsTray(desktopPaths);
}

function updateTrayTooltip(state: AppUpdateState | undefined): string {
  if (state?.phase === "downloading") {
    return `Multi-Agent Office · 正在下载更新 ${Math.round(state.percent ?? 0)}%`;
  }
  if (state?.phase === "downloaded") {
    return `Multi-Agent Office · v${state.latestVersion ?? ""} 等待安装`;
  }
  return "Multi-Agent Office";
}

function showDesktopMessage(options: MessageBoxOptions) {
  const window = mainWindow;
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options);
}

async function ensureConfigFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  await writeFile(path, CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600 });
}

async function openLocalFile(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) shell.showItemInFolder(path);
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForServer(
  url: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  // Slow disks and antivirus scans can make the first server start take tens
  // of seconds; the loading window keeps the user informed meanwhile.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("本地服务在启动完成前退出，请查看 desktop.log");
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error("等待本地服务启动超时（120 秒），请查看 desktop.log");
}

function desktopPath(): string {
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.APPDATA ?? "", "npm"),
          join(process.env.LOCALAPPDATA ?? "", "Programs", "codex"),
        ]
      : [
          join(homedir(), ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ];
  return [...candidates.filter(Boolean), process.env.PATH ?? ""].join(delimiter);
}

function applyGraphicsMode(mode: GraphicsMode): void {
  const switches = graphicsModeSwitches(mode);
  if (switches.length === 0) return;
  app.disableHardwareAcceleration();
  for (const name of switches) app.commandLine.appendSwitch(name);
}

function beginGraphicsModeTrial(): void {
  if (graphicsDecision.escalatedFrom) {
    writeDesktopLogSync(
      `Previous launch in ${graphicsDecision.escalatedFrom} graphics mode never showed a window; starting in ${graphicsMode} mode`,
    );
  }
  if (graphicsDecision.overridden) {
    writeDesktopLogSync(`Graphics mode forced to ${graphicsMode}`);
    return;
  }
  // Written before the first window exists: a launch that dies in between is
  // exactly the one the next start has to escalate away from.
  writeGraphicsModeState(graphicsStatePath, {
    mode: graphicsMode,
    pending: true,
    ...(graphicsDecision.escalatedFrom
      ? { reason: `escalated from ${graphicsDecision.escalatedFrom}` }
      : {}),
  });
}

function confirmGraphicsMode(): void {
  if (graphicsModeConfirmed) return;
  graphicsModeConfirmed = true;
  writeGraphicsModeState(graphicsStatePath, {
    mode: graphicsMode,
    pending: false,
    ...(graphicsDecision.escalatedFrom
      ? { reason: `escalated from ${graphicsDecision.escalatedFrom}` }
      : {}),
  });
}

function recoverFromGraphicsFailure(reason: string): void {
  if (graphicsRestartScheduled || !hasSingleInstanceLock) return;
  writeDesktopLogSync(`Graphics failure in ${graphicsMode} mode: ${reason}`);
  const escalated = nextGraphicsMode(graphicsMode);
  if (graphicsDecision.overridden || !escalated) return;
  graphicsRestartScheduled = true;
  const windowAlreadyShown = graphicsModeConfirmed;
  graphicsModeConfirmed = true;
  writeGraphicsModeState(graphicsStatePath, {
    mode: escalated,
    pending: false,
    reason,
  });
  if (windowAlreadyShown) {
    // Chromium survives an occasional GPU crash once the window is up; taking a
    // working session away from the user would be worse than the crash itself.
    writeDesktopLogSync(`Next launch will use ${escalated} graphics mode`);
    return;
  }
  writeDesktopLogSync(`Restarting in ${escalated} graphics mode`);
  quitting = true;
  stopServer();
  // Electron aborts the whole application once the GPU process has failed a few
  // times, so the restart has to happen now rather than after an async quit.
  app.relaunch();
  app.exit(0);
}

function restartWithGraphicsMode(mode: GraphicsMode): void {
  graphicsModeConfirmed = true;
  writeGraphicsModeState(graphicsStatePath, {
    mode,
    pending: false,
    reason: "chosen from the menu",
  });
  quitting = true;
  app.relaunch();
  app.quit();
}

function graphicsMenuItem(): MenuItemConstructorOptions {
  const compatible = graphicsMode !== "hardware";
  return {
    label: compatible
      ? `图形兼容模式：${describeGraphicsMode(graphicsMode)}（点击恢复硬件加速并重启）`
      : "启用图形兼容模式并重启（画面显示异常时使用）",
    enabled: !graphicsDecision.overridden,
    click: () => restartWithGraphicsMode(compatible ? "hardware" : "software"),
  };
}

function stopServer(): void {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill("SIGTERM");
  serverProcess = undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error);
}

async function reportFatalError(
  kind: string,
  error: unknown,
  fatal: boolean,
): Promise<void> {
  // The failure is in the launcher, not in the graphics stack: keep the current
  // graphics mode instead of degrading it on the next launch.
  if (fatal) confirmGraphicsMode();
  await writeDesktopLog(`${kind}: ${errorStack(error)}`);
  if (!fatal) return;
  if (!fatalErrorShown) {
    fatalErrorShown = true;
    try {
      dialog.showErrorBox(
        "Multi-Agent Office 无法启动",
        `${errorMessage(error)}\n\n日志：${desktopLogPath}`,
      );
    } catch {
      // The dialog is best-effort; the log above is the source of truth.
    }
  }
  app.exit(1);
}

function writeDesktopLogSync(message: string): void {
  try {
    appendFileSync(
      desktopLogPath,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8",
    );
  } catch {
    // Logging must never prevent the desktop launcher from starting.
  }
}

async function writeDesktopLog(message: string): Promise<void> {
  try {
    await appendFile(
      desktopLogPath,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8",
    );
  } catch {
    // Logging must never prevent the desktop launcher from starting.
  }
}
