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

/** Executes one scenario on the canonical ordered timeline and enforces its cleanup contract. */
export async function runBrowserConformanceScenarioCore(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  options: BrowserConformanceExecutionOptions = {},
): Promise<BrowserConformanceNormalizedRun> {
  const baseline = subject.snapshotResources();
  let run: BrowserConformanceNormalizedRun | undefined;
  let failure: unknown;
  let final = baseline;
  let cleanup: BrowserConformanceCleanupComparison = checkBrowserConformanceCleanup({ baseline }, baseline);

  try {
    run = await executeBrowserConformanceTimeline(scenario, subject, options.faultController);
  } catch (error) {
    failure = error;
  }

  try {
    await subject.drainToQuiescence();
  } catch (error) {
    if (failure === undefined) failure = error;
  }

  try {
    await subject.dispose();
  } catch (error) {
    if (failure === undefined) failure = error;
  }

  try {
    final = subject.snapshotResources();
    options.faultController?.hit("cleanup");
    cleanup = checkBrowserConformanceCleanup(scenario.cleanup, final);
    if (!cleanup.ok && failure === undefined) {
      const resources = cleanup.violations.map((violation) => violation.resource).join(", ");
      failure = new Error(`Browser conformance cleanup failed: ${resources}`);
    }
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  options.faultController?.dispose();

  if (failure !== undefined) {
    if (!run) {
      try {
        run = subject.snapshotOutcome();
      } catch {
        // A subject that cannot snapshot still preserves the original failure.
      }
    }
    try {
      await options.onFailure?.({ error: failure, ...(run ? { run } : {}), baseline, final, cleanup });
    } catch {
      // Failure reporting is observational and must never replace the scenario failure.
    }
    throw failure;
  }

  if (!run) run = subject.snapshotOutcome();
  return run;
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
  const events = [...scenario.schedule.events].sort(compareScheduledOrder);
  const checkpoints = [...scenario.schedule.checkpoints].sort(compareScheduledOrder);
  let eventIndex = 0;
  let checkpointIndex = 0;
  let currentTick = -1;
  for (const event of scenario.schedule.events) {
    faultController?.hit("scheduling");
    subject.schedule(event);
  }
  for (let index = 0; index < scenario.commands.length; index += 1) {
    await flushTimeline({ tick: index, ordinal: -1 });
    faultController?.hit("executor-dispatch");
    await subject.dispatch(scenario.commands[index]!);
    faultController?.hit("receipt-delivery");
  }
  await flushTimeline({ tick: Math.max(currentTick, scenario.schedule.bounds.maxTick), ordinal: Number.MAX_SAFE_INTEGER });
  return subject.snapshotOutcome();

  async function flushTimeline(limit: { readonly tick: number; readonly ordinal: number }): Promise<void> {
    while (eventIndex < events.length || checkpointIndex < checkpoints.length) {
      const nextEvent = events[eventIndex];
      const nextCheckpoint = checkpoints[checkpointIndex];
      const next = !nextCheckpoint || (nextEvent && compareScheduledOrder(nextEvent, nextCheckpoint) <= 0)
        ? nextEvent
        : nextCheckpoint;
      if (!next || compareOrders(next.order, limit) > 0) break;
      if (next.order.tick > currentTick) {
        faultController?.hit("clock");
        await subject.advanceClock(next.order.tick);
        currentTick = next.order.tick;
      }
      if (next === nextEvent) {
        if (nextEvent?.kind === "host-disconnect" || nextEvent?.kind === "host-reconnect") faultController?.hit("host-transport");
        if (nextEvent?.kind === "target-register") faultController?.hit("target-registration");
        if (nextEvent?.kind === "capability-revision") faultController?.hit("capability-revision");
        await subject.injectExternalEvent(nextEvent!);
        eventIndex += 1;
      } else {
        faultController?.hit("checkpoint");
        assertCheckpoint(subject, nextCheckpoint!);
        checkpointIndex += 1;
      }
    }
    if (limit.tick > currentTick) {
      faultController?.hit("clock");
      await subject.advanceClock(limit.tick);
      currentTick = limit.tick;
    }
  }
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
