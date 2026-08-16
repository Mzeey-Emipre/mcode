import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileTerminalSearchRegex,
  TerminalSearchShelf,
  type TerminalSearchDirection,
  type TerminalSearchRunResult,
} from "../TerminalSearchShelf";
import { useTerminalStore, type TerminalSearchOptions } from "@/features/terminal/state/terminalStore";

function makeSearchHarness() {
  const addon = {
    clearDecorations: vi.fn(),
    findNext: vi.fn((query: string, _options: TerminalSearchOptions) => {
      if (query === "missing") return false;
      return true;
    }),
    findPrevious: vi.fn((_query: string, _options: TerminalSearchOptions) => true),
  };
  const terminal = {
    clearSelection: vi.fn(),
    focus: vi.fn(),
    cols: 80,
    rows: 24,
  };
  return {
    addon,
    terminal,
    onSearch: vi.fn((
      query: string,
      options: TerminalSearchOptions,
      direction: TerminalSearchDirection,
    ): TerminalSearchRunResult => {
      if (options.regex && !compileTerminalSearchRegex(query, options.caseSensitive)) {
        return "invalid-regex" as const;
      }
      const found = direction === "next"
        ? addon.findNext(query, options)
        : addon.findPrevious(query, options);
      return found ? ("found" as const) : ("no-matches" as const);
    }),
    onClear: vi.fn(),
    onRestoreFocus: vi.fn(() => terminal.focus()),
  };
}

beforeEach(() => {
  useTerminalStore.setState({
    terminals: {},
    terminalPanelByThread: {},
    ptyToThread: {},
    terminalSearchByPty: {},
    splitMode: false,
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
});

describe("TerminalSearchShelf", () => {
  it("opens and focuses from stored PTY state, then closes and restores terminal focus", () => {
    const harness = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-a");

    render(
      <TerminalSearchShelf
        ptyId="pty-a"
        active
        addonState="ready"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole("button", { name: "Close terminal search" }));
    expect(screen.queryByTestId("terminal-search-shelf")).toBeNull();
    expect(harness.terminal.focus).toHaveBeenCalledOnce();
  });

  it("shows empty, zero-result, and current-match statuses", async () => {
    const harness = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-status");
    render(
      <TerminalSearchShelf
        ptyId="pty-status"
        active
        addonState="ready"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "missing" } });
    await waitFor(() => expect(status).toHaveTextContent("No matches"));

    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => {
      useTerminalStore.getState().setTerminalSearchResult("pty-status", 1, 4);
    });
    expect(status).toHaveTextContent("2 / 4");
  });

  it("keeps an empty query status silent while addon loading or failed", () => {
    const harness = makeSearchHarness();
    const onRetry = vi.fn();
    useTerminalStore.getState().openTerminalSearch("pty-addon-state");
    const view = render(
      <TerminalSearchShelf
        ptyId="pty-addon-state"
        active
        addonState="loading"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    view.rerender(
      <TerminalSearchShelf
        ptyId="pty-addon-state"
        active
        addonState="failed"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Retry terminal search" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("maps navigation keys, option flags, and invalid regex safely", async () => {
    const harness = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-controls");
    render(
      <TerminalSearchShelf
        ptyId="pty-controls"
        active
        addonState="ready"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => {
      useTerminalStore.getState().setTerminalSearchResult("pty-controls", 0, 2);
    });
    const nextCallsBefore = harness.addon.findNext.mock.calls.length;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.addon.findNext.mock.calls.length).toBe(nextCallsBefore + 1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(harness.addon.findPrevious).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ regex: false, wholeWord: false }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminal search options" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Case sensitive/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Whole word/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Regular expression/ }));
    expect(useTerminalStore.getState().terminalSearchByPty["pty-controls"]?.options).toEqual({
      caseSensitive: true,
      wholeWord: true,
      regex: true,
    });

    fireEvent.change(input, { target: { value: "[" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Invalid regular expression"));
    expect(harness.addon.findNext.mock.calls.some(([query]) => query === "[")).toBe(false);
    expect(compileTerminalSearchRegex("[", false)).toBeNull();
  });

  it("retains each PTY query and options through A/B/A switches", () => {
    const harnessA = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-a");
    const first = render(
      <TerminalSearchShelf
        ptyId="pty-a"
        active
        addonState="ready"
        onSearch={harnessA.onSearch}
        onClear={harnessA.onClear}
        onRestoreFocus={harnessA.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal" }), {
      target: { value: "alpha" },
    });
    useTerminalStore.getState().setTerminalSearchOptions("pty-a", {
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
    first.unmount();

    const harnessB = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-b");
    const second = render(
      <TerminalSearchShelf
        ptyId="pty-b"
        active
        addonState="ready"
        onSearch={harnessB.onSearch}
        onClear={harnessB.onClear}
        onRestoreFocus={harnessB.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal" }), {
      target: { value: "beta" },
    });
    second.unmount();

    const harnessA2 = makeSearchHarness();
    render(
      <TerminalSearchShelf
        ptyId="pty-a"
        active
        addonState="ready"
        onSearch={harnessA2.onSearch}
        onClear={harnessA2.onClear}
        onRestoreFocus={harnessA2.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Find in terminal" })).toHaveValue("alpha");
    expect(useTerminalStore.getState().terminalSearchByPty["pty-a"]?.options.caseSensitive).toBe(true);
    expect(useTerminalStore.getState().terminalSearchByPty["pty-b"]?.query).toBe("beta");
  });

  it("caps long queries before storing and searching", async () => {
    const harness = makeSearchHarness();
    useTerminalStore.getState().openTerminalSearch("pty-bound");
    render(
      <TerminalSearchShelf
        ptyId="pty-bound"
        active
        addonState="ready"
        onSearch={harness.onSearch}
        onClear={harness.onClear}
        onRestoreFocus={harness.onRestoreFocus}
        onRetry={vi.fn()}
      />,
    );

    const longQuery = "x".repeat(256) + "y".repeat(44);
    const expectedQuery = "x".repeat(256);
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal" }), {
      target: { value: longQuery },
    });

    await waitFor(() => expect(harness.onSearch).toHaveBeenCalledWith(
      expectedQuery,
      { caseSensitive: false, wholeWord: false, regex: false },
      "next",
    ));
    expect(useTerminalStore.getState().terminalSearchByPty["pty-bound"]?.query).toBe(expectedQuery);
    expect(expectedQuery).toHaveLength(256);
  });
});
