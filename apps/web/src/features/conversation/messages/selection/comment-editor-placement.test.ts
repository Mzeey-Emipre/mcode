import { describe, expect, it } from "vitest";
import { placeSelectedTextCommentEditor } from "./comment-editor-placement";

const viewport = { top: 0, right: 600, bottom: 400, left: 0 };

describe("placeSelectedTextCommentEditor", () => {
  it("uses an 8px gap below the final visible source rect when it fits", () => {
    expect(placeSelectedTextCommentEditor({
      viewport,
      source: { kind: "visible", rect: { top: 100, right: 260, bottom: 120, left: 120 } },
      preferredWidth: 328,
      editorHeight: 160,
    })).toEqual({ top: 128, left: 120, width: 328, maxHeight: 384, side: "below" });
  });

  it("uses the rendered shell height when placing above a source", () => {
    expect(placeSelectedTextCommentEditor({
      viewport,
      source: { kind: "visible", rect: { top: 370, right: 260, bottom: 390, left: 120 } },
      preferredWidth: 328,
      editorHeight: 46,
    })).toEqual({ top: 316, left: 120, width: 328, maxHeight: 384, side: "above" });
  });

  it("chooses the side with more space when neither side fits", () => {
    expect(placeSelectedTextCommentEditor({
      viewport,
      source: { kind: "visible", rect: { top: 80, right: 260, bottom: 100, left: 120 } },
      preferredWidth: 328,
      editorHeight: 360,
    })).toEqual({ top: 32, left: 120, width: 328, maxHeight: 384, side: "below" });
  });

  it("clamps an over-wide editor inside 8px transcript insets", () => {
    expect(placeSelectedTextCommentEditor({
      viewport: { top: 0, right: 300, bottom: 400, left: 0 },
      source: { kind: "visible", rect: { top: 100, right: 320, bottom: 120, left: 280 } },
      preferredWidth: 500,
      editorHeight: 160,
    })).toEqual({ top: 128, left: 8, width: 284, maxHeight: 384, side: "below" });
  });

  it("caps height to the visible viewport and docks the rendered shell eight pixels from either edge", () => {
    expect(placeSelectedTextCommentEditor({
      viewport: { top: 20, right: 600, bottom: 220, left: 0 },
      source: { kind: "docked", edge: "top" },
      preferredWidth: 328,
      editorHeight: 500,
    })).toEqual({ top: 28, left: 8, width: 328, maxHeight: 184, side: "docked-top" });

    expect(placeSelectedTextCommentEditor({
      viewport: { top: 20, right: 600, bottom: 220, left: 0 },
      source: { kind: "docked", edge: "bottom" },
      preferredWidth: 328,
      editorHeight: 46,
    })).toEqual({ top: 166, left: 8, width: 328, maxHeight: 184, side: "docked-bottom" });
  });
});
