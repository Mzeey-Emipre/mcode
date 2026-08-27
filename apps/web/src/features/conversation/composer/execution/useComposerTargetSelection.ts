import { useCallback, useMemo } from "react";
import type { ComposerMode } from "@/components/chat/ModeSelector";
import type { GitBranch, PrDetail, Thread } from "@/transport";
import type { WorktreeInfo } from "@/transport/types";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { isDetachedWorktree, normalizeWorktreePath } from "@/lib/worktree";

/** The product flow that owns an execution target. */
export type ComposerTargetScope = "new-thread" | "branch";

/** Props for shared branch and worktree target selection. */
export type ComposerTargetSelectionProps =
  | {
    scope: "new-thread";
    mode: ComposerMode;
    workspaceId: string | undefined;
    variant: "context-strip" | "status-bar";
  }
  | {
    scope: "branch";
    mode: ComposerMode;
    sourceThread?: Pick<Thread, "base_branch" | "branch">;
    variant: "context-strip" | "status-bar";
  };

interface TargetScopeContext {
  isNewThread: boolean;
  workspaceId: string | undefined;
  sourceThread: Pick<Thread, "base_branch" | "branch"> | undefined;
}

interface ComposerTargetStoreState {
  branches: GitBranch[];
  branchesLoading: boolean;
  newThreadBranch: string;
  branchTargetBranch: string;
  branchWorktreePath: string;
  selectedWorktree: WorktreeInfo | null;
  worktrees: WorktreeInfo[];
  worktreesLoading: boolean;
  openPrs: PrDetail[];
  openPrsLoading: boolean;
  fetchingBranch: string | null;
  setNewThreadBranch(branch: string): void;
  setNewThreadBranchFromPr(branch: string): void;
  setSelectedWorktree(worktree: WorktreeInfo | null): void;
  setBranchTargetBranch(branch: string): void;
  setBranchWorktreePath(path: string): void;
  fetchBranch(workspaceId: string, branch: string, pullRequestNumber?: number): Promise<void>;
}

interface BranchSelection {
  selectedBranch: string;
  existingWorktreeBranch: string;
}

interface PullRequestSelection {
  openPrs: PrDetail[] | undefined;
  openPrsLoading: boolean | undefined;
  fetchingBranch: string | null | undefined;
}

interface TargetPresentation {
  triggerClassName: string | undefined;
  iconSize: number | undefined;
}

function resolveTargetScopeContext(props: ComposerTargetSelectionProps): TargetScopeContext {
  if (props.scope === "new-thread") {
    return { isNewThread: true, workspaceId: props.workspaceId, sourceThread: undefined };
  }
  return { isNewThread: false, workspaceId: undefined, sourceThread: props.sourceThread };
}

function useComposerTargetStoreState(): ComposerTargetStoreState {
  return {
    branches: useWorkspaceStore((state) => state.branches),
    branchesLoading: useWorkspaceStore((state) => state.branchesLoading),
    newThreadBranch: useWorkspaceStore((state) => state.newThreadBranch),
    branchTargetBranch: useWorkspaceStore((state) => state.branchTargetBranch),
    branchWorktreePath: useWorkspaceStore((state) => state.branchWorktreePath),
    selectedWorktree: useWorkspaceStore((state) => state.selectedWorktree),
    worktrees: useWorkspaceStore((state) => state.worktrees),
    worktreesLoading: useWorkspaceStore((state) => state.worktreesLoading),
    openPrs: useWorkspaceStore((state) => state.openPrs),
    openPrsLoading: useWorkspaceStore((state) => state.openPrsLoading),
    fetchingBranch: useWorkspaceStore((state) => state.fetchingBranch),
    setNewThreadBranch: useWorkspaceStore((state) => state.setNewThreadBranch),
    setNewThreadBranchFromPr: useWorkspaceStore((state) => state.setNewThreadBranchFromPr),
    setSelectedWorktree: useWorkspaceStore((state) => state.setSelectedWorktree),
    setBranchTargetBranch: useWorkspaceStore((state) => state.setBranchTargetBranch),
    setBranchWorktreePath: useWorkspaceStore((state) => state.setBranchWorktreePath),
    fetchBranch: useWorkspaceStore((state) => state.fetchBranch),
  };
}

function getSelectedThreadBranch(
  branchTargetBranch: string,
  sourceThread: TargetScopeContext["sourceThread"],
): string {
  if (branchTargetBranch) return branchTargetBranch;
  return sourceThread?.branch || "";
}

function getExistingWorktreeBranch(
  branchTargetBranch: string,
  sourceThread: TargetScopeContext["sourceThread"],
): string {
  if (branchTargetBranch) return branchTargetBranch;
  if (sourceThread?.base_branch) return sourceThread.base_branch;
  return sourceThread?.branch || "main";
}

function getBranchSelection(
  isNewThread: boolean,
  newThreadBranch: string,
  branchTargetBranch: string,
  sourceThread: TargetScopeContext["sourceThread"],
): BranchSelection {
  if (isNewThread) {
    const selectedBranch = newThreadBranch || "main";
    return { selectedBranch, existingWorktreeBranch: selectedBranch };
  }
  return {
    selectedBranch: getSelectedThreadBranch(branchTargetBranch, sourceThread),
    existingWorktreeBranch: getExistingWorktreeBranch(branchTargetBranch, sourceThread),
  };
}

