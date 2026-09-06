import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerAccessControls } from "../ComposerAccessControls";
import type { ComposerAgentSelection } from "../../draft/useComposerFormController";

const selection: ComposerAgentSelection = {
  modelId: "gpt-5.6-luna",
  provider: "codex",
  reasoning: "high",
  interactionMode: "build",
  permissionMode: "supervised",
  approvalReviewMode: "manual",
  orchestrationMode: "standard",
  copilotAgent: null,
  contextWindow: null,
  thinking: null,
  codexFastMode: null,
};

function renderControls(overrides: Partial<React.ComponentProps<typeof ComposerAccessControls>> = {}) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerAccessControls
      selection={selection}
      isModelLocked={false}
      permissionLocked={false}
      approvalReviewSupported
      showInlineOptions
      onSelectionChange={onSelectionChange}
      onSelectionTouched={vi.fn()}
      {...overrides}
    />,
  );
  return onSelectionChange;
}

describe("ComposerAccessControls", () => {
  it.each([
    ["Supervised", { permissionMode: "supervised", approvalReviewMode: "manual" }],
    ["Auto", { permissionMode: "supervised", approvalReviewMode: "automatic" }],
    ["Full access", { permissionMode: "full", approvalReviewMode: "manual" }],
  ] as const)("maps %s to one atomic turn selection", (label, patch) => {
    const onSelectionChange = renderControls();

    fireEvent.click(screen.getByRole("button", { name: /Access mode: Supervised/ }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
    expect(screen.queryByText("Access mode")).not.toBeInTheDocument();
  });

  it("shows Auto but prevents selecting it when the provider does not support approval review", () => {
    const onSelectionChange = renderControls({ approvalReviewSupported: false });

    fireEvent.click(screen.getByRole("button", { name: /Access mode: Supervised/ }));

    expect(screen.getByRole("button", { name: /^Auto/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
