import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupApplicationUpdates,
  createApplicationUpdates,
  initializeApplicationUpdates,
} from "../index";

const { notificationMock } = vi.hoisted(() => ({
  notificationMock: { on: vi.fn(), show: vi.fn() },
}));

vi.mock("electron", () => ({
  Notification: Object.assign(function Notification() {
    return notificationMock;
  }, {
    isSupported: vi.fn(() => false),
  }),
}));

function createDependencies() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const beforeQuitListeners = new Set<(event: unknown) => void>();
  let timeoutId = 0;
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
    isPackaged: true,
    getVersion: vi.fn(() => "0.13.0"),
    on: vi.fn((_event: string, listener: (event: unknown) => void) => {
      beforeQuitListeners.add(listener);
    }),
    removeListener: vi.fn((_event: string, listener: (event: unknown) => void) => {
      beforeQuitListeners.delete(listener);
    }),
    quit: vi.fn(),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
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
    setTimeout: vi.fn(() => ++timeoutId),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => ++timeoutId),
    clearInterval: vi.fn(),
    setImmediate: vi.fn((callback: () => void) => setImmediate(callback)),
  };
  const settings = vi.fn(() => ({
    releaseLine: "stable" as const,
    autoDownload: false,
    autoInstallOnQuit: true,
    checkInterval: "1hour",
  }));
  const forceReplace = vi.fn().mockResolvedValue(undefined);
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return {
    dependencies: {
      updater,
      application,
      windows,
      timer,
      settings,
      ipc,
      forceReplace,
    },
    listeners,
    beforeQuitListeners,
    updater,
    application,
    window,
    timer,
    settings,
    forceReplace,
    ipc,
    handlers,
  };
}

describe("Application Updates feature seam", () => {
  afterEach(() => {
    cleanupApplicationUpdates();
  });

  it("composes initialization, controls, status, release-line switching, and cleanup", async () => {
    const current = createDependencies();
    const feature = createApplicationUpdates(current.dependencies);

    feature.initialize();
    expect(current.settings).toHaveBeenCalledOnce();
    expect(current.updater.channel).toBe("latest");
    expect(current.updater.autoDownload).toBe(false);
    expect(current.updater.autoInstallOnAppQuit).toBe(true);

    current.listeners.get("update-available")?.({ version: "0.14.0" });
    expect(feature.getUpdateStatus()).toEqual({
      state: "available",
      version: "0.14.0",
      releaseNotes: undefined,
    });
    await feature.downloadUpdate();
    expect(current.updater.downloadUpdate).toHaveBeenCalledOnce();

    current.listeners.get("update-downloaded")?.({ version: "0.14.0" });
    current.updater.quitAndInstall.mockImplementation(() => {
      for (const listener of current.beforeQuitListeners) {
        listener({ preventDefault: vi.fn() });
      }
    });
    await expect(feature.installUpdate()).resolves.toBe(true);
    expect(current.forceReplace).toHaveBeenCalledOnce();

    current.settings.mockReturnValue({
      releaseLine: "nightly",
      autoDownload: false,
      autoInstallOnQuit: true,
      checkInterval: "1hour",
    });
    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    await expect(feature.applyReleaseLineSwitch("nightly")).resolves.toEqual(
      feature.getUpdateStatus(),
    );
    expect(current.updater.channel).toBe("nightly");
    expect(current.updater.allowPrerelease).toBe(true);

    feature.cleanup();
    expect(current.updater.removeAllListeners).toHaveBeenCalledOnce();
    expect(current.timer.clearTimeout).toHaveBeenCalledOnce();
    expect(current.timer.clearInterval).toHaveBeenCalledOnce();
    expect(current.application.removeListener).toHaveBeenCalledOnce();
    expect(current.ipc.removeHandler).toHaveBeenCalledTimes(6);
    expect(feature.getUpdateStatus()).toEqual({
      state: "checking",
    });
  });

  it("cleans the previous instance before process-level reinitialization", () => {
    const first = createDependencies();
    initializeApplicationUpdates(first.dependencies);
    const second = createDependencies();

    initializeApplicationUpdates(second.dependencies);

    expect(first.updater.removeAllListeners).toHaveBeenCalledOnce();
    expect(first.application.removeListener).toHaveBeenCalledOnce();
    expect(first.ipc.removeHandler).toHaveBeenCalledTimes(6);
    expect(second.updater.on).toHaveBeenCalledTimes(6);
    expect(second.application.on).toHaveBeenCalledOnce();
    expect(second.ipc.handle).toHaveBeenCalledTimes(6);
  });

  it("reinitializes the same public feature with fresh checks and status", async () => {
    const current = createDependencies();
    const feature = createApplicationUpdates(current.dependencies);
    feature.initialize();

    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldCheck = feature.checkForUpdatesNow();

    feature.cleanup();
    feature.initialize();
    expect(feature.getUpdateStatus()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshCheck = feature.checkForUpdatesNow();

    expect(freshCheck).not.toBe(oldCheck);
    expect(feature.getUpdateStatus()).toEqual({ state: "checking" });
    expect(current.window.webContents.send).toHaveBeenLastCalledWith(
      "app:update-status",
      { state: "checking" },
    );
    resolveOldCheck?.();
    await Promise.all([oldCheck, freshCheck]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("reinitializes the same public feature with a fresh release switch", async () => {
    const current = createDependencies();
    const feature = createApplicationUpdates(current.dependencies);
    feature.initialize();

    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldSwitch = feature.applyReleaseLineSwitch("nightly");

    feature.cleanup();
    feature.initialize();
    expect(feature.getUpdateStatus()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshSwitch = feature.applyReleaseLineSwitch("stable");

    expect(freshSwitch).not.toBe(oldSwitch);
    expect(feature.getUpdateStatus()).toEqual({ state: "checking" });
    resolveOldCheck?.();
    await Promise.all([oldSwitch, freshSwitch]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
