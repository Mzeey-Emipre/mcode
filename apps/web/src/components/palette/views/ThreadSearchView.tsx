import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { ThreadFilterDropdown } from "@/components/sidebar/ThreadFilterDropdown";
import { ThreadSortControl } from "@/components/sidebar/ThreadSortControl";
import { getThreadStateMarker, ThreadStateMarker } from "@/components/sidebar/ThreadStateMarker";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useRecentThreadsStore } from "@/stores/recentThreadsStore";
import {
  useSidebarSearchStore,
  type SortDirection,
  type ThreadFilters,
  type ThreadSortField,
} from "@/stores/sidebarSearchStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { useShallow } from "zustand/shallow";
import { cn } from "@/lib/utils";
import type { ChecksStatus } from "@mcode/contracts";
import type { RecentThread, Thread } from "@/transport/types";

interface SearchRow {
  thread: Thread | RecentThread;
  workspaceName: string;
  workspacePath: string;
}

function getThreadSearchResultLabel(loading: boolean, hasQuery: boolean, resultCount: number): string {
  if (loading) return "Searching…";
  const resultNoun = resultCount === 1 ? "result" : "results";
  const recentNoun = resultCount === 1 ? "recent thread" : "recent threads";
  return hasQuery ? `${resultCount} ${resultNoun}` : `${resultCount} ${recentNoun}`;
}

function ThreadSearchToolbar({ loading, resultLabel, providers }: { loading: boolean; resultLabel: string; providers: string[] }) {
  return <div data-testid="thread-search-toolbar" className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5"><div aria-live="polite" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{loading && <Spinner size={12} aria-hidden />}<span>{resultLabel}</span></div><div className="flex shrink-0 items-center gap-1" role="toolbar" aria-label="Thread search controls"><ThreadSortControl showLabel /><ThreadFilterDropdown providers={providers} showLabel /></div></div>;
}

function ThreadSearchResults({ loading, rows, searchError, hasQuery, renderRow }: { loading: boolean; rows: SearchRow[]; searchError: boolean; hasQuery: boolean; renderRow: (row: SearchRow) => ReactNode }) {
  if (loading && rows.length === 0) return <CommandList className="max-h-[28rem] overflow-y-auto p-1.5"><div className="grid gap-1 px-1 py-2" aria-label="Loading threads">{[0, 1, 2].map((item) => <div key={item} className="flex h-14 animate-pulse items-center gap-3 rounded-md px-3"><span className="size-7 rounded-md bg-accent" /><span className="grid flex-1 gap-2"><span className="h-3 w-2/5 rounded bg-accent" /><span className="h-2.5 w-3/5 rounded bg-accent/70" /></span></div>)}</div></CommandList>;
  if (rows.length === 0) return <CommandList className="max-h-[28rem] overflow-y-auto p-1.5"><CommandEmpty>{searchError ? "Thread search is unavailable." : hasQuery ? "No matching threads." : "No recent threads."}</CommandEmpty></CommandList>;
  return <CommandList className="max-h-[28rem] overflow-y-auto p-1.5"><CommandGroup heading={hasQuery ? "Threads" : "Recent threads"}>{rows.map(renderRow)}</CommandGroup></CommandList>;
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

/** One compact thread record in the cross-project finder. */
function ThreadSearchResult({
  row,
  isRunning,
  hasPendingPermission,
  checks,
  onSelect,
}: {
  row: SearchRow;
  isRunning: boolean;
  hasPendingPermission: boolean;
  checks: ChecksStatus | undefined;
  onSelect: () => void;
}) {
  const { thread } = row;
  const isUserCompleted = thread.user_completed_at !== null;
  const marker = getThreadStateMarker({
    thread,
    checks,
    isRunning,
    hasPendingPermission,
  });

  return (
    <CommandItem
      value={thread.id}
      onSelect={onSelect}
      className="group min-h-9 gap-3 rounded-md px-3 py-1.5"
      data-testid={`thread-search-result-${thread.id}`}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-medium text-foreground",
          isUserCompleted &&
            "text-muted-foreground line-through decoration-muted-foreground decoration-1",
        )}
      >
        {thread.title}
      </span>
      <div className="flex min-w-0 shrink items-center justify-end gap-2 whitespace-nowrap text-xs text-muted-foreground">
        <span className="max-w-44 truncate text-right" title={row.workspacePath} aria-label={`Project, ${row.workspaceName}`}>
          {row.workspaceName}
        </span>
        <span aria-hidden className="text-muted-foreground/35">·</span>
        <span className="max-w-40 truncate font-mono" title={thread.branch} aria-label={`Branch, ${thread.branch}`}>
          {thread.branch}
        </span>
        <span className={cn(isUserCompleted && "grayscale opacity-45")}>
          <ThreadStateMarker marker={marker} />
        </span>
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
  const setProjectThreadView = useUiStore(
    (state) => state.setProjectThreadView,
  );
  const checksById = useWorkspaceStore((state) => state.checksById);
  const runningThreadIds = useThreadStore((state) => state.runningThreadIds);
  const pendingPermissionIds = useThreadStore(
    useShallow((state) => {
      const ids: string[] = [];
      for (const [threadId, record] of state.records) {
        if (record.permissions.some((permission) => !permission.settled)) ids.push(threadId);
      }
      return ids;
    }),
  );
  const pendingPermissionThreadIds = useMemo(
    () => new Set(pendingPermissionIds),
    [pendingPermissionIds],
  );

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
    setProjectThreadView(
      thread.workspace_id,
      thread.user_completed_at === null ? "active" : "completed",
    );
    setActiveWorkspace(thread.workspace_id);
    setActiveThread(thread.id);
    close();
  };

  const hasQuery = Boolean(query.trim());
  const loading = hasQuery ? isSearching : recentLoading;
  const resultLabel = getThreadSearchResultLabel(loading, hasQuery, rows.length);

  return (
    <>
      <ThreadSearchToolbar loading={loading} resultLabel={resultLabel} providers={providers} />
      <ThreadSearchResults loading={loading} rows={rows} searchError={searchError} hasQuery={hasQuery} renderRow={(row) => <ThreadSearchResult key={row.thread.id} row={row} isRunning={runningThreadIds.has(row.thread.id)} hasPendingPermission={pendingPermissionThreadIds.has(row.thread.id)} checks={checksById[row.thread.id]} onSelect={() => handleSelect(row.thread)} />} />
    </>
  );
}