function useSelectedWorktree(
  isNewThread: boolean,
  selectedWorktree: WorktreeInfo | null,
  branchWorktreePath: string,
  worktrees: WorktreeInfo[],
): WorktreeInfo | null {
  return useMemo(() => {
    if (isNewThread) return selectedWorktree;
    const normalizedPath = normalizeWorktreePath(branchWorktreePath);
    return worktrees.find((worktree) => normalizeWorktreePath(worktree.path) === normalizedPath) ?? null;
  }, [branchWorktreePath, isNewThread, selectedWorktree, worktrees]);
}

function getPullRequestSelection(
  isNewThread: boolean,
  openPrs: PrDetail[],
  openPrsLoading: boolean,
  fetchingBranch: string | null,
): PullRequestSelection {
  if (!isNewThread) {
    return { openPrs: undefined, openPrsLoading: undefined, fetchingBranch: undefined };
  }
  return { openPrs, openPrsLoading, fetchingBranch };
}

function getTargetPresentation(variant: ComposerTargetSelectionProps["variant"]): TargetPresentation {
  if (variant !== "context-strip") return { triggerClassName: undefined, iconSize: undefined };
  return {
    triggerClassName: "h-[28px] gap-[6px] rounded-md px-[10px] text-xs font-medium leading-none",
    iconSize: 14,
  };
}

function useTargetSelectionActions(
  isNewThread: boolean,
  workspaceId: string | undefined,
  store: ComposerTargetStoreState,
) {
  const {
    setNewThreadBranch,
    setNewThreadBranchFromPr,
    setSelectedWorktree,
    setBranchTargetBranch,
    setBranchWorktreePath,
    fetchBranch,
  } = store;
  const selectWorktree = useCallback((worktree: WorktreeInfo) => {
    if (isNewThread) {
      setSelectedWorktree(worktree);
      return;
    }
    setBranchWorktreePath(worktree.path);
  }, [isNewThread, setBranchWorktreePath, setSelectedWorktree]);
  const fetchAndSelectPullRequest = useCallback(async (branch: string, pullRequestNumber: number) => {
    if (!workspaceId) return;
    await fetchBranch(workspaceId, branch, pullRequestNumber);
    setNewThreadBranchFromPr(branch);
  }, [fetchBranch, setNewThreadBranchFromPr, workspaceId]);

  return {
    selectBranch: isNewThread ? setNewThreadBranch : setBranchTargetBranch,
    selectWorktree,
    fetchAndSelectPullRequest: isNewThread ? fetchAndSelectPullRequest : undefined,
  };
}

/** State and actions that drive a Composer execution target picker. */
export interface ComposerTargetSelectionState {
  mode: ComposerMode;
  selectedBranch: string;
  selectedWorktree: WorktreeInfo | null;
  existingWorktreeBranch: string;
  selectedPath: string;
  branches: GitBranch[];
  branchesLoading: boolean;
  worktrees: WorktreeInfo[];
  worktreesLoading: boolean;
  openPrs: PrDetail[] | undefined;
  openPrsLoading: boolean | undefined;
  fetchingBranch: string | null | undefined;
  selectBranch(branch: string): void;
  selectWorktree(worktree: WorktreeInfo): void;
  fetchAndSelectPullRequest: ((branch: string, pullRequestNumber: number) => Promise<void>) | undefined;
  triggerClassName: string | undefined;
  iconSize: number | undefined;
}

/** Owns target picker state, including worktree lookup and pull-request branch selection. */
export function useComposerTargetSelection(
  props: ComposerTargetSelectionProps,
): ComposerTargetSelectionState {
  const scope = resolveTargetScopeContext(props);
  const store = useComposerTargetStoreState();
  const branchSelection = getBranchSelection(
    scope.isNewThread,
    store.newThreadBranch,
    store.branchTargetBranch,
    scope.sourceThread,
  );
  const selectedWorktree = useSelectedWorktree(
    scope.isNewThread,
    store.selectedWorktree,
    store.branchWorktreePath,
    store.worktrees,
  );
  const actions = useTargetSelectionActions(scope.isNewThread, scope.workspaceId, store);
  const pullRequestSelection = getPullRequestSelection(
    scope.isNewThread,
    store.openPrs,
    store.openPrsLoading,
    store.fetchingBranch,
  );
  const presentation = getTargetPresentation(props.variant);

  return {
    mode: props.mode,
    ...branchSelection,
    selectedWorktree,
    selectedPath: selectedWorktree?.path ?? (scope.isNewThread ? "" : store.branchWorktreePath),
    branches: store.branches,
    branchesLoading: store.branchesLoading,
    worktrees: store.worktrees,
    worktreesLoading: store.worktreesLoading,
    ...pullRequestSelection,
    ...actions,
    ...presentation,
  };
}

/** Determines whether the selected worktree needs an explicit branch picker. */
export function isDetachedTargetWorktree(worktree: WorktreeInfo | null): boolean {
  return isDetachedWorktree(worktree);
}
