import { describe, expect, it } from "vitest";

import {
  buildSingleInstanceServerUrl,
  getReconnectScanRange,
  isSingleInstanceDev,
  parseServerPort,
} from "../index";

/**
 * `parseServerPort` backs the guard (`getPinnedServerPort`) that stops a
 * dev/demo page from wandering onto another server (including a production app)
 * when its pinned backend drops. When `VITE_SERVER_URL` carries a port,
 * reconnect must target only that port; when it does not, the helper returns
 * null so callers fall back to a range scan. These tests lock that contract.
 */
describe("parseServerPort", () => {
  it("returns the port from a ws:// URL", () => {
    expect(parseServerPort("ws://localhost:5999?token=abc")).toBe(5999);
  });

  it("returns the port from an http:// URL", () => {
    expect(parseServerPort("http://127.0.0.1:19533/")).toBe(19533);
  });

  it("returns null for an empty or undefined URL", () => {
    expect(parseServerPort("")).toBeNull();
    expect(parseServerPort(undefined)).toBeNull();
  });

  it("returns null when the URL has no explicit port", () => {
    expect(parseServerPort("ws://localhost")).toBeNull();
  });

  it("returns null for an unparseable URL rather than throwing", () => {
    expect(parseServerPort("http://:::")).toBeNull();
  });
});

/**
 * `getReconnectScanRange` is the actual behavior change in `discoverServerUrl`:
 * a pinned backend must scan only its own port (so a dropped dev/demo page can
 * never reattach to a production server), while an unpinned page (standalone /
 * production build, where `VITE_SERVER_URL` is unset) must keep the original
 * full-range scan. These tests lock both branches.
 */
describe("getReconnectScanRange", () => {
  it("scans only the pinned port (one-wide window)", () => {
    expect(getReconnectScanRange(5999)).toEqual({ min: 5999, max: 6000 });
  });

  it("falls back to the full range when nothing is pinned", () => {
    expect(getReconnectScanRange(null)).toEqual({ min: 19400, max: 19800 });
  });
});

describe("isSingleInstanceDev", () => {
  it("returns false when the Vite single-instance flag is unset", () => {
    expect(isSingleInstanceDev()).toBe(false);
  });
});

describe("buildSingleInstanceServerUrl", () => {
  it("builds the WebSocket URL from the runtime contract", () => {
    const url = buildSingleInstanceServerUrl({
      serverPort: 41_234,
      instanceToken: "instance-token-abc",
      worktreeIdentity: "C:\\repo\\worktree-a",
      seedLogin: {
        token: "seed-token-abc",
      },
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("ws://127.0.0.1:41234");
    expect(parsed.searchParams.get("token")).toBe("seed-token-abc");
    expect(parsed.searchParams.get("instanceToken")).toBe("instance-token-abc");
    expect(parsed.searchParams.get("worktree")).toBe("C:\\repo\\worktree-a");
  });

  it("rejects contracts without the pairing fields", () => {
    expect(() => buildSingleInstanceServerUrl({ serverPort: 41_234 })).toThrow(
      /instanceToken/,
    );
  });
});
