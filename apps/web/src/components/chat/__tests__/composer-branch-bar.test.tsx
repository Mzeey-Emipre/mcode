/**
 * Tests for the ComposerBranchBar component.
 *
 * Verifies the minimal ↳ glyph layout and the absence of the old
 * gradient/border chrome.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ComposerBranchBar } from "../ComposerBranchBar";

describe("ComposerBranchBar — minimal glyph layout", () => {
  it("renders the ↳ glyph when branchFromMessageId is set", () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        branchFromMessageContent="Fix the auth bug in the login flow"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText("↳")).toBeTruthy();
  });

  it('renders "Branching from" label text', () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText("Branching from")).toBeTruthy();
  });

  it("renders italic excerpt when branchFromMessageContent is provided", () => {
    render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        branchFromMessageContent="Fix the auth bug in the login flow"
        onBranchModeExit={vi.fn()}
      />,
    );
    expect(screen.getByText(/Fix the auth bug/)).toBeTruthy();
  });

  it("does not use border-l-2 or border-l-primary chrome classes", () => {
    const { container } = render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        onBranchModeExit={vi.fn()}
      />,
    );
    // Check raw HTML to avoid CSS selector escaping issues with slash characters.
    expect(container.innerHTML).not.toContain("border-l-2");
    expect(container.innerHTML).not.toContain("border-l-primary");
  });

  it("does not use bg-gradient-to-r or from-primary gradient classes", () => {
    const { container } = render(
      <ComposerBranchBar
        branchFromMessageId="msg-1"
        onBranchModeExit={vi.fn()}
      />,
    );
    // Check raw HTML to avoid CSS selector escaping issues.
    expect(container.innerHTML).not.toContain("bg-gradient-to-r");
    expect(container.innerHTML).not.toContain("from-primary");
  });

  it("renders nothing when branchFromMessageId is absent", () => {
    const { container } = render(
      <ComposerBranchBar onBranchModeExit={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
