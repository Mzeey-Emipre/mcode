import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListChecks } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ComposerAddMenu } from "../ComposerAddMenu";
import { ComposerCapabilityChip } from "../ComposerCapabilityChip";

const COMPOSER_RECT = new DOMRect(80, 80, 640, 160);

describe("composer capabilities", () => {
  it("attaches Plan from the composer add menu", async () => {
    const user = userEvent.setup();
    const onAttachPlan = vi.fn();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={onAttachPlan}
        onAttachGoal={vi.fn()}
        onAttachOrchestration={vi.fn()}
        planAttached={false}
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(screen.getByRole("button", { name: /Plan/ }));

    await waitFor(() => expect(onAttachPlan).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("attaches Goal from the composer add menu", async () => {
    const user = userEvent.setup();
    const onAttachGoal = vi.fn();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={vi.fn()}
        onAttachGoal={onAttachGoal}
        onAttachOrchestration={vi.fn()}
        planAttached={false}
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(screen.getByRole("button", { name: /Goal/ }));

    await waitFor(() => expect(onAttachGoal).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("attaches Ultra from the composer add menu", async () => {
    const user = userEvent.setup();
    const onAttachOrchestration = vi.fn();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={vi.fn()}
        onAttachGoal={vi.fn()}
        onAttachOrchestration={onAttachOrchestration}
        planAttached={false}
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        orchestrationLabel="Ultra"
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(screen.getByRole("button", { name: /Ultra/ }));

    await waitFor(() => expect(onAttachOrchestration).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("removes an attached capability through its named control", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(
      <ComposerCapabilityChip
        label="Plan"
        icon={ListChecks}
        removeLabel="Remove Plan"
        onRemove={onRemove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove Plan" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("uses capability-specific icons in the add menu", async () => {
    const user = userEvent.setup();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={vi.fn()}
        onAttachGoal={vi.fn()}
        onAttachOrchestration={vi.fn()}
        planAttached={false}
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        orchestrationLabel="Ultra"
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    expect(
      screen.getByRole("button", { name: /Plan/ }).querySelector(".lucide-list-checks"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Goal/ }).querySelector(".lucide-goal")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Ultra/ }).querySelector(".lucide-network"),
    ).toBeTruthy();
  });

  it("marks attached capabilities as selected in the add menu", async () => {
    const user = userEvent.setup();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={vi.fn()}
        onAttachGoal={vi.fn()}
        onAttachOrchestration={vi.fn()}
        planAttached
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    const planButton = screen.getByRole("button", { name: /Plan/ });
    expect(planButton).toHaveAttribute("aria-pressed", "true");
    expect(planButton.querySelector(".lucide-check")).toBeTruthy();
  });

  it("keeps titles visible while descriptions stay inline and fade", async () => {
    const user = userEvent.setup();

    render(
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        onAttachPlan={vi.fn()}
        onAttachGoal={vi.fn()}
        onAttachOrchestration={vi.fn()}
        planAttached={false}
        goalAttached={false}
        goalAvailable={true}
        orchestrationAttached={false}
        orchestrationLabel="Ultracode"
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    for (const description of [
      "Images, PDFs, documents, and code",
      "Explore the work and propose a plan",
      "Set the objective for the next run",
      "Proactively delegate work to sub-agents",
    ]) {
      const descriptionElement = screen.getByText(description);
      const titleElement = descriptionElement.previousElementSibling;

      expect(descriptionElement).toHaveClass("flex-1", "overflow-hidden", "whitespace-nowrap");
      expect(descriptionElement).toHaveStyle({
        maskImage: "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
      });
      expect(titleElement).toHaveClass("shrink-0");
      expect(descriptionElement.parentElement).toHaveClass("items-baseline", "overflow-hidden");
      expect(descriptionElement.parentElement).not.toHaveClass("flex-col");
    }
  });
});
