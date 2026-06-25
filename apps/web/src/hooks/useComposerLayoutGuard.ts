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
  readonly activeWorkspaceId: string | null;
  readonly activeThreadId: string | null;
}

/**
 * Composer-first responsive guard: on shrink, closes the inline right panel and
 * collapses the docked project tree before the chat/composer can fall below its
 * minimum width. Publishes live row measurements for adaptive open paths.
 */
export function useComposerLayoutGuard(
  outerRowRef: RefObject<HTMLElement | null>,
  contentRowRef: RefObject<HTMLElement | null>,
  opts: ComposerLayoutGuardOptions,
): void {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUiStore((s) => s.sidebarFloating);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const rightPanelMaximizedByLayout = useUiStore((s) => s.rightPanelMaximizedByLayout);

  useEffect(() => {
    if (opts.settingsOpen || opts.showLanding || !opts.activeWorkspaceId) return;

    const outer = outerRowRef.current;
    const content = contentRowRef.current;
    if (!outer || !content) return;

    const enforce = () => {
      const outerWidth = outer.clientWidth;
      const contentWidth = content.clientWidth;
      setLayoutMeasurements(contentWidth, outerWidth);

      const ui = useUiStore.getState();
      const diff = useDiffStore.getState();
      const { activeWorkspaceId, activeThreadId } = opts;
      if (!activeWorkspaceId) return;

      const panelVisible = diff.getRightPanelVisible(activeWorkspaceId, activeThreadId);
      const panelWidth = diff.getRightPanel(activeWorkspaceId, activeThreadId).width;
      const panelInline = panelVisible && !ui.rightPanelMaximized;
      const sidebarDocked = !ui.sidebarCollapsed && !ui.sidebarFloating;

      if (
        panelVisible &&
        ui.rightPanelMaximized &&
        ui.rightPanelMaximizedByLayout &&
        canFitSideBySidePanel(contentWidth, panelWidth)
      ) {
        ui.setRightPanelMaximized(false);
        return;
      }

      if (ui.sidebarCollapsedByLayout) {
        const contentNeed = panelInline
          ? minContentWidthForSideBySidePanel(panelWidth)
          : COMPOSER_MIN_WIDTH;
        if (canFitInlineSidebar(outerWidth, contentNeed) && contentWidth >= contentNeed) {
          ui.restoreSidebarFromLayoutCollapse();
          return;
        }
      }

      if (panelInline && sidebarDocked) {
        const needAll = minOuterWidthForInlineSidebar(
          minContentWidthForSideBySidePanel(panelWidth),
        );
        if (outerWidth < needAll) {
          ui.setRightPanelMaximized(true, "layout");
          ui.collapseSidebar("layout");
          return;
        }
      }

      if (panelInline && !canFitSideBySidePanel(contentWidth, panelWidth)) {
        ui.setRightPanelMaximized(true, "layout");
        return;
      }

      if (!sidebarDocked) return;

      const contentNeed = panelInline
        ? minContentWidthForSideBySidePanel(panelWidth)
        : COMPOSER_MIN_WIDTH;

      if (contentWidth < contentNeed || !canFitInlineSidebar(outerWidth, contentNeed)) {
        ui.collapseSidebar("layout");
      }
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
    opts.settingsOpen,
    opts.showLanding,
    opts.activeWorkspaceId,
    opts.activeThreadId,
    sidebarCollapsed,
    sidebarFloating,
    rightPanelMaximized,
    rightPanelMaximizedByLayout,
  ]);
}
