import { describe, expect, it } from "vitest";

import { shouldSetDockIcon } from "../dock-icon.js";

describe("shouldSetDockIcon", () => {
  it("returns false for packaged macOS", () => {
    expect(shouldSetDockIcon("darwin", true)).toBe(false);
  });

  it("returns true for macOS development", () => {
    expect(shouldSetDockIcon("darwin", false)).toBe(true);
  });

  it("returns false for non-macOS platforms", () => {
    expect(shouldSetDockIcon("win32", false)).toBe(false);
    expect(shouldSetDockIcon("linux", true)).toBe(false);
  });
});
