import { create } from "zustand";
import {
  canFitInlineSidebar,
  getContentRowWidth,
  getOuterRowWidth,
  minContentWidthForSideBySidePanel,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** Top-level content surface displayed beside the application sidebar. */
export type PrimarySurface = "chat" | "pullRequests";

/** Thread lifecycle view selected for one Project in the current app session. */
export type ProjectThreadView = "active" | "completed";

/** UI state for cross-component toggles that commands need to control. */
interface UiState {
  /** Top-level content surface displayed beside the application sidebar. */
  primarySurface: PrimarySurface;
  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /** Whether the layout guard, not the user, collapsed the sidebar. */
  sidebarCollapsedByLayout: boolean;
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
  /** Whether cramped layout, not the user, maximized the right panel. */
  rightPanelMaximizedByLayout: boolean;
  /** Per-Project thread views for the current app session. */
  projectThreadViews: Record<string, ProjectThreadView>;

  /** Select the top-level content surface. */
  setPrimarySurface: (surface: PrimarySurface) => void;

  /** Toggle sidebar collapsed state (expands floating when inline will not fit). */
  toggleSidebar: () => void;
  /** Expand the project tree inline when there is room, otherwise as a float. */
  expandSidebar: () => void;
  /** Keep the open project tree visible as a floating panel. */
  floatSidebar: () => void;
  /** Collapse the project tree and exit floating mode. */
  collapseSidebar: (source?: "user" | "layout") => void;
  /** Restore a sidebar that was collapsed only to protect the layout. */
  restoreSidebarFromLayoutCollapse: () => void;
  /** Dismiss the floating project tree without changing docked expand state. */
  closeFloatingSidebar: () => void;
  /** Set shortcut help dialog open state. */
  setShortcutHelpOpen: (open: boolean) => void;
  /** Toggle the right panel between maximized (full content area) and side-by-side. */
  toggleRightPanelMaximized: () => void;
  /** Set the right panel maximized state explicitly. */
  setRightPanelMaximized: (maximized: boolean, source?: "user" | "layout") => void;
  /** Select the Active or Completed thread view for one Project. */
  setProjectThreadView: (workspaceId: string, view: ProjectThreadView) => void;
  /** Toggle one Project between its Active and Completed thread views. */
  toggleProjectThreadView: (workspaceId: string) => void;
}

/** Minimum content-row width needed given the current right-panel visibility. */
function contentNeedForSidebarDock(rightPanelMaximized: boolean): number {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return COMPOSER_MIN_WIDTH;

  const diff = useDiffStore.getState();
  const panelVisible = diff.getRightPanelVisible(activeWorkspaceId, activeThreadId);
  const panelInline = panelVisible && !rightPanelMaximized;
  if (!panelInline) return COMPOSER_MIN_WIDTH;

  return minContentWidthForSideBySidePanel(
    diff.getRightPanel(activeWorkspaceId, activeThreadId).width,
  );
}

/** Zustand store for global UI toggle state. Command palette state lives in commandPaletteStore. */
export const useUiStore = create<UiState>((set, get) => ({
  primarySurface: "chat",
  sidebarCollapsed: false,
  sidebarCollapsedByLayout: false,
  sidebarFloating: false,
  shortcutHelpOpen: false,
  rightPanelMaximized: false,
  rightPanelMaximizedByLayout: false,
  projectThreadViews: {},

  setPrimarySurface: (surface) =>
    set({
      primarySurface: surface,
      rightPanelMaximized: surface === "pullRequests" ? false : get().rightPanelMaximized,
      rightPanelMaximizedByLayout:
        surface === "pullRequests" ? false : get().rightPanelMaximizedByLayout,
    }),

  toggleSidebar: () => {
    if (get().sidebarCollapsed) get().expandSidebar();
    else get().collapseSidebar();
  },
  expandSidebar: () => {
    const contentNeed = contentNeedForSidebarDock(get().rightPanelMaximized);
    const inline =
      canFitInlineSidebar(getOuterRowWidth(), contentNeed) &&
      getContentRowWidth() >= contentNeed;
    set({ sidebarCollapsed: false, sidebarCollapsedByLayout: false, sidebarFloating: !inline });
  },
  floatSidebar: () =>
    set({ sidebarCollapsed: false, sidebarCollapsedByLayout: false, sidebarFloating: true }),
  collapseSidebar: (source = "user") =>
    set({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: source === "layout",
      sidebarFloating: false,
    }),
  restoreSidebarFromLayoutCollapse: () => {
    if (!get().sidebarCollapsedByLayout) return;
    set({ sidebarCollapsed: false, sidebarCollapsedByLayout: false, sidebarFloating: false });
  },
  closeFloatingSidebar: () =>
    set({ sidebarFloating: false, sidebarCollapsed: true, sidebarCollapsedByLayout: false }),
  setShortcutHelpOpen: (open) =>
    set({ shortcutHelpOpen: open }),
  toggleRightPanelMaximized: () =>
    set((s) => ({
      rightPanelMaximized: !s.rightPanelMaximized,
      rightPanelMaximizedByLayout: false,
    })),
  setRightPanelMaximized: (maximized, source = "user") =>
    set({
      rightPanelMaximized: maximized,
      rightPanelMaximizedByLayout: maximized && source === "layout",
    }),
  setProjectThreadView: (workspaceId, view) =>
    set((state) => ({
      projectThreadViews: { ...state.projectThreadViews, [workspaceId]: view },
    })),
  toggleProjectThreadView: (workspaceId) =>
    set((state) => ({
      projectThreadViews: {
        ...state.projectThreadViews,
        [workspaceId]:
          state.projectThreadViews[workspaceId] === "completed"
            ? "active"
            : "completed",
      },
    })),
}));
