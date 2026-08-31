import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
  await Promise.all(replayRoots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
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
type BrowserRevisionCounters = { host: number; document: number; control: number; capability: number; observation: number };

const REVISION_BY_EVENT = {
  "host-disconnect": "host",
  "host-reconnect": "host",
  "target-register": "document",
  "target-close": "document",
  cancel: "control",
  timeout: "control",
  "lost-response": null,
  "late-response": null,
  "late-event": null,
  "late-timer": null,
  "user-takeover": "control",
  navigation: "document",
  reload: "document",
  resize: "control",
  "competing-mutation": "control",
  "capability-revision": "capability",
  "document-revision": "document",
  "control-revision": "control",
  "observation-revision": "observation",
  cleanup: "control",
} as const satisfies Record<BrowserConformanceScheduledEvent["kind"], keyof BrowserRevisionCounters | null>;

describe("BrowserSessionDriver deterministic races", () => {
  it("executes every revision schedule through the real WebBrowserSessionAdapter and rejects stale effects", async () => {
    const fixture = new WebDriverRaceFixture();
    const replayRoot = await createReplayRoot();
    await runRevisionRaceSchedules(fixture, replayRoot);
    await verifyBootstrapRaces(fixture);
    await verifyActionTakeover(fixture);
    await verifyBatchNavigation(fixture);
    await runRaceCatalogue(fixture, replayRoot);
  });
});

async function createReplayRoot(): Promise<string> {
  const replayRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-web-browser-races-"));
  replayRoots.push(replayRoot);
  return replayRoot;
}

async function runRevisionRaceSchedules(fixture: WebDriverRaceFixture, replayRoot: string): Promise<void> {
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
  for (const generatedSchedule of schedules) {
    fixture.resetTargetState();
    const subject = fixture.createSubject({ host: 0, document: 0, control: 0, capability: 0, observation: 0 });
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
    expectKnownReceipts(run, generatedSchedule.id);
    const terminalReceipt = run.receipts.at(-1);
    expect(terminalReceipt?.status, generatedSchedule.id).toBe("failed");
    expect(terminalReceipt?.errorCode, generatedSchedule.id).toBe(
      generatedSchedule.revisions.includes("capability") ? "CAPABILITY_CHANGED" : "STALE_TARGET_GENERATION",
    );
    expect(terminalReceipt?.effect, generatedSchedule.id).toBe("none");
    expect(subject.mutationSnapshotBeforeAct(), generatedSchedule.id).toEqual(fixture.mutationCounters);
    expect(subject.snapshotResources(), generatedSchedule.id).toEqual(createBrowserConformanceResourceSnapshot());
  }
}

async function verifyBootstrapRaces(fixture: WebDriverRaceFixture): Promise<void> {
  fixture.resetTargetState();
  const bootstrap = fixture.createSubject();
  fixture.deferNextOpen();
  const firstOpen = bootstrap.dispatch({ id: "bootstrap-open-a", operation: "open", args: { idempotencyKey: "bootstrap-a" } });
  await Promise.resolve();
  const concurrent = await bootstrap.dispatch({ id: "bootstrap-open-b", operation: "open", args: { idempotencyKey: "bootstrap-b" } });
  expect(concurrent.errorCode, "bootstrap-concurrent-open").toBe("BROWSER_BUSY");
  expectKnownReceipt(concurrent);
  fixture.completeDeferredOpen();
  expect((await firstOpen).status).toBe("applied");
  const replay = await bootstrap.dispatch({ id: "bootstrap-replay", operation: "open", args: { idempotencyKey: "bootstrap-a" } });
  expect(replay.status, "bootstrap-idempotent-replay").toBe("applied");
  expect(replay.effect).not.toBe("unknown");
  const conflict = await bootstrap.dispatch({ id: "bootstrap-conflict", operation: "open", args: { idempotencyKey: "bootstrap-a", url: "https://other.test/" } });
  expect(conflict.errorCode, "bootstrap-idempotent-replay").toBe("IDEMPOTENCY_CONFLICT");
  expectKnownReceipt(conflict);
  await bootstrap.dispose();
}

async function verifyActionTakeover(fixture: WebDriverRaceFixture): Promise<void> {
  fixture.resetControlAndTarget();
  const action = fixture.createSubject();
  await action.dispatch({ id: "action-open", operation: "open", args: { idempotencyKey: "action-open" } });
  await action.dispatch({ id: "action-inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
  fixture.abortAfterFirstClick(action);
  const takeover = await action.dispatch({
    id: "action-takeover",
    operation: "act",
    args: {
      observationRef: action.observationRef ?? "missing-observation",
      deadlineMs: 10_000,
      steps: [{ operation: "click", target: { cssSelector: "#save" } }, { operation: "click", target: { cssSelector: "#save" } }],
    },
  });
  fixture.clearClickAbort();
  expectInterruptedActionResponse(action.lastResponse);
  expectKnownReceipt(takeover);
  await action.dispose();
}

async function verifyBatchNavigation(fixture: WebDriverRaceFixture): Promise<void> {
  fixture.resetControlAndTarget();
  const batch = fixture.createSubject();
  await batch.dispatch({ id: "batch-open", operation: "open", args: { idempotencyKey: "batch-open" } });
  await batch.dispatch({ id: "batch-inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
  const navigation = await batch.dispatch({
    id: "batch-navigation",
    operation: "act",
    args: {
      observationRef: batch.observationRef ?? "missing-observation",
      deadlineMs: 10_000,
      steps: [
        { operation: "click", target: { cssSelector: "#save" } },
        { operation: "navigate", url: `${window.location.origin}/next` },
        { operation: "click", target: { cssSelector: "#save" } },
      ],
    },
  });
  expect(batch.lastResponse, "batch-navigation/batch-partial-failure").toMatchObject({
    ok: true,
    result: { outcome: "completed", receipts: [{ status: "applied" }, { status: "applied" }, { status: "skipped" }] },
  });
  expectKnownReceipt(navigation);
  await batch.dispose();
}

async function runRaceCatalogue(fixture: WebDriverRaceFixture, replayRoot: string): Promise<void> {
  const exercisedRaceIds = new Set<string>();
  for (const race of BROWSER_CONFORMANCE_RACE_CATALOGUE) {
    fixture.resetTargetState();
    const raceSubject = fixture.createSubject({ host: 0, document: 0, control: 0, capability: 0, observation: 0 });
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
    expectKnownReceipts(run, race.id);
    expectReplayListenerCount(race.id, run.finalState.resources.listeners);
    expect(raceSubject.snapshotResources().listeners, race.id).toBe(0);
    exercisedRaceIds.add(race.id);
  }
  expect(exercisedRaceIds).toEqual(new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.id)));
}

function expectKnownReceipts(run: BrowserConformanceNormalizedRun, message: string): void {
  expect(run.receipts.every((receipt) => receipt.status !== "unknown" && receipt.effect !== "unknown" && receipt.recovery !== "unknown"), message).toBe(true);
}

function expectKnownReceipt(receipt: BrowserConformanceReceipt): void {
  expect(receipt.status).not.toBe("unknown");
  expect(receipt.effect).not.toBe("unknown");
  expect(receipt.recovery).not.toBe("unknown");
}

function expectReplayListenerCount(raceId: string, listeners: number): void {
  if (raceId === "bootstrap-idempotent-replay") expect(listeners, raceId).toBeGreaterThan(0);
}

function expectInterruptedActionResponse(
  response: Awaited<ReturnType<BrowserSessionDriver["execute"]>> | undefined,
): void {
  if (!response?.ok) throw new Error(JSON.stringify(response));
  expect(response, "action-takeover/action-cancel").toMatchObject({
    ok: true,
    result: { outcome: "interrupted", effect: "partial", receipts: [{ status: "applied" }, { status: "interrupted" }] },
  });
}

class WebDriverRaceFixture {
  readonly revisions: BrowserRevisionCounters = { host: 1, document: 1, control: 0, capability: 1, observation: 0 };
  readonly mutationCounters: BrowserMutationCounters = { clicks: 0, inputs: 0, navigations: 0 };
  readonly observerDisposers = new Set<() => void>();
  readonly driver: BrowserSessionDriver;
  private readonly adapter: WebBrowserSessionAdapter;
  private readonly iframe: HTMLIFrameElement;
  private liveTargets = new Map<string, typeof TARGET>([["tab", TARGET]]);
  private releaseOpen: (() => void) | undefined;
  private deferOpen = false;
  private abortCurrent: (() => void) | undefined;
  private abortOnClick = false;

  constructor() {
    document.body.innerHTML = `<iframe data-thread-id="thread" data-tab-id="tab" src="about:blank"></iframe><button id="save">Save</button><input id="name" />`;
    this.iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
    Object.defineProperty(this.iframe, "contentDocument", { configurable: true, value: document });
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const input = document.querySelector<HTMLInputElement>("#name")!;
    Object.defineProperty(button, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    Object.defineProperty(input, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    button.addEventListener("click", () => { this.mutationCounters.clicks += 1; });
    input.addEventListener("input", () => { this.mutationCounters.inputs += 1; });
    this.iframe.addEventListener("load", () => { this.mutationCounters.navigations += 1; });
    this.adapter = new WebBrowserSessionAdapter({
      resolveDocument: () => document,
      resolveSignal: (_dispatch, signal) => signal,
      getControlEpoch: () => this.revisions.control,
      getTargetGeneration: () => this.revisions.document,
      onHumanInput: vi.fn(),
      onObserver: (_dispatch, dispose) => this.trackObserver(dispose),
      executeNonInteraction: (dispatch, signal) => this.executeNonInteraction(dispatch, signal),
    });
    const runtimeAdapter = { execute: (dispatch: BrowserAutomationHostDispatch, signal: AbortSignal) => this.executeRuntime(dispatch, signal) };
    this.driver = new BrowserSessionDriver({
      web: runtimeAdapter,
      electron: runtimeAdapter,
      isElectron: () => false,
      getHostRevision: () => this.revisions.host,
      getDocumentRevision: () => this.revisions.document,
      getControlRevision: () => this.revisions.control,
      getCapabilityRevision: () => this.revisions.capability,
      supportedActOperations: ["click", "navigate"],
      webTabs: {
        list: async () => [...this.liveTargets.values()],
        close: async (target) => { this.liveTargets.delete(target.tabId); },
      },
    });
  }

  resetTargetState(): void {
    this.revisions.host = 1;
    this.revisions.document = 1;
    this.revisions.control = 0;
    this.revisions.capability = 1;
    this.liveTargets = new Map([["tab", TARGET]]);
  }

  resetControlAndTarget(): void {
    this.revisions.control = 0;
    this.liveTargets = new Map([["tab", TARGET]]);
  }

  createSubject(observedRevisions: BrowserRevisionCounters = { ...this.revisions }): WebDriverRaceSubject {
    return new WebDriverRaceSubject(
      this.driver,
      this.revisions,
      this.liveTargets,
      observedRevisions,
      this.mutationCounters,
      this.observerDisposers,
    );
  }

  deferNextOpen(): void { this.deferOpen = true; }

  completeDeferredOpen(): void {
    this.releaseOpen?.();
    this.deferOpen = false;
  }

  abortAfterFirstClick(subject: WebDriverRaceSubject): void {
    this.abortOnClick = true;
    this.abortCurrent = () => subject.abortCurrent();
  }

  clearClickAbort(): void {
    this.abortOnClick = false;
    this.abortCurrent = undefined;
  }

  private trackObserver(dispose: () => void): void {
    const wrappedDispose = () => {
      this.observerDisposers.delete(wrappedDispose);
      dispose();
    };
    this.observerDisposers.add(wrappedDispose);
  }

  private executeNonInteraction(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeWebBrowserDispatch>>> {
    if (this.deferOpen && dispatch.request.operation === "open") {
      return new Promise((resolve) => {
        this.releaseOpen = () => resolve(executeWebBrowserDispatch(dispatch, signal));
      });
    }
    const response = executeWebBrowserDispatch(dispatch, signal);
    if (dispatch.request.operation === "open" || dispatch.request.operation === "navigate") {
      this.iframe.dispatchEvent(new Event("load"));
    }
    return Promise.resolve(response);
  }

  private async executeRuntime(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<WebBrowserSessionAdapter["execute"]>>> {
    const response = await this.adapter.execute(dispatch, signal);
    if (this.abortOnClick && dispatch.request.operation === "click") this.abortCurrent?.();
    return response;
  }
}

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
    private readonly revisions: BrowserRevisionCounters,
    private readonly liveTargets: Map<string, typeof TARGET>,
    observedRevisions = { ...revisions },
    mutationCounters?: BrowserMutationCounters,
    observerDisposers?: Set<() => void>,
  ) {
    this.observedRevisions = observedRevisions;
    this.mutationCounters = mutationCounters;
    this.observerDisposers = observerDisposers;
  }

  private readonly observedRevisions: BrowserRevisionCounters;

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
    this.applyExternalEventSideEffects(event.kind);
    const revision = REVISION_BY_EVENT[event.kind];
    if (revision) this.bumpRevision(revision);
  }

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const requestKey = this.recordDispatchStart(command);
    const response = await this.executeDispatch(this.createDispatch(command));
    this.recordDispatchResponse(command, requestKey, response);
    const receipt = this.normalizeReceipt(command, response);
    this.receipts.push(receipt);
    return receipt;
  }

  snapshotOutcome(): BrowserConformanceNormalizedRun {
    const last = this.receipts.at(-1);
    return normalizeBrowserConformanceRun({
      receipts: this.receipts,
      outcome: {
        status: this.outcomeStatus(last),
        effect: this.outcomeEffect(last),
        recovery: this.outcomeRecovery(last),
        revisions: this.observedRevisions,
        ownership: this.outcomeOwnership(last),
      },
      finalState: {
        readiness: this.disposed ? "target-unavailable" : "ready",
        controlOwner: this.outcomeOwnership(last),
        tabCount: this.liveTargets.size,
        currentUrl: null,
        revisions: this.observedRevisions,
        resources: this.snapshotResources(),
      },
    });
  }

  private applyExternalEventSideEffects(event: BrowserConformanceScheduledEvent["kind"]): void {
    if (event === "observation-revision") this.driver.invalidateTargetObservations("workspace", "thread", "tab");
    if (event === "target-close") {
      this.driver.clearIdempotencyForTarget("workspace", "thread", "tab");
      this.liveTargets.delete("tab");
    }
  }

  private recordDispatchStart(command: BrowserConformanceCommand): string {
    if (command.operation === "act" && this.mutationCounters) this.preActMutationCounters = { ...this.mutationCounters };
    const requestKey = `${command.id}:${this.receipts.length}`;
    this.requestLeases.add(requestKey);
    this.bufferEntries.add(requestKey);
    this.registryEntries.set("provider-session", "active");
    if (command.operation === "act") this.recordActionLeases(requestKey);
    return requestKey;
  }

  private recordActionLeases(requestKey: string): void {
    this.heldInputLeases.add(requestKey);
    this.controllerLeases.add(requestKey);
  }

  private createDispatch(command: BrowserConformanceCommand): BrowserAutomationHostDispatch {
    const operation = command.operation;
    const args = { ...command.args } as Record<string, unknown>;
    if (operation === "act") args.observationRef = this.observationRef ?? "missing-observation";
    return {
      connection: { desktopInstanceId: "web", windowId: 1, connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: { ...TARGET, connectionGeneration: 1, targetGeneration: 1 },
      request: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
        requestId: `race-${command.id}-${this.receipts.length}`, sequence: this.receipts.length, deadline: 4_000_000_000_000,
        expectedControlEpoch: 0, operation, args,
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  private async executeDispatch(
    dispatch: BrowserAutomationHostDispatch,
  ): Promise<Awaited<ReturnType<BrowserSessionDriver["execute"]>>> {
    const controller = new AbortController();
    this.activeController = controller;
    try {
      return BrowserAutomationResponseSchema().parse(await this.driver.execute(dispatch, controller.signal));
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private recordDispatchResponse(
    command: BrowserConformanceCommand,
    requestKey: string,
    response: Awaited<ReturnType<BrowserSessionDriver["execute"]>>,
  ): void {
    this.lastResponse = response;
    if (!response.ok) return;
    const result = response.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
    this.observationRef = result.nextObservationRef ?? result.finalObservation?.observationRef ?? result.observationRef ?? this.observationRef;
    if (this.observationRef) this.replayEntries.set(this.observationRef, requestKey);
    if (command.operation === "open") this.liveTargets.set("tab", TARGET);
  }

  private normalizeReceipt(
    command: BrowserConformanceCommand,
    response: Awaited<ReturnType<BrowserSessionDriver["execute"]>>,
  ): BrowserConformanceReceipt {
    return normalizeBrowserConformanceRun({
      receipts: [{
        order: { tick: this.tick, ordinal: this.receipts.length },
        commandId: command.id,
        operation: command.operation,
        status: response.ok ? "applied" : "failed",
        effect: response.ok ? "complete" : response.error.effect,
        recovery: response.ok ? "none" : response.error.recovery,
        errorCode: response.ok ? null : response.error.code,
        errorStage: response.ok ? "effect" : response.error.stage,
        ownership: response.ok ? "agent" : "none",
        revisions: this.observedRevisions,
      }],
    }).receipts[0]!;
  }

  private outcomeStatus(last: BrowserConformanceReceipt | undefined): "completed" | "failed" {
    return last?.status === "failed" ? "failed" : "completed";
  }

  private outcomeEffect(last: BrowserConformanceReceipt | undefined): BrowserConformanceReceipt["effect"] {
    return last?.effect ?? "none";
  }

  private outcomeRecovery(last: BrowserConformanceReceipt | undefined): BrowserConformanceReceipt["recovery"] {
    return last?.recovery ?? "none";
  }

  private outcomeOwnership(last: BrowserConformanceReceipt | undefined): BrowserConformanceReceipt["ownership"] {
    return last?.ownership ?? "none";
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
