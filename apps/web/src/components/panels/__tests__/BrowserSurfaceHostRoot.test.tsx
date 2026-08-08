import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSurfaceHostRoot,
  browserSurfaceHost,
} from "../BrowserSurfaceHostRoot";
import type { BrowserSurfaceIdentity } from "@/services/browser-surfaces";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import { useBrowserAutomationStore } from "@/stores/browserAutomationStore";
import type { PreviewPopupRequest, PreviewSurfaceRef } from "@/transport/desktop-bridge";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "web-preview",
};

describe("BrowserSurfaceHostRoot", () => {
  const originalOpenPage = usePreviewTabsStore.getState().openPage;

  afterEach(() => {
    browserSurfaceHost.dispose(IDENTITY);
    usePreviewTabsStore.setState({
      openPage: originalOpenPage,
      tabSetByScope: {},
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });
    useBrowserAutomationStore.getState().releaseWorkspaceTargets("workspace-1");
    delete window.desktopBridge;
  });

  it("discards only the exact current generation selected by Memory Saver", () => {
    let onDiscardRequested: ((request: PreviewSurfaceRef) => void) | null = null;
    const stopDiscardRequests = vi.fn();
    const first = browserSurfaceHost.create(IDENTITY, {
      generation: 7,
      address: "https://example.test/recovery",
    });
    window.desktopBridge = {
      preview: {
        surface: {
          onPopupRequested: vi.fn(() => () => undefined),
          onDiscardRequested: vi.fn((listener: (request: PreviewSurfaceRef) => void) => {
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
      renderingHost: "webview",
    });

    act(() => onPopupRequested?.({ ...request, initiator: "agent" }));
    expect(openPage).toHaveBeenLastCalledWith("workspace-1", "thread-1", {
      activate: false,
      focusOmnibox: false,
      initialAddress: request.address,
      renderingHost: "webview",
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
