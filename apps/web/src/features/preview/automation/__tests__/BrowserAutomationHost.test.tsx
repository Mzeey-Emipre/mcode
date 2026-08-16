import { act, render, waitFor } from "@testing-library/react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  type BrowserAutomationControllerState,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationResponse,
  type BrowserTabSet,
} from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useThreadStore } from "@/stores/threadStore";
import {
  browserAutomationScopeKey,
  browserAutomationTargetKey,
  interruptBrowserAutomationTarget,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "../browserAutomationStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/stores/previewTabsStore";
import { browserTargetRegistry } from "../services/browserTargetRegistry";

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    transport: {
      registerBrowserAutomationHost: vi.fn(),
      updateBrowserAutomationHostTargets: vi.fn(),
      respondToBrowserAutomationRequest: vi.fn(),
      heartbeatBrowserAutomationHost: vi.fn(),
      cancelBrowserAutomationRequest: vi.fn(),
    },
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
});

const webExecutor = vi.hoisted(() => ({
  executeWebBrowserDispatch: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => harness.transport,
  pushEmitter: {
    on: (channel: string, listener: (payload: unknown) => void) => {
      const listeners = harness.listeners.get(channel) ?? new Set();
      listeners.add(listener);
      harness.listeners.set(channel, listeners);
      return () => listeners.delete(listener);
    },
  },
}));

vi.mock("../../surfaces/PreviewPanel", () => ({
  WEB_RUNTIME_PREVIEW_TAB_ID: "web-preview",
  PreviewPanel: ({ threadId, automationOnly }: { readonly threadId: string; readonly automationOnly?: boolean }) => (
    <div
      data-testid="automation-preview-panel"
      data-thread-id={threadId}
      data-automation-only={String(automationOnly ?? false)}
    />
  ),
}));

vi.mock("../browserAutomationWebExecutor", () => webExecutor);
vi.mock("../webBrowserInteractionExecutor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webBrowserInteractionExecutor")>();
  return {
    ...actual,
    observeWebHumanInput: (
      ownerDocument: Document,
      onHumanInput: () => void,
    ) => actual.observeWebHumanInput(ownerDocument, onHumanInput, () => true),
  };
});

import {
  BrowserAutomationHost,
  isBrowserAutomationWebRuntimeEnabled,
} from "../BrowserAutomationHost";
import { BrowserAutomationRecorder } from "../browserAutomationRecorder";
import {
  BrowserSessionDriver,
  type BrowserSessionLifecycleTab,
} from "../services/browserSessionDriver";
import { ViewportCoordinator } from "../services/viewportCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function dispatch(
  generation: number,
  sequence: number,
  options: { requestId?: string; threadId?: string; tabId?: string; targetGeneration?: number; expectedControlEpoch?: number } = {},
): BrowserAutomationHostDispatch {
  const threadId = options.threadId ?? "thread-1";
  const tabId = options.tabId ?? "tab-1";
  const targetGeneration = options.targetGeneration ??
    useBrowserAutomationStore.getState().liveTargets.get(browserAutomationTargetKey("workspace-1", threadId, tabId))?.revision ?? 1;
  return {
    scope: {
      workspaceId: "workspace-1",
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: "provider-instance",
    },
    connection: {
      desktopInstanceId: `desktop-${generation}`,
      windowId: 7,
      connectionGeneration: generation,
      targetGeneration,
    },
    request: {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: "provider-instance",
      requestId: options.requestId ?? `request-${sequence}`,
      sequence,
      deadline: Date.now() + 60_000,
      expectedControlEpoch: options.expectedControlEpoch ?? 0,
      operation: "status",
      args: {},
    },
    target: {
      desktopInstanceId: `desktop-${generation}`,
      windowId: 7,
      connectionGeneration: generation,
      threadId,
      tabId,
      targetGeneration,
      active: true,
      focused: true,
      lastUsedAt: 10,
    },
  };
}

function response(request: BrowserAutomationHostDispatch["request"]): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error: {
      code: "OPERATION_CANCELLED",
      message: "Cancelled by test",
      retryable: true,
    },
  };
}

function successResponse(request: BrowserAutomationHostDispatch["request"]): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: true,
    result: {
      operation: "status",
      available: true,
      active: true,
      tabId: "tab-1",
      url: "about:blank",
      loading: false,
      focused: true,
      viewport: { width: 800, height: 600 },
      capabilities: [],
    },
  };
}

function markIframeLoaded(iframe: HTMLIFrameElement): void {
  if (iframe.contentDocument) {
    Object.defineProperty(iframe.contentDocument, "readyState", { configurable: true, value: "complete" });
  }
}

function setIframeIdentity(iframe: HTMLIFrameElement, tabId: string): void {
  iframe.dataset.workspaceId = "workspace-1";
  iframe.dataset.scopeKind = "thread";
  iframe.dataset.scopeId = "thread-1";
  iframe.dataset.threadId = "thread-1";
  iframe.dataset.tabId = tabId;
}

