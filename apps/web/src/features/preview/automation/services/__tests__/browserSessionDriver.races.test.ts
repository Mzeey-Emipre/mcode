import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationResponseSchema,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import {
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  createBrowserConformanceScenario,
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceSchedule,
  createBrowserConformanceRevisionRaceSchedules,
  normalizeBrowserConformanceRun,
  runBrowserConformanceScenarioWithReplay,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceReceipt,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceSubject,
} from "@mcode/browser-conformance";
import { executeWebBrowserDispatch } from "../../browserAutomationWebExecutor";
import { BrowserSessionDriver } from "../browserSessionDriver";
import { WebBrowserSessionAdapter } from "../webBrowserSessionAdapter";

const replayRoots: string[] = [];

afterEach(async () => {
  await Promise.all(replayRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TARGET = {
  desktopInstanceId: "web",
  windowId: 1,
  connectionGeneration: 1,
  threadId: "thread",
  tabId: "tab",
  targetGeneration: 1,
  active: true,
  focused: true,
  lastUsedAt: 0,
} as const;

type BrowserMutationCounters = { clicks: number; inputs: number; navigations: number };

describe("BrowserSessionDriver deterministic races", () => {
  it("executes every revision schedule through the real WebBrowserSessionAdapter and rejects stale effects", async () => {
    document.body.innerHTML = `<iframe data-thread-id="thread" data-tab-id="tab" src="about:blank"></iframe><button id="save">Save</button><input id="name" />`;
    const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: document });
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const input = document.querySelector<HTMLInputElement>("#name")!;
    Object.defineProperty(button, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    Object.defineProperty(input, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    const mutationCounters: BrowserMutationCounters = { clicks: 0, inputs: 0, navigations: 0 };
    const observerDisposers = new Set<() => void>();
    button.addEventListener("click", () => { mutationCounters.clicks += 1; });
    input.addEventListener("input", () => { mutationCounters.inputs += 1; });
    iframe.addEventListener("load", () => { mutationCounters.navigations += 1; });
    let releaseOpen: (() => void) | undefined;
    let deferOpen = false;
    let abortCurrent: (() => void) | undefined;
    let abortAfterFirstClick = false;
    const revisions = { host: 1, document: 1, control: 0, capability: 1, observation: 0 };
    let liveTargets = new Map<string, typeof TARGET>([["tab", TARGET]]);
    const adapter = new WebBrowserSessionAdapter({
      resolveDocument: () => document,
      resolveSignal: (_dispatch, signal) => signal,
      getControlEpoch: () => revisions.control,
      getTargetGeneration: () => revisions.document,
      onHumanInput: vi.fn(),
      onObserver: (_dispatch, dispose) => {
        const wrappedDispose = () => {
          observerDisposers.delete(wrappedDispose);
          dispose();
        };
        observerDisposers.add(wrappedDispose);
      },
      executeNonInteraction: async (dispatch, signal) => {
        if (deferOpen && dispatch.request.operation === "open") {
          return new Promise<Awaited<ReturnType<typeof executeWebBrowserDispatch>>>((resolve) => {
            releaseOpen = () => resolve(executeWebBrowserDispatch(dispatch, signal));
          });
        }
        const response = executeWebBrowserDispatch(dispatch, signal);
        if (dispatch.request.operation === "open" || dispatch.request.operation === "navigate") iframe.dispatchEvent(new Event("load"));
        return response;
      },
    });
    const runtimeAdapter = {
      execute: async (dispatch: BrowserAutomationHostDispatch, signal: AbortSignal) => {
        const response = await adapter.execute(dispatch, signal);
        if (abortAfterFirstClick && dispatch.request.operation === "click") abortCurrent?.();
        return response;
      },
    };
    const driver = new BrowserSessionDriver({
      web: runtimeAdapter,
      electron: runtimeAdapter,
      isElectron: () => false,
      getHostRevision: () => revisions.host,
      getDocumentRevision: () => revisions.document,
      getControlRevision: () => revisions.control,
      getCapabilityRevision: () => revisions.capability,
      supportedActOperations: ["click", "navigate"],
      webTabs: {
        list: async () => [...liveTargets.values()],
        close: async (target) => { liveTargets.delete(target.tabId); },
      },
    });

    const generated = createBrowserConformanceRevisionRaceSchedules({
      seed: "web-driver-revision-races",
      maxCommands: 4,
      maxEvents: 8,
      maxCheckpoints: 4,
      maxTick: 0,
    });
    const schedules = [
      ...Object.values(generated.individual),
      ...generated.pairs,
      ...generated.highRisk,
    ];
    const replayRoot = await mkdtemp(join(tmpdir(), "mcode-web-browser-races-"));
    replayRoots.push(replayRoot);
    for (const generatedSchedule of schedules) {
      revisions.host = 1;
      revisions.document = 1;
      revisions.control = 0;
      revisions.capability = 1;
      liveTargets = new Map([["tab", TARGET]]);
      const subject = new WebDriverRaceSubject(driver, revisions, liveTargets, {
        host: 0,
        document: 0,
        control: 0,
        capability: 0,
        observation: 0,
      }, mutationCounters, observerDisposers);
      await subject.dispatch({ id: "open", operation: "open", args: { idempotencyKey: `open-${generatedSchedule.id}` } });
      const scenario = createBrowserConformanceScenario({
        id: `web-driver-${generatedSchedule.id}`,
        seed: generatedSchedule.schedule.seed,
        commands: [
          { id: "inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
          {
            id: "act",
            operation: "act",
            args: {
              observationRef: "$lastObservationRef",
              deadlineMs: 10_000,
              steps: [{ operation: "click", target: { cssSelector: "#save" } }],
            },
          },
        ],
        schedule: generatedSchedule.schedule,
        cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
      });
      const run = await runBrowserConformanceScenarioWithReplay(scenario, subject, {
        workspaceRoot: replayRoot,
        fileName: `web-${generatedSchedule.id}.json`,
        failingInvariant: "web BrowserSessionDriver seeded revision schedule remains bounded",
      });
      expect(run.outcome.status, generatedSchedule.id).not.toBe("unknown");
      expect(run.finalState.resources.targets, generatedSchedule.id).toBe(1);
      expect(run.finalState.resources.requests, generatedSchedule.id).toBeGreaterThan(0);
      expect(run.receipts.every((receipt) => receipt.status !== "unknown" && receipt.effect !== "unknown" && receipt.recovery !== "unknown"), generatedSchedule.id).toBe(true);
      const terminalReceipt = run.receipts.at(-1);
      expect(terminalReceipt?.status, generatedSchedule.id).toBe("failed");
      expect(terminalReceipt?.errorCode, generatedSchedule.id).toBe(
        generatedSchedule.revisions.includes("capability") ? "CAPABILITY_CHANGED" : "STALE_TARGET_GENERATION",
      );
      expect(terminalReceipt?.effect, generatedSchedule.id).toBe("none");
      expect(subject.mutationSnapshotBeforeAct(), generatedSchedule.id).toEqual(mutationCounters);
      expect(subject.snapshotResources(), generatedSchedule.id).toEqual(createBrowserConformanceResourceSnapshot());
    }
    revisions.host = 1;
    revisions.document = 1;
    revisions.control = 0;
    revisions.capability = 1;
    liveTargets = new Map([["tab", TARGET]]);
    const bootstrap = new WebDriverRaceSubject(driver, revisions, liveTargets);
    deferOpen = true;
    const firstOpen = bootstrap.dispatch({ id: "bootstrap-open-a", operation: "open", args: { idempotencyKey: "bootstrap-a" } });
    await Promise.resolve();
    const concurrent = await bootstrap.dispatch({ id: "bootstrap-open-b", operation: "open", args: { idempotencyKey: "bootstrap-b" } });
    expect(concurrent.errorCode, "bootstrap-concurrent-open").toBe("BROWSER_BUSY");
    expect(concurrent.status).not.toBe("unknown");
    expect(concurrent.effect).not.toBe("unknown");
    expect(concurrent.recovery).not.toBe("unknown");
    releaseOpen?.();
    deferOpen = false;
    expect((await firstOpen).status).toBe("applied");
    const replay = await bootstrap.dispatch({ id: "bootstrap-replay", operation: "open", args: { idempotencyKey: "bootstrap-a" } });
    expect(replay.status, "bootstrap-idempotent-replay").toBe("applied");
    expect(replay.effect).not.toBe("unknown");
    const conflict = await bootstrap.dispatch({ id: "bootstrap-conflict", operation: "open", args: { idempotencyKey: "bootstrap-a", url: "https://other.test/" } });
    expect(conflict.errorCode, "bootstrap-idempotent-replay").toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.status).not.toBe("unknown");
    expect(conflict.effect).not.toBe("unknown");
    expect(conflict.recovery).not.toBe("unknown");
    await bootstrap.dispose();

    revisions.control = 0;
    liveTargets = new Map([["tab", TARGET]]);
    const action = new WebDriverRaceSubject(driver, revisions, liveTargets);
    await action.dispatch({ id: "action-open", operation: "open", args: { idempotencyKey: "action-open" } });
    await action.dispatch({ id: "action-inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
    abortAfterFirstClick = true;
    const abortingAction = action;
    abortCurrent = () => abortingAction.abortCurrent();
    const takeover = await action.dispatch({ id: "action-takeover", operation: "act", args: { observationRef: action.observationRef ?? "missing-observation", deadlineMs: 10_000, steps: [{ operation: "click", target: { cssSelector: "#save" } }, { operation: "click", target: { cssSelector: "#save" } }] } });
    abortAfterFirstClick = false;
    abortCurrent = undefined;
    if (!action.lastResponse?.ok) throw new Error(JSON.stringify(action.lastResponse));
    expect(action.lastResponse, "action-takeover/action-cancel").toMatchObject({ ok: true, result: { outcome: "interrupted", effect: "partial", receipts: [{ status: "applied" }, { status: "interrupted" }] } });
    expect(takeover.status).not.toBe("unknown");
    expect(takeover.effect).not.toBe("unknown");
    expect(takeover.recovery).not.toBe("unknown");
    await action.dispose();

    revisions.control = 0;
    liveTargets = new Map([["tab", TARGET]]);
    const batch = new WebDriverRaceSubject(driver, revisions, liveTargets);
    await batch.dispatch({ id: "batch-open", operation: "open", args: { idempotencyKey: "batch-open" } });
    await batch.dispatch({ id: "batch-inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
    const navigation = await batch.dispatch({ id: "batch-navigation", operation: "act", args: { observationRef: batch.observationRef ?? "missing-observation", deadlineMs: 10_000, steps: [{ operation: "click", target: { cssSelector: "#save" } }, { operation: "navigate", url: `${window.location.origin}/next` }, { operation: "click", target: { cssSelector: "#save" } }] } });
    expect(batch.lastResponse, "batch-navigation/batch-partial-failure").toMatchObject({ ok: true, result: { outcome: "completed", receipts: [{ status: "applied" }, { status: "applied" }, { status: "skipped" }] } });
    expect(navigation.status).not.toBe("unknown");
    expect(navigation.effect).not.toBe("unknown");
    expect(navigation.recovery).not.toBe("unknown");
    await batch.dispose();
    const exercisedRaceIds = new Set<string>();
    for (const race of BROWSER_CONFORMANCE_RACE_CATALOGUE) {
      revisions.host = 1;
      revisions.document = 1;
      revisions.control = 0;
      revisions.capability = 1;
      liveTargets = new Map([["tab", TARGET]]);
      const raceSubject = new WebDriverRaceSubject(driver, revisions, liveTargets, {
        host: 0,
        document: 0,
        control: 0,
        capability: 0,
        observation: 0,
      }, mutationCounters, observerDisposers);
      await raceSubject.dispatch({ id: `${race.id}-open`, operation: "open", args: { idempotencyKey: `${race.id}-open` } });
      const schedule = createBrowserConformanceSchedule({
        seed: race.id,
        maxCommands: 2,
        maxEvents: race.events.length,
        maxCheckpoints: 0,
        maxTick: 0,
        eventCount: 0,
      });
      const scenario = createBrowserConformanceScenario({
        id: `web-catalogue-${race.id}`,
        seed: race.id,
        commands: [
          { id: `${race.id}-inspect`, operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
          {
            id: `${race.id}-act`,
            operation: "act",
            args: {
              observationRef: "$lastObservationRef",
              deadlineMs: 10_000,
              steps: [{ operation: "click", target: { cssSelector: "#save" } }],
            },
          },
        ],
        schedule: {
          ...schedule,
          events: race.events.map((kind, ordinal) => ({ order: { tick: 0, ordinal }, kind } as BrowserConformanceScheduledEvent)),
        },
        cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
      });
      const run = await runBrowserConformanceScenarioWithReplay(scenario, raceSubject, {
        workspaceRoot: replayRoot,
        fileName: `web-catalogue-${race.id}.json`,
        failingInvariant: race.invariant,
      });
      expect(run.outcome.status, race.id).not.toBe("unknown");
      expect(run.finalState.resources.requests, race.id).toBeGreaterThan(0);
      expect(run.receipts.every((receipt) => receipt.status !== "unknown" && receipt.effect !== "unknown" && receipt.recovery !== "unknown"), race.id).toBe(true);
      if (race.id === "bootstrap-idempotent-replay") expect(run.finalState.resources.listeners, race.id).toBeGreaterThan(0);
      expect(raceSubject.snapshotResources().listeners, race.id).toBe(0);
      exercisedRaceIds.add(race.id);
    }
    expect(exercisedRaceIds).toEqual(new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.id)));
  });

});

class WebDriverRaceSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly scheduled: BrowserConformanceScheduledEvent[] = [];
  private readonly requestLeases = new Set<string>();
  private readonly timerLeases = new Set<number>();
  private readonly heldInputLeases = new Set<string>();
  private readonly controllerLeases = new Set<string>();
  private readonly replayEntries = new Map<string, string>();
  private readonly registryEntries = new Map<string, string>();
  private readonly bufferEntries = new Set<string>();
  private readonly mutationCounters?: BrowserMutationCounters;
  private readonly observerDisposers?: Set<() => void>;
  private preActMutationCounters: BrowserMutationCounters | undefined;
  private tick = 0;
  private disposed = false;
  private activeController: AbortController | undefined;
  observationRef: string | undefined;
  lastResponse: Awaited<ReturnType<BrowserSessionDriver["execute"]>> | undefined;

  constructor(
    private readonly driver: BrowserSessionDriver,
    private readonly revisions: { host: number; document: number; control: number; capability: number; observation: number },
    private readonly liveTargets: Map<string, typeof TARGET>,
    observedRevisions = { ...revisions },
    mutationCounters?: BrowserMutationCounters,
    observerDisposers?: Set<() => void>,
  ) {
    this.observedRevisions = observedRevisions;
    this.mutationCounters = mutationCounters;
    this.observerDisposers = observerDisposers;
  }

  private readonly observedRevisions: { host: number; document: number; control: number; capability: number; observation: number };

  private bumpRevision(key: keyof typeof this.revisions): void {
    this.revisions[key] += 1;
    this.observedRevisions[key] += 1;
  }

  abortCurrent(): void { this.activeController?.abort(); }

  mutationSnapshotBeforeAct(): BrowserMutationCounters | undefined {
    return this.preActMutationCounters;
  }

  schedule(event: BrowserConformanceScheduledEvent): void {
    this.scheduled.push(event);
  }
  async advanceClock(tick: number): Promise<void> {
    this.tick = tick;
    this.timerLeases.add(tick);
  }
  async injectExternalEvent(event: BrowserConformanceScheduledEvent): Promise<void> {
    if (this.disposed) return;
    switch (event.kind) {
      case "host-disconnect":
      case "host-reconnect":
        this.bumpRevision("host");
        break;
      case "navigation":
      case "reload":
      case "document-revision":
      case "target-register":
        this.bumpRevision("document");
        break;
      case "user-takeover":
      case "competing-mutation":
      case "cancel":
      case "timeout":
      case "resize":
      case "control-revision":
        this.bumpRevision("control");
        break;
      case "capability-revision":
        this.bumpRevision("capability");
        break;
      case "observation-revision":
        this.driver.invalidateTargetObservations("workspace", "thread", "tab");
        this.bumpRevision("observation");
        break;
      case "late-event":
      case "late-timer":
      case "late-response":
      case "lost-response":
        // Late responses carry no new authority revision and disposed callbacks stay inert.
        break;
      case "target-close":
        this.driver.clearIdempotencyForTarget("workspace", "thread", "tab");
        this.liveTargets.delete("tab");
        this.bumpRevision("document");
        break;
      default:
        this.bumpRevision("control");
        break;
    }
  }

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    if (command.operation === "act" && this.mutationCounters) this.preActMutationCounters = { ...this.mutationCounters };
    const requestKey = `${command.id}:${this.receipts.length}`;
    this.requestLeases.add(requestKey);
    this.bufferEntries.add(requestKey);
    this.registryEntries.set("provider-session", "active");
    if (command.operation === "act") {
      this.heldInputLeases.add(requestKey);
      this.controllerLeases.add(requestKey);
    }
    const operation = command.operation;
    const args = { ...(command.args ?? {}) } as Record<string, unknown>;
    if (operation === "act") args.observationRef = this.observationRef ?? "missing-observation";
    const dispatch = {
      connection: { desktopInstanceId: "web", windowId: 1, connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: { ...TARGET, connectionGeneration: 1, targetGeneration: 1 },
      request: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
        requestId: `race-${command.id}-${this.receipts.length}`, sequence: this.receipts.length, deadline: 4_000_000_000_000,
        expectedControlEpoch: 0, operation, args,
      },
    } as unknown as BrowserAutomationHostDispatch;
    const controller = new AbortController();
    this.activeController = controller;
    let response: Awaited<ReturnType<BrowserSessionDriver["execute"]>>;
    try {
      response = BrowserAutomationResponseSchema().parse(await this.driver.execute(dispatch, controller.signal));
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
    this.lastResponse = response;
    if (response.ok) {
      const result = response.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
      this.observationRef = result.nextObservationRef ?? result.finalObservation?.observationRef ?? result.observationRef ?? this.observationRef;
      if (this.observationRef) this.replayEntries.set(this.observationRef, requestKey);
      if (operation === "open") this.liveTargets.set("tab", TARGET);
    }
    const receipt = normalizeBrowserConformanceRun({ receipts: [{
      order: { tick: this.tick, ordinal: this.receipts.length }, commandId: command.id, operation,
      status: response.ok ? "applied" : "failed", effect: response.ok ? "complete" : response.error.effect,
      recovery: response.ok ? "none" : response.error.recovery, errorCode: response.ok ? null : response.error.code,
      errorStage: response.ok ? "effect" : response.error.stage, ownership: response.ok ? "agent" : "none",
      revisions: this.observedRevisions,
    }] }).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }

  snapshotOutcome(): BrowserConformanceNormalizedRun {
    return normalizeBrowserConformanceRun({ receipts: this.receipts, outcome: { status: this.receipts.at(-1)?.status === "failed" ? "failed" : "completed", effect: this.receipts.at(-1)?.effect ?? "none", recovery: this.receipts.at(-1)?.recovery ?? "none", revisions: this.observedRevisions, ownership: this.receipts.at(-1)?.ownership ?? "none" }, finalState: { readiness: this.disposed ? "target-unavailable" : "ready", controlOwner: this.receipts.at(-1)?.ownership ?? "none", tabCount: this.liveTargets.size, currentUrl: null, revisions: this.observedRevisions, resources: this.snapshotResources() } });
  }
  snapshotResources(): BrowserConformanceResourceSnapshot {
    return createBrowserConformanceResourceSnapshot({
      counts: {
        requests: this.requestLeases.size,
        queues: this.scheduled.length,
        timers: this.timerLeases.size,
        listeners: this.observerDisposers?.size ?? 0,
        heldInput: this.heldInputLeases.size,
        controllerLeases: this.controllerLeases.size,
        targets: this.liveTargets.size,
        replayEntries: this.replayEntries.size,
        registries: this.registryEntries.size,
        buffers: this.bufferEntries.size,
      },
      identities: { targets: [...this.liveTargets.values()].map((target) => ({ id: `${target.threadId}/${target.tabId}`, generation: target.targetGeneration })) },
    });
  }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.driver.releaseProviderSession("session");
    for (const dispose of this.observerDisposers ?? []) dispose();
    this.observerDisposers?.clear();
    this.requestLeases.clear();
    this.scheduled.length = 0;
    this.timerLeases.clear();
    this.heldInputLeases.clear();
    this.controllerLeases.clear();
    this.replayEntries.clear();
    this.registryEntries.clear();
    this.bufferEntries.clear();
  }
}
