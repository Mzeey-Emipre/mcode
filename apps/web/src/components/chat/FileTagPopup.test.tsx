import { describe, it, expect, vi } from "vitest";
import { renderHook, act, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { useFileTagPopup, FileTagPopup } from "./FileTagPopup";
import type { MentionSuggestion } from "./useFileAutocomplete";

const items: MentionSuggestion[] = [
  {
    id: "agent:planner",
    kind: "agent",
    group: "Agents",
    label: "planner",
    name: "planner",
    path: "C:/Users/example/.codex/agents/planner.toml",
    provider: "codex",
    description: "Plans implementation work.",
  },
  {
    id: "file:src/a.ts",
    kind: "file",
    group: "Files",
    label: "src/a.ts",
    path: "src/a.ts",
  },
  {
    id: "file:src/b.ts",
    kind: "file",
    group: "Files",
    label: "src/b.ts",
    path: "src/b.ts",
  },
];

describe("useFileTagPopup", () => {
  const defaultProps = {
    items,
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

  it("resets selectedIndex when items change", () => {
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
    rerender({ ...defaultProps, items: items.slice(0, 2) });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("calls onSelect with selected item on Enter", () => {
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
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("calls onSelect with selected item on Tab", () => {
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
    expect(onSelect).toHaveBeenCalledWith(items[1]);
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

  it("renders grouped agent and file items", () => {
    render(
      <FileTagPopup
        items={items}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );

    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getAllByText("src/")).toHaveLength(2);
  });

  it("keeps group labels sticky while scrolling within long sections", () => {
    render(
      <FileTagPopup
        items={items}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );

    expect(screen.getByText("Agents").className).toContain("sticky");
    expect(screen.getByText("Files").className).toContain("sticky");
  });

  it("renders agent suggestions with a muted non-robot glyph", () => {
    render(
      <FileTagPopup
        items={items}
        isOpen={true}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );

    const agentOption = screen.getByRole("option", { name: /planner/i });
    const icon = agentOption.querySelector("svg");
    expect(icon?.className.baseVal).toContain("text-muted-foreground/55");
    expect(icon?.className.baseVal).not.toContain("text-primary");
    expect(agentOption.querySelector(".lucide-bot")).toBeNull();
  });

  it("accepts selectedIndex prop and marks the correct item", () => {
    render(
      <FileTagPopup
        items={items}
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
        items={[items[0]]}
        isOpen={false}
        onSelect={onSelect}
        listRef={mockListRef}
        selectedIndex={0}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
