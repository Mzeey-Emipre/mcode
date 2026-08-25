import { create } from "zustand";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

interface ProjectActionHydration {
  readonly generation: number;
  readonly inFlight: number;
}

/** Retained Project Action runs indexed by their Thread and stable Action slot. */
export interface ProjectActionState {
  readonly runsByThread: Readonly<Record<string, Readonly<Record<string, WorkspaceEnvironmentActionRun>>>>;
  /** Monotonic workspace revisions that make mounted Action menus reread saved configuration. */
  readonly configurationEpochByWorkspace: Readonly<Record<string, number>>;
  /** Renderer-local update epochs used to fence stale list hydration by Thread and Action slot. */
  readonly updateEpochByThread: Readonly<Record<string, number>>;
  /** Most recent renderer-local update epoch for each retained Action slot. */
  readonly updateEpochByThreadAction: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** In-flight list hydration generations that reject responses invalidated by Thread deletion. */
  readonly hydrationByThread: Readonly<Record<string, ProjectActionHydration>>;
  /** Replaces one Thread's retained Action run snapshots from an authoritative list response. */
  replaceRuns: (threadId: string, runs: readonly WorkspaceEnvironmentActionRun[]) => void;
  /** Replaces pre-request slots from a list response while retaining post-request pushes for a live Thread. */
  hydrateRuns: (
    threadId: string,
    runs: readonly WorkspaceEnvironmentActionRun[],
    requestEpoch: number,
    hydrationGeneration: number,
  ) => void;
  /** Starts one list hydration and returns the generation that owns its response. */
  beginHydration: (threadId: string) => number;
  /** Releases one settled list hydration and removes its lifecycle record when no requests remain. */
  endHydration: (threadId: string) => void;
  /** Applies a pushed or RPC-returned run when it is not delayed behind the current slot run. */
  applyRun: (run: WorkspaceEnvironmentActionRun) => void;
  /** Removes retained Action runs when their owning Thread is deleted. */
  clearThread: (threadId: string) => void;
  /** Invalidates saved Action configuration after the Project settings editor persists it. */
  invalidateWorkspaceConfiguration: (workspaceId: string) => void;
}

/** Returns whether an incoming run can replace the current retained slot state. */
export function shouldApplyProjectActionRun(
  current: WorkspaceEnvironmentActionRun | undefined,
  incoming: WorkspaceEnvironmentActionRun,
): boolean {
  if (!current) return true;
  if (current.runId !== incoming.runId) {
    const createdAtComparison = incoming.createdAt.localeCompare(current.createdAt);
    return createdAtComparison > 0 || (
      createdAtComparison === 0 && incoming.runId.localeCompare(current.runId) > 0
    );
  }
  if (current.status !== "running" && incoming.status === "running") return false;
  return incoming.revision > current.revision;
}

/** Global renderer state for retained Project Action output and lifecycle pushes. */
export const useProjectActionStore = create<ProjectActionState>((set) => ({
  runsByThread: {},
  configurationEpochByWorkspace: {},
  updateEpochByThread: {},
  updateEpochByThreadAction: {},
  hydrationByThread: {},
  replaceRuns: (threadId, runs) =>
    set((state) => {
      // List responses are the server-authoritative slot snapshot. Keeping an
      // omitted local row would resurrect a result the server has pruned.
      const nextByAction: Record<string, WorkspaceEnvironmentActionRun> = {};
      for (const run of runs) {
        nextByAction[run.actionId] = run;
      }
      return {
        runsByThread: {
          ...state.runsByThread,
          [threadId]: nextByAction,
        },
      };
    }),
  hydrateRuns: (threadId, runs, requestEpoch, hydrationGeneration) =>
    set((state) => {
      if (state.hydrationByThread[threadId]?.generation !== hydrationGeneration) return state;
      const currentByAction = state.runsByThread[threadId] ?? {};
      const currentEpochByAction = state.updateEpochByThreadAction[threadId] ?? {};
      const nextByAction = Object.fromEntries(runs.map((run) => [run.actionId, run]));
      const nextEpochByAction: Record<string, number> = {};
      for (const actionId of Object.keys(nextByAction)) {
        nextEpochByAction[actionId] = currentEpochByAction[actionId] ?? 0;
      }
      for (const [actionId, current] of Object.entries(currentByAction)) {
        const updateEpoch = currentEpochByAction[actionId] ?? 0;
        if (updateEpoch <= requestEpoch) continue;
        nextByAction[actionId] = current;
        nextEpochByAction[actionId] = updateEpoch;
      }
      return {
        runsByThread: {
          ...state.runsByThread,
          [threadId]: nextByAction,
        },
        updateEpochByThreadAction: {
          ...state.updateEpochByThreadAction,
          [threadId]: nextEpochByAction,
        },
      };
    }),
  beginHydration: (threadId) => {
    let generation = 0;
    set((state) => {
      const current = state.hydrationByThread[threadId];
      generation = current?.generation ?? 0;
      return {
        hydrationByThread: {
          ...state.hydrationByThread,
          [threadId]: { generation, inFlight: (current?.inFlight ?? 0) + 1 },
        },
      };
    });
    return generation;
  },
  endHydration: (threadId) =>
    set((state) => {
      const current = state.hydrationByThread[threadId];
      if (!current) return state;
      const hydrationByThread = { ...state.hydrationByThread };
      if (current.inFlight === 1) delete hydrationByThread[threadId];
      else hydrationByThread[threadId] = { ...current, inFlight: current.inFlight - 1 };
      return { hydrationByThread };
    }),
  applyRun: (incoming) =>
    set((state) => {
      const currentByAction = state.runsByThread[incoming.threadId] ?? {};
      const current = currentByAction[incoming.actionId];
      if (!shouldApplyProjectActionRun(current, incoming)) return state;
      const nextEpoch = (state.updateEpochByThread[incoming.threadId] ?? 0) + 1;
      return {
        runsByThread: {
          ...state.runsByThread,
          [incoming.threadId]: { ...currentByAction, [incoming.actionId]: incoming },
        },
        updateEpochByThread: {
          ...state.updateEpochByThread,
          [incoming.threadId]: nextEpoch,
        },
        updateEpochByThreadAction: {
          ...state.updateEpochByThreadAction,
          [incoming.threadId]: {
            ...state.updateEpochByThreadAction[incoming.threadId],
            [incoming.actionId]: nextEpoch,
          },
        },
      };
    }),
  clearThread: (threadId) =>
    set((state) => {
      const runsByThread = { ...state.runsByThread };
      delete runsByThread[threadId];
      const updateEpochByThreadAction = { ...state.updateEpochByThreadAction };
      delete updateEpochByThreadAction[threadId];
      const updateEpochByThread = { ...state.updateEpochByThread };
      delete updateEpochByThread[threadId];
      const currentHydration = state.hydrationByThread[threadId];
      return {
        runsByThread,
        updateEpochByThread,
        updateEpochByThreadAction,
        hydrationByThread: currentHydration
          ? {
              ...state.hydrationByThread,
              [threadId]: { ...currentHydration, generation: currentHydration.generation + 1 },
            }
          : state.hydrationByThread,
      };
    }),
  invalidateWorkspaceConfiguration: (workspaceId) =>
    set((state) => ({
      configurationEpochByWorkspace: {
        ...state.configurationEpochByWorkspace,
        [workspaceId]: (state.configurationEpochByWorkspace[workspaceId] ?? 0) + 1,
      },
    })),
}));
