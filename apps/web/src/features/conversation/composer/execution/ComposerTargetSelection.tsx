import { lazy, Suspense } from "react";
import { BranchPicker } from "@/components/chat/BranchPicker";
import {
  isDetachedTargetWorktree,
  useComposerTargetSelection,
  type ComposerTargetSelectionProps,
  type ComposerTargetScope,
} from "./useComposerTargetSelection";

const LazyWorktreePicker = lazy(() => import("@/components/chat/WorktreePicker"));

export type { ComposerTargetSelectionProps, ComposerTargetScope };

/** Renders branch, pull-request, and worktree choices for new-thread and branch flows. */
export function ComposerTargetSelection(props: ComposerTargetSelectionProps) {
  const target = useComposerTargetSelection(props);

  if (target.mode === "direct") {
    return (
      <BranchPicker
        branches={target.branches}
        selectedBranch={target.selectedBranch}
        onSelect={target.selectBranch}
        loading={target.branchesLoading}
        locked={false}
        triggerClassName={target.triggerClassName}
        iconSize={target.iconSize}
      />
    );
  }

  if (target.mode === "worktree") {
    return (
      <BranchPicker
        branches={target.branches}
        selectedBranch={target.selectedBranch}
        onSelect={target.selectBranch}
        loading={target.branchesLoading}
        locked={false}
        pullRequests={target.openPrs}
        prsLoading={target.openPrsLoading}
        fetchingBranch={target.fetchingBranch}
        onFetchAndSelect={target.fetchAndSelectPullRequest}
        triggerClassName={target.triggerClassName}
        iconSize={target.iconSize}
      />
    );
  }

  return (
    <>
      {isDetachedTargetWorktree(target.selectedWorktree) && (
        <BranchPicker
          branches={target.branches}
          selectedBranch={target.existingWorktreeBranch}
          onSelect={target.selectBranch}
          loading={target.branchesLoading}
          locked={false}
          triggerClassName={target.triggerClassName}
          iconSize={target.iconSize}
        />
      )}
      <Suspense fallback={<div className={target.triggerClassName ? "h-7 w-28 animate-pulse rounded-md bg-accent" : "h-7"} />}>
        <LazyWorktreePicker
          worktrees={target.worktrees}
          selectedPath={target.selectedPath}
          onSelect={target.selectWorktree}
          loading={target.worktreesLoading}
          triggerClassName={target.triggerClassName}
          iconSize={target.iconSize}
        />
      </Suspense>
    </>
  );
}
