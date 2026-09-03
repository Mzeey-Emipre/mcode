import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import {
  useComposerDraftStore,
  type SelectedTextCommentEditorDraft,
} from "@/stores/composerDraftStore";
import { ComposerEditor } from "@/components/chat/lexical";
import { removeSelectedTextComment } from "@/features/conversation/composer/draft/composer-selected-text-comments";
import { SelectedTextCommentMarkers } from "./SelectedTextCommentMarkers";
import { SelectedTextCommentControls } from "./SelectedTextCommentControls";

const originalClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const EMPTY_COMMENTS: readonly SelectedTextComment[] = [];

const comments: SelectedTextComment[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    displayNumber: 1,
    source: {
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 0,
      end: 5,
      quote: "First",
    },
    note: "First note",
    mentions: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    displayNumber: 2,
    source: {
      threadId: "thread-1",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 6,
      end: 12,
      quote: "Second",
    },
    note: "Second note",
    mentions: [],
  },
];

function setDraft(
  selectedTextComments: SelectedTextComment[],
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft,
) {
  useComposerDraftStore.setState({
    drafts: {
      "thread-1": {
        input: "",
        attachments: [],
        modelId: "model",
        reasoning: "low",
        selectedTextComments,
        selectedTextCommentEditor,
      },
    },
  });
}

function MarkerHarness({ onOpenComment }: { readonly onOpenComment: (comment: SelectedTextComment) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) return;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
  }, []);

  return (
    <div ref={rootRef} className="relative h-30">
      <div ref={viewportRef} className="overflow-y-auto">
        <article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">
          <p data-selected-text-content="" data-selected-text-eligible="true">First Second</p>
        </article>
      </div>
      <SelectedTextCommentMarkers
        viewportRef={viewportRef}
        renderedThreadId="thread-1"
        onOpenComment={onOpenComment}
      />
    </div>
  );
}

function SourceEditorHarness({ withComposerInput = false }: { readonly withComposerInput?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<SelectedTextCommentEditorDraft>();
  const savedComments = useComposerDraftStore((state) => (
    state.drafts["thread-1"]?.selectedTextComments ?? EMPTY_COMMENTS
  ));
  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) return;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
  }, []);

  return (
    <div ref={rootRef} className="relative h-30">
      {withComposerInput && (
        <ComposerEditor
          ariaLabel="Message Mcode"
          isMentionPopupOpen={false}
          isSlashPopupOpen={false}
          onChange={() => {}}
          onMentionDismiss={() => {}}
          onMentionTrigger={() => {}}
          onSlashDismiss={() => {}}
          onSlashTrigger={() => {}}
          onSubmit={() => {}}
        />
      )}
      <div ref={viewportRef} className="overflow-y-auto">
        <article data-message-id="message-1" data-message-role="assistant" data-thread-id="thread-1">
          <p data-selected-text-content="" data-selected-text-eligible="true">First Second</p>
        </article>
      </div>
      <SelectedTextCommentMarkers
        viewportRef={viewportRef}
        renderedThreadId="thread-1"
        onOpenComment={(comment) => setEditor({
          source: comment.source,
          commentId: comment.id,
          note: comment.note,
          mentions: [],
          escapeWarned: false,
          outsideWarned: false,
          anchor: "source",
        })}
      />
      <SelectedTextCommentControls
        comments={savedComments}
        editor={editor}
        onDeleteSelectedTextComment={(comment) => {
          const draft = useComposerDraftStore.getState().drafts["thread-1"];
          if (!draft) return;
          useComposerDraftStore.setState({
            drafts: {
              "thread-1": {
                ...draft,
                selectedTextComments: removeSelectedTextComment(
                  draft.selectedTextComments ?? EMPTY_COMMENTS,
                  comment.id,
                ),
              },
            },
          });
        }}
        onSelectedTextCommentEditorChange={setEditor}
        viewportRef={viewportRef}
        renderedThreadId="thread-1"
        messageIds={["message-1"]}
      />
    </div>
  );
}

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [new DOMRect(20, 20, 80, 20)];
    },
  });
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  if (originalClientRects) Object.defineProperty(Range.prototype, "getClientRects", originalClientRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.restoreAllMocks();
});

