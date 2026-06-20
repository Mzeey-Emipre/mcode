import { getDefaultPanelWidthPx, useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  canFitSideBySidePanel,
  getContentRowWidth,
  preferredSplitPanelWidth,
} from "@/lib/composer-layout";

/**
 * On first open, size the panel to ~half the content row instead of the fixed
 * default. Only applies while the scope still carries the built-in default
 * width, so a width the user has dragged is never overridden.
 */
function applyHalfWidthIfUntouched(workspaceId: string, threadId?: string | null): void {
  const diff = useDiffStore.getState();
  if (diff.getRightPanel(workspaceId, threadId).width !== getDefaultPanelWidthPx()) return;
  diff.setRightPanelWidth(workspaceId, threadId, preferredSplitPanelWidth(getContentRowWidth()));
}

/**
 * After opening the right panel, maximize it when the content row cannot fit
 * composer and panel side by side. Composer-first: inline mode only when there
 * is room; otherwise the panel owns the content row. The width is read from the
 * scope's effective panel record (the thread's own, or the workspace fallback).
 */
export function applyMaximizeIfCramped(
  workspaceId: string,
  threadId?: string | null,
): void {
  const panelWidth = useDiffStore.getState().getRightPanel(workspaceId, threadId).width;
  if (canFitSideBySidePanel(getContentRowWidth(), panelWidth)) return;
  useUiStore.getState().setRightPanelMaximized(true);
}

/**
 * Opens the right panel for a workspace/thread and applies cramped-layout maximize.
 */
export function showRightPanelAdaptive(
  workspaceId: string,
  threadId?: string | null,
): void {
  useDiffStore.getState().showRightPanel(workspaceId, threadId);
  applyHalfWidthIfUntouched(workspaceId, threadId);
  applyMaximizeIfCramped(workspaceId, threadId);
}

/**
 * Toggles the right panel; on open applies cramped-layout maximize, on close
 * clears maximize so the chat pane returns cleanly.
 */
export function toggleRightPanelAdaptive(
  workspaceId: string,
  threadId?: string | null,
): void {
  const diff = useDiffStore.getState();
  const wasVisible = diff.getRightPanelVisible(workspaceId, threadId);
  diff.toggleRightPanel(workspaceId, threadId);
  if (wasVisible) {
    useUiStore.getState().setRightPanelMaximized(false);
    return;
  }
  applyHalfWidthIfUntouched(workspaceId, threadId);
  applyMaximizeIfCramped(workspaceId, threadId);
}

/**
 * Hides the right panel for the active workspace/thread and clears maximize.
 */
export function hideRightPanelAdaptive(workspaceId: string, threadId?: string | null): void {
  useDiffStore.getState().hideRightPanel(workspaceId, threadId);
  useUiStore.getState().setRightPanelMaximized(false);
}

/** Active workspace/thread hide helper for layout guard and Escape paths. */
export function hideActiveRightPanelAdaptive(): void {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return;
  hideRightPanelAdaptive(activeWorkspaceId, activeThreadId);
}
