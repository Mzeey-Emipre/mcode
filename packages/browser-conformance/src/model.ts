/** JSON values accepted by the adapter-neutral Browser conformance model. */
export type BrowserConformanceJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly BrowserConformanceJsonValue[]
  | { readonly [key: string]: BrowserConformanceJsonValue };

/** Browser operations that can appear in a conformance scenario. */
export const BROWSER_CONFORMANCE_OPERATIONS = [
  "status",
  "open",
  "inspect",
  "act",
  "tabs",
  "navigate",
  "resize",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "scroll",
  "waitFor",
  "console",
  "network",
  "accessibility",
  "performance",
  "evaluate",
  "recordingStart",
  "recordingStop",
] as const;

/** One operation identifier accepted by a Browser conformance command. */
export type BrowserConformanceOperation = (typeof BROWSER_CONFORMANCE_OPERATIONS)[number];

/** Revision dimensions whose changes invalidate different Browser authorities. */
export const BROWSER_CONFORMANCE_REVISION_KEYS = [
  "host",
  "document",
  "control",
  "capability",
  "observation",
] as const;

/** One revision dimension in the Browser authority vector. */
export type BrowserConformanceRevisionKey = (typeof BROWSER_CONFORMANCE_REVISION_KEYS)[number];

/** Monotonic Browser authority revisions captured at admission and receipts. */
export interface BrowserConformanceRevisionVector {
  readonly host: number;
  readonly document: number;
  readonly control: number;
  readonly capability: number;
  readonly observation: number;
}

/** Scenario schema version for serialized Browser conformance cases. */
export const BROWSER_CONFORMANCE_SCENARIO_VERSION = 1 as const;

/** Schedule generator version for deterministic replay compatibility. */
export const BROWSER_CONFORMANCE_GENERATOR_VERSION = "browser-v2-seeded-v1" as const;

/** Hard upper bound for commands, events, checkpoints, and total-order ordinals. */
export const BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS = 256;

/** Hard upper bound for virtual monotonic ticks in custom schedules. */
export const BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK = BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS * 4;

/** Virtual monotonic time and total-order position for scheduled work. */
export interface BrowserConformanceOrder {
  readonly tick: number;
  readonly ordinal: number;
}

/** Creates a zero-based initial Browser revision vector. */
export function createBrowserConformanceRevisionVector(
  revisions: Partial<BrowserConformanceRevisionVector> = {},
): BrowserConformanceRevisionVector {
  return {
    host: revisions.host ?? 0,
    document: revisions.document ?? 0,
    control: revisions.control ?? 0,
    capability: revisions.capability ?? 0,
    observation: revisions.observation ?? 0,
  };
}

/** A declarative Browser command independent of web or Electron transport. */
export interface BrowserConformanceCommand {
  readonly id: string;
  readonly operation: BrowserConformanceOperation;
  readonly args?: Readonly<Record<string, BrowserConformanceJsonValue>>;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
}

/** Events used to drive reviewed Browser races and revision invalidation. */
export const BROWSER_CONFORMANCE_EVENT_KINDS = [
  "host-disconnect",
  "host-reconnect",
  "target-register",
  "target-close",
  "cancel",
  "timeout",
  "lost-response",
  "late-response",
  "late-event",
  "late-timer",
  "user-takeover",
  "navigation",
  "reload",
  "resize",
  "competing-mutation",
  "capability-revision",
  "document-revision",
  "control-revision",
  "observation-revision",
  "cleanup",
] as const;

/** One scheduled race or fault event in a conformance scenario. */
export type BrowserConformanceEventKind = (typeof BROWSER_CONFORMANCE_EVENT_KINDS)[number];

/** A bounded event scheduled at a command-step boundary. */
export interface BrowserConformanceScheduledEvent {
  readonly order: BrowserConformanceOrder;
  readonly kind: BrowserConformanceEventKind;
  readonly revision?: BrowserConformanceRevisionKey;
  readonly payload?: Readonly<Record<string, BrowserConformanceJsonValue>>;
}

/** A named assertion point in a deterministic Browser schedule. */
export interface BrowserConformanceCheckpoint {
  readonly id: string;
  readonly order: BrowserConformanceOrder;
  readonly label: string;
  readonly expectedRevisions?: BrowserConformanceRevisionVector;
}

/** Explicit bounds carried with every generated Browser schedule. */
export interface BrowserConformanceScheduleBounds {
  readonly maxCommands: number;
  readonly maxEvents: number;
  readonly maxCheckpoints: number;
  readonly maxTick: number;
}

