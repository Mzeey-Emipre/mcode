import { describe, it, expect } from "vitest";
import { sanitizeBranchForFolder } from "../index.js";

describe("sanitizeBranchForFolder", () => {
  it("replaces slashes with hyphens", () => {
    expect(sanitizeBranchForFolder("fix/oauth-login")).toBe("fix-oauth-login");
  });

  it("replaces whitespace with hyphens", () => {
    expect(sanitizeBranchForFolder("feat/add user profiles")).toBe(
      "feat-add-user-profiles",
    );
  });

  it("lowercases the result", () => {
    expect(sanitizeBranchForFolder("Fix/OAuth-Login")).toBe("fix-oauth-login");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeBranchForFolder("foo--bar")).toBe("foo-bar");
  });

  it("strips leading hyphens", () => {
    expect(sanitizeBranchForFolder("-leading")).toBe("leading");
  });

  it("strips trailing hyphens", () => {
    expect(sanitizeBranchForFolder("trailing-")).toBe("trailing");
  });

  it("strips leading dots", () => {
    expect(sanitizeBranchForFolder(".dotfile")).toBe("dotfile");
  });

  it("replaces special characters with hyphens", () => {
    expect(sanitizeBranchForFolder("feat/add@user#profiles!")).toBe(
      "feat-add-user-profiles",
    );
  });

  it("handles a simple branch name with no special chars", () => {
    expect(sanitizeBranchForFolder("hotfix")).toBe("hotfix");
  });

  it("handles multiple slashes", () => {
    expect(sanitizeBranchForFolder("user/feat/thing")).toBe("user-feat-thing");
  });

  it("handles mixed special chars, whitespace, and slashes", () => {
    expect(sanitizeBranchForFolder("feat/my cool--feature!")).toBe(
      "feat-my-cool-feature",
    );
  });

  it("returns empty string for input that is all special chars", () => {
    expect(sanitizeBranchForFolder("///...")).toBe("");
  });
});
