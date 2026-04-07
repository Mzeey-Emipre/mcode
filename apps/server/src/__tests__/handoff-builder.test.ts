import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  buildHandoffContent,
  buildConversationReplay,
  parseHandoffJson,
  replayBudgetChars,
  HANDOFF_MARKER,
} from "../services/handoff-builder.js";
import type { Thread, Message } from "@mcode/contracts";

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

// Helper to create minimal Message fixtures without the full DB layer.
function makeMsg(
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  seq = 1,
): Message {
  return {
    id,
    thread_id: "t-1",
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-04-08T00:00:00Z",
    sequence: seq,
    attachments: null,
  };
}

describe("buildConversationReplay", () => {
  it("returns empty string for empty message list", () => {
    expect(buildConversationReplay([], 100_000)).toBe("");
  });

  it("skips system messages", () => {
    const msgs = [
      makeMsg("1", "system", "You are an agent"),
      makeMsg("2", "user", "Fix the bug"),
      makeMsg("3", "assistant", "I fixed it"),
    ];
    const result = buildConversationReplay(msgs, 100_000);
    expect(result).not.toContain("You are an agent");
    expect(result).toContain("User: Fix the bug");
    expect(result).toContain("Assistant: I fixed it");
  });

  it("formats turns as 'User: ...' and 'Assistant: ...'", () => {
    const msgs = [
      makeMsg("1", "user", "Hello"),
      makeMsg("2", "assistant", "World"),
    ];
    const result = buildConversationReplay(msgs, 100_000);
    expect(result).toBe("User: Hello\n\nAssistant: World");
  });

  it("omits oldest turns when over budget and notes the omission", () => {
    const msgs = [
      makeMsg("1", "user", "First turn"),
      makeMsg("2", "assistant", "First response"),
      makeMsg("3", "user", "Second turn"),
      makeMsg("4", "assistant", "Second response"),
    ];
    // Budget just enough for the last two turns
    const budget = "User: Second turn\n\nAssistant: Second response".length + 10;
    const result = buildConversationReplay(msgs, budget);
    expect(result).toContain("[2 earlier messages omitted]");
    expect(result).toContain("User: Second turn");
    expect(result).toContain("Assistant: Second response");
    expect(result).not.toContain("First turn");
  });

  it("uses plural 'messages' for multiple omitted turns", () => {
    const msgs = [
      makeMsg("1", "user", "First"),
      makeMsg("2", "user", "Second"),
      makeMsg("3", "user", "Third"),
    ];
    const budget = "User: Third".length + 5;
    const result = buildConversationReplay(msgs, budget);
    expect(result).toContain("[2 earlier messages omitted]");
  });

  it("uses singular 'message' for exactly 1 omitted turn", () => {
    const msgs = [
      makeMsg("1", "user", "First"),
      makeMsg("2", "user", "Second"),
    ];
    // Budget only fits "Second"
    const budget = "User: Second".length + 5;
    const result = buildConversationReplay(msgs, budget);
    expect(result).toContain("[1 earlier message omitted]");
    expect(result).not.toContain("[1 earlier messages omitted]");
  });

  it("truncates if even the latest turn exceeds budget", () => {
    const msgs = [makeMsg("1", "user", "A".repeat(200))];
    const result = buildConversationReplay(msgs, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("replayBudgetChars", () => {
  it("returns 120000 for claude models", () => {
    expect(replayBudgetChars("claude-sonnet-4-6")).toBe(120_000);
    expect(replayBudgetChars("claude-opus-4-6")).toBe(120_000);
  });

  it("returns 100000 for unknown models", () => {
    expect(replayBudgetChars("some-future-model")).toBe(100_000);
  });
});

describe("parseHandoffJson - --> inside JSON values", () => {
  it("still parses when a JSON string contains -->", () => {
    const metadata = {
      parentThreadId: "p-1",
      parentTitle: "A --> B migration",
      forkedFromMessageId: "msg-1",
      sourceProvider: "claude",
      sourceModel: null,
      sourceBranch: "main",
      sourceWorktreePath: null,
      sourceHead: null,
      recentFilesChanged: [],
      openTasks: [{ content: "migrate A --> B", status: "pending" }],
    };
    const content = `${HANDOFF_MARKER}\n${JSON.stringify(metadata, null, 2)}\n-->`;
    const parsed = parseHandoffJson(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.parentTitle).toBe("A --> B migration");
    expect(parsed!.openTasks[0].content).toBe("migrate A --> B");
  });
});
