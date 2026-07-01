import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message, StoredAttachment } from "@/transport";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
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

vi.mock("../components/chat/ImageAttachmentLightbox", () => ({
  ImageAttachmentLightbox: ({
    open,
    items,
    initialIndex = 0,
  }: {
    open: boolean;
    items: { src: string; title: string }[];
    initialIndex?: number;
  }) =>
    open ? (
      <div
        data-testid="mock-lightbox"
        data-slide-count={String(items.length)}
        data-initial-index={String(initialIndex)}
        data-active-src={items[initialIndex]?.src ?? ""}
        data-active-title={items[initialIndex]?.title ?? ""}
      />
    ) : null,
}));

function makeMessage(content: string): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    attachments: [] as StoredAttachment[],
    cost_usd: null,
    tokens_used: null,
    sequence: 1,
    tool_calls: null,
    files_changed: null,
  };
}

function makePreviewAnnotationBundle(): PreviewAnnotationBundle {
  return {
    schemaVersion: 1,
    annotations: [
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        displayNumber: 1,
        pageIdentity: "http://localhost:44354/product-preview",
        pageContext: {
          schemaVersion: 2,
          pageUrl: "http://localhost:44354/product-preview",
          pageTitle: "Product preview",
          capturedAt: new Date().toISOString(),
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
        },
        targetContext: {
          label: "html",
          selectorHint: "html",
          bounds: { x: 12, y: 16, width: 240, height: 80 },
        },
        note: "Make the product content flush with the edge on narrow screens.",
        snapshot: {
          id: "shot-1",
          name: "annotation.png",
          mimeType: "image/png",
          sizeBytes: 128,
          sourcePath: "preview/annotation.png",
          capture: {
            schemaVersion: 2,
            pageUrl: "http://localhost:44354/product-preview",
            pageTitle: "Product preview",
            capturedAt: new Date().toISOString(),
            bounds: { x: 12, y: 16, width: 240, height: 80 },
          },
        },
      },
    ],
  };
}

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

  it("renders leading /goal set commands as stripped user bubbles with a receipt", async () => {
    const { container, getByText, queryByText } = render(
      <MessageBubble message={makeMessage("/goal ship the release")} />,
    );
    await waitFor(() => {
      expect(getByText("ship the release")).toBeInTheDocument();
    });
    expect(queryByText("/goal ship the release")).not.toBeInTheDocument();
    expect(getByText("Sent as goal")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='goal-pill']")).toBeNull();
  });

  it("opens image preview when user activates an image attachment control", async () => {
    const user = userEvent.setup();
    const threadUuid = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeMessage(""),
      thread_id: threadUuid,
      attachments: [
        {
          id: "a1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);
    const btn = container.querySelector('[aria-label="Preview image shot.png"]');
    expect(btn).toBeTruthy();
    await user.click(btn!);
    const lb = container.querySelector("[data-testid='mock-lightbox']");
    expect(lb).toBeTruthy();
    expect(lb?.getAttribute("data-slide-count")).toBe("1");
    expect(lb?.getAttribute("data-initial-index")).toBe("0");
    expect(lb?.getAttribute("data-active-src")).toBe(
      `mcode-attachment://${threadUuid}/a1.png`,
    );
    expect(lb?.getAttribute("data-active-title")).toBe("shot.png");
  });

  it("passes full slide tray and clicked index when several images attach", async () => {
    const user = userEvent.setup();
    const threadUuid = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeMessage(""),
      thread_id: threadUuid,
      attachments: [
        {
          id: "a1",
          name: "one.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
        {
          id: "a2",
          name: "two.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);
    const btn = container.querySelector('[aria-label="Preview image two.png"]');
    expect(btn).toBeTruthy();
    await user.click(btn!);
    const lb = container.querySelector("[data-testid='mock-lightbox']");
    expect(lb?.getAttribute("data-slide-count")).toBe("2");
    expect(lb?.getAttribute("data-initial-index")).toBe("1");
    expect(lb?.getAttribute("data-active-src")).toBe(
      `mcode-attachment://${threadUuid}/a2.png`,
    );
    expect(lb?.getAttribute("data-active-title")).toBe("two.png");
  });

  it("renders sent preview annotation chips for annotation-only messages", () => {
    const message: Message = {
      ...makeMessage(""),
      previewAnnotations: makePreviewAnnotationBundle(),
    };

    const { getByTestId, queryByText } = render(<MessageBubble message={message} />);

    expect(getByTestId("sent-preview-annotation-bundle-chip")).toHaveTextContent(
      "1 annotation",
    );
    expect(queryByText("bundle")).not.toBeInTheDocument();
  });

  it("uses an annotation reply fallback for annotation-only messages", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn();
    const message: Message = {
      ...makeMessage(""),
      previewAnnotations: makePreviewAnnotationBundle(),
    };

    const { getByLabelText } = render(
      <MessageBubble message={message} onReply={onReply} />,
    );

    await user.click(getByLabelText("Reply to this message"));

    expect(onReply).toHaveBeenCalledWith("msg-1", "[Annotation]", "user");
  });
});

describe("MessageBubble assistant plan-questions suppression", () => {
  const makeAssistantMessage = (content: string): Message => ({
    id: "msg-asst",
    thread_id: "thread-1",
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
    attachments: [] as StoredAttachment[],
    cost_usd: null,
    tokens_used: null,
    sequence: 2,
    tool_calls: null,
    files_changed: null,
  });

  it("renders goal-cleared receipts once", () => {
    const { container } = render(
      <MessageBubble message={makeAssistantMessage("Goal cleared.")} />,
    );

    expect(container.querySelector("[data-testid='goal-pill']")).toBeInTheDocument();
    expect((container.textContent ?? "").match(/Goal cleared/g)).toHaveLength(1);
  });

  it("renders Goal achieved as a milestone receipt, not a faint hairline pill", () => {
    const { container, getByText } = render(
      <MessageBubble message={makeAssistantMessage("Goal achieved in 42s.")} />,
    );

    // Same receipt vocabulary as the user-side "Sent as goal" marker.
    expect(container.querySelector("[data-testid='goal-receipt']")).toBeInTheDocument();
    expect(getByText("Goal achieved")).toBeInTheDocument();
    expect(getByText("in 42s")).toBeInTheDocument();
    // Not the hairline chapter-break used for control acknowledgements.
    expect(container.querySelector("[data-testid='goal-pill']")).toBeNull();
  });

  it("renders nothing when the assistant body is exclusively a plan-questions block", () => {
    const planQuestionsOnly = [
      "```plan-questions",
      JSON.stringify([
        {
          id: "q1",
          category: "ARCHITECTURE",
          question: "Which approach?",
          options: [
            { id: "o1", title: "A", description: "First" },
            { id: "o2", title: "B", description: "Second" },
          ],
        },
      ]),
      "```",
    ].join("\n");

    const { container } = render(
      <MessageBubble message={makeAssistantMessage(planQuestionsOnly)} />,
    );
    // The wizard renders the questions; an empty assistant bubble must not show
    // up as a stray ASSISTANT header with no body.
    expect(container.textContent ?? "").not.toMatch(/assistant/i);
    expect(container.querySelector("[data-testid='markdown-content']")).toBeNull();
  });

  it("still renders the assistant bubble when prose surrounds the plan-questions block", () => {
    const mixed = [
      "Here are some questions:",
      "```plan-questions",
      "[]",
      "```",
      "Let me know.",
    ].join("\n");

    const { container } = render(
      <MessageBubble message={makeAssistantMessage(mixed)} />,
    );
    expect(container.querySelector("[data-testid='markdown-content']")).not.toBeNull();
  });

  it("renders nothing when the assistant body is only whitespace", () => {
    const { container } = render(
      <MessageBubble message={makeAssistantMessage("   \n  \n")} />,
    );
    expect(container.textContent ?? "").not.toMatch(/assistant/i);
  });

  it("renders assistant image attachments even when the text body is empty", async () => {
    const user = userEvent.setup();
    const threadUuid = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeAssistantMessage(""),
      thread_id: threadUuid,
      attachments: [
        {
          id: "img-1",
          name: "generated.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);

    const tray = container.querySelector("[data-testid='assistant-image-attachments']");
    expect(tray).toBeTruthy();
    const btn = container.querySelector('[aria-label="Preview image generated.png"]');
    expect(btn).toBeTruthy();
    expect(container.querySelector("[data-testid='markdown-content']")).toBeNull();

    await user.click(btn!);
    const lb = container.querySelector("[data-testid='mock-lightbox']");
    expect(lb?.getAttribute("data-active-src")).toBe(
      `mcode-attachment://${threadUuid}/img-1.png`,
    );
    expect(lb?.getAttribute("data-active-title")).toBe("generated.png");
  });
});
