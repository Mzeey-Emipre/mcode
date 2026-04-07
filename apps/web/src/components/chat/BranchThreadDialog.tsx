import { useState, useCallback, useEffect, useMemo } from "react";
import { GitBranch, Loader2 } from "lucide-react";
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
}

/** Generate a random branch ID matching the Composer's pattern. */
function generateBranchId(): string {
  return `mcode-${Math.random().toString(36).slice(2, 10)}`;
}

/** Dialog for creating a branched child thread. Two-column layout with sidebar controls and prompt area. */
export function BranchThreadDialog({
  thread,
  open,
  onOpenChange,
  forkedFromMessageId,
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

  // Derive provider from selected model
  const provider = useMemo(() => {
    const p = findProviderForModel(modelId);
    return p?.id ?? thread.provider;
  }, [modelId, thread.provider]);

  // Initialize mode from parent thread
  useEffect(() => {
    if (open) {
      const initial: ComposerMode = thread.mode === "worktree" ? "direct" : "direct";
      setComposerMode(initial);
      setSelectedBranch(thread.branch);
      setModelId(defaultModel);
      setPrompt("");
      setError(null);
    }
  }, [open, thread.mode, thread.branch, defaultModel]);

  // Load branches and worktrees when dialog opens
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

  // Submit on Ctrl/Cmd+Enter
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const isMac = navigator.platform.includes("Mac");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl w-[min(90vw,780px)] p-0 gap-0"
        showCloseButton={!submitting}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
            <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium leading-none">
              Branch thread
            </DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">from</span>
              <span className="font-medium max-w-[280px] truncate text-foreground/80">
                {thread.title}
              </span>
              {thread.branch && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="font-mono max-w-[160px] truncate text-muted-foreground">
                    {thread.branch}
                  </span>
                </>
              )}
            </DialogDescription>
          </div>
          {forkedFromMessageId && (
            <span className="text-xs text-muted-foreground bg-muted/60 border border-border/50 rounded px-2 py-0.5 shrink-0">
              From message
            </span>
          )}
        </div>

        {/* Two-column body */}
        <div className="flex min-h-[400px]">
          {/* Left sidebar: controls + actions */}
          <div className="w-64 shrink-0 flex flex-col gap-4 border-r border-border/50 p-5">
            {/* Model */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">Model</label>
              <ModelSelector
                selectedModelId={modelId}
                onSelect={setModelId}
                locked={false}
              />
            </div>

            {/* Execution mode */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">Execution</label>
              <ModeSelector
                mode={composerMode}
                onModeChange={setComposerMode}
                locked={false}
              />
            </div>

            {/* Branch controls - conditional on mode */}
            {composerMode === "direct" && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground flex items-center gap-1">
                  <GitBranch className="size-3" aria-hidden="true" />
                  Branch
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
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-muted-foreground flex items-center gap-1">
                    <GitBranch className="size-3" aria-hidden="true" />
                    Base branch
                  </label>
                  <BranchPicker
                    branches={branches}
                    selectedBranch={selectedBranch}
                    onSelect={setSelectedBranch}
                    loading={branchesLoading}
                    locked={false}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-muted-foreground">Branch name</label>
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
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">Worktree</label>
                <WorktreePicker
                  worktrees={worktrees}
                  selectedPath={selectedWorktreePath}
                  onSelect={(wt) => setSelectedWorktreePath(wt.path)}
                  loading={worktreesLoading}
                />
              </div>
            )}

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
                disabled={!prompt.trim() || submitting}
                className="w-full"
              >
                {submitting && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Create branch
              </Button>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                className="w-full"
              >
                Cancel
              </Button>
            </div>
          </div>

          {/* Right: prompt area */}
          <div className="flex-1 flex flex-col gap-2 p-5 min-w-0">
            <label htmlFor="branch-prompt" className="text-xs text-muted-foreground">
              Prompt
            </label>
            <textarea
              id="branch-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What should the child thread work on?"
              autoFocus
              disabled={submitting}
              className={cn(
                "flex-1 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm shadow-xs transition-colors",
                "resize-none",
                "placeholder:text-muted-foreground",
                "focus-visible:border-ring focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground/50">
                Parent context will be included automatically
              </span>
              <kbd className="text-[10px] font-mono text-muted-foreground/40">
                {isMac ? "\u2318" : "Ctrl"}+Enter
              </kbd>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
