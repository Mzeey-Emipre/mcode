import * as NodeV8 from "node:v8";

/** The memory measurement used to make server admission decisions. */
export type RuntimeMemoryMeasurement = {
  source: "v8-heap" | "process-rss";
  usedBytes: number;
  budgetBytes: number;
};

type V8HeapStats = Pick<
  ReturnType<typeof NodeV8.getHeapStatistics>,
  "used_heap_size" | "heap_size_limit"
>;

type ProcessMemoryRuntime = {
  readonly versions: Partial<NodeJS.ProcessVersions> & { readonly bun?: string };
  memoryUsage(): { rss: number };
};

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Measures memory with the limit that the active JavaScript runtime can support.
 * Bun's V8 compatibility values do not represent its JavaScriptCore heap, so Bun
 * admission uses whole-process RSS against the configured soft server budget.
 */
export function sampleRuntimeMemory(
  configuredBudgetMb: number,
  runtime: ProcessMemoryRuntime = process,
  getHeapStatistics: () => V8HeapStats = NodeV8.getHeapStatistics,
): RuntimeMemoryMeasurement {
  if (runtime.versions.bun !== undefined) {
    if (!Number.isSafeInteger(configuredBudgetMb) || configuredBudgetMb <= 0) {
      throw new RangeError("Server memory budget must be a positive integer number of MiB");
    }
    const usedBytes = runtime.memoryUsage().rss;
    if (!Number.isFinite(usedBytes) || usedBytes < 0) {
      throw new RangeError("Process RSS must be a finite non-negative byte count");
    }
    return {
      source: "process-rss",
      usedBytes,
      budgetBytes: configuredBudgetMb * BYTES_PER_MIB,
    };
  }

  const stats = getHeapStatistics();
  return {
    source: "v8-heap",
    usedBytes: Math.max(0, stats.used_heap_size),
    budgetBytes: Math.max(1, stats.heap_size_limit),
  };
}
