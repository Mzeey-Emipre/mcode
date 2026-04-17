import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useRef as reactUseRef } from "react";
import { SpellcheckContextMenu } from "./SpellcheckContextMenu";

// Mock the desktopBridge
const mockReplaceMisspelling = vi.fn().mockResolvedValue(undefined);
const mockAddToDictionary = vi.fn().mockResolvedValue(undefined);
const mockPaste = vi.fn().mockResolvedValue(undefined);
const mockOffContextMenu = vi.fn();
let contextMenuCallback: ((data: unknown) => void) | null = null;
const fakeListener = () => {};

beforeEach(() => {
  contextMenuCallback = null;

  window.desktopBridge = {
    spellcheck: {
      onContextMenu: (cb: (data: unknown) => void) => {
        contextMenuCallback = cb;
        return fakeListener;
      },
      offContextMenu: mockOffContextMenu,
      replaceMisspelling: mockReplaceMisspelling,
      addToDictionary: mockAddToDictionary,
      paste: mockPaste,
    },
  } as unknown as typeof window.desktopBridge;
});

afterEach(() => {
  vi.clearAllMocks();
  window.desktopBridge = undefined;
});

/** Wrapper that provides a real div element as the editor ref. */
function TestWrapper() {
  const ref = reactUseRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} data-testid="editor" />
      <SpellcheckContextMenu editorRef={ref} />
    </div>
  );
}

/**
 * Simulate a right-click in the editor and a context-menu IPC event
 * from the Electron main process with optional overrides.
 */
function fireContextMenu(overrides: Record<string, unknown> = {}) {
  // Step 1: Fire DOM contextmenu on the editor to set pendingPos.
  const editor = screen.getByTestId("editor");
  fireEvent.contextMenu(editor);

  // Step 2: Simulate the IPC push from the main process.
  act(() => {
    contextMenuCallback?.({
      x: 100,
      y: 200,
      misspelledWord: "teh",
      suggestions: ["the", "tea", "ten"],
      selectionText: "",
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      ...overrides,
    });
  });
}

describe("SpellcheckContextMenu", () => {
  it("renders nothing when no context-menu event received", () => {
    render(<TestWrapper />);
    // Only the wrapper div and the editor div should be present - no menu.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows spelling suggestions when misspelled word is present", () => {
    render(<TestWrapper />);
    fireContextMenu();

    expect(screen.getByText("the")).toBeInTheDocument();
    expect(screen.getByText("tea")).toBeInTheDocument();
    expect(screen.getByText("ten")).toBeInTheDocument();
  });

  it("shows 'Add to dictionary' when misspelled word is present", () => {
    render(<TestWrapper />);
    fireContextMenu();

    expect(screen.getByText(/add .* to dictionary/i)).toBeInTheDocument();
  });

  it("calls replaceMisspelling when a suggestion is clicked", () => {
    render(<TestWrapper />);
    fireContextMenu();

    fireEvent.click(screen.getByText("the"));
    expect(mockReplaceMisspelling).toHaveBeenCalledWith("the");
  });

  it("calls addToDictionary when 'Add to dictionary' is clicked", () => {
    render(<TestWrapper />);
    fireContextMenu();

    fireEvent.click(screen.getByText(/add .* to dictionary/i));
    expect(mockAddToDictionary).toHaveBeenCalledWith("teh");
  });

  it("does not show spelling items when no misspelled word", () => {
    render(<TestWrapper />);
    fireContextMenu({ misspelledWord: "", suggestions: [] });

    expect(screen.queryByText(/add .* to dictionary/i)).not.toBeInTheDocument();
  });

  it("calls paste via IPC when Paste is clicked", () => {
    render(<TestWrapper />);
    fireContextMenu({ misspelledWord: "", suggestions: [] });

    fireEvent.click(screen.getByText("Paste"));
    expect(mockPaste).toHaveBeenCalled();
  });

  it("cleans up the context-menu listener on unmount", () => {
    const { unmount } = render(<TestWrapper />);
    unmount();
    expect(mockOffContextMenu).toHaveBeenCalledWith(fakeListener);
  });

  it("renders nothing when desktopBridge is not available (web browser)", () => {
    window.desktopBridge = undefined;
    render(<TestWrapper />);
    // Even after simulating contextmenu, no menu appears without the bridge.
    const editor = screen.getByTestId("editor");
    fireEvent.contextMenu(editor);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("ignores IPC events not originating from the editor", () => {
    render(<TestWrapper />);
    // Don't fire contextmenu on the editor - simulate IPC only.
    act(() => {
      contextMenuCallback?.({
        x: 100,
        y: 200,
        misspelledWord: "teh",
        suggestions: ["the"],
        selectionText: "",
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      });
    });
    // Menu should NOT appear because pendingRef was not set.
    expect(screen.queryByText("the")).not.toBeInTheDocument();
  });
});
