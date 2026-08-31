import type {
  BrowserAutomationErrorCode,
  BrowserAutomationOperation,
  BrowserAutomationResponse,
} from "@mcode/contracts";

/** Maximum content-free lifecycle events retained for local evidence. */
export const BROWSER_AUTOMATION_MAX_TELEMETRY_EVENTS = 2_048;
/** Maximum recent failure bundles retained for nightly evidence. */
export const BROWSER_AUTOMATION_MAX_FAILURE_BUNDLES = 64;

/** Browser lifecycle stages recorded without page or credential content. */
export type BrowserAutomationTelemetryStage =
  | "configuration"
  | "mcp-routing"
  | "admission"
  | "queueing"
  | "execution"
  | "page-waiting"
  | "settlement"
  | "receipt-delivery"
  | "cleanup";

/** Stable nightly failure classes from the Browser v2 release decision. */
export type BrowserAutomationFailureClass =
  | "user-takeover"
  | "capability-rejection"
  | "cross-origin-rejection"
  | "stale-observation-recovery"
  | "application-error"
  | "pre-effect-rejection"
  | "lost-transport"
  | "capability-mismatch"
  | "internal-exception"
  | "unknown-outcome";

/** Content-free lifecycle record accepted by the telemetry boundary. */
export interface BrowserAutomationTelemetryEvent {
  readonly timestampMs: number;
  readonly correlationId: string;
  readonly stage: BrowserAutomationTelemetryStage;
  readonly provider: string;
  readonly operation: BrowserAutomationOperation;
  readonly contractVersion: number;
  readonly runtime?: "electron" | "web";
  readonly capabilityRevision?: number;
  readonly connectionGeneration?: number;
  readonly targetGeneration?: number;
  readonly durationMs?: number;
  readonly outcome?: "accepted" | "queued" | "dispatched" | "waiting" | "completed" | "failed" | "interrupted";
  readonly errorCode?: BrowserAutomationErrorCode;
  readonly failureClass?: BrowserAutomationFailureClass;
  readonly expectedFailure?: boolean;
  readonly effect?: "none" | "partial" | "complete" | "created" | "closed" | "preserved" | "unknown";
  readonly recovery?: "none" | "retry" | "refresh" | "reopen" | "manual" | "inspect" | "wait" | "yield_to_user" | "do_not_retry";
  readonly takeover?: boolean;
  readonly settlement?: "complete" | "unknown";
}

/** One bounded, redacted failure bundle suitable for deterministic review. */
export interface BrowserAutomationFailureBundle {
  readonly correlationId: string;
  readonly provider: string;
  readonly runtime?: "electron" | "web";
  readonly operation: BrowserAutomationOperation;
  readonly contractVersion: number;
  readonly capabilityRevision?: number;
  readonly connectionGeneration?: number;
  readonly targetGeneration?: number;
  readonly durationMs: number;
  readonly errorCode?: BrowserAutomationErrorCode;
  readonly failureClass: BrowserAutomationFailureClass;
  readonly expected: boolean;
  readonly effect?: BrowserAutomationTelemetryEvent["effect"];
  readonly recovery?: BrowserAutomationTelemetryEvent["recovery"];
  readonly takeover: boolean;
  readonly settlement: "complete" | "unknown";
}

/** Zero-tolerance Browser v2 outcome counts used by the release gate. */
export interface BrowserAutomationZeroToleranceOutcomes {
  readonly falseSuccess: number;
  readonly postTakeoverEffect: number;
  readonly ambiguousOwnership: number;
  readonly staleMutation: number;
  readonly unknownOutcome: number;
  readonly sensitiveDataViolation: number;
}

/** Privacy-safe nightly evidence report for the current process. */
export interface BrowserAutomationNightlyEvidenceReport {
  readonly observedRequests: number;
  readonly successfulRequests: number;
  readonly expectedFailures: number;
  readonly unexpectedFailures: number;
  readonly unexpectedFailureRate: number;
  readonly classifiedFailures: Readonly<Partial<Record<BrowserAutomationFailureClass, number>>>;
  readonly zeroTolerance: BrowserAutomationZeroToleranceOutcomes;
  readonly retainedEvents: number;
  readonly recentFailures: readonly BrowserAutomationFailureBundle[];
}

