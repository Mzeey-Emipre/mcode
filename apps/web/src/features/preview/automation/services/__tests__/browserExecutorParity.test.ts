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

vi.mock("../../components/panels/web-browser-automation/capture", () => ({
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

class WebExecutorSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly state = { url: "https://example.test/", owner: "none" as "none" | "agent", observationRef: undefined as string | undefined };
  private tick = 0;

  constructor(private readonly driver: BrowserSessionDriver, private readonly liveTargets: Map<string, ReturnType<typeof target>>) {}

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const args = replaceObservationRefs(command.args ?? {}, this.state.observationRef) as Record<string, unknown>;
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
    const result = BrowserAutomationResponseSchema().parse(
      await this.driver.execute(dispatch, new AbortController().signal),
    );
    if (result.ok) {
      const candidate = result.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
      this.state.observationRef = candidate.nextObservationRef ?? candidate.finalObservation?.observationRef ?? candidate.observationRef ?? this.state.observationRef;
      if (["open", "navigate"].includes(command.operation)) this.state.url = String(args.url ?? this.state.url);
      if (command.operation === "act" && Array.isArray(args.steps)) {
        const navigation = args.steps.find((step) => typeof step === "object" && step !== null && (step as { operation?: unknown }).operation === "navigate");
        if (navigation && typeof (navigation as { url?: unknown }).url === "string") this.state.url = navigation.url;
      }
      if (["open", "navigate", "click", "type", "act", "tabs"].includes(command.operation)) this.state.owner = "agent";
    }
    const raw = {
      receipts: [{
        order: { tick: this.tick, ordinal: this.receipts.length },
        commandId: command.id,
        operation: command.operation,
        status: result.ok ? "applied" : "failed",
        effect: result.ok ? ((result.result as { effect?: string }).effect ?? (["inspect", "snapshot", "screenshot"].includes(command.operation) ? "none" : command.operation === "open" ? "created" : "complete")) : (result.error.effect ?? "none"),
        recovery: result.ok ? ((result.result as { recovery?: string }).recovery ?? "none") : (result.error.recovery ?? "inspect"),
        truncated: result.ok && Boolean((result.result as { truncation?: { truncated?: boolean } }).truncation?.truncated),
        revisions: { host: 0, document: 0, control: 0, capability: 1, observation: this.receipts.length },
        errorCode: result.ok ? null : result.error.code,
        errorStage: result.ok ? (["inspect", "snapshot", "screenshot"].includes(command.operation) ? "observation" : "effect") : (result.error.stage ?? "effect"),
        ownership: this.state.owner,
      }],
      outcome: result.ok ? { status: "completed", effect: "complete", recovery: "none", revisions: { capability: 1, observation: this.receipts.length }, ownership: this.state.owner } : { status: "failed", effect: result.error.effect ?? "none", recovery: result.error.recovery ?? "inspect", errorCode: result.error.code, errorStage: result.error.stage ?? "effect", ownership: this.state.owner },
      finalState: { readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, revisions: { capability: 1, observation: this.receipts.length }, resources: this.snapshotResources() },
      visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, title: "Executor fixture", action: command.operation, truncated: false }],
    };
    const normalized = normalizeBrowserConformanceRun(raw);
    const receipt = normalized.receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }

  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  snapshotOutcome(): BrowserConformanceNormalizedRun {
    const last = this.receipts.at(-1);
    return normalizeBrowserConformanceRun({
      receipts: this.receipts,
      outcome: { status: last?.status === "failed" ? "failed" : "completed", effect: last?.effect ?? "none", recovery: last?.recovery ?? "none", revisions: last?.revisions, ownership: last?.ownership },
      finalState: { readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, revisions: last?.revisions, resources: this.snapshotResources() },
      visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, title: "Executor fixture", action: last?.operation ?? null, truncated: false }],
    });
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
