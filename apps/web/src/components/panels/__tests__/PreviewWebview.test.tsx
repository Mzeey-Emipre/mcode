import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  browserAutomationTargetKey,
  onBrowserAutomationObservationInvalidation,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "@/stores/browserAutomationStore";
import { PreviewWebview, type PreviewWebviewHandle } from "../PreviewWebview";

describe("PreviewWebview", () => {
  let canGoBack: Mock<() => boolean>;
  let canGoForward: Mock<() => boolean>;
  let domReady = false;
  const prototype = HTMLElement.prototype as HTMLElement & {
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
  };
  const originalCanGoBack = prototype.canGoBack;
  const originalCanGoForward = prototype.canGoForward;

  beforeEach(() => {
    domReady = false;
    canGoBack = vi.fn(() => {
      if (!domReady) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return true;
    });
    canGoForward = vi.fn(() => {
      if (!domReady) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return false;
    });
    prototype.canGoBack = canGoBack;
    prototype.canGoForward = canGoForward;
  });

  afterEach(() => {
    prototype.canGoBack = originalCanGoBack;
    prototype.canGoForward = originalCanGoForward;
    delete window.desktopBridge;
  });

  it("invalidates exact tab observations only for the trusted guest input channel", () => {
    const invalidate = vi.fn();
    window.desktopBridge = {
      preview: {},
    } as unknown as NonNullable<typeof window.desktopBridge>;
    const unsubscribe = onBrowserAutomationObservationInvalidation(invalidate);
    render(
      <PreviewWebview
        workspaceId="workspace-1"
        threadId="thread-1"
        tabId="tab-1"
        src="https://example.com"
      />,
    );
    const webview = screen.getByTestId("preview-webview");
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "pointer" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "synthetic" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "focus" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "untrusted-channel",
      args: [{ kind: "pointer" }],
    }));
    unsubscribe();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith("thread-1", "tab-1");
  });

  it("does not call Electron navigation methods before dom-ready", async () => {
    const observed: { handle: PreviewWebviewHandle | null } = { handle: null };
    window.desktopBridge = { preview: {} } as unknown as NonNullable<typeof window.desktopBridge>;

    function Probe() {
      const ref = useRef<PreviewWebviewHandle>(null);
      useEffect(() => {
        observed.handle = ref.current;
        ref.current?.canGoBack();
        ref.current?.canGoForward();
      }, []);
      return (
        <PreviewWebview
          ref={ref}
          threadId="thread-1"
          tabId="tab-1"
          src="https://example.com"
        />
      );
    }

    render(<Probe />);

    await waitFor(() => expect(observed.handle).not.toBeNull());
    expect(observed.handle?.canGoBack()).toBe(false);
    expect(observed.handle?.canGoForward()).toBe(false);
    expect(canGoBack).not.toHaveBeenCalled();
    expect(canGoForward).not.toHaveBeenCalled();

    domReady = true;
    screen.getByTestId("preview-webview").dispatchEvent(new Event("dom-ready"));

    expect(observed.handle?.canGoBack()).toBe(true);
    expect(observed.handle?.canGoForward()).toBe(false);
    expect(canGoBack).toHaveBeenCalled();
    expect(canGoForward).toHaveBeenCalled();
  });

  it("advances the viewport coordinator when dom-ready refreshes the target", async () => {
    const getWebContentsId = vi.fn(() => 42);
    const originalGetWebContentsId = (
      HTMLElement.prototype as HTMLElement & { getWebContentsId?: () => number }
    ).getWebContentsId;
    (
      HTMLElement.prototype as HTMLElement & { getWebContentsId?: () => number }
    ).getWebContentsId = getWebContentsId;
    window.desktopBridge = {
      preview: {
        adoptWebview: vi.fn().mockResolvedValue({ ok: true }),
        releaseWebview: vi.fn().mockResolvedValue(undefined),
        design: {},
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;

    try {
      render(
        <PreviewWebview
          workspaceId="workspace-generation"
          threadId="thread-generation"
          tabId="tab-generation"
          src="https://example.com"
        />,
      );
      const key = browserAutomationTargetKey("thread-generation", "tab-generation");
      await waitFor(() => {
        expect(useBrowserAutomationStore.getState().viewportCoordinators.get(key)).toBeDefined();
      });

      fireEvent(screen.getByTestId("preview-webview"), new Event("dom-ready"));

      await waitFor(() => {
        const store = useBrowserAutomationStore.getState();
        expect(store.viewportCoordinators.get(key)?.snapshot().targetGeneration).toBe(
          store.liveTargets.get(key)?.revision,
        );
        expect(store.liveTargets.get(key)?.revision).toBe(2);
      });
    } finally {
      releaseBrowserAutomationThreadScope("thread-generation");
      (
        HTMLElement.prototype as HTMLElement & { getWebContentsId?: () => number }
      ).getWebContentsId = originalGetWebContentsId;
    }
  });

  it("keeps native event subscriptions stable when parent callbacks change", () => {
    window.desktopBridge = { preview: {} } as unknown as NonNullable<typeof window.desktopBridge>;
    const addEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const firstStatus = vi.fn();
    const secondStatus = vi.fn();
    const { rerender } = render(
      <PreviewWebview
        threadId="thread-stable"
        tabId="tab-stable"
        src="https://example.com"
        onPageStatus={firstStatus}
      />,
    );
    const initialStopSubscriptions = addEventListener.mock.calls.filter(
      ([eventName]) => eventName === "did-stop-loading",
    ).length;

    rerender(
      <PreviewWebview
        threadId="thread-stable"
        tabId="tab-stable"
        src="https://example.com"
        onPageStatus={secondStatus}
      />,
    );
    screen.getByTestId("preview-webview").dispatchEvent(new Event("did-stop-loading"));

    expect(addEventListener.mock.calls.filter(
      ([eventName]) => eventName === "did-stop-loading",
    )).toHaveLength(initialStopSubscriptions);
    expect(firstStatus).not.toHaveBeenCalled();
    expect(secondStatus).toHaveBeenCalledOnce();
  });

  it("applies an exact renderer-owned design viewport to the visible webview", () => {
    render(
      <PreviewWebview
        threadId="thread-1"
        tabId="tab-1"
        src="https://example.com"
        viewport={{ width: 1024, height: 768 }}
      />,
    );
    expect(screen.getByTestId("preview-webview")).toHaveStyle({
      width: "1024px",
      height: "768px",
    });
  });
});
