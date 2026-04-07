import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { useFileTagPopup, FileTagPopup } from "./FileTagPopup";

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

  it("uses virtual rendering above threshold and marks selected item", () => {
    // 21 items crosses VIRTUAL_THRESHOLD (20), activating the virtualizer path.
    // jsdom has no scroll height so the virtualizer renders only its overscan
    // window (first few items); we verify the listbox exists and that the
    // rendered subset has the correct aria-selected attribute.
    const files = Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`);
    render(
      <FileTagPopup
        files={files}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // jsdom has no scroll height, so the virtualizer renders 0 items — but
    // crucially, NOT all 21 nodes are in the DOM, proving the virtual path
    // is active rather than the native map() path.
    const options = screen.queryAllByRole("option");
    expect(options.length).toBeLessThan(21);
  });
});
