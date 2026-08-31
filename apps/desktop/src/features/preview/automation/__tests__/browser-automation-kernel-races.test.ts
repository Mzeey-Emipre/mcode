import * as NodeEvents from "node:events";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BrowserAutomationResponseSchema,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import {
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceRevisionRaceSchedules,
  createBrowserConformanceScenario,
  createBrowserConformanceSchedule,
  normalizeBrowserConformanceRun,
  runBrowserConformanceScenarioWithReplay,
  type BrowserConformanceCommand,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceReceipt,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceSubject,
} from "@mcode/browser-conformance";

const rendererSender = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
};
rendererSender.isDestroyed = () => false;
rendererSender.send = vi.fn();

const fakeWindow = {
  id: 404,
  isDestroyed: () => false,
  isFocused: () => true,
  webContents: rendererSender,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Command = { method: string; params: unknown };
type CommandGate = {
  matches: (command: Command) => boolean;
  reached: Deferred<void>;
  release: Deferred<void>;
};

let currentWebContents: FakeWebContents;
const replayRoots: string[] = [];
const tabsByThread = new Map<string, { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; view: null }> }>();

class FakeDebugger extends NodeEvents.EventEmitter {
  attached = false;
  readonly commands: Command[] = [];
  private gate: CommandGate | null = null;

  constructor(private readonly owner: FakeWebContents) {
    super();
  }

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
    this.emit("detach");
  }

  blockNext(matches: CommandGate["matches"]): Pick<CommandGate, "reached" | "release" | "reject"> {
    if (this.gate) throw new Error("A command gate is already installed");
    const gate: CommandGate = { matches, reached: deferred<void>(), release: deferred<void>() };
    this.gate = gate;
    return gate;
  }

  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    const command = { method, params };
    this.commands.push(command);
    await this.releaseCommandGate(command);
    if (method === "Input.dispatchKeyEvent") this.owner.emit("before-input-event", {});
    return this.commandResult(method, params);
  }

  private async releaseCommandGate(command: Command): Promise<void> {
    const gate = this.gate;
    if (!gate?.matches(command)) return;
    this.gate = null;
    gate.reached.resolve(undefined);
    await gate.release.promise;
  }

  private commandResult(method: string, params: unknown): unknown {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.callFunctionOn") return this.callFunctionResult(params);
    return {};
  }

  private callFunctionResult(params: unknown): unknown {
    const input = params as { functionDeclaration?: string; arguments?: Array<{ value?: unknown }> } | undefined;
    const source = input?.functionDeclaration ?? "";
    if (source.includes("inspectPageTarget")) return { result: { value: { attached: true, visible: true, x: 10, y: 20 } } };
    if (source.includes("evaluateIsolatedExpression")) return this.evaluateIsolatedExpression(input);
    return { result: { value: false } };
  }

  private evaluateIsolatedExpression(input: { arguments?: Array<{ value?: unknown }> } | undefined): unknown {
    const argument = input?.arguments?.[0]?.value as { expression?: unknown } | undefined;
    const expression = String(argument?.expression ?? "null");
    if (expression === "never") return new Promise(() => undefined);
    if (expression === "huge") return { result: { value: { ok: false, tooLarge: true } } };
    return { result: { value: { ok: true, valueJson: "null" } } };
  }
}

class FakeWebContents extends NodeEvents.EventEmitter {
  readonly debugger = new FakeDebugger(this);
  readonly send = vi.fn();
  readonly stop = vi.fn();
  readonly loadURL = vi.fn(async (_url: string) => undefined);
  destroyed = false;
  hostWebContents = rendererSender;
  url = "https://example.test/";
  title = "Example";

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  isLoading(): boolean {
    return false;
  }

  isFocused(): boolean {
    return true;
  }

  async executeJavaScript(source: string): Promise<unknown> {
    if (source.includes("window.innerWidth")) return { width: 1_280, height: 720 };
    return {};
  }
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => fakeWindow),
    getAllWindows: vi.fn(() => [fakeWindow]),
  },
}));

vi.mock("../../surfaces/registry.js", () => ({
  findAdoptedWebContentsForWindow: vi.fn(() => currentWebContents),
}));

vi.mock("../../state/window-session.js", () => ({
  getSession: vi.fn(() => ({ workspaceId: "workspace", lastPreviewThreadId: "thread", tabsByThread })),
  getThreadTabSet: vi.fn((session, threadId, workspaceId = session.workspaceId ?? threadId) =>
    session.tabsByThread.get(JSON.stringify([workspaceId, threadId])) ?? session.tabsByThread.get(threadId)),
  getActiveTab: vi.fn((session, threadId) => {
    const tabSet = session.tabsByThread.get(JSON.stringify([session.workspaceId, threadId])) ?? session.tabsByThread.get(threadId);
    return tabSet.tabs.find((tab: { id: string }) => tab.id === tabSet.activeTabId);
  }),
}));

