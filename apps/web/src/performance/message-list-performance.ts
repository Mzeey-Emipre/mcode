const performanceBuild =
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production";

const MAX_MESSAGE_LIST_PERFORMANCE_OBSERVATIONS = 10_000;

/** The performance-only MessageList stages collected by the frontend runner. */
export type MessageListPerformanceStage = "narrativeItemProjection" | "tanstackVirtualItems";

/** One bounded performance-only MessageList timing observation. */
export interface MessageListPerformanceObservation {
  readonly stage: MessageListPerformanceStage;
  readonly durationMs: number;
}

const observations: MessageListPerformanceObservation[] = [];

function boundedDuration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 60_000 ? value : null;
}

/** Returns whether the bundle runs under the maintained performance fixture. */
export function isMessageListPerformanceBuild(): boolean {
  return performanceBuild;
}

/** Runs a narrow MessageList stage and records its duration only in performance builds. */
export function measureMessageListPerformance<T>(
  stage: MessageListPerformanceStage,
  operation: () => T,
): T {
  if (!performanceBuild || observations.length >= MAX_MESSAGE_LIST_PERFORMANCE_OBSERVATIONS) {
    return operation();
  }
  const startedAt = performance.now();
  const result = operation();
  const durationMs = boundedDuration(performance.now() - startedAt);
  if (durationMs !== null) observations.push({ stage, durationMs });
  return result;
}

/** Clears MessageList performance observations at a fixture sample boundary. */
export function resetMessageListPerformanceObservations(): void {
  observations.length = 0;
}

/** Drains bounded MessageList performance observations from the current fixture sample. */
export function drainMessageListPerformanceObservations(): MessageListPerformanceObservation[] {
  return observations.splice(0, observations.length);
}
