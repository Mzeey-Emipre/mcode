import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BrowserAutomationResponseSchema,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from "@mcode/contracts";

const rendererSender = new EventEmitter() as EventEmitter & {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
};
rendererSender.isDestroyed = () => false;
rendererSender.send = vi.fn();

const fakeWindow = {
  id: 404,
  isDestroyed: () => false,
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
const tabsByThread = new Map<string, { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; view: null }> }>();

class FakeDebugger extends EventEmitter {
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
    const gate = this.gate;
    if (gate?.matches(command)) {
      this.gate = null;
      gate.reached.resolve(undefined);
      await gate.release.promise;
    }
    if (method === "Input.dispatchKeyEvent") this.owner.emit("before-input-event", {});
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.callFunctionOn") {
      const input = params as { functionDeclaration?: string; arguments?: Array<{ value?: unknown }> } | undefined;
      const source = input?.functionDeclaration ?? "";
      if (source.includes("inspectPageTarget")) {
        return { result: { value: { attached: true, visible: true, x: 10, y: 20 } } };
      }
      if (source.includes("evaluateIsolatedExpression")) {
        const argument = input?.arguments?.[0]?.value as { expression?: unknown } | undefined;
        const expression = String(argument?.expression ?? "null");
        if (expression === "never") return new Promise(() => undefined);
        if (expression === "huge") return { result: { value: { ok: false, tooLarge: true } } };
        return { result: { value: { ok: true, valueJson: "null" } } };
      }
      return { result: { value: false } };
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
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

vi.mock("../preview/preview-webview-adopt.js", () => ({
  findAdoptedWebContentsForWindow: vi.fn(() => currentWebContents),
}));

vi.mock("../preview/preview-session.js", () => ({
  getSession: vi.fn(() => ({ lastPreviewThreadId: "thread", tabsByThread })),
}));

import { BrowserAutomationKernel } from "../browser-automation/kernel.js";

function seedTab(tabId = "tab", threadId = "thread"): void {
  tabsByThread.set(threadId, {
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
    kernel = new BrowserAutomationKernel();
  });

  afterEach(() => {
    vi.useRealTimers();
    kernel.disposeWindow(fakeWindow.id);
    tabsByThread.clear();
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
