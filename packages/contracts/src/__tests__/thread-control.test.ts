import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SEARCH_LIMIT_DEFAULT,
  WorkspaceSearchInputSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
} from "../thread-control.js";

describe("thread control discovery schemas", () => {
  it("bounds and defaults workspace search without accepting authority fields", () => {
    expect(WorkspaceSearchInputSchema().parse({})).toEqual({ limit: WORKSPACE_SEARCH_LIMIT_DEFAULT });
    expect(WorkspaceSearchInputSchema().safeParse({ limit: 51 }).success).toBe(false);
    expect(WorkspaceSearchInputSchema().safeParse({ sourceThreadId: "forged" }).success).toBe(false);
  });

  it("rejects forged fields and raw paths in worktree discovery payloads", () => {
    expect(WorktreeListInputSchema().safeParse({ workspaceId: "workspace", path: "C:/secret" }).success).toBe(false);
    expect(WorktreeListResultSchema().safeParse({
      status: "found", workspaceId: "workspace", worktrees: [{ worktreeId: "worktree", label: "main", path: "C:/secret" }],
    }).success).toBe(false);
  });
});
