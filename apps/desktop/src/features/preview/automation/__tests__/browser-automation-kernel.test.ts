import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationRequest } from "@mcode/contracts";
import {
  PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
  PreviewGuestInputSuppressor,
} from "../../contracts/guest-input.js";

let currentWebContents: FakeWebContents | null = null;
const adoptedWebContents = new Map<string, FakeWebContents | null>();
const rendererSender = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
rendererSender.isDestroyed = () => false;
rendererSender.send = vi.fn();
const fakeWindow = { id: 7, isDestroyed: () => false, isFocused: () => true, webContents: rendererSender };
const SMALL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type FakeNativeImage = {
  getSize: () => { width: number; height: number };
  resize: (input: { width: number; quality?: string }) => FakeNativeImage;
  toPNG: () => Buffer;
};

function makeFakeNativeImage(buffer: Buffer, width = 1, height = 1): FakeNativeImage {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth }) => makeFakeNativeImage(buffer, nextWidth, Math.max(1, Math.floor(nextWidth * 0.75))),
    toPNG: () => buffer,
  };
}

const nativeImageCreateFromBuffer = vi.hoisted(() => vi.fn());
nativeImageCreateFromBuffer.mockImplementation((buffer: Buffer) => makeFakeNativeImage(buffer));

const fakePreviewSession = {
  lastPreviewThreadId: "thread",
  view: null,
  tabsByThread: new Map<string, { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string }> }>(),
};

function seedFakeTab(threadId = "thread", tabId = "tab") {
  fakePreviewSession.tabsByThread.set(threadId, {
    threadId,
    activeTabId: tabId,
    tabs: [{ id: tabId, threadId, view: null }],
  });
}

class FakeDebugger extends EventEmitter {
  attached = false;
  attachError = false;
  commands: Array<{ method: string; params: unknown }> = [];
  axNodes: unknown[] = [];
  performanceMetrics: unknown[] = [];
  isolatedMarker = 0;
  failKeyUpFor: string | null = null;
  failMousePressed = false;
  constructor(private readonly owner: FakeWebContents) { super(); }
  isAttached() { return this.attached; }
  attach() {
    if (this.attachError) throw new Error("conflict");
    this.attached = true;
  }
  detach() { this.attached = false; }
  async sendCommand(method: string, params?: unknown) {
    this.commands.push({ method, params });
    if (
      this.failMousePressed && method === "Input.dispatchMouseEvent" &&
      (params as { type?: string } | undefined)?.type === "mousePressed"
    ) {
      this.failMousePressed = false;
      throw new Error("mouse dispatch failed");
    }
    if (
      method === "Input.dispatchKeyEvent" &&
      (params as { type?: string; key?: string } | undefined)?.type === "keyUp" &&
      (params as { key?: string } | undefined)?.key === this.failKeyUpFor
    ) {
      this.failKeyUpFor = null;
      throw new Error("key up failed");
    }
    if (method === "Input.dispatchKeyEvent") this.owner.emit("before-input-event", {});
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "DOM.getDocument") return { root: { backendNodeId: 1 } };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 2 } };
    if (method === "Accessibility.getPartialAXTree") return { nodes: this.axNodes };
    if (method === "Performance.getMetrics") return { metrics: this.performanceMetrics };
    if (method === "Page.captureScreenshot") return { data: SMALL_PNG_BASE64 };
    if (method === "Runtime.callFunctionOn") {
      const input = params as {
        functionDeclaration?: string;
        arguments?: Array<{ value?: unknown }>;
        returnByValue?: boolean;
      };
      const source = input.functionDeclaration ?? "";
      const argument = input.arguments?.[0]?.value as Record<string, unknown> | undefined;
      if (input.returnByValue === false) return { result: { objectId: "remote-element-1" } };
      if (source.includes("snapshotPage")) {
        return {
          result: {
            value: this.owner.snapshotValue,
          },
        };
      }
      if (source.includes("inspectPageTarget")) {
        const target = argument?.target as Record<string, unknown> | undefined;
        if (target?.semanticId) {
          const semantic = this.owner.semanticElements.get(String(target.semanticId));
          return { result: { value: semantic ?? { attached: false, visible: false } } };
        }
        return { result: { value: { attached: true, visible: true, x: 10, y: 20 } } };
      }
      if (source.includes("evaluateIsolatedExpression")) {
        const expression = String(argument?.expression ?? "null");
        if (expression === "never") return new Promise(() => undefined);
        if (expression === "huge") return { result: { value: { ok: false, tooLarge: true } } };
        if (expression === "cyclic") return { result: { value: { ok: true, valueJson: '{"self":"[Circular]"}' } } };
        if (expression.includes("__mcodeEvalMarker")) this.isolatedMarker = 1;
        return { result: { value: { ok: true, valueJson: expression === "1" ? "1" : "null" } } };
      }
      if (source.includes("capturePagePerformance")) {
        return { result: { value: this.owner.performanceTiming } };
      }
      return { result: { value: false } };
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger(this);
  destroyed = false;
  hostWebContents = rendererSender;
  readonly semanticElements = new Map<string, { attached: boolean; visible: boolean; x?: number; y?: number }>();
  performanceTiming: Record<string, unknown> = {};
  snapshotValue: Record<string, unknown> = {
    url: "https://example.test/",
    title: "Example",
    loading: false,
    visibleText: "Example",
    visibleTextOriginalLength: 7,
    elements: [],
    elementCount: 0,
  };
  stop = vi.fn();
  canGoBack = vi.fn(() => true);
  canGoForward = vi.fn(() => true);
  goBack = vi.fn(() => queueMicrotask(() => this.emit("did-stop-loading")));
  goForward = vi.fn(() => queueMicrotask(() => this.emit("did-stop-loading")));
  reload = vi.fn(() => queueMicrotask(() => this.emit("did-stop-loading")));
  send = vi.fn();
  openDevTools = vi.fn();
  getMediaSourceId = vi.fn(() => `media-source-${this.id}`);
  loadURL = vi.fn(async () => undefined);
  url = "https://example.test/";
  title = "Example";
  focused = true;
  focus = vi.fn(() => {
    this.focused = true;
  });
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return false; }
  isFocused() { return this.focused; }
  async executeJavaScript(source: string) {
    if (source.includes("window.innerWidth")) return { width: 1_280, height: 720 };
    if (source.includes("__mcodeEvalMarker")) return undefined;
    if (source.includes("locatePageTarget")) return { x: 10, y: 20 };
    if (source.includes("snapshotPage")) {
      return {
        url: "https://example.test/",
        title: "Example",
        loading: false,
        visibleText: "Example",
        visibleTextOriginalLength: 7,
        elements: [],
        elementCount: 0,
      };
    }
    if (source.includes("pageIncludesText")) return false;
    return {};
  }
  capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize: () => this.capturePage(),
      toPNG: () => Buffer.from("png"),
    }));
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => fakeWindow),
    getAllWindows: vi.fn(() => [fakeWindow]),
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBuffer,
  },
}));

