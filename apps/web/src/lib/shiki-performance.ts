/** A bounded Shiki stage observation recorded by the performance workload. */
export interface ShikiPerformanceObservation {
  readonly stage:
    | "workerStartup"
    | "highlighterCreation"
    | "grammarLoad"
    | "codeToHtml"
    | "responseBytes"
    | "workerDelivery"
    | "reactCommit"
    | "htmlInsertion";
  readonly durationMs?: number;
  readonly value?: number;
}

/** Records Shiki attribution only in the maintained performance builds. */
export function recordShikiPerformance(
  observation: ShikiPerformanceObservation,
): void {
  if (!isShikiPerformanceEnabled()) return;
  window.__mcodeShikiPerformanceSink?.record(observation);
}

/** Returns whether the renderer was built for the maintained performance workload. */
export function isShikiPerformanceEnabled(): boolean {
  return import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
    import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production";
}

declare global {
  interface Window {
    __mcodeShikiPerformanceSink?: {
      record(observation: ShikiPerformanceObservation): void;
    };
  }
}
