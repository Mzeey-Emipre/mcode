import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationResponseSchema,
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import {
  createBrowserConformanceResourceSnapshot,
  normalizeBrowserConformanceRun,
  runBrowserConformanceScenarioWithReplay,
  createBrowserExecutorParityScenario,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceReceipt,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceSubject,
} from "@mcode/browser-conformance";
import {
  BrowserSessionDriver,
  ElectronBrowserSessionAdapter,
  getBrowserAutomationRuntimeOperations,
} from "../browserSessionDriver";
import { WebBrowserSessionAdapter } from "../webBrowserSessionAdapter";
import { executeWebBrowserDispatch } from "../../browserAutomationWebExecutor";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const OBSERVATION_OPERATIONS = new Set(["inspect", "snapshot", "screenshot"]);
const AGENT_OWNED_OPERATIONS = new Set(["open", "navigate", "click", "type", "act", "tabs"]);

vi.mock("../../web-browser-automation/capture", () => ({
  captureVisibleWebScreenshot: vi.fn(async () => ({
    ok: true,
    value: {
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      width: 1,
      height: 1,
      truncation: { truncated: false },
    },
  })),
}));

function target() {
  return {
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
}

function replaceObservationRefs(value: unknown, observationRef: string | undefined): unknown {
  if (value === "$lastObservationRef") return observationRef ?? "missing-observation";
  if (Array.isArray(value)) return value.map((entry) => replaceObservationRefs(entry, observationRef));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceObservationRefs(entry, observationRef)]));
}

function isNavigationStep(value: unknown): value is { operation: "navigate"; url?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const step = value as { operation?: unknown; url?: unknown };
  return step.operation === "navigate";
}

class WebExecutorSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly state = { url: "https://example.test/", owner: "none" as "none" | "agent", observationRef: undefined as string | undefined };
  private tick = 0;

  constructor(private readonly driver: BrowserSessionDriver, private readonly liveTargets: Map<string, ReturnType<typeof target>>) {}

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const args = this.resolveArgs(command);
    const result = await this.execute(command, args);
    this.recordSuccessfulDispatch(command, args, result);
    const receipt = this.normalizeReceipt(command, result);
    this.receipts.push(receipt);
    return receipt;
  }

  private resolveArgs(command: BrowserConformanceCommand): Record<string, unknown> {
    return replaceObservationRefs(command.args ?? {}, this.state.observationRef) as Record<string, unknown>;
  }

  private async execute(
    command: BrowserConformanceCommand,
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<BrowserSessionDriver["execute"]>>> {
    const dispatch = {
      scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
      connection: { desktopInstanceId: "web", windowId: 1, connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: target(),
      request: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: `parity-${command.id}-${this.receipts.length}`,
        sequence: this.receipts.length,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: command.operation,
        args,
      },
    } as unknown as BrowserAutomationHostDispatch;
    return BrowserAutomationResponseSchema().parse(await this.driver.execute(dispatch, new AbortController().signal));
  }

  private recordSuccessfulDispatch(
    command: BrowserConformanceCommand,
    args: Record<string, unknown>,
    result: Awaited<ReturnType<BrowserSessionDriver["execute"]>>,
  ): void {
    if (!result.ok) return;
    this.recordObservationRef(result.result);
    this.recordNavigation(command, args);
    if (AGENT_OWNED_OPERATIONS.has(command.operation)) this.state.owner = "agent";
  }

  private recordObservationRef(result: unknown): void {
    const candidate = result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
    this.state.observationRef = candidate.nextObservationRef ?? candidate.finalObservation?.observationRef ?? candidate.observationRef ?? this.state.observationRef;
  }

  private recordNavigation(command: BrowserConformanceCommand, args: Record<string, unknown>): void {
    if (["open", "navigate"].includes(command.operation)) {
      this.state.url = String(args.url ?? this.state.url);
      return;
    }
    if (command.operation !== "act") return;
    const navigation = Array.isArray(args.steps) ? args.steps.find(isNavigationStep) : undefined;
    if (typeof navigation?.url === "string") this.state.url = navigation.url;
  }

  private normalizeReceipt(
    command: BrowserConformanceCommand,
    result: Awaited<ReturnType<BrowserSessionDriver["execute"]>>,
  ): BrowserConformanceReceipt {
    const receipt = result.ok
      ? this.successfulReceipt(command, result.result)
      : this.failedReceipt(result.error);
    const outcome = result.ok
      ? this.completedOutcome()
      : this.failedOutcome(result.error);
    return normalizeBrowserConformanceRun({
      receipts: [{
        order: { tick: this.tick, ordinal: this.receipts.length },
        commandId: command.id,
        operation: command.operation,
        ...receipt,
        revisions: this.revisions(),
        ownership: this.state.owner,
      }],
      outcome,
      finalState: this.finalState(),
      visibleObservations: [this.visibleObservation(command.operation)],
    }).receipts[0]!;
  }

  private successfulReceipt(command: BrowserConformanceCommand, result: unknown): Record<string, unknown> {
    const candidate = result as { effect?: string; recovery?: string; truncation?: { truncated?: boolean } };
    return {
      status: "applied",
      effect: candidate.effect ?? this.defaultEffect(command.operation),
      recovery: candidate.recovery ?? "none",
      truncated: Boolean(candidate.truncation?.truncated),
      errorCode: null,
      errorStage: OBSERVATION_OPERATIONS.has(command.operation) ? "observation" : "effect",
    };
  }

  private failedReceipt(error: { effect?: string; recovery?: string; code: string; stage?: string }): Record<string, unknown> {
    return {
      status: "failed",
      effect: error.effect ?? "none",
      recovery: error.recovery ?? "inspect",
      truncated: false,
      errorCode: error.code,
      errorStage: error.stage ?? "effect",
    };
  }

  private defaultEffect(operation: BrowserConformanceCommand["operation"]): string {
    if (OBSERVATION_OPERATIONS.has(operation)) return "none";
    return operation === "open" ? "created" : "complete";
  }

  private completedOutcome(): Record<string, unknown> {
    return { status: "completed", effect: "complete", recovery: "none", revisions: this.revisions(), ownership: this.state.owner };
  }

  private failedOutcome(error: { effect?: string; recovery?: string; code: string; stage?: string }): Record<string, unknown> {
    return {
      status: "failed",
      effect: error.effect ?? "none",
      recovery: error.recovery ?? "inspect",
      errorCode: error.code,
      errorStage: error.stage ?? "effect",
      ownership: this.state.owner,
    };
  }

  private revisions(): { host: number; document: number; control: number; capability: number; observation: number } {
    return { host: 0, document: 0, control: 0, capability: 1, observation: this.receipts.length };
  }

  private finalState(): Record<string, unknown> {
    return {
      readiness: "ready",
      controlOwner: this.state.owner,
      tabCount: 1,
      currentUrl: this.state.url,
      revisions: this.revisions(),
      resources: this.snapshotResources(),
    };
  }

  private visibleObservation(operation: BrowserConformanceCommand["operation"]): Record<string, unknown> {
    return {
      surface: "browser",
      readiness: "ready",
      controlOwner: this.state.owner,
      tabCount: 1,
      currentUrl: this.state.url,
      title: "Executor fixture",
      action: operation,
      truncated: false,
    };
  }

  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  snapshotOutcome(): BrowserConformanceNormalizedRun {
    const last = this.receipts.at(-1);
    return normalizeBrowserConformanceRun({
      receipts: this.receipts,
      outcome: this.snapshotOutcomeFor(last),
      finalState: this.snapshotFinalState(last),
      visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, title: "Executor fixture", action: last?.operation ?? null, truncated: false }],
    });
  }

  private snapshotOutcomeFor(last: BrowserConformanceReceipt | undefined): Record<string, unknown> {
    return {
      status: last?.status === "failed" ? "failed" : "completed",
      effect: last?.effect ?? "none",
      recovery: last?.recovery ?? "none",
      revisions: last?.revisions,
      ownership: last?.ownership,
    };
  }

  private snapshotFinalState(last: BrowserConformanceReceipt | undefined): Record<string, unknown> {
    return {
      readiness: "ready",
      controlOwner: this.state.owner,
      tabCount: 1,
      currentUrl: this.state.url,
      revisions: last?.revisions,
      resources: this.snapshotResources(),
    };
  }
  snapshotResources(): BrowserConformanceResourceSnapshot {
    const targets = this.liveTargets.size > 0 ? [{ id: "browser-target", generation: 1 }] : [];
    return createBrowserConformanceResourceSnapshot({ identities: { targets } });
  }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { await this.driver.releaseProviderSession("session"); }
}

