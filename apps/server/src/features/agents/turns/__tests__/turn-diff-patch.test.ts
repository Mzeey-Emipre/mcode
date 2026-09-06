import { describe, expect, it } from "vitest";
import { parseTurnDiff, TURN_DIFF_MAX_BYTES, TURN_DIFF_MAX_LINE_BYTES, TURN_DIFF_MAX_LINES } from "../turn-diff-patch.js";

const patch = "diff --git a/a file.txt b/a file.txt\nindex abc..def\n--- a/a file.txt\n+++ b/a file.txt\n@@ -1 +1 @@\n-before\n+after\n";

describe("parseTurnDiff", () => {
  it("accepts exactly 2097152 UTF-8 bytes and rejects one additional byte without truncation", () => {
    const header = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,128 @@\n";
    const prefix = header + ("+" + "x".repeat(16382) + "\n").repeat(127);
    const exact = prefix + "+" + "x".repeat(TURN_DIFF_MAX_BYTES - prefix.length - 2) + "\n";
    expect(Buffer.byteLength(exact)).toBe(2_097_152);
    expect(parseTurnDiff(exact)?.additions).toBe(128);
    expect(parseTurnDiff(exact.slice(0, -1) + "x\n")).toBeNull();
  });
  it("parses complete native text with spaces and derives exact Review metadata", () => {
    const result = parseTurnDiff(patch);
    expect(result?.files).toEqual([{ path: "a file.txt", previousPath: null, binary: false, changeType: "modified" }]);
    expect([result?.additions, result?.deletions]).toEqual([1, 1]);
    expect(result?.filePatches.get("a file.txt")).toBe(patch);
    expect(parseTurnDiff(patch.trimEnd())?.filePatches.get("a file.txt")).toBe(patch);
  });

  it("accepts the native add and delete forms", () => {
    const added = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 000..abc\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n";
    const deleted = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex abc..000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
    const result = parseTurnDiff(added + deleted);
    expect(result?.files.map(({ path, changeType }) => ({ path, changeType }))).toEqual([{ path: "new.txt", changeType: "added" }, { path: "old.txt", changeType: "deleted" }]);
    expect([result?.additions, result?.deletions]).toEqual([1, 1]);
  });

  it.each([
    patch + "unvalidated trailing data",
    patch.replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
    patch.replace("+++ b/a file.txt", "+++ b/other.txt"),
    patch.replaceAll("a file.txt", "../escape.txt"),
    patch.replace("-before\n+after", "Binary files differ"),
    patch + patch,
    patch + "\n".repeat(TURN_DIFF_MAX_LINES),
    patch.replace("+after", "+" + "a".repeat(TURN_DIFF_MAX_LINE_BYTES)),
  ])("rejects the whole malformed or bounded-out aggregate", (input) => {
    expect(parseTurnDiff(input)).toBeNull();
  });
});
