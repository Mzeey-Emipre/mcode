/** Build-time measurement phases for Shiki attribution. */
export type ShikiPerformancePhase = "cold" | "warm" | "workload";

/** Request phase used by worker and renderer request observations. */
export type ShikiRequestPhase = Exclude<ShikiPerformancePhase, "workload">;

/** The worker contract is the producer; runner validation mirrors this serialized boundary. */
export interface ShikiWorkerTiming {
  readonly phase: ShikiRequestPhase;
  readonly workerStartupMs: number;
  readonly highlighterCreationMs: number;
  readonly grammarLoadMs: number;
  readonly codeToHtmlMs: number;
  readonly responseBytes: number;
  readonly workerPostedAtEpochMs: number;
}

/** Renderer observation emitted for one measured Shiki request. */
export interface ShikiPerformanceObservation {
  readonly phase: ShikiPerformancePhase;
  readonly stage:
    | "workerStartup"
    | "highlighterCreation"
    | "grammarLoad"
    | "codeToHtml"
    | "responseBytes"
    | "workerDelivery"
    | "reactCommit"
    | "htmlInsertion"
    | "style"
    | "layout"
    | "totalCompletion";
  readonly durationMs?: number;
  readonly bytes?: number;
}

/** Maximum duration retained from worker or renderer timing metadata. */
export const MAX_SHIKI_PERFORMANCE_DURATION_MS = 60_000;

/** Maximum response size retained from worker timing metadata. */
export const MAX_SHIKI_PERFORMANCE_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Latest accepted worker-to-renderer wall-clock timestamp. */
export const MAX_SHIKI_PERFORMANCE_EPOCH_MS = 4_102_444_800_000;

/** Maximum number of in-flight Shiki measurements retained by the renderer. */
export const MAX_SHIKI_PERFORMANCE_MEASUREMENTS = 256;
