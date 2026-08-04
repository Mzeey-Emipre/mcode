import { describe, expect, it } from "vitest";
import {
  coalesceRendererResize,
  markerCoverage,
  restoreRendererViewportAnchor,
} from "../rendererHeadToHeadModel";

describe("renderer head-to-head model", () => {
  it("keeps only the latest bounded resize request", () => {
    expect(
      coalesceRendererResize([
        { cols: 80, rows: 24, requestedAt: 1 },
        { cols: 500, rows: 0, requestedAt: 2 },
      ]),
    ).toEqual({ cols: 140, rows: 1, requestedAt: 2 });
  });

  it("restores tail-following and scrolled-back anchors independently", () => {
    expect(
      restoreRendererViewportAnchor(
        { linesFromBottom: 0, followingTail: true },
        100,
        24,
      ),
    ).toBe(76);
    expect(
      restoreRendererViewportAnchor(
        { linesFromBottom: 12, followingTail: false },
        100,
        24,
      ),
    ).toBe(64);
  });

  it("reports marker coverage without treating duplicate markers as extra credit", () => {
    expect(markerCoverage("ready ready done", ["ready", "done"])).toBe(1);
    expect(markerCoverage("ready", ["ready", "done"])).toBe(0.5);
  });
});
