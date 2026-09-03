import { describe, expect, it } from "vitest";
import { sourceEdgeAfterScrollDeparture } from "./SelectedTextCommentControls";

describe("sourceEdgeAfterScrollDeparture", () => {
  it("docks an unmounted source across large uneven virtual-content jumps without message-index ratios", () => {
    expect(sourceEdgeAfterScrollDeparture({
      lastVisibleScrollTop: 1_000,
      lastDockedEdge: "bottom",
      isDocked: false,
    }, 80_000)).toBe("top");
    expect(sourceEdgeAfterScrollDeparture({
      lastVisibleScrollTop: 9_000,
      lastDockedEdge: "top",
      isDocked: false,
    }, 4_000)).toBe("bottom");
  });

  it("retains the semantic edge after the source is already docked", () => {
    expect(sourceEdgeAfterScrollDeparture({
      lastVisibleScrollTop: 1_000,
      lastDockedEdge: "bottom",
      isDocked: true,
    }, 9_000)).toBe("bottom");
  });
});
