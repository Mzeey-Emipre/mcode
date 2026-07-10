import { create } from "zustand";
import { getTransport } from "@/transport";
import type { Thread } from "@/transport/types";

/** Sort field for threads in the sidebar. */
export type ThreadSortField = "updated_at" | "created_at" | "title";

/** Sort direction. */
export type SortDirection = "asc" | "desc";

/** Active filter state. */
export interface ThreadFilters {
  status: string[];
  provider: string[];
}

/** Persisted preferences restored from localStorage. */
interface PersistedPrefs {
  sortField: ThreadSortField;
  sortDirection: SortDirection;
  filters: ThreadFilters;
}

const STORAGE_KEY = "mcode-sidebar-search-prefs";
const VALID_THREAD_STATUSES = new Set([
  "active",
  "paused",
  "interrupted",
  "errored",
  "archived",
  "completed",
  "deleted",
]);

function loadPrefs(): PersistedPrefs {
  const defaults: PersistedPrefs = { sortField: "updated_at", sortDirection: "desc", filters: { status: [], provider: [] } };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const validFields = new Set<string>(["updated_at", "created_at", "title"]);
    const validDirs = new Set<string>(["asc", "desc"]);
    return {
      sortField: validFields.has(parsed?.sortField) ? parsed.sortField : "updated_at",
      sortDirection: validDirs.has(parsed?.sortDirection) ? parsed.sortDirection : "desc",
      filters: {
        status: Array.isArray(parsed?.filters?.status)
          ? parsed.filters.status.filter(
              (status: unknown): status is string =>
                typeof status === "string" && VALID_THREAD_STATUSES.has(status),
            )
          : [],
        provider: Array.isArray(parsed?.filters?.provider)
          ? parsed.filters.provider.filter(
              (provider: unknown): provider is string => typeof provider === "string",
            )
          : [],
      },
    };
  } catch {
    return defaults;
  }
}

