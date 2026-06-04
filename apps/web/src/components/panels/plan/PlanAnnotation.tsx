import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/platform";

const SAVE_HINT = isMac ? "⌘↵ to save" : "Ctrl+↵ to save";

interface PlanAnnotationProps {
  sectionTitle: string;
  initialValue: string;
  /** Called on blur (click away) to stash the draft and close the editor. */
  onCommit: (value: string) => void;
  /** Called when the user explicitly saves and closes the note. */
  onSave: (value: string) => void;
  onDiscard: () => void;
}

/**
 * Inline annotation textarea below a plan heading. Manages its own
 * text state to avoid re-rendering the parent markdown on every
 * keystroke. Blur (click away) stashes the draft and closes; Save note
 * commits and closes explicitly.
 */
export function PlanAnnotation({
  sectionTitle,
  initialValue,
  onCommit,
  onSave,
  onDiscard,
}: PlanAnnotationProps) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = `plan-note-${sectionTitle.replace(/\s+/g, "-").toLowerCase()}`;

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.selectionStart = el.value.length;
    }
  }, []);

  const handleBlur = () => {
    onCommit(text);
  };

  const handleSave = () => {
    onSave(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onDiscard();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="my-2.5 overflow-hidden rounded-lg bg-card shadow-lg shadow-black/25 ring-1 ring-border/60 transition-shadow duration-200 focus-within:ring-primary/35 animate-wizard-float-rise">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="size-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/55">
          Note <span className="text-muted-foreground/30">·</span>{" "}
          <span className="text-muted-foreground/75 normal-case tracking-normal">{sectionTitle}</span>
        </span>
      </div>
      <label htmlFor={fieldId} className="sr-only">
        Note for section {sectionTitle}
      </label>
      <textarea
        id={fieldId}
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="What should change in this section?"
        rows={2}
        className="block min-h-[4rem] w-full resize-y border-none bg-transparent px-3.5 pb-3 text-[13px] leading-[1.7] text-foreground outline-none placeholder:text-muted-foreground/45"
      />
      <div className="flex items-center justify-between gap-2 bg-muted/25 px-3.5 py-2.5">
        <p className="min-w-0 font-mono text-[9px] leading-snug tracking-[0.14em] text-muted-foreground/55">
          Click away to stash <span className="text-muted-foreground/30">·</span> {SAVE_HINT}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onMouseDown={(e) => {
              // Blur fires before click; block it so discard runs first.
              e.preventDefault();
            }}
            onClick={onDiscard}
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70 hover:text-foreground"
          >
            Discard
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={handleSave}
            className="bg-primary/15 font-mono text-[10px] uppercase tracking-[0.16em] text-primary hover:bg-primary/25 hover:text-primary"
          >
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
