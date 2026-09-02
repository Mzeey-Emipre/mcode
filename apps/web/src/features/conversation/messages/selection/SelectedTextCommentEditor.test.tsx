import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LexicalEditor } from "lexical";
import type { MessageMention, SelectedTextComment, SelectedTextCommentSource } from "@mcode/contracts";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { SelectedTextCommentEditor } from "./SelectedTextCommentEditor";

const source: SelectedTextCommentSource = {
  threadId: "thread-1",
  messageId: "message-1",
  sourceRole: "assistant",
  start: 4,
  end: 10,
  quote: "<b>literal</b>\nsecond line",
};

const comment: SelectedTextComment = {
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source,
  note: "Saved note",
  mentions: [],
};

function renderSavedEditor() {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const onClose = vi.fn();
  const onAnnouncement = vi.fn();
  const view = render(
    <SelectedTextCommentEditor
      source={source}
      comment={comment}
      onSave={onSave}
      onDelete={onDelete}
      onClose={onClose}
      onAnnouncement={onAnnouncement}
    />,
  );
  return { ...view, onSave, onDelete, onClose, onAnnouncement };
}

function renderNewEditor() {
  const editorRef: { current: LexicalEditor | null } = { current: null };
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onAnnouncement = vi.fn();
  const view = render(
    <SelectedTextCommentEditor
      source={source}
      editorRef={editorRef}
      onSave={onSave}
      onClose={onClose}
      onAnnouncement={onAnnouncement}
    />,
  );
  return { ...view, editorRef, onSave, onClose, onAnnouncement };
}

function focusOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[contenteditable="true"], button')].map(
    (element) => element.getAttribute("aria-label") ?? element.textContent ?? "",
  );
}

describe("SelectedTextCommentEditor", () => {
  it("saves an existing comment without rendering the selected text in the editor", () => {
    const { container, onAnnouncement, onClose, onSave } = renderSavedEditor();

    expect(focusOrder(container)).toEqual([
      "Comment note",
      "Close comment editor",
      "Save comment",
      "Delete comment",
    ]);
    expect(container.querySelector("blockquote")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Comment note" })).toHaveAttribute("aria-placeholder", "Write a note");

    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    expect(onSave).toHaveBeenCalledWith(comment);
    expect(onAnnouncement).toHaveBeenCalledWith("Comment 1 updated.");
    expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it("limits the note to the shell's available height so its own scrollbar remains usable", () => {
    render(
      <SelectedTextCommentEditor
        source={source}
        maxHeight={46}
        onSave={() => {}}
        onClose={() => {}}
        onAnnouncement={() => {}}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Comment on selected text" })).toHaveStyle({ maxHeight: "46px" });
    expect(screen.getByRole("textbox", { name: "Comment note" })).toHaveStyle({
      maxHeight: "36px",
      overflowY: "auto",
    });
  });

  it("saves a new multiline comment with its typed slash and mention metadata", async () => {
    const { container, editorRef, onAnnouncement, onClose, onSave } = renderNewEditor();
    const mentions: MessageMention[] = [
      {
        id: "command:skill:review",
        kind: "command",
        label: "review",
        namespace: "skill",
        range: { start: 0, end: 7 },
      },
      {
        id: "file-1",
        kind: "file",
        label: "notes.ts",
        path: "src/notes.ts",
        range: { start: 8, end: 17 },
      },
    ];
    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    await act(async () => {
      writeComposerContent(editorRef.current!, "/review @notes.ts\nExplain this.", mentions);
    });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());
    expect(focusOrder(container)).toEqual(["Comment note", "Close comment editor", "Add comment"]);

    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(onSave).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      displayNumber: 1,
      source,
      note: "/review @notes.ts\nExplain this.",
      mentions,
    });
    expect(onAnnouncement).toHaveBeenCalledWith("Comment 1 added.");
    expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it("requires independent dirty confirmations and resets them when the draft changes", async () => {
    const { editorRef, onAnnouncement, onClose } = renderNewEditor();
    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    await act(async () => {
      writeComposerContent(editorRef.current!, "First draft");
    });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onAnnouncement).toHaveBeenLastCalledWith("Press Escape again to discard this comment.");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      writeComposerContent(editorRef.current!, "Edited draft");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onAnnouncement).toHaveBeenLastCalledWith("Press Escape again to discard this comment.");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onAnnouncement).toHaveBeenLastCalledWith("Repeat this action to discard this comment.");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes a saved comment with its required announcement", () => {
    const { onAnnouncement, onClose, onDelete, onSave } = renderSavedEditor();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    expect(onDelete).toHaveBeenCalledWith(comment);
    expect(onSave).not.toHaveBeenCalled();
    expect(onAnnouncement).toHaveBeenCalledWith("Comment deleted.");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
