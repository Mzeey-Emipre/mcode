import {
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  createBrowserConformanceScenario,
  hashBrowserConformanceSeed,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceScenario,
  type BrowserConformanceSubject,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceCheckpoint,
} from "./model.js";
import {
  checkBrowserConformanceCleanup,
  createBrowserConformanceResourceSnapshot,
  type BrowserConformanceCleanupComparison,
} from "./cleanup.js";
import { normalizeBrowserConformanceRun } from "./normalize.js";
import { BrowserConformanceFaultController } from "./faults.js";

/** Shared-capability operations exercised by the web and Electron executors. */
export const BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS = [
  "inspect",
  "open",
  "act",
  "tabs",
] as const;

/** A named black-box executor scenario and its canonical operation allowlist. */
export interface BrowserConformanceExecutorScenario {
  readonly scenario: BrowserConformanceScenario;
  readonly operations: readonly typeof BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS[number][];
  readonly expected: BrowserConformanceNormalizedRun;
}

/** Failure context supplied after the shared runner has drained and disposed a subject. */
export interface BrowserConformanceExecutionFailure {
  readonly error: unknown;
  readonly run?: BrowserConformanceNormalizedRun;
  readonly baseline: ReturnType<BrowserConformanceSubject["snapshotResources"]>;
  readonly final: ReturnType<BrowserConformanceSubject["snapshotResources"]>;
  readonly cleanup: BrowserConformanceCleanupComparison;
}

/** Hooks used by the shared scenario core without changing its failure semantics. */
export interface BrowserConformanceExecutionOptions {
  readonly onFailure?: (failure: BrowserConformanceExecutionFailure) => Promise<void> | void;
  readonly faultController?: BrowserConformanceFaultController;
}

type StageAttempt<TValue> =
  | { readonly value: TValue; readonly error: undefined }
  | { readonly value: undefined; readonly error: unknown };

type TimelineEntry = BrowserConformanceScheduledEvent | BrowserConformanceCheckpoint;

type TimelineState = {
  readonly events: readonly BrowserConformanceScheduledEvent[];
  readonly checkpoints: readonly BrowserConformanceCheckpoint[];
  eventIndex: number;
  checkpointIndex: number;
  currentTick: number;
};

const EVENT_FAULT_STAGES: Partial<
  Record<BrowserConformanceScheduledEvent["kind"], "host-transport" | "target-registration" | "capability-revision">
> = {
  "host-disconnect": "host-transport",
  "host-reconnect": "host-transport",
  "target-register": "target-registration",
  "capability-revision": "capability-revision",
};

/** Executes one scenario on the canonical ordered timeline and enforces its cleanup contract. */
export async function runBrowserConformanceScenarioCore(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  options: BrowserConformanceExecutionOptions = {},
): Promise<BrowserConformanceNormalizedRun> {
  const baseline = subject.snapshotResources();
  let final = baseline;
  let cleanup: BrowserConformanceCleanupComparison = checkBrowserConformanceCleanup({ baseline }, baseline);
  const timeline = await attemptStage(() => executeBrowserConformanceTimeline(scenario, subject, options.faultController));
  const drained = await attemptStage(() => subject.drainToQuiescence());
  const disposed = await attemptStage(() => subject.dispose());
  const cleanupCapture = await attemptStage(() => captureCleanup(scenario, subject, options.faultController));
  if (cleanupCapture.value) {
    final = cleanupCapture.value.final;
    cleanup = cleanupCapture.value.cleanup;
  }
  options.faultController?.dispose();
  const failure = firstFailure(
    timeline.error,
    drained.error,
    disposed.error,
    cleanupCapture.error,
    cleanupCapture.value?.error,
  );
  if (failure !== undefined) {
    return reportAndThrowFailure(failure, timeline.value, subject, options.onFailure, baseline, final, cleanup);
  }
  return timeline.value ?? subject.snapshotOutcome();
}

