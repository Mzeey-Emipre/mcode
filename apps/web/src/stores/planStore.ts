import { create } from "zustand";
import type { PlanRecord } from "@mcode/contracts";

/** Zustand state shape for per-thread plan data. */
interface PlanState {
  /** All plan versions keyed by thread ID, ordered by version ASC. */
  plansByThread: Record<string, readonly PlanRecord[]>;

  /** Which version is currently viewed per thread (null = latest). */
  activeVersionByThread: Record<string, number | null>;

  /** Threads currently generating a new plan version. */
  generatingThreads: Set<string>;

  /** Session-local live plan preview keyed by thread ID. Hydration never writes this. */
  livePreviewByThread: Record<string, Pick<PlanRecord, "id" | "version" | "title">>;

  /** Session-local dismissed preview versions keyed by thread ID. */
  dismissedPreviewVersionsByThread: Record<string, readonly number[]>;

  /** Add or replace a plan in the thread's version list. */
  addPlan: (threadId: string, plan: PlanRecord) => void;

  /** Show a session-local preview for a live-generated plan version. */
  showLivePreview: (threadId: string, plan: PlanRecord) => void;

  /** Dismiss the current session-local preview for a specific plan version. */
  dismissLivePreview: (threadId: string, version: number) => void;

  /** Clear any visible session-local preview for a thread. */
  clearLivePreview: (threadId: string) => void;

  /** Set the actively viewed version for a thread. */
  setActiveVersion: (threadId: string, version: number | null) => void;

  /** Mark a thread as generating a plan (shows skeleton). */
  setGenerating: (threadId: string, generating: boolean) => void;

  /** Update a plan's status optimistically. */
  updatePlanStatus: (planId: string, status: PlanRecord["status"]) => void;

  /** Clear plan state for a thread. */
  clearPlans: (threadId: string) => void;
}

/** Zustand store for per-thread plan versions. */
export const usePlanStore = create<PlanState>((set) => ({
  plansByThread: {},
  activeVersionByThread: {},
  generatingThreads: new Set(),
  livePreviewByThread: {},
  dismissedPreviewVersionsByThread: {},

  addPlan: (threadId, plan) =>
    set((state) => {
      const existing = state.plansByThread[threadId] ?? [];
      const idx = existing.findIndex((p) => p.version === plan.version);
      const updated =
        idx >= 0
          ? existing.map((p, i) => (i === idx ? plan : p))
          : [...existing, plan].sort((a, b) => a.version - b.version);
      return {
        plansByThread: { ...state.plansByThread, [threadId]: updated },
        // Clear generating flag when a plan arrives
        generatingThreads: new Set(
          [...state.generatingThreads].filter((id) => id !== threadId),
        ),
      };
    }),

  showLivePreview: (threadId, plan) =>
    set((state) => {
      const dismissed = state.dismissedPreviewVersionsByThread[threadId] ?? [];
      if (dismissed.includes(plan.version)) return {};
      return {
        livePreviewByThread: {
          ...state.livePreviewByThread,
          [threadId]: { id: plan.id, version: plan.version, title: plan.title },
        },
      };
    }),

  dismissLivePreview: (threadId, version) =>
    set((state) => {
      const dismissed = state.dismissedPreviewVersionsByThread[threadId] ?? [];
      const nextDismissed = dismissed.includes(version) ? dismissed : [...dismissed, version];
      const nextPreview = { ...state.livePreviewByThread };
      if (nextPreview[threadId]?.version === version) delete nextPreview[threadId];
      return {
        livePreviewByThread: nextPreview,
        dismissedPreviewVersionsByThread: {
          ...state.dismissedPreviewVersionsByThread,
          [threadId]: nextDismissed,
        },
      };
    }),

  clearLivePreview: (threadId) =>
    set((state) => {
      if (!(threadId in state.livePreviewByThread)) return {};
      const next = { ...state.livePreviewByThread };
      delete next[threadId];
      return { livePreviewByThread: next };
    }),

  setActiveVersion: (threadId, version) =>
    set((state) => ({
      activeVersionByThread: {
        ...state.activeVersionByThread,
        [threadId]: version,
      },
    })),

  setGenerating: (threadId, generating) =>
    set((state) => {
      const next = new Set(state.generatingThreads);
      if (generating) next.add(threadId);
      else next.delete(threadId);
      return { generatingThreads: next };
    }),

  updatePlanStatus: (planId, status) =>
    set((state) => {
      const updated: Record<string, readonly PlanRecord[]> = {};
      for (const [tid, plans] of Object.entries(state.plansByThread)) {
        updated[tid] = plans.map((p) =>
          p.id === planId ? { ...p, status } : p,
        );
      }
      return { plansByThread: updated };
    }),

  clearPlans: (threadId) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitPlans, ...rest } = state.plansByThread;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitVersion, ...restVersions } = state.activeVersionByThread;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitPreview, ...restPreviews } = state.livePreviewByThread;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitDismissed, ...restDismissed } = state.dismissedPreviewVersionsByThread;
      return {
        plansByThread: rest,
        activeVersionByThread: restVersions,
        livePreviewByThread: restPreviews,
        dismissedPreviewVersionsByThread: restDismissed,
      };
    }),
}));
