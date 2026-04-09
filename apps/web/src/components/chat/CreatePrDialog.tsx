import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, GitPullRequest, GitBranch, ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SegControl } from "@/components/settings/SegControl";
import { MarkdownContent } from "./MarkdownContent";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import type { GitBranch as GitBranchType } from "@mcode/contracts";

// ---------------------------------------------------------------------------
// BaseBranchSelect — searchable local-branch picker for the PR dialog sidebar
// ---------------------------------------------------------------------------

interface BaseBranchSelectProps {
  branches: GitBranchType[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

/**
 * Searchable dropdown for picking the PR base branch.
 * Renders a styled trigger button that opens a popover with a search input
 * and a scrollable list of local branches.
 */
function BaseBranchSelect({ branches, value, onChange, disabled }: BaseBranchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(
    () => branches.filter((b) => b.name.toLowerCase().includes(search.toLowerCase())),
    [branches, search],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-8 w-full items-center justify-between rounded-lg border border-input bg-background pl-3 pr-2.5 text-sm shadow-xs transition-colors",
          "focus-visible:border-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-ring",
        )}
      >
        <span className="truncate">{value}</span>
        <ChevronDown
          className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Base branch"
          className="absolute top-full left-0 z-50 mt-1 w-full min-w-[200px] rounded-lg border border-border bg-popover shadow-lg"
        >
          <div className="p-1.5">
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches…"
              size="sm"
              className="text-popover-foreground"
            />
          </div>
          <div className="max-h-[200px] overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">No branches match</p>
            ) : (
              filtered.map((b) => (
                <button
                  key={b.name}
                  type="button"
                  role="option"
                  aria-selected={b.name === value}
                  onClick={() => { onChange(b.name); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs transition-colors",
                    b.name === value
                      ? "bg-accent text-foreground"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className="truncate">{b.name}</span>
                  {b.isCurrent && (
                    <Badge variant="secondary" size="sm" className="ml-2 shrink-0">current</Badge>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const { branches, branchesLoading, loadBranches } = useWorkspaceStore();

  const [state, setState] = useState<DialogState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [descMode, setDescMode] = useState<"write" | "preview">("write");

  // Include local + remote branches as base branch candidates.
  // Remote branches have their "remotename/" prefix stripped so the value sent
  // to GitHub is a plain branch name (e.g. "main", not "origin/main").
  // Duplicates (same clean name from both local and remote) are deduplicated.
  const baseBranches = useMemo(() => {
    const seen = new Set<string>();
    const result: GitBranchType[] = [];
    for (const b of branches) {
      if (b.type === "worktree") continue;
      const name = b.type === "remote" ? b.name.replace(/^[^/]+\//, "") : b.name;
      if (name === branch || seen.has(name)) continue;
      seen.add(name);
      result.push({ ...b, name });
    }
    return result;
  }, [branches, branch]);

  const defaultBase =
    baseBranches.find((b) => b.name === "main") ??
    baseBranches.find((b) => b.name === "master") ??
    baseBranches[0];

  const [baseBranch, setBaseBranch] = useState<string>(
    defaultBase?.name ?? "main",
  );

  // Keep baseBranch in sync when branches load.
  // On first load: initialize to the repo default (main/master/first).
  // On subsequent loads: reset to default if the current value is no longer available.
  useEffect(() => {
    if (baseBranches.length === 0) return;
    const defaultBranch = (
      baseBranches.find((b) => b.name === "main") ??
      baseBranches.find((b) => b.name === "master") ??
      baseBranches[0]
    ).name;
    if (!baseBranches.some((b) => b.name === baseBranch)) {
      setBaseBranch(defaultBranch);
    }
  }, [baseBranches, baseBranch]);

  // Load branches when the dialog opens.
  useEffect(() => {
    if (open && workspaceId) {
      loadBranches(workspaceId);
    }
  }, [open, workspaceId, loadBranches]);

  // Reset ephemeral fields when the dialog closes.
  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
      setIsDraft(false);
      setError(null);
      setDescMode("write");
      setState("ready");
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    setState("submitting");
    setError(null);
    try {
      const result = await getTransport().createPr(
        workspaceId,
        threadId,
        title,
        body,
        baseBranch,
        isDraft,
      );
      useWorkspaceStore.getState().recordPrCreated(threadId, result.number, result.url);
      onOpenChange(false);
      useToastStore.getState().show("info", "Pull request created", `PR #${result.number} opened on GitHub`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "PR creation failed";
      setError(message);
      setState("ready");
    }
  }, [workspaceId, threadId, title, body, baseBranch, isDraft, onOpenChange]);

  /** Re-run AI draft generation with the current base branch, keeping existing content visible. */
  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    setError(null);
    try {
      const draft = await getTransport().generatePrDraft(workspaceId, threadId, baseBranch);
      setTitle(draft.title);
      setBody(draft.body);
    } catch (err) {
      setError(`Draft generation failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsRegenerating(false);
    }
  }, [workspaceId, threadId, baseBranch]);

  const isDisabled = state === "loading" || state === "submitting" || branchesLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl w-[min(90vw,900px)] p-0 gap-0"
        showCloseButton={!isDisabled}
      >
        {/* Header */}
        <div className="flex items-center gap-3 pl-5 pr-12 py-4 border-b border-border/50">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
            <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium leading-none">
              Create pull request
            </DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
              <span className="font-mono max-w-[200px] truncate text-foreground/80">{branch}</span>
              <span className="text-muted-foreground/50">→</span>
              <span className="font-mono max-w-[200px] truncate text-muted-foreground">{baseBranch}</span>
            </DialogDescription>
          </div>
          {isDraft && (
            <span className="text-xs text-muted-foreground bg-muted/60 border border-border/50 rounded px-2 py-0.5 shrink-0">
              Draft
            </span>
          )}
        </div>

        {/* Two-column body */}
        <div className="flex h-[480px]">
          {/* Left sidebar: metadata + actions */}
          <div className="w-64 shrink-0 flex flex-col gap-4 border-r border-border/50 p-5">
            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pr-title" className="text-xs text-muted-foreground">
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
              <label className="text-xs text-muted-foreground flex items-center gap-1">
                <GitBranch className="size-3" aria-hidden="true" />
                Base branch
              </label>
              <BaseBranchSelect
                branches={baseBranches}
                value={baseBranch}
                onChange={setBaseBranch}
                disabled={isDisabled}
              />
            </div>

            {/* Draft toggle */}
            <div className="flex items-center justify-between">
              <label
                htmlFor="pr-is-draft"
                className="text-xs text-muted-foreground select-none cursor-pointer"
              >
                Draft PR
              </label>
              <Switch
                id="pr-is-draft"
                checked={isDraft}
                onCheckedChange={setIsDraft}
                disabled={isDisabled}
              />
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Error banner */}
            {error && (
              <div
                role="alert"
                className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2"
              >
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <Button
                onClick={handleSubmit}
                disabled={isDisabled || !title.trim()}
                className="w-full"
              >
                {state === "submitting" && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Create PR
              </Button>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isDisabled}
                className="w-full"
              >
                Cancel
              </Button>
            </div>
          </div>

          {/* Right: description */}
          <div className="flex-1 flex flex-col gap-2 p-5 min-w-0">
            {isRegenerating && !body ? (
              <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-4 animate-spin" />
                Generating PR draft…
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <label htmlFor="pr-body" className="text-xs text-muted-foreground">
                    Description
                  </label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRegenerate}
                      disabled={isDisabled || isRegenerating}
                      className="h-6 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {isRegenerating ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3" />
                      )}
                      {title || body ? "Regenerate" : "Generate"}
                    </Button>
                    <SegControl
                      options={[
                        { value: "write", label: "Write" },
                        { value: "preview", label: "Preview" },
                      ]}
                      value={descMode}
                      onChange={(v) => setDescMode(v as "write" | "preview")}
                    />
                  </div>
                </div>
                {descMode === "write" ? (
                  <textarea
                    id="pr-body"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    disabled={isDisabled || isRegenerating}
                    placeholder="PR description"
                    className={cn(
                      "flex-1 min-h-0 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm shadow-xs transition-colors",
                      "font-mono resize-none overflow-y-auto",
                      "placeholder:text-muted-foreground",
                      "focus-visible:border-ring focus-visible:outline-none",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  />
                ) : (
                  <div
                    className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
                  >
                    {body.trim() ? (
                      <MarkdownContent content={body} />
                    ) : (
                      <span className="text-muted-foreground italic">Nothing to preview.</span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
