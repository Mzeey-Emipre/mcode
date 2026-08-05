import { describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_GENERATOR_VERSION,
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  createBrowserConformanceScenario,
  createBrowserConformanceSchedule,
  createBrowserConformanceResourceSnapshot,
} from "../index.js";

describe("Browser conformance scenario boundaries", () => {
  it("rejects mismatched schedule metadata and out-of-bound total-order entries", () => {
    const base = createBrowserConformanceSchedule({ seed: 11, maxCommands: 1, maxEvents: 1, eventCount: 1 });
    expect(() => createBrowserConformanceScenario({
      id: "invalid-version",
      seed: 11,
      commands: [],
      schedule: { ...base, version: BROWSER_CONFORMANCE_SCENARIO_VERSION + 1 as 1 },
      cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
    })).toThrow(/metadata/);
    expect(() => createBrowserConformanceScenario({
      id: "invalid-order",
      seed: 11,
      commands: [],
      schedule: {
        ...base,
        generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
        events: [{ ...base.events[0], order: { tick: base.bounds.maxTick + 1, ordinal: 0 } }],
      },
      cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
    })).toThrow(/order|bounds/);
  });
});
