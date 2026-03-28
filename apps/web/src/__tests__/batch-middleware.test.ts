import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchedUpdater } from "@/stores/batchMiddleware";

describe("createBatchedUpdater", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces multiple calls into a single flush", () => {
    const setState = vi.fn();
    const batch = createBatchedUpdater<{ count: number }>(setState);

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));

    expect(setState).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("applies updates sequentially to produce correct final state", () => {
    let capturedFn: ((s: { count: number }) => Partial<{ count: number }>) | null = null;
    const setState = vi.fn((fn) => { capturedFn = fn; });
    const batch = createBatchedUpdater<{ count: number }>(setState);

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 10 }));

    vi.runAllTimers();
    const result = capturedFn!({ count: 0 });
    expect(result.count).toBe(11);
  });

  it("flushes immediately when queue exceeds max size", () => {
    const setState = vi.fn();
    const batch = createBatchedUpdater<{ count: number }>(setState, { maxQueueSize: 2 });

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));
    expect(setState).toHaveBeenCalledTimes(1);
  });
});
