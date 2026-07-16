import { act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerLayoutGuard } from "../useComposerLayoutGuard";
import { useUiStore } from "@/stores/uiStore";

let resizeCallback: ResizeObserverCallback | null = null;
let frameCallback: FrameRequestCallback | null = null;

class ResizeObserverMock implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function LayoutHarness({
  outerWidth,
  contentWidth,
  showPullRequests = true,
  showLanding = true,
  activeWorkspaceId = null,
}: {
  outerWidth: number;
  contentWidth: number;
  showPullRequests?: boolean;
  showLanding?: boolean;
  activeWorkspaceId?: string | null;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  if (!outerRef.current) outerRef.current = document.createElement("div");
  if (!contentRef.current) contentRef.current = document.createElement("div");
  Object.defineProperty(outerRef.current, "clientWidth", {
    configurable: true,
    value: outerWidth,
  });
  Object.defineProperty(contentRef.current, "clientWidth", {
    configurable: true,
    value: contentWidth,
  });

  useComposerLayoutGuard(outerRef, contentRef, {
    settingsOpen: false,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId: null,
  });
  return null;
}

function triggerResize(): void {
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
    const callback = frameCallback;
    frameCallback = null;
    callback?.(0);
  });
}

describe("useComposerLayoutGuard responsive sidebar", () => {
  beforeEach(() => {
    resizeCallback = null;
    frameCallback = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useUiStore.setState({
      primarySurface: "pullRequests",
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: false,
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("floats a docked sidebar at narrow widths and restores it inline when room returns", async () => {
    const view = render(<LayoutHarness outerWidth={420} contentWidth={188} />);

    await waitFor(() =>
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: false,
        sidebarCollapsedByLayout: false,
        sidebarFloating: true,
      }),
    );

    view.rerender(<LayoutHarness outerWidth={1_440} contentWidth={1_440} />);
    triggerResize();

    await waitFor(() =>
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: false,
        sidebarCollapsedByLayout: false,
        sidebarFloating: false,
      }),
    );
  });

  it("does not restore a sidebar the user collapsed", () => {
    useUiStore.setState({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: false,
      sidebarFloating: false,
    });

    render(<LayoutHarness outerWidth={1_440} contentWidth={1_440} />);

    expect(useUiStore.getState()).toMatchObject({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: false,
    });
  });

  it("floats the open sidebar when a new-thread canvas becomes narrow", async () => {
    render(
      <LayoutHarness
        outerWidth={420}
        contentWidth={188}
        showPullRequests={false}
        showLanding={false}
        activeWorkspaceId="workspace-1"
      />,
    );

    await waitFor(() =>
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: false,
        sidebarCollapsedByLayout: false,
        sidebarFloating: true,
      }),
    );
  });

  it("floats the open sidebar when the projectless landing canvas becomes narrow", async () => {
    render(
      <LayoutHarness
        outerWidth={420}
        contentWidth={188}
        showPullRequests={false}
      />,
    );

    await waitFor(() =>
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: false,
        sidebarCollapsedByLayout: false,
        sidebarFloating: true,
      }),
    );
    expect(resizeCallback).not.toBeNull();
  });
});
