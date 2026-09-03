import { describe, expect, it } from "vitest";
import {
  isSelectedTextCommentHighlightActive,
  placeSelectedTextCommentMarkers,
  selectedTextCommentMarkerOffsets,
} from "./selected-text-comment-marker-layout";

const bounds = { top: 0, right: 200, bottom: 120, left: 0 };
const sourceRect = { top: 20, right: 80, bottom: 40, left: 20, width: 60, height: 20 };

describe("selected-text comment marker layout", () => {
  it("uses the exact collision-candidate sequence", () => {
    expect(selectedTextCommentMarkerOffsets(3)).toEqual([0, 24, -24, 48, -48, 72, -72]);
  });

  it("keeps creation order while assigning dense colliding markers", () => {
    const markers = placeSelectedTextCommentMarkers([
      { commentId: "one", displayNumber: 1, sourceRect },
      { commentId: "two", displayNumber: 2, sourceRect },
      { commentId: "three", displayNumber: 3, sourceRect },
    ], bounds);

    expect(markers.map((marker) => marker.commentId)).toEqual(["one", "two", "three"]);
    expect(markers.map((marker) => marker.top)).toEqual([14, 62, 14]);
  });

  it("clamps every marker and retains markers when clamping leaves an overlap", () => {
    const markers = placeSelectedTextCommentMarkers([
      { commentId: "one", displayNumber: 1, sourceRect: { ...sourceRect, top: 0, bottom: 20 } },
      { commentId: "two", displayNumber: 2, sourceRect: { ...sourceRect, top: 0, bottom: 20 } },
      { commentId: "three", displayNumber: 3, sourceRect: { ...sourceRect, top: 0, bottom: 20 } },
    ], { top: 0, right: 80, bottom: 38, left: 0 });

    expect(markers).toHaveLength(3);
    expect(markers.map((marker) => marker.top)).toEqual([4, 4, 4]);
    expect(markers.every((marker) => marker.left >= 4 && marker.left <= 44)).toBe(true);
  });

  it("activates only the linked source highlight", () => {
    expect(isSelectedTextCommentHighlightActive("one", "one")).toBe(true);
    expect(isSelectedTextCommentHighlightActive("two", "one")).toBe(false);
  });
});
