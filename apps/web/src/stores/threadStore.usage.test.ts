import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageInfo } from "@mcode/contracts";
import { mergeProviderUsageSnapshot, useThreadStore } from "./threadStore";
import { createEmptyThreadRecord } from "./thread-record";

const { getProviderUsage } = vi.hoisted(() => ({
  getProviderUsage: vi.fn<() => Promise<ProviderUsageInfo>>(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    getProviderUsage,
  }),
}));

const READY_USAGE: ProviderUsageInfo = {
  providerId: "claude",
  quotaCategories: [
    {
      label: "5-hour limit",
      used: 25,
      total: 100,
      remainingPercent: 0.75,
      resetDate: "2026-07-03T14:00:00.000Z",
      isUnlimited: false,
    },
  ],
  usageStatus: "ready",
  fetchedAt: "2026-07-03T12:00:00.000Z",
};

describe("mergeProviderUsageSnapshot", () => {
  const now = Date.parse("2026-07-03T13:00:00.000Z");

  it("keeps known-good quota as stale when refresh becomes unavailable", () => {
    expect(
      mergeProviderUsageSnapshot(
        READY_USAGE,
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "unavailable",
          failedAt: "2026-07-03T13:00:00.000Z",
          diagnostic: "network unavailable",
        },
        now,
      ),
    ).toEqual({
      ...READY_USAGE,
      usageStatus: "stale",
      failedAt: "2026-07-03T13:00:00.000Z",
      diagnostic: "network unavailable",
    });
  });

  it("expires stale known-good quota after 24 hours", () => {
    expect(
      mergeProviderUsageSnapshot(
        READY_USAGE,
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "unavailable",
          failedAt: "2026-07-04T13:01:00.000Z",
          diagnostic: "network unavailable",
        },
        Date.parse("2026-07-04T13:01:00.000Z"),
      ),
    ).toEqual({
      providerId: "claude",
      quotaCategories: [],
      usageStatus: "unavailable",
      failedAt: "2026-07-04T13:01:00.000Z",
      diagnostic: "network unavailable",
    });
  });

  it("keeps explicit supported empty quota as ready-empty", () => {
    expect(
      mergeProviderUsageSnapshot(
        READY_USAGE,
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "ready-empty",
          fetchedAt: "2026-07-03T13:00:00.000Z",
        },
        now,
      ),
    ).toEqual({
      providerId: "claude",
      quotaCategories: [],
      usageStatus: "ready-empty",
      fetchedAt: "2026-07-03T13:00:00.000Z",
    });
  });

  it("successful refresh clears stale diagnostics", () => {
    expect(
      mergeProviderUsageSnapshot(
        { ...READY_USAGE, usageStatus: "stale", diagnostic: "old failure" },
        { ...READY_USAGE, fetchedAt: "2026-07-03T13:00:00.000Z" },
        now,
      ),
    ).toMatchObject({
      usageStatus: "ready",
      fetchedAt: "2026-07-03T13:00:00.000Z",
      failedAt: undefined,
      diagnostic: undefined,
    });
  });
});

describe("fetchProviderUsage", () => {
  afterEach(() => {
    getProviderUsage.mockReset();
    useThreadStore.setState({
      records: new Map(),
      currentThreadId: null,
      runningThreadIds: new Set(),
      recapByThread: {},
      recentlyAnsweredPlanMessageIds: new Set(),
    });
  });

  it("reuses same-provider quota after another thread's failed refresh without copying thread metrics", async () => {
    const providerId = `claude-regression-${crypto.randomUUID()}`;
    getProviderUsage
      .mockResolvedValueOnce({
        ...READY_USAGE,
        providerId,
        fetchedAt: new Date().toISOString(),
        sessionCostUsd: 0.42,
        serviceTier: "priority",
        numTurns: 3,
        durationMs: 1200,
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));

    useThreadStore.setState({
      records: new Map([
        ["thread-a", createEmptyThreadRecord()],
        ["thread-b", createEmptyThreadRecord()],
      ]),
    });

    await useThreadStore.getState().fetchProviderUsage("thread-a", providerId);
    await useThreadStore.getState().fetchProviderUsage("thread-b", providerId);

    const threadAUsage = useThreadStore.getState().records.get("thread-a")?.usageByProvider[providerId];
    const threadBUsage = useThreadStore.getState().records.get("thread-b")?.usageByProvider[providerId];

    expect(threadAUsage).toMatchObject({
      usageStatus: "ready",
      sessionCostUsd: 0.42,
      serviceTier: "priority",
      numTurns: 3,
      durationMs: 1200,
    });
    expect(threadBUsage).toMatchObject({
      providerId,
      quotaCategories: READY_USAGE.quotaCategories,
      usageStatus: "stale",
      diagnostic: "Usage refresh failed",
    });
    expect(threadBUsage?.sessionCostUsd).toBeUndefined();
    expect(threadBUsage?.serviceTier).toBeUndefined();
    expect(threadBUsage?.numTurns).toBeUndefined();
    expect(threadBUsage?.durationMs).toBeUndefined();
  });
});