import { BrowserAutomationKernel } from "../kernel.js";
import { BrowserSessionDriver, ElectronBrowserSessionAdapter } from "../../../../../../web/src/features/preview/automation/services/browserSessionDriver";

function seedTab(tabId = "tab", threadId = "thread"): void {
  tabsByThread.set(JSON.stringify(["workspace", threadId]), {
    threadId,
    activeTabId: tabId,
    tabs: [{ id: tabId, threadId, view: null }],
  });
}

let nextRequestId = 0;

function request<T extends BrowserAutomationRequest["operation"]>(
  operation: T,
  args: Extract<BrowserAutomationRequest, { operation: T }>["args"],
  overrides: { requestId?: string; deadline?: number; threadId?: string; expectedControlEpoch?: number } = {},
): Extract<BrowserAutomationRequest, { operation: T }> {
  const requestId = overrides.requestId ?? `race-${++nextRequestId}`;
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    workspaceId: "workspace",
    threadId: overrides.threadId ?? "thread",
    providerSessionId: "provider-session",
    providerInstanceId: "provider-instance",
    requestId,
    sequence: nextRequestId,
    deadline: overrides.deadline ?? Date.now() + 5_000,
    expectedControlEpoch: overrides.expectedControlEpoch ?? 0,
    operation,
    args,
  } as Extract<BrowserAutomationRequest, { operation: T }>;
}

function dispatch(browserRequest: BrowserAutomationRequest, targetGeneration = 0, tabId = "tab") {
  return {
    scope: {
      workspaceId: browserRequest.workspaceId,
      threadId: browserRequest.threadId,
      providerSessionId: browserRequest.providerSessionId,
      providerInstanceId: browserRequest.providerInstanceId,
    },
    connection: {
      desktopInstanceId: "desktop",
      windowId: fakeWindow.id,
      connectionGeneration: 1,
      targetGeneration,
    },
    request: browserRequest,
    target: {
      desktopInstanceId: "desktop",
      windowId: fakeWindow.id,
      connectionGeneration: 1,
      threadId: browserRequest.threadId,
      tabId,
      targetGeneration,
      active: true,
      focused: true,
      lastUsedAt: 0,
    },
  };
}

