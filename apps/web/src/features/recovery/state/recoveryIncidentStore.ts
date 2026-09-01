import type { RecoveryIncident } from "@mcode/contracts";
import { create } from "zustand";

interface RecoveryIncidentState {
  readonly incident: RecoveryIncident | null;
  readonly dismissedIncidentIds: ReadonlySet<string>;
  setIncident: (incident: RecoveryIncident | null) => void;
  dismissIncident: (incidentId: string) => void;
}

/** Holds restart recovery state for the lifetime of the browser app session. */
export const useRecoveryIncidentStore = create<RecoveryIncidentState>((set) => ({
  incident: null,
  dismissedIncidentIds: new Set<string>(),
  setIncident: (incident) => set({ incident }),
  dismissIncident: (incidentId) => set((state) => ({
    dismissedIncidentIds: new Set(state.dismissedIncidentIds).add(incidentId),
  })),
}));

/** Selects the current incident unless this browser session dismissed it. */
export function useVisibleRecoveryIncident(): RecoveryIncident | null {
  return useRecoveryIncidentStore((state) =>
    state.incident && !state.dismissedIncidentIds.has(state.incident.id)
      ? state.incident
      : null,
  );
}
