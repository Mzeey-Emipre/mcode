import { beforeEach, describe, expect, it, vi } from "vitest";

const { appMock, readFileMock } = vi.hoisted(() => ({
  appMock: { getVersion: vi.fn() },
  readFileMock: vi.fn(),
}));

vi.mock("electron", () => ({ app: appMock }));
vi.mock("fs", () => ({ readFileSync: readFileMock }));
vi.mock("@mcode/shared", () => ({ getMcodeDir: vi.fn(() => "/tmp/mcode") }));

import { intervalToMs, loadUpdaterSettings } from "../settings";

describe("intervalToMs", () => {
  it.each([
    ["15min", 15 * 60 * 1000],
    ["1hour", 60 * 60 * 1000],
    ["4hours", 4 * 60 * 60 * 1000],
    ["1day", 24 * 60 * 60 * 1000],
    ["never", Infinity],
  ])("maps %s to its configured duration", (name, expected) => {
    expect(intervalToMs(name)).toBe(expected);
  });

  it("uses the four-hour default for an unknown interval", () => {
    expect(intervalToMs("unexpected")).toBe(4 * 60 * 60 * 1000);
  });
});

describe("loadUpdaterSettings", () => {
  beforeEach(() => {
    appMock.getVersion.mockReturnValue("0.13.0");
    readFileMock.mockReset();
  });

  it("returns updater defaults when settings are unavailable", () => {
    readFileMock.mockImplementation(() => {
      const error = new Error("missing");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    expect(loadUpdaterSettings()).toEqual({
      releaseLine: "stable",
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "4hours",
    });
  });

  it("keeps an implicit nightly line for nightly builds", () => {
    appMock.getVersion.mockReturnValue("0.13.0-nightly.20260815.1");
    readFileMock.mockReturnValue("{}");

    expect(loadUpdaterSettings().releaseLine).toBe("nightly");
  });

  it("uses the supplied application version for the implicit release line", () => {
    appMock.getVersion.mockReturnValue("0.13.0");
    readFileMock.mockReturnValue("{}");

    expect(loadUpdaterSettings("0.13.0-nightly.20260815.1").releaseLine).toBe(
      "nightly",
    );
  });

  it("uses validated explicit settings", () => {
    readFileMock.mockReturnValue(
      JSON.stringify({
        updates: {
          channel: "nightly",
          autoDownload: false,
          autoInstallOnQuit: false,
          checkInterval: "1day",
        },
      }),
    );

    expect(loadUpdaterSettings()).toEqual({
      releaseLine: "nightly",
      autoDownload: false,
      autoInstallOnQuit: false,
      checkInterval: "1day",
    });
  });

  it("falls back to defaults when settings fail validation", () => {
    readFileMock.mockReturnValue(
      JSON.stringify({ updates: { channel: "preview" } }),
    );

    expect(loadUpdaterSettings()).toEqual({
      releaseLine: "stable",
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "4hours",
    });
  });
});