/** Deterministic schedule inputs and its ordered events/checkpoints. */
export interface BrowserConformanceSchedule {
  readonly version: typeof BROWSER_CONFORMANCE_SCENARIO_VERSION;
  readonly generatorVersion: typeof BROWSER_CONFORMANCE_GENERATOR_VERSION;
  readonly seed: number;
  readonly bounds: BrowserConformanceScheduleBounds;
  readonly events: readonly BrowserConformanceScheduledEvent[];
  readonly checkpoints: readonly BrowserConformanceCheckpoint[];
}

/** Stable logical identity and generation for one owned runtime resource. */
export interface BrowserConformanceResourceIdentity {
  readonly id: string;
  readonly generation: number;
}

/** Bounded resource counters owned by one Browser conformance scenario. */
export interface BrowserConformanceResourceSnapshot {
  readonly requests: number;
  readonly queues: number;
  readonly timers: number;
  readonly listeners: number;
  readonly heldInput: number;
  readonly controllerLeases: number;
  readonly targets: number;
  readonly replayEntries: number;
  readonly registries: number;
  readonly buffers: number;
  readonly identities: Readonly<Record<BrowserConformanceResourceKey, readonly BrowserConformanceResourceIdentity[]>>;
  readonly revisions: BrowserConformanceRevisionVector;
}

/** Resource counters included in cleanup baselines and declared bounds. */
export const BROWSER_CONFORMANCE_RESOURCE_KEYS = [
  "requests",
  "queues",
  "timers",
  "listeners",
  "heldInput",
  "controllerLeases",
  "targets",
  "replayEntries",
  "registries",
  "buffers",
] as const;

/** Resource dimensions accepted in a declared cleanup bound. */
export type BrowserConformanceResourceKey = (typeof BROWSER_CONFORMANCE_RESOURCE_KEYS)[number];

/** Maximum allowed growth over a cleanup baseline for selected resources. */
export type BrowserConformanceResourceBounds = Partial<
  Readonly<Record<BrowserConformanceResourceKey, number>>
>;

/** Expected cleanup contract for a scenario-owned resource snapshot. */
export interface BrowserConformanceCleanupInvariant {
  readonly baseline: BrowserConformanceResourceSnapshot;
  readonly allowedGrowth?: BrowserConformanceResourceBounds;
}

/** Stable outcome statuses shared by adapters and normalized receipts. */
export type BrowserConformanceOutcomeStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

/** Stable receipt statuses shared by Browser adapters. */
export type BrowserConformanceReceiptStatus =
  | "applied"
  | "satisfied"
  | "failed"
  | "interrupted"
  | "skipped"
  | "unknown";

/** Stable effect vocabulary retained by normalized Browser receipts. */
export type BrowserConformanceEffect =
  | "none"
  | "partial"
  | "complete"
  | "created"
  | "closed"
  | "preserved"
  | "unknown";

/** Stable recovery vocabulary retained by normalized Browser receipts. */
export type BrowserConformanceRecovery =
  | "none"
  | "retry"
  | "refresh"
  | "reopen"
  | "manual"
  | "inspect"
  | "wait"
  | "yield_to_user"
  | "do_not_retry"
  | "unknown";

/** Stable failure stage retained by normalized Browser receipts. */
export type BrowserConformanceErrorStage =
  | "validation"
  | "admission"
  | "dispatch"
  | "effect"
  | "observation"
  | "cleanup"
  | "unknown";

/** Stable ownership state retained by normalized receipts and final state. */
export type BrowserConformanceOwnership = "none" | "agent" | "user" | "shared" | "unknown";

/** One normalized, runtime-neutral Browser command receipt. */
export interface BrowserConformanceReceipt {
  readonly order: BrowserConformanceOrder;
  readonly commandId: string | null;
  readonly operation: BrowserConformanceOperation | "unknown";
  readonly status: BrowserConformanceReceiptStatus;
  readonly effect: BrowserConformanceEffect;
  readonly recovery: BrowserConformanceRecovery;
  readonly truncated: boolean;
  readonly revisions: BrowserConformanceRevisionVector;
  readonly errorCode: string | null;
  readonly errorStage: BrowserConformanceErrorStage;
  readonly ownership: BrowserConformanceOwnership;
}

