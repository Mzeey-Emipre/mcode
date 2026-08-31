// @vitest-environment jsdom
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, BrowserAutomationResponseSchema, type BrowserAutomationHostDispatch, type BrowserAutomationResponse } from "@mcode/contracts";
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
} from "../../../../../../web/src/features/preview/automation/services/browserSessionDriver";
import { WebBrowserSessionAdapter } from "../../../../../../web/src/features/preview/automation/services/webBrowserSessionAdapter";
import { executeWebBrowserDispatch } from "../../../../../../web/src/features/preview/automation/browserAutomationWebExecutor";
import { BrowserAutomationKernel } from "../kernel.js";

vi.mock("../../../../../../web/src/features/preview/automation/web-browser-automation/capture", () => ({
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

const workspaceRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../../../../../");

let currentWebContents: FakeWebContents;
const rendererSender = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
rendererSender.isDestroyed = () => false;
rendererSender.send = vi.fn();
const fakeWindow = { id: 7, isDestroyed: () => false, isFocused: () => true, webContents: rendererSender };
const fakePreviewSession = {
  lastPreviewThreadId: "thread",
  tabsByThread: new Map<string, { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; view: null }> }>(),
};

class FakeDebugger extends NodeEvents.EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly owner: FakeWebContents) { super(); }
  isAttached(): boolean { return this.attached; }
  attach(): void { this.attached = true; }
  detach(): void { this.attached = false; }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params });
    if (method.startsWith("Input.")) this.owner.emit("before-input-event", {});
    return this.commandResult(method, params) ?? {};
  }

  private commandResult(method: string, params: unknown): unknown | undefined {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "Runtime.callFunctionOn") return this.callFunctionResult(params);
    if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    if (method === "DOM.getDocument") return { root: { backendNodeId: 1 } };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 2 } };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [] };
    if (method === "Performance.getMetrics") return { metrics: [] };
    return undefined;
  }

  private callFunctionResult(params: unknown): unknown {
    const source = String((params as { functionDeclaration?: string } | undefined)?.functionDeclaration ?? "");
    if (source.includes("snapshotPage")) return { result: { value: this.owner.snapshotValue } };
    if (source.includes("locatePageTarget")) return { result: { value: { x: 10, y: 20 } } };
    if (source.includes("inspectPageTarget")) return { result: { value: { attached: true, visible: true, x: 10, y: 20 } } };
    return { result: { value: { ok: true, valueJson: "null" } } };
  }
}

class FakeWebContents extends NodeEvents.EventEmitter {
  readonly debugger = new FakeDebugger(this);
  readonly id = 1;
  readonly hostWebContents = rendererSender;
  readonly snapshotValue = {
    url: "http://localhost:3000/",
    title: "Executor fixture",
    loading: false,
    visibleText: "Executor fixture Save",
    visibleTextOriginalLength: 23,
    elements: [],
    elementCount: 0,
  };
  private url = "http://localhost:3000/";
  destroyed = false;
  loadURL = vi.fn(async (url: string) => { this.url = url; });
  stop = vi.fn();
  send = vi.fn();
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
  getTitle(): string { return "Executor fixture"; }
  isLoading(): boolean { return false; }
  isFocused(): boolean { return true; }
  async executeJavaScript(source: string): Promise<unknown> {
    if (source.includes("window.innerWidth")) return { width: 1_280, height: 720 };
    if (source.includes("snapshotPage")) return this.snapshotValue;
    if (source.includes("locatePageTarget")) return { x: 10, y: 20 };
    return {};
  }
  capturePage = vi.fn(async () => ({
    getSize: () => ({ width: 1, height: 1 }),
    resize: () => this.capturePage(),
    toPNG: () => Buffer.from("png"),
  }));
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => fakeWindow),
    getAllWindows: vi.fn(() => [fakeWindow]),
  },
  nativeImage: { createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => ({ getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from("png") }), toPNG: () => Buffer.from("png") })) },
}));
vi.mock("../../surfaces/registry.js", () => ({ findAdoptedWebContentsForWindow: vi.fn(() => currentWebContents) }));
vi.mock("../../contracts/guest-input.js", () => ({ PREVIEW_GUEST_AGENT_INPUT_CHANNEL: "mcode:browser-agent-input" }));
vi.mock("../../state/window-session.js", () => ({
  getSession: vi.fn(() => fakePreviewSession),
  getThreadTabSet: vi.fn((session, threadId) => session.tabsByThread.get(threadId)),
  getActiveTab: vi.fn((session, threadId) => {
    const tabSet = session.tabsByThread.get(threadId);
    return tabSet.tabs.find((tab: { id: string }) => tab.id === tabSet.activeTabId);
  }),
}));

