import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture writes to autoUpdater so we can assert on the channel + prerelease config.
// Hoisted so the reference is initialized before vi.mock's hoisted factory runs.
const { updaterMock } = vi.hoisted(() => ({
  updaterMock: {
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: "0.0.0" } }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: updaterMock,
}));

vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
    isPackaged: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]), getFocusedWindow: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn().mockReturnValue(false) }),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

import {
  applyChannelConfig,
  applyReleaseLineSwitch,
  isCrossChannelDowngrade,
  isTransientNetworkError,
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
    expect(isTransientNetworkError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(true);
  });

  it("classifies other Chromium connectivity errors as transient", () => {
    expect(isTransientNetworkError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(true);
    expect(isTransientNetworkError(new Error("net::ERR_CONNECTION_RESET"))).toBe(true);
    expect(isTransientNetworkError(new Error("net::ERR_TIMED_OUT"))).toBe(true);
    expect(isTransientNetworkError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toBe(true);
  });

  it("classifies Node POSIX socket/DNS codes as transient", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), {
      code: "ENOTFOUND",
    });
    expect(isTransientNetworkError(err)).toBe(true);

    const econn = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isTransientNetworkError(econn)).toBe(true);

    const etimeout = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
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
        new Error('504 "method: GET url: .../releases.atom\\n\\n<h1>504 Gateway Time-out</h1>"'),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientNetworkError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("does not classify real update failures as transient", () => {
    expect(isTransientNetworkError(new Error("HttpError: 404"))).toBe(false);
    expect(isTransientNetworkError(new Error("signature verification failed"))).toBe(false);
    expect(isTransientNetworkError(new Error("Cannot find latest.yml"))).toBe(false);
    expect(isTransientNetworkError(new Error("Cannot parse update info"))).toBe(false);
    // Real 4xx auth/missing-asset statusCodes must surface, not be swallowed.
    expect(
      isTransientNetworkError(Object.assign(new Error("forbidden"), { statusCode: 403 })),
    ).toBe(false);
    expect(
      isTransientNetworkError(Object.assign(new Error("not found"), { statusCode: 404 })),
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
