import {
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  createBrowserConformanceScenario,
  hashBrowserConformanceSeed,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceScenario,
  type BrowserConformanceSubject,
} from "./model.js";
import { createBrowserConformanceResourceSnapshot } from "./cleanup.js";
import { normalizeBrowserConformanceRun } from "./normalize.js";

/** Shared-capability operations exercised by the web and Electron executors. */
export const BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS = [
  "inspect",
  "open",
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "act",
  "tabs",
] as const;

/** A named black-box executor scenario and its canonical operation allowlist. */
export interface BrowserConformanceExecutorScenario {
  readonly scenario: BrowserConformanceScenario;
  readonly operations: readonly typeof BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS[number][];
  readonly expected: BrowserConformanceNormalizedRun;
}

/** Runs one adapter-neutral scenario through a real runtime subject. */
export async function runBrowserConformanceExecutorScenario(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
): Promise<BrowserConformanceNormalizedRun> {
  try {
    for (const event of scenario.schedule.events) subject.schedule(event);
    for (let index = 0; index < scenario.commands.length; index += 1) {
      await subject.advanceClock(index);
      await subject.dispatch(scenario.commands[index]!);
    }
    await subject.drainToQuiescence();
    return subject.snapshotOutcome();
  } finally {
    await subject.dispose();
  }
}

/** Creates the deterministic shared executor scenario used by both app test runners. */
export function createBrowserExecutorParityScenario(): BrowserConformanceExecutorScenario {
  const commands: readonly BrowserConformanceCommand[] = [
    { id: "inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
    { id: "open", operation: "open", args: { url: "http://localhost:3000/next", idempotencyKey: "open-parity" } },
    { id: "navigate", operation: "navigate", args: { url: "http://localhost:3000/final" } },
    { id: "snapshot", operation: "snapshot", args: { includeScreenshot: false } },
    { id: "screenshot", operation: "screenshot", args: { fullPage: false, maxWidth: 320 } },
    {
      id: "click",
      operation: "click",
      args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1 },
    },
    {
      id: "type",
      operation: "type",
      args: { target: { cssSelector: "#name" }, text: "Mcode", clear: true, submit: false },
    },
    { id: "inspect-after-input", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
    {
      id: "act",
      operation: "act",
      args: {
        observationRef: "$lastObservationRef",
        deadlineMs: 10_000,
        steps: [{ operation: "click", target: { cssSelector: "#save" }, button: "left", clickCount: 1 }],
      },
    },
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
    cleanup: { baseline: createBrowserConformanceResourceSnapshot(), allowedGrowth: { targets: 1 } },
  });
  const operations = BROWSER_CONFORMANCE_SHARED_EXECUTOR_OPERATIONS;
  const mutations = new Set(["open", "navigate", "click", "type", "act", "tabs"]);
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
    errorStage: command.operation === "inspect" || command.operation === "snapshot" || command.operation === "screenshot" ? "observation" : "effect",
    ownership: index === 0 ? "none" : "agent",
  }));
  const expected = normalizeBrowserConformanceRun({
    receipts,
    outcome: { status: "completed", effect: "complete", recovery: "none", revisions: { host: 0, document: 0, control: 0, capability: 1, observation: commands.length - 1 }, ownership: "agent" },
    finalState: { readiness: "ready", controlOwner: "agent", tabCount: 1, currentUrl: "http://localhost:3000/final", revisions: { host: 0, document: 0, control: 0, capability: 1, observation: commands.length - 1 }, resources: { targets: 1, identities: { targets: [{ id: "browser-target", generation: 1 }] } } },
    visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: "agent", tabCount: 1, currentUrl: "http://localhost:3000/final", title: "Executor fixture", action: "tabs", truncated: false }],
  });
  return {
    scenario,
    operations,
    expected,
  };
}
