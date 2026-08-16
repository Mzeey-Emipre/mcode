import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { normalizeQuotaSnapshots } from "../copilot-provider.js";

describe("normalizeQuotaSnapshots", () => {
  it("preserves SDK reset dates on quota categories", () => {
    expect(
      normalizeQuotaSnapshots({
        premium_interactions: {
          entitlementRequests: 100,
          usedRequests: 25,
          remainingPercentage: 75,
          resetDate: "2026-07-31T00:00:00.000Z",
        },
      }),
    ).toEqual([
      {
        label: "Premium usage",
        used: 25,
        total: 100,
        remainingPercent: 0.75,
        resetDate: "2026-07-31T00:00:00.000Z",
        isUnlimited: false,
      },
    ]);
  });
});
