import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { isPrable } from "@/lib/is-prable";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import type { Thread } from "@/transport";

/** Composer prefill the "Commit or push" action drops into the thread for the agent. */
export const COMMIT_PREFILL = "Commit and push the current changes.";

function resolveStoredPr(
  thread: Thread,
  cachedPrUrl: string | undefined,
): { number: number; url: string; state: string } | null {
  if (thread.pr_number === null || !cachedPrUrl) return null;
  return {
    number: thread.pr_number,
    url: cachedPrUrl,
    state: thread.pr_status ?? "OPEN",
  };
}

function resolveCurrentPr<T extends { number: number; url: string; state: string }>(
  polledPr: T | null | undefined,
  storePr: { number: number; url: string; state: string } | null,
): T | { number: number; url: string; state: string } | null {
  if (storePr && polledPr?.url && polledPr.number !== storePr.number) return storePr;
  return polledPr?.url ? polledPr : storePr;
}

function useThreadPrState(thread: Thread) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === thread.workspace_id),
  );
  const prable = isPrable(thread);
  const cwd = workspace?.path ?? null;
  const polledPr = useBranchPr(
    prable ? thread.branch : null,
    cwd,
  );
  const cachedPrUrl = useWorkspaceStore((state) => state.prUrlsByThreadId[thread.id]);
  const checks = useWorkspaceStore((state) => state.checksById[thread.id]) ?? null;
  const openPrDetail = useWorkspaceStore((state) => {
    if (thread.pr_number === null) return null;
    return state.openPrs.find((candidate) => candidate.number === thread.pr_number) ?? null;
  });
  const storePr = resolveStoredPr(thread, cachedPrUrl);
  const pr = resolveCurrentPr(polledPr, storePr);

  useEffect(() => {
    if (!pr) return;
    useWorkspaceStore.setState((workspaceState) => {
      const stored = workspaceState.threads.find((candidate) => candidate.id === thread.id);
      if (!stored) return workspaceState;
      const stateChanged = stored.pr_status?.toLowerCase() !== pr.state.toLowerCase();
      const numberChanged = stored.pr_number !== pr.number;
      if (!stateChanged && !numberChanged) return workspaceState;
      return {
        threads: workspaceState.threads.map((candidate) =>
          candidate.id === thread.id
            ? { ...candidate, pr_number: pr.number, pr_status: pr.state }
            : candidate,
        ),
      };
    });
  }, [pr, thread.id]);

  return {
    workspace,
    prable,
    pr,
    checks,
    openPrDetail,
  };
}

/**
 * Shared commit-or-push / create-PR orchestration for a thread, so the chat
 * header and the Review toolbar surface the same actions and PR state from one
 * place. Polls the branch PR + commits-ahead, derives the live PR (preferring a
 * freshly-created store entry over a stale poll), and syncs PR state back to the
 * workspace store. "Commit or push" prefills the composer; the agent does the
 * work (there is no direct git-commit transport). "Create PR" opens
 * `CreatePrDialog`, which the consumer renders with `createPrOpen`.
 */
export function useThreadGitActions(thread: Thread) {
  const [createPrOpen, setCreatePrOpen] = useState(false);
  const { workspace, prable, pr, checks, openPrDetail } = useThreadPrState(thread);
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // Whether the branch has commits ahead of base (disable Create PR when it doesn't).
  const hasCommitsAhead = useHasCommitsAhead(
    prable ? thread.workspace_id : "",
    prable ? thread.branch : null,
    prable ? thread.id : undefined,
  );

  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);
  const handleCommitOrPush = useCallback(() => {
    setPendingPrefill(COMMIT_PREFILL);
  }, [setPendingPrefill]);

  const handleOpenPr = useCallback(
    (url: string, event?: MouseEvent) => {
      openGitHubUrl(url, thread.id, event);
    },
    [thread.id],
  );

  return {
    prable,
    pr,
    hasCommitsAhead,
    checks,
    openPrDetail,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommitOrPush,
    handleOpenPr,
  };
}
