import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { WorktreeRepo } from "../repositories/worktree-repo.js";

describe("WorktreeRepo", () => {
  it("keeps an opaque identity stable and marks absent registrations stale", () => {
    const db = openMemoryDatabase();
    const workspaces = new WorkspaceRepo(db);
    const worktrees = new WorktreeRepo(db);
    const workspace = workspaces.create("Workspace", "/repo");
    const first = worktrees.reconcile(workspace.id, [{
      canonicalPath: "/repo/.worktrees/feature",
      label: "feature",
      branch: "feature",
      managed: true,
    }]);
    const second = worktrees.reconcile(workspace.id, [{
      canonicalPath: "/repo/.worktrees/feature",
      label: "feature",
      branch: "feature",
      managed: true,
    }]);
    expect(second[0]?.worktreeId).toBe(first[0]?.worktreeId);
    expect(Object.keys(second[0] ?? {})).not.toContain("canonicalPath");
    expect(worktrees.reconcile(workspace.id, [])).toEqual([]);
    db.close();
  });
});
