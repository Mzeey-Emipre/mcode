import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  compileTerminalSearchRegex,
  cycleTerminalSearchVariant,
  getTerminalSearchVariant,
  TERMINAL_SEARCH_QUERY_MAX_LENGTH,
  TerminalSearchPrototype,
  TerminalSearchPrototypeSwitcher,
} from "./TerminalSearchPrototype";
import { TERMINAL_SEARCH_VARIANT_EVENT } from "./terminalSearchGate";

describe("Terminal search prototype gate and switcher", () => {
  it("accepts only dev variants and cycles them with wraparound", () => {
    expect(getTerminalSearchVariant("?terminalSearchVariant=island")).toBe("island");
    expect(getTerminalSearchVariant("?terminalSearchVariant=unknown")).toBeNull();
    expect(getTerminalSearchVariant("?terminalSearchVariant=island%20")).toBeNull();
    expect(cycleTerminalSearchVariant("island", "previous")).toBe("shelf");
    expect(cycleTerminalSearchVariant("shelf", "next")).toBe("island");
  });

  it("updates the URL and ignores arrow keys from editable controls", () => {
    const onVariantChange = vi.fn();
    const onWindowVariantChange = vi.fn();
    window.addEventListener(TERMINAL_SEARCH_VARIANT_EVENT, onWindowVariantChange);
    window.history.replaceState(null, "", "/?terminalSearchVariant=island");
    const { rerender } = render(
      <TerminalSearchPrototypeSwitcher
        variant="island"
        onVariantChange={onVariantChange}
      />,
    );
    expect(screen.getByTestId("terminal-search-variant-switcher")).toHaveClass("bottom-3");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onVariantChange).toHaveBeenCalledWith("lane");
    expect(onWindowVariantChange).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?terminalSearchVariant=lane");

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onVariantChange).toHaveBeenCalledTimes(1);
    input.remove();

    rerender(
      <TerminalSearchPrototypeSwitcher
        variant="shelf"
        onVariantChange={onVariantChange}
      />,
    );
    expect(screen.getByTestId("terminal-search-variant-switcher")).toHaveClass("bottom-24");
    window.removeEventListener(TERMINAL_SEARCH_VARIANT_EVENT, onWindowVariantChange);
  });

  it("prevalidates regex queries, bounds input, and hides the switcher for inactive views", async () => {
    expect(compileTerminalSearchRegex("[", false)).toBeNull();
    expect(compileTerminalSearchRegex("needle", true)).toEqual(/needle/);

    const addon = {
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      cols: 80,
      rows: 24,
      clearSelection: vi.fn(),
      focus: vi.fn(),
    };
    const shortcutRef = { current: null as (() => void) | null };

    render(
      <TerminalSearchPrototype
        ptyId="pty-regex"
        active
        variant="lane"
        terminal={terminal as never}
        searchAddon={addon as never}
        shortcutRef={shortcutRef}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    expect(screen.queryByTestId("terminal-search-variant-switcher")).toBeNull();

    await act(async () => {
      shortcutRef.current?.();
    });
    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    expect(input).toHaveAttribute("maxlength", String(TERMINAL_SEARCH_QUERY_MAX_LENGTH));
    const primaryRow = screen.getByTestId("terminal-search-primary-row");
    const secondaryRow = screen.getByTestId("terminal-search-secondary-row");
    expect(primaryRow).toContainElement(input);
    expect(secondaryRow).toContainElement(
      screen.getByRole("checkbox", { name: /Regular expression/ }),
    );

    const invalidQuery = "[";
    fireEvent.change(input, { target: { value: invalidQuery } });
    await waitFor(() =>
      expect(addon.findNext).toHaveBeenCalledWith(
        invalidQuery,
        expect.objectContaining({ regex: false }),
      ),
    );
    expect(screen.queryByText("Invalid regular expression")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Regular expression/ }));
    await waitFor(() =>
      expect(screen.getByText("Invalid regular expression")).toBeInTheDocument(),
    );
    expect(addon.findNext).toHaveBeenCalledTimes(1);

    fireEvent.change(input, {
      target: { value: "x".repeat(TERMINAL_SEARCH_QUERY_MAX_LENGTH + 20) },
    });
    await waitFor(() =>
      expect(input).toHaveValue("x".repeat(TERMINAL_SEARCH_QUERY_MAX_LENGTH)),
    );
    expect(addon.findNext).toHaveBeenCalledWith(
      "x".repeat(TERMINAL_SEARCH_QUERY_MAX_LENGTH),
      expect.objectContaining({ incremental: true }),
    );
  });

  it("surfaces addon failures without labeling plain text as invalid regex", async () => {
    const addon = {
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => {
        throw new Error("Cannot use addon until it has been loaded");
      }),
      findPrevious: vi.fn(() => true),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      cols: 80,
      rows: 24,
      clearSelection: vi.fn(),
      focus: vi.fn(),
    };
    const shortcutRef = { current: null as (() => void) | null };

    render(
      <TerminalSearchPrototype
        ptyId="pty-addon-error"
        active
        variant="island"
        terminal={terminal as never}
        searchAddon={addon as never}
        shortcutRef={shortcutRef}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );

    await act(async () => {
      shortcutRef.current?.();
    });
    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "plain text" } });

    await waitFor(() =>
      expect(
        screen.getByText("Search failed: Cannot use addon until it has been loaded"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Invalid regular expression")).toBeNull();
  });

  it("keeps open state while inactive and resumes search on activation", async () => {
    const addon = {
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      cols: 80,
      rows: 24,
      clearSelection: vi.fn(),
      focus: vi.fn(),
    };
    const shortcutRef = { current: null as (() => void) | null };
    const view = render(
      <TerminalSearchPrototype
        ptyId="pty-active-visibility"
        active
        variant="lane"
        terminal={terminal as never}
        searchAddon={addon as never}
        shortcutRef={shortcutRef}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );

    await act(async () => {
      shortcutRef.current?.();
    });
    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "persisted query" } });
    await waitFor(() =>
      expect(addon.findNext).toHaveBeenCalledWith(
        "persisted query",
        expect.objectContaining({ incremental: true }),
      ),
    );
    const searchCallsBeforeHide = addon.findNext.mock.calls.length;

    view.rerender(
      <TerminalSearchPrototype
        ptyId="pty-active-visibility"
        active={false}
        variant="lane"
        terminal={terminal as never}
        searchAddon={addon as never}
        shortcutRef={shortcutRef}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    expect(screen.queryByTestId("terminal-search-lane")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Find in terminal" })).toBeNull();
    expect(shortcutRef.current).toBeNull();
    expect(addon.findNext).toHaveBeenCalledTimes(searchCallsBeforeHide);

    view.rerender(
      <TerminalSearchPrototype
        ptyId="pty-active-visibility"
        active
        variant="lane"
        terminal={terminal as never}
        searchAddon={addon as never}
        shortcutRef={shortcutRef}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Find in terminal" })).toHaveValue(
      "persisted query",
    );
    await waitFor(() =>
      expect(addon.findNext).toHaveBeenCalledTimes(searchCallsBeforeHide + 1),
    );
  });

  it("restores search state independently for each terminal", async () => {
    const createAddon = () => ({
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    });
    const terminal = {
      cols: 80,
      rows: 24,
      clearSelection: vi.fn(),
      focus: vi.fn(),
    };
    const shortcutA = { current: null as (() => void) | null };
    const addonA = createAddon();
    const firstA = render(
      <TerminalSearchPrototype
        ptyId="pty-state-a"
        active
        variant="island"
        terminal={terminal as never}
        searchAddon={addonA as never}
        shortcutRef={shortcutA}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    await act(async () => {
      shortcutA.current?.();
    });
    const inputA = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(inputA, { target: { value: "alpha" } });
    await waitFor(() => expect(inputA).toHaveValue("alpha"));
    firstA.unmount();

    const shortcutB = { current: null as (() => void) | null };
    const addonB = createAddon();
    const firstB = render(
      <TerminalSearchPrototype
        ptyId="pty-state-b"
        active
        variant="island"
        terminal={terminal as never}
        searchAddon={addonB as never}
        shortcutRef={shortcutB}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    await act(async () => {
      shortcutB.current?.();
    });
    const inputB = screen.getByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(inputB, { target: { value: "beta" } });
    await waitFor(() => expect(inputB).toHaveValue("beta"));
    firstB.unmount();

    const shortcutA2 = { current: null as (() => void) | null };
    const addonA2 = createAddon();
    const restoredA = render(
      <TerminalSearchPrototype
        ptyId="pty-state-a"
        active
        variant="island"
        terminal={terminal as never}
        searchAddon={addonA2 as never}
        shortcutRef={shortcutA2}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    const restoredInputA = screen.getByRole("textbox", { name: "Find in terminal" });
    expect(restoredInputA).toHaveValue("alpha");
    await waitFor(() =>
      expect(addonA2.findNext).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ incremental: true }),
      ),
    );
    restoredA.unmount();

    const shortcutB2 = { current: null as (() => void) | null };
    const addonB2 = createAddon();
    render(
      <TerminalSearchPrototype
        ptyId="pty-state-b"
        active
        variant="island"
        terminal={terminal as never}
        searchAddon={addonB2 as never}
        shortcutRef={shortcutB2}
        onVariantChange={vi.fn()}
        showSwitcher={false}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Find in terminal" })).toHaveValue("beta");
  });
});
