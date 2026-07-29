import { act, render, waitFor } from "@testing-library/react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  type BrowserAutomationControllerState,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  interruptBrowserAutomationTarget,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "@/stores/browserAutomationStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";

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

vi.mock("../PreviewPanel", () => ({
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

import { BrowserAutomationHost, isBrowserAutomationWebRuntimeEnabled } from "../BrowserAutomationHost";
import { BrowserAutomationRecorder } from "../browserAutomationRecorder";

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
  options: { requestId?: string; threadId?: string; tabId?: string } = {},
): BrowserAutomationHostDispatch {
  const threadId = options.threadId ?? "thread-1";
  const tabId = options.tabId ?? "tab-1";
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
      targetGeneration: 3,
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
      expectedControlEpoch: 0,
      operation: "status",
      args: {},
    },
    target: {
      desktopInstanceId: `desktop-${generation}`,
      windowId: 7,
      connectionGeneration: generation,
      threadId,
      tabId,
      targetGeneration: 3,
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

describe("BrowserAutomationHost", () => {
  const execute = vi.fn();
  const beginRendererOperation = vi.fn();
  const finishRendererOperation = vi.fn();
  const cancel = vi.fn();
  const interrupt = vi.fn();
  const describeTarget = vi.fn();
  const createTab = vi.fn();
  const closeTab = vi.fn();
  const listTabs = vi.fn();
  let nextGeneration: number;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.listeners.clear();
    sessionStorage.clear();
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
          describeTarget,
          getMediaSourceId: vi.fn(),
          onControllerChanged(_callback: (state: BrowserAutomationControllerState) => void) {
            return () => undefined;
          },
        },
        tabs: {
          list: listTabs,
          create: createTab,
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
    useBrowserAutomationStore.setState({
      liveTargets: new Map(),
      controllers: new Map(),
      activeRequests: new Map(),
      registered: false,
      viewportByTarget: new Map(),
      hostedScopeIds: new Set(),
    });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {} });
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
    await waitFor(() => expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalled());
    expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(`${window.location.origin}/fixture`);
    expect(webExecutor.executeWebBrowserDispatch).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ operation: "open", args: openRequest.args }),
    }), expect.any(AbortSignal));
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
    act(() => useBrowserAutomationStore.getState().refreshTarget("thread-1", "tab-1"));
    await waitFor(() => expect(harness.transport.updateBrowserAutomationHostTargets).toHaveBeenCalledTimes(2));
    expect(harness.transport.updateBrowserAutomationHostTargets.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({ windowId: 8, targetGeneration: 4, connectionGeneration: 1 }),
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

    act(() => useBrowserAutomationStore.getState().unregisterTarget("thread-1", "tab-1"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(activeDispatch.request.requestId));
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
      interruptBrowserAutomationTarget("thread-2", "tab-1", "human-interrupted");
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
    await waitFor(() => expect(useBrowserAutomationStore.getState().hostedScopeIds.has("thread-1")).toBe(true));

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
        usePreviewTabsStore.getState().tabSetByScope["thread-1"]?.tabs[0]?.url,
      ).toBe("about:blank");
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
    expect(createTab).toHaveBeenCalledWith("thread-1", true);
    expect(usePreviewTabsStore.getState().tabSetByScope["thread-1"]?.tabs[0]?.url).toBe(
      "about:blank",
    );
    expect(useWorkspaceStore.getState().activeThreadId).toBe("thread-1");
    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      visible: true,
      activeTab: "preview",
    });
    expect(document.querySelector('[data-automation-persistent-scope="thread-1"]')).not.toBeNull();
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has("thread-1")).toBe(true);
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
    view.unmount();
  });

  it("allows a cold browser target to attach after ten seconds but before its deadline", async () => {
    vi.useFakeTimers();
    try {
      useBrowserAutomationStore.setState({ liveTargets: new Map() });
      createTab.mockImplementation(async (threadId: string) => ({
        ok: true,
        data: {
          tabId: "cold-tab",
          tabs: {
            threadId,
            activeTabId: "cold-tab",
            tabs: [{ id: "cold-tab", threadId, url: null, title: null, faviconUrl: null, warm: true }],
          },
        },
      }));
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
        args: { url: "https://example.com/", activate: true },
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
      expect(execute).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(10_500);
        useBrowserAutomationStore.getState().registerTarget(
          "workspace-1",
          "thread-1",
          "cold-tab",
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(execute).toHaveBeenCalledOnce();
      expect(harness.transport.respondToBrowserAutomationRequest).toHaveBeenCalledWith(
        hostId,
        1,
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ tabId: "cold-tab" }),
      );
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
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has("thread-1")).toBe(true);

    act(() => releaseBrowserAutomationThreadScope("thread-1"));
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
    expect(useBrowserAutomationStore.getState().hostedScopeIds.has("thread-1")).toBe(false);

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
    fourthDock.dataset.visible = "false";
    const fifthDock = document.createElement("div");
    fifthDock.dataset.automationPreviewDock = "sequential-5";
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
      JSON.stringify(["thread-1", "tab-1"]),
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
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("thread-1", "created-tab"));
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
      JSON.stringify(["thread-1", "tab-1"]),
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

  it("disposes exact target recording on human takeover even after start settled", async () => {
    const disposeTarget = vi.spyOn(BrowserAutomationRecorder.prototype, "disposeTarget");
    const view = render(<BrowserAutomationHost />);
    await waitFor(() => expect(harness.transport.registerBrowserAutomationHost).toHaveBeenCalledOnce());
    await act(async () => {
      interruptBrowserAutomationTarget("thread-1", "tab-1", "human-interrupted");
      await Promise.resolve();
    });
    expect(disposeTarget).toHaveBeenCalledWith("thread-1", "tab-1");
    view.unmount();
    disposeTarget.mockRestore();
  });
});
