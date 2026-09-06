import { describe, expect, it } from "vitest";
import { CursorNativeTurnDiff } from "../cursor-native-turn-diff.js";

const cwd = "/workspace";

describe("CursorNativeTurnDiff", () => {
  it("falls back for metadata-only empty-file creation instead of claiming net-zero", () => {
    expect(new CursorNativeTurnDiff().push(cwd, [{ type: "diff", path: "empty.txt", oldText: null, newText: "" }])).toEqual({ state: "rejected" });
  });
  it("retains initial ACP blocks until a content-free successful completion", () => {
    const diff = new CursorNativeTurnDiff();
    expect(diff.observe(cwd, { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "a.txt", oldText: "a\n", newText: "b\n" }] })).toBeNull();
    expect(diff.observe(cwd, { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" })).toMatchObject({ state: "snapshot", patch: expect.stringContaining("-a\n+b\n") });
  });

  it("rejects a partial aggregate when another successful edit has no full evidence", () => {
    const diff = new CursorNativeTurnDiff();
    diff.push(cwd, [{ type: "diff", path: "a.txt", oldText: "a", newText: "b" }]);
    diff.observe(cwd, { sessionUpdate: "tool_call", toolCallId: "missing", title: "Edit", kind: "edit", status: "in_progress" });
    expect(diff.observe(cwd, { sessionUpdate: "tool_call_update", toolCallId: "missing", status: "completed" })).toEqual({ state: "rejected" });
  });

  it("does not admit a failed tool's proposed blocks", () => {
    const diff = new CursorNativeTurnDiff();
    diff.observe(cwd, { sessionUpdate: "tool_call", toolCallId: "failed", title: "Edit", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "a.txt", oldText: "a", newText: "b" }] });
    expect(diff.observe(cwd, { sessionUpdate: "tool_call_update", toolCallId: "failed", status: "failed" })).toBeNull();
    expect(diff.push(cwd, [{ type: "diff", path: "a.txt", oldText: "a", newText: "c" }])).toMatchObject({ state: "snapshot", patch: expect.stringContaining("+c\n") });
  });
  it.each([
    { type: "diff", oldText: "a", newText: "b" },
    { type: "diff", path: "a.txt", oldText: 42, newText: "b" },
    { type: "diff", path: "a.txt", oldText: "a", newText: "x".repeat(2_097_153) },
  ])("rejects a complete batch containing unusable evidence", (invalid) => {
    const diff = new CursorNativeTurnDiff();
    expect(diff.push(cwd, [{ type: "diff", path: "valid.txt", oldText: "a", newText: "b" }, invalid])).toEqual({ state: "rejected" });
    expect(diff.push(cwd, [{ type: "diff", path: "valid.txt", oldText: "b", newText: "c" }])).toEqual({ state: "rejected" });
  });

  it("distinguishes creation from an existing empty file", () => {
    const created = new CursorNativeTurnDiff().push(cwd, [{ type: "diff", path: "a.txt", oldText: null, newText: "new\n" }]);
    const edited = new CursorNativeTurnDiff().push(cwd, [{ type: "diff", path: "a.txt", oldText: "", newText: "new\n" }]);
    expect(created).toMatchObject({ state: "snapshot", patch: expect.stringContaining("--- /dev/null") });
    expect(edited).toMatchObject({ state: "snapshot", patch: expect.stringContaining("--- a/a.txt") });
  });
  it("keeps the first before state and latest after state for repeated ACP edits", () => {
    const diff = new CursorNativeTurnDiff();
    diff.push(cwd, [{ type: "diff", path: "src/a.ts", oldText: "const value = 1;\n", newText: "const value = 2;\n" }]);
    const patch = diff.push(cwd, [{ type: "diff", path: "src/a.ts", oldText: "const value = 2;\n", newText: "const value = 3;\n" }]);

    expect(patch).toMatchObject({ state: "snapshot", patch: expect.stringContaining("-const value = 1;\n+const value = 3;\n") });
  });

  it("rejects an outside-workspace path without emitting a partial patch", () => {
    const diff = new CursorNativeTurnDiff();
    expect(diff.push(cwd, [{ type: "diff", path: "src/a.ts", oldText: "a\n", newText: "b\n" }])).toMatchObject({ state: "snapshot" });
    expect(diff.push(cwd, [{ type: "diff", path: "../outside.ts", oldText: "a\n", newText: "b\n" }])).toEqual({ state: "rejected" });
    expect(diff.push(cwd, [{ type: "diff", path: "src/b.ts", oldText: "a\n", newText: "b\n" }])).toEqual({ state: "rejected" });
  });

  it("drops net-zero edits instead of showing every unchanged line as a replacement", () => {
    const diff = new CursorNativeTurnDiff();
    expect(diff.push(cwd, [{ type: "diff", path: "a.ts", oldText: "same\n", newText: "changed\n" }])).toMatchObject({ state: "snapshot" });
    expect(diff.push(cwd, [{ type: "diff", path: "a.ts", oldText: "changed\n", newText: "same\n" }])).toEqual({ state: "indeterminate-empty" });
  });

  it.each([
    ["middle insertion", "a\nc\n", "a\nb\nc\n", " a\n+b\n c\n"],
    ["middle deletion", "a\nb\nc\n", "a\nc\n", " a\n-b\n c\n"],
    ["final newline added", "a", "a\n", "-a\n\\ No newline at end of file\n+a\n"],
    ["final newline removed", "a\n", "a", "-a\n+a\n\\ No newline at end of file\n"],
  ])("serializes %s with valid hunk anchors and EOF markers", (_name, before, after, expected) => {
    const result = new CursorNativeTurnDiff().push(cwd, [{ type: "diff", path: "a.txt", oldText: before, newText: after }]);
    expect(result).toMatchObject({ state: "snapshot", patch: expect.stringContaining(expected) });
  });

  it("rejects a repeated ACP edit when its before state is discontinuous", () => {
    const diff = new CursorNativeTurnDiff();
    diff.push(cwd, [{ type: "diff", path: "a.txt", oldText: "a\n", newText: "b\n" }]);
    expect(diff.push(cwd, [{ type: "diff", path: "a.txt", oldText: "external\n", newText: "c\n" }])).toEqual({ state: "rejected" });
  });
});
