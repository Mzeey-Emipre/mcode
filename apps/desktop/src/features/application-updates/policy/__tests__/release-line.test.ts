import { describe, expect, it, beforeEach, vi } from "vitest";

const { updaterMock } = vi.hoisted(() => ({
  updaterMock: {
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
  },
}));

import {
  applyChannelConfig,
  isCrossChannelDowngrade,
} from "../release-line";

describe("applyChannelConfig", () => {
  beforeEach(() => {
    updaterMock.channel = "";
    updaterMock.allowPrerelease = false;
    updaterMock.allowDowngrade = false;
  });

  it("selects the nightly channel and prerelease feed", () => {
    applyChannelConfig(updaterMock, "nightly");

    expect(updaterMock.channel).toBe("nightly");
    expect(updaterMock.allowPrerelease).toBe(true);
    expect(updaterMock.allowDowngrade).toBe(false);
  });

  it("selects the stable channel without changing downgrade policy", () => {
    updaterMock.allowDowngrade = true;

    applyChannelConfig(updaterMock, "stable");

    expect(updaterMock.channel).toBe("latest");
    expect(updaterMock.allowPrerelease).toBe(false);
    expect(updaterMock.allowDowngrade).toBe(true);
  });
});

describe("isCrossChannelDowngrade", () => {
  it.each([
    [
      "newer nightly core than stable",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      },
      true,
    ],
    [
      "older nightly core than stable",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.0-nightly.20260301.1",
        latestStable: "0.11.1",
      },
      false,
    ],
    [
      "stable to nightly",
      {
        from: "stable",
        to: "nightly",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      },
      false,
    ],
    [
      "same channel",
      {
        from: "nightly",
        to: "nightly",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      },
      false,
    ],
    [
      "missing stable metadata",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: undefined,
      },
      false,
    ],
    [
      "nightly behind a same-core stable",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.12.0",
      },
      false,
    ],
    [
      "plain semver current newer than stable",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0",
        latestStable: "0.11.1",
      },
      true,
    ],
    [
      "equal versions",
      {
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      },
      false,
    ],
  ])("keeps downgrade decision for %s", (_name, input, expected) => {
    expect(isCrossChannelDowngrade(input)).toBe(expected);
  });
});
