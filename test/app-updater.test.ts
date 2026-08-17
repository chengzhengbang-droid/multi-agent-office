import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppUpdaterController,
  appUpdateSupport,
  updateMenuPresentation,
  type UpdateClient,
} from "../src/desktop/app-updater.js";
import { signatureDetailsIndicateDeveloperId } from "../src/desktop/mac-signature.js";

test("update support requires a packaged and Developer ID signed macOS app", () => {
  assert.deepEqual(appUpdateSupport("darwin", true, true), {
    supported: true,
    reason: "supported",
    manualDownloadAvailable: false,
  });
  assert.deepEqual(appUpdateSupport("darwin", true, false), {
    supported: false,
    reason: "unsigned-macos",
    manualDownloadAvailable: true,
  });
  assert.deepEqual(appUpdateSupport("darwin", false, false), {
    supported: false,
    reason: "development",
    manualDownloadAvailable: false,
  });
  assert.deepEqual(appUpdateSupport("linux", true), {
    supported: false,
    reason: "unsupported-platform",
    manualDownloadAvailable: true,
  });
});

test("Developer ID signature details reject ad-hoc macOS builds", () => {
  assert.equal(
    signatureDetailsIndicateDeveloperId(
      "Authority=Developer ID Application: Example Corp (ABCDE12345)\nTeamIdentifier=ABCDE12345",
    ),
    true,
  );
  assert.equal(
    signatureDetailsIndicateDeveloperId(
      "Signature=adhoc\nTeamIdentifier=not set",
    ),
    false,
  );
});

test("update menu describes each actionable updater state", () => {
  assert.deepEqual(updateMenuPresentation(undefined, false), {
    label: "检查更新…",
    enabled: true,
  });
  assert.deepEqual(updateMenuPresentation(undefined, false, true), {
    label: "手动下载更新…",
    enabled: true,
  });
  assert.deepEqual(
    updateMenuPresentation(
      { phase: "checking", currentVersion: "0.3.0" },
      true,
    ),
    { label: "正在检查更新…", enabled: false },
  );
  assert.deepEqual(
    updateMenuPresentation(
      {
        phase: "downloading",
        currentVersion: "0.3.0",
        latestVersion: "0.3.14",
        percent: 42.4,
      },
      true,
    ),
    { label: "正在下载更新 42%", enabled: false },
  );
  assert.deepEqual(
    updateMenuPresentation(
      {
        phase: "downloaded",
        currentVersion: "0.3.0",
        latestVersion: "0.3.14",
      },
      true,
    ),
    { label: "重启并安装 v0.3.14", enabled: true },
  );
});

test("manual update check reports when the installed version is current", async () => {
  const updater = new FakeUpdater();
  updater.checkResult = { event: "update-not-available", version: "0.3.0" };
  let noUpdateVersion = "";
  const controller = createController(updater, {
    showNoUpdate: async (version) => {
      noUpdateVersion = version;
    },
  });
  controller.initialize();

  await controller.performMenuAction();

  assert.equal(noUpdateVersion, "0.3.0");
  assert.equal(controller.state.phase, "idle");
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test("available update downloads, tracks progress, and can install later", async () => {
  const updater = new FakeUpdater();
  updater.checkResult = { event: "update-available", version: "0.3.14" };
  updater.downloadVersion = "0.3.14";
  let prepared = false;
  let installPromptVersion = "";
  const controller = createController(updater, {
    askToDownload: async () => true,
    askToInstall: async (version) => {
      installPromptVersion = version;
      return false;
    },
    prepareToInstall: () => {
      prepared = true;
    },
  });
  controller.initialize();

  await controller.performMenuAction();
  await waitFor(() => controller.state.phase === "downloaded");

  assert.equal(controller.state.latestVersion, "0.3.14");
  assert.equal(updater.downloadCalls, 1);
  assert.equal(updater.quitAndInstallCalls, 0);
  assert.equal(installPromptVersion, "0.3.14");

  await controller.performMenuAction();

  assert.equal(prepared, true);
  assert.equal(updater.quitAndInstallCalls, 1);
  assert.deepEqual(updater.lastInstallArguments, [true, true]);
});

type EventName = Parameters<UpdateClient["on"]>[0];

class FakeUpdater implements UpdateClient {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  logger = null;
  checkResult:
    | { event: "update-not-available" | "update-available"; version: string }
    | undefined;
  downloadVersion = "";
  downloadCalls = 0;
  quitAndInstallCalls = 0;
  lastInstallArguments: [boolean | undefined, boolean | undefined] | undefined;
  private readonly listeners = new Map<EventName, Array<(...args: unknown[]) => void>>();

  on(event: EventName, listener: (...args: unknown[]) => void): this {
    const registered = this.listeners.get(event) ?? [];
    registered.push(listener);
    this.listeners.set(event, registered);
    return this;
  }

  async checkForUpdates(): Promise<void> {
    if (this.checkResult) {
      this.emit(this.checkResult.event, { version: this.checkResult.version });
    }
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    this.emit("download-progress", { percent: 42.4 });
    this.emit("update-downloaded", { version: this.downloadVersion });
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls += 1;
    this.lastInstallArguments = [isSilent, isForceRunAfter];
  }

  private emit(event: EventName, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function createController(
  updater: FakeUpdater,
  overrides: Partial<{
    askToDownload(version: string): Promise<boolean>;
    askToInstall(version: string): Promise<boolean>;
    showNoUpdate(version: string): Promise<void>;
    prepareToInstall(): void;
  }> = {},
): AppUpdaterController {
  return new AppUpdaterController({
    updater,
    currentVersion: "0.3.0",
    onStateChange: () => undefined,
    log: () => undefined,
    askToDownload: overrides.askToDownload ?? (async () => false),
    askToInstall: overrides.askToInstall ?? (async () => false),
    showNoUpdate: overrides.showNoUpdate ?? (async () => undefined),
    showError: async (message) => assert.fail(message),
    prepareToInstall: overrides.prepareToInstall ?? (() => undefined),
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for updater state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
