/**
 * Tests for the ScrollToBottomButton sub-component.
 *
 * Verifies that the button signals new content via a calm color shift to the
 * primary palette rather than an attention-grabbing pulse animation.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ScrollToBottomButton } from "../MessageList";

describe("ScrollToBottomButton", () => {
  it("uses primary color tokens when hasNewContent is true", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={true}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /new messages below/i });
    expect(btn.className).toContain("text-primary");
    expect(btn.className).toContain("bg-primary/15");
  });

  it("uses no animation classes (calm, not attention-grabbing)", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={true}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /new messages below/i });
    expect(btn.className).not.toContain("animate-pulse");
    expect(btn.className).not.toContain("animate-bounce");
  });

  it("uses muted background when hasNewContent is false", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={false}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /scroll to bottom/i });
    expect(btn.className).toContain("bg-background/80");
    expect(btn.className).not.toContain("animate-pulse");
    expect(btn.className).not.toContain("animate-bounce");
  });
});
