import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { saveSelectedTextComment } from "./draft/composer-selected-text-comments";
import { SelectedTextCommentsComposerAttachment } from "./SelectedTextCommentsComposerAttachment";

const comments: SelectedTextComment[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    displayNumber: 1,
    source: {
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 0,
      end: 11,
      quote: "First quote",
    },
    note: "First note\nkeeps its spacing.",
    mentions: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    displayNumber: 2,
    source: {
      threadId: "thread-1",
      messageId: "message-2",
      sourceRole: "assistant",
      start: 0,
      end: 12,
      quote: "Second quote",
    },
    note: "Second note",
    mentions: [],
  },
];

function renderAttachment(overrides: Partial<ComponentProps<typeof SelectedTextCommentsComposerAttachment>> = {}) {
  const handlers = {
    onRemove: vi.fn(),
    onOpenSource: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onFocusComposer: vi.fn(),
    onSave: vi.fn(),
    onEditorChange: vi.fn(),
  };
  return {
    ...handlers,
    ...render(<SelectedTextCommentsComposerAttachment comments={comments} {...handlers} {...overrides} />),
  };
}

afterEach(() => {
  document.querySelectorAll("article[data-message-id]").forEach((element) => element.remove());
});

describe("SelectedTextCommentsComposerAttachment", () => {
  it("keeps composer padding while right-aligning read-only sent annotations", () => {
    const handlers = {
      onRemove: vi.fn(),
      onOpenSource: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onFocusComposer: vi.fn(),
      onSave: vi.fn(),
      onEditorChange: vi.fn(),
    };
    const { getByTestId, rerender } = render(
      <SelectedTextCommentsComposerAttachment comments={[comments[0]!]} {...handlers} />,
    );

    expect(getByTestId("selected-text-comment-attachment")).toHaveClass("px-3", "pt-2");

    rerender(<SelectedTextCommentsComposerAttachment comments={[comments[0]!]} readOnly {...handlers} />);

    expect(getByTestId("selected-text-comment-attachment")).toHaveClass("relative", "z-10", "flex", "justify-end", "pt-2");
    expect(getByTestId("selected-text-comment-attachment")).not.toHaveClass("px-3");
  });

  it("opens a sent preview below its chip when the message viewport has no room above", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this.classList.contains("overflow-y-auto")) return new DOMRect(0, 100, 1_000, 600);
      if (this.dataset.testid === "selected-text-comment-preview") return new DOMRect(0, 0, 600, 200);
      if (this.classList.contains("inline-flex") && this.classList.contains("relative")) return new DOMRect(700, 140, 160, 32);
      return new DOMRect();
    });
    const handlers = {
      onRemove: vi.fn(),
      onOpenSource: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onFocusComposer: vi.fn(),
      onSave: vi.fn(),
      onEditorChange: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <div data-testid="message-list">
        <div className="overflow-y-auto">
          <SelectedTextCommentsComposerAttachment comments={[comments[0]!]} readOnly {...handlers} />
        </div>
      </div>,
    );

    await user.hover(screen.getByRole("button", { name: "1 annotation. Preview available." }));

    const preview = screen.getByTestId("selected-text-comment-preview");
    expect(preview).toHaveClass("top-[calc(100%+0.25rem)]");
    await user.hover(preview);
    expect(preview).toHaveClass("top-[calc(100%+0.25rem)]");
    rectSpy.mockRestore();
  });

  it("anchors a sent preview inside the message viewport's right inset", async () => {
    const handlers = {
      onRemove: vi.fn(),
      onOpenSource: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onFocusComposer: vi.fn(),
      onSave: vi.fn(),
      onEditorChange: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <div data-testid="message-list" className="px-8">
        <SelectedTextCommentsComposerAttachment comments={[comments[0]!]} readOnly {...handlers} />
      </div>,
    );

    await user.hover(screen.getByRole("button", { name: "1 annotation. Preview available." }));

    const preview = screen.getByTestId("selected-text-comment-preview");
    expect(preview).toHaveClass("right-0", "left-auto");
    expect(preview).not.toHaveClass("left-0");
  });

  it("assigns each attachment chip its own preview relationship", () => {
    const handlers = {
      onRemove: vi.fn(),
      onOpenSource: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onFocusComposer: vi.fn(),
      onSave: vi.fn(),
      onEditorChange: vi.fn(),
    };
    render(
      <>
        <SelectedTextCommentsComposerAttachment comments={comments} {...handlers} />
        <SelectedTextCommentsComposerAttachment comments={comments} {...handlers} />
      </>,
    );

    const previewIds = screen
      .getAllByRole("button", { name: "2 annotations. Preview available." })
      .map((button) => button.getAttribute("aria-controls"));

    expect(previewIds).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(previewIds).size).toBe(2);
  });

  it("shows an annotation preview with navigation-only source cards and direct removal", async () => {
    const user = userEvent.setup();
    const { onDelete, onEdit, onOpenSource, onRemove } = renderAttachment({
      unavailableSourceCommentIds: [comments[1]!.id],
    });
    const annotationCount = screen.getByRole("button", { name: "2 annotations. Preview available." });

    expect(screen.getByTestId("selected-text-comment-chip")).toHaveClass("h-8");
    expect(annotationCount).toHaveTextContent("2 annotations");
    expect(screen.queryByTestId("selected-text-comment-preview")).toBeNull();

    await user.hover(annotationCount);

    const preview = screen.getByTestId("selected-text-comment-preview");
    expect(preview).toHaveClass("w-[min(38rem,calc(100vw-1.5rem))]");
    expect(preview).toHaveClass("bottom-[calc(100%+0.25rem)]");
    const firstItem = within(preview).getByTestId("selected-text-comment-preview-item-1");
    expect(firstItem).toHaveTextContent(/1\. Selected text:[\s\S]*First quote[\s\S]*User comment:[\s\S]*First note/);
    expect(within(preview).getByText("2. Selected text:")).toBeVisible();
    expect(within(preview).getAllByText("User comment:")).toHaveLength(2);
    expect(within(firstItem).getByText("First quote")).not.toHaveClass("font-mono", "rounded-md");
    expect(within(preview).getByText("Source unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open source for comment 1" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open source for comment 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete comment 1" })).toBeNull();

    await user.hover(firstItem);

    expect(screen.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete comment 1" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete comment 2" })).toBeNull();

    await user.hover(within(preview).getByTestId("selected-text-comment-preview-item-2"));

    expect(screen.getByRole("button", { name: "Edit comment 2" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete comment 2" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete comment 1" })).toBeNull());

    await user.unhover(annotationCount);
    await waitFor(() => expect(screen.queryByTestId("selected-text-comment-preview")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Remove 2 annotations" }));
    expect(onRemove).toHaveBeenCalledOnce();
    await user.hover(annotationCount);

    const reopenedPreview = screen.getByTestId("selected-text-comment-preview");
    await user.hover(within(reopenedPreview).getByTestId("selected-text-comment-preview-item-1"));
    await user.click(screen.getByRole("button", { name: "Open source for comment 1" }));
    await user.hover(within(reopenedPreview).getByTestId("selected-text-comment-preview-item-2"));
    await user.click(screen.getByRole("button", { name: "Delete comment 2" }));

    expect(onOpenSource).toHaveBeenCalledWith(comments[0]);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(comments[1]);
  });

  it("opens a single annotation preview on keyboard focus without an item delete control", async () => {
    const user = userEvent.setup();
    renderAttachment({ comments: [comments[0]!] });

    await user.tab();

    expect(screen.getByRole("button", { name: "1 annotation. Preview available." })).toHaveFocus();
    const preview = screen.getByTestId("selected-text-comment-preview");
    expect(within(preview).getByText("1. Selected text:")).toBeVisible();
    expect(within(preview).queryByRole("button", { name: "Delete comment 1" })).toBeNull();

    await user.tab();
    await user.tab();

    expect(screen.getByRole("button", { name: "Open source for comment 1" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
  });

  it("shows quote controls only after rendered overflow, then collapses an expanded quote", async () => {
    const user = userEvent.setup();
    renderAttachment({ comments: [comments[0]!] });
    const annotationCount = screen.getByRole("button", { name: "1 annotation. Preview available." });

    await user.hover(annotationCount);

    const quote = within(screen.getByTestId("selected-text-comment-preview-item-1")).getByText("First quote");
    expect(screen.queryByRole("button", { name: "Show full quote" })).toBeNull();
    Object.defineProperties(quote, {
      clientHeight: { configurable: true, value: 20 },
      scrollHeight: { configurable: true, value: 80 },
    });
    fireEvent(window, new Event("resize"));

    await user.click(await screen.findByRole("button", { name: "Show full quote" }));
    expect(screen.getByRole("button", { name: "Collapse quote" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Collapse quote" }));
    expect(screen.getByRole("button", { name: "Show full quote" })).toBeVisible();
  });

  it("keeps a selected card editor reachable inside its annotation preview", async () => {
    const user = userEvent.setup();
    const editor = {
      source: comments[0]!.source,
      commentId: comments[0]!.id,
      note: comments[0]!.note,
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "card" as const,
    };
    renderAttachment({ comments: [comments[0]!], editor });

    await user.hover(screen.getByRole("button", { name: "1 annotation. Preview available." }));

    expect(await screen.findByRole("textbox", { name: "Comment note" })).toHaveTextContent(/First note\s*keeps its spacing\./);
    expect(screen.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
  });

  it("returns focus to an unavailable source card after its editor closes", async () => {
    const editor = {
      source: comments[0]!.source,
      commentId: comments[0]!.id,
      note: comments[0]!.note,
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "card" as const,
    };
    function StatefulAttachment() {
      const [currentEditor, setCurrentEditor] = useState<SelectedTextCommentEditorDraft | undefined>(editor);
      return (
        <SelectedTextCommentsComposerAttachment
          comments={comments.slice(0, 1)}
          editor={currentEditor}
          unavailableSourceCommentIds={[comments[0]!.id]}
          onRemove={vi.fn()}
          onOpenSource={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onFocusComposer={vi.fn()}
          onSave={vi.fn()}
          onEditorChange={setCurrentEditor}
        />
      );
    }

    const user = userEvent.setup();
    render(<StatefulAttachment />);
    await user.hover(screen.getByRole("button", { name: "1 annotation. Preview available." }));
    await user.click(await screen.findByRole("button", { name: "Close comment editor" }));

    await waitFor(() => expect(screen.getByTestId("selected-text-comment-preview-item-1")).toHaveFocus());
  });

  it("deletes one preview item, renumbers its survivor, announces the deletion, and returns focus", async () => {
    function StatefulAttachment() {
      const [currentComments, setCurrentComments] = useState(comments);
      return (
        <SelectedTextCommentsComposerAttachment
          comments={currentComments}
          onRemove={() => setCurrentComments([])}
          onOpenSource={vi.fn()}
          onEdit={vi.fn()}
          onDelete={(comment) => setCurrentComments((current) => current
            .filter((candidate) => candidate.id !== comment.id)
            .map((candidate, index) => ({ ...candidate, displayNumber: index + 1 })))}
          onFocusComposer={vi.fn()}
          onSave={vi.fn()}
          onEditorChange={vi.fn()}
        />
      );
    }

    const user = userEvent.setup();
    render(<StatefulAttachment />);
    await user.hover(screen.getByRole("button", { name: "2 annotations. Preview available." }));
    await user.hover(screen.getByTestId("selected-text-comment-preview-item-1"));
    await user.click(screen.getByRole("button", { name: "Delete comment 1" }));

    await waitFor(() => expect(screen.queryByTestId("selected-text-comment-preview-item-2")).toBeNull());
    const preview = screen.getByTestId("selected-text-comment-preview");
    expect(within(preview).getByText("1. Selected text:")).toBeVisible();
    expect(within(preview).getByText("Second note")).toBeVisible();
    expect(within(preview).queryByText("2. Selected text:")).toBeNull();
    expect(within(preview).queryByRole("button", { name: "Delete comment 1" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Comment deleted.");
    expect(document.activeElement).toHaveAccessibleName("Open source for comment 1");
  });

  it("keeps an unavailable new-comment draft docked until it saves as annotation 1", async () => {
    const user = userEvent.setup();
    const editor = {
      source: comments[0]!.source,
      note: "Unsaved unavailable note",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "card" as const,
    };
    function StatefulAttachment() {
      const [currentComments, setCurrentComments] = useState<SelectedTextComment[]>([]);
      const [currentEditor, setCurrentEditor] = useState<SelectedTextCommentEditorDraft | undefined>(editor);
      return (
        <SelectedTextCommentsComposerAttachment
          comments={currentComments}
          editor={currentEditor}
          onRemove={vi.fn()}
          onOpenSource={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onFocusComposer={vi.fn()}
          onSave={(comment) => setCurrentComments((current) => saveSelectedTextComment(current, comment))}
          onEditorChange={setCurrentEditor}
        />
      );
    }

    render(<StatefulAttachment />);

    expect(screen.getByTestId("selected-text-comment-docked-editor")).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "Comment note" })).toHaveTextContent(editor.note);
    expect(screen.queryByText("1. Selected text:")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add comment" }));

    const annotationCount = screen.getByRole("button", { name: "1 annotation. Preview available." });
    expect(screen.queryByTestId("selected-text-comment-preview")).toBeNull();
    await user.hover(annotationCount);
    expect(await screen.findByTestId("selected-text-comment-preview-item-1")).toHaveTextContent(editor.note);
    expect(screen.queryByTestId("selected-text-comment-docked-editor")).toBeNull();
  });

  it("keeps the unavailable new-comment draft in the existing dirty dismissal flow", () => {
    const editor = {
      source: comments[0]!.source,
      note: "Unsaved unavailable note",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "card" as const,
    };
    function StatefulAttachment() {
      const [currentEditor, setCurrentEditor] = useState<SelectedTextCommentEditorDraft | undefined>(editor);
      return (
        <SelectedTextCommentsComposerAttachment
          comments={[]}
          editor={currentEditor}
          onRemove={vi.fn()}
          onOpenSource={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onFocusComposer={vi.fn()}
          onSave={vi.fn()}
          onEditorChange={setCurrentEditor}
        />
      );
    }

    render(<StatefulAttachment />);

    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("status")).toHaveTextContent("Repeat this action to discard this comment.");
    expect(screen.getByRole("dialog", { name: "Comment on selected text" })).toBeVisible();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Comment on selected text" })).toBeNull();
  });
});
