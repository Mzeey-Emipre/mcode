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

function getViewportSize(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? document.documentElement.clientWidth,
    height: window.visualViewport?.height ?? document.documentElement.clientHeight,
  };
}

function getPopupWidth(anchorWidth: number, minWidth: number, maxWidth: number | undefined, viewportWidth: number, viewportPadding: number): number {
  const desiredWidth = Math.max(anchorWidth, minWidth);
  const cappedWidth = maxWidth === undefined ? desiredWidth : Math.min(desiredWidth, maxWidth);
  return Math.min(cappedWidth, viewportWidth - viewportPadding * 2);
}

function getPopupLeft(anchorLeft: number, width: number, viewportWidth: number, viewportPadding: number): number {
  return Math.min(Math.max(anchorLeft, viewportPadding), viewportWidth - width - viewportPadding);
}

function getPlacement(anchorRect: DOMRect, estimatedHeight: number, viewportHeight: number, gap: number, viewportPadding: number, preferredPlacement: NonNullable<FixedPopupPositionOptions["preferredPlacement"]>): { placeAbove: boolean; spaceAbove: number; spaceBelow: number } {
  const spaceAbove = Math.max(0, anchorRect.top - gap - viewportPadding);
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - viewportPadding);
  const canPlaceAbove = spaceAbove >= estimatedHeight;
  const canPlaceBelow = spaceBelow >= estimatedHeight;
  return {
    placeAbove: preferredPlacement === "above" || (preferredPlacement === "auto" && (canPlaceAbove || (!canPlaceBelow && spaceAbove >= spaceBelow))),
    spaceAbove,
    spaceBelow,
  };
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
  const viewport = getViewportSize();
  const width = getPopupWidth(anchorRect.width, minWidth, maxWidth, viewport.width, viewportPadding);
  const left = getPopupLeft(anchorRect.left, width, viewport.width, viewportPadding);
  const { placeAbove, spaceAbove, spaceBelow } = getPlacement(anchorRect, estimatedHeight, viewport.height, gap, viewportPadding, preferredPlacement);
  const verticalPosition = placeAbove
    ? { bottom: viewport.height - anchorRect.top + gap }
    : { top: anchorRect.bottom + gap };

  return {
    position: "fixed",
    left,
    width,
    maxHeight: placeAbove ? spaceAbove : spaceBelow,
    ...verticalPosition,
  };
}
