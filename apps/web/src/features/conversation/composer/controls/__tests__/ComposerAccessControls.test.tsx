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
    ["Manual", { permissionMode: "supervised", approvalReviewMode: "manual" }],
    ["Auto", { permissionMode: "supervised", approvalReviewMode: "automatic" }],
    ["Full access", { permissionMode: "full", approvalReviewMode: "manual" }],
  ] as const)("maps %s to one atomic turn selection", (label, patch) => {
    const onSelectionChange = renderControls();

    fireEvent.click(screen.getByRole("button", { name: /Access mode: Manual/ }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
    expect(screen.queryByText("Access mode")).not.toBeInTheDocument();
  });

  it.each([["inline", true], ["menu", false]] as const)("shows only Manual and Full access in the %s control when the provider does not support approval review", (_surface, showInlineOptions) => {
    renderControls({ approvalReviewSupported: false, showInlineOptions });

    fireEvent.click(screen.getByRole("button", { name: /Access mode: Manual/ }));

    expect(screen.getByRole("button", { name: /^Manual/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Full access/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Auto/ })).not.toBeInTheDocument();
  });

  it("updates the picker when switching from an Auto provider to a provider without Auto", () => {
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <ComposerAccessControls
        selection={{ ...selection, approvalReviewMode: "automatic" }}
        isModelLocked={false}
        permissionLocked={false}
        approvalReviewSupported
        showInlineOptions={false}
        onSelectionChange={onSelectionChange}
        onSelectionTouched={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Access mode: Auto/ })).toBeInTheDocument();
    rerender(
      <ComposerAccessControls
        selection={{ ...selection, approvalReviewMode: "automatic" }}
        isModelLocked={false}
        permissionLocked={false}
        approvalReviewSupported={false}
        showInlineOptions={false}
        onSelectionChange={onSelectionChange}
        onSelectionTouched={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Access mode: Manual/ }));

    expect(screen.queryByRole("button", { name: /^Auto/ })).not.toBeInTheDocument();
  });
});
