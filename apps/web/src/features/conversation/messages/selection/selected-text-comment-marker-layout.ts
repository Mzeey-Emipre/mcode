/** A rectangle used to position a saved comment marker within the transcript. */
export interface SelectedTextCommentMarkerRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** A saved comment marker's source geometry before collision placement. */
export interface SelectedTextCommentMarkerAnchor {
  readonly commentId: string;
  readonly displayNumber: number;
  readonly sourceRect: SelectedTextCommentMarkerRect;
}

/** The visible transcript bounds that clamp saved comment markers. */
export interface SelectedTextCommentMarkerBounds {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** One placed saved comment marker. Input order stays the keyboard focus order. */
export interface SelectedTextCommentMarkerPosition {
  readonly commentId: string;
  readonly displayNumber: number;
  readonly top: number;
  readonly left: number;
}

const MARKER_SIZE = 32;
const MARKER_INSET = 4;
const MARKER_COLLISION_STEP = 24;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function markerBounds(bounds: SelectedTextCommentMarkerBounds) {
  const minimumTop = bounds.top + MARKER_INSET;
  const minimumLeft = bounds.left + MARKER_INSET;
  return {
    minimumTop,
    maximumTop: Math.max(minimumTop, bounds.bottom - MARKER_INSET - MARKER_SIZE),
    minimumLeft,
    maximumLeft: Math.max(minimumLeft, bounds.right - MARKER_INSET - MARKER_SIZE),
  };
}

function markersOverlap(
  left: number,
  top: number,
  marker: SelectedTextCommentMarkerPosition,
): boolean {
  return Math.abs(marker.left - left) < MARKER_SIZE && Math.abs(marker.top - top) < MARKER_SIZE;
}

/** Returns collision offsets in the required base, positive, negative sequence. */
export function selectedTextCommentMarkerOffsets(count: number): number[] {
  const offsets = [0];
  for (let step = 1; step <= count; step += 1) {
    offsets.push(step * MARKER_COLLISION_STEP, -step * MARKER_COLLISION_STEP);
  }
  return offsets;
}

/** Places one marker per anchor without changing the input's creation order. */
export function placeSelectedTextCommentMarkers(
  anchors: readonly SelectedTextCommentMarkerAnchor[],
  bounds: SelectedTextCommentMarkerBounds,
): SelectedTextCommentMarkerPosition[] {
  const markerArea = markerBounds(bounds);
  const markers: SelectedTextCommentMarkerPosition[] = [];

  for (const anchor of anchors) {
    const baseLeft = clamp(
      anchor.sourceRect.right - MARKER_SIZE / 2,
      markerArea.minimumLeft,
      markerArea.maximumLeft,
    );
    const baseTop = clamp(
      anchor.sourceRect.top + Math.min(anchor.sourceRect.height / 2, MARKER_SIZE / 2) - MARKER_SIZE / 2,
      markerArea.minimumTop,
      markerArea.maximumTop,
    );
    const candidates = selectedTextCommentMarkerOffsets(markers.length + 1);
    const top = candidates
      .map((offset) => clamp(baseTop + offset, markerArea.minimumTop, markerArea.maximumTop))
      .find((candidate) => !markers.some((marker) => markersOverlap(baseLeft, candidate, marker)))
      ?? baseTop;
    markers.push({
      commentId: anchor.commentId,
      displayNumber: anchor.displayNumber,
      left: baseLeft,
      top,
    });
  }

  return markers;
}

/** Returns whether this saved comment's source highlight receives the active treatment. */
export function isSelectedTextCommentHighlightActive(
  commentId: string,
  activeCommentId: string | null,
): boolean {
  return commentId === activeCommentId;
}
