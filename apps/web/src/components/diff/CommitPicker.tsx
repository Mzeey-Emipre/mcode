import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { GitCommit } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";

/** How many commits to load into the picker. Matches the Commits tab's window. */
const COMMIT_LIMIT = 100;

function mergeFirstPageCommits(current: GitCommit[], firstPage: GitCommit[]): GitCommit[] {
  const firstPageShas = new Set(firstPage.map((commit) => commit.sha));
  return [
    ...firstPage,
    ...current.slice(COMMIT_LIMIT).filter((commit) => !firstPageShas.has(commit.sha)),
  ];
}

/** Format an ISO date to a compact relative string (mirrors CommitEntry's scale). */
function relativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  if (!isFinite(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The Commit view's operand picker: a searchable dropdown over the branch's own
 * commits since its base, resolving to exactly one commit's diff. Default
 * selection is the latest commit (the thread's worktree HEAD in a thread). The
 * picked SHA lives in {@link useDiffStore} so the Commit diff renders against it.
 * Search filters by commit message and short SHA. See CONTEXT.md → "Commit".
 */
export function CommitPicker() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  // In a thread, scope the list to that thread's branch; threadless, the
  // workspace's current branch is resolved below. Both yield commits since base.
  const threadBranch = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === activeThreadId);
    return thread?.branch ?? undefined;
  });
  const selectedSha = useDiffStore((s) => s.selectedCommitSha);
  const setSelectedSha = useDiffStore((s) => s.setSelectedCommitSha);
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? (s.diffRevisionByScope[activeThreadId ?? activeWorkspaceId] ?? 0) : 0,
  );

  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");

  const loadCommits = useCallback(
    async (skip: number): Promise<GitCommit[]> => {
      const transport = getTransport();
      const branch = activeThreadId
        ? threadBranch
        : ((await transport.getCurrentBranch(activeWorkspaceId!)) ?? undefined);
      return transport.getGitLog(
        activeWorkspaceId!,
        branch,
        COMMIT_LIMIT,
        undefined,
        activeThreadId ?? undefined,
        { skip, includeStats: false },
      );
    },
    [activeWorkspaceId, activeThreadId, threadBranch],
  );

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    setCommits([]);
    setHasMore(false);
    setLoadingInitial(true);
    setLoadingMore(false);
    setSearch("");
    setSelectedSha(null);

    void loadCommits(0)
      .then((list) => {
        if (!cancelled) {
          setCommits(list);
          setHasMore(list.length === COMMIT_LIMIT);
          setLoadingInitial(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommits([]);
          setHasMore(false);
          setLoadingInitial(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, loadCommits, setSelectedSha]);

  useEffect(() => {
    if (!activeWorkspaceId || loadingInitial) return;
    let cancelled = false;

    void loadCommits(0)
      .then((list) => {
        if (!cancelled) {
          setCommits((current) => mergeFirstPageCommits(current, list));
          setHasMore(list.length === COMMIT_LIMIT);
        }
      })
      .catch(() => {
        if (!cancelled) setHasMore(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, diffScopeRevision, loadCommits, loadingInitial]);

  useEffect(() => {
    if (!open || !activeWorkspaceId || loadingInitial) return;
    let cancelled = false;

    void loadCommits(0)
      .then((list) => {
        if (!cancelled) {
          setCommits((current) => mergeFirstPageCommits(current, list));
          setHasMore(list.length === COMMIT_LIMIT);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommits([]);
          setHasMore(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, loadCommits, loadingInitial, open]);

  const loadOlder = useCallback(async () => {
    if (loadingInitial || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const list = await loadCommits(commits.length);
      setCommits((current) => [...current, ...list]);
      setHasMore(list.length === COMMIT_LIMIT);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [commits.length, hasMore, loadCommits, loadingInitial, loadingMore]);

  // Default to the latest commit, and recover when the active pick falls out of
  // the current scope's list (thread or branch switch on the same Commit view).
  useEffect(() => {
    if (loadingInitial) return;
    const present = selectedSha !== null && commits.some((c) => c.sha === selectedSha);
    if (!present) setSelectedSha(commits[0]?.sha ?? null);
  }, [commits, loadingInitial, selectedSha, setSelectedSha]);

  const selected = useMemo(
    () => commits.find((c) => c.sha === selectedSha) ?? null,
    [commits, selectedSha],
  );

  const empty = !loadingInitial && commits.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="commit-picker-trigger"
        disabled={loadingInitial || empty}
        aria-label="Pick a commit"
        className="flex h-6 min-w-0 max-w-[220px] items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
      >
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/55">
          {selected?.shortSha ?? (loadingInitial ? "..." : "-")}
        </span>
        {selected && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {selected.message}
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" />
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={4} className="w-80 p-0">
        <Command>
          <CommandInput
            placeholder="Search commits…"
            value={search}
            onValueChange={setSearch}
            className="h-8 text-[11.5px]"
          />
          <CommandList>
            <CommandEmpty className="py-4 text-[11px]">No commits found</CommandEmpty>
            {commits.map((commit) => {
              const active = commit.sha === selectedSha;
              return (
                <CommandItem
                  key={commit.sha}
                  // cmdk filters on this value, so search matches short SHA + message.
                  value={`${commit.shortSha} ${commit.message}`}
                  data-testid={`commit-picker-item-${commit.shortSha}`}
                  aria-current={active ? "true" : undefined}
                  onSelect={() => {
                    setSelectedSha(commit.sha);
                    setOpen(false);
                  }}
                  className="gap-2 px-2 py-1.5"
                >
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/60">
                    {commit.shortSha}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/80">
                    {commit.message}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45">
                    {relativeTime(commit.date)}
                  </span>
                  {active && <Check size={11} className="shrink-0 text-muted-foreground" />}
                </CommandItem>
              );
            })}
            {hasMore && (
              <div className="border-t border-border/40 p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={loadOlder}
                  className="h-7 w-full justify-center text-[11px] text-muted-foreground"
                >
                  {loadingMore
                    ? "Loading older commits..."
                    : search.trim()
                      ? "Search older commits"
                      : "Load older commits"}
                </Button>
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
