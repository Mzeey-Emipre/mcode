import { create } from "zustand";

interface PreviewDesignModeStore {
  /** Map of threadId -> whether design mode is currently active for that thread. */
  readonly modes: Record<string, boolean>;
  /** Returns the current active flag for a thread, defaulting to false. */
  isActive: (threadId: string) => boolean;
  /** Flip active/inactive for the thread. */
  toggle: (threadId: string) => void;
  /** Explicitly set the active flag (used by the exit pill and by escape handlers). */
  setActive: (threadId: string, active: boolean) => void;
}

/**
 * Per-thread persistence for the preview Design mode flag. When active, the
 * toolbar's Design button reads as pressed, the right-side Exit pill appears,
 * and PreviewPanel auto-arms an element-pick session whenever no capture is
 * busy. The mode is the single state behind a "next click on the page
 * captures the element under the cursor, repeat" interaction; it stays on
 * across successful captures and Esc-cancels until the user toggles it off
 * via the toolbar button or pill.
 *
 * State is intentionally scoped to one thread so design sessions do not bleed
 * between contexts when the user switches threads.
 */
export const usePreviewDesignModeStore = create<PreviewDesignModeStore>((set, get) => ({
  modes: {},
  isActive: (threadId) => get().modes[threadId] === true,
  toggle: (threadId) => {
    const current = get().modes[threadId] === true;
    set({ modes: { ...get().modes, [threadId]: !current } });
  },
  setActive: (threadId, active) => {
    const current = get().modes[threadId] === true;
    if (current === active) return;
    set({ modes: { ...get().modes, [threadId]: active } });
  },
}));
