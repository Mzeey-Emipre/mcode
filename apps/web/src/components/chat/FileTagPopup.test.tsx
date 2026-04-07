import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useFileTagPopup, FileTagPopup } from "./FileTagPopup";

// Mock the virtualizer so component tests control which virtual items are
// "rendered" without needing real scroll dimensions from jsdom.
vi.mock("@tanstack/react-virtual");

describe("useFileTagPopup", () => {
  const defaultProps = {
    files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    query: "",
    isOpen: true,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
  };

  it("exposes selectedIndex starting at 0", () => {
    const { result } = renderHook(() => useFileTagPopup(defaultProps));
    expect(result.current.selectedIndex).toBe(0);
  });

  it("increments selectedIndex on ArrowDown", () => {
    const { result } = renderHook(() => useFileTagPopup(defaultProps));
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("clamps selectedIndex at last item", () => {
    const { result } = renderHook(() => useFileTagPopup(defaultProps));
    act(() => {
      const prevent = vi.fn();
      for (let i = 0; i < 10; i++) {
        result.current.handleKeyDown({
          key: "ArrowDown",
          preventDefault: prevent,
        } as unknown as React.KeyboardEvent);
      }
    });
    expect(result.current.selectedIndex).toBe(2);
  });

  it("decrements selectedIndex on ArrowUp", () => {
    const { result } = renderHook(() => useFileTagPopup(defaultProps));
    act(() => {
      const prevent = vi.fn();
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: prevent,
      } as unknown as React.KeyboardEvent);
      result.current.handleKeyDown({
        key: "ArrowUp",
        preventDefault: prevent,
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("clamps selectedIndex at 0 on ArrowUp", () => {
    const { result } = renderHook(() => useFileTagPopup(defaultProps));
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("resets selectedIndex when files change", () => {
    const { result, rerender } = renderHook(
      (props) => useFileTagPopup(props),
      { initialProps: defaultProps },
    );
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(1);
    rerender({ ...defaultProps, files: ["src/x.ts", "src/y.ts"] });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("calls onSelect with selected file on Enter", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useFileTagPopup({ ...defaultProps, onSelect }),
    );
    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("calls onSelect with selected file on Tab", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useFileTagPopup({ ...defaultProps, onSelect }),
    );
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
      result.current.handleKeyDown({
        key: "Tab",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(onSelect).toHaveBeenCalledWith("src/b.ts");
  });

  it("calls onDismiss on Escape", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useFileTagPopup({ ...defaultProps, onDismiss }),
    );
    act(() => {
      result.current.handleKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("ignores all keys when isOpen is false", () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useFileTagPopup({ ...defaultProps, isOpen: false, onSelect, onDismiss }),
    );
    act(() => {
      const prevent = vi.fn();
      for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
        result.current.handleKeyDown({
          key,
          preventDefault: prevent,
        } as unknown as React.KeyboardEvent);
      }
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("FileTagPopup", () => {
  const mockListRef = { current: null } as RefObject<HTMLDivElement | null>;
  const onSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default stub: virtualizer renders no items (mirrors jsdom behavior).
    // Individual tests override this when they need to inspect virtual output.
    vi.mocked(useVirtualizer).mockReturnValue({
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      scrollToIndex: vi.fn(),
    } as unknown as ReturnType<typeof useVirtualizer>);
  });

  it("renders all items when below virtual threshold", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    render(
      <FileTagPopup
        files={files}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(10);
  });

  it("accepts selectedIndex prop and marks the correct item", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    render(
      <FileTagPopup
        files={files}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={1}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("renders nothing when closed", () => {
    render(
      <FileTagPopup
        files={["src/a.ts"]}
        isOpen={false}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("uses native rendering at threshold boundary (20 items)", () => {
    // 20 items == VIRTUAL_THRESHOLD: strict > check means this is non-virtual.
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    render(
      <FileTagPopup
        files={files}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );
    expect(screen.getAllByRole("option")).toHaveLength(20);
  });

  it("uses virtual rendering above threshold and marks selected item", () => {
    // 21 items crosses VIRTUAL_THRESHOLD (20). Override the mock to return a
    // controlled window of virtual rows so we can assert aria-selected without
    // relying on jsdom scroll dimensions.
    vi.mocked(useVirtualizer).mockReturnValueOnce({
      getVirtualItems: () => [
        { key: "0", index: 0, start: 0, size: 28 },
        { key: "1", index: 1, start: 28, size: 28 },
        { key: "2", index: 2, start: 56, size: 28 },
      ],
      getTotalSize: () => 588,
      scrollToIndex: vi.fn(),
    } as unknown as ReturnType<typeof useVirtualizer>);

    const files = Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`);
    render(
      <FileTagPopup
        files={files}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={1}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).toHaveAttribute("aria-selected", "false");
  });
});
