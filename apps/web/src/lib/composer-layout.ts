import {
  COMPOSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
} from "@/stores/diffStore";
import { useLayoutStore } from "@/stores/layoutStore";

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
  useLayoutStore.getState().setContentRowWidth(contentRowWidth);
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

/**
 * Preferred panel width when it first opens: a fraction (default half) of the
 * content row, clamped so the panel never drops below its minimum and always
 * leaves the composer its minimum width. Lets the panel open to ~50% of the
 * thread view instead of a fixed size, while still degrading to a sane width on
 * narrow viewports.
 */
export function preferredSplitPanelWidth(contentRowWidth: number, fraction = 0.5): number {
  const target = Math.round(contentRowWidth * fraction);
  const max = Math.max(PANEL_MIN_WIDTH, contentRowWidth - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
  return Math.max(PANEL_MIN_WIDTH, Math.min(target, max));
}

/**
 * Content-row width below which the Overview should not auto-open: on a narrow
 * row it would crowd the chat, so the user opens it on demand instead.
 */
export const OVERVIEW_AUTO_OPEN_MIN_ROW = 1024;

/** Visual thread column width from the shared `max-w-4xl` message/composer shell. */
export const OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX = 896;

/**
 * Right-side popover footprint for Overview (`w-80`) plus collision padding. This
 * is also the maximum padding we apply when the row is too narrow to keep the
 * centered thread clear of the popover.
 */
export const OVERVIEW_POPOVER_RESERVE_PX = 328;

/** Minimum breathing room between the centered thread column and the Overview. */
export const OVERVIEW_THREAD_GAP_PX = 16;

/**
 * Whether the Overview should auto-open and "sit" given the current space. It
 * stays closed on narrow rows, and when the right panel is open it only opens if
 * chat and panel still fit side by side (i.e., the layout isn't cramped).
 */
export function shouldAutoOpenOverview(args: {
  contentRowWidth: number;
  rightPanelVisible: boolean;
  rightPanelWidth: number;
}): boolean {
  const { contentRowWidth, rightPanelVisible, rightPanelWidth } = args;
  if (contentRowWidth < OVERVIEW_AUTO_OPEN_MIN_ROW) return false;
  if (rightPanelVisible && !canFitSideBySidePanel(contentRowWidth, rightPanelWidth)) return false;
  return true;
}

/** Width at which a centered thread can sit beside the Overview with no offset. */
export function overviewNoPaddingMinWidth(): number {
  return OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX +
    (OVERVIEW_POPOVER_RESERVE_PX * 2) +
    (OVERVIEW_THREAD_GAP_PX * 2);
}

/** Right padding needed to keep centered thread content clear of the Overview. */
export function overviewResponsivePaddingPx(contentWidth: number): number {
  return Math.max(
    0,
    Math.min(OVERVIEW_POPOVER_RESERVE_PX, overviewNoPaddingMinWidth() - contentWidth),
  );
}

/**
 * CSS equivalent of {@link overviewResponsivePaddingPx}, using the container's
 * own width so the chat stays centered on roomy screens and only steps left as
 * much as the open Overview requires.
 */
export function overviewResponsivePaddingRight(): string {
  return `clamp(0px, calc(${overviewNoPaddingMinWidth()}px - 100%), ${OVERVIEW_POPOVER_RESERVE_PX}px)`;
}

/** Whether the project tree can dock inline beside a content row of `contentNeed` px. */
export function canFitInlineSidebar(outerRowWidth: number, contentNeed: number): boolean {
  return outerRowWidth >= minOuterWidthForInlineSidebar(contentNeed);
}
