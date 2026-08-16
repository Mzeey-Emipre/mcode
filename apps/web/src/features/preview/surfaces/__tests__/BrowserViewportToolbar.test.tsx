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
    const presetTrigger = screen.getByRole("button", { name: "Viewport preset" });
    expect(presetTrigger).toHaveTextContent("Responsive");
    expect(presetTrigger).toHaveClass("w-32");
    expect(presetTrigger.className).toContain("@max-[520px]:w-24");
    const widthInput = screen.getByRole("textbox", { name: "Viewport width" });
    expect(widthInput).toBeInTheDocument();
    expect(widthInput.parentElement).toHaveClass("shrink-0");
    expect(screen.getByRole("textbox", { name: "Viewport height" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate viewport to landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Viewport scale and presentation" })).toHaveTextContent("100%");
    const closeButton = screen.getByRole("button", { name: "Close viewport toolbar" });
    expect(closeButton).toHaveClass("ml-auto");
    expect(closeButton.className).not.toContain("@max-[520px]:ml-0");
  });

  it("opens matching dimensions as Responsive until the user selects a preset", () => {
    const coordinator = createCoordinator(async (operation) => ({
      status: "applied",
      applied: operation.requested,
    }));
    coordinator.setMode("responsive");
    render(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
    expect(screen.getByRole("button", { name: "Viewport preset" })).not.toHaveTextContent("Laptop");
  });

  it("activates Responsive from the full preset menu click target", async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async (operation: ViewportHostOperation) => ({
      status: "applied" as const,
      applied: operation.requested,
    }));
    const coordinator = createCoordinator(apply);
    const { rerender } = render(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    const responsiveItem = within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Responsive",
    });
    expect(responsiveItem).toHaveClass("w-full");
    await user.click(responsiveItem);

    await waitFor(() => expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ requested: { width: 1280, height: 800 } }),
    ));
    expect(coordinator.snapshot().mode).toBe("responsive");
    rerender(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
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
    expect(await screen.findByText("393 × 852")).toBeInTheDocument();
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
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Actual size" }));
    expect(coordinator.snapshot().presentation).toBe("actual");
    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Fit to panel" }));
    expect(coordinator.snapshot().presentation).toBe("fit");
    await user.click(screen.getByRole("button", { name: "Close viewport toolbar" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers the complete fixed zoom scale", async () => {
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

    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    const zoomMenu = await screen.findByRole("menu");
    for (const zoom of ["50%", "75%", "100%", "125%", "150%", "200%"]) {
      expect(within(zoomMenu).getByRole("menuitem", { name: zoom })).toBeInTheDocument();
    }
    await user.click(within(zoomMenu).getByRole("menuitem", { name: "150%" }));
    expect(coordinator.snapshot().presentation).toBe("150%");
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
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.click(presetTrigger);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const scaleTrigger = screen.getByRole("button", { name: "Viewport scale and presentation" });
    await user.click(scaleTrigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.click(scaleTrigger);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
