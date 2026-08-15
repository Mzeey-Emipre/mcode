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
  applyChannelConfig,
  applyReleaseLineSwitch,
  isCrossChannelDowngrade,
  isTransientNetworkError,
  cleanupAutoUpdater,
  createBeforeInstallHook,
  getUpdateStatus,
  initAutoUpdater,
  installUpdate,
  setBeforeInstallHook,
} from "../auto-updater";

describe("applyChannelConfig", () => {
  beforeEach(() => {
    updaterMock.channel = "";
    updaterMock.allowPrerelease = false;
    updaterMock.allowDowngrade = false;
  });

  it("nightly: channel=nightly, allowPrerelease=true", () => {
    applyChannelConfig("nightly");
    expect(updaterMock.channel).toBe("nightly");
    expect(updaterMock.allowPrerelease).toBe(true);
  });

  it("stable: channel=latest, allowPrerelease=false", () => {
    applyChannelConfig("stable");
    expect(updaterMock.channel).toBe("latest");
    expect(updaterMock.allowPrerelease).toBe(false);
  });

  it("does not touch allowDowngrade by default", () => {
    applyChannelConfig("nightly");
    expect(updaterMock.allowDowngrade).toBe(false);
    applyChannelConfig("stable");
    expect(updaterMock.allowDowngrade).toBe(false);
  });
});

describe("isCrossChannelDowngrade", () => {
  it("nightly version > latest stable triggers downgrade flow", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      }),
    ).toBe(true);
  });

  it("nightly version older than latest stable does not", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.0-nightly.20260301.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("stable → nightly never triggers downgrade", () => {
    expect(
      isCrossChannelDowngrade({
        from: "stable",
        to: "nightly",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("same channel never triggers downgrade", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "nightly",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("missing latestStable falls back to false (no info, no warning)", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: undefined,
      }),
    ).toBe(false);
  });

  it("current nightly at same core as just-shipped stable is older (no downgrade)", () => {
    // semverGt §11.4.1: equal core, no-prerelease > has-prerelease.
    // Running 0.12.0-nightly.X right after 0.12.0 stable ships: stable is
    // newer, so switching channels does NOT cross-downgrade.
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.12.0",
      }),
    ).toBe(false);
  });

  it("current is plain semver newer than latest stable (downgrade)", () => {
    // Belt-and-suspenders: a non-prerelease current version greater than
    // latestStable still triggers downgrade. (Practically rare for nightly→
    // stable, but exercises semverGt's no-prerelease-on-both branch.)
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0",
        latestStable: "0.11.1",
      }),
    ).toBe(true);
  });

  it("identical core and identical prerelease is not a downgrade", () => {
    // currentVersion === latestStable should return false even if both happen
    // to carry the same prerelease tag (defensive — practical case is two
    // stables that happen to match).
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });
});

describe("isTransientNetworkError", () => {
  it("classifies Chromium net::ERR_NAME_NOT_RESOLVED as transient", () => {
    // Regression: this was surfaced as a scary red "Update failed" banner
    // when the app launched before WiFi reconnected. See UpdateIndicator.tsx.
    expect(
      isTransientNetworkError(new Error("net::ERR_NAME_NOT_RESOLVED")),
    ).toBe(true);
  });

  it("classifies other Chromium connectivity errors as transient", () => {
    expect(
      isTransientNetworkError(new Error("net::ERR_INTERNET_DISCONNECTED")),
    ).toBe(true);
    expect(
      isTransientNetworkError(new Error("net::ERR_CONNECTION_RESET")),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("net::ERR_TIMED_OUT"))).toBe(true);
    expect(
      isTransientNetworkError(new Error("net::ERR_PROXY_CONNECTION_FAILED")),
    ).toBe(true);
  });

  it("classifies Node POSIX socket/DNS codes as transient", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), {
      code: "ENOTFOUND",
    });
    expect(isTransientNetworkError(err)).toBe(true);

    const econn = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(isTransientNetworkError(econn)).toBe(true);

    const etimeout = Object.assign(new Error("read ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(isTransientNetworkError(etimeout)).toBe(true);
  });

  it("classifies transient HTTP gateway statusCodes as transient", () => {
    // Regression: a GitHub 504 on the releases feed surfaced as a scary
    // "Update failed" banner. Gateway/overload statuses self-heal on retry.
    for (const statusCode of [408, 429, 500, 502, 503, 504]) {
      const err = Object.assign(new Error("request failed"), { statusCode });
      expect(isTransientNetworkError(err)).toBe(true);
    }
  });

  it("classifies gateway phrases in the error body as transient", () => {
    // electron-updater folds the HTML response body into the message; the
    // bare "504 Gateway Time-out" page must be recognized without a statusCode.
    expect(
      isTransientNetworkError(
        new Error(
          '504 "method: GET url: .../releases.atom\\n\\n<h1>504 Gateway Time-out</h1>"',
        ),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("503 Service Unavailable"))).toBe(
      true,
    );
    expect(isTransientNetworkError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("does not classify real update failures as transient", () => {
    expect(isTransientNetworkError(new Error("HttpError: 404"))).toBe(false);
    expect(
      isTransientNetworkError(new Error("signature verification failed")),
    ).toBe(false);
    expect(isTransientNetworkError(new Error("Cannot find latest.yml"))).toBe(
      false,
    );
    expect(isTransientNetworkError(new Error("Cannot parse update info"))).toBe(
      false,
    );
    // Real 4xx auth/missing-asset statusCodes must surface, not be swallowed.
    expect(
      isTransientNetworkError(
        Object.assign(new Error("forbidden"), { statusCode: 403 }),
      ),
    ).toBe(false);
    expect(
      isTransientNetworkError(
        Object.assign(new Error("not found"), { statusCode: 404 }),
      ),
    ).toBe(false);
  });

  it("handles non-Error inputs without throwing", () => {
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("net::ERR_NAME_NOT_RESOLVED")).toBe(true);
  });
});

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