describe("BrowserAutomationHost", () => {
  const execute = vi.fn();
  const beginRendererOperation = vi.fn();
  const finishRendererOperation = vi.fn();
  const cancel = vi.fn();
  const interrupt = vi.fn();
  const releaseAgentControl = vi.fn();
  const describeTarget = vi.fn();
  const createTab = vi.fn();
  const closeTab = vi.fn();
  const listTabs = vi.fn();
  let controllerChanged: ((state: BrowserAutomationControllerState) => void) | null;
  let nextGeneration: number;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.listeners.clear();
    sessionStorage.clear();
    controllerChanged = null;
    nextGeneration = 1;
    harness.transport.registerBrowserAutomationHost.mockImplementation(async () => {
      const generation = nextGeneration++;
      return { generation, desktopInstanceId: `desktop-${generation}` };
    });
    harness.transport.updateBrowserAutomationHostTargets.mockResolvedValue(undefined);
    harness.transport.respondToBrowserAutomationRequest.mockResolvedValue(undefined);
    harness.transport.heartbeatBrowserAutomationHost.mockResolvedValue(undefined);
    harness.transport.cancelBrowserAutomationRequest.mockResolvedValue(undefined);
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "tab-1", targetGeneration: 3, active: true, focused: true, lastUsedAt: 10 },
    });
    cancel.mockResolvedValue(true);
    interrupt.mockResolvedValue(true);
    releaseAgentControl.mockImplementation(async (target: { tabId: string; controlEpoch: number }) => {
      controllerChanged?.({
        tabId: target.tabId,
        controller: "none",
        controlEpoch: target.controlEpoch,
      });
      return true;
    });
    beginRendererOperation.mockResolvedValue({ ok: true, leaseId: "renderer-lease" });
    finishRendererOperation.mockResolvedValue(true);
    closeTab.mockResolvedValue({ ok: true, data: { threadId: "thread-1", activeTabId: "tab-1", tabs: [] } });
    listTabs.mockResolvedValue({ ok: true, data: { threadId: "thread-1", activeTabId: "", tabs: [] } });
    window.desktopBridge = {
      preview: {
        automation: {
          execute,
          beginRendererOperation,
          finishRendererOperation,
          cancel,
          interrupt,
          releaseAgentControl,
          describeTarget,
          getMediaSourceId: vi.fn(),
          onControllerChanged(callback: (state: BrowserAutomationControllerState) => void) {
            controllerChanged = callback;
            return () => {
              if (controllerChanged === callback) controllerChanged = null;
            };
          },
        },
        tabs: {
          list: listTabs,
          open: createTab,
          close: closeTab,
        },
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace-1",
      activeThreadId: "thread-1",
      workspaces: [{ id: "workspace-1" }] as never,
    });
    useConnectionStore.setState({ status: "connected" });
    useThreadStore.setState({ runningThreadIds: new Set() });
    useBrowserAutomationStore.setState({
      liveTargets: new Map(),
      controllers: new Map(),
      activeRequests: new Map(),
      pendingAgentOpens: new Map(),
      lifecycleTabs: new Map(),
      registered: false,
      viewportByTarget: new Map(),
      viewportStateByTarget: new Map(),
      viewportCoordinators: new Map(),
      hostedScopeIds: new Set(),
    });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    browserTargetRegistry.clear();
    useBrowserAutomationStore.getState().registerTarget(
      "workspace-1",
      "thread-1",
      "tab-1",
    );
  });

  it("keeps web automation disabled by default and recognizes explicit opt-in", () => {
    expect(isBrowserAutomationWebRuntimeEnabled({})).toBe(false);
    expect(isBrowserAutomationWebRuntimeEnabled({ VITE_MCODE_WEB_AUTOMATION: "0" })).toBe(false);
    expect(isBrowserAutomationWebRuntimeEnabled({ VITE_MCODE_WEB_AUTOMATION: "1" })).toBe(true);
  });

  it("clears stale lifecycle rows across host replacement and republishes after reconnect", async () => {
    const lifecycleTab: BrowserSessionLifecycleTab = {
      tabId: "stale-tab",
      provenance: "agent-created",
      ownership: "owned",
      target: {
        desktopInstanceId: "desktop-1",
        windowId: 7,
        connectionGeneration: 1,
        threadId: "thread-1",
        tabId: "stale-tab",
        targetGeneration: 3,
        active: true,
        focused: true,
        lastUsedAt: 10,
      },
      workspaceId: "workspace-1",
      threadId: "thread-1",
      providerSessionId: "provider-session",
      providerInstanceId: "provider-instance",
    };
    useBrowserAutomationStore.getState().setLifecycleTabs([lifecycleTab]);
    const publish = vi.spyOn(BrowserSessionDriver.prototype, "publishLifecycleProjection");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledOnce();

    act(() => useConnectionStore.setState({ status: "reconnecting" }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().lifecycleTabs).toHaveLength(0));

    act(() => useConnectionStore.setState({ status: "connected" }));
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(useBrowserAutomationStore.getState().lifecycleTabs).toHaveLength(0);

    act(() => useBrowserAutomationStore.getState().setLifecycleTabs([lifecycleTab]));
    view.unmount();
    expect(useBrowserAutomationStore.getState().lifecycleTabs).toHaveLength(0);
    publish.mockRestore();
  });

  it("enters BrowserSessionDriver for broker-dispatched web and Electron commands", async () => {
    execute.mockResolvedValue(successResponse(dispatch(1, 91).request));
    const driverExecute = vi.spyOn(BrowserSessionDriver.prototype, "execute");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 91) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(driverExecute).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ operation: "status" }) }), expect.any(AbortSignal));
    view.unmount();
    driverExecute.mockRestore();
    execute.mockReset();
  });

  it("returns a failure when a completed act cannot restore the user viewport", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      reset: async () => ({
        status: "failed",
        applied: { width: 1_200, height: 800 },
        error: "native reset failed",
      }),
      initial: { width: 800, height: 600 },
      targetGeneration: 1,
    });
    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    useBrowserAutomationStore.getState().setViewportCoordinator("workspace-1", "thread-1", "tab-1", coordinator);
    useBrowserAutomationStore.getState().setViewportState(
      "workspace-1",
      "thread-1",
      "tab-1",
      coordinator.snapshot(),
      coordinator,
    );

    const actDispatch = {
      ...dispatch(1, 92),
      request: {
        ...dispatch(1, 92).request,
        operation: "act",
        args: {
          idempotencyKey: "restore-failure",
          observationRef: "observation-1",
          deadlineMs: 1_000,
          steps: [{ operation: "click", target: { cssSelector: "#button" } }],
        },
      },
    } as BrowserAutomationHostDispatch;
    const completedResponse = {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: actDispatch.request.requestId,
      sequence: actDispatch.request.sequence,
      ok: true,
      result: { operation: "act", outcome: "completed" },
    } as unknown as BrowserAutomationResponse;
    const driverExecute = vi.spyOn(BrowserSessionDriver.prototype, "execute")
      .mockResolvedValue(completedResponse);

    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: actDispatch }));

    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest.mock.calls[0]?.[2]).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "native reset failed" },
    });
    expect(coordinator.snapshot()).toMatchObject({ mode: "responsive", agentActive: false });

    view.unmount();
    driverExecute.mockRestore();
  });

  it("keeps Electron agent control visible between Browser calls while the turn is running", async () => {
    useThreadStore.setState({ runningThreadIds: new Set(["thread-1"]) });
    const request = dispatch(1, 96);
    request.request = {
      ...request.request,
      operation: "navigate",
      args: { url: "https://example.test/next" },
    } as never;
    execute.mockImplementation(async () => {
      controllerChanged?.({
        tabId: "tab-1",
        controller: "agent",
        controlEpoch: 0,
        providerSessionId: "provider-session",
        operation: "navigate",
      });
      return {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: request.request.requestId,
        sequence: request.request.sequence,
        ok: true,
        result: {
          operation: "navigate",
          url: "https://example.test/next",
          title: "Example",
          controlEpoch: 0,
        },
      } as BrowserAutomationResponse;
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    await waitFor(() => expect(controllerChanged).not.toBeNull());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");

    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: request }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());

    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-1", "thread-1", "tab-1"),
    )).toMatchObject({ controller: "agent", controlEpoch: 0 });

    act(() => useThreadStore.setState({ runningThreadIds: new Set() }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-1", "thread-1", "tab-1"),
    )).toMatchObject({ controller: "none", controlEpoch: 0 }));
    expect(releaseAgentControl).toHaveBeenCalledWith({
      threadId: "thread-1",
      tabId: "tab-1",
      controlEpoch: 0,
      providerSessionId: "provider-session",
    });
    view.unmount();
  });

  it("settles driver-owned tabs when the broker releases a provider session", async () => {
    const release = vi.spyOn(BrowserSessionDriver.prototype, "releaseProviderSession").mockResolvedValue();
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.sessionRelease", {
      hostId,
      generation: 1,
      providerSessionId: "provider-session-1",
      reason: "credential-revoked",
    }));
    await waitFor(() => expect(release).toHaveBeenCalledWith("provider-session-1"));
    view.unmount();
    release.mockRestore();
  });

  it("enters BrowserSessionDriver before web adapter dispatch", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const driverExecute = vi.spyOn(BrowserSessionDriver.prototype, "execute");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 92).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 92) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(driverExecute).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ operation: "status" }) }), expect.any(AbortSignal));
    view.unmount();
    driverExecute.mockRestore();
    webExecutor.executeWebBrowserDispatch.mockReset();
  });

  it("publishes web targets as active only in the active workspace and thread", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useBrowserAutomationStore.getState().registerTarget(
      "workspace-2",
      "thread-1",
      "tab-2",
    );

    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.updateBrowserAutomationHostTargets).toHaveBeenCalled());
    const targets = harness.transport.updateBrowserAutomationHostTargets.mock.calls.at(-1)?.[2];

    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: "tab-1", active: true, focused: true }),
      expect.objectContaining({ tabId: "tab-2", active: false, focused: false }),
    ]));
    view.unmount();
  });

  it("keeps evaluate out of the pure web descriptor, registration, and status capabilities", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const statusDispatch = dispatch(1, 93);
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(statusDispatch.request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const registration = harness.transport.registerBrowserAutomationHost.mock.calls[0]?.[0];
    expect(registration.executorDescriptor.operations).not.toContain("evaluate");
    expect(registration.capabilities.map((capability: { operation: string }) => capability.operation)).not.toContain("evaluate");
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: statusDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    const status = harness.transport.respondToBrowserAutomationRequest.mock.calls[0]?.[2];
    expect(status).toMatchObject({ ok: true, result: { operation: "status" } });
    if (status.ok && status.result.operation === "status") expect(status.result.capabilities).not.toContain("evaluate");
    view.unmount();
  });

  it("advertises evaluate in Electron descriptor, registration, and status capabilities", async () => {
    execute.mockResolvedValue(successResponse(dispatch(1, 94).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const registration = harness.transport.registerBrowserAutomationHost.mock.calls[0]?.[0];
    expect(registration.executorDescriptor.operations).toContain("evaluate");
    expect(registration.capabilities).toContainEqual({ operation: "evaluate", available: true });
    const request = dispatch(1, 94);
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: request }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    const status = harness.transport.respondToBrowserAutomationRequest.mock.calls[0]?.[2];
    expect(status).toMatchObject({ ok: true, result: { operation: "status", capabilities: expect.arrayContaining(["evaluate"]) } });
    view.unmount();
  });

  it("carries an initial web open URL into the visible preview state", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    expect(window.desktopBridge).toBeUndefined();
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 31).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openRequest = {
      ...dispatch(1, 31).request,
      operation: "open" as const,
      args: { url: `${window.location.origin}/fixture`, activate: true },
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(openRequest.args.url));
    expect(webExecutor.executeWebBrowserDispatch).not.toHaveBeenCalled();
    const iframe = document.createElement("iframe");
    iframe.src = openRequest.args.url;
    setIframeIdentity(iframe, "web-preview");
    document.body.append(iframe);
    markIframeLoaded(iframe);
    window.setTimeout(() => iframe.dispatchEvent(new Event("load")), 0);
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(`${window.location.origin}/fixture`);
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ operation: "open", args: { activate: true } }),
    }), expect.any(AbortSignal));
    iframe.remove();
    view.unmount();
  });

  it("waits for the seeded web preview iframe before the first open dispatch", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 36).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openRequest = {
      ...dispatch(1, 36).request,
      operation: "open" as const,
      args: { url: `${window.location.origin}/first-open`, activate: true },
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(openRequest.args.url));
    expect(webExecutor.executeWebBrowserDispatch).not.toHaveBeenCalled();
    const iframe = document.createElement("iframe");
    iframe.src = openRequest.args.url;
    setIframeIdentity(iframe, "web-preview");
    document.body.append(iframe);
    markIframeLoaded(iframe);
    window.setTimeout(() => iframe.dispatchEvent(new Event("load")), 0);
    await waitFor(() => expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ args: { activate: true } }) }),
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    iframe.remove();
    view.unmount();
  });

  it("bootstraps the hidden dedicated web surface with its created tab id", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    webExecutor.executeWebBrowserDispatch.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: value.request.contractVersion,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true as const,
      result: {
        operation: "open" as const,
        url: value.request.args.url ?? `${window.location.origin}/browser-automation-fixture.html`,
        title: "Fixture",
        controlEpoch: 0,
      },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openRequest = {
      ...dispatch(1, 37).request,
      operation: "open" as const,
      args: {
        url: `${window.location.origin}/browser-automation-fixture.html`,
        idempotencyKey: "hidden-web-open",
        activate: false,
      },
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().hostedScopeIds.has(
      browserAutomationScopeKey("workspace-1", "thread-1"),
    )).toBe(true));
    const surface = document.querySelector<HTMLElement>('[data-automation-persistent-scope="thread-1"]');
    expect(surface).not.toBeNull();
    let tabId!: string;
    await waitFor(() => {
      const value = usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey("workspace-1", "thread-1")
      ]?.tabs.find((tab) => tab.id.startsWith("web-agent-"));
      expect(value).toBeDefined();
      tabId = value!.id;
    });
    expect(surface!.querySelector("iframe")).toBeNull();
    const iframe = document.createElement("iframe");
    iframe.src = openRequest.args.url;
    setIframeIdentity(iframe, tabId);
    document.body.append(iframe);
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", tabId);
    iframe.addEventListener("load", () => {
      useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", tabId);
    }, { once: true });
    markIframeLoaded(iframe);
    expect(iframe.src).toBe(openRequest.args.url);
    window.setTimeout(() => iframe.dispatchEvent(new Event("load")), 0);
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ tabId }),
    ));
    const firstResponse = harness.transport.respondToBrowserAutomationRequest.mock.calls[0]?.[2];
    expect(firstResponse.result.observationRef).toEqual(expect.any(String));
    if (iframe.contentDocument) {
      Object.defineProperty(iframe.contentDocument, "readyState", { configurable: true, value: "complete" });
    }

    const replayRequest = {
      ...openRequest,
      requestId: "request-38",
      sequence: 38,
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: replayRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(2));
    const replayResponse = harness.transport.respondToBrowserAutomationRequest.mock.calls[1]?.[2];
    expect(replayResponse).toMatchObject({ ok: true, requestId: replayRequest.requestId, sequence: replayRequest.sequence });
    expect(usePreviewTabsStore.getState().tabSetByScope[
      previewTabsScopeKey("workspace-1", "thread-1")
    ]?.tabs.filter((tab) => tab.id.startsWith("web-agent-"))).toHaveLength(1);
    expect(harness.transport.respondToBrowserAutomationRequest.mock.calls[1]?.[3]).toMatchObject({
      tabId,
    });

    const secondRequest = {
      ...openRequest,
      requestId: "request-39",
      sequence: 39,
      args: {
        ...openRequest.args,
        idempotencyKey: "hidden-web-open-2",
        url: `${window.location.origin}/browser-automation-fixture-second.html`,
      },
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: secondRequest }));
    let secondTabId!: string;
    await waitFor(() => {
      const value = usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey("workspace-1", "thread-1")
      ]?.tabs.find((tab) => tab.id.startsWith("web-agent-") && tab.id !== tabId);
      expect(value).toBeDefined();
      secondTabId = value!.id;
    });
    const secondIframe = document.createElement("iframe");
    secondIframe.src = secondRequest.args.url;
    setIframeIdentity(secondIframe, secondTabId);
    document.body.append(secondIframe);
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", secondTabId);
    secondIframe.addEventListener("load", () => {
      useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", secondTabId);
    }, { once: true });
    expect(secondTabId).not.toBe(tabId);
    expect(secondIframe.src).toBe(secondRequest.args.url);
    markIframeLoaded(secondIframe);
    window.setTimeout(() => secondIframe.dispatchEvent(new Event("load")), 0);
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(3));
    const secondResponse = harness.transport.respondToBrowserAutomationRequest.mock.calls[2]?.[2];
    expect(secondResponse.result.observationRef).not.toBe(firstResponse.result.observationRef);
    expect(harness.transport.respondToBrowserAutomationRequest.mock.calls[2]?.[3]).toMatchObject({
      tabId: secondTabId,
      active: false,
      focused: false,
    });

    expect(surface).toHaveAttribute("aria-hidden", "true");
    iframe.remove();
    secondIframe.remove();
    view.unmount();
  });

  it("projects an agent-owned web tab and reveals it through the Browser dock", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    webExecutor.executeWebBrowserDispatch.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: value.request.contractVersion,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true as const,
      result: {
        operation: "open" as const,
        url: value.request.args.url ?? `${window.location.origin}/browser-automation-fixture.html`,
        title: "Fixture",
        controlEpoch: 0,
      },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openRequest = {
      ...dispatch(1, 47).request,
      operation: "open" as const,
      args: {
        url: `${window.location.origin}/browser-automation-fixture.html`,
        idempotencyKey: "dock-web-open",
        activate: false,
      },
    };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    let tabId!: string;
    await waitFor(() => {
      const value = usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey("workspace-1", "thread-1")
      ]?.tabs.find((tab) => tab.id.startsWith("web-agent-"));
      expect(value).toBeDefined();
      tabId = value!.id;
    });
    const iframe = document.createElement("iframe");
    iframe.src = openRequest.args.url;
    setIframeIdentity(iframe, tabId);
    document.body.append(iframe);
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", tabId);
    iframe.addEventListener("load", () => {
      useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", tabId);
    }, { once: true });
    await waitFor(() => expect(
      usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("workspace-1", "thread-1")]?.tabs.some((tab) => tab.id === tabId),
    ).toBe(true));
    markIframeLoaded(iframe);
    window.setTimeout(() => iframe.dispatchEvent(new Event("load")), 0);
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());

    const dock = document.createElement("div");
    dock.dataset.automationPreviewDock = "thread-1";
    dock.dataset.automationPreviewWorkspace = "workspace-1";
    dock.dataset.visible = "true";
    Object.defineProperty(dock, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 40, top: 20, width: 640, height: 480, right: 680, bottom: 500, x: 40, y: 20, toJSON: () => ({}) }),
    });
    document.body.append(dock);
    await act(async () => usePreviewTabsStore.getState().activatePage("workspace-1", "thread-1", tabId));
    await waitFor(() => expect(usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("workspace-1", "thread-1")]?.activeTabId).toBe(tabId));
    expect(document.querySelector('[data-automation-persistent-scope="thread-1"]')).toHaveAttribute("aria-hidden", "false");

    iframe.remove();
    dock.remove();
    view.unmount();
  });

  it("routes normal web status and open requests through the web executor", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 32).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const statusDispatch = dispatch(1, 32);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: statusDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    const openDispatch = dispatch(1, 33, { targetGeneration: 1 });
    openDispatch.request = {
      ...openDispatch.request,
      operation: "open",
      args: { url: `${window.location.origin}/normal-open`, activate: true },
    } as never;
    const normalOpenUrl = `${window.location.origin}/normal-open`;
    const existingIframe = document.createElement("iframe");
    existingIframe.src = normalOpenUrl;
    setIframeIdentity(existingIframe, "tab-1");
    document.body.append(existingIframe);
    window.setTimeout(() => existingIframe.dispatchEvent(new Event("load")), 0);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: openDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(2));
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(statusDispatch, expect.any(AbortSignal));
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ args: { activate: true } }) }),
      expect.any(AbortSignal),
    );
    expect(harness.transport.respondToBrowserAutomationRequest.mock.calls.every(([, , response]) => response.ok)).toBe(true);
    existingIframe.remove();
    view.unmount();
  });

  it("seeds an empty registered web target for normal open requests", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 37).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openDispatch = dispatch(1, 37, { tabId: "web-preview", targetGeneration: 1 });
    openDispatch.request = {
      ...openDispatch.request,
      operation: "open",
      args: { url: `${window.location.origin}/normal-first-open`, activate: true },
    } as never;
    const firstOpenUrl = `${window.location.origin}/normal-first-open`;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: openDispatch }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(firstOpenUrl));
    expect(webExecutor.executeWebBrowserDispatch).not.toHaveBeenCalled();
    const iframe = document.createElement("iframe");
    iframe.src = firstOpenUrl;
    setIframeIdentity(iframe, "web-preview");
    document.body.append(iframe);
    window.setTimeout(() => {
      iframe.dispatchEvent(new Event("load"));
      useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "web-preview");
    }, 0);
    await waitFor(() => expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ args: { activate: true } }) }),
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    iframe.remove();
    view.unmount();
  });

  it("accepts the expected target revision advanced by a same-origin open load", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 38).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openDispatch = dispatch(1, 38, { tabId: "tab-1", targetGeneration: 1 });
    openDispatch.request = {
      ...openDispatch.request,
      operation: "open",
      args: { url: `${window.location.origin}/revision-open`, activate: true },
    } as never;
    const expectedUrl = `${window.location.origin}/revision-open`;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: openDispatch }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(expectedUrl));
    expect(webExecutor.executeWebBrowserDispatch).not.toHaveBeenCalled();

    const iframe = document.createElement("iframe");
    iframe.src = expectedUrl;
    setIframeIdentity(iframe, "tab-1");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { location: { origin: window.location.origin } },
    });
    document.body.append(iframe);
    window.setTimeout(() => {
      useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1");
      iframe.dispatchEvent(new Event("load"));
    }, 0);

    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true }),
    );
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ args: { activate: true } }) }),
      expect.any(AbortSignal),
    );
    iframe.remove();
    view.unmount();
  });

  it("rejects an open revision advance observed before iframe load", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const expectedUrl = `${window.location.origin}/revision-open-before-load`;
    const openDispatch = dispatch(1, 44, { targetGeneration: 1 });
    openDispatch.request = { ...openDispatch.request, operation: "open", args: { url: expectedUrl, activate: true } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: openDispatch }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(expectedUrl));
    const iframe = document.createElement("iframe");
    iframe.src = expectedUrl;
    setIframeIdentity(iframe, "tab-1");
    document.body.append(iframe);
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_TARGET_GENERATION" }) }),
    );
    iframe.remove();
    view.unmount();
  });

  it("accepts the expected target revision advanced by a same-origin navigate load", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const executing = deferred<BrowserAutomationResponse>();
    webExecutor.executeWebBrowserDispatch.mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const expectedUrl = `${window.location.origin}/revision-navigate`;
    const navigateDispatch = dispatch(1, 43, { targetGeneration: 1 });
    navigateDispatch.request = {
      ...navigateDispatch.request,
      operation: "navigate",
      args: { url: expectedUrl },
    } as never;
    const iframe = document.createElement("iframe");
    iframe.src = expectedUrl;
    setIframeIdentity(iframe, "tab-1");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { location: { origin: window.location.origin } },
    });
    document.body.append(iframe);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: navigateDispatch }));
    await waitFor(() => expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(navigateDispatch, expect.any(AbortSignal)));
    act(() => iframe.dispatchEvent(new Event("load")));
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));
    executing.resolve(successResponse(navigateDispatch.request));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true }),
      navigateDispatch.target,
    );
    iframe.remove();
    view.unmount();
  });

  it("rejects a navigate revision advance observed before iframe load", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const executing = deferred<BrowserAutomationResponse>();
    webExecutor.executeWebBrowserDispatch.mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const expectedUrl = `${window.location.origin}/revision-navigate-before-load`;
    const navigateDispatch = dispatch(1, 45, { targetGeneration: 1 });
    navigateDispatch.request = { ...navigateDispatch.request, operation: "navigate", args: { url: expectedUrl } } as never;
    const iframe = document.createElement("iframe");
    iframe.src = `${window.location.origin}/before`;
    setIframeIdentity(iframe, "tab-1");
    document.body.append(iframe);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: navigateDispatch }));
    await waitFor(() => expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(navigateDispatch, expect.any(AbortSignal)));
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));
    executing.resolve(successResponse(navigateDispatch.request));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_TARGET_GENERATION" }) }),
      navigateDispatch.target,
    );
    iframe.remove();
    view.unmount();
  });

  it("rejects an unrelated iframe replacement during a same-origin open", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue(successResponse(dispatch(1, 39).request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openDispatch = dispatch(1, 39, { tabId: "tab-1", targetGeneration: 1 });
    openDispatch.request = {
      ...openDispatch.request,
      operation: "open",
      args: { url: `${window.location.origin}/replacement-open`, activate: true },
    } as never;
    const expectedUrl = `${window.location.origin}/replacement-open`;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: openDispatch }));
    await waitFor(() => expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(expectedUrl));

    const replacement = document.createElement("iframe");
    replacement.src = `${window.location.origin}/unrelated-replacement`;
    setIframeIdentity(replacement, "tab-1");
    document.body.append(replacement);
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));

    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_TARGET_GENERATION" }) }),
    );
    expect(webExecutor.executeWebBrowserDispatch).not.toHaveBeenCalled();
    replacement.remove();
    view.unmount();
  });

  afterEach(() => {
    delete window.desktopBridge;
    vi.unstubAllEnvs();
  });

  it("stays inactive when a partial desktop bridge omits preview automation", async () => {
    window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;

    const view = render(<BrowserAutomationHost />);

    await act(async () => Promise.resolve());
    expect(harness.transport.registerBrowserAutomationHost).not.toHaveBeenCalled();
    expect(useBrowserAutomationStore.getState().status).toBe("disabled");
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
  });

  it("re-registers after reconnect and suppresses a response from the stale generation", async () => {
    const first = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(first.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledTimes(1));
    const registration = harness.transport.registerBrowserAutomationHost.mock.calls[0]?.[0];
    expect(registration.capabilities).toContainEqual({ operation: "open", available: true });
    expect(registration.capabilities).toContainEqual({ operation: "resize", available: true });
    expect(registration.capabilities).toContainEqual({ operation: "navigate", available: true });
    expect(registration.capabilities).toContainEqual({ operation: "screenshot", available: true });

    const firstDispatch = dispatch(1, 1);
    act(() => harness.emit("browserAutomation.request", {
      hostId: sessionStorage.getItem("mcode.browserAutomation.hostId"),
      generation: 1,
      dispatch: firstDispatch,
    }));
    expect(execute).toHaveBeenCalledWith(firstDispatch);

    act(() => useConnectionStore.setState({ status: "reconnecting" }));
    act(() => useConnectionStore.setState({ status: "connected" }));
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledTimes(2));
    first.resolve(response(firstDispatch.request));
    await act(async () => first.promise);
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    view.unmount();
  });

  it("shares one executor descriptor between registration and the live driver revision getter", async () => {
    execute.mockResolvedValue(successResponse(dispatch(1, 98).request));
    const driverExecute = vi.spyOn(BrowserSessionDriver.prototype, "execute");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const registration = harness.transport.registerBrowserAutomationHost.mock.calls[0]?.[0];
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 98) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    const instance = driverExecute.mock.instances[0] as unknown as {
      options: { getCapabilityRevision?: () => number };
    };
    expect(instance.options.getCapabilityRevision?.()).toBe(registration.executorDescriptor.capabilityRevision);
    registration.executorDescriptor.capabilityRevision = 7;
    expect(instance.options.getCapabilityRevision?.()).toBe(7);
    view.unmount();
    driverExecute.mockRestore();
  });

  it("routes web screenshots to the registered target", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const screenshotRequest = dispatch(1, 41);
    const requestId = screenshotRequest.request.requestId;
    const sequence = screenshotRequest.request.sequence;
    screenshotRequest.request = {
      ...screenshotRequest.request,
      operation: "screenshot",
      args: { maxWidth: 320, fullPage: false },
    } as never;
    webExecutor.executeWebBrowserDispatch.mockResolvedValue({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId,
      sequence,
      ok: true,
      result: {
        operation: "screenshot",
        screenshot: {
          mediaType: "image/png",
          dataBase64: "AAAA",
          width: 320,
          height: 180,
          truncation: { truncated: false },
        },
        controlEpoch: 0,
      },
    } as never);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const registration = harness.transport.registerBrowserAutomationHost.mock.calls[0]?.[0];
    expect(registration.capabilities).toContainEqual({ operation: "screenshot", available: true });
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: screenshotRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(screenshotRequest, expect.any(AbortSignal));
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "screenshot" }) }),
      screenshotRequest.target,
    );
    view.unmount();
  });

  it("cancels in-flight dispatch and bootstrap work when registration is replaced", async () => {
    const executing = deferred<BrowserAutomationResponse>();
    const creating = deferred<{
      ok: true;
      data: {
        tabId: string;
        tabs: { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; url: string | null; title: string | null; faviconUrl: string | null; warm: boolean }> };
      };
    }>();
    execute.mockReturnValueOnce(executing.promise);
    createTab.mockReturnValueOnce(creating.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const activeDispatch = dispatch(1, 21);
    act(() => harness.emit("browserAutomation.request", {
      hostId,
      generation: 1,
      dispatch: activeDispatch,
    }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(activeDispatch));

    const openRequest = {
      ...dispatch(1, 22).request,
      operation: "open" as const,
      args: { url: "https://example.com/", activate: false },
    };
    act(() => harness.emit("browserAutomation.bootstrap", {
      hostId,
      generation: 1,
      request: openRequest,
    }));
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce());

    act(() => useConnectionStore.setState({ status: "reconnecting" }));
    await waitFor(() => expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      activeDispatch.request.requestId,
      activeDispatch.request.sequence,
      "host-shutdown",
    ));
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      openRequest.requestId,
      openRequest.sequence,
      "host-shutdown",
    );
    expect(cancel).toHaveBeenCalledWith(activeDispatch.request.requestId);
    expect(useBrowserAutomationStore.getState().activeRequests).toHaveLength(0);

    creating.resolve({
      ok: true,
      data: {
        tabId: "bootstrap-tab",
        tabs: {
          threadId: "thread-1",
          activeTabId: "bootstrap-tab",
          tabs: [{ id: "bootstrap-tab", threadId: "thread-1", url: null, title: null, faviconUrl: null, warm: true }],
        },
      },
    });
    executing.resolve(successResponse(activeDispatch.request));
    await act(async () => Promise.all([creating.promise, executing.promise]));
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    view.unmount();
  });

  it("publishes targets after registration and refreshes desktop identity on replacement", async () => {
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.updateBrowserAutomationHostTargets).toHaveBeenCalledTimes(1));
    expect(harness.transport.updateBrowserAutomationHostTargets.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ targetGeneration: 3, connectionGeneration: 1 }),
    ]);

    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 8, threadId: "thread-1", tabId: "tab-1", targetGeneration: 4, active: true, focused: true, lastUsedAt: 20 },
    });
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));
    await waitFor(() => expect(harness.transport.updateBrowserAutomationHostTargets).toHaveBeenCalledTimes(2));
    expect(harness.transport.updateBrowserAutomationHostTargets.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({ windowId: 8, targetGeneration: 4, connectionGeneration: 1 }),
    ]);
    view.unmount();
  });

  it("retries target publication while an adopted desktop guest is still becoming discoverable", async () => {
    describeTarget.mockResolvedValueOnce({ ok: false, error: "TAB_UNAVAILABLE" });
    const view = render(<BrowserAutomationHost />);

    await waitFor(() => expect(harness.transport.updateBrowserAutomationHostTargets).toHaveBeenCalledTimes(2));
    expect(harness.transport.updateBrowserAutomationHostTargets.mock.calls[0]?.[2]).toEqual([]);
    expect(harness.transport.updateBrowserAutomationHostTargets.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({ threadId: "thread-1", tabId: "tab-1", targetGeneration: 3 }),
    ]);

    view.unmount();
  });

  it("keeps duplicate bookkeeping stable and correlates cancel by request id plus sequence", async () => {
    const first = deferred<BrowserAutomationResponse>();
    const second = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const firstDispatch = dispatch(1, 1, { requestId: "reused" });
    const secondDispatch = dispatch(1, 2, { requestId: "reused" });
    act(() => {
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: firstDispatch });
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: secondDispatch });
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: firstDispatch });
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(useBrowserAutomationStore.getState().activeRequests.size).toBe(2);
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();

    act(() => harness.emit("browserAutomation.cancel", {
      hostId, generation: 1, requestId: "reused", sequence: 3,
    }));
    expect(cancel).not.toHaveBeenCalled();
    act(() => harness.emit("browserAutomation.cancel", {
      hostId, generation: 1, requestId: "reused", sequence: 2,
    }));
    expect(cancel).toHaveBeenCalledOnce();

    first.resolve(response(firstDispatch.request));
    await act(async () => first.promise);
    expect(useBrowserAutomationStore.getState().activeRequests.size).toBe(1);
    second.resolve(response(secondDispatch.request));
    await act(async () => second.promise);
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("cancels an exact removed target and suppresses its late success response", async () => {
    const clearTargetReplay = vi.spyOn(BrowserSessionDriver.prototype, "clearIdempotencyForTarget");
    const executing = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const activeDispatch = dispatch(1, 23);
    act(() => harness.emit("browserAutomation.request", {
      hostId,
      generation: 1,
      dispatch: activeDispatch,
    }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().activeRequests).toHaveLength(1));

    act(() => useBrowserAutomationStore.getState().unregisterTarget("workspace-1", "thread-1", "tab-1"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(activeDispatch.request.requestId));
    expect(clearTargetReplay).toHaveBeenCalledWith("workspace-1", "thread-1", "tab-1");
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      activeDispatch.request.requestId,
      activeDispatch.request.sequence,
      "host-shutdown",
    );
    expect(useBrowserAutomationStore.getState().activeRequests).toHaveLength(0);

    executing.resolve(successResponse(activeDispatch.request));
    await act(async () => executing.promise);
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    clearTargetReplay.mockRestore();
    view.unmount();
  });

  it("delivers the receipt when a tab lifecycle request removes its target", async () => {
    const executing = deferred<BrowserAutomationResponse>();
    const executeTabs = vi.spyOn(BrowserSessionDriver.prototype, "execute").mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const activeDispatch = dispatch(1, 24);
    activeDispatch.request = {
      ...activeDispatch.request,
      operation: "tabs",
      args: {
        action: "finalize",
        observationRef: "observation-1",
        idempotencyKey: "finalize-1",
        dispositions: [{ tabId: "tab-1", disposition: "close" }],
      },
    };
    act(() => harness.emit("browserAutomation.request", {
      hostId,
      generation: 1,
      dispatch: activeDispatch,
    }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().activeRequests).toHaveLength(1));

    act(() => useBrowserAutomationStore.getState().unregisterTarget("workspace-1", "thread-1", "tab-1"));
    expect(cancel).not.toHaveBeenCalled();
    expect(harness.transport.cancelBrowserAutomationRequest).not.toHaveBeenCalled();

    const completedResponse = {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: activeDispatch.request.requestId,
      sequence: activeDispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "finalize", tabs: [] },
    } satisfies BrowserAutomationResponse;
    executing.resolve(completedResponse);
    await act(async () => executing.promise);
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      completedResponse,
      activeDispatch.target,
    ));
    executeTabs.mockRestore();
    view.unmount();
  });

  it("interrupts only the exact thread and tab selected by the human", async () => {
    const first = deferred<BrowserAutomationResponse>();
    const second = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-2", "tab-1");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const firstDispatch = dispatch(1, 1, { threadId: "thread-1", tabId: "tab-1" });
    const secondDispatch = dispatch(1, 2, { threadId: "thread-2", tabId: "tab-1" });
    await act(async () => {
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: firstDispatch });
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: secondDispatch });
      interruptBrowserAutomationTarget("workspace-1", "thread-2", "tab-1", "human-interrupted");
      await Promise.resolve();
    });
    expect(interrupt).toHaveBeenCalledWith({ threadId: "thread-2", tabId: "tab-1" });
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledOnce();
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId, 1, secondDispatch.request.requestId, 2, "human-interrupted",
    );
    first.resolve(response(firstDispatch.request));
    second.resolve(response(secondDispatch.request));
    await act(async () => Promise.all([first.promise, second.promise]));
    view.unmount();
  });

  it("cancels every live correlation when the component shuts down", async () => {
    const first = deferred<BrowserAutomationResponse>();
    const second = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => {
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 1) });
      harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 2) });
    });
    view.unmount();
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledTimes(2);
    expect(harness.transport.cancelBrowserAutomationRequest.mock.calls.every(
      (call) => call[4] === "host-shutdown",
    )).toBe(true);
    first.resolve(response(dispatch(1, 1).request));
    second.resolve(response(dispatch(1, 2).request));
  });

  it("aborts bootstrap work and clears hosted scope state on unmount", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    const creating = deferred<{
      ok: true;
      data: {
        tabId: string;
        tabs: { threadId: string; activeTabId: string; tabs: Array<{ id: string; threadId: string; url: string | null; title: string | null; faviconUrl: string | null; warm: boolean }> };
      };
    }>();
    const executing = deferred<BrowserAutomationResponse>();
    createTab.mockReturnValueOnce(creating.promise);
    execute.mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const activeDispatch = dispatch(1, 24);
    act(() => harness.emit("browserAutomation.request", {
      hostId,
      generation: 1,
      dispatch: activeDispatch,
    }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const openRequest = {
      ...dispatch(1, 25).request,
      operation: "open" as const,
      args: { url: "https://example.com/", activate: false },
    };
    act(() => harness.emit("browserAutomation.bootstrap", {
      hostId,
      generation: 1,
      request: openRequest,
    }));
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    await waitFor(() => expect(useBrowserAutomationStore.getState().hostedScopeIds.has(
      browserAutomationScopeKey("workspace-1", "thread-1"),
    )).toBe(true));

    view.unmount();
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      activeDispatch.request.requestId,
      activeDispatch.request.sequence,
      "host-shutdown",
    );
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      openRequest.requestId,
      openRequest.sequence,
      "host-shutdown",
    );
    expect(cancel).toHaveBeenCalledWith(activeDispatch.request.requestId);
    expect(useBrowserAutomationStore.getState().activeRequests).toHaveLength(0);
    expect(useBrowserAutomationStore.getState().hostedScopeIds).toHaveLength(0);

    creating.resolve({
      ok: true,
      data: {
        tabId: "unmounted-tab",
        tabs: {
          threadId: "thread-1",
          activeTabId: "unmounted-tab",
          tabs: [{ id: "unmounted-tab", threadId: "thread-1", url: null, title: null, faviconUrl: null, warm: true }],
        },
      },
    });
    executing.resolve(successResponse(activeDispatch.request));
    await act(async () => Promise.all([creating.promise, executing.promise]));
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
  });

  it("bootstraps open from zero targets, reveals Browser, creates a tab, and navigates it", async () => {
    useThreadStore.setState({ runningThreadIds: new Set(["thread-1"]) });
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "created-tab");
      return {
        ok: true,
        data: {
          tabId: "created-tab",
          tabs: { threadId, activeTabId: "created-tab", tabs: [{ id: "created-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "created-tab", targetGeneration: 1, active: true, focused: true, lastUsedAt: 30 },
    });
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => {
      expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe("about:blank");
      expect(
        usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("workspace-1", "thread-1")]?.tabs[0]?.url,
      ).toBe("about:blank");
      controllerChanged?.({
        tabId: "created-tab",
        controller: "agent",
        controlEpoch: 0,
        providerSessionId: value.request.providerSessionId,
        operation: "open",
      });
      return {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: { operation: "open", url: value.request.operation === "open" ? value.request.args.url! : "https://example.com/", title: "Example", controlEpoch: 0 },
      };
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const request = dispatch(1, 9).request;
    const openRequest = { ...request, operation: "open" as const, args: { url: "https://example.com/", activate: true } };
    act(() => {
      harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest });
      harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest });
    });
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(createTab).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith("thread-1", "workspace-1", { activate: true });
    expect(usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("workspace-1", "thread-1")]?.tabs[0]?.url).toBe(
      "about:blank",
    );
    expect(useWorkspaceStore.getState().activeThreadId).toBe("thread-1");
    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      visible: true,
      activeTab: "preview",
    });
    expect(document.querySelector('[data-automation-persistent-scope="thread-1"]')).not.toBeNull();
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has(
      browserAutomationScopeKey("workspace-1", "thread-1"),
    )).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      request: openRequest,
      target: expect.objectContaining({ tabId: "created-tab" }),
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(useDiffStore.getState().previewUrlByThread["thread-1"]).not.toBe("https://example.com/");
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ tabId: "created-tab", targetGeneration: 1 }),
    );
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-1", "thread-1", "created-tab"),
    )).toMatchObject({ controller: "agent", operation: "open" });
    view.unmount();
  });

  it("keeps an active warm user tab selected while an idempotent background open creates one agent tab", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    const userTab = {
      id: "user-tab",
      threadId: "thread-1",
      url: "https://user.example/loaded",
      title: "User page",
      faviconUrl: null,
      warm: true,
      active: true,
    };
    const agentTab = {
      id: "agent-tab",
      threadId: "thread-1",
      url: null,
      title: null,
      faviconUrl: null,
      warm: true,
      active: false,
    };
    let tabSet: BrowserTabSet = {
      threadId: "thread-1",
      activeTabId: userTab.id,
      tabs: [userTab],
    };
    listTabs.mockImplementation(async () => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", userTab.id);
      return { ok: true, data: tabSet };
    });
    createTab.mockImplementation(async (threadId: string, workspaceId: string) => {
      useBrowserAutomationStore.getState().registerTarget(workspaceId, threadId, agentTab.id);
      tabSet = {
        threadId,
        activeTabId: userTab.id,
        tabs: [userTab, agentTab],
      };
      return { ok: true, data: { tabId: agentTab.id, tabs: tabSet } };
    });
    let agentTargetDiscoveryAttempts = 0;
    describeTarget.mockImplementation(async ({ tabId }: { tabId: string }) => {
      if (tabId === agentTab.id && agentTargetDiscoveryAttempts++ === 0) {
        return { ok: false as const, error: "TAB_UNAVAILABLE" };
      }
      return {
        ok: true as const,
        target: {
          windowId: 7,
          threadId: "thread-1",
          tabId,
          targetGeneration: 1,
          active: tabId === userTab.id,
          focused: tabId === userTab.id,
          lastUsedAt: tabId === userTab.id ? 100 : 50,
        },
      };
    });
    execute.mockResolvedValue({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: "request-1192",
      sequence: 1192,
      ok: true,
      result: {
        operation: "open",
        url: "https://agent.example/loaded",
        title: "Agent page",
        controlEpoch: 0,
      },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const openRequest = {
      ...dispatch(1, 1192).request,
      requestId: "request-1192",
      sequence: 1192,
      operation: "open" as const,
      args: {
        url: "https://agent.example/loaded",
        idempotencyKey: "agent-open-1192",
        activate: false,
      },
    };

    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(createTab).toHaveBeenCalledOnce();
    expect(agentTargetDiscoveryAttempts).toBeGreaterThanOrEqual(2);
    expect(createTab).toHaveBeenCalledWith("thread-1", "workspace-1", { activate: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        requestId: openRequest.requestId,
        sequence: openRequest.sequence,
        operation: "open",
        args: { url: openRequest.args.url, idempotencyKey: openRequest.args.idempotencyKey },
      }),
      target: expect.objectContaining({ tabId: agentTab.id, active: false, focused: false }),
    }));

    const firstTabSet = usePreviewTabsStore.getState().tabSetByScope[
      previewTabsScopeKey("workspace-1", "thread-1")
    ];
    expect(firstTabSet).toMatchObject({ activeTabId: userTab.id });
    expect(firstTabSet?.tabs).toEqual([
      expect.objectContaining({ ...userTab, active: true }),
      expect.objectContaining({ id: agentTab.id, url: openRequest.args.url, active: false }),
    ]);
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: "workspace-1",
      activeThreadId: "thread-1",
    });
    expect(useBrowserAutomationStore.getState().lifecycleTabs).toEqual(
      expect.any(Map),
    );
    expect([...useBrowserAutomationStore.getState().lifecycleTabs.values()]).toEqual([
      expect.objectContaining({
        tabId: agentTab.id,
        provenance: "agent-created",
        ownership: "owned",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        providerSessionId: openRequest.providerSessionId,
        providerInstanceId: openRequest.providerInstanceId,
      }),
    ]);
    expect(useBrowserAutomationStore.getState().lifecycleTabs.has(
      browserAutomationTargetKey("workspace-1", "thread-1", userTab.id),
    )).toBe(false);

    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(2));
    expect(createTab).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    const replayTabSet = usePreviewTabsStore.getState().tabSetByScope[
      previewTabsScopeKey("workspace-1", "thread-1")
    ];
    expect(replayTabSet).toMatchObject({ activeTabId: userTab.id });
    expect(replayTabSet?.tabs).toHaveLength(2);
    expect(replayTabSet?.tabs.find((tab) => tab.id === userTab.id)).toMatchObject({
      id: userTab.id,
      url: userTab.url,
      active: true,
      warm: true,
    });
    expect(replayTabSet?.tabs.find((tab) => tab.id === agentTab.id)).toMatchObject({
      id: agentTab.id,
      url: openRequest.args.url,
      active: false,
      warm: true,
    });
    view.unmount();
  });

  it("registers a hidden agent tab for the renderer host before its panel surface", async () => {
    vi.useFakeTimers();
    try {
      useBrowserAutomationStore.setState({ liveTargets: new Map() });
      useDiffStore.getState().closeRightPanelTab("workspace-1", "thread-1", "preview");
      listTabs.mockResolvedValue({
        ok: true,
        data: {
          threadId: "thread-1",
          activeTabId: "cold-tab",
          tabs: [{ id: "cold-tab", threadId: "thread-1", url: null, title: null, faviconUrl: null, warm: false }],
        },
      });
      createTab.mockImplementation(async (threadId: string) => {
        useBrowserAutomationStore.getState().registerTarget(
          "workspace-1",
          threadId,
          "cold-tab",
        );
        return {
          ok: true,
          data: {
            tabId: "cold-tab",
            tabs: {
              threadId,
              activeTabId: "cold-tab",
              tabs: [{ id: "cold-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }],
            },
          },
        };
      });
      describeTarget.mockResolvedValue({
        ok: true,
        target: {
          windowId: 7,
          threadId: "thread-1",
          tabId: "cold-tab",
          targetGeneration: 1,
          active: true,
          focused: true,
          lastUsedAt: 32,
        },
      });
      execute.mockImplementation(async (value: BrowserAutomationHostDispatch): Promise<BrowserAutomationResponse> => ({
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: {
          operation: "open",
          url: "https://example.com/",
          title: "Example",
          controlEpoch: 0,
        },
      }));
      const view = render(<BrowserAutomationHost />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
      expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce();
      const base = dispatch(1, 16).request;
      const openRequest = {
        ...base,
        deadline: Date.now() + 60_000,
        operation: "open" as const,
        args: {
          url: "https://example.com/",
          activate: false,
          idempotencyKey: "cold-agent-open",
        },
      };
      act(() => harness.emit("browserAutomation.bootstrap", {
        hostId,
        generation: 1,
        request: openRequest,
      }));
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(createTab).toHaveBeenCalledWith("thread-1", "workspace-1", {
        activate: false,
        tabId: "cold-tab",
      });
      expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
        hostId,
        1,
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ tabId: "cold-tab" }),
      );
      expect(useBrowserAutomationStore.getState().pendingAgentOpens).toHaveLength(0);
      expect(usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("workspace-1", "thread-1")]?.tabs).toEqual([
        expect.objectContaining({ id: "cold-tab", url: "https://example.com/" }),
      ]);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches a URL-less open bootstrap to an about:blank visible target", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "blank-tab");
      return {
        ok: true,
        data: {
          tabId: "blank-tab",
          tabs: { threadId, activeTabId: "blank-tab", tabs: [{ id: "blank-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "blank-tab", targetGeneration: 1, active: true, focused: true, lastUsedAt: 31 },
    });
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 14).request;
    const openRequest = { ...base, operation: "open" as const, args: { activate: true } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe("about:blank");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      request: openRequest,
      target: expect.objectContaining({ tabId: "blank-tab" }),
    }));
    view.unmount();
  });

  it("bootstraps both activation modes in another thread without stealing user context", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    useWorkspaceStore.setState({ activeThreadId: "thread-2" });
    let created = 0;
    createTab.mockImplementation(async (threadId: string) => {
      created += 1;
      const tabId = `background-${created}`;
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, tabId);
      return {
        ok: true,
        data: {
          tabId,
          tabs: { threadId, activeTabId: tabId, tabs: [{ id: tabId, threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockImplementation(async ({ threadId, tabId }: { threadId: string; tabId: string }) => ({
      ok: true,
      target: { windowId: 7, threadId, tabId, targetGeneration: 1, active: true, focused: false, lastUsedAt: 40 + created },
    }));
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.com/", title: "Example", controlEpoch: 0 },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    for (const [index, activate] of [true, false].entries()) {
      const base = dispatch(1, 15 + index).request;
      const openRequest = { ...base, operation: "open" as const, args: { url: "https://example.com/", activate } };
      act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
      await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(index + 1));
      expect(useWorkspaceStore.getState()).toMatchObject({
        activeWorkspaceId: "workspace-1",
        activeThreadId: "thread-2",
      });
    }
    expect(createTab).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("cancels and unmounts an exact persistent surface when its thread is deleted", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    useWorkspaceStore.setState({ activeThreadId: "thread-2" });
    const pending = deferred<BrowserAutomationResponse>();
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "background-tab");
      return {
        ok: true,
        data: {
          tabId: "background-tab",
          tabs: { threadId, activeTabId: "background-tab", tabs: [{ id: "background-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "background-tab", targetGeneration: 2, active: true, focused: false, lastUsedAt: 50 },
    });
    execute.mockReturnValue(pending.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 20).request;
    const openRequest = { ...base, operation: "open" as const, args: { url: "https://example.com/", activate: false } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const surface = document.querySelector('[data-automation-persistent-scope="thread-1"]');
    expect(surface).not.toBeNull();
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has(
      browserAutomationScopeKey("workspace-1", "thread-1"),
    )).toBe(true);

    act(() => releaseBrowserAutomationThreadScope("workspace-1", "thread-1"));
    await waitFor(() => expect(document.querySelector(
      '[data-automation-persistent-scope="thread-1"]',
    )).toBeNull());
    expect(cancel).toHaveBeenCalledWith(openRequest.requestId);
    expect(harness.transport.cancelBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      openRequest.requestId,
      openRequest.sequence,
      "host-shutdown",
    );
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has(
      browserAutomationScopeKey("workspace-1", "thread-1"),
    )).toBe(false);

    pending.resolve(response(openRequest));
    await act(async () => pending.promise);
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    view.unmount();
  });

  it("evicts the oldest idle persistent surface across six sequential threads", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    useWorkspaceStore.setState({ activeThreadId: "visible-thread" });
    const hostedScopeSpy = vi.spyOn(useBrowserAutomationStore.getState(), "setHostedScopeIds");
    listTabs.mockImplementation(async (threadId: string) => ({
      ok: true,
      data: { threadId, activeTabId: "", tabs: [] },
    }));
    createTab.mockImplementation(async (threadId: string) => {
      const tabId = `tab-${threadId}`;
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, tabId);
      return {
        ok: true,
        data: {
          tabId,
          tabs: { threadId, activeTabId: tabId, tabs: [{ id: tabId, threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockImplementation(async ({ threadId, tabId }: { threadId: string; tabId: string }) => ({
      ok: true,
      target: { windowId: 7, threadId, tabId, targetGeneration: 1, active: true, focused: false, lastUsedAt: 60 },
    }));
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => response(value.request));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostedScopeBaseline = hostedScopeSpy.mock.calls.length;
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");

    let oldestVisiblePanel: Element | null = null;
    let oldestDock: HTMLDivElement | null = null;
    for (let index = 0; index < 6; index += 1) {
      if (index === 5) {
        oldestVisiblePanel = document.querySelector(
          '[data-automation-persistent-scope="sequential-0"] [data-testid="automation-preview-panel"]',
        );
        oldestDock = document.createElement("div");
        oldestDock.dataset.automationPreviewDock = "sequential-0";
        oldestDock.dataset.automationPreviewWorkspace = "workspace-1";
        oldestDock.dataset.visible = "true";
        vi.spyOn(oldestDock, "getBoundingClientRect").mockReturnValue({
          left: 5, top: 10, width: 700, height: 500, right: 705, bottom: 510, x: 5, y: 10, toJSON: () => undefined,
        });
        document.body.append(oldestDock);
        await waitFor(() => expect(oldestVisiblePanel).toHaveAttribute(
          "data-automation-only",
          "false",
        ));
      }
      const threadId = `sequential-${index}`;
      const base = dispatch(1, 30 + index, { threadId }).request;
      const request = { ...base, operation: "open" as const, args: { activate: false } };
      act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request }));
      await waitFor(() => expect(
        harness.transport.respondToBrowserAutomationRequest,
      ).toHaveBeenCalledTimes(index + 1));
      await act(async () => Promise.resolve());
    }

    expect(document.querySelectorAll("[data-automation-persistent-scope]")).toHaveLength(5);
    expect(document.querySelector('[data-automation-persistent-scope="sequential-1"]')).toBeNull();
    expect(document.querySelector(
      '[data-automation-persistent-scope="sequential-0"] [data-testid="automation-preview-panel"]',
    )).toBe(oldestVisiblePanel);
    expect(document.querySelector('[data-automation-persistent-scope="sequential-5"]')).not.toBeNull();
    expect(harness.transport.cancelBrowserAutomationRequest).not.toHaveBeenCalled();
    expect(hostedScopeSpy.mock.calls.slice(hostedScopeBaseline).some(
      ([scopeIds]) => scopeIds.size === 0,
    )).toBe(false);

    const fourthPanel = document.querySelector(
      '[data-automation-persistent-scope="sequential-4"] [data-testid="automation-preview-panel"]',
    );
    const fifthPanel = document.querySelector(
      '[data-automation-persistent-scope="sequential-5"] [data-testid="automation-preview-panel"]',
    );
    const fourthDock = document.createElement("div");
    fourthDock.dataset.automationPreviewDock = "sequential-4";
    fourthDock.dataset.automationPreviewWorkspace = "workspace-1";
    fourthDock.dataset.visible = "false";
    const fifthDock = document.createElement("div");
    fifthDock.dataset.automationPreviewDock = "sequential-5";
    fifthDock.dataset.automationPreviewWorkspace = "workspace-1";
    fifthDock.dataset.visible = "true";
    vi.spyOn(fourthDock, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 800, height: 600, right: 810, bottom: 620, x: 10, y: 20, toJSON: () => undefined,
    });
    vi.spyOn(fifthDock, "getBoundingClientRect").mockReturnValue({
      left: 20, top: 30, width: 900, height: 700, right: 920, bottom: 730, x: 20, y: 30, toJSON: () => undefined,
    });
    document.body.append(fourthDock, fifthDock);
    await waitFor(() => expect(fifthPanel).toHaveAttribute("data-automation-only", "false"));
    expect(fourthPanel).toHaveAttribute("data-automation-only", "true");

    fourthDock.dataset.visible = "true";
    fifthDock.dataset.visible = "false";
    await waitFor(() => expect(fourthPanel).toHaveAttribute("data-automation-only", "false"));
    expect(fifthPanel).toHaveAttribute("data-automation-only", "true");
    expect(document.querySelector(
      '[data-automation-persistent-scope="sequential-4"] [data-testid="automation-preview-panel"]',
    )).toBe(fourthPanel);
    expect(document.querySelector(
      '[data-automation-persistent-scope="sequential-5"] [data-testid="automation-preview-panel"]',
    )).toBe(fifthPanel);
    fourthDock.remove();
    fifthDock.remove();
    oldestDock?.remove();
    view.unmount();
  });

  it("runs five concurrent thread surfaces without eviction and rejects only a busy sixth", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    useWorkspaceStore.setState({ activeThreadId: "visible-thread" });
    listTabs.mockImplementation(async (threadId: string) => ({
      ok: true,
      data: { threadId, activeTabId: "", tabs: [] },
    }));
    createTab.mockImplementation(async (threadId: string) => {
      const tabId = `tab-${threadId}`;
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, tabId);
      return {
        ok: true,
        data: {
          tabId,
          tabs: { threadId, activeTabId: tabId, tabs: [{ id: tabId, threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockImplementation(async ({ threadId, tabId }: { threadId: string; tabId: string }) => ({
      ok: true,
      target: { windowId: 7, threadId, tabId, targetGeneration: 1, active: true, focused: false, lastUsedAt: 70 },
    }));
    const pending = Array.from({ length: 5 }, () => deferred<BrowserAutomationResponse>());
    execute.mockImplementation((value: BrowserAutomationHostDispatch) => {
      const index = Number(value.scope.threadId.split("-").at(-1));
      return pending[index]!.promise;
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const activeRequests: BrowserAutomationHostDispatch["request"][] = [];
    for (let index = 0; index < 5; index += 1) {
      const base = dispatch(1, 40 + index, { threadId: `concurrent-${index}` }).request;
      const request = { ...base, operation: "open" as const, args: { activate: false } };
      activeRequests.push(request);
      act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request }));
    }
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(5));
    expect(document.querySelectorAll("[data-automation-persistent-scope]")).toHaveLength(5);

    const sixthBase = dispatch(1, 45, { threadId: "concurrent-5" }).request;
    const sixth = { ...sixthBase, operation: "open" as const, args: { activate: false } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: sixth }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ message: expect.stringContaining("five-thread") }) }),
    ));
    expect(execute).toHaveBeenCalledTimes(5);

    pending.forEach((item, index) => item.resolve(response(activeRequests[index]!)));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(6));
    view.unmount();
  });

  it("re-warms a cold existing background tab instead of creating a duplicate", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    useWorkspaceStore.setState({ activeThreadId: "thread-2" });
    listTabs.mockImplementationOnce(async () => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "cold-tab");
      return {
        ok: true,
        data: {
          threadId: "thread-1",
          activeTabId: "cold-tab",
          tabs: [{ id: "cold-tab", threadId: "thread-1", url: "https://existing.example/", title: "Existing", faviconUrl: null, warm: false }],
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "cold-tab", targetGeneration: 2, active: true, focused: false, lastUsedAt: 50 },
    });
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://existing.example/", title: "Existing", controlEpoch: 0 },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 17).request;
    const openRequest = { ...base, operation: "open" as const, args: { activate: false } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(createTab).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ tabId: "cold-tab", targetGeneration: 2 }),
    }));
    expect(useWorkspaceStore.getState().activeThreadId).toBe("thread-2");
    view.unmount();
  });

  it("applies resize to the exact visible webview viewport and returns honest dimensions", async () => {
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 10);
    const resizeDispatch = {
      ...base,
      request: { ...base.request, operation: "resize" as const, args: { width: 1024, height: 768 } },
    };
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: resizeDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(
      browserAutomationTargetKey("workspace-1", "thread-1", "tab-1"),
    )).toEqual({ width: 1024, height: 768 });
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "resize", width: 1024, height: 768 }) }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(beginRendererOperation).toHaveBeenCalledWith(resizeDispatch);
    expect(finishRendererOperation).toHaveBeenCalledWith({ leaseId: "renderer-lease", succeeded: true });
    view.unmount();
  });

  it("cancels desktop execution when bootstrap is revoked after it starts", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "created-tab");
      return {
        ok: true,
        data: {
          tabId: "created-tab",
          tabs: { threadId, activeTabId: "created-tab", tabs: [{ id: "created-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId: "created-tab", targetGeneration: 1, active: true, focused: true, lastUsedAt: 30 },
    });
    const executing = deferred<BrowserAutomationResponse>();
    execute.mockReturnValueOnce(executing.promise);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 12).request;
    const openRequest = { ...base, operation: "open" as const, args: { url: "https://example.com/", activate: true } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    act(() => harness.emit("browserAutomation.cancel", {
      hostId,
      generation: 1,
      requestId: openRequest.requestId,
      sequence: openRequest.sequence,
    }));
    expect(cancel).toHaveBeenCalledWith(openRequest.requestId);
    executing.resolve(response(openRequest));
    await act(async () => executing.promise);
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("thread-1", "workspace-1", "created-tab"));
    expect(browserTargetRegistry.get("workspace-1", "thread-1", "created-tab")).toBeNull();
    view.unmount();
  });

  it("releases a bootstrap-created target when bootstrap fails before execution", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "failed-tab");
      return {
        ok: true,
        data: {
          tabId: "failed-tab",
          tabs: { threadId, activeTabId: "failed-tab", tabs: [{ id: "failed-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockImplementation(async ({ tabId }: { readonly tabId: string }) =>
      tabId === "failed-tab"
        ? { ok: false, error: "target unavailable" }
        : { ok: true, target: { windowId: 7, threadId: "thread-1", tabId, targetGeneration: 3, active: true, focused: true, lastUsedAt: 10 } },
    );
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const request = dispatch(1, 13).request;
    const openRequest = { ...request, operation: "open" as const, args: { url: "https://example.com/", activate: true } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("thread-1", "workspace-1", "failed-tab"));
    expect(browserTargetRegistry.get("workspace-1", "thread-1", "failed-tab")).toBeNull();
    view.unmount();
  });

  it("attempts created-tab close when background restoration rejects", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    usePreviewTabsStore.setState({
      tabSetByScope: {
        [previewTabsScopeKey("workspace-1", "thread-1")]: {
          threadId: "thread-1",
          activeTabId: "previous-tab",
          tabs: [{ id: "previous-tab", threadId: "thread-1", url: null, title: null, faviconUrl: null, warm: true, active: true }],
        },
      },
    });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "restore-failure-tab");
      return {
        ok: true,
        data: {
          tabId: "restore-failure-tab",
          tabs: { threadId, activeTabId: "restore-failure-tab", tabs: [{ id: "restore-failure-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockImplementation(async ({ tabId }: { readonly tabId: string }) => ({
      ok: true,
      target: { windowId: 7, threadId: "thread-1", tabId, targetGeneration: 1, active: true, focused: true, lastUsedAt: 10 },
    }));
    execute.mockRejectedValueOnce(new Error("bootstrap execution failed"));
    const activatePage = vi.fn().mockRejectedValue(new Error("restore activation failed"));
    usePreviewTabsStore.setState({ activatePage });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const request = dispatch(1, 15).request;
    const openRequest = { ...request, operation: "open" as const, args: { url: "https://example.com/", activate: false } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("thread-1", "workspace-1", "restore-failure-tab"));
    expect(activatePage).toHaveBeenCalledWith("workspace-1", "thread-1", "previous-tab");
    expect(browserTargetRegistry.get("workspace-1", "thread-1", "restore-failure-tab")).toBeNull();
    view.unmount();
  });

  it("retains logical target when created-tab physical close fails", async () => {
    useBrowserAutomationStore.setState({ liveTargets: new Map() });
    createTab.mockImplementation(async (threadId: string) => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", threadId, "close-failure-tab");
      return {
        ok: true,
        data: {
          tabId: "close-failure-tab",
          tabs: { threadId, activeTabId: "close-failure-tab", tabs: [{ id: "close-failure-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }] },
        },
      };
    });
    describeTarget.mockResolvedValue({
      ok: false,
      error: "target unavailable",
    });
    closeTab.mockResolvedValueOnce({ ok: false, error: "physical close failed" });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const request = dispatch(1, 17).request;
    const openRequest = { ...request, operation: "open" as const, args: { url: "https://example.com/", activate: true } };
    act(() => harness.emit("browserAutomation.bootstrap", { hostId, generation: 1, request: openRequest }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("thread-1", "workspace-1", "close-failure-tab"));
    expect(browserTargetRegistry.get("workspace-1", "thread-1", "close-failure-tab")).not.toBeNull();
    view.unmount();
  });

  it("does not mutate the renderer when its desktop operation lease is stale", async () => {
    beginRendererOperation.mockResolvedValueOnce({
      ok: false,
      response: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: "request-11",
        sequence: 11,
        ok: false,
        error: { code: "STALE_CONTROL_EPOCH", message: "stale", retryable: true },
      },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const base = dispatch(1, 11);
    const resizeDispatch = {
      ...base,
      request: { ...base.request, operation: "resize" as const, args: { width: 800, height: 600 } },
    };
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: resizeDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(useBrowserAutomationStore.getState().viewportByTarget.has(
      browserAutomationTargetKey("workspace-1", "thread-1", "tab-1"),
    )).toBe(false);
    expect(finishRendererOperation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("normalizes status capabilities to include renderer-managed operations", async () => {
    vi.stubGlobal("MediaRecorder", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    execute.mockImplementation(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: {
        operation: "status",
        available: true,
        active: true,
        url: "https://example.com/",
        loading: false,
        focused: true,
        viewport: { width: 1_280, height: 720 },
        capabilities: ["status"],
      },
    }));
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 20) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    const sent = harness.transport.respondToBrowserAutomationRequest.mock.calls.at(-1)?.[2];
    expect(sent.result.capabilities).toEqual(expect.arrayContaining([
      "open", "resize", "recordingStart", "recordingStop",
    ]));
    view.unmount();
    vi.unstubAllGlobals();
  });

  it("returns web screenshot responses through transport", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const screenshotDispatch = dispatch(1, 21);
    const requestId = screenshotDispatch.request.requestId;
    const sequence = screenshotDispatch.request.sequence;
    const expectedControlEpoch = screenshotDispatch.request.expectedControlEpoch;
    screenshotDispatch.request = {
      ...screenshotDispatch.request,
      operation: "screenshot",
      args: { maxWidth: 320, fullPage: false },
    } as never;
    webExecutor.executeWebBrowserDispatch.mockResolvedValue({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId,
      sequence,
      ok: true,
      result: {
        operation: "screenshot",
        screenshot: {
          mediaType: "image/png",
          dataBase64: "AAAA",
          width: 320,
          height: 180,
          truncation: { truncated: false },
        },
        controlEpoch: expectedControlEpoch,
      },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: screenshotDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(
      screenshotDispatch,
      expect.any(AbortSignal),
    );
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "screenshot" }) }),
      screenshotDispatch.target,
    );
    view.unmount();
  });

  it("sanitizes the mounted web status location before responding", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const iframe = document.createElement("iframe");
    setIframeIdentity(iframe, "tab-1");
    const targetDocument = {
      location: { href: "https://user:password@example.com/sessions/eyJabcdefghijk.abcdefghijklmnop?secret=query#fragment" },
      body: document.createElement("body"),
    } as unknown as Document;
    Object.defineProperty(iframe, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: targetDocument });
    document.body.appendChild(iframe);
    const statusResponse = successResponse(dispatch(1, 20).request);
    if (!statusResponse.ok || statusResponse.result.operation !== "status") throw new Error("Expected status response");
    webExecutor.executeWebBrowserDispatch.mockResolvedValue({
      ...statusResponse,
      result: { ...statusResponse.result, url: targetDocument.location.href },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 20) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    const sent = harness.transport.respondToBrowserAutomationRequest.mock.calls.at(-1)?.[2];
    expect(sent.result.url).toMatch(/^https:\/\/example\.com\//);
    expect(sent.result.url).not.toMatch(/user|password|eyJabcdefghijk|secret|fragment/);
    view.unmount();
    iframe.remove();
  });

  it("returns typed cross-origin status failure for an inaccessible mounted web target", async () => {
    delete window.desktopBridge;
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const iframe = document.createElement("iframe");
    setIframeIdentity(iframe, "tab-1");
    iframe.src = "https://evil.example/";
    Object.defineProperty(iframe, "contentWindow", { configurable: true, value: { location: { origin: "https://evil.example" } } });
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: { body: document.createElement("body") } });
    document.body.appendChild(iframe);
    webExecutor.executeWebBrowserDispatch.mockResolvedValue({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: dispatch(1, 20).request.requestId,
      sequence: 20,
      ok: false,
      error: { code: "CROSS_ORIGIN", message: "Visible preview is cross-origin", retryable: false },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: dispatch(1, 20) }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(harness.transport.respondToBrowserAutomationRequest.mock.calls.at(-1)?.[2]).toMatchObject({ ok: false, error: { code: "CROSS_ORIGIN" } });
    view.unmount();
    iframe.remove();
  });

  it("routes web click and type through the broker for the exact iframe target", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    delete window.desktopBridge;
    const frame = document.createElement("iframe");
    setIframeIdentity(frame, "tab-1");
    document.body.append(frame);
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<button id="save">Save</button><input id="name" />';
    const button = frameDocument.querySelector("button")!;
    const input = frameDocument.querySelector("input")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    await waitFor(() => expect(useBrowserAutomationStore.getState().registered).toBe(true));
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const clickDispatch = dispatch(1, 30, { targetGeneration: 1 });
    clickDispatch.request = { ...clickDispatch.request, operation: "click", args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: clickDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(clicked).toHaveBeenCalledOnce();
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(hostId, 1, expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "click" }) }), clickDispatch.target);
    expect(harness.transport.cancelBrowserAutomationRequest).not.toHaveBeenCalled();
    const typeDispatch = dispatch(1, 31, { targetGeneration: 1 });
    typeDispatch.request = { ...typeDispatch.request, operation: "type", args: { target: { cssSelector: "#name" }, text: "typed", clear: true, submit: false, timeoutMs: 1000 } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: typeDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("typed");
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenLastCalledWith(hostId, 1, expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "type" }) }), typeDispatch.target);
    view.unmount();
    frame.remove();
  });

  it("invalidates the exact web target on direct pointer input without cancelling the request", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    delete window.desktopBridge;
    const frame = document.createElement("iframe");
    setIframeIdentity(frame, "tab-1");
    document.body.append(frame);
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<button id="save">Save</button>';
    const button = frameDocument.querySelector("button")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const clickDispatch = dispatch(1, 32, { targetGeneration: 1 });
    clickDispatch.request = { ...clickDispatch.request, operation: "click", args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 } } as never;
    frameDocument.addEventListener("mousedown", () => frameDocument.dispatchEvent(new frameDocument.defaultView!.Event("pointerdown", { bubbles: true })), true);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: clickDispatch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(useBrowserAutomationStore.getState().activeRequests.size).toBe(0));
    expect(clicked).toHaveBeenCalledOnce();
    expect(harness.transport.cancelBrowserAutomationRequest).not.toHaveBeenCalled();
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: true, result: expect.objectContaining({ operation: "click" }) }),
      clickDispatch.target,
    );
    expect(useBrowserAutomationStore.getState().controllers.size).toBe(0);
    view.unmount();
    frame.remove();
  });

  it("rejects stale web generations and control epochs without mutating the iframe", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    delete window.desktopBridge;
    const frame = document.createElement("iframe");
    setIframeIdentity(frame, "tab-1");
    document.body.append(frame);
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<button id="save">Save</button><input id="name" />';
    const button = frameDocument.querySelector("button")!;
    const input = frameDocument.querySelector("input")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    useBrowserAutomationStore.getState().setControllerForTarget("workspace-1", "thread-1", "tab-1", { tabId: "tab-1", controller: "agent", controlEpoch: 2 });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const staleGeneration = dispatch(1, 33, { targetGeneration: 9 });
    staleGeneration.request = { ...staleGeneration.request, operation: "click", args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: staleGeneration }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenLastCalledWith(hostId, 1, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_TARGET_GENERATION" }) }), staleGeneration.target);
    expect(clicked).not.toHaveBeenCalled();
    const staleEpoch = dispatch(1, 34, { targetGeneration: 1, expectedControlEpoch: 0 });
    staleEpoch.request = { ...staleEpoch.request, operation: "type", args: { target: { cssSelector: "#name" }, text: "typed", clear: true, submit: false, timeoutMs: 1000 } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: staleEpoch }));
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledTimes(2));
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenLastCalledWith(hostId, 1, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_CONTROL_EPOCH" }) }), staleEpoch.target);
    expect(input.value).toBe("");
    view.unmount();
    frame.remove();
  });

  it("rejects a pending request after web iframe replacement without mutating the new document", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    delete window.desktopBridge;
    const frame = document.createElement("iframe");
    setIframeIdentity(frame, "tab-1");
    document.body.append(frame);
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<input id="name" />';
    const input = frameDocument.querySelector("input")!;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const pending: Array<FrameRequestCallback> = [];
    Object.defineProperty(frameDocument.defaultView, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        pending.push(callback);
        return pending.length;
      },
    });
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    await waitFor(() => expect(useBrowserAutomationStore.getState().registered).toBe(true));
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const typeDispatch = dispatch(1, 36, { targetGeneration: 1 });
    typeDispatch.request = { ...typeDispatch.request, operation: "type", args: { target: { cssSelector: "#name" }, text: "typed", clear: true, submit: false, timeoutMs: 1000 } } as never;
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: typeDispatch }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().activeRequests.size).toBe(1));
    act(() => useBrowserAutomationStore.getState().refreshTarget("workspace-1", "thread-1", "tab-1"));
    pending.shift()?.(performance.now());
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledOnce());
    expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenLastCalledWith(
      hostId,
      1,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "STALE_TARGET_GENERATION" }) }),
      typeDispatch.target,
    );
    expect(input).toHaveValue("");
    view.unmount();
    frame.remove();
    delete (frameDocument.defaultView as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  });

  it("suppresses mutation and response after broker cancellation", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    delete window.desktopBridge;
    const frame = document.createElement("iframe");
    setIframeIdentity(frame, "tab-1");
    document.body.append(frame);
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<button id="save">Save</button>';
    const button = frameDocument.querySelector("button")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    const hostId = sessionStorage.getItem("mcode.browserAutomation.hostId");
    const clickDispatch = dispatch(1, 35, { targetGeneration: 1 });
    clickDispatch.request = { ...clickDispatch.request, operation: "click", args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 } } as never;
    frameDocument.addEventListener("mousedown", () => harness.emit("browserAutomation.cancel", { hostId, generation: 1, requestId: clickDispatch.request.requestId, sequence: clickDispatch.request.sequence }), true);
    act(() => harness.emit("browserAutomation.request", { hostId, generation: 1, dispatch: clickDispatch }));
    await waitFor(() => expect(useBrowserAutomationStore.getState().activeRequests.size).toBe(0));
    expect(clicked).not.toHaveBeenCalled();
    expect(harness.transport.respondToBrowserAutomationRequest).not.toHaveBeenCalled();
    view.unmount();
    frame.remove();
  });

  it("disposes exact target recording on human takeover even after start settled", async () => {
    const disposeTarget = vi.spyOn(BrowserAutomationRecorder.prototype, "disposeTarget");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    await act(async () => {
      interruptBrowserAutomationTarget("workspace-1", "thread-1", "tab-1", "human-interrupted");
      await Promise.resolve();
    });
    expect(disposeTarget).toHaveBeenCalledWith("workspace-1", "thread-1", "tab-1");
    view.unmount();
    disposeTarget.mockRestore();
  });
});
