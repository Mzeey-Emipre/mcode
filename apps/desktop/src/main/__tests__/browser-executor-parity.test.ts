import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../../../web/src/services/browser-automation/browserSessionDriver";
import { BrowserAutomationKernel } from "../browser-automation/kernel.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

let currentWebContents: FakeWebContents;
const rendererSender = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
rendererSender.isDestroyed = () => false;
rendererSender.send = vi.fn();
const fakeWindow = { id: 7, isDestroyed: () => false, webContents: rendererSender };
const fakePreviewSession = {
  lastPreviewThreadId: "thread",
  tabsByThread: new Map<string, { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; view: null }> }>(),
};

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly owner: FakeWebContents) { super(); }
  isAttached(): boolean { return this.attached; }
  attach(): void { this.attached = true; }
  detach(): void { this.attached = false; }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params });
    if (method.startsWith("Input.")) this.owner.emit("before-input-event", {});
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "Runtime.callFunctionOn") {
      const source = String((params as { functionDeclaration?: string } | undefined)?.functionDeclaration ?? "");
      if (source.includes("snapshotPage")) return { result: { value: this.owner.snapshotValue } };
      if (source.includes("locatePageTarget")) return { result: { value: { x: 10, y: 20 } } };
      if (source.includes("inspectPageTarget")) return { result: { value: { attached: true, visible: true, x: 10, y: 20 } } };
      return { result: { value: { ok: true, valueJson: "null" } } };
    }
    if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    if (method === "DOM.getDocument") return { root: { backendNodeId: 1 } };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 2 } };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [] };
    if (method === "Performance.getMetrics") return { metrics: [] };
    return {};
  }
}

class FakeWebContents extends EventEmitter {
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
vi.mock("../preview/preview-webview-adopt.js", () => ({ findAdoptedWebContentsForWindow: vi.fn(() => currentWebContents) }));
vi.mock("../preview/preview-guest-input-contract.js", () => ({ PREVIEW_GUEST_AGENT_INPUT_CHANNEL: "mcode:browser-agent-input" }));
vi.mock("../preview/preview-session.js", () => ({ getSession: vi.fn(() => fakePreviewSession) }));

function seedTarget(): void {
  fakePreviewSession.tabsByThread.set("thread", { threadId: "thread", activeTabId: "tab", tabs: [{ id: "tab", threadId: "thread", view: null }] });
}

function target() {
  return { desktopInstanceId: "electron", windowId: 7, connectionGeneration: 1, threadId: "thread", tabId: "tab", targetGeneration: 0, active: true, focused: true, lastUsedAt: 0 } as const;
}

function replaceObservationRefs(value: unknown, observationRef: string | undefined): unknown {
  if (value === "$lastObservationRef") return observationRef ?? "missing-observation";
  if (Array.isArray(value)) return value.map((entry) => replaceObservationRefs(entry, observationRef));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceObservationRefs(entry, observationRef)]));
}

class ElectronExecutorSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly state = { url: "http://localhost:3000/", owner: "none" as "none" | "agent", observationRef: undefined as string | undefined };
  private tick = 0;
  constructor(private readonly driver: BrowserSessionDriver, private readonly kernel: BrowserAutomationKernel) {}
  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const args = replaceObservationRefs(command.args ?? {}, this.state.observationRef) as Record<string, unknown>;
    const dispatch = {
      scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
      connection: { desktopInstanceId: "electron", windowId: 7, connectionGeneration: 1, targetGeneration: 0, capabilityRevision: 1 },
      target: target(),
      request: { contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance", requestId: `parity-${command.id}-${this.receipts.length}`, sequence: this.receipts.length, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: command.operation, args },
    } as unknown as BrowserAutomationHostDispatch;
    const result = BrowserAutomationResponseSchema().parse(
      await this.driver.execute(dispatch, new AbortController().signal),
    );
    if (result.ok) {
      const candidate = result.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
      this.state.observationRef = candidate.nextObservationRef ?? candidate.finalObservation?.observationRef ?? candidate.observationRef ?? this.state.observationRef;
      if (["open", "navigate"].includes(command.operation)) this.state.url = String(args.url ?? this.state.url);
      if (["open", "navigate", "click", "type", "act", "tabs"].includes(command.operation)) this.state.owner = "agent";
    }
    const raw = { receipts: [{ order: { tick: this.tick, ordinal: this.receipts.length }, commandId: command.id, operation: command.operation, status: result.ok ? "applied" : "failed", effect: result.ok ? ((result.result as { effect?: string }).effect ?? (["inspect", "snapshot", "screenshot"].includes(command.operation) ? "none" : command.operation === "open" ? "created" : "complete")) : (result.error.effect ?? "none"), recovery: result.ok ? ((result.result as { recovery?: string }).recovery ?? "none") : (result.error.recovery ?? "inspect"), truncated: false, revisions: { host: 0, document: 0, control: 0, capability: 1, observation: this.receipts.length }, errorCode: result.ok ? null : result.error.code, errorStage: result.ok ? (["inspect", "snapshot", "screenshot"].includes(command.operation) ? "observation" : "effect") : (result.error.stage ?? "effect"), ownership: this.state.owner }], outcome: result.ok ? { status: "completed", effect: "complete", recovery: "none", revisions: { capability: 1, observation: this.receipts.length }, ownership: this.state.owner } : { status: "failed", effect: result.error.effect ?? "none", recovery: result.error.recovery ?? "inspect", errorCode: result.error.code, errorStage: result.error.stage ?? "effect", ownership: this.state.owner }, finalState: { readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, revisions: { capability: 1, observation: this.receipts.length }, resources: { targets: 1, identities: { targets: [{ id: "browser-target", generation: 1 }] } } }, visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, title: "Executor fixture", action: command.operation, truncated: false }] };
    const receipt = normalizeBrowserConformanceRun(raw).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }
  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.tick = tick; }
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  snapshotOutcome(): BrowserConformanceNormalizedRun { const last = this.receipts.at(-1); return normalizeBrowserConformanceRun({ receipts: this.receipts, outcome: { status: last?.status === "failed" ? "failed" : "completed", effect: last?.effect ?? "none", recovery: last?.recovery ?? "none", revisions: last?.revisions, ownership: last?.ownership }, finalState: { readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, revisions: last?.revisions, resources: { targets: 1, identities: { targets: [{ id: "browser-target", generation: 1 }] } } }, visibleObservations: [{ surface: "browser", readiness: "ready", controlOwner: this.state.owner, tabCount: 1, currentUrl: this.state.url, title: "Executor fixture", action: last?.operation ?? null, truncated: false }] }); }
  snapshotResources(): BrowserConformanceResourceSnapshot { return createBrowserConformanceResourceSnapshot({ counts: { targets: 1 }, identities: { targets: [{ id: "browser-target", generation: 1 }] } }); }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { await this.driver.releaseProviderSession("session"); this.kernel.disposeWindow(fakeWindow.id); }
}

describe("Electron Browser executor parity at BrowserSessionDriver", () => {
  it("does not normalize malformed runtime output into a successful receipt", async () => {
    const malformed = new BrowserSessionDriver({
      web: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      electron: { execute: async () => ({ ok: true, result: { operation: "inspect" } } as never) },
      isElectron: () => false,
    });
    await expect(new ElectronExecutorSubject(malformed, new BrowserAutomationKernel()).dispatch({ id: "malformed", operation: "inspect" }))
      .rejects.toThrow();
  });

  let kernel: BrowserAutomationKernel;
  beforeEach(() => { currentWebContents = new FakeWebContents(); fakePreviewSession.tabsByThread.clear(); seedTarget(); kernel = new BrowserAutomationKernel(); });
  afterEach(() => { kernel.disposeWindow(fakeWindow.id); });

  it("executes the shared scenario through the real Electron kernel and matches canonical outcomes", async () => {
    const execute = (dispatch: BrowserAutomationHostDispatch, signal: AbortSignal): Promise<BrowserAutomationResponse> => kernel.execute({ sender: rendererSender } as never, dispatch);
    const electronAdapter = new ElectronBrowserSessionAdapter(execute);
    const driver = new BrowserSessionDriver({ web: electronAdapter, electron: electronAdapter, isElectron: () => true, supportedActOperations: ["click", "type", "navigate"], electronTabs: { list: async () => [target()], close: async () => undefined } });
    const parity = createBrowserExecutorParityScenario();
    expect(getBrowserAutomationRuntimeOperations("electron")).toEqual(expect.arrayContaining([...parity.operations]));
    const run = await runBrowserConformanceScenarioWithReplay(parity.scenario, new ElectronExecutorSubject(driver, kernel), {
      workspaceRoot,
      failingInvariant: "electron executor parity remains canonical",
    });
    expect(run).toEqual(parity.expected);
    expect(currentWebContents.debugger.commands.some((entry) => entry.method === "Input.dispatchMouseEvent")).toBe(true);
    expect(currentWebContents.debugger.commands.some((entry) => entry.method === "Input.insertText")).toBe(true);
    expect(currentWebContents.loadURL).toHaveBeenCalledWith("http://localhost:3000/final");
  });
});
