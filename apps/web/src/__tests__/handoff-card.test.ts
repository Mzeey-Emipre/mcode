import { describe, it, expect } from "vitest";
import { parseHandoffJson, isHandoffMessage } from "@/components/chat/handoff-utils";

const sampleContent = `You are continuing work from a previous thread titled "Fix auth race condition".
The previous thread used claude-sonnet-4-6 on branch feature/auth-fix.

<!-- mcode-handoff
{
  "parentThreadId": "p-1",
  "parentTitle": "Fix auth race condition",
  "forkedFromMessageId": "msg-5",
  "sourceProvider": "claude",
  "sourceModel": "claude-sonnet-4-6",
  "sourceBranch": "feature/auth-fix",
  "sourceWorktreePath": "/src/mcode/.worktrees/auth-fix",
  "sourceHead": "abc1234",
  "recentFilesChanged": ["auth-service.ts"],
  "openTasks": [{"content": "Write tests", "status": "pending"}]
}
-->`;

describe("isHandoffMessage", () => {
  it("returns true for system messages with handoff marker", () => {
    expect(isHandoffMessage("system", sampleContent)).toBe(true);
  });

  it("returns false for user messages with handoff marker", () => {
    expect(isHandoffMessage("user", sampleContent)).toBe(false);
  });

  it("returns false for system messages without handoff marker", () => {
    expect(isHandoffMessage("system", "Context window compacted")).toBe(false);
  });
});

describe("parseHandoffJson", () => {
  it("extracts metadata from handoff content", () => {
    const result = parseHandoffJson(sampleContent);
    expect(result).not.toBeNull();
    expect(result!.parentTitle).toBe("Fix auth race condition");
    expect(result!.sourceModel).toBe("claude-sonnet-4-6");
    expect(result!.sourceBranch).toBe("feature/auth-fix");
    expect(result!.recentFilesChanged).toEqual(["auth-service.ts"]);
    expect(result!.openTasks).toHaveLength(1);
  });

  it("returns null for non-handoff content", () => {
    expect(parseHandoffJson("regular text")).toBeNull();
  });
});