async function attemptStage<TValue>(operation: () => Promise<TValue> | TValue): Promise<StageAttempt<TValue>> {
  try {
    return { value: await operation(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function captureCleanup(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  faultController: BrowserConformanceFaultController | undefined,
): { readonly final: ReturnType<BrowserConformanceSubject["snapshotResources"]>; readonly cleanup: BrowserConformanceCleanupComparison; readonly error: Error | undefined } {
  const final = subject.snapshotResources();
  faultController?.hit("cleanup");
  const cleanup = checkBrowserConformanceCleanup(scenario.cleanup, final);
  const error = cleanup.ok
    ? undefined
    : new Error(`Browser conformance cleanup failed: ${cleanup.violations.map((violation) => violation.resource).join(", ")}`);
  return { final, cleanup, error };
}

function firstFailure(...failures: readonly unknown[]): unknown {
  return failures.find((failure) => failure !== undefined);
}

async function reportAndThrowFailure(
  error: unknown,
  run: BrowserConformanceNormalizedRun | undefined,
  subject: BrowserConformanceSubject,
  onFailure: BrowserConformanceExecutionOptions["onFailure"],
  baseline: ReturnType<BrowserConformanceSubject["snapshotResources"]>,
  final: ReturnType<BrowserConformanceSubject["snapshotResources"]>,
  cleanup: BrowserConformanceCleanupComparison,
): Promise<never> {
  const observedRun = run ?? snapshotOutcome(subject);
  await reportFailure(onFailure, { error, ...(observedRun ? { run: observedRun } : {}), baseline, final, cleanup });
  throw error;
}

function snapshotOutcome(subject: BrowserConformanceSubject): BrowserConformanceNormalizedRun | undefined {
  try {
    return subject.snapshotOutcome();
  } catch {
    return undefined;
  }
}

async function reportFailure(
  onFailure: BrowserConformanceExecutionOptions["onFailure"],
  failure: BrowserConformanceExecutionFailure,
): Promise<void> {
  try {
    await onFailure?.(failure);
  } catch {
    // Failure reporting is observational and must not replace the scenario failure.
  }
}

/** Runs one adapter-neutral scenario through a real runtime subject. */
export async function runBrowserConformanceExecutorScenario(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  options: BrowserConformanceExecutionOptions = {},
): Promise<BrowserConformanceNormalizedRun> {
  return runBrowserConformanceScenarioCore(scenario, subject, options);
}

async function executeBrowserConformanceTimeline(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  faultController?: BrowserConformanceFaultController,
): Promise<BrowserConformanceNormalizedRun> {
  // Command N runs before scheduled work at tick N (ordinal >= 0).
  // That work therefore occurs after command N and before command N+1.
  const timeline = createTimelineState(scenario);
  for (const event of scenario.schedule.events) {
    faultController?.hit("scheduling");
    subject.schedule(event);
  }
  for (let index = 0; index < scenario.commands.length; index += 1) {
    await flushTimeline(subject, timeline, { tick: index, ordinal: -1 }, faultController);
    faultController?.hit("executor-dispatch");
    await subject.dispatch(scenario.commands[index]!);
    faultController?.hit("receipt-delivery");
  }
  await flushTimeline(
    subject,
    timeline,
    { tick: Math.max(timeline.currentTick, scenario.schedule.bounds.maxTick), ordinal: Number.MAX_SAFE_INTEGER },
    faultController,
  );
  return subject.snapshotOutcome();
}

function createTimelineState(scenario: BrowserConformanceScenario): TimelineState {
  return {
    events: [...scenario.schedule.events].sort(compareScheduledOrder),
    checkpoints: [...scenario.schedule.checkpoints].sort(compareScheduledOrder),
    eventIndex: 0,
    checkpointIndex: 0,
    currentTick: -1,
  };
}

async function flushTimeline(
  subject: BrowserConformanceSubject,
  timeline: TimelineState,
  limit: { readonly tick: number; readonly ordinal: number },
  faultController: BrowserConformanceFaultController | undefined,
): Promise<void> {
  while (hasPendingTimelineEntries(timeline)) {
    const entry = nextTimelineEntry(timeline);
    if (!entry || compareOrders(entry.order, limit) > 0) break;
    await advanceTimelineClock(subject, timeline, entry.order.tick, faultController);
    await processTimelineEntry(subject, timeline, entry, faultController);
  }
  await advanceTimelineClock(subject, timeline, limit.tick, faultController);
}

function hasPendingTimelineEntries(timeline: TimelineState): boolean {
  return timeline.eventIndex < timeline.events.length || timeline.checkpointIndex < timeline.checkpoints.length;
}

function nextTimelineEntry(timeline: TimelineState): TimelineEntry | undefined {
  const event = timeline.events[timeline.eventIndex];
  const checkpoint = timeline.checkpoints[timeline.checkpointIndex];
  if (!checkpoint) return event;
  if (!event) return checkpoint;
  return compareScheduledOrder(event, checkpoint) <= 0 ? event : checkpoint;
}

async function advanceTimelineClock(
  subject: BrowserConformanceSubject,
  timeline: TimelineState,
  tick: number,
  faultController: BrowserConformanceFaultController | undefined,
): Promise<void> {
  if (tick <= timeline.currentTick) return;
  faultController?.hit("clock");
  await subject.advanceClock(tick);
  timeline.currentTick = tick;
}

async function processTimelineEntry(
  subject: BrowserConformanceSubject,
  timeline: TimelineState,
  entry: TimelineEntry,
  faultController: BrowserConformanceFaultController | undefined,
): Promise<void> {
  if ("kind" in entry) {
    const stage = EVENT_FAULT_STAGES[entry.kind];
    if (stage) faultController?.hit(stage);
    await subject.injectExternalEvent(entry);
    timeline.eventIndex += 1;
    return;
  }
  faultController?.hit("checkpoint");
  assertCheckpoint(subject, entry);
  timeline.checkpointIndex += 1;
}

function compareScheduledOrder(
  left: BrowserConformanceScheduledEvent | BrowserConformanceCheckpoint,
  right: BrowserConformanceScheduledEvent | BrowserConformanceCheckpoint,
): number {
  return compareOrders(left.order, right.order);
}

function compareOrders(
  left: { readonly tick: number; readonly ordinal: number },
  right: { readonly tick: number; readonly ordinal: number },
): number {
  return left.tick - right.tick || left.ordinal - right.ordinal;
}

function assertCheckpoint(subject: BrowserConformanceSubject, checkpoint: BrowserConformanceCheckpoint): void {
  if (!checkpoint.expectedRevisions) return;
  const actual = subject.snapshotOutcome().finalState.revisions;
  for (const key of Object.keys(checkpoint.expectedRevisions) as Array<keyof typeof checkpoint.expectedRevisions>) {
    if (actual[key] !== checkpoint.expectedRevisions[key]) {
      throw new Error(`Browser conformance checkpoint failed: ${checkpoint.id}`);
    }
  }
}

/** Creates the deterministic shared executor scenario used by both app test runners. */
export function createBrowserExecutorParityScenario(): BrowserConformanceExecutorScenario {
  const commands: readonly BrowserConformanceCommand[] = [
    { id: "inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
    { id: "open", operation: "open", args: { url: "http://localhost:3000/next", idempotencyKey: "open-parity" } },
    {
      id: "act-navigate",
      operation: "act",
      args: {
        observationRef: "$lastObservationRef",
        deadlineMs: 10_000,
        steps: [{ operation: "navigate", url: "http://localhost:3000/final" }],
      },
    },
    { id: "inspect-after-navigation", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
    {
      id: "act-input",
      operation: "act",
      args: {
        observationRef: "$lastObservationRef",
        deadlineMs: 10_000,
        steps: [
          { operation: "click", target: { cssSelector: "#save" }, button: "left", clickCount: 2 },
          { operation: "type", target: { cssSelector: "#name" }, text: "Mcode", clear: true, submit: false },
        ],
      },
    },
    { id: "inspect-after-input", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
    {
      id: "tabs-claim",
      operation: "tabs",
      args: { action: "claim", tabId: "tab", observationRef: "$lastObservationRef", idempotencyKey: "tabs-parity" },
    },
  ];
  const seed = hashBrowserConformanceSeed("browser-executor-shared-capabilities");
  const scenario = createBrowserConformanceScenario({
    id: "browser-executor-shared-capabilities",
    seed: "browser-executor-shared-capabilities",
    commands,
    schedule: {
      version: BROWSER_CONFORMANCE_SCENARIO_VERSION,
      generatorVersion: "browser-v2-seeded-v1",
      seed,
      bounds: { maxCommands: commands.length, maxEvents: 0, maxCheckpoints: 0, maxTick: commands.length },
      events: [],
      checkpoints: [],
    },
    cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
  });
  const operations = BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS;
  const mutations = new Set(["open", "act", "tabs"]);
  const receipts = commands.map((command, index) => ({
    order: { tick: index, ordinal: index },
    commandId: command.id,
    operation: command.operation,
    status: "applied",
    effect: command.operation === "open" ? "created" : mutations.has(command.operation) ? "complete" : "none",
    recovery: command.operation === "act" ? "inspect" : "none",
    truncated: false,
    revisions: { host: 0, document: 0, control: 0, capability: 1, observation: index },
    errorCode: null,
    errorStage: command.operation === "inspect" ? "observation" : "effect",
    ownership: index === 0 ? "none" : "agent",
  }));
  const expected = normalizeBrowserConformanceRun({
    receipts,
    outcome: { status: "completed", effect: "complete", recovery: "none", revisions: { host: 0, document: 0, control: 0, capability: 1, observation: commands.length - 1 }, ownership: "agent" },
    finalState: { readiness: "ready", controlOwner: "agent", tabCount: 1, currentUrl: "http://localhost:3000/final", revisions: { host: 0, document: 0, control: 0, capability: 1, observation: commands.length - 1 }, resources: createBrowserConformanceResourceSnapshot({ identities: { targets: [{ id: "browser-target", generation: 1 }] } }) },
    visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: "agent", tabCount: 1, currentUrl: "http://localhost:3000/final", title: "Executor fixture", action: "tabs", truncated: false }],
  });
  return {
    scenario,
    operations,
    expected,
  };
}
