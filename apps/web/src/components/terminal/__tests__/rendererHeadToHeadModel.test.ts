import { describe, expect, it } from "vitest";
import {
  compareRendererInputFrames,
  coalesceRendererResize,
  markerCoverage,
  RENDERER_CAPABILITY_MATRIX,
  restoreRendererViewportAnchor,
  rendererPercentile,
  summarizeRendererTimings,
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

  it("summarizes candidate timing tails without mutating samples", () => {
    const samples = [4, 1, 9, 3];
    expect(rendererPercentile(samples, 0.5)).toBe(3);
    expect(summarizeRendererTimings(samples)).toEqual({ p50Ms: 3, p95Ms: 9, p99Ms: 9, maxMs: 9 });
    expect(samples).toEqual([4, 1, 9, 3]);
  });

  it("rejects any frame sequence or byte mismatch between candidates", () => {
    const frames = [{ seq: 1, bytes: 3, digest: "a" }, { seq: 2, bytes: 5, digest: "b" }];
    expect(compareRendererInputFrames(frames, [...frames])).toBe(true);
    expect(compareRendererInputFrames(frames, [{ ...frames[0] }, { ...frames[1], bytes: 4 }])).toBe(false);
    expect(compareRendererInputFrames(frames, frames.slice(0, 1))).toBe(false);
  });

  it("keeps missing production capabilities as explicit failures", () => {
    expect(RENDERER_CAPABILITY_MATRIX.filter((row) => row.ghostty === "fail").map((row) => row.capability)).toEqual([
      "IME / dead keys",
      "Mouse protocol",
      "Selection / clipboard",
    ]);
  });
});
