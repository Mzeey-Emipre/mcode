import { describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS,
  createBrowserConformanceRandom,
  createBrowserConformanceSchedule,
} from "../index.js";

describe("Browser conformance deterministic schedules", () => {
  it("replays the same seed byte-for-byte and gives events a total order", () => {
    const first = createBrowserConformanceSchedule({
      seed: "bootstrap-race",
      maxCommands: 12,
      maxEvents: 10,
      maxCheckpoints: 4,
      maxTick: 30,
      eventCount: 10,
      checkpointCount: 4,
    });
    const second = createBrowserConformanceSchedule({
      seed: "bootstrap-race",
      maxCommands: 12,
      maxEvents: 10,
      maxCheckpoints: 4,
      maxTick: 30,
      eventCount: 10,
      checkpointCount: 4,
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const orders = [...first.events, ...first.checkpoints]
      .map((item) => `${item.order.tick}:${item.order.ordinal}`);
    expect(new Set(orders).size).toBe(orders.length);
    expect(first.events.every((event) => event.order.tick <= first.bounds.maxTick)).toBe(true);
  });

  it("clamps generated work to hard bounds and rejects invalid random bounds", () => {
    const schedule = createBrowserConformanceSchedule({
      seed: 7,
      maxCommands: Number.MAX_SAFE_INTEGER,
      maxEvents: Number.MAX_SAFE_INTEGER,
      maxCheckpoints: Number.MAX_SAFE_INTEGER,
      maxTick: Number.MAX_SAFE_INTEGER,
      eventCount: Number.MAX_SAFE_INTEGER,
      checkpointCount: Number.MAX_SAFE_INTEGER,
    });

    expect(schedule.bounds.maxCommands).toBe(BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS);
    expect(schedule.events.length).toBe(BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS);
    expect(schedule.checkpoints.length).toBe(BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS);
    expect(() => createBrowserConformanceRandom(1).integer(0)).toThrow(RangeError);
  });
});
