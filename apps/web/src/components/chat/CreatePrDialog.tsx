import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { PrDraft } from "@mcode/contracts";

/** Possible states for the PR creation flow. */
type DialogState = "loading" | "ready" | "submitting" | "error";

/** Props for the CreatePrDialog component. */
export interface CreatePrDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** ID of the thread to create the PR from. */
  threadId: string;
  /** ID of the workspace that owns the thread. */
  workspaceId: string;
  /** Current branch name, shown in the form description. */
  branch: string;
}

/**
 * Modal dialog for creating a GitHub pull request from a thread.
 * Generates an AI-powered PR draft on open, then allows the user to
 * edit the title and body before submitting.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  threadId,
  workspaceId,
  branch,
}: CreatePrDialogProps) {
  const { branches, loadBranches } = useWorkspaceStore();

  const [state, setState] = useState<DialogState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);

  // Default base branch to "main" or the first local branch that isn't current.
  const localBranches = useMemo(
    () => branches.filter((b) => b.type === "local" && b.name !== branch),
    [branches, branch],
  );
  const defaultBase =
    localBranches.find((b) => b.name === "main") ??
    localBranches.find((b) => b.name === "master") ??
    localBranches[0];

  const [baseBranch, setBaseBranch] = useState<string>(
    defaultBase?.name ?? "main",
  );

  // Keep baseBranch in sync when branches load and current value becomes unavailable.
  useEffect(() => {
    if (localBranches.length > 0 && !localBranches.some((b) => b.name === baseBranch)) {
      setBaseBranch(localBranches[0].name);
    }
  }, [localBranches, baseBranch]);

  // Load branches when the dialog opens.
  useEffect(() => {
    if (open && workspaceId) {
      loadBranches(workspaceId);
    }
  }, [open, workspaceId, loadBranches]);

  // Generate the PR draft when the dialog opens.
  // baseBranch is intentionally excluded from deps to avoid re-generating when
  // the user changes the base branch.
  useEffect(() => {
    if (!open) {
      // Reset ephemeral fields so the next open starts clean
      setTitle("");
      setBody("");
      setIsDraft(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    setError(null);

    getTransport()
      .generatePrDraft(workspaceId, threadId, baseBranch)
      .then((draft: PrDraft) => {
        if (cancelled) return;
        setTitle(draft.title);
        setBody(draft.body);
        setState("ready");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(`Draft generation failed: ${err.message}`);
        setState("error");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baseBranch intentionally excluded to avoid re-generating draft on base change
  }, [open, workspaceId, threadId]);

  const handleSubmit = useCallback(async () => {
    setState("submitting");
    setError(null);
    try {
      await getTransport().createPr(
        workspaceId,
        threadId,
        title,
        body,
        baseBranch,
        isDraft,
      );
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "PR creation failed";
      setError(message);
      setState("ready");
    }
  }, [workspaceId, threadId, title, body, baseBranch, isDraft, onOpenChange]);

  const isDisabled = state === "loading" || state === "submitting";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        showCloseButton={!isDisabled}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
            Create pull request
          </DialogTitle>
          <DialogDescription>
            Opening a PR from <span className="font-mono text-xs">{branch}</span>.
          </DialogDescription>
        </DialogHeader>

        {/* Loading state */}
        {state === "loading" && (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating PR draft...
          </div>
        )}

        {/* Form — shown in ready, submitting, and error states */}
        {state !== "loading" && (
          <div className="flex flex-col gap-4">
            {/* Error banner */}
            {error && (
              <div
                role="alert"
                className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2"
              >
                {error}
              </div>
            )}

            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="pr-title"
                className="text-xs font-medium text-foreground"
              >
                Title
              </label>
              <Input
                id="pr-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="PR title"
                disabled={isDisabled}
              />
            </div>

            {/* Base branch */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="pr-base-branch"
                className="text-xs font-medium text-foreground"
              >
                Base branch
              </label>
              <select
                id="pr-base-branch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={isDisabled || localBranches.length === 0}
                className={cn(
                  "flex h-8 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors",
                  "focus-visible:border-ring focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {localBranches.length === 0 && (
                  <option value={baseBranch}>{baseBranch}</option>
                )}
                {localBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Draft checkbox */}
            <div className="flex items-center gap-2">
              <input
                id="pr-is-draft"
                type="checkbox"
                checked={isDraft}
                onChange={(e) => setIsDraft(e.target.checked)}
                disabled={isDisabled}
                className="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
              <label
                htmlFor="pr-is-draft"
                className="text-xs font-medium text-foreground select-none cursor-pointer"
              >
                Draft PR
              </label>
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="pr-body"
                className="text-xs font-medium text-foreground"
              >
                Description
              </label>
              <textarea
                id="pr-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                disabled={isDisabled}
                placeholder="PR description"
                className={cn(
                  "flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors",
                  "font-mono resize-y",
                  "placeholder:text-muted-foreground",
                  "focus-visible:border-ring focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDisabled}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isDisabled || !title.trim()}
          >
            {state === "submitting" && (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            )}
            Create PR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
