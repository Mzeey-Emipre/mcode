import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { buildHandoffContent, parseHandoffJson, HANDOFF_MARKER } from "../services/handoff-builder.js";
import type { Thread } from "@mcode/contracts";

const baseThread: Thread = {
  id: "parent-1",
  workspace_id: "ws-1",
  title: "Fix auth race condition",
  status: "active",
  mode: "worktree",
  worktree_path: "/src/mcode/.worktrees/auth-fix",
  branch: "feature/auth-fix",
  worktree_managed: true,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: "sdk-123",
  model: "claude-sonnet-4-6",
  provider: "claude",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-07T00:00:00Z",
  deleted_at: null,
  last_context_tokens: 50000,
  context_window: 200000,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

describe("buildHandoffContent", () => {
  it("produces prose header with parent title", () => {
    const result = buildHandoffContent({
      parentThread: baseThread,
      forkMessageId: "msg-5",
      lastAssistantText: "I fixed the race condition in auth-service.ts.",
      recentFilesChanged: ["apps/server/src/services/auth-service.ts"],
      openTasks: [],
      sourceHead: "abc1234",
    });

    expect(result).toContain('previous thread titled "Fix auth race condition"');
    expect(result).toContain("claude-sonnet-4-6");
    expect(result).toContain("feature/auth-fix");
  });

  it("includes last assistant text truncated to 2000 chars", () => {
    const longText = "x".repeat(3000);
    const result = buildHandoffContent({
      parentThread: baseThread,
      forkMessageId: "msg-5",
      lastAssistantText: longText,
      recentFilesChanged: [],
      openTasks: [],
      sourceHead: null,
    });

    const proseEnd = result.indexOf("<!-- mcode-handoff");
    const prose = result.slice(0, proseEnd);
    expect(prose.length).toBeLessThan(2500);
  });

  it("embeds parseable mcode-handoff JSON in HTML comment", () => {
    const result = buildHandoffContent({
      parentThread: baseThread,
      forkMessageId: "msg-5",
      lastAssistantText: "Done.",
      recentFilesChanged: ["file-a.ts"],
      openTasks: [{ content: "Write tests", status: "pending" }],
      sourceHead: "abc1234",
    });

    const parsed = parseHandoffJson(result);
    expect(parsed).not.toBeNull();
    expect(parsed!.parentThreadId).toBe("parent-1");
    expect(parsed!.parentTitle).toBe("Fix auth race condition");
    expect(parsed!.forkedFromMessageId).toBe("msg-5");
    expect(parsed!.sourceProvider).toBe("claude");
    expect(parsed!.sourceModel).toBe("claude-sonnet-4-6");
    expect(parsed!.sourceBranch).toBe("feature/auth-fix");
    expect(parsed!.recentFilesChanged).toEqual(["file-a.ts"]);
    expect(parsed!.openTasks).toHaveLength(1);
    expect(parsed!.sourceHead).toBe("abc1234");
  });

  it("handles missing optional fields gracefully", () => {
    const minThread = { ...baseThread, model: null, worktree_path: null, mode: "direct" as const };
    const result = buildHandoffContent({
      parentThread: minThread,
      forkMessageId: "msg-1",
      lastAssistantText: null,
      recentFilesChanged: [],
      openTasks: [],
      sourceHead: null,
    });

    expect(result).toContain("Fix auth race condition");
    const parsed = parseHandoffJson(result);
    expect(parsed).not.toBeNull();
    expect(parsed!.sourceModel).toBeNull();
  });
});

describe("parseHandoffJson", () => {
  it("returns null for non-handoff content", () => {
    expect(parseHandoffJson("just a regular message")).toBeNull();
  });

  it("returns null for malformed JSON in handoff block", () => {
    expect(parseHandoffJson("<!-- mcode-handoff\n{invalid json\n-->")).toBeNull();
  });
});

describe("HANDOFF_MARKER", () => {
  it("matches the expected marker string", () => {
    expect(HANDOFF_MARKER).toBe("<!-- mcode-handoff");
  });
});
