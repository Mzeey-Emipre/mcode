import { describe, expect, it } from "vitest";
import { resolveThreadCheckoutLabel } from "../checkout-label";

describe("resolveThreadCheckoutLabel", () => {
  it("returns a named branch", () => {
    expect(resolveThreadCheckoutLabel({ branch: "feat/x", checkout_state: "named" })).toBe("feat/x");
  });

  it("returns HEAD for a branchless checkout with a base branch", () => {
    expect(resolveThreadCheckoutLabel({ branch: "main", checkout_state: "branchless" })).toBe("HEAD");
  });

  it("returns HEAD when the branch value is HEAD", () => {
    expect(resolveThreadCheckoutLabel({ branch: "HEAD", checkout_state: "named" })).toBe("HEAD");
  });

  it("falls back to HEAD for an empty branch", () => {
    expect(resolveThreadCheckoutLabel({ branch: "", checkout_state: "named" })).toBe("HEAD");
  });
});
