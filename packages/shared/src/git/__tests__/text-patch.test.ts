import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { createTextPatch } from "../text-patch.js";

describe("createTextPatch", () => {
  it.each([
    ["middle insertion", "a\nc\n", "a\nb\nc\n"],
    ["middle deletion", "a\nb\nc\n", "a\nc\n"],
    ["final newline added", "a", "a\n"],
    ["final newline removed", "a\n", "a"],
    ["line change and newline removal", "a\nb\n", "c\nb"],
    ["line change and newline addition", "a\nb", "c\nb\n"],
    ["existing empty file", "", "text\n"],
    ["emptying a file", "text\n", ""],
  ])("round trips %s", (_name, before, after) => {
    const patch = createTextPatch("a.txt", before, after);
    expect(patch).not.toBeUndefined();
    expect(applyPatch(before, patch!)).toBe(after);
    expect(patch).not.toContain("/dev/null");
  });

  it("marks file creation explicitly", () => {
    const patch = createTextPatch("a.txt", "", "new\n", "added");
    expect(patch).toContain("--- /dev/null");
    expect(applyPatch("", patch!)).toBe("new\n");
  });

  it("marks removal explicitly", () => {
    const patch = createTextPatch("a.txt", "old\n", "", "removed");
    expect(patch).toContain("+++ /dev/null");
    expect(applyPatch("old\n", patch!)).toBe("");
  });

  it("rejects oversized contents and patch-header injection", () => {
    expect(createTextPatch("a.txt", "x".repeat(2_097_153), "")).toBeUndefined();
    expect(createTextPatch("a.txt\n+++ b/evil", "a", "b")).toBeUndefined();
  });
});
