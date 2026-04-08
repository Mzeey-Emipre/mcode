import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { GitBranch, Loader2, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector, type ComposerMode } from "./ModeSelector";
import { BranchPicker } from "./BranchPicker";
import { WorktreePicker } from "./WorktreePicker";
import { NamingModeSelector } from "./NamingModeSelector";
import { BranchNameInput } from "./BranchNameInput";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { findProviderForModel } from "@/lib/model-registry";
import type { NamingMode } from "@mcode/contracts";
import type { Thread } from "@mcode/contracts";

/** Props for BranchThreadDialog. */
interface BranchThreadDialogProps {
  /** The source thread to branch from. */
  thread: Thread;
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to control open state. */
  onOpenChange: (open: boolean) => void;
  /** Specific message ID to branch from. When omitted, branches from the latest message. */
  forkedFromMessageId?: string;
  /** Preview text of the message being branched from, shown as context. */
  forkedFromMessageContent?: string;
}

/** Generate a random branch ID matching the Composer's pattern. */
function generateBranchId(): string {
  return `mcode-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Chat-style dialog for creating a branched child thread.
 * Shows the forked message as a quoted reference and focuses on the composer,
 * rather than a form layout. Config (model, execution, branch) lives in a
 * collapsible row below the quote so it stays accessible but out of the way.
 */
export function BranchThreadDialog({
  thread,
  open,
  onOpenChange,
  forkedFromMessageId,
  forkedFromMessageContent,
}: BranchThreadDialogProps) {
  const branchThread = useWorkspaceStore((s) => s.branchThread);
  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoading = useWorkspaceStore((s) => s.worktreesLoading);
  const settings = useSettingsStore((s) => s.settings);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadBranches = useWorkspaceStore((s) => s.loadBranches);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);

  const defaultModel = thread.model ?? settings?.model?.defaults?.id ?? "claude-sonnet-4-6";

  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(defaultModel);
  const [composerMode, setComposerMode] = useState<ComposerMode>("direct");
  const [selectedBranch, setSelectedBranch] = useState(thread.branch);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState("");
  const [namingMode, setNamingMode] = useState<NamingMode>("auto");
  const [autoPreview] = useState(generateBranchId);
  const [customBranchName, setCustomBranchName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const provider = useMemo(() => {
    const p = findProviderForModel(modelId);
    return p?.id ?? thread.provider;
  }, [modelId, thread.provider]);

  useEffect(() => {
    if (open) {
      setComposerMode("direct");
      setSelectedBranch(thread.branch);
      setModelId(defaultModel);
      setPrompt("");
      setError(null);
      setConfigOpen(false);
      // Focus textarea after dialog animation
      setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [open, thread.branch, defaultModel]);

  useEffect(() => {
    if (open && activeWorkspaceId) {
      loadBranches(activeWorkspaceId);
      loadWorktrees(activeWorkspaceId);
    }
  }, [open, activeWorkspaceId, loadBranches, loadWorktrees]);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      let mode: "direct" | "worktree" | "existing-worktree" = "direct";
      let branch = selectedBranch;
      let existingWorktreePath: string | undefined;

      if (composerMode === "direct") {
        if (thread.mode === "worktree" && thread.worktree_path) {
          mode = "existing-worktree";
          existingWorktreePath = thread.worktree_path;
        } else {
          mode = "direct";
        }
      } else if (composerMode === "worktree") {
        mode = "worktree";
        branch = namingMode === "custom" && customBranchName.trim()
          ? customBranchName.trim()
          : autoPreview;
      } else {
        mode = "existing-worktree";
        existingWorktreePath = selectedWorktreePath;
        if (!selectedWorktreePath) {
          setError("Select a worktree first");
          setSubmitting(false);
          return;
        }
      }

      await branchThread({
        sourceThreadId: thread.id,
        content: prompt,
        model: modelId,
        provider,
        mode,
        branch,
        existingWorktreePath,
        forkedFromMessageId,
      });

      setPrompt("");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [
    prompt, submitting, composerMode, selectedBranch, namingMode,
    customBranchName, autoPreview, selectedWorktreePath, modelId,
    provider, thread, branchThread, onOpenChange, forkedFromMessageId,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const isMac = navigator.platform.includes("Mac");
  const submitKey = isMac ? "⌘" : "Ctrl";

  // Truncate message preview for quote display
  const messagePreview = forkedFromMessageContent
    ? forkedFromMessageContent.slice(0, 120) + (forkedFromMessageContent.length > 120 ? "…" : "")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg w-[min(90vw,520px)] p-0 gap-0 overflow-hidden"
        showCloseButton={!submitting}
      >
        {/* Accessible title/description (visually hidden, required for a11y) */}
        <DialogTitle className="sr-only">Branch thread</DialogTitle>
        <DialogDescription className="sr-only">
          Create a child thread branching from {thread.title}
        </DialogDescription>

        {/* Quoted message context */}
        <div className="px-4 pt-4">
          <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 relative">
            {/* Left accent line */}
            <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-border/70" />
            <div className="pl-2">
              <div className="flex items-center gap-1.5 mb-1">
                <GitBranch className="size-3 text-muted-foreground/60 shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-medium text-muted-foreground/60 truncate">
                  {thread.title}
                </span>
                {thread.branch && (
                  <span className="text-[10px] font-mono text-muted-foreground/40 truncate shrink-0">
                    · {thread.branch}
                  </span>
                )}
              </div>
              {messagePreview ? (
                <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-2">
                  {messagePreview}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground/50 italic">
                  {forkedFromMessageId ? "Branching from selected message" : "Branching from latest message"}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Config row (collapsible) */}
        <div className="px-4 pt-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            {configOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            <span className="font-medium">{modelId}</span>
            <span className="text-muted-foreground/30">·</span>
            <span>{composerMode === "direct" ? "Local" : composerMode === "worktree" ? "New worktree" : "Existing worktree"}</span>
            {composerMode === "direct" && selectedBranch && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="font-mono">{selectedBranch}</span>
              </>
            )}
          </button>

          {configOpen && (
            <div className="mt-2 mb-1 rounded-lg border border-border/40 bg-muted/20 p-3 flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground/60">Model</label>
                  <ModelSelector selectedModelId={modelId} onSelect={setModelId} locked={false} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground/60">Execution</label>
                  <ModeSelector mode={composerMode} onModeChange={setComposerMode} locked={false} />
                </div>
              </div>

              {composerMode === "direct" && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                    <GitBranch className="size-2.5" aria-hidden="true" /> Branch
                  </label>
                  <BranchPicker
                    branches={branches}
                    selectedBranch={selectedBranch}
                    onSelect={setSelectedBranch}
                    loading={branchesLoading}
                    locked={true}
                  />
                </div>
              )}

              {composerMode === "worktree" && (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                      <GitBranch className="size-2.5" aria-hidden="true" /> Base branch
                    </label>
                    <BranchPicker
                      branches={branches}
                      selectedBranch={selectedBranch}
                      onSelect={setSelectedBranch}
                      loading={branchesLoading}
                      locked={false}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground/60">Branch name</label>
                    <div className="flex flex-wrap items-center gap-1">
                      <NamingModeSelector mode={namingMode} onModeChange={setNamingMode} />
                      <BranchNameInput
                        namingMode={namingMode}
                        autoPreview={autoPreview}
                        customValue={customBranchName}
                        onCustomChange={setCustomBranchName}
                      />
                    </div>
                  </div>
                </>
              )}

              {composerMode === "existing-worktree" && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground/60">Worktree</label>
                  <WorktreePicker
                    worktrees={worktrees}
                    selectedPath={selectedWorktreePath}
                    onSelect={(wt) => setSelectedWorktreePath(wt.path)}
                    loading={worktreesLoading}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="px-4 pt-3 pb-4">
          {error && (
            <div role="alert" className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2 mb-2">
              {error}
            </div>
          )}
          <div
            className={cn(
              "flex items-end gap-2 rounded-xl border bg-background px-3 py-2.5 transition-colors",
              "border-input focus-within:border-ring",
            )}
          >
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="What should the child thread work on?"
              disabled={submitting}
              rows={1}
              className={cn(
                "flex-1 min-h-[24px] max-h-[200px] resize-none bg-transparent text-sm leading-6",
                "placeholder:text-muted-foreground/50",
                "focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            />
            <Button
              size="icon"
              onClick={handleSubmit}
              disabled={!prompt.trim() || submitting}
              className="size-7 shrink-0 rounded-lg"
              title={`Create branch (${submitKey}+Enter)`}
            >
              {submitting
                ? <Loader2 className="size-3.5 animate-spin" />
                : <ArrowUp className="size-3.5" />
              }
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground/40">
            Parent context included automatically · {submitKey}+Enter to send
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
