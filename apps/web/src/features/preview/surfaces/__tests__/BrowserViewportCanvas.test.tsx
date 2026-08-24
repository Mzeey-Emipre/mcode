import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ViewportCoordinator,
  type ViewportHostOperation,
} from "../../automation/services/viewportCoordinator";
import { BrowserViewportCanvas } from "../BrowserViewportCanvas";

function setup() {
  const apply = vi.fn(async (operation: ViewportHostOperation) => ({
    status: "applied" as const,
    applied: operation.requested,
  }));
  const coordinator = new ViewportCoordinator({
    initial: { width: 800, height: 600 },
    mode: "responsive",
    targetGeneration: 1,
    apply,
  });
  return { apply, coordinator };
}

describe("BrowserViewportCanvas", () => {
  it("exposes every edge and corner as a keyboard resize zone", async () => {
    const user = userEvent.setup();
    const { apply, coordinator } = setup();
    render(
      <BrowserViewportCanvas
        coordinator={coordinator}
        state={coordinator.snapshot()}
        bounds={{ width: 1_000, height: 800 }}
        scale={1}
      >
        <div data-testid="viewport-content" />
      </BrowserViewportCanvas>,
    );

    for (const position of [
      "top",
      "right",
      "bottom",
      "left",
      "top-left",
      "top-right",
      "bottom-right",
      "bottom-left",
    ]) {
      expect(screen.getByRole("separator", { name: `Resize viewport from ${position}` })).toHaveClass(
        "pointer-events-auto",
      );
    }
    expect(screen.getByTestId("browser-viewport-stage")).toHaveClass("pointer-events-none");

    await user.click(screen.getByRole("separator", { name: "Resize viewport from right" }));
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("separator", { name: "Resize viewport from bottom" }));
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("separator", { name: "Resize viewport from bottom-right" }));
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("separator", { name: "Resize viewport from top-left" }));
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowUp}");

    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      requested: { width: 848, height: 648 },
    })));
  });

  it("uses pointer capture and coalesces drag requests through the same coordinator", () => {
    const { apply, coordinator } = setup();
    render(
      <BrowserViewportCanvas
        coordinator={coordinator}
        state={coordinator.snapshot()}
        bounds={{ width: 1_000, height: 800 }}
        scale={0.5}
      >
        <div data-testid="viewport-content" />
      </BrowserViewportCanvas>,
    );
    const handle = screen.getByRole("separator", { name: "Resize viewport from right" });
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(handle, "hasPointerCapture", { value: vi.fn(() => true) });
    Object.defineProperty(handle, "releasePointerCapture", { value: vi.fn() });

    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 60, clientY: 10 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 110, clientY: 10 }));
    handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 110, clientY: 10 }));

    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      requested: { width: 1_000, height: 600 },
    }));
    expect(apply.mock.calls.length).toBeGreaterThan(0);
  });
});
