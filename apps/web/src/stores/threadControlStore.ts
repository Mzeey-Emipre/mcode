import { create } from "zustand";
import type {
  ThreadControlIdentity,
  ThreadControlProjection,
} from "@mcode/contracts";
import { getTransport } from "@/transport";

/** Maximum coordination projections retained across thread switches. */
const MAX_PROJECTIONS = 128;
let nextRequestEpoch = 0;

/** Stable cache key for one Project/Thread identity. */
export function threadControlKey(identity: ThreadControlIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.threadId]);
}

interface ProjectionEntry {
  projection: ThreadControlProjection | null;
  loading: boolean;
  error: string | null;
  epoch: number;
  refreshQueued?: boolean;
}

interface ThreadControlState {
  entries: Record<string, ProjectionEntry>;
  /** Load one canonical projection, dropping stale responses by epoch. */
  load: (identity: ThreadControlIdentity, options?: { force?: boolean }) => Promise<void>;
  /** Rehydrate every retained projection after a WebSocket reconnect. */
  rehydrate: () => Promise<void>;
  /** Refresh all retained projections for one thread id. */
  refreshByThreadId: (threadId: string, workspaceId?: string) => Promise<void>;
  /** Drop one projection when its panel closes or the thread is deleted. */
  clear: (identity: ThreadControlIdentity) => void;
}

function boundedEntries(entries: Record<string, ProjectionEntry>, key: string): Record<string, ProjectionEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_PROJECTIONS) return entries;
  const next = { ...entries };
  for (const candidate of keys.slice(0, keys.length - MAX_PROJECTIONS)) {
    if (candidate !== key) delete next[candidate];
  }
  return next;
}

/** Shared renderer authority for coordination projections. */
export const useThreadControlStore = create<ThreadControlState>((set, get) => ({
  entries: {},
  load: async (identity, options) => {
    const key = threadControlKey(identity);
    const current = get().entries[key];
    if (current?.loading) {
      if (options?.force) {
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...current, refreshQueued: true },
          },
        }));
      }
      return;
    }
    if (current?.projection && !options?.force) return;
    const epoch = ++nextRequestEpoch;
    set((state) => ({
      entries: boundedEntries({
        ...state.entries,
        [key]: { projection: current?.projection ?? null, loading: true, error: null, epoch, refreshQueued: false },
      }, key),
    }));
    const runQueuedRefresh = (): void => {
      const latest = get().entries[key];
      if (!latest?.refreshQueued) return;
      set((state) => ({
        entries: {
          ...state.entries,
          [key]: { ...latest, refreshQueued: false },
        },
      }));
      void get().load(identity, { force: true });
    };
    try {
      const result = await getTransport().readThreadControl(identity);
      const latest = get().entries[key];
      if (!latest || latest.epoch !== epoch) return;
      if (result.status === "found" && threadControlKey(result.projection.identity) === key) {
        set((state) => ({ entries: { ...state.entries, [key]: { projection: result.projection, loading: false, error: null, epoch, refreshQueued: latest.refreshQueued } } }));
      } else if (result.status === "rejected") {
        set((state) => ({ entries: { ...state.entries, [key]: { projection: null, loading: false, error: result.error.message, epoch, refreshQueued: latest.refreshQueued } } }));
      }
      runQueuedRefresh();
    } catch (error) {
      const latest = get().entries[key];
      if (!latest || latest.epoch !== epoch) return;
      set((state) => ({ entries: { ...state.entries, [key]: { ...latest, loading: false, error: error instanceof Error ? error.message : String(error) } } }));
      runQueuedRefresh();
    }
  },
  rehydrate: async () => {
    const identities = Object.keys(get().entries).map((key) => {
      try {
        const [workspaceId, threadId] = JSON.parse(key) as unknown[];
        return typeof workspaceId === "string" && typeof threadId === "string"
          ? { workspaceId, threadId }
          : null;
      } catch {
        return null;
      }
    }).filter((identity): identity is ThreadControlIdentity => identity !== null);
    await Promise.allSettled(identities.map((identity) => get().load(identity, { force: true })));
  },
  refreshByThreadId: async (threadId, requestedWorkspaceId) => {
    const identities = Object.keys(get().entries).map((key) => {
      try {
        const [cachedWorkspaceId, cachedThreadId] = JSON.parse(key) as unknown[];
        return typeof cachedWorkspaceId === "string" && cachedThreadId === threadId
          && (requestedWorkspaceId === undefined || cachedWorkspaceId === requestedWorkspaceId)
          ? { workspaceId: cachedWorkspaceId, threadId }
          : null;
      } catch {
        return null;
      }
    }).filter((identity): identity is ThreadControlIdentity => identity !== null);
    await Promise.allSettled(identities.map((identity) => get().load(identity, { force: true })));
  },
  clear: (identity) => set((state) => {
    const next = { ...state.entries };
    delete next[threadControlKey(identity)];
    return { entries: next };
  }),
}));

/** Read one projection entry without subscribing a component. */
export function getThreadControlEntry(identity: ThreadControlIdentity): ProjectionEntry | undefined {
  return useThreadControlStore.getState().entries[threadControlKey(identity)];
}

/** Test helper for deterministic store cleanup. */
export function resetThreadControlStoreForTests(): void {
  useThreadControlStore.setState({ entries: {} });
}
