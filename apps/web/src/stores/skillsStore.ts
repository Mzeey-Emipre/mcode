/**
 * Cache for slash-command skills.
 *
 * Module-scoped so the cache survives Composer remounts. Single-flights
 * concurrent `load()` calls. Reacts to `skills.changed` push events
 * (wired in `ws-events.ts`) by invalidating.
 */

import { create } from "zustand";
import { getTransport, type SkillInfo } from "@/transport";

/** State and actions for the skills Zustand store. */
interface SkillsState {
  /** Fetched skill list, or null if not yet loaded or invalidated. */
  skills: SkillInfo[] | null;
  /** The cwd associated with the last load attempt (success OR failure). */
  cwd: string | undefined;
  /** The providerId associated with the last load attempt. */
  providerId: string | undefined;
  /** Whether a fetch is currently in-flight. */
  isLoading: boolean;
  /** Error from the last failed fetch, if any. */
  error: Error | null;
  /** The in-flight promise. Single-flight only deduplicates same-cwd+providerId callers. */
  inflight: Promise<SkillInfo[]> | null;
  /** The cwd of the in-flight promise; used to scope single-flight by cwd. */
  inflightCwd: string | undefined;
  /** The providerId of the in-flight promise; scopes single-flight to cwd + providerId. */
  inflightProviderId: string | undefined;
  /**
   * Monotonic counter bumped by each new load() call AND by invalidate()/
   * reset(). The async closure captures the value it incremented to and
   * checks `get().loadEpoch === myEpoch` before any set(); a mismatch means
   * a newer load or an invalidate raced ahead, so the stale resolution is
   * dropped instead of rehydrating the store.
   */
  loadEpoch: number;

  /**
   * Load skills for the given cwd and providerId.
   *
   * Returns cached data if still fresh (within TTL) and both cwd and
   * providerId match. Concurrent calls with the same (cwd, providerId)
   * while a request is in-flight all receive the same promise. Different
   * providerId values get separate in-flight promises.
   */
  load(cwd?: string, providerId?: string, force?: boolean): Promise<SkillInfo[]>;

  /**
   * Invalidate the cached skills so the next `load()` re-fetches from
   * the server regardless of TTL.
   */
  invalidate(): void;

  /**
   * Reset all store state to initial values, including in-flight tracking.
   * Used in tests for cleanup between cases.
   */
  reset(): void;
}

/** Skills are considered fresh for 5 minutes after the last successful fetch. */
const CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level timestamp so TTL survives store resets in tests but still
// gets cleared when `reset()` or `invalidate()` is explicitly called.
let lastFetchedAt = 0;

/**
 * The store's "cleared" field values — every data/in-flight field reset to its
 * empty state. `loadEpoch` (bumped, not reset) and `lastFetchedAt` (a module
 * var) are handled separately.
 *
 * Both the initial state and the `invalidate()`/`reset()` actions spread this
 * single object, so a newly added state field can never be cleared in one path
 * but forgotten in another. That divergence is exactly what caused the
 * stuck-popup bug: `invalidate()` once omitted `isLoading: false` while the
 * initial state and `reset()` had it, leaving the flag stuck `true` after a
 * push-during-load and dead-locking the consumer's eager-prefetch effect.
 */
const CLEARED_STATE = {
  skills: null,
  cwd: undefined,
  providerId: undefined,
  isLoading: false,
  error: null,
  inflight: null,
  inflightCwd: undefined,
  inflightProviderId: undefined,
} as const satisfies Partial<SkillsState>;

/** Module-scoped Zustand store for skill caching with single-flight loading. */
export const useSkillsStore = create<SkillsState>((set, get) => ({
  ...CLEARED_STATE,
  loadEpoch: 0,

  // Non-async so the return value IS the cached/in-flight promise directly,
  // enabling identity equality (p1 === p2) for single-flight callers.
  load(cwd, providerId, force = false): Promise<SkillInfo[]> {
    const state = get();

    // Return cache if fresh, same cwd, AND same providerId
    if (
      !force &&
      state.skills &&
      state.cwd === cwd &&
      state.providerId === providerId &&
      Date.now() - lastFetchedAt < CACHE_TTL_MS
    ) {
      return Promise.resolve(state.skills);
    }

    // Single-flight scoped to cwd + providerId. A different-providerId request
    // must not piggyback on an in-flight load or it would receive the wrong data.
    if (
      state.inflight &&
      state.inflightCwd === cwd &&
      state.inflightProviderId === providerId
    ) {
      return state.inflight;
    }

    // Create and register the in-flight promise atomically so a second
    // synchronous caller (same cwd + providerId) sees it immediately via get().inflight.
    let resolveInflight!: (skills: SkillInfo[]) => void;
    let rejectInflight!: (err: unknown) => void;
    const promise = new Promise<SkillInfo[]>((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    });

    const myEpoch = state.loadEpoch + 1;
    set({
      isLoading: true,
      error: null,
      inflight: promise,
      inflightCwd: cwd,
      inflightProviderId: providerId,
      loadEpoch: myEpoch,
    });

    // Kick off the actual fetch outside the synchronous set() block.
    (async () => {
      const transport = getTransport();
      const attempt = () => transport.listSkills(cwd, providerId);
      try {
        let skills: SkillInfo[];
        try {
          skills = await attempt();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Retry once if the WebSocket was momentarily disconnected. The
          // transport may expose waitForConnection; use it if available so
          // the retry doesn't fire before the socket is back up.
          if (message.includes("disconnected") || message.includes("not initialized")) {
            const t = transport as unknown as { waitForConnection?: (ms: number) => Promise<void> };
            if (t.waitForConnection) {
              await t.waitForConnection(5000).catch(() => undefined);
            }
            skills = await attempt();
          } else {
            throw err;
          }
        }
        // Fence: skip set() if invalidate(), reset(), or a newer load()
        // bumped the epoch while we were awaiting. Still resolve the promise
        // so callers don't hang — they'll get the data they asked for, just
        // without polluting the now-fresher store state.
        if (get().loadEpoch === myEpoch) {
          lastFetchedAt = Date.now();
          set({ skills, cwd, providerId, isLoading: false, inflight: null, inflightCwd: undefined, inflightProviderId: undefined, error: null });
        }
        resolveInflight(skills);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn("[skillsStore] load failed after retry", error);
        // Track the attempted cwd even on failure so the consumer hook can
        // detect a cwd change vs. a same-cwd retry and handle each correctly.
        if (get().loadEpoch === myEpoch) {
          set({ cwd, providerId, isLoading: false, inflight: null, inflightCwd: undefined, inflightProviderId: undefined, error });
        }
        rejectInflight(error);
      }
    })();

    return promise;
  },

  invalidate() {
    // Bumping loadEpoch fences any in-flight load() so its eventual set() is
    // dropped instead of rehydrating the store with pre-invalidation data.
    // Spreading CLEARED_STATE guarantees isLoading is reset to false even when
    // the fenced load skips its own reset — see CLEARED_STATE for why that
    // matters (the stuck-popup bug).
    set({ ...CLEARED_STATE, loadEpoch: get().loadEpoch + 1 });
    lastFetchedAt = 0;
  },

  reset() {
    set({ ...CLEARED_STATE, loadEpoch: get().loadEpoch + 1 });
    lastFetchedAt = 0;
  },
}));
