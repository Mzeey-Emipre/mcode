import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./context-menu";

describe("ContextMenu", () => {
  it("renders outside clipping ancestors", () => {
    const { container } = render(
      <div className="overflow-hidden">
        <ContextMenu
          x={100}
          y={100}
          items={[{ label: "Rename", onClick: vi.fn() }]}
          onClose={vi.fn()}
        />
      </div>,
    );

    const menu = screen.getByText("Rename").parentElement;

    expect(menu).not.toBeNull();
    expect(container).not.toContainElement(menu);
    expect(document.body).toContainElement(menu);
  });

  it("closes only when pointerdown occurs outside the menu", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={100}
        items={[{ label: "Rename", onClick: vi.fn() }]}
        onClose={onClose}
      />,
    );

    fireEvent.pointerDown(screen.getByText("Rename"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
