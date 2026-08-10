import type { ProfilerOnRenderCallback } from "react";

/** Row-render strategy used by the issue 1242 throwaway prototype. */
export type NarrativePrototypeVariant = "current" | "zustand-targeted" | "legend";

/** Serializable render evidence captured by the issue 1242 throwaway prototype. */
export interface NarrativePrototypeSnapshot {
  variant: NarrativePrototypeVariant;
  commits: number;
  actualDurationMs: number;
  baseDurationMs: number;
  rowRenders: number;
  rowRendersByKey: Record<string, number>;
}

type MutableNarrativePrototypeMetrics = NarrativePrototypeSnapshot;

interface NarrativePrototypeApi {
  readonly variant: NarrativePrototypeVariant;
  reset(): void;
  snapshot(): NarrativePrototypeSnapshot;
}

declare global {
  interface Window {
    __issue1242?: NarrativePrototypeApi;
  }
}

/** Returns the prototype variant selected by the `narrativePrototype` query parameter. */
export function readNarrativePrototypeVariant(): NarrativePrototypeVariant {
  if (typeof window === "undefined") return "current";
  const value = new URLSearchParams(window.location.search).get("narrativePrototype");
  if (value === "zustand-targeted" || value === "legend") return value;
  return "current";
}

const variant = readNarrativePrototypeVariant();
const metrics: MutableNarrativePrototypeMetrics = createEmptyMetrics();

function createEmptyMetrics(): MutableNarrativePrototypeMetrics {
  return {
    variant,
    commits: 0,
    actualDurationMs: 0,
    baseDurationMs: 0,
    rowRenders: 0,
    rowRendersByKey: {},
  };
}

/** Records one narrative-row render for the selected prototype variant. */
export function recordNarrativePrototypeRowRender(rowKey: string): void {
  metrics.rowRenders += 1;
  metrics.rowRendersByKey[rowKey] = (metrics.rowRendersByKey[rowKey] ?? 0) + 1;
}

/** Records one React Profiler commit for the narrative container. */
export const recordNarrativePrototypeCommit: ProfilerOnRenderCallback = (
  _id,
  _phase,
  actualDuration,
  baseDuration,
) => {
  metrics.commits += 1;
  metrics.actualDurationMs += actualDuration;
  metrics.baseDurationMs += baseDuration;
};

function resetNarrativePrototypeMetrics(): void {
  Object.assign(metrics, createEmptyMetrics());
}

function snapshotNarrativePrototypeMetrics(): NarrativePrototypeSnapshot {
  return {
    ...metrics,
    rowRendersByKey: { ...metrics.rowRendersByKey },
  };
}

if (typeof window !== "undefined") {
  window.__issue1242 = {
    variant,
    reset: resetNarrativePrototypeMetrics,
    snapshot: snapshotNarrativePrototypeMetrics,
  };
}
