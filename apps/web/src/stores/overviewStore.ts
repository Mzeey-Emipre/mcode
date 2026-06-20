import { create } from "zustand";

/**
 * Shares whether the chat area should reserve room on the right for the open
 * Overview. True only when the Overview is open AND there is room to sit beside
 * the chat; on small viewports it stays false so the Overview floats over the
 * content instead of squeezing it. The Overview itself is always a transient
 * popover; this is only a layout hint, not a dock.
 */
interface OverviewState {
  reserveSpace: boolean;
  setReserveSpace: (reserveSpace: boolean) => void;
}

/** Store backing the chat area's "make room for the open Overview" padding. */
export const useOverviewStore = create<OverviewState>((set) => ({
  reserveSpace: false,
  setReserveSpace: (reserveSpace) =>
    set((state) => (state.reserveSpace === reserveSpace ? state : { reserveSpace })),
}));
