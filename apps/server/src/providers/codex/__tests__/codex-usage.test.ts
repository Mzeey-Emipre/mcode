import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  isSameProviderUsageInfo,
  mapCodexRateLimitsToUsage,
  mergeCodexUsageInfo,
} from "../codex-provider.js";

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

  it.each([undefined, null, "bad", 42, [], {}, { rateLimits: "bad" }])(
    "returns empty categories for invalid payload %#",
    (payload) => {
      expect(mapCodexRateLimitsToUsage(payload)).toEqual({
        providerId: "codex",
        quotaCategories: [],
      });
    },
  );

  it("skips windows with invalid usedPercent values", () => {
    expect(
      mapCodexRateLimitsToUsage({
        rateLimits: {
          primary: { usedPercent: "42", windowDurationMins: 300, resetsAt: 1_779_326_286 },
          secondary: { usedPercent: Number.NaN, windowDurationMins: 10_080 },
        },
      }),
    ).toEqual({
      providerId: "codex",
      quotaCategories: [],
    });
  });

  it("ignores invalid windowDurationMins and resetsAt without throwing", () => {
    expect(
      mapCodexRateLimitsToUsage({
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: "300", resetsAt: "soon" },
          secondary: { usedPercent: 18, windowDurationMins: Number.POSITIVE_INFINITY, resetsAt: Number.NaN },
        },
      }),
    ).toEqual({
      providerId: "codex",
      quotaCategories: [
        {
          label: "Primary limit",
          used: 42,
          total: 100,
          remainingPercent: 0.58,
          resetDate: undefined,
          isUnlimited: false,
        },
        {
          label: "Secondary limit",
          used: 18,
          total: 100,
          remainingPercent: 0.82,
          resetDate: undefined,
          isUnlimited: false,
        },
      ],
    });
  });

  it("ignores out-of-range reset timestamps without throwing", () => {
    expect(
      mapCodexRateLimitsToUsage({
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1e100 },
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
          resetDate: undefined,
          isUnlimited: false,
        },
      ],
    });
  });
});

describe("mergeCodexUsageInfo", () => {
  it("preserves existing quota buckets when a sparse update only includes one window", () => {
    const current = mapCodexRateLimitsToUsage({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_779_326_286 },
        secondary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_779_913_086 },
      },
    });
    const sparseUpdate = mapCodexRateLimitsToUsage({
      rateLimits: {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_779_326_286 },
      },
    });

    expect(mergeCodexUsageInfo(current, sparseUpdate)).toEqual({
      providerId: "codex",
      quotaCategories: [
        {
          label: "5-hour limit",
          used: 18,
          total: 100,
          remainingPercent: 0.82,
          resetDate: "2026-05-21T01:18:06.000Z",
          isUnlimited: false,
        },
        {
          label: "Weekly limit",
          used: 47,
          total: 100,
          remainingPercent: 0.53,
          resetDate: "2026-05-27T20:18:06.000Z",
          isUnlimited: false,
        },
      ],
    });
  });

  it("does not replace a known cache with an empty update", () => {
    const current = mapCodexRateLimitsToUsage({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
      },
    });

    expect(mergeCodexUsageInfo(current, { providerId: "codex", quotaCategories: [] })).toBe(current);
  });
});

describe("isSameProviderUsageInfo", () => {
  it("detects unchanged usage snapshots", () => {
    const usage = mapCodexRateLimitsToUsage({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
      },
    });

    expect(isSameProviderUsageInfo(usage, { ...usage, quotaCategories: [...usage.quotaCategories] })).toBe(true);
  });
});
