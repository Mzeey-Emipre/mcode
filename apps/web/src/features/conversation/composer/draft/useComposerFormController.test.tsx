import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import { useComposerFormController } from "./useComposerFormController";

const comment: SelectedTextComment = {
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: {
    threadId: "thread-1",
    messageId: "message-1",
    sourceRole: "assistant",
    start: 0,
    end: 5,
    quote: "focus",
  },
  note: "Saved note",
  mentions: [],
};

describe("useComposerFormController selected-text drafts", () => {
  it("keeps a saved card when the source editor closes in the same update batch", () => {
    const { result } = renderHook(() => useComposerFormController({ isNewThread: true }));
    const editor = {
      source: comment.source,
      note: "Unsaved note",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "source" as const,
    };

    act(() => {
      result.current.setSelectedTextComments([comment], editor);
      result.current.setSelectedTextCommentEditor(undefined);
    });

    expect(result.current.state).toMatchObject({
      selectedTextComments: [comment],
      selectedTextCommentEditor: undefined,
    });
  });

  it("requires a repeat submission attempt before discarding a dirty editor", () => {
    const { result } = renderHook(() => useComposerFormController({ isNewThread: true }));

    act(() => {
      result.current.setSelectedTextCommentEditor({
        source: comment.source,
        note: "Unsaved note",
        mentions: [],
        escapeWarned: false,
        outsideWarned: false,
        anchor: "card",
      });
    });

    expect(result.current.state.selectedTextComments).toEqual([]);

    let firstAttempt: string | null = null;
    act(() => {
      firstAttempt = result.current.requestSelectedTextCommentEditorDismissal();
    });
    expect(firstAttempt).toBe("Repeat this action to discard this comment.");
    expect(result.current.state.selectedTextCommentEditor?.outsideWarned).toBe(true);

    let secondAttempt: string | null = null;
    act(() => {
      secondAttempt = result.current.requestSelectedTextCommentEditorDismissal();
    });
    expect(secondAttempt).toBeNull();
    expect(result.current.state.selectedTextCommentEditor).toBeUndefined();
  });
});