function seedTarget(): void {
  fakePreviewSession.tabsByThread.set("thread", { threadId: "thread", activeTabId: "tab", tabs: [{ id: "tab", threadId: "thread", view: null }] });
}

function target() {
  return { desktopInstanceId: "electron", windowId: 7, connectionGeneration: 1, threadId: "thread", tabId: "tab", targetGeneration: 0, active: true, focused: true, lastUsedAt: 0 } as const;
}

function webTarget() {
  return { ...target(), desktopInstanceId: "web", targetGeneration: 1 } as const;
}

function replaceObservationRefs(value: unknown, observationRef: string | undefined): unknown {
  if (value === "$lastObservationRef") return observationRef ?? "missing-observation";
  if (Array.isArray(value)) return value.map((entry) => replaceObservationRefs(entry, observationRef));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceObservationRefs(entry, observationRef)]));
}

type ParityState = { url: string; owner: "none" | "agent"; observationRef: string | undefined };

function createParityDispatch(
  command: BrowserConformanceCommand,
  args: Record<string, unknown>,
  desktopInstanceId: "electron" | "web",
  targetValue: ReturnType<typeof target> | ReturnType<typeof webTarget>,
  requestId: string,
  sequence: number,
): BrowserAutomationHostDispatch {
  return {
    scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
    connection: { desktopInstanceId, windowId: desktopInstanceId === "electron" ? 7 : 1, connectionGeneration: 1, targetGeneration: targetValue.targetGeneration, capabilityRevision: 1 },
    target: targetValue,
    request: { contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance", requestId, sequence, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: command.operation, args },
  } as unknown as BrowserAutomationHostDispatch;
}

function applyParityResult(
  state: ParityState,
  command: BrowserConformanceCommand,
  args: Record<string, unknown>,
  result: BrowserAutomationResponse,
): void {
  if (!result.ok) return;
  const candidate = result.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
  state.observationRef = candidate.nextObservationRef ?? candidate.finalObservation?.observationRef ?? candidate.observationRef ?? state.observationRef;
  updateParityUrl(state, command, args);
  if (["open", "navigate", "click", "type", "act", "tabs"].includes(command.operation)) state.owner = "agent";
}

function updateParityUrl(state: ParityState, command: BrowserConformanceCommand, args: Record<string, unknown>): void {
  if (["open", "navigate"].includes(command.operation)) state.url = String(args.url ?? state.url);
  if (command.operation !== "act" || !Array.isArray(args.steps)) return;
  const navigation = args.steps.find((step) => typeof step === "object" && step !== null && (step as { operation?: unknown }).operation === "navigate");
  if (navigation && typeof (navigation as { url?: unknown }).url === "string") state.url = navigation.url;
}

function parityRawRun(
  state: ParityState,
  command: BrowserConformanceCommand,
  result: BrowserAutomationResponse,
  tick: number,
  ordinal: number,
  resources: BrowserConformanceResourceSnapshot,
) {
  const effect = parityEffect(command.operation, result);
  const recovery = parityRecovery(result);
  const error = parityError(result, command.operation);
  const observation = parityObservation(command.operation, state);
  return {
    receipts: [{ order: { tick, ordinal }, commandId: command.id, operation: command.operation, status: result.ok ? "applied" : "failed", effect, recovery, truncated: false, revisions: { host: 0, document: 0, control: 0, capability: 1, observation: ordinal }, errorCode: error.code, errorStage: error.stage, ownership: state.owner }],
    outcome: result.ok ? { status: "completed", effect: "complete", recovery: "none", revisions: { capability: 1, observation: ordinal }, ownership: state.owner } : { status: "failed", effect, recovery, errorCode: error.code, errorStage: error.stage, ownership: state.owner },
    finalState: { readiness: "ready", controlOwner: state.owner, tabCount: 1, currentUrl: state.url, revisions: { capability: 1, observation: ordinal }, resources },
    visibleObservations: [observation],
  };
}

function parityEffect(operation: string, result: BrowserAutomationResponse): string {
  if (!result.ok) return result.error.effect ?? "none";
  const explicit = (result.result as { effect?: string }).effect;
  if (explicit) return explicit;
  if (["inspect", "snapshot", "screenshot"].includes(operation)) return "none";
  return operation === "open" ? "created" : "complete";
}

function parityRecovery(result: BrowserAutomationResponse): string {
  return result.ok ? ((result.result as { recovery?: string }).recovery ?? "none") : (result.error.recovery ?? "inspect");
}

function parityError(result: BrowserAutomationResponse, operation: string): { code: string | null; stage: string } {
  if (!result.ok) return { code: result.error.code, stage: result.error.stage ?? "effect" };
  return { code: null, stage: ["inspect", "snapshot", "screenshot"].includes(operation) ? "observation" : "effect" };
}

function parityObservation(operation: string | null, state: ParityState) {
  return { surface: "browser", readiness: "ready", controlOwner: state.owner, tabCount: 1, currentUrl: state.url, title: "Executor fixture", action: operation, truncated: false };
}

function paritySnapshotOutcome(
  receipts: BrowserConformanceReceipt[],
  state: ParityState,
  resources: BrowserConformanceResourceSnapshot,
): BrowserConformanceNormalizedRun {
  const last = receipts.at(-1);
  return normalizeBrowserConformanceRun({
    receipts,
    outcome: parityFinalOutcome(last),
    finalState: { readiness: "ready", controlOwner: state.owner, tabCount: 1, currentUrl: state.url, revisions: last?.revisions, resources },
    visibleObservations: [parityObservation(last?.operation ?? null, state)],
  });
}

function parityFinalOutcome(last: BrowserConformanceReceipt | undefined) {
  return {
    status: last?.status === "failed" ? "failed" : "completed",
    effect: last?.effect ?? "none",
    recovery: last?.recovery ?? "none",
    revisions: last?.revisions,
    ownership: last?.ownership,
  };
}

class ElectronExecutorSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly state = { url: "http://localhost:3000/", owner: "none" as "none" | "agent", observationRef: undefined as string | undefined };
  private tick = 0;
  constructor(private readonly driver: BrowserSessionDriver, private readonly kernel: BrowserAutomationKernel) {}
  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const args = replaceObservationRefs(command.args ?? {}, this.state.observationRef) as Record<string, unknown>;
    const dispatch = createParityDispatch(command, args, "electron", target(), `parity-${command.id}-${this.receipts.length}`, this.receipts.length);
    const result = BrowserAutomationResponseSchema().parse(
      await this.driver.execute(dispatch, new AbortController().signal),
    );
    applyParityResult(this.state, command, args, result);
    const receipt = normalizeBrowserConformanceRun(parityRawRun(this.state, command, result, this.tick, this.receipts.length, this.snapshotResources())).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }
  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  snapshotOutcome(): BrowserConformanceNormalizedRun { return paritySnapshotOutcome(this.receipts, this.state, this.snapshotResources()); }
  snapshotResources(): BrowserConformanceResourceSnapshot { const counters = this.kernel.getCounters(); const targets = counters.targets > 0 ? [{ id: "browser-target", generation: 1 }] : []; return createBrowserConformanceResourceSnapshot({ counts: { targets: counters.targets, queues: counters.queued, requests: counters.active + counters.cancellations }, identities: { targets } }); }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { await this.driver.releaseProviderSession("session"); this.kernel.disposeWindow(fakeWindow.id); }
}

class WebDirectExecutorSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly state = { url: "https://example.test/", owner: "none" as "none" | "agent", observationRef: undefined as string | undefined };
  private tick = 0;

  constructor(private readonly driver: BrowserSessionDriver, private readonly liveTargets: Map<string, ReturnType<typeof webTarget>>) {}

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const args = replaceObservationRefs(command.args ?? {}, this.state.observationRef) as Record<string, unknown>;
    const dispatch = createParityDispatch(command, args, "web", webTarget(), `web-direct-${command.id}-${this.receipts.length}`, this.receipts.length);
    const result = BrowserAutomationResponseSchema().parse(await this.driver.execute(dispatch, new AbortController().signal));
    applyParityResult(this.state, command, args, result);
    const receipt = normalizeBrowserConformanceRun(parityRawRun(this.state, command, result, this.tick, this.receipts.length, this.snapshotResources())).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }
  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  snapshotOutcome(): BrowserConformanceNormalizedRun { return paritySnapshotOutcome(this.receipts, this.state, this.snapshotResources()); }
  snapshotResources(): BrowserConformanceResourceSnapshot { return createBrowserConformanceResourceSnapshot({ identities: { targets: this.liveTargets.size > 0 ? [{ id: "browser-target", generation: 1 }] : [] } }); }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { await this.driver.releaseProviderSession("session"); }
}

