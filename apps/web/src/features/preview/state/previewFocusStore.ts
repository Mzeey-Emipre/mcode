import { create } from "zustand";

interface PreviewFocusStore {
  /**
   * Monotonically-increasing counter bumped each time the omnibox should
   * receive focus. BrowserHeader watches the value via useEffect: whenever it
   * changes, the input is focused and its contents selected so the user can
   * type a new URL immediately.
   *
   * Using a tick (not a boolean) means consecutive focus requests still fire
   * without the parent having to clear an intermediate state, and a bump
   * dispatched before PreviewPanel mounts (e.g. by the keyboard shortcut
   * while the panel is closed) is observed on first render.
   */
  readonly omniboxFocusTick: number;
  /** Bump the focus tick. Called by the preview-opening keyboard command. */
  requestOmniboxFocus: () => void;
}

/**
 * Lightweight signal store for "the preview should focus its omnibox now."
 * Read by BrowserHeader via PreviewPanel; written by the preview.toggle
 * command handler when the user opens the preview panel from anywhere via
 * the mod+shift+b shortcut (or the matching menu/click flows once they exist).
 */
export const usePreviewFocusStore = create<PreviewFocusStore>((set) => ({
  omniboxFocusTick: 0,
  requestOmniboxFocus: () =>
    set((s) => ({ omniboxFocusTick: s.omniboxFocusTick + 1 })),
}));
