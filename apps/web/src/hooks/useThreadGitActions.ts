import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { isPrable } from "@/lib/is-prable";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import type { Thread } from "@/transport";

/** Composer prefill the "Commit or push" action drops into the thread for the agent. */
export const COMMIT_PREFILL = "Commit and push the current changes.";

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

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id),
  );

  // Path to open: worktree path if available, otherwise workspace root.
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // PR affordances only apply to PR-able (worktree) threads. A direct-mode
  // thread runs against the main checkout and can never have a PR through this
  // app, so we skip all GitHub polling for it.
  const cwd = workspace?.path ?? null;
  const prable = isPrable(thread);
  const polledPr = useBranchPr(prable ? thread.branch : null, cwd);

  // polledPr is the live source of truth for state (OPEN / MERGED / CLOSED).
  // The store-backed entry fills the window right after creation, before the first
  // poll resolves. Only use it when cachedPrUrl is present — otherwise we'd produce
  // a PR object with url: "" which breaks the Open-in-browser action.
  const cachedPrUrl = useWorkspaceStore((s) => s.prUrlsByThreadId[thread.id]);
  const checks = useWorkspaceStore((s) => s.checksById[thread.id]) ?? null;

  // Pull PR metadata (title/author) from the openPrs cache for the popover header.
  const openPrDetail = useWorkspaceStore((s) => {
    if (thread.pr_number == null) return null;
    return s.openPrs.find((p) => p.number === thread.pr_number) ?? null;
  });
  const storePr =
    thread.pr_number != null && cachedPrUrl
      ? { number: thread.pr_number, url: cachedPrUrl, state: thread.pr_status ?? "OPEN" }
      : null;
  // When polledPr and storePr have different numbers, storePr is the freshly
  // created PR and polledPr is stale (not yet caught up). Prefer storePr.
  const pr =
    storePr != null && polledPr?.url && polledPr.number !== storePr.number
      ? storePr
      : (polledPr?.url ? polledPr : null) ?? storePr;

  // Whether the branch has commits ahead of base (disable Create PR when it doesn't).
  const hasCommitsAhead = useHasCommitsAhead(
    prable ? thread.workspace_id : "",
    prable ? thread.branch : null,
    prable ? thread.id : undefined,
  );

  // Sync polled PR state back to the workspace store so the project tree
  // icon reflects state changes (e.g. OPEN -> MERGED) in realtime.
  useEffect(() => {
    if (!pr) return;
    useWorkspaceStore.setState((ws) => {
      const stored = ws.threads.find((t) => t.id === thread.id);
      if (!stored) return ws;
      const stateChanged = stored.pr_status?.toLowerCase() !== pr.state.toLowerCase();
      const numberChanged = stored.pr_number !== pr.number;
      if (!stateChanged && !numberChanged) return ws;
      return {
        threads: ws.threads.map((t) =>
          t.id === thread.id ? { ...t, pr_number: pr.number, pr_status: pr.state } : t,
        ),
      };
    });
  }, [pr, thread.id]);

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
