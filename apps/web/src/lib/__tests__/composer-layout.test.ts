// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  SIDEBAR_WIDTH_PX,
  LAYOUT_COLUMN_GAP_PX,
  canFitInlineSidebar,
  canFitSideBySidePanel,
  minContentWidthForSideBySidePanel,
  minOuterWidthForInlineSidebar,
  overviewNoPaddingMinWidth,
  overviewResponsivePaddingPx,
  OVERVIEW_POPOVER_RESERVE_PX,
  OVERVIEW_RIGHT_RESERVE_PX,
  OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX,
  OVERVIEW_THREAD_GAP_PX,
  preferredSplitPanelWidth,
  shouldAutoOpenOverview,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_SPLIT_GAP_PX } from "@/stores/diffStore";

describe("composer-layout", () => {
  it("computes side-by-side minimum from composer, divider, and panel width", () => {
    expect(minContentWidthForSideBySidePanel(440)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + 440,
    );
    expect(minContentWidthForSideBySidePanel(100)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + PANEL_MIN_WIDTH,
    );
  });

  it("computes inline sidebar minimum from content need and column divider", () => {
    expect(minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH)).toBe(
      COMPOSER_MIN_WIDTH + LAYOUT_COLUMN_GAP_PX + SIDEBAR_WIDTH_PX,
    );
  });

  it("reports side-by-side fit from content-row width", () => {
    const need = minContentWidthForSideBySidePanel(440);
    expect(canFitSideBySidePanel(need, 440)).toBe(true);
    expect(canFitSideBySidePanel(need - 1, 440)).toBe(false);
  });

  it("opens the panel at half the content row by default", () => {
    expect(preferredSplitPanelWidth(2000)).toBe(1000);
  });

  it("never lets the default panel width starve the composer", () => {
    // A 900px row can't give half (450) and still leave the composer its min,
    // so the panel is capped to what remains after the composer and gap.
    const width = preferredSplitPanelWidth(900);
    expect(width).toBe(900 - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
    expect(width).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
  });

  it("clamps the default panel width to the panel minimum on narrow rows", () => {
    expect(preferredSplitPanelWidth(600)).toBe(PANEL_MIN_WIDTH);
  });

  it("auto-opens the Overview when the chat pane itself is wide", () => {
    expect(shouldAutoOpenOverview({ threadPaneWidth: 1400 })).toBe(true);
  });

  it("opens Overview at the 824px composer-and-popover boundary", () => {
    expect(COMPOSER_MIN_WIDTH + OVERVIEW_RIGHT_RESERVE_PX).toBe(824);
    expect(shouldAutoOpenOverview({ threadPaneWidth: 823 })).toBe(false);
    expect(shouldAutoOpenOverview({ threadPaneWidth: 824 })).toBe(true);
  });

  it("does not auto-open the Overview when the chat pane itself is narrow", () => {
    expect(shouldAutoOpenOverview({ threadPaneWidth: 800 })).toBe(false);
  });

  it("keeps Overview beside a composer that remains usable", () => {
    expect(shouldAutoOpenOverview({ threadPaneWidth: 960 })).toBe(true);
  });

  it("keeps the centered thread unpadded when the Overview can sit beside it", () => {
    expect(overviewNoPaddingMinWidth()).toBe(
      OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX +
        OVERVIEW_RIGHT_RESERVE_PX * 2,
    );
    expect(overviewResponsivePaddingPx(overviewNoPaddingMinWidth())).toBe(0);
  });

  it("only shifts the thread by the collision amount on roomy Overview layouts", () => {
    expect(overviewResponsivePaddingPx(overviewNoPaddingMinWidth() - 120)).toBe(120);
  });

  it("reserves the popover footprint and thread gap on narrow layouts", () => {
    expect(OVERVIEW_RIGHT_RESERVE_PX).toBe(
      OVERVIEW_POPOVER_RESERVE_PX + OVERVIEW_THREAD_GAP_PX,
    );
    expect(overviewResponsivePaddingPx(overviewNoPaddingMinWidth() - OVERVIEW_RIGHT_RESERVE_PX - 1)).toBe(
      OVERVIEW_RIGHT_RESERVE_PX,
    );
  });

  it("keeps the 1536px thread rail clear at a typical desktop pane width", () => {
    expect(overviewResponsivePaddingPx(1576)).toBe(344);
    expect(overviewResponsivePaddingPx(1900)).toBe(324);
    expect(overviewResponsivePaddingPx(2224)).toBe(0);
  });

  it("reports inline sidebar fit from outer-row width", () => {
    const need = minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH);
    expect(canFitInlineSidebar(need, COMPOSER_MIN_WIDTH)).toBe(true);
    expect(canFitInlineSidebar(need - 1, COMPOSER_MIN_WIDTH)).toBe(false);
  });
});
