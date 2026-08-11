import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPressureService } from "../memory-pressure-service.js";

const db = { pragma: vi.fn() } as unknown as import("better-sqlite3").Database;

describe("MemoryPressureService", () => {
  let service: MemoryPressureService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new MemoryPressureService(db);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it("emits warning and critical pressure levels from V8 heap ratios", () => {
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });

    service.markActive("thread-1");
    service.sampleActiveHeapForTest({ used_heap_size: 81, heap_size_limit: 100 });
    expect(service.currentPressure.level).toBe("warning");
    expect(() => service.assertCanStartTurn()).not.toThrow();

    service.sampleActiveHeapForTest({ used_heap_size: 91, heap_size_limit: 100 });
    expect(service.currentPressure.level).toBe("critical");
    expect(() => service.assertCanStartTurn({ used_heap_size: 91, heap_size_limit: 100 }))
      .toThrow(/Memory pressure is critical/);

    service.sampleActiveHeapForTest({ used_heap_size: 10, heap_size_limit: 100 });
    expect(service.currentPressure.level).toBe("normal");
    expect(levels).toEqual(expect.arrayContaining(["warning", "critical", "normal"]));
  });

  it("tracks per-turn high water and clears pressure after the last active turn", () => {
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveHeapForTest({ used_heap_size: 85, heap_size_limit: 100 });

    service.markIdle("thread-1");
    expect(service.currentPressure.level).toBe("warning");

    service.markIdle("thread-2");
    expect(service.currentPressure.level).toBe("normal");
  });

  it("notifies listeners when a turn becomes idle under sustained pressure", () => {
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveHeapForTest({ used_heap_size: 85, heap_size_limit: 100 });
    levels.length = 0;

    service.markIdle("thread-1");

    expect(service.currentPressure.level).toBe("warning");
    expect(levels).toEqual(["warning"]);
  });

  it("samples current heap before allowing a new turn", () => {
    service.markActive("thread-1");
    service.sampleActiveHeapForTest({ used_heap_size: 91, heap_size_limit: 100 });
    service.markIdle("thread-1");
    expect(service.currentPressure.level).toBe("normal");

    expect(() => service.assertCanStartTurn({ used_heap_size: 91, heap_size_limit: 100 }))
      .toThrow(/Memory pressure is critical/);
  });

  it("runs warm-idle reclamation after all turns finish", async () => {
    service.markActive("thread-1");
    service.markIdle("thread-1");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(db.pragma).toHaveBeenCalledWith("optimize");
    expect(db.pragma).toHaveBeenCalledWith("shrink_memory");
  });

  it("uses the background cache budget and restores the active budget", async () => {
    service.markIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    service.markBackground();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.pragma).toHaveBeenCalledWith("cache_size = -500");

    service.markForeground();
    expect(db.pragma).toHaveBeenCalledWith("cache_size = -2048");
  });
});