function savePrefs(prefs: PersistedPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface SidebarSearchState {
  /** Current search query text. */
  query: string;
  /** Whether a server-side search is in flight. */
  isSearching: boolean;
  /** Threads returned from the server search (from unloaded workspaces). */
  serverResults: Thread[];
  /** Workspace context for server results (id, name, path). */
  serverWorkspaces: { id: string; name: string; path: string }[];
  /** Active sort field. */
  sortField: ThreadSortField;
  /** Active sort direction. */
  sortDirection: SortDirection;
  /** Active filters. */
  filters: ThreadFilters;
  /** Snapshot of expanded state before search began (for restoring on clear). */
  expandedSnapshot: Record<string, boolean> | null;
  /** Whether the last server search failed. */
  searchError: boolean;

  setQuery: (query: string) => void;
  setSortField: (field: ThreadSortField) => void;
  setSortDirection: (dir: SortDirection) => void;
  toggleSortDirection: () => void;
  toggleFilter: (category: "status" | "provider", value: string) => void;
  clearFilters: () => void;
  /** Clear only the search query, preserving active filters. */
  clearQuery: () => void;
  clearAll: () => void;
  setExpandedSnapshot: (snapshot: Record<string, boolean>) => void;
  /** Debounced server search. Call after query/filter changes. */
  executeServerSearch: () => Promise<void>;
}

/** Sidebar search, filter, and sort state. */
export const useSidebarSearchStore = create<SidebarSearchState>((set, get) => {
  const prefs = loadPrefs();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    query: "",
    isSearching: false,
    serverResults: [],
    serverWorkspaces: [],
    sortField: prefs.sortField,
    sortDirection: prefs.sortDirection,
    filters: prefs.filters,
    expandedSnapshot: null,
    searchError: false,

    setQuery: (query) => {
      const hasQuery = Boolean(query.trim());
      set({
        query,
        isSearching: hasQuery,
        serverResults: [],
        serverWorkspaces: [],
        searchError: false,
      });
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!hasQuery) {
        return;
      }
      debounceTimer = setTimeout(() => {
        get().executeServerSearch();
      }, 250);
    },

    setSortField: (field) => {
      set({ sortField: field });
      const { sortDirection, filters } = get();
      savePrefs({ sortField: field, sortDirection, filters });
      if (get().query.trim()) {
        if (debounceTimer) clearTimeout(debounceTimer);
        set({
          serverResults: [],
          serverWorkspaces: [],
          isSearching: true,
          searchError: false,
        });
        get().executeServerSearch();
      }
    },

    setSortDirection: (dir) => {
      set({ sortDirection: dir });
      const { sortField, filters } = get();
      savePrefs({ sortField, sortDirection: dir, filters });
      if (get().query.trim()) {
        if (debounceTimer) clearTimeout(debounceTimer);
        set({
          serverResults: [],
          serverWorkspaces: [],
          isSearching: true,
          searchError: false,
        });
        get().executeServerSearch();
      }
    },

    toggleSortDirection: () => {
      const dir = get().sortDirection === "asc" ? "desc" : "asc";
      get().setSortDirection(dir);
    },

    toggleFilter: (category, value) => {
      const filters = { ...get().filters };
      const arr = [...filters[category]];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(value);
      filters[category] = arr;
      set({ filters });
      const { sortField, sortDirection } = get();
      savePrefs({ sortField, sortDirection, filters });
      if (get().query.trim()) {
        if (debounceTimer) clearTimeout(debounceTimer);
        set({
          serverResults: [],
          serverWorkspaces: [],
          isSearching: true,
          searchError: false,
        });
        get().executeServerSearch();
      }
    },

    clearFilters: () => {
      const filters = { status: [], provider: [] };
      set({ filters });
      const { sortField, sortDirection } = get();
      savePrefs({ sortField, sortDirection, filters });
      if (get().query.trim()) {
        if (debounceTimer) clearTimeout(debounceTimer);
        set({
          serverResults: [],
          serverWorkspaces: [],
          isSearching: true,
          searchError: false,
        });
        get().executeServerSearch();
      }
    },

    clearQuery: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      set({
        query: "",
        serverResults: [],
        serverWorkspaces: [],
        isSearching: false,
        searchError: false,
      });
    },

    clearAll: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const filters = { status: [], provider: [] };
      set({
        query: "",
        filters,
        serverResults: [],
        serverWorkspaces: [],
        isSearching: false,
        searchError: false,
        expandedSnapshot: null,
      });
      const { sortField, sortDirection } = get();
      savePrefs({ sortField, sortDirection, filters });
    },

    setExpandedSnapshot: (snapshot) => {
      if (!get().expandedSnapshot) {
        set({ expandedSnapshot: snapshot });
      }
    },

    executeServerSearch: async () => {
      const { query, filters, sortField, sortDirection } = get();
      if (!query.trim()) {
        set({ isSearching: false, serverResults: [], serverWorkspaces: [] });
        return;
      }
      set({ isSearching: true });
      const requestKey = JSON.stringify({
        query: query.trim(),
        filters,
        sortField,
        sortDirection,
      });
      try {
        const result = await getTransport().searchThreads({
          query: query.trim(),
          filters: {
            status: filters.status.length > 0 ? filters.status : undefined,
            provider:
              filters.provider.length > 0 ? filters.provider : undefined,
          },
          sort: { field: sortField, direction: sortDirection },
        });
        const current = get();
        const currentKey = JSON.stringify({
          query: current.query.trim(),
          filters: current.filters,
          sortField: current.sortField,
          sortDirection: current.sortDirection,
        });
        if (currentKey === requestKey) {
          set({
            serverResults: result.threads,
            serverWorkspaces: result.workspaces,
            isSearching: false,
            searchError: false,
          });
        }
      } catch {
        const current = get();
        const currentKey = JSON.stringify({
          query: current.query.trim(),
          filters: current.filters,
          sortField: current.sortField,
          sortDirection: current.sortDirection,
        });
        if (currentKey === requestKey) {
          set({ isSearching: false, searchError: true });
        }
      }
    },
  };
});
