import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpdateStatusState } from "../../state/update-status";
import { createUpdaterLifecycle } from "../updater";

const { notificationMock } = vi.hoisted(() => ({
  notificationMock: {
    on: vi.fn(),
    show: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  Notification: Object.assign(function Notification() {
    return notificationMock;
  }, {
    isSupported: vi.fn(() => true),
  }),
}));

function createLifecycle() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const updater = {
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    removeAllListeners: vi.fn(() => listeners.clear()),
  };
  const application = {
    isPackaged: false,
    getVersion: vi.fn(() => "0.13.0"),
    on: vi.fn(),
    removeListener: vi.fn(),
    quit: vi.fn(),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const windows = {
    getAllWindows: vi.fn(() => [window]),
    getFocusedWindow: vi.fn(() => null),
  };
  const timer = {
    setTimeout: vi.fn((callback: () => void) => setTimeout(callback, 10_000)),
    clearTimeout: vi.fn((handle: unknown) => clearTimeout(handle as NodeJS.Timeout)),
    setInterval: vi.fn((callback: () => void, delay: number) =>
      setInterval(callback, delay),
    ),
    clearInterval: vi.fn((handle: unknown) => clearInterval(handle as NodeJS.Timeout)),
    setImmediate: vi.fn((callback: () => void) => setImmediate(callback)),
  };
  const status = createUpdateStatusState(windows);
  const installation = {
    register: vi.fn(),
    cleanup: vi.fn(),
  };
  const lifecycle = createUpdaterLifecycle({
    updater,
    application,
    windows,
    timer,
    settings: vi.fn(() => ({
      releaseLine: "stable" as const,
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "never",
    })),
    status,
    installation,
  });
  lifecycle.initialize();
  return { lifecycle, updater, listeners, status, timer, installation };
}

describe("updater lifecycle", () => {
  let current: ReturnType<typeof createLifecycle>;

  afterEach(() => {
    current.lifecycle.cleanup();
  });

  it("publishes the updater event status contract", () => {
    current = createLifecycle();
    current.listeners.get("update-available")?.({
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    });
    expect(current.status.get()).toEqual({
      state: "available",
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    });

    current.listeners.get("download-progress")?.({
      percent: 42.4,
      bytesPerSecond: 1024,
    });
    expect(current.status.get()).toEqual({
      state: "downloading",
      percent: 42,
      bytesPerSecond: 1024,
    });

    current.listeners.get("update-downloaded")?.({
      version: "0.14.0",
      releaseNotes: [{ version: "0.14.0", note: "Bug fixes" }],
    });
    expect(current.status.get()).toEqual({
      state: "downloaded",
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    });
  });

  it("deduplicates concurrent manual checks", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );

    const first = current.lifecycle.checkForUpdatesNow();
    const second = current.lifecycle.checkForUpdatesNow();
    expect(second).toBe(first);
    resolveCheck?.();
    await expect(first).resolves.toEqual({ state: "checking" });
    expect(current.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("applies manual download errors to status", async () => {
    current = createLifecycle();
    current.listeners.get("update-available")?.({ version: "0.14.0" });
    current.updater.downloadUpdate.mockRejectedValueOnce(
      new Error("download failed"),
    );

    await current.lifecycle.downloadUpdate();

    expect(current.status.get()).toEqual({
      state: "error",
      message: "download failed",
    });
  });

  it("returns a quiet idle status for transient network failures", () => {
    current = createLifecycle();
    current.listeners.get("error")?.(new Error("net::ERR_TIMED_OUT"));

    expect(current.status.get()).toEqual({ state: "idle" });
  });

  it("surfaces non-transient update failures", () => {
    current = createLifecycle();
    current.listeners.get("error")?.(new Error("signature invalid"));

    expect(current.status.get()).toEqual({
      state: "error",
      message: "signature invalid",
    });
  });

  it("shares concurrent release-line switches", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );

    const first = current.lifecycle.applyReleaseLineSwitch("nightly");
    const second = current.lifecycle.applyReleaseLineSwitch("stable");
    resolveCheck?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).toEqual({ state: "checking" });
  });

  it("removes listeners and timers and blocks stale results after cleanup", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );
    const check = current.lifecycle.checkForUpdatesNow();

    current.lifecycle.cleanup();
    resolveCheck?.();
    await check;

    expect(current.updater.removeAllListeners).toHaveBeenCalledOnce();
    expect(current.timer.clearTimeout).toHaveBeenCalledOnce();
    expect(current.installation.cleanup).toHaveBeenCalledOnce();
    expect(current.status.get()).toEqual({ state: "checking" });
  });

  it("reinitializes with fresh status and work after a pending check", async () => {
    current = createLifecycle();
    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldCheck = current.lifecycle.checkForUpdatesNow();

    current.lifecycle.cleanup();
    current.lifecycle.initialize();
    expect(current.status.get()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshCheck = current.lifecycle.checkForUpdatesNow();

    expect(freshCheck).not.toBe(oldCheck);
    expect(current.status.get()).toEqual({ state: "checking" });
    resolveOldCheck?.();
    await Promise.all([oldCheck, freshCheck]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh release switch after cleanup cancels a pending switch", async () => {
    current = createLifecycle();
    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldSwitch = current.lifecycle.applyReleaseLineSwitch("nightly");

    current.lifecycle.cleanup();
    current.lifecycle.initialize();
    expect(current.status.get()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshSwitch = current.lifecycle.applyReleaseLineSwitch("stable");

    expect(freshSwitch).not.toBe(oldSwitch);
    expect(current.status.get()).toEqual({ state: "checking" });
    resolveOldCheck?.();
    await Promise.all([oldSwitch, freshSwitch]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
