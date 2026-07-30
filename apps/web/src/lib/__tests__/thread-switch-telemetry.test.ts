import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetThreadSwitchTelemetryForTests,
  recordFirstMessageVisible,
  recordThreadCommit,
  recordThreadHoldEnd,
  recordThreadHoldStart,
  recordThreadPositioned,
  recordThreadSelection,
} from "../thread-switch-telemetry";

function names(prefix: string): string[] {
  return performance.getEntriesByType("mark")
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(prefix));
}

beforeEach(() => {
  __resetThreadSwitchTelemetryForTests();
});

afterEach(() => {
  __resetThreadSwitchTelemetryForTests();
});

describe("thread switch telemetry", () => {
  it("records selection, cache commit, and positioned completion", () => {
    recordThreadSelection("thread-a");
    recordThreadCommit("thread-a", "cache-restore");
    recordThreadPositioned("thread-a");

    expect(names("mcode:thread-switch:selection:")).toHaveLength(1);
    expect(names("mcode:thread-switch:commit:cache-restore:")).toHaveLength(1);
    expect(names("mcode:thread-switch:positioned:")).toHaveLength(1);
    expect(performance.getEntriesByName("mcode:thread-switch:selection-to-positioned:1")).toHaveLength(1);
  });

  it("records the outgoing transcript hold and target's first visible message", () => {
    recordThreadSelection("thread-a");
    recordThreadHoldStart("thread-a");
    recordThreadHoldEnd("thread-a");
    recordFirstMessageVisible("thread-a");

    expect(names("mcode:thread-switch:hold-start:")).toHaveLength(1);
    expect(names("mcode:thread-switch:hold-end:")).toHaveLength(1);
    expect(names("mcode:thread-switch:first-message-visible:")).toHaveLength(1);
    expect(performance.getEntriesByName("mcode:thread-switch:selection-to-first-message-visible:1")).toHaveLength(1);
  });

  it("keeps cache and network commits distinguishable and bounds retained entries", () => {
    for (let index = 0; index < 40; index++) {
      const threadId = `thread-${index}`;
      recordThreadSelection(threadId);
      recordThreadCommit(threadId, index % 2 === 0 ? "cache-restore" : "network-fetch");
    }

    expect(performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("mcode:thread-switch")).length)
      .toBeLessThanOrEqual(64);
    expect(names("mcode:thread-switch:commit:cache-restore:").length).toBeGreaterThan(0);
    expect(names("mcode:thread-switch:commit:network-fetch:").length).toBeGreaterThan(0);
  });

  it("does not position a superseded thread", () => {
    recordThreadSelection("thread-a");
    recordThreadSelection("thread-b");
    recordThreadPositioned("thread-a");
    recordThreadPositioned("thread-b");

    expect(names("mcode:thread-switch:positioned:")).toHaveLength(1);
    expect(performance.getEntriesByType("mark").some((entry) => entry.name.includes(":positioned:2"))).toBe(true);
  });
});
