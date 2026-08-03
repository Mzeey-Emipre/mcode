import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { PreviewWebview, type PreviewWebviewHandle } from "../PreviewWebview";
import {
  onBrowserAutomationObservationInvalidation,
} from "@/stores/browserAutomationStore";

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

  it("notifies only for the trusted guest input channel", () => {
    const humanInput = vi.fn();
    const unsubscribe = onBrowserAutomationObservationInvalidation(humanInput);
    window.desktopBridge = {
      preview: {},
    } as unknown as NonNullable<typeof window.desktopBridge>;
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
    expect(humanInput).toHaveBeenCalledOnce();
    expect(humanInput).toHaveBeenCalledWith("thread-1", "tab-1");
    unsubscribe();
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
