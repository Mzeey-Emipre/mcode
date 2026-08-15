import { describe, it, expect } from "vitest";

/**
 * This test verifies that the wrapper div containing MessageList does not
 * have a `key` prop bound to the active thread id. A key like `key={activeThread.id}`
 * would cause React to destroy and remount the entire MessageList subtree on every
 * thread switch, destroying cached virtualizer state and forcing full re-renders.
 *
 * The fix is to remove the key entirely and let MessageList manage its own
 * per-thread state via useEffect on activeThreadId.
 *
 * We use a code-reader test that imports the source and checks for the absence
 * of the force-remount key pattern, which is a valid approach for structural tests.
 */
describe("ChatView — MessageList container", () => {
  it("does not have key={activeThread.id} on the wrapper div", async () => {
    // Import the source file as a string to verify the key is not present
    // We use import.meta.glob with raw imports to read the file content
    const module = import.meta.glob<string>("../ChatView.tsx", {
      query: "?raw",
      import: "default",
    });
    const files = await module["../ChatView.tsx"]?.();

    if (!files) {
      throw new Error("Unable to load ChatView.tsx for inspection");
    }

    // The wrapper should look like:
    // <div className="animate-fade-up-in flex-1 min-h-0">
    // And NOT:
    // <div key={activeThread.id} className="animate-fade-up-in flex-1 min-h-0">

    // Use [\s\S]* so a future multiline `key={activeThread.id}` wrapper
    // can't slip through this guard.
    const hasForceRemountKey = /key\s*=\s*\{\s*activeThread\.id\s*\}[\s\S]*className="animate-fade-up-in/.test(
      files
    );

    expect(hasForceRemountKey).toBe(false);

    // Also verify the comment explaining why is present
    const hasExplanationComment = /No `key` here[\s\S]*remount[\s\S]*virtualizer/.test(
      files
    );
    expect(hasExplanationComment).toBe(true);
  });
});
