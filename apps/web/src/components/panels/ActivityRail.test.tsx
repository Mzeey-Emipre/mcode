import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabSet } from "@mcode/contracts";
import type { RightPanelTab } from "@/stores/diffStore";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";
import { ActivityRail } from "./ActivityRail";

const EXPECTED_EXPAND_DELAY_MS = 140;
const EXPECTED_COLLAPSE_DELAY_MS = 250;

const browserTabSet: BrowserTabSet = {
  threadId: "thread-activity-rail",
  activeTabId: "browser-page",
  tabs: [
    {
      id: "browser-page",
      url: "https://example.com",
      title: "Example",
      faviconUrl: null,
      active: true,
      threadId: "thread-activity-rail",
      warm: true,
    },
  ],
};

const handlers = {
  onTogglePanel: vi.fn(),
  onToggleMaximized: vi.fn(),
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onCreate: vi.fn(),
  onSelectBrowserPage: vi.fn(),
  onCloseBrowserPage: vi.fn(),
};

function railElement(openTabs: readonly RightPanelTab[] = ["terminal", "changes"]) {
  return (
    <ActivityRail
      openTabs={openTabs}
      activeTab="terminal"
      scope="thread"
      scopeProgress={{ done: 0, total: 0 }}
      changesCount={3}
      changesFresh={false}
      browserTabSet={null}
      maximized={false}
      {...handlers}
    />
  );
}

function renderRail() {
  return render(
    railElement(),
  );
}

describe("ActivityRail expansion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePreviewSuppressionStore.setState({ count: 0 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses hover intent to expand and a grace period to collapse", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS - 1));
    expect(rail).toHaveAttribute("data-expanded", "false");

    act(() => vi.advanceTimersByTime(1));
    expect(rail).toHaveAttribute("data-expanded", "true");
    expect(usePreviewSuppressionStore.getState().count).toBe(1);

    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS - 1));
    expect(rail).toHaveAttribute("data-expanded", "true");

    act(() => vi.advanceTimersByTime(1));
    expect(rail).toHaveAttribute("data-expanded", "false");
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });

  it("keeps a fixed collapsed footprint above right-panel content", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    expect(rail).toHaveClass("z-30", "w-12", "flex-none");
    expect(rail.firstElementChild).toHaveClass("absolute", "w-12");

    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(rail.firstElementChild).toHaveClass("w-40");
    expect(rail).toHaveClass("w-12");
  });

  it("anchors tab, Browser-page, and maximize controls to the same trailing edge", () => {
    const { rerender } = renderRail();
    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.getByRole("button", { name: "Close Terminal" })).toHaveClass(
      "absolute",
      "left-[7.75rem]",
      "top-0",
    );
    expect(screen.getByTestId("rail-maximize-toggle")).toHaveClass(
      "absolute",
      "left-[7.75rem]",
      "top-0",
    );

    rerender(
      <ActivityRail
        openTabs={["preview"]}
        activeTab="preview"
        scope="thread"
        scopeProgress={{ done: 0, total: 0 }}
        changesCount={0}
        changesFresh={false}
        browserTabSet={browserTabSet}
        maximized={false}
        {...handlers}
      />,
    );

    expect(screen.getByRole("button", { name: "Close page Example" })).toHaveClass(
      "absolute",
      "left-[7.75rem]",
      "top-0",
    );
  });

  it("cancels expansion when the pointer only crosses the rail", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS - 1));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("expands immediately when a rail control receives keyboard focus", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("keeps close and maximize as independent panel actions", () => {
    const { rerender } = renderRail();

    fireEvent.focus(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));

    expect(handlers.onTogglePanel).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMaximized).toHaveBeenCalledTimes(1);

    rerender(
      <ActivityRail
        openTabs={["terminal", "changes"]}
        activeTab="terminal"
        scope="thread"
        scopeProgress={{ done: 0, total: 0 }}
        changesCount={3}
        changesFresh={false}
        browserTabSet={null}
        maximized
        {...handlers}
      />,
    );

    expect(screen.getByRole("button", { name: "Restore panel" })).toBeInTheDocument();
  });

  it("collapses after a focused rail control is removed", () => {
    const { rerender } = render(railElement(["terminal"]));
    const rail = screen.getByTestId("activity-rail");

    fireEvent.focus(screen.getByRole("button", { name: "Close Terminal" }));
    expect(rail).toHaveAttribute("data-expanded", "true");

    rerender(railElement([]));
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));

    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("releases preview suppression when an expanded rail unmounts", () => {
    const { unmount } = renderRail();
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(usePreviewSuppressionStore.getState().count).toBe(1);

    unmount();

    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });
});
