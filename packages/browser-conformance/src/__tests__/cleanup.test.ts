import { describe, expect, it } from "vitest";
import {
  checkBrowserConformanceCleanup,
  compareBrowserConformanceCleanup,
  createBrowserConformanceResourceSnapshot,
} from "../index.js";

describe("Browser conformance cleanup baselines", () => {
  it("requires baseline identities and generations to return", () => {
    const baseline = createBrowserConformanceResourceSnapshot({
      identities: { targets: [{ id: "target-a", generation: 4 }] },
    });
    const final = createBrowserConformanceResourceSnapshot({
      identities: { targets: [{ id: "target-a", generation: 5 }] },
    });

    const result = compareBrowserConformanceCleanup(baseline, final);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ resource: "targets", reason: "identity" }),
    ]);
  });

  it("allows only explicitly declared bounded growth", () => {
    const baseline = createBrowserConformanceResourceSnapshot();
    const final = createBrowserConformanceResourceSnapshot({
      identities: { replayEntries: [{ id: "replay-1", generation: 1 }] },
    });

    expect(checkBrowserConformanceCleanup({ baseline, allowedGrowth: { replayEntries: 1 } }, final).ok).toBe(true);
    expect(checkBrowserConformanceCleanup({ baseline }, final).ok).toBe(false);
  });
});
