import type { RecoveryIncident } from "@mcode/contracts";
import { create } from "zustand";

interface RecoveryIncidentState {
  readonly incident: RecoveryIncident | null;
  readonly dismissedIncidentIds: ReadonlySet<string>;
  readonly retriedExecutionIds: ReadonlySet<string>;
  setIncident: (incident: RecoveryIncident | null) => void;
  dismissIncident: (incidentId: string) => void;
  markEntriesRetried: (executionIds: readonly string[]) => void;
}

/** Holds restart recovery state for the lifetime of the browser app session. */
export const useRecoveryIncidentStore = create<RecoveryIncidentState>((set) => ({
  incident: null,
  dismissedIncidentIds: new Set<string>(),
  retriedExecutionIds: new Set<string>(),
  setIncident: (incident) => set((state) => ({
    incident: remainingIncidentEntries(incident, state.retriedExecutionIds),
  })),
  dismissIncident: (incidentId) => set((state) => ({
    dismissedIncidentIds: new Set(state.dismissedIncidentIds).add(incidentId),
  })),
  markEntriesRetried: (executionIds) => set((state) => {
    const retriedExecutionIds = new Set([...state.retriedExecutionIds, ...executionIds]);
    return {
      retriedExecutionIds,
      incident: remainingIncidentEntries(state.incident, retriedExecutionIds),
    };
  }),
}));

function remainingIncidentEntries(
  incident: RecoveryIncident | null,
  retriedExecutionIds: ReadonlySet<string>,
): RecoveryIncident | null {
  if (!incident) return null;
  const entries = incident.entries.filter((entry) => !retriedExecutionIds.has(entry.executionId));
  return entries.length > 0 ? { ...incident, entries } : null;
}

/** Selects the current incident unless this browser session dismissed it. */
export function useVisibleRecoveryIncident(): RecoveryIncident | null {
  return useRecoveryIncidentStore((state) =>
    state.incident && !state.dismissedIncidentIds.has(state.incident.id)
      ? state.incident
      : null,
  );
}

/** Selects whether the incident contains an unretried turn for one thread. */
export function hasRecoveryEntry(
  state: RecoveryIncidentState,
  workspaceId: string,
  threadId: string,
): boolean {
  return state.incident?.entries.some((entry) =>
    entry.workspaceId === workspaceId && entry.threadId === threadId,
  ) ?? false;
}
