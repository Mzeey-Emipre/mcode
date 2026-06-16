import { useCallback } from "react";
import { Code2, FileText, ClipboardCopy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { FileEditorPicker } from "./FileEditorPicker";

/** Props for the FileActionBar component. */
interface FileActionBarProps {
  /**
   * Workspace-relative path. Used as a clipboard fallback only — Copy
   * prefers `absolutePath` when available so the pasted value works in
   * terminals and external tools without further resolution.
   */
  readonly filePath: string;
  /**
   * Absolute path on disk. Used as the Copy payload and by the Open
   * action's editor picker / Reveal. Resolved upstream from the workspace
   * or worktree root plus the relative `filePath`, so in practice this is
   * always populated — undefined only during transient pre-hydration.
   */
  readonly absolutePath?: string;
  /**
   * Absolute parent directory of the file. Used by the picker's Reveal
   * action to open the OS file manager. Falls back to `absolutePath` if
   * omitted, which is harmless — most OS file managers handle either.
   */
  readonly absoluteDir?: string;
  /** Line to jump to when opening in an editor (first hunk's new-start line). */
  readonly openAtLine?: number;
  /** Whether the file is markdown — only then does the Diff/Preview toggle render. */
  readonly isMarkdown: boolean;
  /** Whether the body is currently in preview mode. */
  readonly previewMode: boolean;
  /** Flip preview mode on or off. */
  readonly onTogglePreview: () => void;
}

/**
 * Compact icon-button shared by every action. Muted at rest, brightens on hover.
 * Hover uses a foreground overlay rather than a muted tint: these buttons sit on
 * the opaque `bg-muted` header bar, where a `muted/xx` layer composites back to
 * muted and shows no change.
 */
const ACTION_BUTTON_CLASS = [
  "h-6 w-6 shrink-0 p-0 text-muted-foreground/70",
  "transition-colors hover:bg-foreground/10 hover:text-foreground",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring/55",
].join(" ");

/**
 * Active segment of the Diff/Preview toggle. `bg-background` reads as a distinct
 * recessed (dark theme) / raised (light theme) segment against the muted bar in
 * either theme — a `muted/xx` fill would be invisible here.
 */
const ACTION_BUTTON_ACTIVE = "bg-background text-foreground";

/**
 * Horizontal toolbar of per-file actions that lives in the file header bar:
 * a Diff/Preview view toggle (markdown only), Copy path, and Open in editor.
 * Replaces the old overlay rail now that the diff view is a flat list rather
 * than discrete cards.
 */
export function FileActionBar({
  filePath,
  absolutePath,
  absoluteDir,
  openAtLine,
  isMarkdown,
  previewMode,
  onTogglePreview,
}: FileActionBarProps) {
  const handleCopyPath = useCallback(() => {
    // Prefer the absolute on-disk path so the clipboard value is immediately
    // usable in terminals / external editors without the recipient needing to
    // know the workspace root. Relative is only a fallback for the (unreachable
    // in normal flows) state where the workspace base hasn't hydrated yet.
    const payload = absolutePath ?? filePath;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      useToastStore
        .getState()
        .show("error", "Couldn't copy path", "Clipboard API is unavailable in this environment.");
      return;
    }
    void clipboard
      .writeText(payload)
      .then(() => useToastStore.getState().show("info", "Path copied"))
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show("error", "Couldn't copy path", String((err as { message?: string })?.message ?? err)),
      );
  }, [absolutePath, filePath]);

  return (
    <div role="group" aria-label="File actions" className="flex shrink-0 items-center gap-0.5 pr-1.5">
      {isMarkdown && (
        <>
          <Button
            type="button"
            variant="ghost"
            aria-label="Show raw diff"
            aria-pressed={!previewMode}
            onClick={() => {
              if (previewMode) onTogglePreview();
            }}
            className={cn(ACTION_BUTTON_CLASS, !previewMode && ACTION_BUTTON_ACTIVE)}
          >
            <Code2 size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Show rendered preview"
            aria-pressed={previewMode}
            onClick={() => {
              if (!previewMode) onTogglePreview();
            }}
            className={cn(ACTION_BUTTON_CLASS, previewMode && ACTION_BUTTON_ACTIVE)}
          >
            <FileText size={13} />
          </Button>
        </>
      )}

      <Button
        type="button"
        variant="ghost"
        aria-label="Copy file path"
        onClick={handleCopyPath}
        className={ACTION_BUTTON_CLASS}
      >
        <ClipboardCopy size={13} />
      </Button>

      {absolutePath && (
        <FileEditorPicker
          filePath={absolutePath}
          dirPath={absoluteDir ?? absolutePath}
          line={openAtLine}
          trigger={
            <Button
              type="button"
              variant="ghost"
              aria-label="Open file in editor"
              className={ACTION_BUTTON_CLASS}
            >
              <ExternalLink size={13} />
            </Button>
          }
        />
      )}
    </div>
  );
}
