import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LexicalEditor } from "lexical";
import { describe, expect, it, vi } from "vitest";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { ComposerEditor } from "./ComposerEditor";

describe("ComposerEditor", () => {
  it("uses annotation sizing when compact", () => {
    render(
      <ComposerEditor
        onChange={() => {}}
        onSubmit={() => {}}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        ariaLabel="Comment note"
        compact
      />,
    );

    expect(screen.getByRole("textbox", { name: "Comment note" })).toHaveStyle({ minHeight: "2.25rem" });
  });

  it("uses regular composer sizing", () => {
    render(
      <ComposerEditor
        onChange={() => {}}
        onSubmit={() => {}}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        ariaLabel="Composer"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Composer" })).toHaveStyle({
      minHeight: "80px",
      maxHeight: "30vh",
      overflowY: "auto",
    });
  });

  it("keeps Enter as a line break and reserves Ctrl+Enter for compact-editor submit", async () => {
    const editorRef: { current: LexicalEditor | null } = { current: null };
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ComposerEditor
        onChange={onChange}
        onSubmit={onSubmit}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        editorRef={editorRef}
        ariaLabel="Comment note"
        submitOnEnter={false}
      />,
    );

    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    await act(async () => {
      writeComposerContent(editorRef.current!, "First line\nSecond line");
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("First line\nSecond line", []));

    const editor = screen.getByRole("textbox", { name: "Comment note" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits with Ctrl+Enter instead of selecting an open popup", async () => {
    const editorRef: { current: LexicalEditor | null } = { current: null };
    const onPopupKeyDown = vi.fn(() => true);
    const onSubmit = vi.fn();
    render(
      <ComposerEditor
        onChange={() => {}}
        onSubmit={onSubmit}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        editorRef={editorRef}
        ariaLabel="Comment note"
        submitOnEnter={false}
        isPopupOpen
        onPopupKeyDown={onPopupKeyDown}
      />,
    );

    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment note" }), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(onPopupKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
