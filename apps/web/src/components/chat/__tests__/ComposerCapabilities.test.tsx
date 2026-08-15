import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListChecks } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ComposerAddMenu } from "../ComposerAddMenu";
import { ComposerCapabilityChip } from "../ComposerCapabilityChip";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityId,
  type ResolvedComposerCapability,
} from "@/features/conversation/composer/composer-capabilities";

const COMPOSER_RECT = new DOMRect(80, 80, 640, 160);
const CLAUDE_CAPABILITIES = resolveComposerCapabilities({
  providerId: "claude",
  modelId: "claude-opus-4-7",
});
const CODEX_CAPABILITIES = resolveComposerCapabilities({
  providerId: "codex",
  modelId: "gpt-5.6-sol",
});

function renderAddMenu({
  capabilities = CLAUDE_CAPABILITIES,
  attachedCapabilityIds = new Set<ComposerCapabilityId>(),
  onAttachCapability = vi.fn(),
}: {
  capabilities?: readonly ResolvedComposerCapability[];
  attachedCapabilityIds?: ReadonlySet<ComposerCapabilityId>;
  onAttachCapability?: (capabilityId: ComposerCapabilityId) => void;
} = {}) {
  return render(
    <ComposerAddMenu
      disabled={false}
      onAttachFiles={vi.fn()}
      capabilities={capabilities}
      attachedCapabilityIds={attachedCapabilityIds}
      onAttachCapability={onAttachCapability}
      getComposerRect={() => COMPOSER_RECT}
    />,
  );
}

describe("composer capabilities", () => {
  it.each([
    ["Plan", "plan"],
    ["Goal", "goal"],
  ] as const)("attaches %s from the composer add menu", async (label, capabilityId) => {
    const user = userEvent.setup();
    const onAttachCapability = vi.fn();
    renderAddMenu({ onAttachCapability });

    const trigger = screen.getByRole("button", { name: "Add to composer" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("menu", { name: "Add to composer" })).toBeVisible();
    await user.click(screen.getByRole("menuitemcheckbox", { name: new RegExp(label) }));

    await waitFor(() => expect(onAttachCapability).toHaveBeenCalledWith(capabilityId));
    expect(screen.queryByRole("menu", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("attaches Ultra from the composer add menu", async () => {
    const user = userEvent.setup();
    const onAttachCapability = vi.fn();
    renderAddMenu({ capabilities: CODEX_CAPABILITIES, onAttachCapability });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Ultra/ }));

    await waitFor(() => expect(onAttachCapability).toHaveBeenCalledWith("orchestration"));
    expect(screen.queryByRole("menu", { name: "Add to composer" })).not.toBeInTheDocument();
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
    renderAddMenu({ capabilities: CODEX_CAPABILITIES });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    expect(
      screen.getByRole("menuitemcheckbox", { name: /Plan/ }).querySelector(".lucide-list-checks"),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Goal/ }).querySelector(".lucide-goal"),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Ultra/ }).querySelector(".lucide-network"),
    ).toBeTruthy();
  });

  it("marks attached capabilities as selected in the add menu", async () => {
    const user = userEvent.setup();
    renderAddMenu({ attachedCapabilityIds: new Set(["plan"]) });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    const planButton = screen.getByRole("menuitemcheckbox", { name: /Plan/ });
    expect(planButton).toHaveAttribute("aria-checked", "true");
    expect(planButton.querySelector(".lucide-check")).toBeTruthy();
  });

  it("keeps titles visible while descriptions stay inline and fade", async () => {
    const user = userEvent.setup();
    renderAddMenu();

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

  it("hides the capability section when the provider exposes no Mcode capabilities", async () => {
    const user = userEvent.setup();
    renderAddMenu({ capabilities: [] });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Files/ })).toBeVisible();
  });

  it("focuses the first action and supports arrow, Home, and End navigation", async () => {
    const user = userEvent.setup();
    renderAddMenu();

    const trigger = screen.getByRole("button", { name: "Add to composer" });
    await user.click(trigger);

    const files = screen.getByRole("menuitem", { name: /Files/ });
    const plan = screen.getByRole("menuitemcheckbox", { name: /Plan/ });
    const ultracode = screen.getByRole("menuitemcheckbox", { name: /Ultracode/ });
    await waitFor(() => expect(files).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(plan).toHaveFocus();
    await user.keyboard("{End}");
    expect(ultracode).toHaveFocus();
    await user.keyboard("{Home}");
    expect(files).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(ultracode).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
