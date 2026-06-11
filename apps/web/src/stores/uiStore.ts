import { create } from "zustand";
import {
  canFitInlineSidebar,
  getContentRowWidth,
  getOuterRowWidth,
  minContentWidthForSideBySidePanel,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** UI state for cross-component toggles that commands need to control. */
interface UiState {
  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /**
   * When true the project tree is open as a left-anchored floating panel rather
   * than a docked column (composer-first cramped layouts).
   */
  sidebarFloating: boolean;
  /** Whether the shortcut help dialog is open. */
  shortcutHelpOpen: boolean;
  /**
   * Whether the right panel is maximized to fill the content area beside the
   * project tree, hiding the chat/composer. A transient view mode (not persisted):
   * the panel keeps its stored width, so toggling back restores side-by-side.
   */
  rightPanelMaximized: boolean;

  /** Toggle sidebar collapsed state (expands floating when inline will not fit). */
  toggleSidebar: () => void;
  /** Expand the project tree inline when there is room, otherwise as a float. */
  expandSidebar: () => void;
  /** Collapse the project tree and exit floating mode. */
  collapseSidebar: () => void;
  /** Dismiss the floating project tree without changing docked expand state. */
  closeFloatingSidebar: () => void;
  /** Set shortcut help dialog open state. */
  setShortcutHelpOpen: (open: boolean) => void;
  /** Toggle the right panel between maximized (full content area) and side-by-side. */
  toggleRightPanelMaximized: () => void;
  /** Set the right panel maximized state explicitly. */
  setRightPanelMaximized: (maximized: boolean) => void;
}

/** Minimum content-row width needed given the current right-panel visibility. */
function contentNeedForSidebarDock(rightPanelMaximized: boolean): number {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return COMPOSER_MIN_WIDTH;

  const diff = useDiffStore.getState();
  const panelVisible = diff.getRightPanelVisible(activeWorkspaceId, activeThreadId);
  const panelInline = panelVisible && !rightPanelMaximized;
  if (!panelInline) return COMPOSER_MIN_WIDTH;

  return minContentWidthForSideBySidePanel(diff.getRightPanel(activeWorkspaceId).width);
}

/** Zustand store for global UI toggle state. Command palette state lives in commandPaletteStore. */
export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  sidebarFloating: false,
  shortcutHelpOpen: false,
  rightPanelMaximized: false,

  toggleSidebar: () => {
    if (get().sidebarCollapsed) get().expandSidebar();
    else get().collapseSidebar();
  },
  expandSidebar: () => {
    const contentNeed = contentNeedForSidebarDock(get().rightPanelMaximized);
    const inline =
      canFitInlineSidebar(getOuterRowWidth(), contentNeed) &&
      getContentRowWidth() >= contentNeed;
    set({ sidebarCollapsed: false, sidebarFloating: !inline });
  },
  collapseSidebar: () => set({ sidebarCollapsed: true, sidebarFloating: false }),
  closeFloatingSidebar: () => set({ sidebarFloating: false, sidebarCollapsed: true }),
  setShortcutHelpOpen: (open) =>
    set({ shortcutHelpOpen: open }),
  toggleRightPanelMaximized: () =>
    set((s) => ({ rightPanelMaximized: !s.rightPanelMaximized })),
  setRightPanelMaximized: (maximized) =>
    set({ rightPanelMaximized: maximized }),
}));
