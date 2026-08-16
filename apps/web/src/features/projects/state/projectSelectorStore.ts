import { create } from "zustand";
import { getTransport } from "@/transport";

/** Enrichment data for a workspace: branch, clean state, thread count. */
export interface WorkspaceEnrichmentData {
  id: string;
  branch: string | null;
  isGit: boolean;
  isClean: boolean;
  threadCount: number;
}

interface State {
  /** Keyed by workspace id. Populated lazily via enrich(). */
  enrichmentCache: Map<string, WorkspaceEnrichmentData>;
  /** Workspace ids whose enrichment RPC is currently in flight. */
  pending: Set<string>;
  /**
   * Fetch enrichment for the given workspace ids.
   * Already-cached and in-flight ids are skipped to avoid redundant RPCs.
   * @param ids - Workspace ids to enrich.
   * @param call - Optional transport override for testing. Defaults to `getTransport().enrichWorkspaces`.
   */
  enrich: (ids: string[], call?: EnrichFn) => Promise<void>;
}

/** Injectable call function type — mirrors `McodeTransport.enrichWorkspaces`. */
type EnrichFn = (ids: string[]) => Promise<{ items: WorkspaceEnrichmentData[] }>;

/**
 * Perform batched enrichment of workspace ids.
 *
 * Defined outside the store initializer so the function reference is stable
 * and survives full-state replacements in tests (setState with replace=true).
 * Already-cached and in-flight ids are skipped to prevent duplicate RPCs.
 */
async function enrichImpl(
  ids: string[],
  call?: EnrichFn,
): Promise<void> {
  if (ids.length === 0) return;
  const store = useProjectSelectorStore;
  const { enrichmentCache, pending } = store.getState();
  const todo = ids.filter((id) => !enrichmentCache.has(id) && !pending.has(id));
  if (todo.length === 0) return;

  // Mark as in-flight before the async boundary so concurrent calls see them immediately.
  const nextPending = new Set(store.getState().pending);
  todo.forEach((id) => nextPending.add(id));
  store.setState({ pending: nextPending });

  try {
    const enrichFn = call ?? ((ids: string[]) => getTransport().enrichWorkspaces(ids));
    const { items } = await enrichFn(todo);
    const next = new Map(store.getState().enrichmentCache);
    for (const item of items) next.set(String(item.id), item);
    store.setState({ enrichmentCache: next });
  } finally {
    const cleaned = new Set(store.getState().pending);
    todo.forEach((id) => cleaned.delete(id));
    store.setState({ pending: cleaned });
  }
}

/**
 * Single source of truth for workspace enrichment data (branch, clean state, thread count).
 * The palette ProjectsView subscribes here.
 * Enrichment is fetched lazily and cached so repeated renders don't trigger duplicate RPCs.
 */
export const useProjectSelectorStore = create<State>(() => ({
  enrichmentCache: new Map(),
  pending: new Set(),
  enrich: enrichImpl,
}));

// Patch the store's setState so full-state replacements (replace=true) always
// restore the stable `enrich` action. This lets tests reset data-only state
// without losing the action reference.
//
// Zustand's setState has overloaded signatures (`replace: true` requires the
// full state, `false` accepts a partial). Borrow the original parameter tuple
// so the wrapper preserves both arms without resorting to `any`.
const originalSetState = useProjectSelectorStore.setState.bind(useProjectSelectorStore);
type SetStateParams = Parameters<typeof originalSetState>;
useProjectSelectorStore.setState = (
  partial: State | Partial<State> | ((state: State) => State | Partial<State>),
  replace?: boolean,
) => {
  originalSetState(...([partial, replace] as SetStateParams));
  // If replace wiped the enrich function, restore it.
  if (!useProjectSelectorStore.getState().enrich) {
    originalSetState({ enrich: enrichImpl } as Partial<State>, false);
  }
};
