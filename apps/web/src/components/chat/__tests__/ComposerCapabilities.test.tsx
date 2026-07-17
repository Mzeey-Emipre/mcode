import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileEdit } from "lucide-react";
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
        planAttached={false}
        getComposerRect={() => COMPOSER_RECT}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(screen.getByRole("button", { name: /Plan/ }));

    await waitFor(() => expect(onAttachPlan).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("removes an attached capability through its named control", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(
      <ComposerCapabilityChip
        label="Plan"
        icon={FileEdit}
        removeLabel="Remove Plan"
        onRemove={onRemove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove Plan" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
