import { create } from "zustand";
import type { SettingsSection } from "@/components/settings/settings-nav";

/** Tabs whose selection is part of an Mcode pull request location. */
export type PullRequestHistoryTab = "summary" | "timeline" | "code";

/** A session-only location in the Mcode application shell. */
export type NavigationLocation =
  | { readonly kind: "newThread"; readonly workspaceId: string | null }
  | {
      readonly kind: "thread";
      readonly workspaceId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "settings";
      readonly workspaceId: string | null;
      readonly section: SettingsSection;
    }
  | { readonly kind: "pullRequests"; readonly workspaceId: string | null }
  | {
      readonly kind: "pullRequestDetail";
      readonly workspaceId: string | null;
      readonly identityKey: string;
      readonly tab: PullRequestHistoryTab;
    };

/** Maximum number of locations retained for one window session. */
export const NAVIGATION_HISTORY_LIMIT = 50;

/** Predicate used to skip locations whose project, thread, or pull request no longer exists. */
export type NavigationLocationValidator = (
  location: NavigationLocation,
) => boolean;

/** Public state and actions for Mcode's session-only navigation history. */
export interface NavigationHistoryState {
  readonly entries: readonly NavigationLocation[];
  readonly index: number;
  readonly replayTarget: NavigationLocation | null;
  record: (location: NavigationLocation) => void;
  back: (isValid: NavigationLocationValidator) => NavigationLocation | null;
  forward: (isValid: NavigationLocationValidator) => NavigationLocation | null;
  canGoBack: (isValid: NavigationLocationValidator) => boolean;
  canGoForward: (isValid: NavigationLocationValidator) => boolean;
  reset: () => void;
}

function locationKey(location: NavigationLocation): string {
  switch (location.kind) {
    case "newThread":
      return `new:${location.workspaceId ?? ""}`;
    case "thread":
      return `thread:${location.workspaceId}:${location.threadId}`;
    case "settings":
      return `settings:${location.workspaceId ?? ""}:${location.section}`;
    case "pullRequests":
      return `pullRequests:${location.workspaceId ?? ""}`;
    case "pullRequestDetail":
      return `pullRequest:${location.workspaceId ?? ""}:${location.identityKey}:${location.tab}`;
  }
}

function findValidIndex(
  entries: readonly NavigationLocation[],
  start: number,
  step: -1 | 1,
  isValid: NavigationLocationValidator,
): number {
  for (let index = start; index >= 0 && index < entries.length; index += step) {
    const location = entries[index];
    if (location && isValid(location)) return index;
  }
  return -1;
}

/** In-memory history owned by the current renderer window. */
export const useNavigationHistoryStore = create<NavigationHistoryState>(
  (set, get) => ({
    entries: [],
    index: -1,
    replayTarget: null,
    record: (location) => {
      const state = get();
      if (state.replayTarget) {
        if (locationKey(state.replayTarget) === locationKey(location)) {
          set({ replayTarget: null });
        }
        return;
      }
      const current = state.entries[state.index];
      if (current && locationKey(current) === locationKey(location)) return;
      const entries = [
        ...state.entries.slice(0, state.index + 1),
        location,
      ].slice(-NAVIGATION_HISTORY_LIMIT);
      set({ entries, index: entries.length - 1 });
    },
    back: (isValid) => {
      const state = get();
      const index = findValidIndex(state.entries, state.index - 1, -1, isValid);
      if (index < 0) return null;
      const replayTarget = state.entries[index] ?? null;
      set({ index, replayTarget });
      return replayTarget;
    },
    forward: (isValid) => {
      const state = get();
      const index = findValidIndex(state.entries, state.index + 1, 1, isValid);
      if (index < 0) return null;
      const replayTarget = state.entries[index] ?? null;
      set({ index, replayTarget });
      return replayTarget;
    },
    canGoBack: (isValid) => {
      const state = get();
      return findValidIndex(state.entries, state.index - 1, -1, isValid) >= 0;
    },
    canGoForward: (isValid) => {
      const state = get();
      return findValidIndex(state.entries, state.index + 1, 1, isValid) >= 0;
    },
    reset: () => set({ entries: [], index: -1, replayTarget: null }),
  }),
);
