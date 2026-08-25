import {
  MAX_SHIKI_PERFORMANCE_DURATION_MS,
  MAX_SHIKI_PERFORMANCE_EPOCH_MS,
  MAX_SHIKI_PERFORMANCE_MEASUREMENTS,
  MAX_SHIKI_PERFORMANCE_RESPONSE_BYTES,
  type ShikiPerformanceObservation,
  type ShikiPerformancePhase,
  type ShikiRequestPhase,
  type ShikiWorkerTiming,
} from "./shiki-performance-contract";

const performanceBuild =
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production";

interface PendingShikiMeasurement {
  readonly requestStartedAtMs: number;
  phase: ShikiPerformancePhase | null;
  completed: boolean;
}

const observations: ShikiPerformanceObservation[] = [];
const pendingMeasurements = new Map<string, PendingShikiMeasurement>();
let captureEnabled = false;

function boundedDuration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= MAX_SHIKI_PERFORMANCE_DURATION_MS
    ? value
    : null;
}

function boundedResponseBytes(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SHIKI_PERFORMANCE_RESPONSE_BYTES
    ? value
    : null;
}

function validEpochTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SHIKI_PERFORMANCE_EPOCH_MS;
}

/** Computes worker-to-renderer delivery from the shared wall-clock boundary. */
export function calculateWorkerDeliveryDuration(
  responseReceivedAtEpochMs: number,
  workerPostedAtEpochMs: number,
): number | null {
  if (!validEpochTimestamp(responseReceivedAtEpochMs) || !validEpochTimestamp(workerPostedAtEpochMs)) {
    return null;
  }
  return boundedDuration(responseReceivedAtEpochMs - workerPostedAtEpochMs);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validPhase(value: unknown): value is ShikiRequestPhase {
  return value === "cold" || value === "warm";
}

function parseWorkerTiming(value: unknown): ShikiWorkerTiming | null {
  if (!isPlainObject(value)) return null;
  const expectedKeys = [
    "codeToHtmlMs",
    "grammarLoadMs",
    "highlighterCreationMs",
    "phase",
    "responseBytes",
    "workerPostedAtEpochMs",
    "workerStartupMs",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key, index) => actualKeys[index] !== key)
  ) {
    return null;
  }
  if (!validPhase(value.phase)) return null;
  const durationValues = [
    value.workerStartupMs,
    value.highlighterCreationMs,
    value.grammarLoadMs,
    value.codeToHtmlMs,
  ];
  if (durationValues.some((item) => typeof item !== "number" || boundedDuration(item) === null)) {
    return null;
  }
  if (typeof value.responseBytes !== "number" || boundedResponseBytes(value.responseBytes) === null) {
    return null;
  }
  if (typeof value.workerPostedAtEpochMs !== "number" || !validEpochTimestamp(value.workerPostedAtEpochMs)) {
    return null;
  }
  return value as unknown as ShikiWorkerTiming;
}

function pushObservation(observation: ShikiPerformanceObservation): void {
  if (observations.length >= MAX_SHIKI_PERFORMANCE_MEASUREMENTS * 12) return;
  observations.push(observation);
}

/** Returns whether the current build can emit Shiki measurements. */
export function isShikiPerformanceBuild(): boolean {
  return performanceBuild;
}

/** Enables or disables capture for the next fixture operation. */
export function setShikiPerformanceCapture(enabled: boolean): void {
  if (!performanceBuild) return;
  captureEnabled = enabled;
}

/** Returns whether a highlight request should carry measurement metadata. */
export function shouldMeasureShiki(): boolean {
  return performanceBuild && captureEnabled;
}

/** Clears observations and unfinished request metadata at a fixture boundary. */
export function resetShikiPerformanceObservations(): void {
  observations.length = 0;
  pendingMeasurements.clear();
}

/** Drains the bounded observations collected since the last reset. */
export function drainShikiPerformanceObservations(): ShikiPerformanceObservation[] {
  const drained = observations.splice(0, observations.length);
  pendingMeasurements.clear();
  return drained;
}

/** Starts renderer-side timing for one measured worker request. */
export function startShikiMeasurement(requestId: string, requestStartedAtMs: number): void {
  if (!shouldMeasureShiki()) return;
  if (pendingMeasurements.size >= MAX_SHIKI_PERFORMANCE_MEASUREMENTS) {
    const oldest = pendingMeasurements.keys().next().value;
    if (oldest) pendingMeasurements.delete(oldest);
  }
  pendingMeasurements.set(requestId, {
    requestStartedAtMs,
    phase: null,
    completed: false,
  });
}

/** Records bounded worker stages and the receive-boundary delivery duration. */
export function recordShikiWorkerTiming(
  requestId: string,
  value: unknown,
  responseReceivedAtMs: number,
  responseReceivedAtEpochMs: number,
): boolean {
  if (!shouldMeasureShiki()) return false;
  const measurement = pendingMeasurements.get(requestId);
  const timing = parseWorkerTiming(value);
  if (
    !measurement
    || !timing
    || !Number.isFinite(responseReceivedAtMs)
    || !validEpochTimestamp(responseReceivedAtEpochMs)
  ) return false;

  const deliveryDuration = calculateWorkerDeliveryDuration(
    responseReceivedAtEpochMs,
    timing.workerPostedAtEpochMs,
  );

  measurement.phase = timing.phase;
  if (timing.phase === "cold") {
    pushObservation({ phase: timing.phase, stage: "workerStartup", durationMs: timing.workerStartupMs });
  }
  pushObservation({ phase: timing.phase, stage: "highlighterCreation", durationMs: timing.highlighterCreationMs });
  pushObservation({ phase: timing.phase, stage: "grammarLoad", durationMs: timing.grammarLoadMs });
  pushObservation({ phase: timing.phase, stage: "codeToHtml", durationMs: timing.codeToHtmlMs });
  pushObservation({ phase: timing.phase, stage: "responseBytes", bytes: timing.responseBytes });
  if (deliveryDuration !== null) {
    pushObservation({ phase: timing.phase, stage: "workerDelivery", durationMs: deliveryDuration });
  }
  return true;
}

/**
 * Records Profiler commit, DOM insertion overhead, and request completion.
 * htmlInsertion is the bounded non-negative commit overhead after React render:
 * max(0, commitTime - startTime - actualDuration).
 */
export function recordShikiRendererCompletion(
  requestId: string,
  actualDurationMs: number,
  profilerStartTimeMs: number,
  commitTimeMs: number,
): void {
  if (!shouldMeasureShiki()) return;
  const measurement = pendingMeasurements.get(requestId);
  if (!measurement || measurement.completed || !measurement.phase) return;
  const reactCommit = boundedDuration(actualDurationMs);
  const htmlInsertion = boundedDuration(
    Math.max(0, commitTimeMs - profilerStartTimeMs - actualDurationMs),
  );
  const totalCompletion = boundedDuration(commitTimeMs - measurement.requestStartedAtMs);
  if (reactCommit === null || htmlInsertion === null || totalCompletion === null) return;
  measurement.completed = true;
  pushObservation({ phase: measurement.phase, stage: "reactCommit", durationMs: reactCommit });
  pushObservation({ phase: measurement.phase, stage: "htmlInsertion", durationMs: htmlInsertion });
  pushObservation({ phase: measurement.phase, stage: "totalCompletion", durationMs: totalCompletion });
  pendingMeasurements.delete(requestId);
}
