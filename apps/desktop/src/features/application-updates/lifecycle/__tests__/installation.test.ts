import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUpdateStatusState } from "../../state/update-status";
import { createInstallationLifecycle } from "../installation";

function createLifecycle() {
  const listeners = new Map<string, (event: unknown) => void>();
  const updater = {
    quitAndInstall: vi.fn(),
  };
  const application = {
    isPackaged: true,
    getVersion: vi.fn(() => "0.13.0"),
    on: vi.fn((event: string, listener: (event: unknown) => void) => {
      listeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string) => {
      listeners.delete(event);
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
  const timer = {
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setImmediate: vi.fn((callback: () => void) => setImmediate(callback)),
  };
  const status = createUpdateStatusState({
    getAllWindows: () => [window],
    getFocusedWindow: () => null,
  });
  const lifecycle = createInstallationLifecycle({
    updater,
    application,
    timer,
    settings: vi.fn(() => ({
      releaseLine: "stable" as const,
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "never",
    })),
    status,
  });
  return { lifecycle, updater, application, listeners, status };
}

function markDownloaded(status: ReturnType<typeof createUpdateStatusState>): void {
  status.publish({ state: "downloaded", version: "0.14.0" });
}

describe("update installation lifecycle", () => {
  let current: ReturnType<typeof createLifecycle>;

  beforeEach(() => {
    current = createLifecycle();
    current.lifecycle.setBeforeInstallHook(async () => {});
    current.lifecycle.register();
    markDownloaded(current.status);
    current.updater.quitAndInstall.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });
  });

  afterEach(() => {
    current.lifecycle.cleanup();
  });

  it("blocks manual installation when server teardown fails", async () => {
    current.lifecycle.setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);

    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(current.status.get()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
    });
  });

  it("resets the manual guard after installer failure", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("installer crashed");
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);
    markDownloaded(current.status);
    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(current.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("resets the manual guard when installation does not begin shutdown", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => false);

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);
    markDownloaded(current.status);
    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(current.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("accepts a deferred quit-and-install after before-quit arrives", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => {
      setImmediate(() => current.application.quit());
    });
    current.application.quit.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);
    expect(current.application.quit).toHaveBeenCalledOnce();
  });

  it("keeps the app open when silent install teardown fails", async () => {
    current.lifecycle.setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });
    const event = { preventDefault: vi.fn() };

    current.listeners.get("before-quit")?.(event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(current.application.quit).not.toHaveBeenCalled();
    expect(current.status.get()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
    });
  });

  it("keeps successful silent installation behavior", async () => {
    current.application.quit.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });
    const event = { preventDefault: vi.fn() };

    current.listeners.get("before-quit")?.(event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(current.application.quit).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("builds and propagates the injected teardown hook", async () => {
    const forceReplace = vi.fn().mockResolvedValue(undefined);
    const hook = current.lifecycle.createBeforeInstallHook(forceReplace);

    await hook();

    expect(forceReplace).toHaveBeenCalledOnce();
    const failure = new Error("server teardown failed");
    forceReplace.mockRejectedValueOnce(failure);
    await expect(hook()).rejects.toBe(failure);
  });

  it("blocks stale installation work after cleanup", async () => {
    let resolveTeardown: (() => void) | undefined;
    current.lifecycle.setBeforeInstallHook(
      () => new Promise<void>((resolve) => (resolveTeardown = resolve)),
    );
    const install = current.lifecycle.installUpdate();

    current.lifecycle.cleanup();
    resolveTeardown?.();

    await expect(install).resolves.toBe(false);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(current.application.removeListener).toHaveBeenCalledOnce();
  });

  it("resets the injected hook and guards before a later registration", async () => {
    const forceReplace = vi.fn().mockResolvedValue(undefined);
    current.lifecycle.setBeforeInstallHook(async () => forceReplace());
    current.lifecycle.cleanup();
    current.lifecycle.register();
    markDownloaded(current.status);
    current.updater.quitAndInstall.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(forceReplace).not.toHaveBeenCalled();
    expect(current.updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
