import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message, StoredAttachment } from "@/transport";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { MessageBubble } from "../MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import {
  clearAttachmentTransportWsUrlCache,
  setAttachmentTransportWsUrl,
} from "@/lib/attachment-url";

// Mock MarkdownContent to detect when it's used
vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
  MarkdownContent: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-content" data-variant={variant}>{content}</div>
  ),
}));

vi.mock("@/components/chat/ImageAttachmentLightbox", () => ({
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

function makeCodeCommentBundle(): PreviewAnnotationBundle {
  return {
    schemaVersion: 1,
    annotations: [
      {
        kind: "diff",
        id: "550e8400-e29b-41d4-a716-446655440002",
        displayNumber: 1,
        filePath: "apps/web/src/features/conversation/composer/Composer.tsx",
        side: "right",
        line: 946,
        lineContent: "const diffAnnotationRows = usePreviewAnnotationStore(...);",
        note: "Keep this review target attached to the next prompt.",
      },
    ],
  };
}

function makeMixedFeedbackBundle(): PreviewAnnotationBundle {
  const preview = makePreviewAnnotationBundle().annotations[0];
  const comment = makeCodeCommentBundle().annotations[0];
  return {
    schemaVersion: 1,
    annotations: [preview, { ...comment, displayNumber: 2 }],
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

  it("renders persisted selected-text comments as read-only annotation chips", async () => {
    const user = userEvent.setup();
    const message: Message = {
      ...makeMessage("Please explain this."),
      selectedTextComments: [{
        id: "550e8400-e29b-41d4-a716-446655440003",
        displayNumber: 1,
        source: {
          threadId: "thread-1",
          messageId: "completed-user-message",
          sourceRole: "user",
          start: 3,
          end: 8,
          quote: "focus",
        },
        note: "Explain this choice.",
        mentions: [],
      }],
    };

    const { container, getByRole, getByTestId, queryByRole, queryByTestId } = render(<MessageBubble message={message} />);
    const chip = getByRole("button", { name: "1 annotation. Preview available." });
    const attachment = getByTestId("selected-text-comment-attachment");
    const textBubble = container.querySelector("[data-selected-text-content]");

    expect(attachment).toHaveAttribute("data-selected-text-exclude", "true");
    expect(attachment.compareDocumentPosition(textBubble!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(attachment).toHaveClass("flex", "justify-end", "relative", "z-10");
    expect(getByTestId("selected-text-comment-chip")).toHaveClass("h-8");
    expect(queryByRole("button", { name: "Remove 1 annotation" })).not.toBeInTheDocument();

    await user.hover(chip);

    expect(getByTestId("selected-text-comment-preview")).toHaveTextContent("focus");
    expect(getByTestId("selected-text-comment-preview")).toHaveTextContent("Explain this choice.");
    expect(queryByRole("button", { name: "Open source for comment 1" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "Edit comment 1" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "Delete comment 1" })).not.toBeInTheDocument();

    await user.unhover(chip);
    await waitFor(() => {
      expect(queryByTestId("selected-text-comment-preview")).not.toBeInTheDocument();
    });
    fireEvent.focus(chip);

    expect(getByTestId("selected-text-comment-preview")).toHaveTextContent("focus");
  });

  it("preserves selected entity identity in the sent user bubble", () => {
    const content = "Use /impeccable with @reviewer_qa on @src/App.ts";
    const commandStart = content.indexOf("/impeccable");
    const agentStart = content.indexOf("@reviewer_qa");
    const fileStart = content.indexOf("@src/App.ts");
    const message: Message = {
      ...makeMessage(content),
      mentions: [
        {
          id: "command:skill:impeccable",
          kind: "command",
          label: "impeccable",
          namespace: "skill",
          range: { start: commandStart, end: commandStart + "/impeccable".length },
        },
        {
          id: "agent:reviewer_qa",
          kind: "agent",
          label: "reviewer_qa",
          name: "reviewer_qa",
          path: "agents/reviewer-qa.toml",
          provider: "codex",
          range: { start: agentStart, end: agentStart + "@reviewer_qa".length },
        },
        {
          id: "file:src/App.ts",
          kind: "file",
          label: "src/App.ts",
          path: "src/App.ts",
          range: { start: fileStart, end: fileStart + "@src/App.ts".length },
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);
    const command = container.querySelector('[data-entity-token="skill"]');
    expect(command).toHaveTextContent("impeccable");
    expect(command).toHaveClass("text-primary");
    expect(command).not.toHaveClass("bg-muted", "ring-1", "rounded-md");
    expect(command?.querySelector("[data-entity-icon='skill']")).toHaveClass("text-current");
    expect(container.querySelector('[data-entity-token="agent"]')).toHaveTextContent("@reviewer_qa");
    expect(container.querySelector('[data-entity-token="file"]')).toHaveTextContent("@App.ts");
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

  it("retries a sent image attachment before replacing it with the broken-image fallback", async () => {
    vi.useFakeTimers();
    try {
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
      const img = container.querySelector('img[alt="shot.png"]');
      expect(img).toHaveAttribute("src", `mcode-attachment://${threadUuid}/a1.png`);

      fireEvent.error(img!);

      expect(container.querySelector('img[alt="shot.png"]')).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      expect(container.querySelector('img[alt="shot.png"]')).toHaveAttribute(
        "src",
        `mcode-attachment://${threadUuid}/a1.png?mcodeRetry=1`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates mounted image and lightbox sources when the transport becomes ready", async () => {
    const user = userEvent.setup();
    const threadId = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeMessage(""),
      thread_id: threadId,
      attachments: [
        {
          id: "sent-image",
          name: "sent.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    };

    clearAttachmentTransportWsUrlCache();
    try {
      const { getByAltText, getByTestId } = render(<MessageBubble message={message} />);
      const image = getByAltText("sent.png");

      expect(image).toHaveAttribute(
        "src",
        `mcode-attachment://${threadId}/sent-image.png`,
      );
      await user.click(image);
      expect(getByTestId("mock-lightbox")).toHaveAttribute(
        "data-active-src",
        `mcode-attachment://${threadId}/sent-image.png`,
      );

      await act(async () => {
        setAttachmentTransportWsUrl("ws://127.0.0.1:19400");
      });

      expect(image).toHaveAttribute(
        "src",
        `http://127.0.0.1:19400/attachments/${threadId}/sent-image.png`,
      );
      expect(getByTestId("mock-lightbox")).toHaveAttribute(
        "data-active-src",
        `http://127.0.0.1:19400/attachments/${threadId}/sent-image.png`,
      );
    } finally {
      clearAttachmentTransportWsUrlCache();
    }
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
    expect(getByTestId("sent-preview-annotation-bundle-chip")).toHaveClass(
      "bg-accent",
      "text-accent-foreground",
    );
    expect(queryByText("bundle")).not.toBeInTheDocument();
  });

  it("labels code review feedback as comments", async () => {
    const user = userEvent.setup();
    const message: Message = {
      ...makeMessage(""),
      previewAnnotations: makeCodeCommentBundle(),
    };

    const { findByText, getByTestId } = render(<MessageBubble message={message} />);

    expect(getByTestId("sent-preview-annotation-bundle-chip")).toHaveTextContent(
      "1 comment",
    );
    await user.hover(getByTestId("sent-preview-annotation-bundle-chip"));
    expect(await findByText("Comment")).toBeVisible();
  });

  it("keeps annotations and comments distinct in mixed feedback", () => {
    const message: Message = {
      ...makeMessage(""),
      previewAnnotations: makeMixedFeedbackBundle(),
    };

    const { getByTestId } = render(<MessageBubble message={message} />);

    expect(getByTestId("sent-preview-annotation-bundle-chip")).toHaveTextContent(
      "1 annotation · 1 comment",
    );
  });

  it("shows each annotation screenshot thumbnail in the chip hover", async () => {
    const user = userEvent.setup();
    const threadUuid = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeMessage(""),
      thread_id: threadUuid,
      previewAnnotations: makePreviewAnnotationBundle(),
    };

    const { findByTestId, getByTestId } = render(<MessageBubble message={message} />);

    await user.hover(getByTestId("sent-preview-annotation-bundle-chip"));

    expect(await findByTestId("preview-annotation-hover-thumbnail")).toHaveAttribute(
      "src",
      `mcode-attachment://${threadUuid}/shot-1.png`,
    );
    expect(await findByTestId("preview-annotation-hover-thumbnail")).toHaveClass(
      "object-contain",
    );
    expect(document.querySelector('[data-slot="tooltip-arrow"]')).toHaveClass(
      "bg-popover",
      "fill-popover",
    );
  });

  it("renders preview annotation screenshots as inspectable image attachments", async () => {
    const user = userEvent.setup();
    const threadUuid = "550e8400-e29b-41d4-a716-446655440000";
    const message: Message = {
      ...makeMessage(""),
      thread_id: threadUuid,
      previewAnnotations: makePreviewAnnotationBundle(),
      attachments: [
        {
          id: "shot-1",
          name: "Annotation 1 screenshot.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    };

    const { container, getByTestId } = render(<MessageBubble message={message} />);
    const btn = container.querySelector(
      '[aria-label="Preview image Annotation 1 screenshot.png"]',
    );
    expect(btn).toBeTruthy();

    await user.click(btn!);

    expect(getByTestId("sent-preview-annotation-bundle-chip")).toHaveTextContent(
      "1 annotation",
    );
    const lb = container.querySelector("[data-testid='mock-lightbox']");
    expect(lb?.getAttribute("data-active-src")).toBe(
      `mcode-attachment://${threadUuid}/shot-1.png`,
    );
    expect(lb?.getAttribute("data-active-title")).toBe("Annotation 1 screenshot.png");
  });

});

describe("MessageBubble agent response state", () => {
  const makeAgentMessage = (): Message => ({
    ...makeMessage("Completed response"),
    role: "assistant",
    model: "gpt-5.6",
    tokens_used: 128,
    cost_usd: 0.0123,
    timestamp: "2026-08-27T11:12:00.000Z",
  });

  it("shows completed metadata while keeping response actions hover-only", () => {
    const { getByTestId } = render(
      <MessageBubble
        message={makeAgentMessage()}
        onBranch={vi.fn()}
        agentDisplayState={{ phase: "completed" }}
      />,
    );

    expect(getByTestId("agent-message-metadata")).toHaveTextContent("128 tok");
    expect(getByTestId("agent-message-actions")).toHaveClass(
      "opacity-0",
      "group-hover/msg:opacity-100",
      "group-focus-within/msg:opacity-100",
    );
  });

  it("withholds metadata and response actions until the agent completes", () => {
    const { queryByTestId } = render(
      <MessageBubble
        message={makeAgentMessage()}
        onBranch={vi.fn()}
        agentDisplayState={{ phase: "finalizing" }}
      />,
    );

    expect(queryByTestId("agent-message-metadata")).not.toBeInTheDocument();
    expect(queryByTestId("agent-message-actions")).not.toBeInTheDocument();
  });
});

describe("MessageBubble provider notices", () => {
  afterEach(() => resetThreadStoreForTests());

  it("suppresses only notices represented by the current Composer collection", () => {
    const notice: Message = {
      ...makeMessage("Review the workspace permissions."),
      role: "system",
      systemNotice: {
        kind: "security",
        presentation: "timeline",
        scope: "turn",
        noticeKey: "security-warning",
      },
    };

    resetThreadStoreForTests({
      records: new Map([["thread-1", {
        ...createEmptyThreadRecord(),
        sessionNotices: [notice],
      }]]),
    });

    const { container, rerender } = render(<MessageBubble message={notice} />);
    expect(container).toBeEmptyDOMElement();

    resetThreadStoreForTests({
      records: new Map([["thread-1", createEmptyThreadRecord()]]),
    });
    rerender(<MessageBubble message={notice} />);

    expect(container).toHaveTextContent("Review the workspace permissions.");
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
