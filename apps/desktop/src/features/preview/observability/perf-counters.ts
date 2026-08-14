/**
 * Performance counters for the embedded preview / in-app browser.
 *
 * Counter set mirrors dpcode's `BrowserPerformanceSnapshot.counters`. We
 * increment from the hot paths (bounds sync, tab activate/close, eviction,
 * suspend timers) and surface a snapshot via desktopBridge so a dev-only HUD
 * can render the numbers. Counters are intentionally lightweight: plain
 * numeric fields, no histograms, mutated in-place inside the main process.
 */

import type { BrowserPerfCounters } from "@mcode/contracts";
export type { BrowserPerfCounters };

function newCounters(): BrowserPerfCounters {
  return {
    setPanelBoundsCalls: 0,
    setPanelBoundsNoopSkips: 0,
    setPanelBoundsViewportUpdates: 0,
    stateEmitCalls: 0,
    stateEmitSkips: 0,
    stateCloneCount: 0,
    runtimeSyncQueueFlushes: 0,
    syncRuntimeStateCalls: 0,
    inactiveTabSuspendScheduled: 0,
    inactiveTabSuspendCancelled: 0,
    inactiveTabBudgetEvictions: 0,
    warmInactiveRuntimeCount: 0,
  };
}

/** Module-singleton counters; reset only by tests. */
let counters = newCounters();

/** Return a defensive copy so callers cannot mutate the live bag. */
export function getPerfCounters(): BrowserPerfCounters {
  return { ...counters };
}

/** Reset all counters to zero. Tests call this in beforeEach. */
export function resetPerfCounters(): void {
  counters = newCounters();
}

/** Bump one counter by 1 (or by `by`). */
export function bumpPerf<K extends keyof BrowserPerfCounters>(key: K, by = 1): void {
  counters[key] += by;
}

/** Set a counter to an absolute value (used for gauges like warm-inactive-runtime-count). */
export function setPerf<K extends keyof BrowserPerfCounters>(key: K, value: number): void {
  counters[key] = value;
}