vi.mock("../../surfaces/registry.js", () => ({
  findAdoptedWebContentsForWindow: vi.fn((_windowId: number, threadId: string, tabId: string) => {
    const key = JSON.stringify([threadId, tabId]);
    return adoptedWebContents.has(key) ? adoptedWebContents.get(key) : currentWebContents;
  }),
}));

vi.mock("../../state/window-session.js", () => ({
  getSession: vi.fn(() => fakePreviewSession),
  getThreadTabSet: vi.fn((session, threadId) => session.tabsByThread.get(threadId)),
  getActiveTab: vi.fn((session, threadId) => {
    const tabSet = session.tabsByThread.get(threadId);
    return tabSet.tabs.find((tab: { id: string }) => tab.id === tabSet.activeTabId);
  }),
  sessions: {
    *[Symbol.iterator]() {
      yield [7, fakePreviewSession];
    },
  },
}));

import { BrowserAutomationKernel, selectAllModifierMask } from "../kernel.js";
import { isBrowserAutomationAgentOperationActive } from "../active-operation.js";

function request(
  operation: BrowserAutomationRequest["operation"],
  args: Record<string, unknown> = {},
  overrides: { requestId?: string; threadId?: string; expectedControlEpoch?: number } = {},
): BrowserAutomationRequest {
  const requestArgs = operation === "evaluate"
    ? {
        idempotencyKey: overrides.requestId ?? "evaluate-key",
        observationRef: "observation-ref",
        deadlineMs: 10_000,
        ...args,
      }
    : args;
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    workspaceId: "workspace",
    threadId: overrides.threadId ?? "thread",
    providerSessionId: "provider-session",
    providerInstanceId: "provider-instance",
    requestId: overrides.requestId ?? `request-${operation}`,
    sequence: 1,
    deadline: Date.now() + 10_000,
    expectedControlEpoch: overrides.expectedControlEpoch ?? 0,
    operation,
    args: requestArgs,
  } as BrowserAutomationRequest;
}

function event() {
  return { sender: rendererSender } as never;
}

