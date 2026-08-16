import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IUsageSource } from "@mcode/shared/usage";
import type { QuotaCategory } from "@mcode/contracts";
import { CompositeUsageSource } from "../composite-usage-source.js";

const stub = (id: string, result: QuotaCategory[] | null): IUsageSource => ({
  id,
  isAvailable: async () => result !== null,
  fetch: vi.fn(async () => result) as IUsageSource["fetch"],
});

describe("CompositeUsageSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sample: QuotaCategory[] = [
    { label: "5-hour limit", used: 1, total: 100, isUnlimited: false, remainingPercent: 0.99 },
  ];

  it("returns the first non-null source's result", async () => {
    const a = stub("a", sample);
    const b = stub("b", null);
    const composite = new CompositeUsageSource([a, b]);
    expect(await composite.fetch()).toEqual(sample);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it("falls through when the first source returns null", async () => {
    const a = stub("a", null);
    const b = stub("b", sample);
    const composite = new CompositeUsageSource([a, b]);
    expect(await composite.fetch()).toEqual(sample);
  });

  it("returns null when every source returns null", async () => {
    const composite = new CompositeUsageSource([stub("a", null), stub("b", null)]);
    expect(await composite.fetch()).toBeNull();
  });

  it("caches successful results for 90 seconds", async () => {
    const a = stub("a", sample);
    const composite = new CompositeUsageSource([a]);

    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(89_000);
    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache null results", async () => {
    const a = stub("a", null);
    const composite = new CompositeUsageSource([a]);

    expect(await composite.fetch()).toBeNull();
    expect(await composite.fetch()).toBeNull();
    expect(a.fetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent fetch calls behind one in-flight request", async () => {
    let callCount = 0;
    const slowSource: IUsageSource = {
      id: "slow",
      isAvailable: async () => true,
      fetch: vi.fn(async () => {
        callCount++;
        // Simulate async work
        await Promise.resolve();
        return sample;
      }),
    };
    const composite = new CompositeUsageSource([slowSource]);

    // Fire two concurrent fetches
    const [r1, r2] = await Promise.all([composite.fetch(), composite.fetch()]);

    expect(r1).toEqual(sample);
    expect(r2).toEqual(sample);
    // Source was called only once despite two concurrent fetches
    expect(callCount).toBe(1);
  });
});
