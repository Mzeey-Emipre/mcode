import { create } from "zustand";

interface OverviewState {
  /** Whether the chat pane should reserve the right side for the open Overview. */
  reserveSpace: boolean;
  setReserveSpace: (reserveSpace: boolean) => void;
}

/** Shares the Overview layout hint with the chat pane that owns the composer. */
export const useOverviewStore = create<OverviewState>((set) => ({
  reserveSpace: false,
  setReserveSpace: (reserveSpace) =>
    set((state) => (state.reserveSpace === reserveSpace ? state : { reserveSpace })),
}));
