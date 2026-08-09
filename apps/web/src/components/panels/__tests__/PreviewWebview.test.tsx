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
import { browserSurfaceHost } from "../BrowserSurfaceHostRoot";

describe("PreviewWebview", () => {
  beforeEach(() => {
    document.querySelectorAll("[data-testid='electron-browser-surface-webview'], [data-testid='web-runtime-preview-iframe']")
      .forEach((element) => element.remove());
  });

  afterEach(() => {
    browserSurfaceHost.disposeAll();
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
    expect(invalidate).toHaveBeenCalledWith("workspace-1", "thread-1", "tab-1");
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
      const key = browserAutomationTargetKey("workspace-generation", "thread-generation", "tab-generation");
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
      releaseBrowserAutomationThreadScope("workspace-generation", "thread-generation");
    }
  });

  it("preserves the Electron guest and generation when presentation remounts", () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    const release = vi.fn().mockResolvedValue({ ok: true });
    window.desktopBridge = { preview: { surface: {
      prepare,
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      release,
    } } } as unknown as NonNullable<typeof window.desktopBridge>;
    const props = {
      workspaceId: "workspace-remount",
      threadId: "thread-remount",
      tabId: "tab-remount",
      src: "about:blank",
    };

    const first = render(<PreviewWebview {...props} />);
    const firstGeneration = prepare.mock.calls[0]?.[0].surface.generation as number;
    const firstGuest = screen.getByTestId("electron-browser-surface-webview");
    const targetKey = browserAutomationTargetKey(props.workspaceId, props.threadId, props.tabId);
    const firstTargetGeneration = useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision;
    first.unmount();
    expect(useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision).toBe(
      firstTargetGeneration,
    );
    render(<PreviewWebview {...props} />);
    const snapshot = browserSurfaceHost.getSnapshot({
      workspaceId: props.workspaceId,
      scope: { kind: "thread", id: props.threadId },
      tabId: props.tabId,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(screen.getByTestId("electron-browser-surface-webview")).toBe(firstGuest);
    expect(snapshot?.generation).toBe(firstGeneration);
    expect(useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision).toBe(
      firstTargetGeneration,
    );
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

  it("hides a warm inactive surface and presents it when selected", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const { rerender } = render(
      <PreviewWebview
        active={false}
        threadId="thread-switch"
        tabId="tab-switch"
        src="https://example.com"
      />,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    expect(surface).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });

    rerender(
      <PreviewWebview
        active
        threadId="thread-switch"
        tabId="tab-switch"
        src="https://example.com"
      />,
    );

    expect(surface).toHaveStyle({
      left: "10px",
      top: "20px",
      width: "640px",
      height: "480px",
      visibility: "visible",
      pointerEvents: "auto",
    });
    rect.mockRestore();
  });

  it("clips the covered edge without changing the Browser viewport geometry", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const { rerender } = render(
      <PreviewWebview
        coveredLeft={112}
        threadId="thread-covered"
        tabId="tab-covered"
        src="https://example.com"
      />,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");

    expect(surface).toHaveStyle({
      left: "10px",
      width: "640px",
      clipPath: "inset(0px 0px 0px 112px)",
    });

    rerender(
      <PreviewWebview
        coveredLeft={0}
        threadId="thread-covered"
        tabId="tab-covered"
        src="https://example.com"
      />,
    );
    expect(surface.style.clipPath).toBe("");
    rect.mockRestore();
  });

  it("presents an active automation surface inside its dedicated hidden host", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(-20_000, 0, 1280, 720),
    );
    const { rerender } = render(
      <div aria-hidden="true" inert>
        <PreviewWebview
          threadId="thread-background"
          tabId="tab-background"
          src="https://example.com"
        />
      </div>,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    expect(surface).toHaveStyle({ visibility: "hidden", width: "1px", height: "1px" });

    rerender(
      <div aria-hidden="true" inert>
        <PreviewWebview
          allowHiddenPresentation
          threadId="thread-background"
          tabId="tab-background"
          src="https://example.com"
        />
      </div>,
    );

    expect(surface).toHaveStyle({
      left: "-20000px",
      width: "1280px",
      height: "720px",
      visibility: "visible",
    });
    rect.mockRestore();
  });
});
