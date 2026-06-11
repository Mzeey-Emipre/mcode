import { useEffect, useState } from "react";
import { getTransport } from "@/transport";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { FileList } from "./FileList";

/** The threadless git working-tree views the Review tab renders against the workspace root. */
export type GitView = "unstaged" | "staged" | "commit" | "branch";

/** Props for GitDiffView. */
interface GitDiffViewProps {
  /** Which working-tree view to render. */
  view: GitView;
  /** Active workspace id. Threadless, the views read its root. */
  workspaceId: string;
  /**
   * Active thread id, when a thread is open. The git views are dual-scope: in a
   * thread they read the thread's checkout (its worktree) rather than the
   * workspace root, so the diff reflects the thread's work.
   */
  threadId?: string;
}

/** Resolved file list plus the FileList source/id needed to fetch each file's diff. */
interface Resolved {
  files: string[];
  source: SelectedFile["source"];
  /** FileList row id: the workspace id for working-tree/branch views, the SHA for commit. */
  id: string;
}

/** The empty-state glyph + label shown for a view with no changes. */
function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
      <span aria-hidden="true" className="font-mono text-[28px] leading-none text-muted-foreground/15">
        ⊘
      </span>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
        {label}
      </p>
    </div>
  );
}

/** The three-dot loading pulse shared across the diff views. */
function LoadingPulse() {
  return (
    <div className="flex items-center justify-center gap-1.5 py-10">
      {[0, 150, 300].map((delay) => (
        <div
          key={delay}
          className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * Renders one threadless git working-tree view (Unstaged, Staged, Commit, or
 * Branch) as a single navigable diff: a file tree whose rows lazy-load their
 * per-file diff. Reads the workspace root via the git transport. The Commit view
 * resolves to the latest HEAD commit; Branch compares the current branch to its
 * default base. See CONTEXT.md → "Review tab".
 */
export function GitDiffView({ view, workspaceId, threadId }: GitDiffViewProps) {
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [loading, setLoading] = useState(true);

  // The Branch view's diff is driven by the current branch plus the selected
  // comparison ref. Subscribe so picking a new target refetches the file list.
  const branchBase = useDiffStore((s) => s.branchComparison?.base ?? null);
  const branchTarget = useDiffStore((s) => s.branchComparison?.target ?? null);
  const branchUnborn = useDiffStore((s) => s.branchComparison?.isUnborn ?? false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResolved(null);

    // Branch view waits for the picker to resolve a pair before fetching, unless
    // HEAD is unborn (explicit empty). Holding `loading` avoids a flash of the
    // empty state with a stale/default range during resolution.
    if (view === "branch" && !branchUnborn && (!branchBase || !branchTarget)) {
      return () => {
        cancelled = true;
      };
    }

    const load = async (): Promise<Resolved> => {
      const transport = getTransport();
      if (view === "unstaged" || view === "staged") {
        const files = await transport.getWorkingTreeFiles(workspaceId, view === "staged", threadId);
        return { files, source: view, id: workspaceId };
      }
      if (view === "branch") {
        if (branchUnborn || !branchBase || !branchTarget) {
          return { files: [], source: "branch", id: "branch-empty" };
        }
        const files = await transport.getBranchFiles(workspaceId, branchBase, branchTarget, threadId);
        // The comparison range is folded into the FileList id so the inline diff
        // cache and per-file fetch vary by pair (git refnames can't contain "..").
        return { files, source: "branch", id: `${branchBase}...${branchTarget}` };
      }
      // Commit view: the latest HEAD commit (the thread's worktree HEAD when in a
      // thread). Worktrees share the object store, so the per-file diff fetched by
      // FileList against the workspace root still resolves the worktree's commit.
      const log = await transport.getGitLog(workspaceId, undefined, 1, undefined, threadId);
      const sha = log[0]?.sha;
      if (!sha) return { files: [], source: "commit", id: workspaceId };
      const files = await transport.getCommitFiles(workspaceId, sha);
      return { files, source: "commit", id: sha };
    };

    void load()
      .then((next) => {
        if (!cancelled) {
          setResolved(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ files: [], source: view, id: workspaceId });
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // threadId is a fetch input: switching threads (or thread↔threadless) on the
    // same view+workspace must refetch the worktree's file list, not keep the
    // previous scope's stale diff. branchBase/branchTarget/branchUnborn are fetch
    // inputs for the Branch view: picking a new ref pair refetches its file list.
  }, [view, workspaceId, threadId, branchBase, branchTarget, branchUnborn]);

  if (loading) return <LoadingPulse />;
  if (!resolved || resolved.files.length === 0) {
    return <EmptyState label={view === "commit" ? "No commit yet" : "No changes"} />;
  }

  return (
    <div className="flex flex-col">
      <FileList
        files={resolved.files}
        source={resolved.source}
        id={resolved.id}
        // Cache + per-file fetch scope: the real thread (→ its worktree) when in a
        // thread, else the workspace id (the server reads the workspace root).
        threadId={threadId ?? workspaceId}
        defaultFilesExpanded={view === "branch"}
      />
    </div>
  );
}
