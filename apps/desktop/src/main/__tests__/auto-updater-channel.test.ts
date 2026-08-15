import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { app } from "electron";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Capture writes to autoUpdater so we can assert on the channel + prerelease config.
// Hoisted so the reference is initialized before vi.mock's hoisted factory runs.
const { updaterMock } = vi.hoisted(() => ({
  updaterMock: {
    appListeners: new Map<string, (...args: any[]) => void>(),
    isPackaged: false,
    listeners: new Map<string, (...args: any[]) => void>(),
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    checkForUpdates: vi
      .fn()
      .mockResolvedValue({ updateInfo: { version: "0.0.0" } }),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      updaterMock.listeners.set(event, listener);
    }),
    removeAllListeners: vi.fn(() => updaterMock.listeners.clear()),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: updaterMock,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return updaterMock.isPackaged;
    },
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      updaterMock.appListeners.set(event, listener);
    }),
    quit: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
    getFocusedWindow: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn() },
  Notification: Object.assign(vi.fn(), {
    isSupported: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

import {
  applyReleaseLineSwitch,
  cleanupAutoUpdater,
  createBeforeInstallHook,
  getUpdateStatus,
  initAutoUpdater,
  installUpdate,
  setBeforeInstallHook,
} from "../auto-updater";

describe("applyReleaseLineSwitch concurrency", () => {
  beforeEach(() => {
    updaterMock.channel = "";
    updaterMock.allowPrerelease = false;
    updaterMock.allowDowngrade = false;
  });

  it("concurrent calls share the same in-flight switch", async () => {
    // Both calls should resolve to the same promise (the second is de-duped).
    const a = applyReleaseLineSwitch("nightly");
    const b = applyReleaseLineSwitch("stable"); // would otherwise interleave
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe(resB);
  });
});

describe("update installation safety", () => {
  beforeEach(() => {
    updaterMock.isPackaged = true;
    updaterMock.quitAndInstall.mockReset();
    updaterMock.quitAndInstall.mockImplementation(() => {
      updaterMock.appListeners.get("before-quit")?.({
        preventDefault: vi.fn(),
      });
    });
    vi.mocked(app.quit).mockReset();
    vi.mocked(app.quit).mockImplementation(() => {
      updaterMock.appListeners.get("before-quit")?.({
        preventDefault: vi.fn(),
      });
    });
    setBeforeInstallHook(async () => {});
    if (!updaterMock.appListeners.has("before-quit")) {
      initAutoUpdater();
    }
    updaterMock.listeners.get("update-downloaded")?.({
      version: "0.2.0",
      releaseNotes: null,
    });
  });

  afterAll(() => {
    cleanupAutoUpdater();
    updaterMock.isPackaged = false;
  });

  it("aborts manual installation when server teardown fails", async () => {
    setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });

    await expect(installUpdate()).resolves.toBe(false);
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
    });
  });

  it("keeps the app open when silent install teardown fails", async () => {
    const beforeQuit = updaterMock.appListeners.get("before-quit");
    expect(beforeQuit).toBeDefined();
    setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });
    const event = { preventDefault: vi.fn() } as unknown as Event;

    beforeQuit?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
    });
  });

  it("resets manual install guard when quitAndInstall throws", async () => {
    updaterMock.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("installer crashed");
    });

    await expect(installUpdate()).resolves.toBe(false);
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message: "Update installation blocked: installer crashed",
    });

    updaterMock.listeners.get("update-downloaded")?.({
      version: "0.2.0",
      releaseNotes: null,
    });
    await expect(installUpdate()).resolves.toBe(true);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("accepts deferred quitAndInstall after before-quit arrives", async () => {
    updaterMock.quitAndInstall.mockImplementationOnce(() => {
      setImmediate(() => vi.mocked(app.quit)());
    });

    await expect(installUpdate()).resolves.toBe(true);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("resets manual install guard when quitAndInstall rejects initiation", async () => {
    updaterMock.quitAndInstall.mockImplementationOnce(() => false);

    await expect(installUpdate()).resolves.toBe(false);
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message:
        "Update installation blocked: Update installer did not begin application shutdown",
    });

    updaterMock.listeners.get("update-downloaded")?.({
      version: "0.2.0",
      releaseNotes: null,
    });
    await expect(installUpdate()).resolves.toBe(true);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("resets manual install guard when quitAndInstall returns without before-quit", async () => {
    updaterMock.quitAndInstall.mockImplementationOnce(() => {});

    await expect(installUpdate()).resolves.toBe(false);
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message:
        "Update installation blocked: Update installer did not begin application shutdown",
    });

    updaterMock.listeners.get("update-downloaded")?.({
      version: "0.2.0",
      releaseNotes: null,
    });
    await expect(installUpdate()).resolves.toBe(true);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("resets silent-install guard when deferred app quit returns without before-quit", async () => {
    vi.mocked(app.quit).mockImplementationOnce(() => {});
    const beforeQuit = updaterMock.appListeners.get("before-quit");
    const event = { preventDefault: vi.fn() } as unknown as Event;

    beforeQuit?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getUpdateStatus()).toEqual({
      state: "error",
      message:
        "Update installation blocked: Update installer did not begin application shutdown",
    });

    updaterMock.listeners.get("update-downloaded")?.({
      version: "0.2.0",
      releaseNotes: null,
    });
    beforeQuit?.({ preventDefault: vi.fn() } as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(getUpdateStatus().state).toBe("downloaded");
  });

  it("keeps before-quit ownership at the auto-updater bootstrap boundary", () => {
    const mainSource = readFileSync(
      fileURLToPath(new URL("../main.ts", import.meta.url)),
      "utf8",
    );

    expect(mainSource).not.toMatch(/app\s*\.\s*on\s*\(\s*["']before-quit["']/);
    expect(mainSource).toMatch(
      /setBeforeInstallHook\(\s*createBeforeInstallHook\(\(\)\s*=>\s*serverRuntime\.forceReplace\(\)\)\s*,?\s*\)/s,
    );
    expect(updaterMock.appListeners.has("before-quit")).toBe(true);
    expect(updaterMock.appListeners.size).toBe(1);
  });

  it("builds the updater teardown hook from forceReplace", async () => {
    const forceReplace = vi.fn().mockResolvedValue(undefined);
    const hook = createBeforeInstallHook(forceReplace);

    await hook();

    expect(forceReplace).toHaveBeenCalledOnce();
  });

  it("propagates forceReplace errors through the updater teardown hook", async () => {
    const failure = new Error("server teardown failed");
    const forceReplace = vi.fn().mockRejectedValue(failure);
    const hook = createBeforeInstallHook(forceReplace);

    await expect(hook()).rejects.toBe(failure);
  });

  it("keeps successful silent installation behavior", async () => {
    const beforeQuit = updaterMock.appListeners.get("before-quit");
    expect(beforeQuit).toBeDefined();
    const event = { preventDefault: vi.fn() } as unknown as Event;

    beforeQuit?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps successful manual installation behavior", async () => {
    await expect(installUpdate()).resolves.toBe(true);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledOnce();
  });
});
