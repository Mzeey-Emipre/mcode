import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("keeps Variant B controls in one compact row without a mode switch", () => {
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
    expect(toolbar).toHaveClass("@container");
    expect(toolbar.className).toContain("@max-[520px]:gap-0.5");
    expect(toolbar.className.split(/\s+/)).not.toContain("max-[520px]:gap-0.5");
    expect(toolbar).not.toHaveClass("flex-wrap");
    expect(toolbar).not.toHaveClass("overflow-x-auto");
    expect(toolbar).not.toHaveClass("overflow-x-scroll");
    expect(screen.queryByRole("button", { name: "Regular" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
    const widthInput = screen.getByRole("textbox", { name: "Viewport width" });
    expect(widthInput).toBeInTheDocument();
    expect(widthInput.parentElement).toHaveClass("shrink-0");
    expect(screen.getByRole("textbox", { name: "Viewport height" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate viewport to landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Viewport scale and presentation" })).toHaveTextContent("100%");
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

    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    expect(screen.getByText("393 × 852")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("iPhone 15 Pro");
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

    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Actual size" }));
    expect(coordinator.snapshot().presentation).toBe("actual");
    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Fit to panel" }));
    expect(coordinator.snapshot().presentation).toBe("fit");
    await user.click(screen.getByRole("button", { name: "Close viewport toolbar" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("toggles each controlled menu from its trigger", async () => {
    const user = userEvent.setup();
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

    const presetTrigger = screen.getByRole("button", { name: "Viewport preset" });
    await user.click(presetTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(presetTrigger);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const scaleTrigger = screen.getByRole("button", { name: "Viewport scale and presentation" });
    await user.click(scaleTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(scaleTrigger);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
