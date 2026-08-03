import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ViewportCoordinator,
  type ViewportHostOperation,
} from "@/services/browser-automation/viewportCoordinator";
import { BrowserViewportToolbar } from "../BrowserViewportToolbar";

function createCoordinator(apply: (operation: ViewportHostOperation) => Promise<{
  status: "applied";
  applied: { width: number; height: number };
}>) {
  return new ViewportCoordinator({
    initial: { width: 1280, height: 800 },
    targetGeneration: 1,
    apply,
  });
}

describe("BrowserViewportToolbar", () => {
  it("keeps every control rendered in a compact wrapped row", () => {
    const coordinator = createCoordinator(async (operation) => ({
      status: "applied",
      applied: operation.requested,
    }));
    render(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );

    const toolbar = screen.getByTestId("browser-viewport-toolbar");
    expect(toolbar).toHaveClass("flex-wrap");
    expect(toolbar).not.toHaveClass("overflow-x-auto");
    expect(toolbar).not.toHaveClass("overflow-x-scroll");
    expect(screen.getByRole("button", { name: "Regular" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Responsive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Presets" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Viewport width" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Viewport height" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate viewport" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actual" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close viewport toolbar" })).toBeInTheDocument();
  });

  it("submits presets and bounded custom dimensions through the coordinator", async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async (operation: ViewportHostOperation) => ({
      status: "applied" as const,
      applied: operation.requested,
    }));
    const coordinator = createCoordinator(apply);
    const onClose = vi.fn();
    const { rerender } = render(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Presets" }));
    expect(screen.queryByText("393×852")).not.toBeInTheDocument();
    await user.click(await screen.findByText("iPhone 15 Pro"));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ requested: { width: 393, height: 852 } }),
    ));

    rerender(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={onClose}
      />,
    );
    const width = screen.getByRole("textbox", { name: "Viewport width" });
    const height = screen.getByRole("textbox", { name: "Viewport height" });
    await user.clear(width);
    await user.type(width, "100");
    await user.clear(height);
    await user.type(height, "3000");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: { width: 240, height: 2560 } }),
    ));

    await user.click(screen.getByRole("button", { name: "Actual" }));
    expect(coordinator.snapshot().presentation).toBe("actual");
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(coordinator.snapshot().presentation).toBe("fit");
    await user.click(screen.getByRole("button", { name: "Close viewport toolbar" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
