/**
 * Provider-scoped cache for slash-command skills.
 *
 * Each cwd and provider pair owns independent data, loading state, errors, and
 * in-flight work. This lets Composer and Preview request different scopes at
 * the same time without replacing each other's cache entry.
 */

import { create } from "zustand";
import { getTransport, type SkillInfo } from "@/transport";

/** Cached skill state for one cwd and provider pair. */
export interface SkillsCacheEntry {
  readonly skills: SkillInfo[] | null;
  readonly isLoading: boolean;
  readonly isStale: boolean;
  readonly error: Error | null;
  readonly inflight: Promise<SkillInfo[]> | null;
  readonly loadEpoch: number;
  readonly lastFetchedAt: number;
}

/** Stable empty entry used by selectors before a scope has loaded. */
export const EMPTY_SKILLS_CACHE_ENTRY: SkillsCacheEntry = Object.freeze({
  skills: null,
  isLoading: false,
  isStale: true,
  error: null,
  inflight: null,
  loadEpoch: 0,
  lastFetchedAt: 0,
});

/** Builds a collision-safe cache key for one cwd and provider pair. */
export function skillsCacheKey(cwd?: string, providerId?: string): string {
  return JSON.stringify([cwd ?? null, providerId ?? null]);
}

/** State and actions for the skills Zustand store. */
interface SkillsState {
  /** Entries keyed by {@link skillsCacheKey}. */
  entries: Readonly<Record<string, SkillsCacheEntry>>;

  // Compatibility snapshot of the most recent load. New consumers should read
  // entries so simultaneous scopes never share render state.
  skills: SkillInfo[] | null;
  cwd: string | undefined;
  providerId: string | undefined;
  isLoading: boolean;
  error: Error | null;
  inflight: Promise<SkillInfo[]> | null;
  inflightCwd: string | undefined;
  inflightProviderId: string | undefined;
  loadEpoch: number;

  /** Loads one cwd and provider entry with per-key cache and single-flight behavior. */
  load(cwd?: string, providerId?: string, force?: boolean): Promise<SkillInfo[]>;
  /** Marks every entry stale while retaining visible rows during refresh. */
  invalidate(): void;
  /** Clears all cache and in-flight state. */
  reset(): void;
}

/** Skills are considered fresh for five minutes after a successful fetch. */
const CACHE_TTL_MS = 5 * 60 * 1000;

const LEGACY_CLEARED_STATE = {
  skills: null,
  cwd: undefined,
  providerId: undefined,
  isLoading: false,
  error: null,
  inflight: null,
  inflightCwd: undefined,
  inflightProviderId: undefined,
} as const satisfies Partial<SkillsState>;

function replaceEntry(
  entries: Readonly<Record<string, SkillsCacheEntry>>,
  key: string,
  entry: SkillsCacheEntry,
): Readonly<Record<string, SkillsCacheEntry>> {
  return { ...entries, [key]: entry };
}

/** Module-scoped Zustand store for provider-scoped skill caching. */
export const useSkillsStore = create<SkillsState>((set, get) => ({
  entries: {},
  ...LEGACY_CLEARED_STATE,
  loadEpoch: 0,

  load(cwd, providerId, force = false): Promise<SkillInfo[]> {
    const key = skillsCacheKey(cwd, providerId);
    const state = get();
    const existing = state.entries[key] ?? EMPTY_SKILLS_CACHE_ENTRY;

    if (
      !force &&
      !existing.isStale &&
      existing.skills !== null &&
      Date.now() - existing.lastFetchedAt < CACHE_TTL_MS
    ) {
      return Promise.resolve(existing.skills);
    }

    if (existing.inflight) return existing.inflight;

    let resolveInflight!: (skills: SkillInfo[]) => void;
    let rejectInflight!: (error: unknown) => void;
    const promise = new Promise<SkillInfo[]>((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    const myEpoch = existing.loadEpoch + 1;
    const loadingEntry: SkillsCacheEntry = {
      ...existing,
      isLoading: true,
      isStale: existing.isStale,
      error: null,
      inflight: promise,
      loadEpoch: myEpoch,
    };
    set({
      entries: replaceEntry(state.entries, key, loadingEntry),
      isLoading: true,
      error: null,
      inflight: promise,
      inflightCwd: cwd,
      inflightProviderId: providerId,
      loadEpoch: state.loadEpoch + 1,
    });

    void (async () => {
      const transport = getTransport();
      const attempt = () => transport.listSkills(cwd, providerId);
      try {
        let skills: SkillInfo[];
        try {
          skills = await attempt();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("disconnected") || message.includes("not initialized")) {
            const reconnectable = transport as unknown as {
              waitForConnection?: (timeoutMs: number) => Promise<void>;
            };
            await reconnectable.waitForConnection?.(5_000).catch(() => undefined);
            skills = await attempt();
          } else {
            throw error;
          }
        }

        const current = get();
        const currentEntry = current.entries[key];
        if (currentEntry?.loadEpoch === myEpoch) {
          const readyEntry: SkillsCacheEntry = {
            skills,
            isLoading: false,
            isStale: false,
            error: null,
            inflight: null,
            loadEpoch: myEpoch,
            lastFetchedAt: Date.now(),
          };
          set({
            entries: replaceEntry(current.entries, key, readyEntry),
            skills,
            cwd,
            providerId,
            isLoading: false,
            error: null,
            inflight: null,
            inflightCwd: undefined,
            inflightProviderId: undefined,
          });
        }
        resolveInflight(skills);
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        console.warn("[skillsStore] load failed after retry", error);
        const current = get();
        const currentEntry = current.entries[key];
        if (currentEntry?.loadEpoch === myEpoch) {
          const failedEntry: SkillsCacheEntry = {
            ...currentEntry,
            isLoading: false,
            error,
            inflight: null,
          };
          set({
            entries: replaceEntry(current.entries, key, failedEntry),
            skills: failedEntry.skills,
            cwd,
            providerId,
            isLoading: false,
            error,
            inflight: null,
            inflightCwd: undefined,
            inflightProviderId: undefined,
          });
        }
        rejectInflight(error);
      }
    })();

    return promise;
  },

  invalidate() {
    const state = get();
    const entries = Object.fromEntries(
      Object.entries(state.entries).map(([key, entry]) => [
        key,
        {
          ...entry,
          isLoading: false,
          isStale: true,
          error: null,
          inflight: null,
          loadEpoch: entry.loadEpoch + 1,
        } satisfies SkillsCacheEntry,
      ]),
    );
    set({
      entries,
      ...LEGACY_CLEARED_STATE,
      loadEpoch: state.loadEpoch + 1,
    });
  },

  reset() {
    const state = get();
    set({
      entries: {},
      ...LEGACY_CLEARED_STATE,
      loadEpoch: state.loadEpoch + 1,
    });
  },
}));
