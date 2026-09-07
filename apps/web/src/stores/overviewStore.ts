import { create } from "zustand";

interface OverviewState {
  /** Thread whose chat pane should reserve the right side for its open Overview. */
  reserveThreadId: string | null;
  /** Thread whose Overview should open once its chat surface mounts. */
  requestedThreadId: string | null;
  setReserveThread: (threadId: string | null) => void;
  clearReserveThread: (threadId: string) => void;
  /** Request that one thread's Overview open after navigation. */
  requestOpen: (threadId: string) => void;
  /** Clear a matching open request after the target Overview consumes it. */
  consumeOpenRequest: (threadId: string) => void;
}

/** Shares the Overview layout hint with the chat pane that owns the composer. */
export const useOverviewStore = create<OverviewState>((set) => ({
  reserveThreadId: null,
  requestedThreadId: null,
  setReserveThread: (reserveThreadId) =>
    set((state) => (state.reserveThreadId === reserveThreadId ? state : { reserveThreadId })),
  clearReserveThread: (threadId) =>
    set((state) => (state.reserveThreadId === threadId ? { reserveThreadId: null } : state)),
  requestOpen: (requestedThreadId) => set({ requestedThreadId }),
  consumeOpenRequest: (threadId) =>
    set((state) =>
      state.requestedThreadId === threadId ? { requestedThreadId: null } : state,
    ),
}));
