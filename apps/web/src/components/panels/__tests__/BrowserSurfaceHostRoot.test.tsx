import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSurfaceHostRoot,
  browserSurfaceHost,
} from "../BrowserSurfaceHostRoot";
import type { BrowserSurfaceIdentity } from "@/services/browser-surfaces";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import type { PreviewPopupRequest } from "@/transport/desktop-bridge";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "web-preview",
};

describe("BrowserSurfaceHostRoot", () => {
  const originalOpenPage = usePreviewTabsStore.getState().openPage;

  afterEach(() => {
    browserSurfaceHost.dispose(IDENTITY);
    usePreviewTabsStore.setState({ openPage: originalOpenPage });
    delete window.desktopBridge;
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