/** Normalized run outcome with effects, recovery, truncation, and revisions. */
export interface BrowserConformanceOutcome {
  readonly status: BrowserConformanceOutcomeStatus;
  readonly effect: BrowserConformanceEffect;
  readonly recovery: BrowserConformanceRecovery;
  readonly truncated: boolean;
  readonly revisions: BrowserConformanceRevisionVector;
  readonly errorCode: string | null;
  readonly errorStage: BrowserConformanceErrorStage;
  readonly ownership: BrowserConformanceOwnership;
}

/** Readiness states exposed by the shared Browser product surface. */
export type BrowserConformanceReadiness =
  | "ready"
  | "host-unavailable"
  | "target-unavailable"
  | "recovering"
  | "human-control"
  | "unknown";

/** Ownership states visible while Browser control changes hands. */
export type BrowserConformanceControlOwner = BrowserConformanceOwnership;

/** A normalized visible observation without runtime-specific identifiers. */
export interface BrowserConformanceVisibleObservation {
  readonly surface: "browser" | "thread-overview" | "narrative" | "unknown";
  readonly readiness: BrowserConformanceReadiness;
  readonly controlOwner: BrowserConformanceControlOwner;
  readonly tabCount: number;
  readonly currentUrl: string | null;
  readonly title: string | null;
  readonly action: string | null;
  readonly truncated: boolean;
}

/** Normalized final state returned by a Browser adapter run. */
export interface BrowserConformanceFinalState {
  readonly readiness: BrowserConformanceReadiness;
  readonly controlOwner: BrowserConformanceControlOwner;
  readonly tabCount: number;
  readonly currentUrl: string | null;
  readonly revisions: BrowserConformanceRevisionVector;
  readonly resources: BrowserConformanceResourceSnapshot;
}

/** Complete normalized result used for differential web/Electron comparison. */
export interface BrowserConformanceNormalizedRun {
  readonly receipts: readonly BrowserConformanceReceipt[];
  readonly outcome: BrowserConformanceOutcome;
  readonly finalState: BrowserConformanceFinalState;
  readonly visibleObservations: readonly BrowserConformanceVisibleObservation[];
}

/** Dependency-inverted adapter port exercised by the shared conformance suite. */
export interface BrowserConformanceSubject {
  /** Dispatches one declarative command and returns its normalized receipt. */
  dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt>;
  /** Schedules one external event at its deterministic total-order position. */
  schedule(event: BrowserConformanceScheduledEvent): void;
  /** Advances the subject's virtual monotonic clock without wall-clock sleeps. */
  advanceClock(tick: number): Promise<void>;
  /** Injects one external event into the subject at the current virtual time. */
  injectExternalEvent(event: BrowserConformanceScheduledEvent): Promise<void>;
  /** Captures the normalized outcome and visible observations so far. */
  snapshotOutcome(): BrowserConformanceNormalizedRun;
  /** Captures owned resources for cleanup comparison. */
  snapshotResources(): BrowserConformanceResourceSnapshot;
  /** Waits for bounded quiescence after terminal work and late events. */
  drainToQuiescence(): Promise<void>;
  /** Releases subject-owned resources and listeners. */
  dispose(): Promise<void>;
}

/** Declarative adapter-neutral Browser v2 scenario. */
export interface BrowserConformanceScenario {
  readonly version: typeof BROWSER_CONFORMANCE_SCENARIO_VERSION;
  readonly generatorVersion: typeof BROWSER_CONFORMANCE_GENERATOR_VERSION;
  readonly id: string;
  readonly seed: number;
  readonly commands: readonly BrowserConformanceCommand[];
  readonly schedule: BrowserConformanceSchedule;
  readonly initialRevisions: BrowserConformanceRevisionVector;
  readonly cleanup: BrowserConformanceCleanupInvariant;
}

/** Inputs accepted when constructing a Browser conformance scenario. */
export interface BrowserConformanceScenarioInput {
  readonly id: string;
  readonly seed: number | string;
  readonly commands: readonly BrowserConformanceCommand[];
  readonly schedule?: BrowserConformanceSchedule;
  readonly initialRevisions?: Partial<BrowserConformanceRevisionVector>;
  readonly cleanup: BrowserConformanceCleanupInvariant;
}

