import { act, render, screen } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSurfaceHostRoot,
  browserSurfaceHost,
} from "../BrowserSurfaceHostRoot";
import type { BrowserSurfaceIdentity } from "../../browser-surfaces";
import { previewTabsScopeKey, usePreviewTabsStore } from "../../state/previewTabsStore";
import { useBrowserAutomationStore } from "../../automation/browserAutomationStore";
import type {
  PreviewPopupRequest,
  PreviewSurfaceDiscardRequest,
} from "@/transport/desktop-bridge";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "web-preview",
};

const UNRELATED_IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-2" },
  tabId: "web-preview-other",
};

const UNRELATED_SCOPE_KEY = previewTabsScopeKey("workspace-1", "thread-2");

function SurfaceSnapshotProbe({ identity }: { identity: BrowserSurfaceIdentity }) {
  const subscribe = (listener: () => void): (() => void) =>
    browserSurfaceHost.subscribe(identity, () => listener());
  const getSnapshot = (): ReturnType<typeof browserSurfaceHost.getSnapshot> =>
    browserSurfaceHost.getSnapshot(identity);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);

  return <output data-testid={`surface-title-${identity.tabId}`}>{snapshot?.title ?? ""}</output>;
}

function PanelStoreRerenderHarness() {
  usePreviewTabsStore((state) => state.liveChromeByScope[UNRELATED_SCOPE_KEY]);
  useBrowserAutomationStore((state) => state.status);
  return <BrowserSurfaceHostRoot />;
}

async function flushSurfaceFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      window.setTimeout(resolve, 0);
    });
  });
}

