import { create } from "zustand";
import { getTransport } from "@/transport";
import type { RecentThread } from "@/transport/types";

interface State {
  /** Most recent threads across all workspaces, freshest first. */
  threads: RecentThread[];
  /** True while the initial fetch is in flight. */
  loading: boolean;
  /** Last error from the fetch, if any. */
  error: string | null;
  /**
   * Fetch the latest cross-workspace recent threads. Idempotent — replaces the
   * cached list. The landing calls this on mount; future invalidations (thread
   * created/deleted/updated) can call this again.
   */
  fetch: (limit?: number) => Promise<void>;
  /**
   * Optimistically remove a thread from the list (e.g. after deletion or when
   * the user opens it and the landing remounts). Avoids a re-fetch round-trip.
   */
  remove: (threadId: string) => void;
}

/**
 * Cross-workspace recent threads cache used by the landing's "Recent threads"
 * section. Single in-flight fetch is enforced via the `loading` flag so a
 * remount during slow networks doesn't issue parallel RPCs.
 */
export const useRecentThreadsStore = create<State>((set, get) => ({
  threads: [],
  loading: false,
  error: null,

  fetch: async (limit = 12) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const threads = await getTransport().listRecentThreads(limit);
      // Coerce a null/undefined RPC result to [] so the store never violates its
      // own `threads: RecentThread[]` invariant. A null here would crash the
      // landing's `recentThreads.slice(...)` on a partial or legacy server reply.
      set({ threads: threads ?? [], loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load recent threads",
      });
    }
  },

  remove: (threadId) => {
    set((s) => ({ threads: s.threads.filter((t) => t.id !== threadId) }));
  },
}));
