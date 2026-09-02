import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
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
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useWorkspaceStore.setState({ threads: [] });
  });

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

  it("persists live edits while a failed thread creation waits for retry", async () => {
    const previewUrl = "blob:restored-preview";
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const placeholder = {
      ...createMockThread({ id: "pending-thread" }),
      clientPreparing: false,
      clientError: "Creation failed",
    };
    useWorkspaceStore.setState({ threads: [placeholder] });
    useComposerDraftStore.getState().saveDraft(placeholder.id, {
      input: "Original request.",
      mentions: [],
      selectedTextComments: [comment],
      attachments: [{
        id: "attachment-1",
        name: "preview.png",
        mimeType: "image/png",
        sizeBytes: 128,
        previewUrl,
        filePath: "C:/tmp/preview.png",
      }],
      modelId: "gpt-5.5",
      provider: "codex",
      reasoning: "high",
    });
    const { result } = renderHook(() => useComposerFormController({
      threadId: placeholder.id,
      isNewThread: false,
      activeThread: placeholder,
    }));

    await waitFor(() => expect(result.current.state.text).toBe("Original request."));
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    act(() => {
      result.current.updateDraft("Send the edited request.", []);
      result.current.setSelectedTextComments([comment]);
      result.current.updateSelection({ modelId: "gpt-5.5", provider: "codex" });
    });

    await waitFor(() => expect(useComposerDraftStore.getState().getDraft(placeholder.id)).toMatchObject({
      input: "Send the edited request.",
      selectedTextComments: [comment],
      modelId: "gpt-5.5",
      provider: "codex",
    }));
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    revokeObjectUrl.mockRestore();
  });
});
