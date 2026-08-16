import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  usePreviewAnnotationStore,
  type DiffAnnotationInput,
  type SavedDiffAnnotation,
} from "@/features/preview/state/previewAnnotationStore";

/** Props for the inline editor attached to a local diff line. */
export interface DiffAnnotationEditorProps {
  /** Thread that will receive the composer annotation. */
  readonly threadId: string;
  /** Line target and source context sent to the agent. */
  readonly target: Omit<DiffAnnotationInput, "note">;
  /** Existing annotation when the user is editing a saved line note. */
  readonly annotation?: SavedDiffAnnotation;
  /** Closes the inline editor and restores the diff row. */
  readonly onClose: () => void;
}

/** Edits one Dev diff comment and adds it to the thread composer bundle. */
export function DiffAnnotationEditor({
  threadId,
  target,
  annotation,
  onClose,
}: DiffAnnotationEditorProps) {
  const [note, setNote] = useState(annotation?.note ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const save = (): void => {
    if (!note.trim()) return;
    usePreviewAnnotationStore
      .getState()
      .saveDiffAnnotation(threadId, { ...target, note }, annotation?.id);
    onClose();
  };

  return (
    <section
      aria-label={`Comment on ${target.filePath} line ${target.line}`}
      className="mx-3 my-2 rounded-lg bg-muted/45 p-3 ring-1 ring-inset ring-border/60"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessageCircle size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-foreground">Code comment</span>
        <span className="ml-auto min-w-0 truncate font-mono text-[1.1rem] tabular-nums text-muted-foreground">
          {target.filePath}:{target.line}
        </span>
      </div>
      <Textarea
        ref={textareaRef}
        aria-label="Code comment"
        value={note}
        maxLength={4_000}
        placeholder="Request a change"
        className="mt-2 min-h-20 resize-y bg-background/65 px-3 py-2 text-sm leading-5 shadow-none"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-end gap-1.5">
        {annotation ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mr-auto text-xs text-destructive"
            onClick={() => {
              usePreviewAnnotationStore.getState().deleteAnnotation(threadId, annotation.id);
              onClose();
            }}
          >
            Remove
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" className="text-xs" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="text-xs"
          disabled={!note.trim()}
          onClick={save}
        >
          Add to prompt
        </Button>
      </div>
    </section>
  );
}
