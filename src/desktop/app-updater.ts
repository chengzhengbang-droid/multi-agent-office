export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  error?: string;
}

interface UpdateInfoLike {
  version: string;
}

interface ProgressInfoLike {
  percent: number;
}

interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

type UpdateEvent =
  | "checking-for-update"
  | "update-not-available"
  | "update-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface UpdateClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  logger: UpdaterLogger | null;
  on(event: UpdateEvent, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface AppUpdaterControllerOptions {
  updater: UpdateClient;
  currentVersion: string;
  onStateChange(state: AppUpdateState): void;
  log(message: string): void;
  askToDownload(version: string): Promise<boolean>;
  askToInstall(version: string): Promise<boolean>;
  showNoUpdate(version: string): Promise<void>;
  showError(message: string): Promise<void>;
  prepareToInstall(): void;
}

export interface UpdateMenuPresentation {
  label: string;
  enabled: boolean;
}

export function updateMenuPresentation(
  state: AppUpdateState | undefined,
  supported: boolean,
): UpdateMenuPresentation {
  if (!supported || !state) return { label: "检查更新…", enabled: true };
  switch (state.phase) {
    case "checking":
      return { label: "正在检查更新…", enabled: false };
    case "available":
      return {
        label: `下载更新 v${state.latestVersion ?? ""}`,
        enabled: true,
      };
    case "downloading":
      return {
        label: `正在下载更新 ${Math.round(state.percent ?? 0)}%`,
        enabled: false,
      };
    case "downloaded":
      return {
        label: `重启并安装 v${state.latestVersion ?? ""}`,
        enabled: true,
      };
    case "error":
    case "idle":
      return { label: "检查更新…", enabled: true };
  }
}

export class AppUpdaterController {
  private readonly updater: UpdateClient;
  private readonly options: AppUpdaterControllerOptions;
  private checkingWasManual = false;
  private showOperationErrors = false;
  private dismissedVersion: string | undefined;
  private promptOpen = false;
  private initialTimer: NodeJS.Timeout | undefined;
  private intervalTimer: NodeJS.Timeout | undefined;
  private lastProgress = -1;
  private installing = false;

  state: AppUpdateState;

  constructor(options: AppUpdaterControllerOptions) {
    this.options = options;
    this.updater = options.updater;
    this.state = {
      phase: "idle",
      currentVersion: options.currentVersion,
    };
  }

  initialize(): void {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.logger = {
      info: (message) => this.options.log(`Updater: ${String(message)}`),
      warn: (message) => this.options.log(`Updater warning: ${String(message)}`),
      error: (message) => this.options.log(`Updater error: ${String(message)}`),
    };
    this.updater.on("checking-for-update", () => {
      this.setState({ phase: "checking" });
    });
    this.updater.on("update-not-available", (info) => {
      const update = info as UpdateInfoLike;
      void this.handleNoUpdate(update);
    });
    this.updater.on("update-available", (info) => {
      const update = info as UpdateInfoLike;
      void this.handleAvailable(update);
    });
    this.updater.on("download-progress", (info) => {
      const progress = info as ProgressInfoLike;
      this.handleProgress(progress);
    });
    this.updater.on("update-downloaded", (info) => {
      const update = info as UpdateInfoLike;
      void this.handleDownloaded(update);
    });
    this.updater.on("error", (error) => {
      void this.handleError(error);
    });
    this.options.onStateChange(this.state);
  }

  scheduleBackgroundChecks(
    initialDelayMs = 30_000,
    intervalMs = 6 * 60 * 60 * 1_000,
  ): void {
    this.initialTimer = setTimeout(() => {
      void this.checkForUpdates(false);
      this.intervalTimer = setInterval(() => {
        void this.checkForUpdates(false);
      }, intervalMs);
      this.intervalTimer.unref();
    }, initialDelayMs);
    this.initialTimer.unref();
  }

  async performMenuAction(): Promise<void> {
    if (this.state.phase === "available") {
      await this.downloadUpdate();
      return;
    }
    if (this.state.phase === "downloaded") {
      this.installUpdate();
      return;
    }
    await this.checkForUpdates(true);
  }

  async checkForUpdates(manual: boolean): Promise<void> {
    if (
      this.state.phase === "checking" ||
      this.state.phase === "available" ||
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded"
    ) {
      return;
    }
    this.checkingWasManual = manual;
    this.showOperationErrors = manual;
    this.setState({ phase: "checking" });
    this.options.log(
      `${manual ? "Manual" : "Background"} update check started`,
    );
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      if (this.state.phase !== "error") await this.handleError(error);
    }
  }

  dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }

  private async handleNoUpdate(info: UpdateInfoLike): Promise<void> {
    const wasManual = this.checkingWasManual;
    this.checkingWasManual = false;
    this.showOperationErrors = false;
    this.options.log(`No update available; latest version is ${info.version}`);
    this.setState({ phase: "idle" });
    if (wasManual) await this.options.showNoUpdate(this.state.currentVersion);
  }

  private async handleAvailable(info: UpdateInfoLike): Promise<void> {
    const wasManual = this.checkingWasManual;
    this.checkingWasManual = false;
    this.showOperationErrors = false;
    this.options.log(`Update ${info.version} is available`);
    this.setState({ phase: "available", latestVersion: info.version });
    if (this.promptOpen) return;
    if (!wasManual && this.dismissedVersion === info.version) return;
    this.promptOpen = true;
    let shouldDownload = false;
    try {
      shouldDownload = await this.options.askToDownload(info.version);
      if (!shouldDownload) {
        this.dismissedVersion = info.version;
      }
    } finally {
      this.promptOpen = false;
    }
    if (shouldDownload) await this.downloadUpdate();
  }

  private async downloadUpdate(): Promise<void> {
    if (this.state.phase === "downloading" || this.state.phase === "downloaded") {
      return;
    }
    const latestVersion = this.state.latestVersion;
    if (!latestVersion) return;
    this.lastProgress = -1;
    this.showOperationErrors = true;
    this.setState({ phase: "downloading", latestVersion, percent: 0 });
    this.options.log(`Downloading update ${latestVersion}`);
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      if (this.state.phase !== "error") await this.handleError(error);
    }
  }

  private handleProgress(info: ProgressInfoLike): void {
    const latestVersion = this.state.latestVersion;
    if (!latestVersion) return;
    const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
    if (percent === this.lastProgress) return;
    this.lastProgress = percent;
    this.setState({
      phase: "downloading",
      latestVersion,
      percent,
    });
  }

  private async handleDownloaded(info: UpdateInfoLike): Promise<void> {
    this.showOperationErrors = false;
    this.options.log(`Update ${info.version} downloaded and ready to install`);
    this.setState({ phase: "downloaded", latestVersion: info.version });
    if (this.promptOpen) return;
    this.promptOpen = true;
    try {
      if (await this.options.askToInstall(info.version)) this.installUpdate();
    } finally {
      this.promptOpen = false;
    }
  }

  private installUpdate(): void {
    if (this.installing || this.state.phase !== "downloaded") return;
    this.installing = true;
    this.options.log(`Installing update ${this.state.latestVersion ?? ""}`);
    this.options.prepareToInstall();
    this.updater.quitAndInstall(true, true);
  }

  private async handleError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const shouldShow = this.showOperationErrors || this.checkingWasManual;
    this.checkingWasManual = false;
    this.showOperationErrors = false;
    this.options.log(`Update operation failed: ${message}`);
    this.setState({ phase: "error", error: message });
    if (shouldShow) await this.options.showError(message);
  }

  private setState(
    next: Pick<AppUpdateState, "phase"> &
      Partial<Omit<AppUpdateState, "phase" | "currentVersion">>,
  ): void {
    this.state = {
      currentVersion: this.state.currentVersion,
      ...next,
    };
    this.options.onStateChange(this.state);
  }
}
