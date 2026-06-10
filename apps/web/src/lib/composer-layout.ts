import {
  COMPOSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
} from "@/stores/diffStore";

/** Inline project-tree width (`Sidebar` uses Tailwind `w-72`). */
export const SIDEBAR_WIDTH_PX = 288;

/** Gap between the project tree and the chat/panel row in App.tsx (`gap-1.5`). */
export const LAYOUT_COLUMN_GAP_PX = 6;

/** Live measurements from App layout refs; updated by {@link setLayoutMeasurements}. */
let measuredContentRowWidth = 0;
let measuredOuterRowWidth = 0;

/**
 * Publishes the current content-row and outer-row widths for layout decisions
 * outside React render (panel open, sidebar expand).
 */
export function setLayoutMeasurements(contentRowWidth: number, outerRowWidth: number): void {
  measuredContentRowWidth = contentRowWidth;
  measuredOuterRowWidth = outerRowWidth;
}

/** Width of the chat + right-panel split row, or a conservative fallback before mount. */
export function getContentRowWidth(): number {
  if (measuredContentRowWidth > 0) return measuredContentRowWidth;
  return Math.max(COMPOSER_MIN_WIDTH, window.innerWidth - SIDEBAR_WIDTH_PX - 24);
}

/** Width of the row that may include an inline project tree, or a fallback before mount. */
export function getOuterRowWidth(): number {
  if (measuredOuterRowWidth > 0) return measuredOuterRowWidth;
  return window.innerWidth - 12;
}

/**
 * Minimum content-row width for composer + inline panel at the given stored width.
 */
export function minContentWidthForSideBySidePanel(panelWidth: number): number {
  return COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + Math.max(PANEL_MIN_WIDTH, panelWidth);
}

/**
 * Minimum outer-row width to dock the project tree inline while reserving
 * `contentNeed` pixels for the chat/panel row.
 */
export function minOuterWidthForInlineSidebar(contentNeed: number): number {
  return contentNeed + LAYOUT_COLUMN_GAP_PX + SIDEBAR_WIDTH_PX;
}

/** Whether the content row can host composer and an inline panel side by side. */
export function canFitSideBySidePanel(contentRowWidth: number, panelWidth: number): boolean {
  return contentRowWidth >= minContentWidthForSideBySidePanel(panelWidth);
}

/** Whether the project tree can dock inline beside a content row of `contentNeed` px. */
export function canFitInlineSidebar(outerRowWidth: number, contentNeed: number): boolean {
  return outerRowWidth >= minOuterWidthForInlineSidebar(contentNeed);
}
