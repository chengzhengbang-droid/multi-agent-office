import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";

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
let desktopLogPath: string | undefined;
let quitting = false;
let fatalErrorShown = false;
const isWindows = process.platform === "win32";
const isSmokeTest = process.argv.includes("--smoke-test");

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

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  showMainWindow();
});

if (hasSingleInstanceLock) {
  void app.whenReady().then(startDesktopApp).catch(async (error: unknown) => {
    await writeDesktopLog(`Desktop startup failed: ${errorStack(error)}`);
    await dialog.showMessageBox({
      type: "error",
      title: "Multi-Agent Office 启动失败",
      message: errorMessage(error),
      detail: `请查看运行日志：${desktopLogPath ?? "用户数据目录中的 desktop.log"}`,
    });
    app.quit();
  });
}

async function startDesktopApp(): Promise<void> {
  app.setName("Multi-Agent Office");
  if (isWindows) app.setAppUserModelId("com.multiagentoffice.desktop");
  const userDataRoot = app.getPath("userData");
  const dataRoot = join(userDataRoot, "data");
  const configPath = join(userDataRoot, "config.env");
  const logPath = join(userDataRoot, "desktop.log");
  desktopLogPath = logPath;
  await writeDesktopLog("Desktop launcher starting");
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

  installApplicationMenu({ configPath, dataRoot, logPath });
  if (isWindows) installWindowsTray({ configPath, dataRoot, logPath });
  const window = mainWindow ?? createMainWindow();
  mainWindow = window;
  void window.loadURL(serverUrl);
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
    },
  });
  window.once("ready-to-show", () => window.show());
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

function installWindowsTray(paths: {
  configPath: string;
  dataRoot: string;
  logPath: string;
}): void {
  tray = new Tray(join(app.getAppPath(), "build", "icon.png"));
  tray.setToolTip("Multi-Agent Office");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Multi-Agent Office",
        click: () => showMainWindow(),
      },
      {
        label: "在浏览器中打开",
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
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("double-click", () => showMainWindow());
}

function installApplicationMenu(paths: {
  configPath: string;
  dataRoot: string;
  logPath: string;
}): void {
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
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  if (!desktopLogPath) {
    try {
      desktopLogPath = join(app.getPath("userData"), "desktop.log");
    } catch {
      // The log stays disabled when the user data directory is unavailable.
    }
  }
  await writeDesktopLog(`${kind}: ${errorStack(error)}`);
  if (!fatal) return;
  if (!fatalErrorShown) {
    fatalErrorShown = true;
    try {
      dialog.showErrorBox(
        "Multi-Agent Office 无法启动",
        `${errorMessage(error)}\n\n日志：${desktopLogPath ?? "(未创建)"}`,
      );
    } catch {
      // The dialog is best-effort; the log above is the source of truth.
    }
  }
  app.exit(1);
}

async function writeDesktopLog(message: string): Promise<void> {
  if (!desktopLogPath) return;
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
