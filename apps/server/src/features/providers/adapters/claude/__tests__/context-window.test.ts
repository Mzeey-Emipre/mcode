/**
 * Tests for the SDK 0.3.x context-window overrides.
 *
 * The 0.3.x CLI treats 1M-capable models as natively 1M-context, so without
 * an autoCompactWindow override a standard-mode session never compacts before
 * the 200k tier rejects the request, and the reported contextWindow inflates
 * the UI ring to the 1M ceiling.
 */

import { describe, it, expect } from "vitest";
import {
  STANDARD_CONTEXT_WINDOW_TOKENS,
  resolveAutoCompactWindow,
  clampContextWindowToMode,
} from "../context-window.js";

describe("resolveAutoCompactWindow", () => {
  it("pins the auto-compact window to 200k in standard mode", () => {
    expect(resolveAutoCompactWindow("200k", "claude-sonnet-4-6")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("pins the auto-compact window to 200k when the mode is unspecified", () => {
    expect(resolveAutoCompactWindow(undefined, "claude-sonnet-4-6")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("sends no override in 1M mode for a 1M-capable model", () => {
    expect(resolveAutoCompactWindow("1m", "claude-sonnet-4-6")).toBeUndefined();
  });

  it("still pins to 200k in 1M mode when the model does not support extended context", () => {
    expect(resolveAutoCompactWindow("1m", "claude-haiku-4-5")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
  });
});

describe("clampContextWindowToMode", () => {
  it("clamps the SDK's 1M capability ceiling to 200k in standard mode", () => {
    expect(clampContextWindowToMode(1_000_000, "200k", "claude-sonnet-4-6")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
    expect(clampContextWindowToMode(1_000_000, undefined, "claude-sonnet-4-6")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("passes 200k-and-below values through unchanged", () => {
    expect(clampContextWindowToMode(200_000, "200k", "claude-sonnet-4-6")).toBe(200_000);
    expect(clampContextWindowToMode(180_000, undefined, "claude-sonnet-4-6")).toBe(180_000);
  });

  it("passes the reported window through unchanged in 1M mode for a 1M-capable model", () => {
    expect(clampContextWindowToMode(1_000_000, "1m", "claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("clamps in 1M mode when the model does not support extended context", () => {
    expect(clampContextWindowToMode(1_000_000, "1m", "claude-haiku-4-5")).toBe(
      STANDARD_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("returns undefined when the SDK reported no window", () => {
    expect(clampContextWindowToMode(undefined, "200k", "claude-sonnet-4-6")).toBeUndefined();
    expect(clampContextWindowToMode(undefined, "1m", "claude-sonnet-4-6")).toBeUndefined();
  });
});