describe("Electron Browser executor parity at BrowserSessionDriver", () => {
  it("does not normalize malformed runtime output into a successful receipt", async () => {
    const malformed = new BrowserSessionDriver({
      web: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      electron: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      isElectron: () => false,
    });
    await expect(new ElectronExecutorSubject(malformed, new BrowserAutomationKernel("linux")).dispatch({ id: "malformed", operation: "inspect" }))
      .rejects.toThrow();
  });

  let kernel: BrowserAutomationKernel;
  beforeEach(() => { currentWebContents = new FakeWebContents(); fakePreviewSession.tabsByThread.clear(); seedTarget(); kernel = new BrowserAutomationKernel("linux"); });
  afterEach(() => { kernel.disposeWindow(fakeWindow.id); });

  it("executes the shared scenario through the real Electron kernel and matches canonical outcomes", async () => {
    const execute = (dispatch: BrowserAutomationHostDispatch, _signal: AbortSignal): Promise<BrowserAutomationResponse> => kernel.execute({ sender: rendererSender } as never, dispatch);
    const electronAdapter = new ElectronBrowserSessionAdapter(execute);
    const liveTargets = new Map([["tab", target()]]);
    const driver = new BrowserSessionDriver({ web: electronAdapter, electron: electronAdapter, isElectron: () => true, supportedActOperations: ["click", "type", "navigate"], electronTabs: { list: async () => [...liveTargets.values()], close: async (closedTarget) => { liveTargets.delete(closedTarget.tabId); } } });
    const parity = createBrowserExecutorParityScenario();
    expect(getBrowserAutomationRuntimeOperations("electron")).toEqual(expect.arrayContaining([...parity.operations]));
    const subject = new ElectronExecutorSubject(driver, kernel);
    const run = await runBrowserConformanceScenarioWithReplay(parity.scenario, subject, {
      workspaceRoot,
      failingInvariant: "electron executor parity remains canonical",
    });
    expect(run).toEqual(parity.expected);
    expect(currentWebContents.debugger.commands.some((entry) => entry.method === "Input.dispatchMouseEvent")).toBe(true);
    expect(currentWebContents.debugger.commands.some((entry) => entry.method === "Input.insertText")).toBe(true);
    expect(currentWebContents.loadURL).toHaveBeenCalledWith("http://localhost:3000/final");
    expect(run.finalState.resources.targets).toBe(1);
    expect(subject.snapshotResources().targets).toBe(0);
  });

  it("directly compares one shared scenario across real web and Electron subjects", async () => {
    document.body.innerHTML = `<iframe data-thread-id="thread" data-tab-id="tab" src="about:blank"></iframe><button id="save">Save</button><input id="name" />`;
    const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: document });
    for (const element of [document.querySelector<HTMLButtonElement>("#save")!, document.querySelector<HTMLInputElement>("#name")!]) {
      Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 80, height: 20 }) });
    }
    const webTargets = new Map([["tab", webTarget()]]);
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
    const webDriver = new BrowserSessionDriver({
      web: webAdapter,
      electron: webAdapter,
      isElectron: () => false,
      supportedActOperations: ["click", "type", "navigate"],
      webTabs: { list: async () => [...webTargets.values()], close: async (closedTarget) => { webTargets.delete(closedTarget.tabId); } },
    });
    const electronKernel = new BrowserAutomationKernel("linux");
    const electronTargets = new Map([["tab", target()]]);
    const electronDriver = new BrowserSessionDriver({
      web: new ElectronBrowserSessionAdapter((dispatch) => electronKernel.execute({ sender: rendererSender } as never, dispatch)),
      electron: new ElectronBrowserSessionAdapter((dispatch) => electronKernel.execute({ sender: rendererSender } as never, dispatch)),
      isElectron: () => true,
      supportedActOperations: ["click", "type", "navigate"],
      electronTabs: { list: async () => [...electronTargets.values()], close: async (closedTarget) => { electronTargets.delete(closedTarget.tabId); } },
    });
    const parity = createBrowserExecutorParityScenario();
    const webSubject = new WebDirectExecutorSubject(webDriver, webTargets);
    const electronSubject = new ElectronExecutorSubject(electronDriver, electronKernel);
    const electronRun = await runBrowserConformanceScenarioWithReplay(parity.scenario, electronSubject, { workspaceRoot, failingInvariant: "direct web/electron parity" });
    const webRun = await runBrowserConformanceScenarioWithReplay(parity.scenario, webSubject, { workspaceRoot, failingInvariant: "direct web/electron parity" });
    expect(webRun).toEqual(electronRun);
    expect(webRun.finalState.resources.targets).toBe(1);
    expect(webSubject.snapshotResources().targets).toBe(0);
    expect(electronSubject.snapshotResources().targets).toBe(0);
  });
});
