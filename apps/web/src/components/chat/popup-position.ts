import type { CSSProperties } from "react";

/**
 * Describes the viewport anchor and size constraints for a fixed popup.
 */
export interface FixedPopupPositionOptions {
  readonly anchorRect: DOMRect;
  readonly estimatedHeight: number;
  readonly minWidth: number;
  readonly maxWidth?: number;
  readonly preferredPlacement?: "above" | "below" | "auto";
  readonly gap?: number;
  readonly viewportPadding?: number;
}

/**
 * Computes viewport-clamped fixed coordinates for popups rendered through a
 * body portal.
 */
export function computeFixedPopupPosition({
  anchorRect,
  estimatedHeight,
  minWidth,
  maxWidth,
  preferredPlacement = "auto",
  gap = 4,
  viewportPadding = 8,
}: FixedPopupPositionOptions): CSSProperties {
  const viewportWidth =
    window.visualViewport?.width ?? document.documentElement.clientWidth;
  const viewportHeight =
    window.visualViewport?.height ?? document.documentElement.clientHeight;
  const desiredWidth = Math.max(anchorRect.width, minWidth);
  const cappedDesiredWidth =
    maxWidth === undefined ? desiredWidth : Math.min(desiredWidth, maxWidth);
  const width = Math.min(cappedDesiredWidth, viewportWidth - viewportPadding * 2);
  const left = Math.min(
    Math.max(anchorRect.left, viewportPadding),
    viewportWidth - width - viewportPadding,
  );
  const canPlaceAbove = anchorRect.top > estimatedHeight + gap + viewportPadding;
  const placeAbove =
    preferredPlacement === "above" ||
    (preferredPlacement === "auto" && canPlaceAbove);
  const top = placeAbove
    ? Math.max(viewportPadding, anchorRect.top - estimatedHeight - gap)
    : Math.min(
        anchorRect.bottom + gap,
        viewportHeight - estimatedHeight - viewportPadding,
      );

  return {
    position: "fixed",
    left,
    top,
    width,
  };
}