describe("BrowserSurfaceHostRoot", () => {
  const originalOpenPage = usePreviewTabsStore.getState().openPage;
  const originalAutomationStatus = useBrowserAutomationStore.getState().status;

  afterEach(() => {
    browserSurfaceHost.dispose(IDENTITY);
    browserSurfaceHost.dispose(UNRELATED_IDENTITY);
    usePreviewTabsStore.setState({
      openPage: originalOpenPage,
      tabSetByScope: {},
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });
    useBrowserAutomationStore.getState().releaseWorkspaceTargets("workspace-1");
    useBrowserAutomationStore.getState().setStatus(originalAutomationStatus);
    delete window.desktopBridge;
  });

  it("leaves page input to the hosted Browser surface", () => {
    render(<BrowserSurfaceHostRoot />);

    expect(document.querySelector("[data-browser-surface-host]")).toHaveClass(
      "size-0",
    );
    expect(document.querySelector("[data-browser-surface-host]")).not.toHaveClass(
      "pointer-events-none",
    );
  });

  it("shows the edge blur above the hosted Browser surface only during agent control", () => {
    render(<BrowserSurfaceHostRoot />);
    browserSurfaceHost.create(IDENTITY, {
      address: "https://example.test/controlled",
    });
    browserSurfaceHost.present(IDENTITY, {
      left: 10,
      top: 20,
      width: 640,
      height: 480,
      zIndex: 31,
    });

    const frame = screen.getByTestId("web-runtime-preview-iframe");
    const indicator = screen.getByTestId("browser-surface-control-indicator");
    expect(indicator).toHaveStyle({ visibility: "hidden" });

    act(() => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
      useBrowserAutomationStore.getState().setControllerForTarget(
        "workspace-1",
        "thread-1",
        "web-preview",
        { tabId: "web-preview", controller: "agent", controlEpoch: 1 },
      );
    });

    expect(indicator).toHaveStyle({ visibility: "visible", pointerEvents: "none" });
    expect(Number(indicator.style.zIndex)).toBeGreaterThan(Number(frame.style.zIndex));
    expect(indicator.style.backgroundImage).toContain("transparent 32px");
    expect(indicator.style.boxShadow).toContain("inset 0 0 40px");
    expect(indicator.style.boxShadow).toContain("0 0 24px");

    act(() => {
      useBrowserAutomationStore.getState().setControllerForTarget(
        "workspace-1",
        "thread-1",
        "web-preview",
        { tabId: "web-preview", controller: "none", controlEpoch: 1 },
      );
    });

    expect(indicator).toHaveStyle({ visibility: "hidden" });
  });

  it("discards only the exact current generation selected by Memory Saver", () => {
    let onDiscardRequested: ((request: PreviewSurfaceDiscardRequest) => void) | null = null;
    const stopDiscardRequests = vi.fn();
    const first = browserSurfaceHost.create(IDENTITY, {
      generation: 7,
      address: "https://example.test/recovery",
    });
    window.desktopBridge = {
      preview: {
        surface: {
          onPopupRequested: vi.fn(() => () => undefined),
          onDiscardRequested: vi.fn((listener: (request: PreviewSurfaceDiscardRequest) => void) => {
            onDiscardRequested = listener;
            return stopDiscardRequests;
          }),
        },
      },
    } as never;
    const view = render(<BrowserSurfaceHostRoot />);

    act(() => onDiscardRequested?.({ identity: IDENTITY, generation: 6 }));
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBe(first);

    act(() => {
      useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
      useBrowserAutomationStore.getState().setControllerForTarget(
        "workspace-1",
        "thread-1",
        "web-preview",
        { tabId: "web-preview", controller: "agent", controlEpoch: 1 },
      );
      onDiscardRequested?.({ identity: IDENTITY, generation: 7 });
    });
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBe(first);

    act(() => {
      useBrowserAutomationStore.getState().setControllerForTarget(
        "workspace-1",
        "thread-1",
        "web-preview",
        { tabId: "web-preview", controller: "none", controlEpoch: 1 },
      );
      onDiscardRequested?.({ identity: IDENTITY, generation: 7 });
    });
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBeNull();
    expect(browserSurfaceHost.inspect(IDENTITY)?.residency).toBe("cold");

    view.unmount();
    expect(stopDiscardRequests).toHaveBeenCalledTimes(1);
  });

  it("keeps the root host mounted across unrelated panel and store updates", () => {
    const phases: Parameters<ProfilerOnRenderCallback>[1][] = [];
    const view = render(
      <Profiler id="browser-surface-host-root" onRender={(_id, phase) => phases.push(phase)}>
        <PanelStoreRerenderHarness />
      </Profiler>,
    );
    const rootBefore = document.querySelector("[data-browser-surface-host]");
    expect(rootBefore).not.toBeNull();

    act(() => {
      usePreviewTabsStore.getState().setLiveChrome("workspace-1", "thread-2", {
        title: "Unrelated panel update",
        url: "https://other.example.test",
        favicon: null,
      });
      useBrowserAutomationStore.getState().setStatus("registered");
    });

    expect(document.querySelector("[data-browser-surface-host]")).toBe(rootBefore);
    expect(phases.filter((phase) => phase === "mount")).toHaveLength(1);
    view.unmount();
  });

  it("does not commit for a semantic no-op surface event", async () => {
    browserSurfaceHost.create(IDENTITY, { address: "https://example.test/profiler-no-op" });
    await flushSurfaceFrame();
    const commits: Parameters<ProfilerOnRenderCallback>[1][] = [];
    const view = render(
      <Profiler id="observed-surface" onRender={(_id, phase) => commits.push(phase)}>
        <SurfaceSnapshotProbe identity={IDENTITY} />
      </Profiler>,
    );

    act(() => browserSurfaceHost.handleEvent({
      type: "title-updated",
      identity: IDENTITY,
      generation: browserSurfaceHost.getSnapshot(IDENTITY)!.generation,
      title: "",
    }));
    await flushSurfaceFrame();

    expect(screen.getByTestId("surface-title-web-preview")).toHaveTextContent("");
    expect(commits).toEqual(["mount"]);
    view.unmount();
  });

  it("publishes changed surface state at most once per frame", async () => {
    browserSurfaceHost.create(IDENTITY, { address: "https://example.test/profiler-frame" });
    await flushSurfaceFrame();
    const commits: Parameters<ProfilerOnRenderCallback>[1][] = [];
    const view = render(
      <Profiler id="observed-surface" onRender={(_id, phase) => commits.push(phase)}>
        <SurfaceSnapshotProbe identity={IDENTITY} />
      </Profiler>,
    );
    const generation = browserSurfaceHost.getSnapshot(IDENTITY)!.generation;

    act(() => {
      browserSurfaceHost.handleEvent({ type: "title-updated", identity: IDENTITY, generation, title: "A" });
      browserSurfaceHost.handleEvent({ type: "title-updated", identity: IDENTITY, generation, title: "B" });
    });
    await flushSurfaceFrame();
    const firstFrameCommits = commits.length - 1;
    expect(screen.getByTestId("surface-title-web-preview")).toHaveTextContent("B");

    act(() => browserSurfaceHost.handleEvent({ type: "title-updated", identity: IDENTITY, generation, title: "C" }));
    await flushSurfaceFrame();
    const secondFrameCommits = commits.length - 1 - firstFrameCommits;

    expect(screen.getByTestId("surface-title-web-preview")).toHaveTextContent("C");
    expect(firstFrameCommits).toBe(1);
    expect(secondFrameCommits).toBe(1);
    view.unmount();
  });

  it("does not commit the observed identity for an unrelated complete surface identity", async () => {
    browserSurfaceHost.create(IDENTITY, { address: "https://example.test/profiler-observed" });
    browserSurfaceHost.create(UNRELATED_IDENTITY, { address: "https://example.test/profiler-unrelated" });
    await flushSurfaceFrame();
    const commits: Parameters<ProfilerOnRenderCallback>[1][] = [];
    const view = render(
      <Profiler id="observed-surface" onRender={(_id, phase) => commits.push(phase)}>
        <SurfaceSnapshotProbe identity={IDENTITY} />
      </Profiler>,
    );
    const generation = browserSurfaceHost.getSnapshot(UNRELATED_IDENTITY)!.generation;

    act(() => browserSurfaceHost.handleEvent({
      type: "title-updated",
      identity: UNRELATED_IDENTITY,
      generation,
      title: "Unrelated surface",
    }));
    await flushSurfaceFrame();

    expect(screen.getByTestId("surface-title-web-preview")).toHaveTextContent("");
    expect(commits).toEqual(["mount"]);
    view.unmount();
  });

  it("applies controller and operation protection when their surface materializes later", () => {
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-1", "web-preview");
    useBrowserAutomationStore.getState().setControllerForTarget(
      "workspace-1",
      "thread-1",
      "web-preview",
      { tabId: "web-preview", controller: "agent", controlEpoch: 1 },
    );
    useBrowserAutomationStore.setState({
      activeRequests: new Map([[
        "request-1:1",
        {
          dispatch: {
            scope: { workspaceId: "workspace-1" },
            target: { threadId: "thread-1", tabId: "web-preview" },
            request: { requestId: "request-1", sequence: 1, operation: "navigate", args: {} },
          },
          startedAt: 1,
        } as never,
      ]]),
    });
    const view = render(<BrowserSurfaceHostRoot />);
    const first = browserSurfaceHost.create(IDENTITY);

    expect(browserSurfaceHost.discard(IDENTITY, first.generation)).toBe(false);
    act(() => {
      useBrowserAutomationStore.getState().setControllerForTarget(
        "workspace-1",
        "thread-1",
        "web-preview",
        { tabId: "web-preview", controller: "none", controlEpoch: 1 },
      );
    });
    expect(browserSurfaceHost.discard(IDENTITY, first.generation)).toBe(false);

    act(() => useBrowserAutomationStore.setState({ activeRequests: new Map() }));
    expect(browserSurfaceHost.discard(IDENTITY, first.generation)).toBe(true);
    view.unmount();
  });

  it("re-warms and pins a cold surface when an operation starts", () => {
    const view = render(<BrowserSurfaceHostRoot />);
    const first = browserSurfaceHost.create(IDENTITY, { address: "https://example.test/recovery" });
    expect(browserSurfaceHost.discard(IDENTITY, first.generation)).toBe(true);

    act(() => useBrowserAutomationStore.setState({
      activeRequests: new Map([[
        "request-cold:1",
        {
          dispatch: {
            scope: { workspaceId: "workspace-1" },
            target: { threadId: "thread-1", tabId: "web-preview" },
            request: { requestId: "request-cold", sequence: 1, operation: "navigate", args: {} },
          },
          startedAt: 1,
        } as never,
      ]]),
    }));

    const rewarmed = browserSurfaceHost.getSnapshot(IDENTITY);
    expect(rewarmed?.generation).toBe(first.generation + 1);
    expect(browserSurfaceHost.discard(IDENTITY, rewarmed?.generation)).toBe(false);
    act(() => useBrowserAutomationStore.setState({ activeRequests: new Map() }));
    expect(browserSurfaceHost.discard(IDENTITY, rewarmed?.generation)).toBe(true);
    view.unmount();
  });

  it("keeps the host for cancelled or cached unloads and disposes on committed pagehide", () => {
    const view = render(<BrowserSurfaceHostRoot />);
    const first = browserSurfaceHost.create(IDENTITY);

    act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBe(first);

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBe(first);

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    expect(browserSurfaceHost.getSnapshot(IDENTITY)).toBeNull();
    view.unmount();
  });

  it("disposes a surface when canonical tab membership removes it", () => {
    const view = render(<BrowserSurfaceHostRoot />);
    browserSurfaceHost.create(IDENTITY);
    usePreviewTabsStore.getState().setTabSet("workspace-1", "thread-1", {
      threadId: "thread-1",
      activeTabId: "web-preview",
      tabs: [{
        id: "web-preview",
        threadId: "thread-1",
        title: null,
        url: null,
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    });

    act(() => usePreviewTabsStore.getState().setTabSet("workspace-1", "thread-1", null));

    expect(browserSurfaceHost.inspect(IDENTITY)).toBeNull();
    view.unmount();
  });

  it("mounts a hosted iframe outside the panel tree", () => {
    render(<BrowserSurfaceHostRoot />);

    browserSurfaceHost.create(IDENTITY, {
      address: `${window.location.origin}/browser-automation-fixture.html`,
    });

    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe.parentElement).toHaveAttribute("data-browser-surface-host");
    expect(iframe).toHaveAttribute("data-workspace-id", "workspace-1");
    expect(iframe).toHaveAttribute("data-scope-kind", "thread");
    expect(iframe).toHaveAttribute("data-scope-id", "thread-1");
    expect(iframe).toHaveAttribute("data-tab-id", "web-preview");
  });

  it("opens current human popups in front and agent popups in the background", () => {
    let onPopupRequested: ((request: PreviewPopupRequest) => void) | null = null;
    const stopPopupRequests = vi.fn();
    browserSurfaceHost.create(IDENTITY, { generation: 7 });
    window.desktopBridge = {
      preview: {
        surface: {
          onPopupRequested: vi.fn((listener: (request: PreviewPopupRequest) => void) => {
            onPopupRequested = listener;
            return stopPopupRequests;
          }),
          onDiscardRequested: vi.fn(() => () => undefined),
        },
      },
    } as never;
    const openPage = vi.fn(async () => "popup-tab");
    usePreviewTabsStore.setState({ openPage });
    const view = render(<BrowserSurfaceHostRoot />);

    const request = {
      sourceSurface: { identity: IDENTITY, generation: 7 },
      address: "https://popup.example.test/next",
      initiator: "human" as const,
    };
    act(() => onPopupRequested?.(request));
    expect(openPage).toHaveBeenLastCalledWith("workspace-1", "thread-1", {
      activate: true,
      focusOmnibox: false,
      initialAddress: request.address,
    });

    act(() => onPopupRequested?.({ ...request, initiator: "agent" }));
    expect(openPage).toHaveBeenLastCalledWith("workspace-1", "thread-1", {
      activate: false,
      focusOmnibox: false,
      initialAddress: request.address,
    });

    openPage.mockClear();
    act(() => onPopupRequested?.({
      ...request,
      sourceSurface: { ...request.sourceSurface, generation: 6 },
    }));
    expect(openPage).not.toHaveBeenCalled();

    view.unmount();
    expect(stopPopupRequests).toHaveBeenCalledTimes(1);
  });
});
