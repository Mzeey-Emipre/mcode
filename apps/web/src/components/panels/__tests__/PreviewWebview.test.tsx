import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserAutomationTargetKey,
  onBrowserAutomationObservationInvalidation,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "@/stores/browserAutomationStore";
import { PreviewWebview, type PreviewWebviewHandle } from "../PreviewWebview";

describe("PreviewWebview", () => {
  beforeEach(() => {
    document.querySelectorAll("[data-testid='electron-browser-surface-webview'], [data-testid='web-runtime-preview-iframe']")
      .forEach((element) => element.remove());
  });

  afterEach(() => {
    delete window.desktopBridge;
  });

  it("invalidates exact tab observations only for the trusted guest input channel", () => {
    const invalidate = vi.fn();
    window.desktopBridge = {
      preview: {
        surface: {
          prepare: vi.fn().mockResolvedValue({ ok: true }),
          adopt: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
          release: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
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
    const webview = screen.getByTestId("electron-browser-surface-webview");
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

  it("routes history through the exact generation-bound main bridge", async () => {
    const observed: { handle: PreviewWebviewHandle | null } = { handle: null };
    const navigate = vi.fn().mockResolvedValue({ ok: true });
    window.desktopBridge = { preview: { surface: {
      prepare: vi.fn().mockResolvedValue({ ok: true }),
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate,
      release: vi.fn().mockResolvedValue({ ok: true }),
    } } } as unknown as NonNullable<typeof window.desktopBridge>;

    function Probe() {
      const ref = useRef<PreviewWebviewHandle>(null);
      useEffect(() => {
        observed.handle = ref.current;
        ref.current?.goBack();
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
    expect(navigate).toHaveBeenCalledWith({
      surface: {
        identity: {
          workspaceId: "thread-1",
          scope: { kind: "thread", id: "thread-1" },
          tabId: "tab-1",
        },
        generation: expect.any(Number),
      },
      navigation: { kind: "back" },
    });
  });

  it("binds the viewport coordinator to the hosted target generation", async () => {
    window.desktopBridge = { preview: { surface: {
      prepare: vi.fn().mockResolvedValue({ ok: true }),
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      release: vi.fn().mockResolvedValue({ ok: true }),
    }, design: {} } } as unknown as NonNullable<typeof window.desktopBridge>;

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

      await waitFor(() => {
        const store = useBrowserAutomationStore.getState();
        expect(store.viewportCoordinators.get(key)?.snapshot().targetGeneration).toBe(
          store.liveTargets.get(key)?.revision,
        );
        expect(store.liveTargets.get(key)?.revision).toBe(1);
      });
    } finally {
      releaseBrowserAutomationThreadScope("thread-generation");
    }
  });

  it("advances the Electron surface generation when the same target remounts", () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    window.desktopBridge = { preview: { surface: {
      prepare,
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      release: vi.fn().mockResolvedValue({ ok: true }),
    } } } as unknown as NonNullable<typeof window.desktopBridge>;
    const props = {
      workspaceId: "workspace-remount",
      threadId: "thread-remount",
      tabId: "tab-remount",
      src: "about:blank",
    };

    const first = render(<PreviewWebview {...props} />);
    const firstGeneration = prepare.mock.calls[0]?.[0].surface.generation as number;
    first.unmount();
    render(<PreviewWebview {...props} />);
    const secondGeneration = prepare.mock.calls[1]?.[0].surface.generation as number;

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
  });

  it("keeps native event subscriptions stable when parent callbacks change", async () => {
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
    firstStatus.mockClear();
    screen.getByTestId("web-runtime-preview-iframe").dispatchEvent(new Event("load"));

    expect(addEventListener.mock.calls.filter(
      ([eventName]) => eventName === "did-stop-loading",
    )).toHaveLength(initialStopSubscriptions);
    expect(firstStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(secondStatus).toHaveBeenCalled());
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
