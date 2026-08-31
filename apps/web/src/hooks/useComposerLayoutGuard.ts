import { useEffect, type RefObject } from "react";
import { COMPOSER_MIN_WIDTH } from "@/stores/diffStore";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import {
  canFitInlineSidebar,
  canFitSideBySidePanel,
  minContentWidthForSideBySidePanel,
  minOuterWidthForInlineSidebar,
  setLayoutMeasurements,
} from "@/lib/composer-layout";

/** Inputs that affect composer-first layout enforcement. */
export interface ComposerLayoutGuardOptions {
  readonly settingsOpen: boolean;
  readonly showLanding: boolean;
  readonly showPullRequests: boolean;
  readonly activeWorkspaceId: string | null;
  readonly activeThreadId: string | null;
}

type LayoutUiState = ReturnType<typeof useUiStore.getState>;

function canRestoreSidebar(outerWidth: number, contentWidth: number, contentNeed: number): boolean {
  return (
    canFitInlineSidebar(outerWidth, contentNeed) &&
    contentWidth >= contentNeed
  );
}

function floatSidebarWhenNeeded(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
  contentNeed: number,
): void {
  const sidebarDocked = !ui.sidebarCollapsed && !ui.sidebarFloating;
  if (
    sidebarDocked &&
    (contentWidth < contentNeed || !canFitInlineSidebar(outerWidth, contentNeed))
  ) {
    ui.floatSidebar();
  }
}

function enforcePullRequestLayout(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
): void {
  if (ui.sidebarCollapsedByLayout) {
    if (canRestoreSidebar(outerWidth, contentWidth, COMPOSER_MIN_WIDTH)) {
      ui.restoreSidebarFromLayoutCollapse();
    }
    return;
  }
  if (ui.sidebarFloating && canRestoreSidebar(outerWidth, contentWidth, COMPOSER_MIN_WIDTH)) {
    ui.expandSidebar();
    return;
  }
  floatSidebarWhenNeeded(ui, outerWidth, contentWidth, COMPOSER_MIN_WIDTH);
}

function enforceLandingLayout(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
): void {
  if (ui.sidebarFloating && canRestoreSidebar(outerWidth, contentWidth, COMPOSER_MIN_WIDTH)) {
    ui.expandSidebar();
    return;
  }
  floatSidebarWhenNeeded(ui, outerWidth, contentWidth, COMPOSER_MIN_WIDTH);
}

function restoreThreadLayout(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
  contentNeed: number,
  panelVisible: boolean,
  panelWidth: number,
): boolean {
  if (
    panelVisible &&
    ui.rightPanelMaximized &&
    ui.rightPanelMaximizedByLayout &&
    canFitSideBySidePanel(contentWidth, panelWidth)
  ) {
    ui.setRightPanelMaximized(false);
    return true;
  }
  if (ui.sidebarCollapsedByLayout && canRestoreSidebar(outerWidth, contentWidth, contentNeed)) {
    ui.restoreSidebarFromLayoutCollapse();
    return true;
  }
  if (ui.sidebarFloating && canRestoreSidebar(outerWidth, contentWidth, contentNeed)) {
    ui.expandSidebar();
    return true;
  }
  return false;
}

function maximizeThreadPanelWhenNeeded(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
  panelInline: boolean,
  panelWidth: number,
): boolean {
  const sidebarDocked = !ui.sidebarCollapsed && !ui.sidebarFloating;
  if (panelInline && sidebarDocked) {
    const outerNeed = minOuterWidthForInlineSidebar(
      minContentWidthForSideBySidePanel(panelWidth),
    );
    if (outerWidth < outerNeed) {
      ui.setRightPanelMaximized(true, "layout");
      ui.floatSidebar();
      return true;
    }
  }
  if (panelInline && !canFitSideBySidePanel(contentWidth, panelWidth)) {
    ui.setRightPanelMaximized(true, "layout");
    return true;
  }
  return false;
}

function enforceThreadLayout(
  ui: LayoutUiState,
  outerWidth: number,
  contentWidth: number,
  workspaceId: string,
  threadId: string | null,
): void {
  const diff = useDiffStore.getState();
  const panelVisible = diff.getRightPanelVisible(workspaceId, threadId);
  const panelWidth = diff.getRightPanel(workspaceId, threadId).width;
  const panelInline = panelVisible && !ui.rightPanelMaximized;
  const contentNeed = panelInline
    ? minContentWidthForSideBySidePanel(panelWidth)
    : COMPOSER_MIN_WIDTH;
  if (restoreThreadLayout(ui, outerWidth, contentWidth, contentNeed, panelVisible, panelWidth)) return;
  if (maximizeThreadPanelWhenNeeded(ui, outerWidth, contentWidth, panelInline, panelWidth)) return;
  floatSidebarWhenNeeded(ui, outerWidth, contentWidth, contentNeed);
}

function enforceComposerLayout(
  outerWidth: number,
  contentWidth: number,
  opts: ComposerLayoutGuardOptions,
): void {
  setLayoutMeasurements(contentWidth, outerWidth);
  const ui = useUiStore.getState();
  if (opts.showPullRequests) {
    enforcePullRequestLayout(ui, outerWidth, contentWidth);
    return;
  }
  if (opts.showLanding || !opts.activeWorkspaceId) {
    enforceLandingLayout(ui, outerWidth, contentWidth);
    return;
  }
  enforceThreadLayout(ui, outerWidth, contentWidth, opts.activeWorkspaceId, opts.activeThreadId);
}

/**
 * Composer-first responsive guard: on shrink, closes the inline right panel and
 * floats the docked project tree before the chat/composer can fall below its
 * minimum width. Publishes live row measurements for adaptive open paths.
 */
export function useComposerLayoutGuard(
  outerRowRef: RefObject<HTMLElement | null>,
  contentRowRef: RefObject<HTMLElement | null>,
  opts: ComposerLayoutGuardOptions,
): void {
  const {
    settingsOpen,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
  } = opts;
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUiStore((s) => s.sidebarFloating);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const rightPanelMaximizedByLayout = useUiStore((s) => s.rightPanelMaximizedByLayout);

  useEffect(() => {
    if (settingsOpen) return;

    const outer = outerRowRef.current;
    const content = contentRowRef.current;
    if (!outer || !content) return;

    const enforce = () => {
      enforceComposerLayout(outer.clientWidth, content.clientWidth, {
        settingsOpen,
        showLanding,
        showPullRequests,
        activeWorkspaceId,
        activeThreadId,
      });
    };

    enforce();

    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        enforce();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(outer);
    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    outerRowRef,
    contentRowRef,
    settingsOpen,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
    sidebarCollapsed,
    sidebarFloating,
    rightPanelMaximized,
    rightPanelMaximizedByLayout,
  ]);
}
