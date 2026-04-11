import { create } from "zustand";

/** UI state for cross-component toggles that commands need to control. */
interface UiState {
  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /** Whether the command palette overlay is open. */
  commandPaletteOpen: boolean;
  /** Whether the shortcut help dialog is open. */
  shortcutHelpOpen: boolean;

  /** Toggle sidebar collapsed state. */
  toggleSidebar: () => void;
  /** Set command palette open state. */
  setCommandPaletteOpen: (open: boolean) => void;
  /** Set shortcut help dialog open state. */
  setShortcutHelpOpen: (open: boolean) => void;
}

/** Zustand store for global UI toggle state. */
export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  shortcutHelpOpen: false,

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCommandPaletteOpen: (open) =>
    set({ commandPaletteOpen: open }),
  setShortcutHelpOpen: (open) =>
    set({ shortcutHelpOpen: open }),
}));
