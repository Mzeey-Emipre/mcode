import { create } from "zustand";

/**
 * Reactive mirror of the live content-row width published by the composer
 * layout guard. Components that need to react to the chat area resizing (e.g.
 * the Overview deciding whether it can dock) subscribe here instead of racing a
 * window `resize` listener against the guard's ResizeObserver.
 */
interface LayoutState {
  /** Current content-row width in CSS pixels, or 0 before first measurement. */
  contentRowWidth: number;
  setContentRowWidth: (width: number) => void;
}

/** Store backing reactive content-row width subscriptions. */
export const useLayoutStore = create<LayoutState>((set) => ({
  contentRowWidth: 0,
  setContentRowWidth: (width) =>
    set((state) => (state.contentRowWidth === width ? state : { contentRowWidth: width })),
}));
