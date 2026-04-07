import { useState, useCallback, useEffect } from "react";
import { GitBranch } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { Thread } from "@mcode/contracts";

/** Props for BranchThreadDialog. */
interface BranchThreadDialogProps {
  /** The source thread to branch from. */
  thread: Thread;
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to control open state. */
  onOpenChange: (open: boolean) => void;
}

type ExecutionTarget = "same" | "new-worktree" | "existing-worktree";

/** Dialog for configuring and creating a branched child thread. */
export function BranchThreadDialog({ thread, open, onOpenChange }: BranchThreadDialogProps) {
  const branchThread = useWorkspaceStore((s) => s.branchThread);
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const settings = useSettingsStore((s) => s.settings);

  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState(thread.provider);
  const [model, setModel] = useState(thread.model ?? settings?.model?.defaults?.id ?? "claude-sonnet-4-6");
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>("same");
  const [newBranchName, setNewBranchName] = useState("");
  const [selectedWorktreePath, setSelectedWorktreePath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);

  // Load worktrees when the dialog opens so the picker is populated
  useEffect(() => {
    if (open && activeWorkspaceId) {
      loadWorktrees(activeWorkspaceId);
    }
  }, [open, activeWorkspaceId, loadWorktrees]);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || submitting) return;

    setSubmitting(true);
    try {
      let mode: "direct" | "worktree" | "existing-worktree" = "direct";
      let branch = thread.branch;
      let existingWorktreePath: string | undefined;

      if (executionTarget === "same") {
        mode = thread.mode === "worktree" ? "existing-worktree" : "direct";
        if (thread.worktree_path) {
          existingWorktreePath = thread.worktree_path;
        }
      } else if (executionTarget === "new-worktree") {
        mode = "worktree";
        branch = newBranchName.trim() || `mcode-${Math.random().toString(36).slice(2, 10)}`;
      } else {
        mode = "existing-worktree";
        existingWorktreePath = selectedWorktreePath;
      }

      await branchThread({
        sourceThreadId: thread.id,
        content: prompt,
        model,
        provider,
        mode,
        branch,
        existingWorktreePath,
      });

      setPrompt("");
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting, executionTarget, newBranchName, selectedWorktreePath, model, provider, thread, branchThread, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={16} />
            Branch from "{thread.title}"
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="branch-provider">Provider</Label>
              <Select value={provider} onValueChange={(v) => { if (v) setProvider(v); }}>
                <SelectTrigger id="branch-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branch-model">Model</Label>
              <Input
                id="branch-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Execution target</Label>
            <Select value={executionTarget} onValueChange={(v) => { if (v) setExecutionTarget(v as ExecutionTarget); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">Same worktree</SelectItem>
                <SelectItem value="new-worktree">New worktree</SelectItem>
                <SelectItem value="existing-worktree">Existing worktree</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {executionTarget === "new-worktree" && (
            <div className="space-y-1.5">
              <Label htmlFor="new-branch-name">Branch name</Label>
              <Input
                id="new-branch-name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="Auto-generated if empty"
              />
            </div>
          )}

          {executionTarget === "existing-worktree" && (
            <div className="space-y-1.5">
              <Label>Select worktree</Label>
              <Select value={selectedWorktreePath} onValueChange={(v) => { if (v) setSelectedWorktreePath(v); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a worktree" />
                </SelectTrigger>
                <SelectContent>
                  {worktrees.map((wt) => (
                    <SelectItem key={wt.path} value={wt.path}>
                      {wt.branch} ({wt.path})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="branch-prompt">Prompt</Label>
            <Textarea
              id="branch-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the child thread work on?"
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!prompt.trim() || submitting}>
            {submitting ? "Branching..." : "Branch Thread"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
