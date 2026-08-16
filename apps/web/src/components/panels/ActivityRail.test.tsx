import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabSet } from "@mcode/contracts";
import { rightPanelSingletonId, type RightPanelTab } from "@/stores/diffStore";
import {
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "@/features/preview";
import { ActivityRail } from "./ActivityRail";

const EXPECTED_EXPAND_DELAY_MS = 140;
const EXPECTED_COLLAPSE_DELAY_MS = 250;
const workspaceId = "workspace-1";

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
  onReorder: vi.fn(),
  onCreate: vi.fn(),
  onSelectBrowserPage: vi.fn(),
  onCloseBrowserPage: vi.fn(),
};

function railElement(openTabs: readonly RightPanelTab[] = ["terminal", "changes"]) {
  return (
    <ActivityRail
      tabInstances={openTabs.map((type) => ({ id: rightPanelSingletonId(type), type }))}
      workspaceId={workspaceId}
      activeTabId={rightPanelSingletonId("terminal")}
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
    useBrowserAutomationStore.setState({ controllers: new Map(), pendingAgentOpens: new Map() });
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
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS - 1));
    expect(rail).toHaveAttribute("data-expanded", "true");

    act(() => vi.advanceTimersByTime(1));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("publishes expansion changes for Browser surface coverage", () => {
    const onExpandedChange = vi.fn();
    render(
      <ActivityRail
        {...railElement().props}
        onExpandedChange={onExpandedChange}
      />,
    );
    const rail = screen.getByTestId("activity-rail");

    fireEvent.pointerEnter(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps a fixed collapsed footprint above right-panel content", () => {
    renderRail();
    const rail = screen.getByTestId("activity-rail");

    expect(rail).toHaveClass("z-30", "w-12", "flex-none");
    expect(rail.firstElementChild).toHaveClass("absolute", "w-full");

    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(rail.firstElementChild).toHaveClass("w-full");
    expect(rail).toHaveClass("w-40", "-mr-28");
  });

  it("anchors trailing controls right and reserves their label space", () => {
    const { rerender } = renderRail();
    fireEvent.focus(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.getByRole("button", { name: "Close Terminal" })).toHaveClass(
      "absolute",
      "right-0",
      "top-0",
    );
    expect(screen.getByTestId("rail-maximize-toggle")).toHaveClass(
      "absolute",
      "right-0",
      "top-0",
    );
    expect(screen.getByRole("button", { name: "Terminal" }).querySelector("span")).toHaveClass(
      "left-8",
      "right-8",
    );
    expect(screen.getByTestId("rail-panel-toggle").querySelector("span")).toHaveClass(
      "left-8",
      "right-8",
    );

    rerender(
      <ActivityRail
        tabInstances={[{ id: rightPanelSingletonId("preview"), type: "preview" }]}
        workspaceId={workspaceId}
        activeTabId={rightPanelSingletonId("preview")}
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
      "right-0",
      "top-0",
    );
    expect(screen.getByRole("button", { name: "Browser page: Example" }).querySelector("span")).toHaveClass(
      "left-8",
      "right-8",
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
        tabInstances={["terminal", "changes"].map((type) => ({
          id: rightPanelSingletonId(type as RightPanelTab),
          type: type as RightPanelTab,
        }))}
        workspaceId={workspaceId}
        activeTabId={rightPanelSingletonId("terminal")}
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

  it("gives the expanded rail a real hit-test box over the renderer guest seam", () => {
    const guestPointerDown = vi.fn();
    render(
      <div
        data-testid="preview-compositing-root"
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <div
          data-testid="renderer-guest"
          className="absolute inset-0 z-0"
          onPointerDown={guestPointerDown}
        />
        <div
          data-testid="browser-automation-overlay"
          className="pointer-events-none absolute inset-0 z-20"
        />
        <span
          data-testid="browser-automation-pointer"
          className="pointer-events-none absolute z-30"
        />
        {railElement()}
      </div>,
    );

    const rail = screen.getByTestId("activity-rail");
    const railOverlay = rail.firstElementChild;
    const guest = screen.getByTestId("renderer-guest");
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(rail).toHaveClass("w-12");
    expect(rail).not.toHaveClass("-mr-28");

    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => {
        const expanded = rail.classList.contains("w-40");
        if (expanded && x < 160) return terminal;
        if (x >= 48) return guest;
        return rail;
      },
    });

    try {
      fireEvent.pointerEnter(rail, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(EXPECTED_EXPAND_DELAY_MS));

      expect(rail).toHaveAttribute("data-expanded", "true");
      expect(rail).toHaveClass("w-40", "-mr-28", "z-30");
      expect(railOverlay).toHaveClass("absolute", "w-full");
      expect(document.elementFromPoint(100, 200)).toBe(terminal);
      expect(document.elementFromPoint(300, 200)).toBe(guest);
      expect(guest).toBeVisible();
      expect(guest).not.toHaveClass("invisible", "pointer-events-none");

      fireEvent.click(terminal);
      expect(handlers.onSelect).toHaveBeenCalledWith(rightPanelSingletonId("terminal"));
      fireEvent.pointerDown(guest, { clientX: 300, clientY: 200 });
      expect(guestPointerDown).toHaveBeenCalledTimes(1);

      fireEvent.pointerLeave(rail, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(EXPECTED_COLLAPSE_DELAY_MS));
      expect(rail).toHaveAttribute("data-expanded", "false");
      expect(rail).toHaveClass("w-12");
      expect(rail).not.toHaveClass("-mr-28");
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it("uses the amber pointer favicon and accessible name for an agent-controlled page", () => {
    const page = browserTabSet.tabs[0]!;
    useBrowserAutomationStore.setState({
      controllers: new Map([
        [
          browserAutomationTargetKey(workspaceId, page.threadId, page.id),
          { tabId: page.id, controller: "agent", controlEpoch: 1 },
        ],
      ]),
    });

    render(
      <ActivityRail
        {...railElement(["preview"]).props}
        browserTabSet={browserTabSet}
      />,
    );

    expect(screen.getByTestId("browser-agent-control-indicator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser page: Example, agent controls Browser" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("uses the amber pointer while an agent-created page is still opening", () => {
    const page = browserTabSet.tabs[0]!;
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-open",
          {
            workspaceId: "workspace-1",
            threadId: page.threadId,
            tabId: page.id,
            url: page.url,
            startedAt: 1,
          },
        ],
      ]),
    });

    render(
      <ActivityRail
        {...railElement(["preview"]).props}
        browserTabSet={browserTabSet}
      />,
    );

    expect(screen.getByTestId("browser-agent-control-indicator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser page: Example, agent controls Browser" })).toBeInTheDocument();
  });

  it("reorders only from a focused rail tab keyboard shortcut", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    act(() => terminal.focus());

    fireEvent.keyDown(terminal, { key: "ArrowDown", altKey: true, shiftKey: true });

    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    expect(terminal).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Close panel" }), {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
    });
    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
  });

  it("reorders only after crossing the adjacent top-level item boundary", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 48,
      bottom: 88,
    } as DOMRect);

    terminal.focus();
    fireEvent.pointerDown(terminal, { button: 0, pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 47 });
    expect(handlers.onReorder).not.toHaveBeenCalled();

    fireEvent.pointerMove(terminal, { pointerId: 1, clientY: 48 });
    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    fireEvent.click(terminal);
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(terminal).toHaveFocus();
  });

  it("selects a tab when pointer jitter does not become a drag", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 88,
    } as DOMRect);

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 4, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 4, clientY: 21 });
    fireEvent.pointerUp(terminal, { pointerId: 4, clientY: 21 });
    fireEvent.click(terminal);

    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).toHaveBeenCalledWith("singleton:terminal");
  });

  it("selects normally after a cancelled drag gesture", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const terminalItem = terminal.closest("[data-rail-instance]") as HTMLElement;
    const changesItem = screen
      .getByRole("button", { name: "Review, 3 files changed" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    vi.spyOn(changesItem, "getBoundingClientRect").mockReturnValue({
      top: 48,
      bottom: 88,
    } as DOMRect);

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 5, clientY: 20 });
    fireEvent.pointerMove(terminal, { pointerId: 5, clientY: 48 });
    expect(handlers.onReorder).toHaveBeenCalledWith(
      rightPanelSingletonId("terminal"),
      1,
    );
    fireEvent.pointerCancel(terminal, { pointerId: 5, clientY: 48 });

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 6, clientY: 20 });
    fireEvent.pointerUp(terminal, { pointerId: 6, clientY: 20 });
    fireEvent.click(terminal);

    expect(handlers.onSelect).toHaveBeenCalledWith("singleton:terminal");
  });

  it("excludes close presses from drag and click activation", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    fireEvent.pointerEnter(terminal);
    const close = screen.getByRole("button", { name: "Close Terminal" });

    fireEvent.pointerDown(close, { button: 0, pointerId: 2, clientY: 20 });
    fireEvent.pointerMove(close, { pointerId: 2, clientY: 100 });
    fireEvent.click(close);

    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledWith("singleton:terminal");
  });

  it("treats Browser pages as one top-level drag item", () => {
    render(
      <ActivityRail
        {...railElement(["preview", "terminal"]).props}
        browserTabSet={browserTabSet}
      />,
    );
    const page = screen.getByRole("button", { name: "Browser page: Example" });
    const browserItem = page.closest("[data-rail-instance]") as HTMLElement;
    const terminalItem = screen
      .getByRole("button", { name: "Terminal" })
      .closest("[data-rail-instance]") as HTMLElement;
    vi.spyOn(browserItem, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 80,
    } as DOMRect);
    vi.spyOn(terminalItem, "getBoundingClientRect").mockReturnValue({
      top: 88,
      bottom: 128,
    } as DOMRect);

    fireEvent.pointerDown(page, { button: 0, pointerId: 3, clientY: 20 });
    fireEvent.pointerMove(page, { pointerId: 3, clientY: 70 });
    expect(handlers.onReorder).not.toHaveBeenCalled();
    fireEvent.pointerMove(page, { pointerId: 3, clientY: 88 });
    expect(handlers.onReorder).toHaveBeenCalledWith("singleton:preview", 1);
  });

  it("leaves keyboard boundary handling to the store and does not intercept content", () => {
    renderRail();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(handlers.onReorder).toHaveBeenCalledWith("singleton:terminal", -1);

    const content = document.createElement("textarea");
    document.body.append(content);
    fireEvent.keyDown(content, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(handlers.onReorder).toHaveBeenCalledTimes(1);
    content.remove();
  });
});
