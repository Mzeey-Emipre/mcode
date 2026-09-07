import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { MemoryPressureService } from "../memory-pressure-service.js";
import type { RuntimeMemoryMeasurement } from "../runtime-memory-sampler.js";

const db = { run: vi.fn() } as unknown as import("bun:sqlite").Database;

function settingsWithHeapBudget(getHeapMb: () => number) {
  return {
    get: () => ({
      ...getDefaultSettings(),
      server: { memory: { heapMb: getHeapMb() } },
    }),
  };
}

function v8Measurement(usedBytes: number, budgetBytes: number): RuntimeMemoryMeasurement {
  return { source: "v8-heap", usedBytes, budgetBytes };
}

describe("MemoryPressureService", () => {
  let service: MemoryPressureService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new MemoryPressureService(db, settingsWithHeapBudget(() => 512));
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("emits warning and critical pressure levels from V8 heap ratios", () => {
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });

    service.markActive("thread-1");
    service.sampleActiveMemoryForTest(v8Measurement(81, 100));
    expect(service.currentPressure.level).toBe("warning");
    expect(() => service.assertCanStartTurn(v8Measurement(81, 100))).not.toThrow();

    service.sampleActiveMemoryForTest(v8Measurement(91, 100));
    expect(service.currentPressure.level).toBe("critical");
    expect(() => service.assertCanStartTurn(v8Measurement(91, 100)))
      .toThrow(/Memory pressure is critical/);

    service.sampleActiveMemoryForTest(v8Measurement(10, 100));
    expect(service.currentPressure.level).toBe("normal");
    expect(levels).toEqual(expect.arrayContaining(["warning", "critical", "normal"]));
  });

  it("tracks per-turn high water and clears pressure after the last active turn", () => {
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));

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
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));
    levels.length = 0;

    service.markIdle("thread-1");

    expect(service.currentPressure.level).toBe("warning");
    expect(levels).toEqual(["warning"]);
  });

  it("samples current heap before allowing a new turn", () => {
    service.markActive("thread-1");
    service.sampleActiveMemoryForTest(v8Measurement(91, 100));
    service.markIdle("thread-1");
    expect(service.currentPressure.level).toBe("normal");

    expect(() => service.assertCanStartTurn(v8Measurement(91, 100)))
      .toThrow(/Memory pressure is critical/);
  });

  it("uses Bun RSS for thresholds, admission, recovery, and updated settings", async () => {
    let heapMb = 256;
    const initialBudgetBytes = heapMb * 1024 * 1024;
    let rss = Math.floor(initialBudgetBytes * 0.8);
    service.dispose();
    service = new MemoryPressureService(db, settingsWithHeapBudget(() => heapMb));
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, bun: "1.4.0" },
      memoryUsage: () => ({ rss }),
    });

    service.markActive("thread-1");
    expect(service.currentPressure.level).toBe("normal");

    rss = Math.ceil(initialBudgetBytes * 0.8);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure).toMatchObject({
      level: "warning",
      source: "process-rss",
      usedBytes: rss,
      budgetBytes: initialBudgetBytes,
    });
    expect(service.currentPressure.ratio).toBeGreaterThanOrEqual(0.8);

    rss = Math.ceil(initialBudgetBytes * 0.9);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure.level).toBe("critical");
    expect(service.currentPressure.ratio).toBeGreaterThanOrEqual(0.9);
    expect(() => service.assertCanStartTurn()).toThrow(/Memory pressure is critical/);

    heapMb = 512;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure.level).toBe("normal");
    expect(() => service.assertCanStartTurn()).not.toThrow();
    expect(levels).toEqual(["warning", "critical", "normal"]);
  });

  it("runs warm-idle reclamation after all turns finish", async () => {
    service.markActive("thread-1");
    service.markIdle("thread-1");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(db.run).toHaveBeenCalledWith("PRAGMA optimize");
    expect(db.run).toHaveBeenCalledWith("PRAGMA shrink_memory");
  });

  it("uses the background cache budget and restores the active budget", async () => {
    service.markIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    service.markBackground();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.run).toHaveBeenCalledWith("PRAGMA cache_size = -500");

    service.markForeground();
    expect(db.run).toHaveBeenCalledWith("PRAGMA cache_size = -2048");
  });
});