/** Creates a bounded declarative Browser scenario from commands and a seed. */
export function createBrowserConformanceScenario(
  input: BrowserConformanceScenarioInput,
): BrowserConformanceScenario {
  const seed = typeof input.seed === "string" ? hashBrowserConformanceSeed(input.seed) : normalizeSeed(input.seed);
  const schedule = input.schedule ?? {
    version: BROWSER_CONFORMANCE_SCENARIO_VERSION,
    generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
    seed,
    bounds: { maxCommands: input.commands.length, maxEvents: 0, maxCheckpoints: 0, maxTick: 0 },
    events: [],
    checkpoints: [],
  };
  validateScenarioSchedule(schedule, seed, input.commands.length);
  validateRevisionVector(input.initialRevisions, "initial revisions");
  return {
    version: BROWSER_CONFORMANCE_SCENARIO_VERSION,
    generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
    id: input.id,
    seed,
    commands: input.commands,
    schedule,
    initialRevisions: createBrowserConformanceRevisionVector(input.initialRevisions),
    cleanup: input.cleanup,
  };
}

function validateScenarioSchedule(
  schedule: BrowserConformanceSchedule,
  seed: number,
  commandCount: number,
): void {
  if (!hasMatchingScheduleMetadata(schedule, seed)) {
    throw new RangeError("Browser conformance schedule metadata does not match the scenario");
  }
  if (exceedsScheduleBounds(schedule, commandCount)) {
    throw new RangeError("Browser conformance schedule exceeds its declared bounds");
  }
  const orders = new Set<string>();
  validateScheduledEvents(schedule, orders);
  validateScheduledCheckpoints(schedule, orders);
}

function hasMatchingScheduleMetadata(schedule: BrowserConformanceSchedule, seed: number): boolean {
  return schedule.version === BROWSER_CONFORMANCE_SCENARIO_VERSION
    && schedule.generatorVersion === BROWSER_CONFORMANCE_GENERATOR_VERSION
    && schedule.seed === seed;
}

function exceedsScheduleBounds(schedule: BrowserConformanceSchedule, commandCount: number): boolean {
  const { bounds } = schedule;
  if (commandCount > BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS || !hasValidScheduleBounds(bounds)) {
    return true;
  }
  return commandCount > bounds.maxCommands
    || schedule.events.length > bounds.maxEvents
    || schedule.checkpoints.length > bounds.maxCheckpoints;
}

function hasValidScheduleBounds(bounds: BrowserConformanceScheduleBounds): boolean {
  const values = [
    [bounds.maxCommands, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS],
    [bounds.maxEvents, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS],
    [bounds.maxCheckpoints, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS],
    [bounds.maxTick, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK],
  ] as const;
  return values.every(([value, maximum]) => isBound(value, maximum));
}

function validateScheduledEvents(schedule: BrowserConformanceSchedule, orders: Set<string>): void {
  for (const event of schedule.events) {
    validateOrder(event.order, schedule.bounds.maxTick, orders);
    if (!BROWSER_CONFORMANCE_EVENT_KINDS.includes(event.kind)) {
      throw new RangeError("Browser conformance event kind is invalid");
    }
    if (event.revision !== undefined && !BROWSER_CONFORMANCE_REVISION_KEYS.includes(event.revision)) {
      throw new RangeError("Browser conformance event revision is invalid");
    }
  }
}

function validateScheduledCheckpoints(schedule: BrowserConformanceSchedule, orders: Set<string>): void {
  for (const checkpoint of schedule.checkpoints) {
    validateOrder(checkpoint.order, schedule.bounds.maxTick, orders);
    if (checkpoint.id.length === 0 || checkpoint.label.length === 0) {
      throw new RangeError("Browser conformance checkpoint is invalid");
    }
    validateRevisionVector(checkpoint.expectedRevisions, "checkpoint revisions");
  }
}

function validateOrder(order: BrowserConformanceOrder, maxTick: number, orders: Set<string>): void {
  if (!isBound(order.tick, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK)
    || !isBound(order.ordinal, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS)
    || order.tick > maxTick) {
    throw new RangeError("Browser conformance schedule order is invalid");
  }
  const key = `${order.tick}:${order.ordinal}`;
  if (orders.has(key)) throw new RangeError("Browser conformance schedule order is not total");
  orders.add(key);
}

function validateRevisionVector(
  revisions: Partial<BrowserConformanceRevisionVector> | undefined,
  label: string,
): void {
  if (!revisions) return;
  for (const key of BROWSER_CONFORMANCE_REVISION_KEYS) {
    const value = revisions[key];
    if (value !== undefined && !isBound(value)) throw new RangeError(`${label} contains an invalid ${key} revision`);
  }
}

function isBound(value: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Normalizes a numeric seed into the deterministic unsigned range. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) throw new RangeError("Browser conformance seed must be finite");
  return (Math.trunc(seed) >>> 0) || 0x9e3779b9;
}

/** Hashes a textual seed into the deterministic unsigned range. */
export function hashBrowserConformanceSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 0x9e3779b9;
}
