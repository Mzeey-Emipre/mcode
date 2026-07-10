import { useEffect, useLayoutEffect, useMemo, type ComponentType } from "react";
import { Activity, Folder, GitBranch } from "lucide-react";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import {
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorProviderIcon,
  GeminiIcon,
  OpenCodeIcon,
} from "@/components/chat/ProviderIcons";
import { ThreadFilterDropdown } from "@/components/sidebar/ThreadFilterDropdown";
import { ThreadSortControl } from "@/components/sidebar/ThreadSortControl";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useRecentThreadsStore } from "@/stores/recentThreadsStore";
import {
  useSidebarSearchStore,
  type SortDirection,
  type ThreadFilters,
  type ThreadSortField,
} from "@/stores/sidebarSearchStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { RecentThread, Thread } from "@/transport/types";

type ProviderIcon = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_ICONS: Record<string, ProviderIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  copilot: CopilotIcon,
  cursor: CursorProviderIcon,
  gemini: GeminiIcon,
  opencode: OpenCodeIcon,
};

interface SearchRow {
  thread: Thread | RecentThread;
  workspaceName: string;
  workspacePath: string;
}

function worktreeName(path: string | null): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Applies the thread finder's active filters and sort order to recent threads. */
export function filterAndSortRecentThreads(
  threads: RecentThread[],
  filters: ThreadFilters,
  sortField: ThreadSortField,
  sortDirection: SortDirection,
): RecentThread[] {
  return [...threads]
    .filter(
      (thread) =>
        (filters.status.length === 0 ||
          filters.status.includes(thread.status)) &&
        (filters.provider.length === 0 ||
          filters.provider.includes(thread.provider)),
    )
    .sort((left, right) => {
      const order =
        sortField === "title"
          ? left.title.localeCompare(right.title)
          : left[sortField].localeCompare(right[sortField]);
      return sortDirection === "asc" ? order : -order;
    });
}

/** One metadata-rich result in the cross-project thread finder. */
function ThreadSearchResult({
  row,
  onSelect,
}: {
  row: SearchRow;
  onSelect: () => void;
}) {
  const { thread } = row;
  const Provider = PROVIDER_ICONS[thread.provider] ?? Activity;
  const worktree = worktreeName(thread.worktree_path);

  return (
    <CommandItem
      value={thread.id}
      onSelect={onSelect}
      className="group min-h-16 items-start gap-2.5 rounded-md px-3 py-2.5"
      data-testid={`thread-search-result-${thread.id}`}
    >
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-muted-foreground group-aria-selected:text-foreground"
        aria-label={`Provider, ${thread.provider}`}
      >
        <Provider size={14} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {thread.title}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <span
            className="inline-flex min-w-0 items-center gap-1"
            title={row.workspacePath}
          >
            <Folder size={12} aria-hidden />
            <span className="max-w-40 truncate">{row.workspaceName}</span>
          </span>
          <span
            className="inline-flex min-w-0 items-center gap-1"
            title={thread.branch}
          >
            <GitBranch size={12} aria-hidden />
            <span className="max-w-44 truncate font-mono">{thread.branch}</span>
          </span>
          {worktree && (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={thread.worktree_path ?? undefined}
            >
              <WorktreeModeIcon size={12} aria-hidden />
              <span className="max-w-40 truncate font-mono">{worktree}</span>
            </span>
          )}
        </div>
      </div>
    </CommandItem>
  );
}

