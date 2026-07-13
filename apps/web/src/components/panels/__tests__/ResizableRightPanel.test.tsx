import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResizableRightPanel } from "../ResizableRightPanel";

describe("ResizableRightPanel", () => {
  it("reports drag and keyboard width changes through the controlled seam", () => {
    const onWidthChange = vi.fn();
    render(
      <ResizableRightPanel
        width={500}
        minWidth={320}
        maxWidth="calc(100% - 320px)"
        getMaxWidth={() => 760}
        defaultWidth={500}
        wideWidth={700}
        separatorLabel="Resize test panel"
        onWidthChange={onWidthChange}
      >
        <div>Panel content</div>
      </ResizableRightPanel>,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize test panel",
    });
    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 450 });
    fireEvent.mouseUp(document);
    expect(onWidthChange).toHaveBeenCalledWith(550, "user");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(510, "user");

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onWidthChange).toHaveBeenCalledWith(700, "user");
  });
});
