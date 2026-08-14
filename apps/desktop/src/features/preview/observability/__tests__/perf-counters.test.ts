import { describe, expect, it, beforeEach } from "vitest";
import {
  bumpPerf,
  getPerfCounters,
  resetPerfCounters,
  setPerf,
} from "../perf-counters.js";

describe("preview-perf counters", () => {
  beforeEach(() => {
    resetPerfCounters();
  });

  it("starts every field at zero", () => {
    const c = getPerfCounters();
    for (const k of Object.keys(c) as Array<keyof typeof c>) {
      expect(c[k]).toBe(0);
    }
  });

  it("bumpPerf increments by 1 by default and by N when given", () => {
    bumpPerf("setPanelBoundsCalls");
    bumpPerf("setPanelBoundsCalls");
    bumpPerf("setPanelBoundsNoopSkips", 5);
    const c = getPerfCounters();
    expect(c.setPanelBoundsCalls).toBe(2);
    expect(c.setPanelBoundsNoopSkips).toBe(5);
  });

  it("setPerf assigns absolute values (gauge semantics)", () => {
    setPerf("warmInactiveRuntimeCount", 3);
    expect(getPerfCounters().warmInactiveRuntimeCount).toBe(3);
    setPerf("warmInactiveRuntimeCount", 0);
    expect(getPerfCounters().warmInactiveRuntimeCount).toBe(0);
  });

  it("getPerfCounters returns a defensive copy", () => {
    const a = getPerfCounters();
    a.setPanelBoundsCalls = 999;
    const b = getPerfCounters();
    expect(b.setPanelBoundsCalls).toBe(0);
  });
});
