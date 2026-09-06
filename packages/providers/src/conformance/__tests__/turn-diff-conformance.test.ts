import { describe, expect, it } from "vitest";
import { nativeTurnDiffEvidence } from "../../private/codex/codex-provider.js";
import { CursorNativeTurnDiff } from "../../private/cursor/acp/cursor-native-turn-diff.js";

const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n";

describe("provider-neutral native diff conformance", () => {
  it("rejects malformed Codex evidence so the service can select fallback", () => {
    expect(nativeTurnDiffEvidence(42)).toEqual({ state: "rejected" });
  });
  it.each(["codex", "cursor"])("%s supplies the same complete aggregate", (provider) => {
    const evidence = provider === "codex"
      ? nativeTurnDiffEvidence(patch)
      : new CursorNativeTurnDiff().push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "before\n", newText: "after\n" }]);
    expect(evidence).toMatchObject({ state: "snapshot", patch });
  });

  it.each(["codex", "cursor"])("%s reports a net-zero turn without a partial patch", (provider) => {
    const cursor = new CursorNativeTurnDiff();
    cursor.push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "before\n", newText: "after\n" }]);
    const evidence = provider === "codex"
      ? nativeTurnDiffEvidence("")
      : cursor.push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "after\n", newText: "before\n" }]);
    expect(evidence).toEqual({ state: "indeterminate-empty" });
  });
});
