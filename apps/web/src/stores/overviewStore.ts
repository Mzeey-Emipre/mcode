import { create } from "zustand";

interface OverviewState {
  /** Whether the chat pane should reserve the right side for the open Overview. */
  reserveSpace: boolean;
  /** Thread whose Overview should open once its chat surface mounts. */
  requestedThreadId: string | null;
  setReserveSpace: (reserveSpace: boolean) => void;
  /** Request that one thread's Overview open after navigation. */
  requestOpen: (threadId: string) => void;
  /** Clear a matching open request after the target Overview consumes it. */
  consumeOpenRequest: (threadId: string) => void;
}

/** Shares the Overview layout hint with the chat pane that owns the composer. */
export const useOverviewStore = create<OverviewState>((set) => ({
  reserveSpace: false,
  requestedThreadId: null,
  setReserveSpace: (reserveSpace) =>
    set((state) => (state.reserveSpace === reserveSpace ? state : { reserveSpace })),
  requestOpen: (requestedThreadId) => set({ requestedThreadId }),
  consumeOpenRequest: (threadId) =>
    set((state) =>
      state.requestedThreadId === threadId ? { requestedThreadId: null } : state,
    ),
}));
