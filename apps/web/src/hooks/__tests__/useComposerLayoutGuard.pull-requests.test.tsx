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
}: {
  outerWidth: number;
  contentWidth: number;
  showPullRequests?: boolean;
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
    showLanding: true,
    showPullRequests,
    activeWorkspaceId: null,
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

describe("useComposerLayoutGuard Pull requests layout", () => {
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

  it("collapses a docked sidebar at narrow widths and restores it when room returns", async () => {
    const view = render(<LayoutHarness outerWidth={420} contentWidth={188} />);

    await waitFor(() =>
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: true,
        sidebarCollapsedByLayout: true,
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

  it("preserves the existing landing guard outside Pull requests", () => {
    render(
      <LayoutHarness
        outerWidth={420}
        contentWidth={188}
        showPullRequests={false}
      />,
    );

    expect(useUiStore.getState()).toMatchObject({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
    });
    expect(resizeCallback).toBeNull();
  });
});
