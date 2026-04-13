import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";

// Mock MarkdownContent to detect when it's used
vi.mock("../components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
  MarkdownContent: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
}));

const makeMessage = (content: string) => ({
  id: "msg-1",
  thread_id: "thread-1",
  role: "user" as const,
  content,
  timestamp: new Date().toISOString(),
  attachments: [],
  cost_usd: null,
  tokens_used: null,
  sequence: 1,
});

describe("MessageBubble user messages", () => {
  it("renders user message through MarkdownContent with variant='user'", async () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    await waitFor(() => {
      const md = container.querySelector("[data-testid='markdown-content']");
      expect(md).toBeInTheDocument();
      expect(md?.getAttribute("data-variant")).toBe("user");
    });
  });

  it("does not render user message as plain <p>", async () => {
    const { container } = render(
      <MessageBubble message={makeMessage("Hello **world**")} />,
    );
    await waitFor(() => {
      const plainP = container.querySelector("p.whitespace-pre-wrap");
      expect(plainP).not.toBeInTheDocument();
    });
  });
});
