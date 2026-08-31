import { useCallback, useEffect, useMemo } from "react";
import { ALL_MODE_OPTIONS, type ComposerMode, type ModeOption } from "@/components/chat/ModeSelector";
import type { Thread } from "@/transport";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useComposerPrDetection } from "../draft/useComposerPrDetection";
import { isDetachedWorktree, normalizeWorktreePath } from "@/lib/worktree";
import { rememberComposerMode } from "@/lib/composer-mode-preference";

/** The selected execution target for the current Composer session. */
export type ComposerExecutionTarget =
  | {
    kind: "new-thread";
    mode: ComposerMode;
    branch: string;
    branchSource: "branch" | "pr";
    hasWorktree: boolean;
  }
  | {
    kind: "branch";
    mode: ComposerMode;
    branch: string;
    worktreePath: string | null;
    worktreeIsDetached: boolean;
  }
  | {
    kind: "existing-thread";
    mode: ComposerMode;
  };

/** Inputs that identify the Composer execution flow. */
export interface UseComposerExecutionTargetOptions {
  input: string;
  activeThread?: Thread;
  branchFromMessageId?: string;
  isNewThread: boolean;
  workspaceId?: string;
}

/** Execution target state and operations for new-thread, branch, and existing-thread Composer flows. */
export interface ComposerExecutionTargetController {
  target: ComposerExecutionTarget;
  mode: ComposerMode;
  modeOptions: ModeOption[];
  isGitRepo: boolean;
  needsWorkspace: boolean;
  isStaleWorktree: boolean;
  workspacePath?: string;
  selectedWorktree: ReturnType<typeof useWorkspaceStore.getState>["selectedWorktree"];
  newThreadBranch: string;
  newThreadBranchSource: "branch" | "pr";
  branchExecMode: ComposerMode;
  branchTargetBranch: string;
  branchWorktreePath: string | null;
  branchWorktreeIsDetached: boolean;
  fetchingBranch: boolean;
  detectedPullRequest: ReturnType<typeof useComposerPrDetection>["detectedPr"];
  setMode(mode: ComposerMode): void;
  setBranchMode(mode: ComposerMode): void;
  dismissDetectedPullRequest(): void;
  resetDetectedPullRequest(): void;
  reviewDetectedPullRequest(): Promise<string | null>;
  setNewThreadMode(mode: ComposerMode): void;
  setNewThreadBranch(branch: string): void;
  setNewThreadBranchFromPullRequest(branch: string): void;
}

