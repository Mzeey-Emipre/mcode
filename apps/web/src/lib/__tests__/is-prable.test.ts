import { describe, it, expect } from "vitest";
import { isPrable } from "../is-prable";

describe("isPrable", () => {
  it("returns true for a worktree-mode thread", () => {
    expect(isPrable({ mode: "worktree", checkout_state: "named" })).toBe(true);
  });

  it("returns false for a direct-mode thread", () => {
    expect(isPrable({ mode: "direct", checkout_state: "named" })).toBe(false);
  });

  it("returns false for a branchless worktree thread", () => {
    expect(isPrable({ mode: "worktree", checkout_state: "branchless" })).toBe(false);
  });
});
