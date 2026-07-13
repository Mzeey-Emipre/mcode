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
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUiStore((s) => s.sidebarFloating);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const rightPanelMaximizedByLayout = useUiStore((s) => s.rightPanelMaximizedByLayout);

  useEffect(() => {
    if (opts.settingsOpen) return;

    const outer = outerRowRef.current;
    const content = contentRowRef.current;
    if (!outer || !content) return;

    const enforce = () => {
      const outerWidth = outer.clientWidth;
      const contentWidth = content.clientWidth;
      setLayoutMeasurements(contentWidth, outerWidth);

      const ui = useUiStore.getState();
      const sidebarDocked = !ui.sidebarCollapsed && !ui.sidebarFloating;

      if (opts.showPullRequests) {
        if (ui.sidebarCollapsedByLayout) {
          if (
            canFitInlineSidebar(outerWidth, COMPOSER_MIN_WIDTH) &&
            contentWidth >= COMPOSER_MIN_WIDTH
          ) {
            ui.restoreSidebarFromLayoutCollapse();
          }
          return;
        }

        if (
          ui.sidebarFloating &&
          canFitInlineSidebar(outerWidth, COMPOSER_MIN_WIDTH) &&
          contentWidth >= COMPOSER_MIN_WIDTH
        ) {
          ui.expandSidebar();
          return;
        }

        if (
          sidebarDocked &&
          (contentWidth < COMPOSER_MIN_WIDTH ||
            !canFitInlineSidebar(outerWidth, COMPOSER_MIN_WIDTH))
        ) {
          ui.floatSidebar();
        }
        return;
      }

      const { activeWorkspaceId, activeThreadId } = opts;
      if (opts.showLanding || !activeWorkspaceId) {
        if (
          ui.sidebarFloating &&
          canFitInlineSidebar(outerWidth, COMPOSER_MIN_WIDTH) &&
          contentWidth >= COMPOSER_MIN_WIDTH
        ) {
          ui.expandSidebar();
          return;
        }

        if (
          sidebarDocked &&
          (contentWidth < COMPOSER_MIN_WIDTH ||
            !canFitInlineSidebar(outerWidth, COMPOSER_MIN_WIDTH))
        ) {
          ui.floatSidebar();
        }
        return;
      }

      const diff = useDiffStore.getState();

      const panelVisible = diff.getRightPanelVisible(activeWorkspaceId, activeThreadId);
      const panelWidth = diff.getRightPanel(activeWorkspaceId, activeThreadId).width;
      const panelInline = panelVisible && !ui.rightPanelMaximized;
      const contentNeed = panelInline
        ? minContentWidthForSideBySidePanel(panelWidth)
        : COMPOSER_MIN_WIDTH;

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
        if (canFitInlineSidebar(outerWidth, contentNeed) && contentWidth >= contentNeed) {
          ui.restoreSidebarFromLayoutCollapse();
          return;
        }
      }

      if (
        ui.sidebarFloating &&
        canFitInlineSidebar(outerWidth, contentNeed) &&
        contentWidth >= contentNeed
      ) {
        ui.expandSidebar();
        return;
      }

      if (panelInline && sidebarDocked) {
        const needAll = minOuterWidthForInlineSidebar(
          minContentWidthForSideBySidePanel(panelWidth),
        );
        if (outerWidth < needAll) {
          ui.setRightPanelMaximized(true, "layout");
          ui.floatSidebar();
          return;
        }
      }

      if (panelInline && !canFitSideBySidePanel(contentWidth, panelWidth)) {
        ui.setRightPanelMaximized(true, "layout");
        return;
      }

      if (!sidebarDocked) return;

      if (contentWidth < contentNeed || !canFitInlineSidebar(outerWidth, contentNeed)) {
        ui.floatSidebar();
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
    opts.showPullRequests,
    opts.activeWorkspaceId,
    opts.activeThreadId,
    sidebarCollapsed,
    sidebarFloating,
    rightPanelMaximized,
    rightPanelMaximizedByLayout,
  ]);
}