/** Options for the bounded Browser lifecycle telemetry collector. */
export interface BrowserAutomationTelemetryOptions {
  readonly maxEvents?: number;
  readonly maxFailureBundles?: number;
  readonly sink?: (event: BrowserAutomationTelemetryEvent) => void;
}

const EXPECTED_FAILURE_CLASSES = new Set<BrowserAutomationFailureClass>([
  "user-takeover",
  "capability-rejection",
  "cross-origin-rejection",
  "stale-observation-recovery",
  "application-error",
  "pre-effect-rejection",
]);

const FAILURE_CLASSIFICATIONS = new Map<BrowserAutomationErrorCode, {
  failureClass: BrowserAutomationFailureClass;
  expected: boolean;
}>([
  ["HUMAN_INTERRUPTED", { failureClass: "user-takeover", expected: true }],
  ["OPERATION_CANCELLED", { failureClass: "application-error", expected: true }],
  ["UNSUPPORTED_OPERATION", { failureClass: "capability-rejection", expected: true }],
  ["FORBIDDEN", { failureClass: "capability-rejection", expected: true }],
  ["UNAUTHORIZED", { failureClass: "capability-rejection", expected: true }],
  ["CROSS_ORIGIN", { failureClass: "cross-origin-rejection", expected: true }],
  ["STALE_TARGET_GENERATION", { failureClass: "stale-observation-recovery", expected: true }],
  ["STALE_CONTROL_EPOCH", { failureClass: "stale-observation-recovery", expected: true }],
  ["CAPABILITY_CHANGED", { failureClass: "stale-observation-recovery", expected: true }],
  ["NAVIGATION_FAILED", { failureClass: "application-error", expected: true }],
  ["TARGET_NOT_FOUND", { failureClass: "application-error", expected: true }],
  ["RECORDING_NOT_ACTIVE", { failureClass: "application-error", expected: true }],
  ["TAB_UNAVAILABLE", { failureClass: "pre-effect-rejection", expected: true }],
  ["BROWSER_BUSY", { failureClass: "pre-effect-rejection", expected: true }],
  ["IDEMPOTENCY_CONFLICT", { failureClass: "pre-effect-rejection", expected: true }],
  ["HOST_UNAVAILABLE", { failureClass: "lost-transport", expected: false }],
  ["TIMEOUT", { failureClass: "lost-transport", expected: false }],
  ["DEADLINE_EXCEEDED", { failureClass: "lost-transport", expected: false }],
  ["INVALID_REQUEST", { failureClass: "capability-mismatch", expected: false }],
]);

const OPTIONAL_TELEMETRY_EVENT_FIELDS = [
  "runtime",
  "capabilityRevision",
  "connectionGeneration",
  "targetGeneration",
  "durationMs",
  "outcome",
  "errorCode",
  "failureClass",
  "expectedFailure",
  "effect",
  "recovery",
  "takeover",
  "settlement",
] as const;

const OPTIONAL_FAILURE_BUNDLE_FIELDS = [
  "runtime",
  "capabilityRevision",
  "connectionGeneration",
  "targetGeneration",
  "errorCode",
  "effect",
  "recovery",
] as const;

function sanitizeTelemetryEvent(event: BrowserAutomationTelemetryEvent): BrowserAutomationTelemetryEvent {
  const sanitized: BrowserAutomationTelemetryEvent = {
    timestampMs: event.timestampMs,
    correlationId: event.correlationId,
    stage: event.stage,
    provider: event.provider,
    operation: event.operation,
    contractVersion: event.contractVersion,
  };
  for (const field of OPTIONAL_TELEMETRY_EVENT_FIELDS) {
    const value = event[field];
    if (value !== undefined) (sanitized as unknown as Record<string, unknown>)[field] = value;
  }
  return sanitized;
}

