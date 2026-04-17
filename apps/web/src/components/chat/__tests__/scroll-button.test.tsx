/**
 * Tests for the ScrollToBottomButton sub-component.
 *
 * Verifies that the button uses animate-pulse (not animate-bounce) when new
 * content has arrived while the user is scrolled up.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ScrollToBottomButton } from "../MessageList";

describe("ScrollToBottomButton", () => {
  it("applies animate-pulse when hasNewContent is true", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={true}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /new messages below/i });
    expect(btn.className).toContain("animate-pulse");
  });

  it("does NOT apply animate-bounce when hasNewContent is true", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={true}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /new messages below/i });
    expect(btn.className).not.toContain("animate-bounce");
  });

  it("applies neither animate-pulse nor animate-bounce when hasNewContent is false", () => {
    render(
      <ScrollToBottomButton
        hasNewContent={false}
        onScrollToBottom={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /scroll to bottom/i });
    expect(btn.className).not.toContain("animate-pulse");
    expect(btn.className).not.toContain("animate-bounce");
  });
});
