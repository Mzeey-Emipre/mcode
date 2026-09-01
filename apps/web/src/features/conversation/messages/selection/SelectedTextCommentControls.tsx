import { useCallback, useEffect, useState } from "react";
import { MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS, type SelectedTextComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  createSelectedTextCommentSource,
  type SelectedTextCommentSource,
} from "../selected-text-projection";

/** Props for {@link SelectedTextCommentControls}. */
export interface SelectedTextCommentControlsProps {
  /** Adds the captured selected-text comment to the active composer draft. */
  onSelectedTextComment?: (comment: SelectedTextComment) => void;
}

/** Renders transcript selection actions and the selected-text comment editor. */
export function SelectedTextCommentControls({
  onSelectedTextComment,
}: SelectedTextCommentControlsProps) {
  const [selectedTextContextMenu, setSelectedTextContextMenu] = useState<{
    source: SelectedTextCommentSource;
    x: number;
    y: number;
  } | null>(null);
  const [commentEditorSource, setCommentEditorSource] = useState<SelectedTextCommentSource | null>(null);
  const [commentNote, setCommentNote] = useState("");

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const selection = window.getSelection();
      if (!selection) return;
      const source = createSelectedTextCommentSource(selection, selection.anchorNode);
      if (!source) return;
      setSelectedTextContextMenu({ source, x: event.clientX, y: event.clientY });
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const openSelectedTextCommentEditor = useCallback(() => {
    const source = selectedTextContextMenu?.source;
    if (!source) return;
    setSelectedTextContextMenu(null);
    setCommentEditorSource(source);
    setCommentNote("");
  }, [selectedTextContextMenu]);

  const closeSelectedTextCommentEditor = useCallback(() => {
    setCommentEditorSource(null);
    setCommentNote("");
  }, []);

  const saveSelectedTextComment = useCallback(() => {
    if (!commentEditorSource || !onSelectedTextComment || !commentNote.trim()) return;
    onSelectedTextComment({
      id: crypto.randomUUID(),
      displayNumber: 1,
      source: commentEditorSource,
      note: commentNote,
      mentions: [],
    });
    setCommentEditorSource(null);
    setCommentNote("");
  }, [commentEditorSource, commentNote, onSelectedTextComment]);

  return (
    <>
      {selectedTextContextMenu && (
        <ContextMenu
          x={selectedTextContextMenu.x}
          y={selectedTextContextMenu.y}
          items={[{ label: "Add comment", onClick: openSelectedTextCommentEditor }]}
          onClose={() => setSelectedTextContextMenu(null)}
        />
      )}

      {/* This temporary first-slice editor preserves the composer workflow; #1556 will replace it with compact ComposerEditor behavior. */}
      <Popover
        open={commentEditorSource !== null}
        modal={false}
        onOpenChange={(open) => {
          if (!open) closeSelectedTextCommentEditor();
        }}
      >
        <PopoverTrigger
          nativeButton={false}
          render={<span aria-hidden className="pointer-events-none absolute bottom-4 left-4 size-px sm:left-8" />}
        />
        {commentEditorSource && (
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            role="dialog"
            aria-label="Comment on selected text"
            initialFocus={() => document.getElementById("selected-text-comment-note")}
            finalFocus={false}
            className="w-[min(26rem,calc(100vw-2rem))] p-3"
          >
            <p className="text-sm font-medium">Comment on selected text</p>
            <blockquote className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
              {commentEditorSource.quote}
            </blockquote>
            <Textarea
              id="selected-text-comment-note"
              className="mt-3 min-h-20"
              aria-label="Comment note"
              value={commentNote}
              maxLength={MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS}
              onChange={(event) => setCommentNote(event.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={closeSelectedTextCommentEditor}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!commentNote.trim()}
                onClick={saveSelectedTextComment}
              >
                Add comment
              </Button>
            </div>
          </PopoverContent>
        )}
      </Popover>
    </>
  );
}
