import { describe, it, expect } from "vitest";
import { isPrable } from "../is-prable";

describe("isPrable", () => {
  it("returns true for a worktree-mode thread", () => {
    expect(isPrable({ mode: "worktree" })).toBe(true);
  });

  it("returns false for a direct-mode thread", () => {
    expect(isPrable({ mode: "direct" })).toBe(false);
  });
});
