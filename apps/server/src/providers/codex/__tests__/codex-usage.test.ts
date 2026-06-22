import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { mapCodexRateLimitsToUsage } from "../codex-provider.js";

describe("mapCodexRateLimitsToUsage", () => {
  it("maps primary and secondary account windows to quota categories", () => {
    expect(
      mapCodexRateLimitsToUsage({
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_779_326_286 },
          secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_779_913_086 },
        },
      }),
    ).toEqual({
      providerId: "codex",
      quotaCategories: [
        {
          label: "5-hour limit",
          used: 42,
          total: 100,
          remainingPercent: 0.58,
          resetDate: "2026-05-21T01:18:06.000Z",
          isUnlimited: false,
        },
        {
          label: "Weekly limit",
          used: 18,
          total: 100,
          remainingPercent: 0.82,
          resetDate: "2026-05-27T20:18:06.000Z",
          isUnlimited: false,
        },
      ],
    });
  });

  it("returns empty categories for missing rate limits", () => {
    expect(mapCodexRateLimitsToUsage({ rateLimits: null })).toEqual({
      providerId: "codex",
      quotaCategories: [],
    });
  });
});
