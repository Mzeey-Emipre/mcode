import {
  COMPOSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
} from "@/stores/diffStore";
import { useLayoutStore } from "@/stores/layoutStore";

/** Inline project-tree width (`Sidebar` uses Tailwind `w-72`). */
export const SIDEBAR_WIDTH_PX = 288;

/** Gap between the project tree and the chat/panel row in App.tsx. */
export const LAYOUT_COLUMN_GAP_PX = 0;

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
  return Math.max(COMPOSER_MIN_WIDTH, window.innerWidth - SIDEBAR_WIDTH_PX);
}

/** Width of the row that may include an inline project tree, or a fallback before mount. */
export function getOuterRowWidth(): number {
  if (measuredOuterRowWidth > 0) return measuredOuterRowWidth;
  return window.innerWidth;
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

/** Visual thread column width used for Overview collision spacing. */
export const OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX = 1536;

/** Right-side popover footprint for Overview (`w-80`) plus collision padding. */
export const OVERVIEW_POPOVER_RESERVE_PX = 328;

/** Minimum breathing room between the centered thread column and the Overview. */
export const OVERVIEW_THREAD_GAP_PX = 16;

/** Space from the thread rail to the pane edge while Overview sits beside it. */
export const OVERVIEW_RIGHT_RESERVE_PX =
  OVERVIEW_POPOVER_RESERVE_PX + OVERVIEW_THREAD_GAP_PX;

/** Smallest chat pane that can keep the composer usable beside Overview. */
export const OVERVIEW_AUTO_OPEN_MIN_ROW =
  COMPOSER_MIN_WIDTH + OVERVIEW_RIGHT_RESERVE_PX;

/**
 * Whether the Overview should auto-open given the actual chat pane width.
 * The split row can stay wide while the right panel squeezes the thread; only
 * the pane that contains the composer is a trustworthy signal.
 */
export function shouldAutoOpenOverview(args: {
  threadPaneWidth: number;
}): boolean {
  return args.threadPaneWidth >= OVERVIEW_AUTO_OPEN_MIN_ROW;
}

/** Width at which a centered thread can sit beside the Overview with no offset. */
export function overviewNoPaddingMinWidth(): number {
  return OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX +
    (OVERVIEW_RIGHT_RESERVE_PX * 2);
}

/** Right padding needed to keep centered thread content clear of the Overview. */
export function overviewResponsivePaddingPx(contentWidth: number): number {
  return Math.max(
    0,
    Math.min(OVERVIEW_RIGHT_RESERVE_PX, overviewNoPaddingMinWidth() - contentWidth),
  );
}

/**
 * CSS equivalent of {@link overviewResponsivePaddingPx}, using the chat pane's
 * own width. The reservation follows the actual chat-pane width, including in split mode.
 */
export function overviewResponsivePaddingRight(): string {
  return `clamp(0px, calc(${overviewNoPaddingMinWidth()}px - 100%), ${OVERVIEW_RIGHT_RESERVE_PX}px)`;
}

/** Whether the project tree can dock inline beside a content row of `contentNeed` px. */
export function canFitInlineSidebar(outerRowWidth: number, contentNeed: number): boolean {
  return outerRowWidth >= minOuterWidthForInlineSidebar(contentNeed);
}
