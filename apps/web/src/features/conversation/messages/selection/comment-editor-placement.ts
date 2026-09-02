/** A viewport-relative rectangle used to place the selected-text comment editor. */
export interface CommentEditorPlacementRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** The visible source state used to place an open selected-text comment editor. */
export type CommentEditorSourcePosition =
  | { readonly kind: "visible"; readonly rect: CommentEditorPlacementRect }
  | { readonly kind: "docked"; readonly edge: "top" | "bottom" };

/** The bounded coordinates and dimensions for an open selected-text comment editor. */
export interface CommentEditorPlacement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly side: "above" | "below" | "docked-top" | "docked-bottom";
}

const TRANSCRIPT_INSET = 8;
const MAX_EDITOR_WIDTH = 328;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Places an editor from the current source geometry within the transcript viewport.
 *
 * The editor belongs below the final visible source rect when it fits, then above it.
 * When neither side fits, the side with more room remains associated with the source
 * while transcript bounds keep the editor visible.
 */
export function placeSelectedTextCommentEditor({
  viewport,
  source,
  preferredWidth,
  editorHeight,
}: {
  readonly viewport: CommentEditorPlacementRect;
  readonly source: CommentEditorSourcePosition;
  readonly preferredWidth: number;
  readonly editorHeight: number;
}): CommentEditorPlacement {
  const viewportWidth = Math.max(0, viewport.right - viewport.left);
  const viewportHeight = Math.max(0, viewport.bottom - viewport.top);
  const width = Math.min(MAX_EDITOR_WIDTH, preferredWidth, Math.max(0, viewportWidth - TRANSCRIPT_INSET * 2));
  const maxHeight = Math.max(0, viewportHeight - TRANSCRIPT_INSET * 2);
  const height = Math.min(Math.max(0, editorHeight), maxHeight);
  const minimumLeft = viewport.left + TRANSCRIPT_INSET;
  const maximumLeft = viewport.right - TRANSCRIPT_INSET - width;
  const minimumTop = viewport.top + TRANSCRIPT_INSET;
  const maximumTop = viewport.bottom - TRANSCRIPT_INSET - height;

  if (source.kind === "docked") {
    return {
      left: clamp(viewport.left + TRANSCRIPT_INSET, minimumLeft, maximumLeft),
      top: source.edge === "top" ? minimumTop : maximumTop,
      width,
      maxHeight,
      side: source.edge === "top" ? "docked-top" : "docked-bottom",
    };
  }

  const left = clamp(source.rect.left, minimumLeft, maximumLeft);
  const belowTop = source.rect.bottom + TRANSCRIPT_INSET;
  const aboveTop = source.rect.top - TRANSCRIPT_INSET - height;
  const belowFits = belowTop + height <= viewport.bottom - TRANSCRIPT_INSET;
  const aboveFits = aboveTop >= minimumTop;

  if (belowFits) return { top: belowTop, left, width, maxHeight, side: "below" };
  if (aboveFits) return { top: aboveTop, left, width, maxHeight, side: "above" };

  const belowSpace = viewport.bottom - source.rect.bottom - TRANSCRIPT_INSET;
  const aboveSpace = source.rect.top - viewport.top - TRANSCRIPT_INSET;
  const side = belowSpace >= aboveSpace ? "below" : "above";
  return {
    top: clamp(side === "below" ? belowTop : aboveTop, minimumTop, maximumTop),
    left,
    width,
    maxHeight,
    side,
  };
}
