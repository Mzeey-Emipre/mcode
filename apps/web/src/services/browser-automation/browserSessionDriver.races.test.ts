import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationResponseSchema,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import {
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceRevisionRaceSchedules,
  normalizeBrowserConformanceRun,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceReceipt,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceSubject,
} from "@mcode/browser-conformance";
import { executeWebBrowserDispatch } from "../../components/panels/browserAutomationWebExecutor";
import { BrowserSessionDriver } from "./browserSessionDriver";
import { WebBrowserSessionAdapter } from "./webBrowserSessionAdapter";

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

describe("BrowserSessionDriver deterministic races", () => {
  it("executes every revision schedule through the real WebBrowserSessionAdapter and rejects stale effects", async () => {
    document.body.innerHTML = `<iframe data-thread-id="thread" data-tab-id="tab" src="about:blank"></iframe><button id="save">Save</button>`;
    const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: document });
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    Object.defineProperty(button, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    let releaseOpen: (() => void) | undefined;
    let deferOpen = false;
    let abortCurrent: (() => void) | undefined;
    let abortAfterFirstClick = false;
    const revisions = { host: 1, document: 1, control: 0, capability: 1, observation: 0 };
    const liveTargets = new Map<string, typeof TARGET>();
    const adapter = new WebBrowserSessionAdapter({
      resolveDocument: () => document,
      resolveSignal: (_dispatch, signal) => signal,
      getControlEpoch: () => revisions.control,
      getTargetGeneration: () => revisions.document,
      onHumanInput: vi.fn(),
      onObserver: (_dispatch, dispose) => dispose(),
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
      maxTick: 12,
    });
    const schedules = [
      ...Object.values(generated.individual),
      ...generated.pairs,
      ...generated.highRisk,
    ];
    for (const generatedSchedule of schedules) {
      revisions.host = 1;
      revisions.document = 1;
      revisions.control = 0;
      revisions.capability = 1;
      liveTargets.clear();
      const subject = new WebDriverRaceSubject(driver, revisions, liveTargets);
      await subject.dispatch({ id: "open", operation: "open", args: { idempotencyKey: `open-${generatedSchedule.id}` } });
      await subject.dispatch({ id: "inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
      for (const event of generatedSchedule.schedule.events) {
        subject.schedule(event);
        await subject.advanceClock(event.order.tick);
        await subject.injectExternalEvent(event);
      }
      const receipt = await subject.dispatch({
        id: "act",
        operation: "act",
        args: { observationRef: subject.observationRef ?? "missing-observation", deadlineMs: 10_000, steps: [{ operation: "click", target: { cssSelector: "#save" } }] },
      });
      expect(receipt.status).toBe("failed");
      expect(receipt.effect).not.toBe("unknown");
      expect(receipt.recovery).not.toBe("unknown");
      expect(receipt.errorCode).toBe(generatedSchedule.revisions.includes("capability") ? "CAPABILITY_CHANGED" : "STALE_TARGET_GENERATION");
      const beforeDispose = subject.snapshotResources();
      await subject.drainToQuiescence();
      await subject.dispose();
      const afterDispose = subject.snapshotResources();
      await subject.injectExternalEvent({ order: { tick: 99, ordinal: 99 }, kind: "late-response" });
      await subject.injectExternalEvent({ order: { tick: 100, ordinal: 100 }, kind: "late-event" });
      await subject.injectExternalEvent({ order: { tick: 101, ordinal: 101 }, kind: "late-timer" });
      expect(subject.snapshotResources()).toEqual(afterDispose);
      expect(afterDispose.targets).toBe(0);
      expect(beforeDispose.targets).toBeLessThanOrEqual(1);
    }
    revisions.host = 1;
    revisions.document = 1;
    revisions.control = 0;
    revisions.capability = 1;
    liveTargets.clear();
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
    liveTargets.clear();
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
    liveTargets.clear();
    const batch = new WebDriverRaceSubject(driver, revisions, liveTargets);
    await batch.dispatch({ id: "batch-open", operation: "open", args: { idempotencyKey: "batch-open" } });
    await batch.dispatch({ id: "batch-inspect", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
    const navigation = await batch.dispatch({ id: "batch-navigation", operation: "act", args: { observationRef: batch.observationRef ?? "missing-observation", deadlineMs: 10_000, steps: [{ operation: "click", target: { cssSelector: "#save" } }, { operation: "navigate", url: `${window.location.origin}/next` }, { operation: "click", target: { cssSelector: "#save" } }] } });
    expect(batch.lastResponse, "batch-navigation/batch-partial-failure").toMatchObject({ ok: true, result: { outcome: "completed", receipts: [{ status: "applied" }, { status: "applied" }, { status: "skipped" }] } });
    expect(navigation.status).not.toBe("unknown");
    expect(navigation.effect).not.toBe("unknown");
    expect(navigation.recovery).not.toBe("unknown");
    await batch.dispose();
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.filter((race) => race.family === "bootstrap")).toHaveLength(8);
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.filter((race) => race.family === "action" || race.family === "batch")).toHaveLength(13);
  });

});

class WebDriverRaceSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly scheduled: BrowserConformanceScheduledEvent[] = [];
  private tick = 0;
  private disposed = false;
  private activeController: AbortController | undefined;
  observationRef: string | undefined;
  lastResponse: Awaited<ReturnType<BrowserSessionDriver["execute"]>> | undefined;

  constructor(
    private readonly driver: BrowserSessionDriver,
    private readonly revisions: { host: number; document: number; control: number; capability: number; observation: number },
    private readonly liveTargets: Map<string, typeof TARGET>,
  ) {}

  abortCurrent(): void { this.activeController?.abort(); }

  schedule(event: BrowserConformanceScheduledEvent): void { this.scheduled.push(event); }
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(event: BrowserConformanceScheduledEvent): Promise<void> {
    if (this.disposed) return;
    switch (event.kind) {
      case "host-disconnect":
      case "host-reconnect":
        this.revisions.host += 1;
        break;
      case "navigation":
      case "reload":
      case "document-revision":
      case "target-register":
        this.revisions.document += 1;
        break;
      case "user-takeover":
      case "competing-mutation":
      case "cancel":
      case "timeout":
      case "resize":
      case "control-revision":
        this.revisions.control += 1;
        break;
      case "capability-revision":
        this.revisions.capability += 1;
        break;
      case "observation-revision":
        this.driver.invalidateTargetObservations("thread", "tab");
        this.revisions.observation += 1;
        break;
      case "late-event":
      case "late-timer":
        // Late callbacks are deliberately inert once the subject is disposed.
        break;
      case "target-close":
        this.driver.clearIdempotencyForTarget("thread", "tab");
        this.liveTargets.delete("tab");
        this.revisions.document += 1;
        break;
      default:
        this.revisions.control += 1;
        break;
    }
  }

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const operation = command.operation;
    const args = { ...(command.args ?? {}) } as Record<string, unknown>;
    if (operation === "act") args.observationRef = this.observationRef;
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
      if (operation === "open") this.liveTargets.set("tab", TARGET);
    }
    const receipt = normalizeBrowserConformanceRun({ receipts: [{
      order: { tick: this.tick, ordinal: this.receipts.length }, commandId: command.id, operation,
      status: response.ok ? "applied" : "failed", effect: response.ok ? "complete" : response.error.effect,
      recovery: response.ok ? "none" : response.error.recovery, errorCode: response.ok ? null : response.error.code,
      errorStage: response.ok ? "effect" : response.error.stage, ownership: response.ok ? "agent" : "none",
      revisions: this.revisions,
    }] }).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }

  snapshotOutcome(): BrowserConformanceNormalizedRun {
    return normalizeBrowserConformanceRun({ receipts: this.receipts, outcome: { status: this.receipts.at(-1)?.status === "failed" ? "failed" : "completed", effect: this.receipts.at(-1)?.effect ?? "none", recovery: this.receipts.at(-1)?.recovery ?? "none", revisions: this.revisions, ownership: this.receipts.at(-1)?.ownership ?? "none" }, finalState: { readiness: this.disposed ? "target-unavailable" : "ready", controlOwner: this.receipts.at(-1)?.ownership ?? "none", tabCount: this.liveTargets.size, currentUrl: null, revisions: this.revisions, resources: this.snapshotResources() } });
  }
  snapshotResources(): BrowserConformanceResourceSnapshot {
    return createBrowserConformanceResourceSnapshot({ counts: { targets: this.liveTargets.size }, identities: { targets: [...this.liveTargets.values()].map((target) => ({ id: `${target.threadId}/${target.tabId}`, generation: target.targetGeneration })) } });
  }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; await this.driver.releaseProviderSession("session"); }
}