/** Owns the Composer execution target selection and its workspace data lifecycle. */
export function useComposerExecutionTarget({
  input,
  activeThread,
  branchFromMessageId,
  isNewThread,
  workspaceId,
}: UseComposerExecutionTargetOptions): ComposerExecutionTargetController {
  const activeWorkspace = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId),
  );
  const branches = useWorkspaceStore((state) => state.branches);
  const newThreadMode = useWorkspaceStore((state) => state.newThreadMode);
  const newThreadBranch = useWorkspaceStore((state) => state.newThreadBranch);
  const newThreadBranchSource = useWorkspaceStore((state) => state.newThreadBranchSource);
  const selectedWorktree = useWorkspaceStore((state) => state.selectedWorktree);
  const branchExecMode = useWorkspaceStore((state) => state.branchExecMode);
  const branchTargetBranch = useWorkspaceStore((state) => state.branchTargetBranch);
  const branchWorktreePath = useWorkspaceStore((state) => state.branchWorktreePath);
  const worktrees = useWorkspaceStore((state) => state.worktrees);
  const worktreesLoadedForWorkspace = useWorkspaceStore((state) => state.worktreesLoadedForWorkspace);
  const fetchingBranch = useWorkspaceStore((state) => state.fetchingBranch);
  const loadBranches = useWorkspaceStore((state) => state.loadBranches);
  const loadOpenPrs = useWorkspaceStore((state) => state.loadOpenPrs);
  const loadWorktrees = useWorkspaceStore((state) => state.loadWorktrees);
  const initBranchMode = useWorkspaceStore((state) => state.initBranchMode);
  const fetchBranch = useWorkspaceStore((state) => state.fetchBranch);
  const setBranchExecMode = useWorkspaceStore((state) => state.setBranchExecMode);
  const setNewThreadMode = useWorkspaceStore((state) => state.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((state) => state.setNewThreadBranch);
  const setNewThreadBranchFromPr = useWorkspaceStore((state) => state.setNewThreadBranchFromPr);
  const isGitRepo = activeWorkspace?.is_git_repo ?? false;
  const needsWorkspace = isNewThread && !workspaceId;
  const composerMode = isNewThread
    ? (isGitRepo ? newThreadMode : "direct")
    : (activeThread?.mode === "worktree" ? "worktree" : "direct");
  const lookupPullRequest = useCallback((url: string) => getTransport().getPrByUrl(url), []);
  const {
    detectedPr,
    dismiss: dismissDetectedPullRequest,
    reset: resetDetectedPullRequest,
  } = useComposerPrDetection({
    input,
    enabled: isNewThread && isGitRepo,
    lookup: lookupPullRequest,
  });
  const branchSelectedWorktree = useMemo(() => {
    const normalizedPath = normalizeWorktreePath(branchWorktreePath);
    return worktrees.find((worktree) => normalizeWorktreePath(worktree.path) === normalizedPath) ?? null;
  }, [branchWorktreePath, worktrees]);
  const branchWorktreeIsDetached = isDetachedWorktree(branchSelectedWorktree);
  const isStaleWorktree = useMemo(() => {
    if (!activeThread?.worktree_path || activeThread.mode !== "worktree") return false;
    if (worktreesLoadedForWorkspace !== activeThread.workspace_id) return false;
    const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    return !worktrees.some((worktree) => normalizePath(worktree.path) === normalizePath(activeThread.worktree_path!));
  }, [activeThread, worktrees, worktreesLoadedForWorkspace]);
  const modeOptions = useMemo<ModeOption[]>(
    () => isGitRepo ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((option) => option.value === "direct"),
    [isGitRepo],
  );

  const setMode = useCallback(
    (mode: ComposerMode) => {
      setNewThreadMode(mode);
      rememberComposerMode(mode);
      if (mode === "existing-worktree" && workspaceId) {
        loadWorktrees(workspaceId);
      }
    },
    [loadWorktrees, setNewThreadMode, workspaceId],
  );

  useEffect(() => {
    if (!branchFromMessageId || !workspaceId) return;
    initBranchMode(activeThread);
    loadBranches(workspaceId);
    loadWorktrees(workspaceId);
  }, [activeThread, branchFromMessageId, initBranchMode, loadBranches, loadWorktrees, workspaceId]);

  useEffect(() => {
    if (isNewThread && workspaceId && isGitRepo) loadBranches(workspaceId);
  }, [isGitRepo, isNewThread, loadBranches, workspaceId]);

  useEffect(() => {
    if (!isNewThread || newThreadBranch || branches.length === 0) return;
    const currentBranch = branches.find((branch) => branch.isCurrent);
    if (currentBranch) setNewThreadBranch(currentBranch.name);
  }, [branches, isNewThread, newThreadBranch, setNewThreadBranch]);

  useEffect(() => {
    if (isNewThread && workspaceId && composerMode === "worktree") loadOpenPrs(workspaceId);
  }, [composerMode, isNewThread, loadOpenPrs, workspaceId]);

  const reviewDetectedPullRequest = useCallback(async (): Promise<string | null> => {
    if (!detectedPr || !workspaceId) return null;
    setMode("worktree");
    await fetchBranch(workspaceId, detectedPr.branch, detectedPr.number);
    setNewThreadBranchFromPr(detectedPr.branch);
    resetDetectedPullRequest();
    return `Review PR #${detectedPr.number}: ${detectedPr.title}`;
  }, [detectedPr, fetchBranch, resetDetectedPullRequest, setMode, setNewThreadBranchFromPr, workspaceId]);

  const target = useMemo<ComposerExecutionTarget>(() => {
    if (isNewThread) {
      return {
        kind: "new-thread",
        mode: composerMode,
        branch: newThreadBranch,
        branchSource: newThreadBranchSource,
        hasWorktree: selectedWorktree !== null,
      };
    }
    if (branchFromMessageId) {
      return {
        kind: "branch",
        mode: branchExecMode,
        branch: branchTargetBranch,
        worktreePath: branchWorktreePath,
        worktreeIsDetached: branchWorktreeIsDetached,
      };
    }
    return { kind: "existing-thread", mode: composerMode };
  }, [branchExecMode, branchFromMessageId, branchTargetBranch, branchWorktreeIsDetached, branchWorktreePath, composerMode, isNewThread, newThreadBranch, newThreadBranchSource, selectedWorktree]);

  return {
    target,
    mode: composerMode,
    modeOptions,
    isGitRepo,
    needsWorkspace,
    isStaleWorktree,
    workspacePath: activeWorkspace?.path,
    selectedWorktree,
    newThreadBranch,
    newThreadBranchSource,
    branchExecMode,
    branchTargetBranch,
    branchWorktreePath,
    branchWorktreeIsDetached,
    fetchingBranch: Boolean(fetchingBranch),
    detectedPullRequest: detectedPr,
    setMode,
    setBranchMode: setBranchExecMode,
    dismissDetectedPullRequest,
    resetDetectedPullRequest,
    reviewDetectedPullRequest,
    setNewThreadMode,
    setNewThreadBranch,
    setNewThreadBranchFromPullRequest: setNewThreadBranchFromPr,
  };
}