function payload(browserRequest: BrowserAutomationRequest, targetGeneration = 0, tabId = "tab") {
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

describe("BrowserAutomationKernel", () => {
  let kernel: BrowserAutomationKernel;
  beforeEach(() => {
    adoptedWebContents.clear();
    currentWebContents = new FakeWebContents(1);
    fakePreviewSession.lastPreviewThreadId = "thread";
    fakePreviewSession.tabsByThread.clear();
    seedFakeTab();
    kernel = new BrowserAutomationKernel();
  });
  afterEach(() => {
    kernel.disposeWindow(fakeWindow.id);
    nativeImageCreateFromBuffer.mockReset();
    nativeImageCreateFromBuffer.mockImplementation((buffer: Buffer) => makeFakeNativeImage(buffer));
  });

  it("reports exact URL, activity, loading, focus, and viewport before acting", async () => {
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: true,
      result: {
        operation: "status",
        active: true,
        url: "https://example.test/",
        loading: false,
        focused: true,
        viewport: { width: 1_280, height: 720 },
      },
    });
  });

  it("returns mechanical browser_inspect facts without public semantic metadata", async () => {
    const first = await kernel.execute(event(), payload(request("inspect", {}, { requestId: "inspect-first" })));
    const second = await kernel.execute(event(), payload(request("inspect", {}, { requestId: "inspect-second" })));
    expect(first).toMatchObject({
      ok: true,
      result: {
        operation: "inspect",
        target: { threadId: "thread", tabId: "tab", sticky: true },
        tabs: [{ threadId: "thread", tabId: "tab" }],
        snapshot: { visibleText: "Example" },
      },
    });
    if (!first.ok || !second.ok || first.result.operation !== "inspect" || second.result.operation !== "inspect") throw new Error("Expected inspect results");
    expect(first.result).not.toHaveProperty("capabilities");
    expect(first.result).not.toHaveProperty("guidance");
    expect(first.result).not.toHaveProperty("capabilityRevision");
    expect(first.result).not.toHaveProperty("observationRef");
    expect(first.result).not.toHaveProperty("readiness");
    expect(second.result).not.toHaveProperty("capabilityRevision");
  });

  it("keeps capabilityRevision stable across navigation", async () => {
    const before = await kernel.execute(event(), payload(request("status", {}, { requestId: "revision-before" })));
    await kernel.execute(event(), payload(request("navigate", { url: "https://example.test/next" }, { requestId: "revision-navigation" })));
    const after = await kernel.execute(event(), payload(request("status", {}, { requestId: "revision-after" })));
    if (!before.ok || !after.ok || before.result.operation !== "status" || after.result.operation !== "status") throw new Error("Expected status results");
    expect(after.result.capabilityRevision).toBeUndefined();
  });

  it("reports a bounded sanitized non-HTTP page-initiated location", async () => {
    currentWebContents!.url = "data:text/html,secret-page-payload";
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: true,
      result: { operation: "status", url: "data:[REDACTED]" },
    });
    currentWebContents!.url = "about:blank";
    await expect(kernel.execute(event(), payload(request("status", {}, { requestId: "about-status" })))).resolves.toMatchObject({
      ok: true,
      result: { operation: "status", url: "about:blank" },
    });
  });

  it("redacts secret-shaped page titles from action results", async () => {
    currentWebContents!.title = "Account access_token=raw-title-secret";
    const result = await kernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })));
    expect(result).toMatchObject({
      ok: true,
      result: { title: "Account access_token=[REDACTED]" },
    });
  });

  it("uses native Select All modifiers across desktop platforms", () => {
    expect(selectAllModifierMask("darwin")).toBe(4);
    expect(selectAllModifierMask("win32")).toBe(2);
    expect(selectAllModifierMask("linux")).toBe(2);
  });

  it("rejects stale renderer operation epochs before local UI work begins", async () => {
    await kernel.execute(event(), payload(request("status", {}, { requestId: "seed-status" })));
    kernel.interrupt(event(), { threadId: "thread", tabId: "tab" });
    const stale = request("resize", { width: 800, height: 600 }, { requestId: "stale-resize" });
    await expect(kernel.beginRendererOperation(event(), payload(stale))).resolves.toMatchObject({
      ok: false,
      response: { ok: false, error: { code: "STALE_CONTROL_EPOCH" } },
    });
  });

  it("serializes and cancels renderer-owned operations on the exact target", async () => {
    const firstRequest = request("recordingStart", { maxDurationMs: 60_000 }, { requestId: "renderer-first" });
    const secondRequest = request("resize", { width: 800, height: 600 }, { requestId: "renderer-second" });
    const first = await kernel.beginRendererOperation(event(), payload(firstRequest));
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error("first renderer lease was rejected");

    let secondSettled = false;
    const secondPending = kernel.beginRendererOperation(event(), payload(secondRequest)).then((value) => {
      secondSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(kernel.finishRendererOperation(event(), { leaseId: first.leaseId, succeeded: true })).toBe(true);

    const second = await secondPending;
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error("second renderer lease was rejected");
    expect(kernel.cancel(secondRequest.requestId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.finishRendererOperation(event(), { leaseId: second.leaseId, succeeded: true })).toBe(false);
    expect(kernel.getCounters()).toMatchObject({ active: 0, queued: 0, cancellations: 0 });
  });

  it("classifies only the exact guest while its automation operation is active", async () => {
    let finishNavigation!: () => void;
    currentWebContents!.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }));
    const otherGuest = new FakeWebContents(99);
    const pending = kernel.execute(event(), payload(request("open", { url: "https://example.test" }, { requestId: "popup-source" })));
    await Promise.resolve();
    expect(isBrowserAutomationAgentOperationActive(currentWebContents! as never)).toBe(true);
    expect(isBrowserAutomationAgentOperationActive(otherGuest as never)).toBe(false);
    finishNavigation();
    await pending;
    expect(isBrowserAutomationAgentOperationActive(currentWebContents! as never)).toBe(false);
  });

  it("rejects stale target generations after a webview replacement", async () => {
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({ ok: true });
    currentWebContents = new FakeWebContents(2);
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_TARGET_GENERATION" },
    });
    await expect(kernel.execute(event(), payload(request("status"), 1))).resolves.toMatchObject({ ok: true });
  });

  it("describes target generations without exposing WebContents details", () => {
    expect(kernel.describeTarget(event(), { threadId: "thread", tabId: "tab" })).toEqual({
      ok: true,
      target: { windowId: 7, threadId: "thread", tabId: "tab", targetGeneration: 0, active: true, focused: true, lastUsedAt: 0 },
    });
    currentWebContents = new FakeWebContents(2);
    expect(kernel.describeTarget(event(), { threadId: "thread", tabId: "tab" })).toEqual({
      ok: true,
      target: { windowId: 7, threadId: "thread", tabId: "tab", targetGeneration: 1, active: true, focused: true, lastUsedAt: 0 },
    });
    expect(kernel.describeTarget(event(), { threadId: "thread", tabId: "missing" })).toEqual({
      ok: false,
      error: "TAB_UNAVAILABLE",
    });
  });

  it("issues media source ids only for the current exact adopted target", () => {
    expect(kernel.getMediaSourceId(event(), {
      windowId: 7,
      threadId: "thread",
      tabId: "tab",
      targetGeneration: 0,
    })).toMatchObject({ ok: true, mediaSourceId: "media-source-1" });
    expect(currentWebContents!.getMediaSourceId).toHaveBeenCalledWith(rendererSender);
    currentWebContents = new FakeWebContents(2);
    expect(kernel.getMediaSourceId(event(), {
      windowId: 7,
      threadId: "thread",
      tabId: "tab",
      targetGeneration: 0,
    })).toEqual({ ok: false, error: "STALE_TARGET_GENERATION" });
    expect(kernel.getMediaSourceId(event(), {
      windowId: 8,
      threadId: "thread",
      tabId: "tab",
      targetGeneration: 1,
    })).toEqual({ ok: false, error: "STALE_TARGET_GENERATION" });
  });

  it("keeps adversarial colon ids in distinct target queues and generations", async () => {
    seedFakeTab("a:b", "c");
    seedFakeTab("a", "b:c");
    const first = request("status", {}, { threadId: "a:b", requestId: "colon-first" });
    const second = request("status", {}, { threadId: "a", requestId: "colon-second" });
    await expect(kernel.execute(event(), payload(first, 0, "c"))).resolves.toMatchObject({ ok: true });
    await expect(kernel.execute(event(), payload(second, 0, "b:c"))).resolves.toMatchObject({ ok: true });
    expect(kernel.getCounters().targets).toBe(2);
  });

  it("moves the control epoch on human interruption", async () => {
    await kernel.execute(event(), payload(request("status")));
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: true,
      result: {
        operation: "status",
        controller: { controller: "human", controlEpoch: 1 },
      },
    });
    await expect(kernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })))).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_CONTROL_EPOCH" },
    });
  });

  it("does not treat synthetic keyboard input as human takeover and releases held input", async () => {
    let syntheticInputObserved = false;
    currentWebContents!.on("before-input-event", () => {
      syntheticInputObserved = true;
    });
    const pressed = await kernel.execute(event(), payload(request("press", { key: "A", modifiers: ["Shift"] })));
    expect(pressed).toMatchObject({ ok: true });
    expect(syntheticInputObserved).toBe(true);
    const commands = currentWebContents!.debugger.commands.map((command) => command.method);
    expect(commands.filter((method) => method === "Input.dispatchKeyEvent").length).toBeGreaterThanOrEqual(4);
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controller: "agent", controlEpoch: 0 } },
    });
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
  });

  it("revokes failed CDP input before an immediate trusted human takeover", async () => {
    const suppressor = new PreviewGuestInputSuppressor();
    currentWebContents!.send.mockImplementation((channel: string, message: unknown) => {
      if (channel !== PREVIEW_GUEST_AGENT_INPUT_CHANNEL) return;
      if ((message as { action?: unknown }).action === "revoke") suppressor.revoke(message);
      else suppressor.allow(message);
    });
    currentWebContents!.debugger.failMousePressed = true;
    await expect(kernel.execute(event(), payload(request("click", {
      target: { x: 10, y: 20 },
      button: "left",
      clickCount: 1,
      timeoutMs: 1_000,
    }, { requestId: "failed-pointer-dispatch" })))).resolves.toMatchObject({ ok: false });
    expect(currentWebContents!.send).toHaveBeenNthCalledWith(
      1,
      PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
      expect.objectContaining({ action: "allow", kind: "pointer", generation: 1 }),
    );
    expect(currentWebContents!.send).toHaveBeenNthCalledWith(
      2,
      PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
      expect.objectContaining({ action: "revoke", generation: 1 }),
    );
    expect(suppressor.consume("pointer")).toBe(false);
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
  });

  it("does not treat click-triggered link navigation as human takeover", async () => {
    vi.useFakeTimers();
    currentWebContents!.semanticElements.set("link", { attached: true, visible: true, x: 10, y: 20 });
    await kernel.execute(event(), payload(request("click", {
      target: { semanticId: "link" },
      button: "left",
      clickCount: 1,
      timeoutMs: 1_000,
    }, { requestId: "click-link" })));
    currentWebContents!.emit("did-start-navigation", {}, "https://example.test/next", false, true);
    await expect(kernel.execute(event(), payload(request("status", {}, { requestId: "status-after-click-navigation" })))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controller: "agent", controlEpoch: 0 } },
    });
    vi.useRealTimers();
  });

  it("keeps opaque semantic identities stable across reorder and rejects removal or replacement", async () => {
    currentWebContents!.semanticElements.set("opaque-original", { attached: true, visible: true, x: 10, y: 20 });
    currentWebContents!.semanticElements.set("opaque-sibling", { attached: true, visible: true, x: 30, y: 40 });
    const click = (semanticId: string, requestId: string) => kernel.execute(
      event(),
      payload(request("click", {
        target: { semanticId },
        button: "left",
        clickCount: 1,
        timeoutMs: 1_000,
      }, { requestId })),
    );
    await expect(click("opaque-original", "semantic-before-reorder")).resolves.toMatchObject({ ok: true });
    const original = currentWebContents!.semanticElements.get("opaque-original")!;
    currentWebContents!.semanticElements.delete("opaque-original");
    currentWebContents!.semanticElements.set("opaque-original", original);
    await expect(click("opaque-original", "semantic-after-reorder")).resolves.toMatchObject({ ok: true });
    currentWebContents!.semanticElements.set("opaque-original", { attached: false, visible: false });
    currentWebContents!.semanticElements.set("opaque-replacement", { attached: true, visible: true, x: 10, y: 20 });
    await expect(click("opaque-original", "semantic-stale")).resolves.toMatchObject({ ok: false, error: { code: "TARGET_NOT_FOUND" } });
    await expect(click("opaque-replacement", "semantic-replacement")).resolves.toMatchObject({ ok: true });
  });

  it("publishes a resolved semantic target pointer before agent input", async () => {
    const states: unknown[] = [];
    const unsubscribe = kernel.subscribe(7, (state) => states.push(state));
    currentWebContents!.semanticElements.set("semantic-button", { attached: true, visible: true, x: 25, y: 40 });
    await kernel.execute(event(), payload(request("click", {
      target: { semanticId: "semantic-button" },
      button: "left",
      clickCount: 1,
      timeoutMs: 1_000,
    }, { requestId: "semantic-pointer" })));
    expect(states).toContainEqual(expect.objectContaining({
      controller: "agent",
      pointer: { x: 25, y: 40 },
    }));
    expect(currentWebContents!.send).toHaveBeenCalledWith(
      "mcode:browser-agent-input",
      expect.objectContaining({ kind: "pointer", count: 1 }),
    );
    unsubscribe();
  });

  it("scrolls an off-screen semantic target into view before clicking", async () => {
    currentWebContents!.semanticElements.set("offscreen-button", { attached: true, visible: true, x: 25, y: 40 });

    await kernel.execute(event(), payload(request("click", {
      target: { semanticId: "offscreen-button" },
      button: "left",
      clickCount: 1,
      timeoutMs: 1_000,
    }, { requestId: "offscreen-semantic-target" })));

    const targetResolution = currentWebContents!.debugger.commands.findLast(
      ({ method, params }) => method === "Runtime.callFunctionOn" &&
        (params as { functionDeclaration?: string }).functionDeclaration?.includes("inspectPageTarget"),
    );
    expect(targetResolution?.params).toMatchObject({
      arguments: [{ value: { target: { semanticId: "offscreen-button" }, scrollIntoView: true } }],
    });
  });

  it("retains agent control between Browser calls until the renderer releases the turn", async () => {
    await expect(kernel.execute(event(), payload(request("press", {
      key: "A",
      modifiers: [],
    }, { requestId: "retained-agent-control" })))).resolves.toMatchObject({ ok: true });

    await expect(kernel.execute(event(), payload(request("status", {}, {
      requestId: "status-during-agent-turn",
    })))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controller: "agent", controlEpoch: 0 } },
    });

    expect(kernel.releaseAgentControl(event(), {
      threadId: "thread",
      tabId: "tab",
      controlEpoch: 0,
      providerSessionId: "provider-session",
    })).toBe(true);
    await expect(kernel.execute(event(), payload(request("status", {}, {
      requestId: "status-after-agent-turn",
    })))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controller: "none", controlEpoch: 0 } },
    });
  });

  it("restores native focus to the active user tab after background agent input", async () => {
    const userWebContents = new FakeWebContents(10);
    const agentWebContents = new FakeWebContents(11);
    userWebContents.focused = false;
    agentWebContents.focused = true;
    fakePreviewSession.tabsByThread.set("thread", {
      threadId: "thread",
      activeTabId: "user-tab",
      tabs: [
        { id: "user-tab", threadId: "thread", view: null },
        { id: "agent-tab", threadId: "thread", view: null },
      ],
    });
    adoptedWebContents.set(JSON.stringify(["thread", "user-tab"]), userWebContents);
    adoptedWebContents.set(JSON.stringify(["thread", "agent-tab"]), agentWebContents);

    await expect(kernel.execute(event(), payload(request("press", {
      key: "A",
      modifiers: [],
    }, { requestId: "background-agent-input" }), 0, "agent-tab"))).resolves.toMatchObject({ ok: true });

    expect(userWebContents.focus).toHaveBeenCalledOnce();
  });

  it("rejects sessionless and stale same-epoch releases after a newer inspect turn", async () => {
    const oldInspect = {
      ...request("inspect", {}, { requestId: "inspect-old-turn" }),
      providerSessionId: "provider-session-old",
    } as BrowserAutomationRequest;
    const newInspect = {
      ...request("inspect", {}, { requestId: "inspect-new-turn" }),
      providerSessionId: "provider-session-new",
    } as BrowserAutomationRequest;

    await expect(kernel.execute(event(), payload(oldInspect))).resolves.toMatchObject({ ok: true });
    await expect(kernel.execute(event(), payload(newInspect))).resolves.toMatchObject({ ok: true });

    expect(kernel.releaseAgentControl(event(), {
      threadId: "thread",
      tabId: "tab",
      controlEpoch: 0,
    })).toBe(false);
    expect(kernel.releaseAgentControl(event(), {
      threadId: "thread",
      tabId: "tab",
      controlEpoch: 0,
      providerSessionId: "provider-session-old",
    })).toBe(false);
    await expect(kernel.execute(event(), payload(request("status", {}, {
      requestId: "status-after-stale-release",
    })))).resolves.toMatchObject({
      ok: true,
      result: {
        controller: {
          controller: "agent",
          controlEpoch: 0,
          providerSessionId: "provider-session-new",
        },
      },
    });
    expect(kernel.releaseAgentControl(event(), {
      threadId: "thread",
      tabId: "tab",
      controlEpoch: 0,
      providerSessionId: "provider-session-new",
    })).toBe(true);
  });

  it("distinguishes attached, visible, hidden, and detached wait states", async () => {
    currentWebContents!.semanticElements.set("visible-element", { attached: true, visible: true, x: 1, y: 1 });
    currentWebContents!.semanticElements.set("hidden-element", { attached: true, visible: false });
    const wait = (semanticId: string, state: string, requestId: string) => kernel.execute(
      event(),
      payload(request("waitFor", { target: { semanticId }, state, timeoutMs: 25 }, { requestId })),
    );
    await expect(wait("hidden-element", "attached", "wait-attached")).resolves.toMatchObject({ ok: true });
    await expect(wait("visible-element", "visible", "wait-visible")).resolves.toMatchObject({ ok: true });
    await expect(wait("hidden-element", "hidden", "wait-hidden")).resolves.toMatchObject({ ok: true });
    await expect(wait("missing-element", "detached", "wait-detached")).resolves.toMatchObject({ ok: true });
    await expect(wait("missing-element", "hidden", "wait-hidden-not-detached")).resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("returns a recoverable typed debugger conflict", async () => {
    currentWebContents!.debugger.attachError = true;
    await expect(kernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })))).resolves.toMatchObject({
      ok: false,
      error: { code: "DEBUGGER_CONFLICT", retryable: true },
    });
    currentWebContents!.debugger.attachError = false;
    await expect(kernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })))).resolves.toMatchObject({ ok: true });
  });

  it("does not poison human takeover when debugger attachment fails", async () => {
    currentWebContents!.debugger.attachError = true;
    await expect(kernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })))).resolves.toMatchObject({
      ok: false,
      error: { code: "DEBUGGER_CONFLICT" },
    });
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    await expect(kernel.execute(event(), payload(request("status", {}, { requestId: "status-after-attach-failure" })))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controller: "human", controlEpoch: 1 } },
    });
  });

  it("releases the exact held key after key-up failure", async () => {
    vi.useFakeTimers();
    currentWebContents!.debugger.failKeyUpFor = "Enter";
    await expect(kernel.execute(event(), payload(request("press", { key: "Enter", modifiers: [] })))).resolves.toMatchObject({
      ok: false,
    });
    const enterUps = currentWebContents!.debugger.commands.filter(({ method, params }) =>
      method === "Input.dispatchKeyEvent" &&
      (params as { type?: string; key?: string }).type === "keyUp" &&
      (params as { type?: string; key?: string }).key === "Enter",
    );
    expect(enterUps).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(251);
    expect(kernel.interrupt(event(), { threadId: "thread", tabId: "tab" })).toBe(true);
    vi.useRealTimers();
  });

  it("does not issue automation commands through an externally owned debugger", async () => {
    currentWebContents!.debugger.attached = true;
    await expect(kernel.execute(
      event(),
      payload(request("press", { key: "A", modifiers: [] }, { requestId: "external-debugger" })),
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "DEBUGGER_CONFLICT", retryable: true },
    });
    expect(currentWebContents!.debugger.isAttached()).toBe(true);
    expect(currentWebContents!.debugger.commands).toEqual([]);
  });

  it("keeps exact-target diagnostic floods bounded and strips secrets", async () => {
    await kernel.execute(event(), payload(request("network", { failedOnly: false, limit: 200 })));
    currentWebContents!.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "request-1",
      request: { url: "https://example.test/api?token=secret#private", method: "POST" },
    });
    currentWebContents!.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "request-1",
      response: { url: "https://example.test/api?token=secret#private", status: 401 },
    });
    for (let index = 0; index < 1_000; index += 1) {
      currentWebContents!.emit(
        "console-message",
        {},
        3,
        `message-${index} Authorization: Bearer raw-secret`,
        index,
        "https://example.test/app.js?session=private#source",
      );
    }
    const network = await kernel.execute(event(), payload(request("network", { failedOnly: false, limit: 200 })));
    expect(network).toMatchObject({
      ok: true,
      result: {
        operation: "network",
        entries: [{ url: "https://example.test/api", method: "POST", status: 401 }],
      },
    });
    const consoleResult = await kernel.execute(event(), payload(request("console", { limit: 200 })));
    expect(consoleResult).toMatchObject({ ok: true, result: { operation: "console" } });
    if (!consoleResult.ok || consoleResult.result.operation !== "console") throw new Error("Expected console result");
    expect(consoleResult.result.entries).toHaveLength(200);
    expect(consoleResult.result.entries[0]).toMatchObject({
      text: expect.stringContaining("message-800"),
      sourceUrl: "https://example.test/app.js",
    });
    expect(consoleResult.result.entries.at(-1)?.text).not.toContain("raw-secret");
  });

  it("filters console diagnostics by an exact sanitized source", async () => {
    await kernel.execute(event(), payload(request("status", {}, { requestId: "console-source-seed" })));
    currentWebContents!.emit("console-message", {}, 1, "from app", 1, "https://example.test/app.js?private=1");
    currentWebContents!.emit("console-message", {}, 1, "from worker", 2, "https://example.test/worker.js");
    const filtered = await kernel.execute(event(), payload(request("console", {
      source: "https://example.test/app.js",
      limit: 200,
    }, { requestId: "console-source-filter" })));
    expect(filtered).toMatchObject({
      ok: true,
      result: {
        entries: [{ text: "from app", sourceUrl: "https://example.test/app.js" }],
        truncation: { truncated: false, originalCount: 1 },
      },
    });
  });

  it("cancels work when the exact target navigates or closes", async () => {
    const waiting = kernel.execute(event(), payload(request("waitFor", { text: "never", timeoutMs: 5_000 })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    currentWebContents!.emit("did-start-navigation", {}, "https://other.test/", false, true);
    await expect(waiting).resolves.toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });

    const nextWebContents = new FakeWebContents(2);
    currentWebContents = nextWebContents;
    await kernel.execute(event(), payload({ ...request("status"), expectedControlEpoch: 1 }, 1));
    const waitingOnClose = kernel.execute(event(), payload({ ...request("waitFor", { text: "never", timeoutMs: 5_000 }), expectedControlEpoch: 0 }, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    nextWebContents.destroyed = true;
    nextWebContents.emit("destroyed");
    await expect(waitingOnClose).resolves.toMatchObject({ ok: false });
  });

  it("cancels an in-flight browser wait through the request signal", async () => {
    const waiting = kernel.execute(event(), payload(request(
      "wait",
      { durationMs: 5_000 },
      { requestId: "wait-cancel" },
    )));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kernel.cancel("wait-cancel")).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED" },
    });
  });

  it("stops an exact cancelled navigation and ignores its late completion", async () => {
    let finishNavigation!: () => void;
    currentWebContents!.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }));
    const navigatingRequest = request(
      "navigate",
      { url: "https://other.test/" },
      { requestId: "navigation-cancel" },
    );
    const navigating = kernel.execute(event(), payload(navigatingRequest));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(kernel.cancel("navigation-cancel")).toBe(true);
    await expect(navigating).resolves.toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    expect(currentWebContents!.stop).toHaveBeenCalledOnce();
    finishNavigation();
    await Promise.resolve();
    await expect(kernel.execute(event(), payload(request("status", {}, { requestId: "after-late-navigation" })))).resolves.toMatchObject({
      ok: true,
      result: { controller: { controlEpoch: 0 } },
    });
  });

  it("accepts an aborted load after the requested navigation commits", async () => {
    const targetUrl = "https://www.google.test/search?q=browser";
    const committedUrl = `${targetUrl}&source=redirect`;
    currentWebContents!.loadURL.mockImplementationOnce(async () => {
      currentWebContents!.url = committedUrl;
      throw Object.assign(new Error("ERR_ABORTED (-3)"), {
        code: "ERR_ABORTED",
        errno: -3,
      });
    });

    await expect(kernel.execute(
      event(),
      payload(request("navigate", { url: targetUrl }, { requestId: "redirect-committed" })),
    )).resolves.toMatchObject({
      ok: true,
      result: { operation: "navigate", url: committedUrl },
    });
  });

  it("rejects an aborted load that leaves the previous page unchanged", async () => {
    currentWebContents!.loadURL.mockRejectedValueOnce(Object.assign(new Error("ERR_ABORTED (-3)"), {
      code: "ERR_ABORTED",
      errno: -3,
    }));

    await expect(kernel.execute(
      event(),
      payload(request(
        "navigate",
        { url: "https://other.test/" },
        { requestId: "redirect-not-committed" },
      )),
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "NAVIGATION_FAILED" },
    });
  });

  it("stops every timed-out navigation before returning its error response", async () => {
    vi.useFakeTimers();
    try {
      for (let index = 0; index < 12; index += 1) {
        currentWebContents!.loadURL.mockImplementationOnce(() => new Promise<void>(() => undefined));
        const timedNavigation = {
          ...request("navigate", { url: `https://slow-${index}.test/` }, { requestId: `navigation-timeout-${index}` }),
          deadline: Date.now() + 1_000,
        } as BrowserAutomationRequest;
        const navigating = kernel.execute(event(), payload(timedNavigation));
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(navigating).resolves.toMatchObject({
          ok: false,
          error: { code: "TIMEOUT" },
        });
        expect(currentWebContents!.stop).toHaveBeenCalledTimes(index + 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects duplicate live request ids and cleans cancellation by identity", async () => {
    const first = kernel.execute(
      event(),
      payload(request("waitFor", { text: "never", timeoutMs: 5_000 }, { requestId: "duplicate-live" })),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(kernel.execute(
      event(),
      payload(request("status", {}, { requestId: "duplicate-live" })),
    )).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(kernel.cancel("duplicate-live")).toBe(true);
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    await expect(kernel.execute(
      event(),
      payload(request("status", {}, { requestId: "duplicate-live" })),
    )).resolves.toMatchObject({ ok: true });
  });

  it("releases owned automation debugging for DevTools and preserves external debugging", async () => {
    await kernel.execute(event(), payload(request("press", { key: "A", modifiers: [], timeoutMs: 1_000 })));
    expect(currentWebContents!.debugger.isAttached()).toBe(true);
    await expect(kernel.openDevTools(event())).resolves.toBe(true);
    expect(currentWebContents!.debugger.isAttached()).toBe(false);
    expect(currentWebContents!.openDevTools).toHaveBeenCalledWith({ mode: "detach" });

    kernel.disposeWindow(fakeWindow.id);
    kernel = new BrowserAutomationKernel();
    currentWebContents = new FakeWebContents(2);
    currentWebContents.debugger.attached = true;
    await kernel.execute(event(), payload(request("status", {}, { requestId: "external-debugger-state" })));
    await expect(kernel.openDevTools(event())).resolves.toBe(true);
    expect(currentWebContents.debugger.isAttached()).toBe(true);
  });

  it("opens DevTools for the requested exact thread and tab instead of the last preview", async () => {
    const first = currentWebContents!;
    const second = new FakeWebContents(2);
    seedFakeTab("thread-two", "tab-two");
    adoptedWebContents.set(JSON.stringify(["thread", "tab"]), first);
    adoptedWebContents.set(JSON.stringify(["thread-two", "tab-two"]), second);

    await expect(kernel.openDevTools(event(), {
      threadId: "thread-two",
      tabId: "tab-two",
    })).resolves.toBe(true);
    expect(first.openDevTools).not.toHaveBeenCalled();
    expect(second.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    adoptedWebContents.set(JSON.stringify(["thread-two", "tab-two"]), null);
    await expect(kernel.openDevTools(event(), {
      threadId: "thread-two",
      tabId: "tab-two",
    })).resolves.toBe(false);
    expect(first.openDevTools).not.toHaveBeenCalled();
    await expect(kernel.openDevTools(event(), {
      threadId: "thread-two",
      tabId: "missing-tab",
    })).resolves.toBe(false);
  });

  it("keeps target generations monotonic after destruction", async () => {
    await kernel.execute(event(), payload(request("status")));
    currentWebContents!.destroyed = true;
    currentWebContents!.emit("destroyed");
    currentWebContents = new FakeWebContents(2);
    await expect(kernel.execute(event(), payload(request("status")))).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_TARGET_GENERATION" },
    });
    await expect(kernel.execute(event(), payload(request("status"), 1))).resolves.toMatchObject({ ok: true });
  });

  it("evaluates only in the isolated world with bounded cyclic and never-settling behavior", async () => {
    const evaluate = (expression: string, requestId: string, awaitPromise = true, timeoutMs = 50) => kernel.execute(
      event(),
      payload(request("evaluate", { expression, awaitPromise, timeoutMs }, { requestId })),
    );
    await expect(evaluate("cyclic", "evaluate-cyclic")).resolves.toMatchObject({
      ok: true,
      result: { operation: "evaluate", valueJson: '{"self":"[Circular]"}' },
    });
    await expect(evaluate("huge", "evaluate-huge")).resolves.toMatchObject({
      ok: false,
      error: { code: "RESULT_TOO_LARGE" },
    });
    await expect(evaluate("never", "evaluate-never", true, 10)).resolves.toMatchObject({
      ok: false,
      error: { code: "TIMEOUT" },
    });
    expect(currentWebContents!.debugger.commands.some((command) => command.method === "Runtime.terminateExecution")).toBe(true);
    await expect(evaluate("globalThis.__mcodeEvalMarker=1", "evaluate-isolation", false)).resolves.toMatchObject({ ok: true });
    expect(currentWebContents!.debugger.isolatedMarker).toBe(1);
    await expect(currentWebContents!.executeJavaScript("globalThis.__mcodeEvalMarker")).resolves.toBeUndefined();
    const evaluateCommand = currentWebContents!.debugger.commands.findLast(
      (command) => command.method === "Runtime.callFunctionOn" &&
        String((command.params as { functionDeclaration?: string }).functionDeclaration).includes("evaluateIsolatedExpression"),
    );
    expect(evaluateCommand?.params).toMatchObject({ executionContextId: 42, returnByValue: true });
  });

  it("rejects hostile or oversized request boundaries before execution", async () => {
    const oversized = payload(request("evaluate", {
      expression: "x".repeat(70_000),
      awaitPromise: true,
      timeoutMs: 1_000,
    }));
    await expect(kernel.execute(event(), oversized))
      .resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const mismatchedScope = payload(request("status"));
    mismatchedScope.scope.threadId = "other-thread";
    await expect(kernel.execute(event(), mismatchedScope))
      .resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const wrongWindow = payload(request("status"));
    wrongWindow.connection.windowId = 99;
    wrongWindow.target.windowId = 99;
    await expect(kernel.execute(event(), wrongWindow))
      .resolves.toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
  });

  it("returns contract-valid results or honest unsupported errors for all 18 operations", async () => {
    const cases: Array<[BrowserAutomationRequest["operation"], Record<string, unknown>, boolean]> = [
      ["status", {}, true],
      ["open", { activate: true }, true],
      ["navigate", { url: "https://example.test/" }, true],
      ["back", {}, true],
      ["forward", {}, true],
      ["reload", {}, true],
      ["resize", { width: 800, height: 600 }, false],
      ["snapshot", { includeScreenshot: false }, true],
      ["screenshot", { maxWidth: 1_280, fullPage: false }, true],
      ["click", { target: { x: 1, y: 1 }, button: "left", clickCount: 1 }, true],
      ["type", { text: "hello", clear: false, submit: false }, true],
      ["press", { key: "A", modifiers: [] }, true],
      ["scroll", { deltaX: 0, deltaY: 100 }, true],
      ["wait", { durationMs: 1 }, true],
      ["waitFor", { url: "https://example.test/" }, true],
      ["console", { limit: 10 }, true],
      ["network", { failedOnly: false, limit: 10 }, true],
      ["accessibility", { limit: 10 }, true],
      ["performance", { includeMemory: true }, true],
      ["evaluate", { expression: "1", awaitPromise: true }, true],
      ["recordingStart", { maxDurationMs: 1_000 }, false],
      ["recordingStop", {}, false],
    ];
    for (const [operation, args, supported] of cases) {
      const response = await kernel.execute(event(), payload(request(operation, args)));
      if (supported) expect(response, `${operation}: ${JSON.stringify(response)}`).toMatchObject({ ok: true });
      else expect(response, operation).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_OPERATION" } });
    }
  });

  it("resolves an AX root, reports hierarchy depth, and removes textbox values", async () => {
    currentWebContents!.debugger.axNodes = [
      { nodeId: "root", role: { value: "group" }, name: { value: "Root" }, ignored: false },
      { nodeId: "field", parentId: "root", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "raw-password" }, ignored: false },
      { nodeId: "button", parentId: "field", role: { value: "button" }, name: { value: "Save" }, ignored: false },
    ];
    const response = await kernel.execute(
      event(),
      payload(request("accessibility", {
        root: { cssSelector: "#dialog" },
        limit: 10,
      }, { requestId: "ax-root" })),
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        operation: "accessibility",
        nodes: [
          { nodeId: "root", depth: 0 },
          { nodeId: "field", depth: 1, role: "textbox" },
          { nodeId: "button", depth: 2 },
        ],
      },
    });
    if (!response.ok || response.result.operation !== "accessibility") throw new Error("Expected AX result");
    expect(response.result.nodes[1]).not.toHaveProperty("value");
    expect(currentWebContents!.debugger.commands).toContainEqual(expect.objectContaining({
      method: "Accessibility.getPartialAXTree",
      params: { backendNodeId: 2, fetchRelatives: true },
    }));
    expect(currentWebContents!.debugger.commands.some((command) => command.method === "Accessibility.getFullAXTree")).toBe(false);
  });

  it("captures screenshots through CDP and never calls webContents.capturePage", async () => {
    const response = await kernel.execute(
      event(),
      payload(request("screenshot", { maxWidth: 1_280, fullPage: false }, { requestId: "cdp-screenshot" })),
    );

    expect(response).toMatchObject({ ok: true, result: { operation: "screenshot" } });
    expect(currentWebContents!.capturePage).not.toHaveBeenCalled();
    expect(currentWebContents!.debugger.commands).toContainEqual({
      method: "Page.captureScreenshot",
      params: {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
    });
    expect(nativeImageCreateFromBuffer).toHaveBeenCalledWith(Buffer.from(SMALL_PNG_BASE64, "base64"));
    if (!response.ok || response.result.operation !== "screenshot") throw new Error("Expected screenshot result");
    expect(response.result.screenshot.width).toBeGreaterThan(0);
    expect(response.result.screenshot.height).toBeGreaterThan(0);
    expect(response.result.screenshot.dataBase64.length).toBeGreaterThan(0);
  });

  it("shrinks screenshots until the complete response fits its outer byte bound", async () => {
    const makeImage = (width: number): { getSize: () => { width: number; height: number }; resize: (input: { width: number }) => unknown; toPNG: () => Buffer } => ({
      getSize: () => ({ width, height: Math.max(1, Math.floor(width * 0.75)) }),
      resize: ({ width: nextWidth }) => makeImage(nextWidth),
      toPNG: () => Buffer.alloc(width * 600),
    });
    nativeImageCreateFromBuffer.mockImplementation(() => makeImage(1_280) as never);
    const response = await kernel.execute(
      event(),
      payload(request("screenshot", { maxWidth: 1_280, fullPage: false }, { requestId: "bounded-screenshot" })),
    );
    expect(response).toMatchObject({ ok: true, result: { operation: "screenshot" } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(512 * 1_024);
    if (!response.ok || response.result.operation !== "screenshot") throw new Error("Expected screenshot result");
    expect(response.result.screenshot.width).toBeLessThan(1_280);
  });

  it("applies one composite byte budget to rich snapshots with screenshots", async () => {
    currentWebContents!.snapshotValue = {
      url: "https://example.test/",
      title: "T".repeat(4_096),
      loading: false,
      visibleText: "V".repeat(20_000),
      visibleTextOriginalLength: 20_000,
      elements: Array.from({ length: 200 }, (_, index) => ({
        semanticId: `element-${index}`,
        role: "button",
        accessibleName: "N".repeat(1_024),
        disabled: false,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      })),
      elementCount: 200,
    };
    currentWebContents!.debugger.axNodes = Array.from({ length: 1_000 }, (_, index) => ({
      nodeId: `node-${index}`,
      ...(index > 0 ? { parentId: `node-${index - 1}` } : {}),
      role: { value: "group" },
      name: { value: "A".repeat(1_024) },
      ignored: false,
    }));
    const makeImage = (width: number): { getSize: () => { width: number; height: number }; resize: (input: { width: number }) => unknown; toPNG: () => Buffer } => ({
      getSize: () => ({ width, height: Math.max(1, Math.floor(width * 0.75)) }),
      resize: ({ width: nextWidth }) => makeImage(nextWidth),
      toPNG: () => Buffer.alloc(width * 300),
    });
    nativeImageCreateFromBuffer.mockImplementation(() => makeImage(1_280) as never);
    const response = await kernel.execute(
      event(),
      payload(request("snapshot", { includeScreenshot: true }, { requestId: "bounded-rich-snapshot" })),
    );
    expect(response).toMatchObject({ ok: true, result: { operation: "snapshot" } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(512 * 1_024);
    if (!response.ok || response.result.operation !== "snapshot") throw new Error("Expected snapshot result");
    expect(response.result.snapshot.accessibilityTruncation).toMatchObject({ truncated: true });
  });

  it("uses the actual isolated-world JS heap limit in performance output", async () => {
    currentWebContents!.debugger.performanceMetrics = [
      { name: "JSHeapUsedSize", value: 100 },
      { name: "JSHeapTotalSize", value: 200 },
    ];
    currentWebContents!.performanceTiming = {
      navigation: null,
      resources: { count: 0, transferBytes: 0, decodedBodyBytes: 0 },
      longTasks: { count: 0, totalBlockingTimeMs: 0 },
      jsHeapLimitBytes: 1_000,
    };
    await expect(kernel.execute(
      event(),
      payload(request("performance", { includeMemory: true }, { requestId: "performance-memory" })),
    )).resolves.toMatchObject({
      ok: true,
      result: {
        metrics: {
          memory: { usedJsHeapBytes: 100, totalJsHeapBytes: 200, jsHeapLimitBytes: 1_000 },
        },
      },
    });
  });

  it("cleans listeners and timers through 100 target registration cycles", async () => {
    for (let index = 0; index < 100; index += 1) {
      currentWebContents = new FakeWebContents(index + 1);
      const cycleKernel = new BrowserAutomationKernel();
      await cycleKernel.execute(event(), payload(request("press", { key: "A", modifiers: [] })));
      cycleKernel.disposeWindow(fakeWindow.id);
      expect(currentWebContents.listenerCount("before-input-event")).toBe(0);
      expect(currentWebContents.listenerCount("did-start-navigation")).toBe(0);
      expect(currentWebContents.debugger.listenerCount("message")).toBe(0);
      expect(currentWebContents.debugger.isAttached()).toBe(false);
      expect(cycleKernel.getCounters()).toEqual({ targets: 0, targetGenerations: 0, cancellations: 0, active: 0, queued: 0 });
    }
  });

  it("bounds target-generation tombstones across unique tab churn", async () => {
    for (let index = 0; index < 300; index += 1) {
      const tabId = `tab-${index}`;
      seedFakeTab("thread", tabId);
      currentWebContents = new FakeWebContents(index + 10_000);
      await kernel.execute(event(), payload(
        request("status", {}, { requestId: `churn-${index}` }),
        0,
        tabId,
      ));
      currentWebContents.destroyed = true;
      currentWebContents.emit("destroyed");
    }
    expect(kernel.getCounters()).toMatchObject({ targets: 0, targetGenerations: 128 });
  });

  it("isolates, bounds, cancels, and cleans five concurrent agent targets", async () => {
    const requests = Array.from({ length: 5 }, (_, index) => {
      const threadId = `agent-thread-${index}`;
      const tabId = `agent-tab-${index}`;
      seedFakeTab(threadId, tabId);
      const browserRequest = request(
        "waitFor",
        { text: "never", timeoutMs: 5_000 },
        { threadId, requestId: `agent-request-${index}` },
      );
      return { browserRequest, tabId };
    });
    const pending = requests.map(({ browserRequest, tabId }) =>
      kernel.execute(event(), payload(browserRequest, 0, tabId)),
    );
    for (let attempt = 0; attempt < 50 && kernel.getCounters().active < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(kernel.getCounters()).toMatchObject({
      targets: 5,
      targetGenerations: 5,
      cancellations: 5,
      active: 5,
      queued: 0,
    });
    for (const { browserRequest } of requests) {
      expect(kernel.cancel(browserRequest.requestId)).toBe(true);
    }
    await expect(Promise.all(pending)).resolves.toEqual(
      requests.map(({ browserRequest }) => expect.objectContaining({
        requestId: browserRequest.requestId,
        ok: false,
        error: expect.objectContaining({ code: "OPERATION_CANCELLED" }),
      })),
    );
    expect(kernel.getCounters()).toMatchObject({ cancellations: 0, active: 0, queued: 0 });
    kernel.disposeWindow(fakeWindow.id);
    expect(kernel.getCounters()).toEqual({
      targets: 0,
      targetGenerations: 0,
      cancellations: 0,
      active: 0,
      queued: 0,
    });
    expect(currentWebContents!.listenerCount("before-input-event")).toBe(0);
  });
});
