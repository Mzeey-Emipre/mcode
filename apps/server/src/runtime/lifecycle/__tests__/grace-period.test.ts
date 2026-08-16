import { describe, it, expect } from "vitest";
import { resolveGracePeriodMs, shouldShutdownOnIdle } from "../grace-period-ms.js";

describe("resolveGracePeriodMs", () => {
  it("returns 5s in dev when setting is default (30)", () => {
    expect(resolveGracePeriodMs(30, false)).toBe(5_000);
  });

  it("returns 30s in production when setting is default (30)", () => {
    expect(resolveGracePeriodMs(30, true)).toBe(30_000);
  });

  it("returns explicit setting in dev", () => {
    expect(resolveGracePeriodMs(15, false)).toBe(15_000);
  });

  it("returns explicit setting in production", () => {
    expect(resolveGracePeriodMs(10, true)).toBe(10_000);
  });

  it("returns 0 when set to 0 (immediate shutdown)", () => {
    expect(resolveGracePeriodMs(0, false)).toBe(0);
  });

  it("keeps agent runtimes alive until their supervisor stops them", () => {
    expect(shouldShutdownOnIdle({ MCODE_AGENT_RUNTIME: "1" })).toBe(false);
  });

  it("preserves idle shutdown for regular server processes", () => {
    expect(shouldShutdownOnIdle({})).toBe(true);
  });
});