describe("SelectedTextCommentMarkers", () => {
  it("renders one persistent highlight and focusable marker per saved comment in creation order", async () => {
    const onOpenComment = vi.fn();
    setDraft(comments);
    render(<MarkerHarness onOpenComment={onOpenComment} />);

    await waitFor(() => expect(screen.getAllByTestId("selected-text-comment-marker")).toHaveLength(2));
    expect(screen.getAllByTestId("selected-text-comment-highlight")).toHaveLength(2);
    expect(screen.getAllByTestId("selected-text-comment-highlight")[0]!.parentElement).toHaveClass("z-[1]");
    expect(screen.getAllByTestId("selected-text-comment-marker")[0]!.parentElement).toHaveClass("z-[2]");
    expect(screen.getAllByTestId("selected-text-comment-marker")[0]).toHaveAccessibleName("Open comment 1");
    expect(screen.getAllByTestId("selected-text-comment-marker")[1]).toHaveAccessibleName("Open comment 2");

    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Open comment 1" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onOpenComment).toHaveBeenNthCalledWith(1, comments[0]);
    expect(onOpenComment).toHaveBeenNthCalledWith(2, comments[0]);
  });

  it("strengthens only the linked highlight on marker hover or focus", async () => {
    setDraft(comments);
    render(<MarkerHarness onOpenComment={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByTestId("selected-text-comment-marker")).toHaveLength(2));
    const [firstMarker, secondMarker] = screen.getAllByTestId("selected-text-comment-marker");
    const [firstHighlightGroup, secondHighlightGroup] = screen.getAllByTestId("selected-text-comment-highlight");
    const firstHighlight = firstHighlightGroup!.firstElementChild;
    const secondHighlight = secondHighlightGroup!.firstElementChild;

    fireEvent.mouseEnter(secondMarker!);
    await waitFor(() => expect(firstHighlight).not.toHaveClass("bg-primary/30"));
    expect(secondHighlight).toHaveClass("bg-primary/30");

    firstMarker!.focus();
    await waitFor(() => expect(firstHighlight).toHaveClass("bg-primary/30"));
    expect(secondHighlight).not.toHaveClass("bg-primary/30");

    fireEvent.mouseEnter(firstMarker!);
    fireEvent.mouseLeave(firstMarker!);
    expect(firstHighlight).toHaveClass("bg-primary/30");
  });

  it("keeps dense, clamped markers in creation order for keyboard focus", async () => {
    const denseComments = Array.from({ length: 6 }, (_, index) => ({
      ...comments[0]!,
      id: `dense-comment-${index + 1}`,
      displayNumber: index + 1,
    }));
    setDraft(denseComments);
    render(<MarkerHarness onOpenComment={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByTestId("selected-text-comment-marker")).toHaveLength(6));
    const markers = screen.getAllByTestId("selected-text-comment-marker");
    expect(markers[3]).toHaveStyle({ top: "14px" });

    const user = userEvent.setup();
    for (const comment of denseComments) {
      await user.tab();
      expect(screen.getByRole("button", { name: `Open comment ${comment.displayNumber}` })).toHaveFocus();
    }
  });

  it("renders no marker or highlight for an unsaved editor", () => {
    setDraft([], {
      source: comments[0]!.source,
      note: "Unsaved note",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "source",
    });
    render(<MarkerHarness onOpenComment={vi.fn()} />);

    expect(screen.queryByTestId("selected-text-comment-marker")).toBeNull();
    expect(screen.queryByTestId("selected-text-comment-highlight")).toBeNull();
  });

  it("opens and closes a source editor from the marker with focus handoff", async () => {
    setDraft(comments);
    render(<SourceEditorHarness />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Open comment 1" })).toBeVisible());
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");

    const note = await screen.findByRole("textbox", { name: "Comment note" });
    await waitFor(() => expect(note).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Close comment editor" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comment on selected text" })).toBeNull());
    expect(screen.getByRole("button", { name: "Open comment 1" })).toHaveFocus();
  });

  it("returns focus to the marker after saving a marker-initiated edit", async () => {
    setDraft([comments[0]!]);
    render(<SourceEditorHarness />);

    const marker = await screen.findByRole("button", { name: "Open comment 1" });
    const user = userEvent.setup();
    await user.click(marker);
    await user.type(await screen.findByRole("textbox", { name: "Comment note" }), " updated");
    await user.click(screen.getByRole("button", { name: "Save comment" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comment on selected text" })).toBeNull());
    await waitFor(() => expect(marker).toHaveFocus());
  });

  it("deletes the saved comment behind a marker, renumbers its survivor, and returns focus", async () => {
    setDraft(comments);
    render(<SourceEditorHarness />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Open comment 1" })).toBeVisible());
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Delete comment" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open comment 2" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open comment 1" })).toHaveFocus());
  });

  it("returns focus to the composer after deleting the final marker comment", async () => {
    setDraft([comments[0]!]);
    render(<SourceEditorHarness withComposerInput />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Open comment 1" })).toBeVisible());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open comment 1" }));
    await user.click(await screen.findByRole("button", { name: "Delete comment" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open comment 1" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comment on selected text" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Mcode" })).toHaveFocus());
  });
});