/** Classifies one typed Browser failure without inspecting its message or page data. */
export function classifyBrowserAutomationFailure(
  code: BrowserAutomationErrorCode | undefined,
  effect: BrowserAutomationTelemetryEvent["effect"],
): { failureClass: BrowserAutomationFailureClass; expected: boolean } {
  if (effect === "unknown") return { failureClass: "unknown-outcome", expected: false };
  return code === undefined
    ? { failureClass: "internal-exception", expected: false }
    : FAILURE_CLASSIFICATIONS.get(code) ?? { failureClass: "internal-exception", expected: false };
}

/** Builds the terminal, content-free telemetry fields for one Browser response. */
export function browserAutomationTerminalFields(
  response: BrowserAutomationResponse,
): Pick<BrowserAutomationTelemetryEvent,
  "outcome" | "errorCode" | "failureClass" | "expectedFailure" | "effect" | "recovery" | "takeover" | "settlement"
> {
  if (!response.ok) {
    const effect = response.error.effect;
    const classification = classifyBrowserAutomationFailure(response.error.code, effect);
    return {
      outcome: response.error.code === "HUMAN_INTERRUPTED" || response.error.code === "OPERATION_CANCELLED"
        ? "interrupted"
        : "failed",
      errorCode: response.error.code,
      failureClass: classification.failureClass,
      expectedFailure: classification.expected,
      effect,
      recovery: response.error.recovery,
      takeover: response.error.code === "HUMAN_INTERRUPTED",
      settlement: effect === "unknown" ? "unknown" : "complete",
    };
  }

  const result = response.result;
  if ((result.operation === "act" || result.operation === "evaluate") && "outcome" in result) {
    if (result.outcome !== "completed") {
      const classification = result.outcome === "interrupted"
        ? { failureClass: "application-error" as const, expected: true }
        : { failureClass: "application-error" as const, expected: true };
      return {
        outcome: result.outcome,
        failureClass: classification.failureClass,
        expectedFailure: classification.expected,
        effect: result.effect,
        recovery: result.recovery,
        takeover: false,
        settlement: "complete",
      };
    }
    return {
      outcome: "completed",
      effect: result.effect,
      recovery: result.recovery,
      takeover: false,
      settlement: "complete",
    };
  }

  return { outcome: "completed", takeover: false, settlement: "complete" };
}

/** Retains bounded, privacy-safe Browser lifecycle evidence for nightly reports. */
export class BrowserAutomationTelemetry {
  private readonly events: BrowserAutomationTelemetryEvent[] = [];
  private readonly failures: BrowserAutomationFailureBundle[] = [];
  private readonly maxEvents: number;
  private readonly maxFailureBundles: number;
  private readonly sink?: (event: BrowserAutomationTelemetryEvent) => void;
  private observedRequests = 0;
  private successfulRequests = 0;
  private expectedFailures = 0;
  private unexpectedFailures = 0;
  private readonly classifiedFailures = new Map<BrowserAutomationFailureClass, number>();
  private falseSuccesses = 0;
  private postTakeoverEffects = 0;
  private ambiguousOwnership = 0;
  private staleMutations = 0;
  private unknownOutcomes = 0;

