import { describe, it, expect, vi } from "vitest";
import { renderHook, act, render, screen } from "@testing-library/react";
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
});

describe("FileTagPopup", () => {
  const mockListRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  const onSelect = vi.fn();

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
});