function parseResponse(value: unknown): BrowserAutomationResponse {
  const parsed = BrowserAutomationResponseSchema().safeParse(value);
  expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

type ConformanceRevisions = { host: number; document: number; control: number; capability: number; observation: number };
type BrowserMutationCounters = { debuggerInput: number; navigation: number; loadURL: number };

class KernelConformanceSubject implements BrowserConformanceSubject {
  private readonly receipts: BrowserConformanceReceipt[] = [];
  private readonly requestLeases = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly timerLeases = new Set<number>();
  private readonly heldInputLeases = new Set<string>();
  private readonly controllerLeases = new Set<string>();
  private readonly replayEntries = new Map<string, string>();
  private readonly registryEntries = new Map<string, string>();
  private readonly bufferEntries = new Set<string>();
  private readonly mutationCounters?: () => BrowserMutationCounters;
  private preActMutationCounters: BrowserMutationCounters | undefined;
  private readonly revisions: ConformanceRevisions;
  private readonly admissionRevisions: ConformanceRevisions;
  private readonly liveTargets: Map<string, ReturnType<typeof kernelTarget>>;
  private tick = 0;
  private disposed = false;
  private observationRef: string | undefined;

  constructor(
    private readonly driver: BrowserSessionDriver,
    private readonly kernel: BrowserAutomationKernel,
    revisions: ConformanceRevisions,
    admissionRevisions: ConformanceRevisions,
    liveTargets = new Map([["tab", kernelTarget()]]),
    mutationCounters?: () => BrowserMutationCounters,
  ) { this.revisions = revisions; this.admissionRevisions = admissionRevisions; this.liveTargets = liveTargets; this.mutationCounters = mutationCounters; }

  mutationSnapshotBeforeAct(): BrowserMutationCounters | undefined {
    return this.preActMutationCounters;
  }

  async dispatch(command: BrowserConformanceCommand): Promise<BrowserConformanceReceipt> {
    const requestKey = this.startDispatch(command);
    const response = await this.executeDispatch(command);
    this.recordObservation(response, requestKey);
    const receipt = normalizeBrowserConformanceRun(this.rawDispatch(command, response)).receipts[0]!;
    this.receipts.push(receipt);
    return receipt;
  }

  private startDispatch(command: BrowserConformanceCommand): string {
    if (command.operation === "act" && this.mutationCounters) this.preActMutationCounters = this.mutationCounters();
    const requestKey = `${command.id}:${this.receipts.length}`;
    this.requestLeases.add(requestKey);
    this.bufferEntries.add(requestKey);
    this.registryEntries.set("provider-session", "active");
    if (command.operation === "act") this.addActLeases(requestKey);
    return requestKey;
  }

  private addActLeases(requestKey: string): void {
    this.heldInputLeases.add(requestKey);
    this.controllerLeases.add(requestKey);
  }

  private async executeDispatch(command: BrowserConformanceCommand): Promise<BrowserAutomationResponse> {
    const request = requestForConformance({ ...command, args: this.dispatchArgs(command) }, this.receipts.length);
    const envelope = dispatch(request) as unknown as BrowserAutomationHostDispatch;
    envelope.connection = { ...envelope.connection, capabilityRevision: 1 };
    return parseResponse(await this.driver.execute(envelope, new AbortController().signal));
  }

  private dispatchArgs(command: BrowserConformanceCommand): Record<string, unknown> {
    const fallback = command.operation === "inspect" ? { includeScreenshot: false, includeDiagnostics: false } : {};
    const args = { ...(command.args ?? fallback) } as Record<string, unknown>;
    if (command.operation === "act") args.observationRef = this.observationRef ?? "missing-observation";
    return args;
  }

  private recordObservation(response: BrowserAutomationResponse, requestKey: string): void {
    if (!response.ok) return;
    const result = response.result as { observationRef?: string; nextObservationRef?: string; finalObservation?: { observationRef?: string } };
    this.observationRef = result.nextObservationRef ?? result.finalObservation?.observationRef ?? result.observationRef ?? this.observationRef;
    if (this.observationRef) this.replayEntries.set(this.observationRef, requestKey);
  }

  private rawDispatch(command: BrowserConformanceCommand, response: BrowserAutomationResponse) {
    return response.ok ? this.successfulRawDispatch(command) : this.failedRawDispatch(command, response);
  }

  private successfulRawDispatch(command: BrowserConformanceCommand) {
    return this.rawDispatchResult(command, "applied", "none", "none", null, "observation", {
      status: "completed", effect: "none", recovery: "none", revisions: this.revisions,
    });
  }

  private failedRawDispatch(command: BrowserConformanceCommand, response: Extract<BrowserAutomationResponse, { ok: false }>) {
    return this.rawDispatchResult(command, "failed", response.error.effect, response.error.recovery, response.error.code, response.error.stage, {
      status: "failed", effect: response.error.effect, recovery: response.error.recovery, errorCode: response.error.code, errorStage: response.error.stage, revisions: this.revisions,
    });
  }

  private rawDispatchResult(
    command: BrowserConformanceCommand,
    status: BrowserConformanceReceipt["status"],
    effect: BrowserConformanceReceipt["effect"],
    recovery: BrowserConformanceReceipt["recovery"],
    errorCode: BrowserConformanceReceipt["errorCode"],
    errorStage: BrowserConformanceReceipt["errorStage"],
    outcome: BrowserConformanceNormalizedRun["outcome"],
  ) {
    return {
      receipts: [{
        order: { tick: this.tick, ordinal: this.receipts.length },
        commandId: command.id,
        operation: command.operation,
        status,
        effect,
        recovery,
        errorCode,
        errorStage,
        revisions: this.revisions,
      }],
      outcome,
      finalState: { readiness: "ready", controlOwner: "none", tabCount: 1, currentUrl: null, revisions: this.revisions, resources: this.snapshotResources() },
    };
  }

  schedule(eventValue: BrowserConformanceScheduledEvent): void {
    if (!this.disposed) this.scheduled.add(`${eventValue.order.tick}:${eventValue.order.ordinal}`);
  }
  async advanceClock(tick: number): Promise<void> {
    this.tick = tick;
    this.timerLeases.add(tick);
  }
  async injectExternalEvent(eventValue: BrowserConformanceScheduledEvent): Promise<void> {
    if (this.disposed) return;
    if (eventValue.kind === "target-close") {
      this.driver.clearIdempotencyForTarget("workspace", "thread", "tab");
      this.liveTargets.delete("tab");
    } else if (eventValue.kind === "target-register") {
      this.liveTargets.set("tab", kernelTarget());
    }
    const revision = eventValue.revision ?? revisionForEvent(eventValue.kind);
    if (revision) {
      this.revisions[revision] += 1;
      this.admissionRevisions[revision] += 1;
      if (revision === "observation") this.driver.invalidateTargetObservations("workspace", "thread", "tab");
    }
  }
  snapshotOutcome(): BrowserConformanceNormalizedRun {
    const last = this.receipts.at(-1);
    return normalizeBrowserConformanceRun({
      receipts: this.receipts,
      outcome: { status: last?.status === "failed" ? "failed" : "completed", effect: last?.effect ?? "none", recovery: last?.recovery ?? "none", revisions: this.revisions },
      finalState: { readiness: "ready", controlOwner: "none", tabCount: 1, currentUrl: null, revisions: this.revisions, resources: this.snapshotResources() },
    });
  }
  snapshotResources(): BrowserConformanceResourceSnapshot {
    const counters = this.kernel.getCounters();
    const listenerCount = currentWebContents.eventNames().reduce((total, name) => total + currentWebContents.listenerCount(name), 0)
      + currentWebContents.debugger.eventNames().reduce((total, name) => total + currentWebContents.debugger.listenerCount(name), 0);
    return createBrowserConformanceResourceSnapshot({
      counts: {
        requests: this.requestLeases.size,
        queues: Math.max(counters.queued, this.scheduled.size),
        timers: this.timerLeases.size,
        listeners: listenerCount,
        heldInput: this.heldInputLeases.size,
        controllerLeases: this.controllerLeases.size,
        targets: counters.targets,
        replayEntries: this.replayEntries.size,
        registries: this.registryEntries.size,
        buffers: this.bufferEntries.size,
      },
      identities: { targets: counters.targets > 0 ? [{ id: "browser-target", generation: kernelTarget().targetGeneration }] : [] },
    });
  }
  async drainToQuiescence(): Promise<void> { await settleLateWork(); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.driver.releaseProviderSession("provider-session");
    this.kernel.disposeWindow(fakeWindow.id);
    this.liveTargets.clear();
    this.requestLeases.clear();
    this.scheduled.clear();
    this.timerLeases.clear();
    this.heldInputLeases.clear();
    this.controllerLeases.clear();
    this.replayEntries.clear();
    this.registryEntries.clear();
    this.bufferEntries.clear();
  }
}

function requestForConformance(command: BrowserConformanceCommand, sequence: number): BrowserAutomationRequest {
  const args = command.args ?? (command.operation === "inspect" ? { includeScreenshot: false, includeDiagnostics: false } : {});
  return request(command.operation as BrowserAutomationRequest["operation"], args as never, { requestId: `conformance-${command.id}-${sequence}`, expectedControlEpoch: 0 });
}

const revisionByEvent: Partial<Record<BrowserConformanceScheduledEvent["kind"], keyof ConformanceRevisions>> = {
  "host-disconnect": "host",
  "host-reconnect": "host",
  navigation: "document",
  reload: "document",
  "document-revision": "document",
  "user-takeover": "control",
  "competing-mutation": "control",
  cancel: "control",
  timeout: "control",
  resize: "control",
  "control-revision": "control",
  "capability-revision": "capability",
  "observation-revision": "observation",
};

function revisionForEvent(kind: BrowserConformanceScheduledEvent["kind"]): keyof ConformanceRevisions | undefined {
  return revisionByEvent[kind];
}

function kernelTarget() {
  return { desktopInstanceId: "desktop", windowId: fakeWindow.id, connectionGeneration: 1, threadId: "thread", tabId: "tab", targetGeneration: 0, active: true, focused: true, lastUsedAt: 0 } as const;
}

function mutationCounters(webContents: FakeWebContents): BrowserMutationCounters {
  return {
    debuggerInput: webContents.debugger.commands.filter((command) => command.method.startsWith("Input.")).length,
    navigation: webContents.debugger.commands.filter((command) => command.method === "Page.navigate").length,
    loadURL: webContents.loadURL.mock.calls.length,
  };
}

function event() {
  return { sender: rendererSender } as never;
}

async function settleLateWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowserAutomationKernel race conformance", () => {
  let kernel: BrowserAutomationKernel;

  beforeEach(() => {
    currentWebContents = new FakeWebContents(1);
    tabsByThread.clear();
    seedTab();
    nextRequestId = 0;
    kernel = new BrowserAutomationKernel("linux");
  });

  afterEach(async () => {
    vi.useRealTimers();
    kernel.disposeWindow(fakeWindow.id);
    tabsByThread.clear();
    await Promise.all(replayRoots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
  });

  it("trusted takeover stops a deferred mutation and cancellation releases held input", async () => {
    const gate = currentWebContents.debugger.blockNext((command) =>
      command.method === "Input.dispatchKeyEvent" &&
      (command.params as { type?: string; key?: string }).type === "keyDown" &&
      (command.params as { type?: string; key?: string }).key === "Enter",
    );
    const heldRequest = request("type", {
      text: "typed-before-cancel",
      clear: false,
      submit: true,
      timeoutMs: 5_000,
    }, { requestId: "takeover", expectedControlEpoch: 0 });
    const held = kernel.execute(event(), dispatch(heldRequest));
    await gate.reached.promise;
    expect(currentWebContents.debugger.commands).toContainEqual(expect.objectContaining({
      method: "Input.insertText",
      params: { text: "typed-before-cancel" },
    }));
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    gate.release.resolve(undefined);
    const heldResponse = parseResponse(await held);
    expect(heldResponse).toMatchObject({
      ok: false,
      requestId: "takeover",
      error: { code: "HUMAN_INTERRUPTED", effect: "preserved", recovery: "retry" },
    });
    await settleLateWork();
    const enterKeyDown = currentWebContents.debugger.commands.findIndex((command) =>
      command.method === "Input.dispatchKeyEvent" &&
      (command.params as { type?: string; key?: string }).type === "keyDown" &&
      (command.params as { type?: string; key?: string }).key === "Enter",
    );
    expect(enterKeyDown).toBeGreaterThanOrEqual(0);
    expect(currentWebContents.debugger.commands.slice(enterKeyDown + 1)).toContainEqual(expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyUp", key: "Enter" }),
    }));
    const status = parseResponse(await kernel.execute(event(), dispatch(request("status", {}, { requestId: "takeover-status" }))));
    expect(status).toMatchObject({ ok: true, result: { controller: { controller: "human", controlEpoch: 1 } } });
  });

  it("does not continue a cleared type mutation after takeover before text insertion", async () => {
    const gate = currentWebContents.debugger.blockNext((command) =>
      command.method === "Input.dispatchKeyEvent" &&
      (command.params as { type?: string; key?: string }).type === "keyUp" &&
      (command.params as { type?: string; key?: string }).key === "Backspace",
    );
    const pending = kernel.execute(event(), dispatch(request("type", {
      text: "must-not-be-inserted",
      clear: true,
      submit: false,
      timeoutMs: 5_000,
    }, { requestId: "clear-takeover" })));

    await gate.reached.promise;
    expect(currentWebContents.debugger.commands).toContainEqual(expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyDown", key: "a" }),
    }));
    expect(currentWebContents.debugger.commands).toContainEqual(expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyDown", key: "Backspace" }),
    }));
    gate.release.resolve(undefined);
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);

    const response = parseResponse(await pending);
    expect(response).toMatchObject({
      ok: false,
      requestId: "clear-takeover",
      error: { code: "HUMAN_INTERRUPTED", effect: "preserved", recovery: "retry" },
    });
    await settleLateWork();
    expect(currentWebContents.debugger.commands.filter((command) => command.method === "Input.insertText")).toHaveLength(0);
    expect(parseResponse(await kernel.execute(event(), dispatch(request("status", {}, { requestId: "clear-takeover-status" }))))).toMatchObject({
      ok: true,
      result: { controller: { controller: "human", controlEpoch: 1 } },
    });
    expect(kernel.getCounters()).toMatchObject({ cancellations: 0, active: 0, queued: 0 });
  });

  it("does not release a clicked point after takeover before mouse release", async () => {
    const gate = currentWebContents.debugger.blockNext((command) =>
      command.method === "Input.dispatchMouseEvent" &&
      (command.params as { type?: string }).type === "mousePressed",
    );
    const pending = kernel.execute(event(), dispatch(request("click", {
      target: { x: 10, y: 20 },
      button: "left",
      clickCount: 1,
      timeoutMs: 5_000,
    }, { requestId: "click-takeover" })));

    await gate.reached.promise;
    gate.release.resolve(undefined);
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    expect(parseResponse(await pending)).toMatchObject({
      ok: false,
      requestId: "click-takeover",
      error: { code: "HUMAN_INTERRUPTED", effect: "preserved", recovery: "retry" },
    });
    await settleLateWork();
    const pointReleases = currentWebContents.debugger.commands.filter((command) =>
      command.method === "Input.dispatchMouseEvent" &&
      (command.params as { type?: string; x?: number; y?: number }).type === "mouseReleased" &&
      (command.params as { x?: number; y?: number }).x === 10 &&
      (command.params as { x?: number; y?: number }).y === 20,
    );
    expect(pointReleases).toHaveLength(0);
    expect(kernel.getCounters()).toMatchObject({ cancellations: 0, active: 0, queued: 0 });
  });

  it("does not type after a target click is interrupted", async () => {
    const gate = currentWebContents.debugger.blockNext((command) =>
      command.method === "Input.dispatchMouseEvent" &&
      (command.params as { type?: string }).type === "mousePressed",
    );
    const pending = kernel.execute(event(), dispatch(request("type", {
      target: { x: 10, y: 20 },
      text: "must-not-follow-click",
      clear: false,
      submit: false,
      timeoutMs: 5_000,
    }, { requestId: "target-click-takeover" })));

    await gate.reached.promise;
    gate.release.resolve(undefined);
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    expect(parseResponse(await pending)).toMatchObject({
      ok: false,
      requestId: "target-click-takeover",
      error: { code: "HUMAN_INTERRUPTED", effect: "preserved", recovery: "retry" },
    });
    await settleLateWork();
    expect(currentWebContents.debugger.commands.filter((command) => command.method === "Input.insertText")).toHaveLength(0);
  });

  it("reports evaluation oversize and timeout after dispatch as bounded failures", async () => {
    const oversize = parseResponse(await kernel.execute(event(), dispatch(request("evaluate", {
      idempotencyKey: "oversize",
      observationRef: "observation",
      deadlineMs: 1_000,
      expression: "huge",
      awaitPromise: true,
      timeoutMs: 1_000,
    }, { requestId: "evaluate-oversize" }))));
    expect(oversize).toMatchObject({
      ok: false,
      requestId: "evaluate-oversize",
      error: { code: "RESULT_TOO_LARGE", effect: "preserved", recovery: "manual" },
    });

    vi.useFakeTimers();
    const timeout = kernel.execute(event(), dispatch(request("evaluate", {
      idempotencyKey: "timeout",
      observationRef: "observation",
      deadlineMs: 1_000,
      expression: "never",
      awaitPromise: true,
      timeoutMs: 10,
    }, { requestId: "evaluate-timeout", deadline: Date.now() + 1_000 })));
    await vi.advanceTimersByTimeAsync(10);
    expect(parseResponse(await timeout)).toMatchObject({
      ok: false,
      requestId: "evaluate-timeout",
      error: { code: "TIMEOUT", effect: "preserved", recovery: "retry" },
    });
    vi.useRealTimers();
  });

  it("executes every seeded revision schedule through the real Electron kernel with replay hooks", async () => {
    const replayRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-kernel-conformance-"));
    replayRoots.push(replayRoot);
    const generated = createBrowserConformanceRevisionRaceSchedules({
      seed: "electron-kernel-revision-races",
      maxCommands: 2,
      maxEvents: 8,
      maxCheckpoints: 4,
      maxTick: 0,
    });
    const schedules = [...Object.values(generated.individual), ...generated.pairs, ...generated.highRisk];
    for (const generatedSchedule of schedules) {
      currentWebContents = new FakeWebContents(1);
      tabsByThread.clear();
      seedTab();
      const seededKernel = new BrowserAutomationKernel("linux");
      const revisions = { host: 1, document: 0, control: 0, capability: 1, observation: 0 };
      const liveTargets = new Map([["tab", kernelTarget()]]);
      const electronAdapter = new ElectronBrowserSessionAdapter((dispatchValue) => seededKernel.execute(event(), dispatchValue));
      const driver = new BrowserSessionDriver({
        web: electronAdapter,
        electron: electronAdapter,
        isElectron: () => true,
        getHostRevision: () => revisions.host,
        getDocumentRevision: () => revisions.document,
        getControlRevision: () => revisions.control,
        getCapabilityRevision: () => revisions.capability,
        supportedActOperations: ["click", "navigate"],
        electronTabs: { list: async () => [...liveTargets.values()], close: async (closedTarget) => { liveTargets.delete(closedTarget.tabId); } },
      });
      const subject = new KernelConformanceSubject(driver, seededKernel, { host: 0, document: 0, control: 0, capability: 0, observation: 0 }, revisions, liveTargets, () => mutationCounters(currentWebContents));
      const scenario = createBrowserConformanceScenario({
        id: `electron-kernel-${generatedSchedule.id}`,
        seed: generatedSchedule.schedule.seed,
        commands: [
          { id: "inspect-before-revision", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } },
          {
            id: "act-after-revision",
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
        fileName: `electron-kernel-${generatedSchedule.id}.json`,
        failingInvariant: "electron kernel seeded revision schedule remains bounded",
      });
      expect(run.outcome.status, generatedSchedule.id).not.toBe("unknown");
      expect(run.finalState.resources.targets, generatedSchedule.id).toBe(1);
      expect(run.finalState.resources.requests, generatedSchedule.id).toBeGreaterThan(0);
      expect(run.receipts.length, generatedSchedule.id).toBe(2);
      expect(run.receipts.every((receipt) => receipt.status !== "unknown" && receipt.effect !== "unknown" && receipt.recovery !== "unknown"), generatedSchedule.id).toBe(true);
      const terminalReceipt = run.receipts.at(-1);
      expect(terminalReceipt?.status, generatedSchedule.id).toBe("failed");
      expect(terminalReceipt?.errorCode, generatedSchedule.id).toBe(
        generatedSchedule.revisions.includes("capability") ? "CAPABILITY_CHANGED" : "STALE_TARGET_GENERATION",
      );
      expect(terminalReceipt?.effect, generatedSchedule.id).toBe("none");
      expect(subject.mutationSnapshotBeforeAct(), generatedSchedule.id).toEqual(mutationCounters(currentWebContents));
      expect(subject.snapshotResources()).toEqual(createBrowserConformanceResourceSnapshot());
    }
  });

  it("executes every named catalogue race through the real Electron adapter with replay hooks", async () => {
    const replayRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-kernel-catalogue-"));
    replayRoots.push(replayRoot);
    const exercisedRaceIds = new Set<string>();
    for (const race of BROWSER_CONFORMANCE_RACE_CATALOGUE) {
      currentWebContents = new FakeWebContents(1);
      tabsByThread.clear();
      seedTab();
      const seededKernel = new BrowserAutomationKernel("linux");
      const revisions = { host: 1, document: 0, control: 0, capability: 1, observation: 0 };
      const liveTargets = new Map([["tab", kernelTarget()]]);
      const electronAdapter = new ElectronBrowserSessionAdapter((dispatchValue) => seededKernel.execute(event(), dispatchValue));
      const driver = new BrowserSessionDriver({
        web: electronAdapter,
        electron: electronAdapter,
        isElectron: () => true,
        getHostRevision: () => revisions.host,
        getDocumentRevision: () => revisions.document,
        getControlRevision: () => revisions.control,
        getCapabilityRevision: () => revisions.capability,
        supportedActOperations: ["click", "navigate"],
        electronTabs: { list: async () => [...liveTargets.values()], close: async (closedTarget) => { liveTargets.delete(closedTarget.tabId); } },
      });
      const subject = new KernelConformanceSubject(driver, seededKernel, { host: 0, document: 0, control: 0, capability: 0, observation: 0 }, revisions, liveTargets, () => mutationCounters(currentWebContents));
      const schedule = createBrowserConformanceSchedule({
        seed: race.id,
        maxCommands: 2,
        maxEvents: race.events.length,
        maxCheckpoints: 0,
        maxTick: 0,
        eventCount: 0,
      });
      const scenario = createBrowserConformanceScenario({
        id: `electron-catalogue-${race.id}`,
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
          events: race.events.map((kind, ordinal) => ({ order: { tick: 0, ordinal }, kind })),
        },
        cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
      });
      const run = await runBrowserConformanceScenarioWithReplay(scenario, subject, {
        workspaceRoot: replayRoot,
        fileName: `electron-catalogue-${race.id}.json`,
        failingInvariant: race.invariant,
      });
      expect(run.outcome.status, race.id).not.toBe("unknown");
      expect(run.finalState.resources.requests, race.id).toBeGreaterThan(0);
      expect(run.receipts.every((receipt) => receipt.status !== "unknown" && receipt.effect !== "unknown" && receipt.recovery !== "unknown"), race.id).toBe(true);
      expect(subject.snapshotResources(), race.id).toEqual(createBrowserConformanceResourceSnapshot());
      exercisedRaceIds.add(race.id);
    }
    expect(exercisedRaceIds).toEqual(new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.id)));
  });

  it("cancellation and deadline between effects return bounded recovery without false success", async () => {
    vi.useFakeTimers();
    const gate = currentWebContents.debugger.blockNext((command) => command.method === "Input.insertText");
    const cancelledRequest = request("type", {
      text: "cancel-before-submit",
      clear: false,
      submit: true,
      timeoutMs: 5_000,
    }, { requestId: "cancel-between-effects" });
    const cancelled = kernel.execute(event(), dispatch(cancelledRequest));
    await gate.reached.promise;
    expect(kernel.cancel(cancelledRequest.requestId)).toBe(true);
    gate.release.reject(new Error("cancelled before text commit"));
    const cancelledResponse = parseResponse(await cancelled);
    expect(cancelledResponse).toMatchObject({
      ok: false,
      requestId: "cancel-between-effects",
      error: { code: "OPERATION_CANCELLED", effect: "preserved", recovery: "retry" },
    });
    expect(cancelledResponse.ok).toBe(false);
    expect(cancelledResponse.result).toBeUndefined();
    expect(currentWebContents.debugger.commands).not.toContainEqual(expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyDown", key: "Enter" }),
    }));

    const load = deferred<void>();
    currentWebContents.loadURL.mockImplementationOnce(() => load.promise);
    const deadlineRequest = request("navigate", { url: "https://deadline.example/" }, {
      requestId: "deadline-between-effects",
      deadline: Date.now() + 30,
    });
    const deadline = kernel.execute(event(), dispatch(deadlineRequest));
    await vi.advanceTimersByTimeAsync(31);
    const deadlineResponse = parseResponse(await deadline);
    expect(deadlineResponse).toMatchObject({
      ok: false,
      requestId: "deadline-between-effects",
      error: { code: "TIMEOUT", effect: "preserved", recovery: "retry" },
    });
    load.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(deadlineResponse.ok).toBe(false);
    vi.useRealTimers();
  });

  it("rejects stale late completion after target replacement without touching the new generation", async () => {
    const oldTarget = currentWebContents;
    const gate = oldTarget.debugger.blockNext((command) =>
      command.method === "Input.dispatchKeyEvent" &&
      (command.params as { type?: string; key?: string }).type === "keyDown" &&
      (command.params as { type?: string; key?: string }).key === "Enter",
    );
    const oldRequest = request("type", { text: "old-target", clear: false, submit: true, timeoutMs: 5_000 }, { requestId: "old-target" });
    const oldPending = kernel.execute(event(), dispatch(oldRequest));
    await gate.reached.promise;

    oldTarget.destroyed = true;
    oldTarget.emit("destroyed");
    currentWebContents = new FakeWebContents(2);
    seedTab();
    const replacement = currentWebContents;
    const replacementResponse = parseResponse(await kernel.execute(event(), dispatch(
      request("status", {}, { requestId: "new-target" }),
      1,
    )));
    expect(replacementResponse).toMatchObject({ ok: true, result: { controller: { controller: "none" } } });

    gate.release.resolve(undefined);
    const oldResponse = parseResponse(await oldPending);
    expect(oldResponse).toMatchObject({ ok: false, requestId: "old-target" });
    await settleLateWork();
    expect(replacement.debugger.commands.filter((command) => command.method.startsWith("Input."))).toHaveLength(0);
    expect(parseResponse(await kernel.execute(event(), dispatch(
      request("status", {}, { requestId: "new-target-after-late" }),
      1,
    )))).toMatchObject({ ok: true, result: { controller: { controller: "none", controlEpoch: 0 } } });
  });

  it("disposes active work and ignores late debugger, event, and timer activity", async () => {
    vi.useFakeTimers();
    const target = currentWebContents;
    const pending = kernel.execute(event(), dispatch(request("waitFor", {
      text: "never-observed",
      timeoutMs: 5_000,
    }, { requestId: "dispose-race" })));
    for (let attempt = 0; attempt < 20 && target.debugger.listenerCount("message") === 0; attempt += 1) {
      await Promise.resolve();
    }
    target.emit("console-message", {}, 3, "before-dispose", 1, "https://example.test/");
    target.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "before-dispose",
      request: { url: "https://example.test/resource", method: "GET" },
    });
    kernel.disposeWindow(fakeWindow.id);
    setTimeout(() => {
      target.emit("console-message", {}, 3, "late-console", 1, "https://late.example/");
      target.debugger.emit("message", {}, "Network.responseReceived", {
        requestId: "before-dispose",
        response: { url: "https://late.example/", status: 200 },
      });
    }, 5);
    parseResponse(await pending);
    await vi.advanceTimersByTimeAsync(5);

    expect(target.listenerCount("destroyed")).toBe(0);
    expect(target.listenerCount("did-start-navigation")).toBe(0);
    expect(target.listenerCount("console-message")).toBe(0);
    expect(target.debugger.listenerCount("message")).toBe(0);
    expect(target.debugger.listenerCount("detach")).toBe(0);
    expect(target.debugger.isAttached()).toBe(false);
    expect(kernel.getCounters()).toEqual({ targets: 0, targetGenerations: 0, cancellations: 0, active: 0, queued: 0 });

    currentWebContents = new FakeWebContents(2);
    seedTab();
    const consoleResponse = parseResponse(await kernel.execute(event(), dispatch(request("console", { limit: 200 }, { requestId: "post-dispose-console" }))));
    expect(consoleResponse).toMatchObject({ ok: true, result: { entries: [], truncation: { originalCount: 0 } } });
    const networkResponse = parseResponse(await kernel.execute(event(), dispatch(request("network", { failedOnly: false, limit: 200 }, { requestId: "post-dispose-network" }))));
    expect(networkResponse).toMatchObject({ ok: true, result: { entries: [], truncation: { originalCount: 0 } } });
    vi.useRealTimers();
  });

  it("bounds diagnostic buffers and target-generation tombstones during churn", async () => {
    await kernel.execute(event(), dispatch(request("network", { failedOnly: false, limit: 200 }, { requestId: "buffer-init" })));
    for (let index = 0; index < BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES + 40; index += 1) {
      currentWebContents.emit("console-message", {}, 2, `console-${index}`, index, "https://example.test/");
      currentWebContents.debugger.emit("message", {}, "Network.requestWillBeSent", {
        requestId: `request-${index}`,
        request: { url: `https://example.test/resource-${index}`, method: "GET" },
      });
      currentWebContents.debugger.emit("message", {}, "Network.responseReceived", {
        requestId: `request-${index}`,
        response: { url: `https://example.test/resource-${index}`, status: 200 },
      });
    }
    const consoleResponse = parseResponse(await kernel.execute(event(), dispatch(request("console", { limit: 200 }, { requestId: "buffer-console" }))));
    const networkResponse = parseResponse(await kernel.execute(event(), dispatch(request("network", { failedOnly: false, limit: 200 }, { requestId: "buffer-network" }))));
    expect(consoleResponse).toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
    expect(networkResponse).toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
    if (!consoleResponse.ok || !networkResponse.ok) throw new Error("Expected bounded diagnostic responses");
    expect(consoleResponse.result.operation).toBe("console");
    expect(networkResponse.result.operation).toBe("network");
    expect(consoleResponse.result.entries).toHaveLength(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES);
    expect(networkResponse.result.entries).toHaveLength(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES);

    currentWebContents.destroyed = true;
    currentWebContents.emit("destroyed");

    for (let index = 0; index < 300; index += 1) {
      const tabId = `churn-tab-${index}`;
      seedTab(tabId);
      currentWebContents = new FakeWebContents(index + 10);
      parseResponse(await kernel.execute(event(), dispatch(
        request("status", {}, { requestId: `churn-${index}` }),
        0,
        tabId,
      )));
      currentWebContents.destroyed = true;
      currentWebContents.emit("destroyed");
    }
    expect(kernel.getCounters()).toMatchObject({ targets: 0, targetGenerations: 128, cancellations: 0, active: 0, queued: 0 });
  });
});