  constructor(options: BrowserAutomationTelemetryOptions = {}) {
    this.maxEvents = options.maxEvents ?? BROWSER_AUTOMATION_MAX_TELEMETRY_EVENTS;
    this.maxFailureBundles = options.maxFailureBundles ?? BROWSER_AUTOMATION_MAX_FAILURE_BUNDLES;
    this.sink = options.sink;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > BROWSER_AUTOMATION_MAX_TELEMETRY_EVENTS) {
      throw new RangeError("Browser telemetry event capacity is invalid");
    }
    if (!Number.isInteger(this.maxFailureBundles) || this.maxFailureBundles < 1 || this.maxFailureBundles > BROWSER_AUTOMATION_MAX_FAILURE_BUNDLES) {
      throw new RangeError("Browser telemetry failure capacity is invalid");
    }
  }

  /** Records one already-redacted Browser lifecycle event. */
  record(event: BrowserAutomationTelemetryEvent): void {
    const retained = Object.freeze(sanitizeTelemetryEvent(event));
    if (this.events.length >= this.maxEvents) this.events.shift();
    this.events.push(retained);
    try {
      this.sink?.(retained);
    } catch {
      // Observability must not change Browser request outcomes.
    }
    if (retained.stage !== "settlement") return;
    this.recordSettlement(retained);
  }

  private recordSettlement(retained: BrowserAutomationTelemetryEvent): void {
    this.observedRequests++;
    if (retained.outcome === "completed") {
      this.recordSuccessfulSettlement(retained);
      return;
    }
    if (!retained.failureClass) return;
    this.recordFailedSettlement(retained);
  }

  private recordSuccessfulSettlement(retained: BrowserAutomationTelemetryEvent): void {
    if (retained.failureClass) this.falseSuccesses++;
    this.successfulRequests++;
  }

  private recordFailedSettlement(retained: BrowserAutomationTelemetryEvent): void {
    const failureClass = retained.failureClass!;
    this.classifiedFailures.set(
      failureClass,
      (this.classifiedFailures.get(failureClass) ?? 0) + 1,
    );
    if (retained.expectedFailure ?? EXPECTED_FAILURE_CLASSES.has(failureClass)) this.expectedFailures++;
    else this.unexpectedFailures++;
    if (retained.takeover && retained.effect !== undefined && retained.effect !== "none") this.postTakeoverEffects++;
    this.recordFailureRiskCounters(retained, failureClass);
    this.appendFailureBundle(retained, failureClass);
  }

  private recordFailureRiskCounters(retained: BrowserAutomationTelemetryEvent, failureClass: BrowserAutomationFailureClass): void {
    if (retained.settlement === "unknown") {
      this.unknownOutcomes++;
      this.ambiguousOwnership++;
    }
    if (failureClass === "stale-observation-recovery" && retained.effect !== undefined && retained.effect !== "none") {
      this.staleMutations++;
    }
  }

  private appendFailureBundle(retained: BrowserAutomationTelemetryEvent, failureClass: BrowserAutomationFailureClass): void {
    const bundle: BrowserAutomationFailureBundle = {
      correlationId: retained.correlationId,
      provider: retained.provider,
      operation: retained.operation,
      contractVersion: retained.contractVersion,
      durationMs: retained.durationMs ?? 0,
      failureClass,
      expected: retained.expectedFailure ?? EXPECTED_FAILURE_CLASSES.has(failureClass),
      takeover: retained.takeover ?? false,
      settlement: retained.settlement ?? "complete",
    };
    for (const field of OPTIONAL_FAILURE_BUNDLE_FIELDS) {
      const value = retained[field];
      if (value !== undefined) (bundle as unknown as Record<string, unknown>)[field] = value;
    }
    if (this.failures.length >= this.maxFailureBundles) this.failures.shift();
    this.failures.push(Object.freeze(bundle));
  }

  /** Returns the bounded current-process nightly evidence report. */
  report(): BrowserAutomationNightlyEvidenceReport {
    return {
      observedRequests: this.observedRequests,
      successfulRequests: this.successfulRequests,
      expectedFailures: this.expectedFailures,
      unexpectedFailures: this.unexpectedFailures,
      unexpectedFailureRate: this.observedRequests === 0 ? 0 : this.unexpectedFailures / this.observedRequests,
      classifiedFailures: Object.fromEntries(this.classifiedFailures),
      zeroTolerance: {
        falseSuccess: this.falseSuccesses,
        postTakeoverEffect: this.postTakeoverEffects,
        ambiguousOwnership: this.ambiguousOwnership,
        staleMutation: this.staleMutations,
        unknownOutcome: this.unknownOutcomes,
        sensitiveDataViolation: 0,
      },
      retainedEvents: this.events.length,
      recentFailures: [...this.failures],
    };
  }
}
