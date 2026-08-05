import { describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS,
  BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK,
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

  it("rejects hard-cap overflow in commands, schedule bounds, and custom items", () => {
    const baseline = createBrowserConformanceSchedule({ seed: 12, maxCommands: 1, maxEvents: 0, maxCheckpoints: 0, maxTick: 0 });
    const cleanup = { baseline: createBrowserConformanceResourceSnapshot() };
    const commands = Array.from({ length: BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1 }, (_, index) => ({
      id: `inspect-${index}`,
      operation: "inspect" as const,
    }));
    expect(() => createBrowserConformanceScenario({ id: "too-many-commands", seed: 12, commands, schedule: baseline, cleanup }))
      .toThrow(/bounds/);

    for (const [key, value] of [
      ["maxCommands", BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1],
      ["maxEvents", BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1],
      ["maxCheckpoints", BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1],
      ["maxTick", BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK + 1],
    ] as const) {
      const schedule = { ...baseline, bounds: { ...baseline.bounds, [key]: value } };
      expect(() => createBrowserConformanceScenario({
        id: `too-large-${key}`,
        seed: 12,
        commands: [{ id: "inspect", operation: "inspect" }],
        schedule,
        cleanup,
      })).toThrow(/bounds/);
    }

    const tooManyEvents = Array.from({ length: BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1 }, (_, ordinal) => ({
      order: { tick: 0, ordinal },
      kind: "timeout" as const,
    }));
    expect(() => createBrowserConformanceScenario({
      id: "too-many-events",
      seed: 12,
      commands: [{ id: "inspect", operation: "inspect" }],
      schedule: { ...baseline, bounds: { ...baseline.bounds, maxEvents: BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1 }, events: tooManyEvents },
      cleanup,
    })).toThrow(/bounds|order/);

    const tooManyCheckpoints = Array.from({ length: BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1 }, (_, ordinal) => ({
      id: `checkpoint-${ordinal}`,
      order: { tick: 0, ordinal },
      label: "checkpoint",
    }));
    expect(() => createBrowserConformanceScenario({
      id: "too-many-checkpoints",
      seed: 12,
      commands: [{ id: "inspect", operation: "inspect" }],
      schedule: { ...baseline, bounds: { ...baseline.bounds, maxCheckpoints: BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS + 1 }, checkpoints: tooManyCheckpoints },
      cleanup,
    })).toThrow(/bounds|order/);
  });
});
