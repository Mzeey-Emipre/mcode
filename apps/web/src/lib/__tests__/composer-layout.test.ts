// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  SIDEBAR_WIDTH_PX,
  LAYOUT_COLUMN_GAP_PX,
  canFitInlineSidebar,
  canFitSideBySidePanel,
  minContentWidthForSideBySidePanel,
  minOuterWidthForInlineSidebar,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_SPLIT_GAP_PX } from "@/stores/diffStore";

describe("composer-layout", () => {
  it("computes side-by-side minimum from composer, gap, and panel width", () => {
    expect(minContentWidthForSideBySidePanel(440)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + 440,
    );
    expect(minContentWidthForSideBySidePanel(100)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + PANEL_MIN_WIDTH,
    );
  });

  it("computes inline sidebar minimum from content need and column gap", () => {
    expect(minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH)).toBe(
      COMPOSER_MIN_WIDTH + LAYOUT_COLUMN_GAP_PX + SIDEBAR_WIDTH_PX,
    );
  });

  it("reports side-by-side fit from content-row width", () => {
    const need = minContentWidthForSideBySidePanel(440);
    expect(canFitSideBySidePanel(need, 440)).toBe(true);
    expect(canFitSideBySidePanel(need - 1, 440)).toBe(false);
  });

  it("reports inline sidebar fit from outer-row width", () => {
    const need = minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH);
    expect(canFitInlineSidebar(need, COMPOSER_MIN_WIDTH)).toBe(true);
    expect(canFitInlineSidebar(need - 1, COMPOSER_MIN_WIDTH)).toBe(false);
  });
});