/** Dedicated command-palette view for finding threads across every project. */
export function ThreadSearchView() {
  const query = useCommandPaletteStore((state) => state.query);
  const close = useCommandPaletteStore((state) => state.close);
  const recentThreads = useRecentThreadsStore((state) => state.threads);
  const recentLoading = useRecentThreadsStore((state) => state.loading);
  const fetchRecent = useRecentThreadsStore((state) => state.fetch);
  const serverResults = useSidebarSearchStore((state) => state.serverResults);
  const serverWorkspaces = useSidebarSearchStore(
    (state) => state.serverWorkspaces,
  );
  const isSearching = useSidebarSearchStore((state) => state.isSearching);
  const searchError = useSidebarSearchStore((state) => state.searchError);
  const filters = useSidebarSearchStore((state) => state.filters);
  const sortField = useSidebarSearchStore((state) => state.sortField);
  const sortDirection = useSidebarSearchStore((state) => state.sortDirection);
  const setSearchQuery = useSidebarSearchStore((state) => state.setQuery);
  const clearSearchQuery = useSidebarSearchStore((state) => state.clearQuery);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const projectThreads = useWorkspaceStore((state) => state.threads);
  const setActiveWorkspace = useWorkspaceStore(
    (state) => state.setActiveWorkspace,
  );
  const setActiveThread = useWorkspaceStore((state) => state.setActiveThread);

  useEffect(() => {
    void fetchRecent(20);
  }, [fetchRecent]);

  useLayoutEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);

  useEffect(() => clearSearchQuery, [clearSearchQuery]);

  const workspaceById = useMemo(() => {
    const map = new Map<string, { name: string; path: string }>();
    for (const workspace of workspaces) {
      map.set(workspace.id, { name: workspace.name, path: workspace.path });
    }
    for (const workspace of serverWorkspaces) {
      map.set(workspace.id, { name: workspace.name, path: workspace.path });
    }
    return map;
  }, [serverWorkspaces, workspaces]);

  const sortedRecentThreads = useMemo(
    () =>
      filterAndSortRecentThreads(
        recentThreads,
        filters,
        sortField,
        sortDirection,
      ),
    [filters, recentThreads, sortDirection, sortField],
  );

  const rows = useMemo<SearchRow[]>(() => {
    if (!query.trim()) {
      return sortedRecentThreads.map((thread) => ({
        thread,
        workspaceName: thread.workspace_name,
        workspacePath: thread.workspace_path,
      }));
    }
    return serverResults.map((thread) => {
      const workspace = workspaceById.get(thread.workspace_id);
      return {
        thread,
        workspaceName: workspace?.name ?? "Unknown project",
        workspacePath: workspace?.path ?? "",
      };
    });
  }, [query, serverResults, sortedRecentThreads, workspaceById]);

  const providers = useMemo(
    () =>
      [
        ...new Set([
          ...projectThreads.map((thread) => thread.provider),
          ...recentThreads.map((thread) => thread.provider),
          ...serverResults.map((thread) => thread.provider),
        ]),
      ].sort(),
    [projectThreads, recentThreads, serverResults],
  );

  const handleSelect = (thread: Thread | RecentThread) => {
    setActiveWorkspace(thread.workspace_id);
    setActiveThread(thread.id);
    close();
  };

  const loading = query.trim() ? isSearching : recentLoading;
  const resultLabel = loading
    ? "Searching…"
    : query.trim()
      ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
      : `${rows.length} ${rows.length === 1 ? "recent thread" : "recent threads"}`;

  return (
    <>
      <div
        data-testid="thread-search-toolbar"
        className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5"
      >
        <div
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          {loading && <Spinner size={12} aria-hidden />}
          <span>{resultLabel}</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          role="toolbar"
          aria-label="Thread search controls"
        >
          <ThreadSortControl showLabel />
          <ThreadFilterDropdown providers={providers} showLabel />
        </div>
      </div>

      <CommandList className="max-h-[28rem] overflow-y-auto p-1.5">
        {loading && rows.length === 0 ? (
          <div className="grid gap-1 px-1 py-2" aria-label="Loading threads">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="flex h-14 animate-pulse items-center gap-3 rounded-md px-3"
              >
                <span className="size-7 rounded-md bg-accent" />
                <span className="grid flex-1 gap-2">
                  <span className="h-3 w-2/5 rounded bg-accent" />
                  <span className="h-2.5 w-3/5 rounded bg-accent/70" />
                </span>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <CommandEmpty>
            {searchError
              ? "Thread search is unavailable."
              : query.trim()
                ? "No matching threads."
                : "No recent threads."}
          </CommandEmpty>
        ) : (
          <CommandGroup heading={query.trim() ? "Threads" : "Recent threads"}>
            {rows.map((row) => (
              <ThreadSearchResult
                key={row.thread.id}
                row={row}
                onSelect={() => handleSelect(row.thread)}
              />
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
}