describe("shared Browser executor parity at BrowserSessionDriver", () => {
  it("does not normalize malformed runtime output into a successful receipt", async () => {
    const malformed = new BrowserSessionDriver({
      web: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      electron: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      isElectron: () => false,
    });
    const malformedSubject = new WebExecutorSubject(malformed, new Map([["tab", target()]]));
    await expect(malformedSubject.dispatch({ id: "malformed", operation: "inspect" }))
      .rejects.toThrow();
  });

  it("proves the web descriptor and compares the real DOM-backed executor with canonical outcomes", async () => {
    document.body.innerHTML = `<iframe data-thread-id="thread" data-tab-id="tab" src="about:blank"></iframe><button id="save">Save</button><input id="name" />`;
    const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: document });
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const input = document.querySelector<HTMLInputElement>("#name")!;
    for (const element of [button, input]) Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    let clicks = 0;
    button.addEventListener("click", () => { clicks += 1; });
    const webAdapter = new WebBrowserSessionAdapter({
      resolveDocument: () => document,
      resolveSignal: (_dispatch, signal) => signal,
      getControlEpoch: () => 0,
      getTargetGeneration: () => 1,
      onHumanInput: vi.fn(),
      onObserver: (_dispatch, dispose) => dispose(),
      executeNonInteraction: async (dispatch, signal) => {
        const result = executeWebBrowserDispatch(dispatch, signal);
        if (dispatch.request.operation === "open" || dispatch.request.operation === "navigate") iframe.dispatchEvent(new Event("load"));
        return result;
      },
    });
    const liveTargets = new Map([["tab", target()]]);
    const driver = new BrowserSessionDriver({
      web: webAdapter,
      electron: new ElectronBrowserSessionAdapter(async () => { throw new Error("electron adapter must not run in web parity"); }),
      isElectron: () => false,
      supportedActOperations: ["click", "type", "navigate"],
      webTabs: { list: async () => [...liveTargets.values()], close: async (closedTarget) => { liveTargets.delete(closedTarget.tabId); } },
    });
    const descriptor = getBrowserAutomationRuntimeOperations("web");
    const parity = createBrowserExecutorParityScenario();
    expect(descriptor).toEqual(expect.arrayContaining([...parity.operations]));
    expect(getBrowserAutomationRuntimeOperations("electron")).toEqual(expect.arrayContaining([...parity.operations]));
    const subject = new WebExecutorSubject(driver, liveTargets);
    const run = await runBrowserConformanceScenarioWithReplay(parity.scenario, subject, {
      workspaceRoot,
      failingInvariant: "web executor parity remains canonical",
    });
    expect(clicks).toBe(2);
    expect(input.value).toBe("Mcode");
    expect(run).toEqual(parity.expected);
    expect(run.finalState.resources.targets).toBe(1);
    expect(subject.snapshotResources().targets).toBe(0);
  });
});
