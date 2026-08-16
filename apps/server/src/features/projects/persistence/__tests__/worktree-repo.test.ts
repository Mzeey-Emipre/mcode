import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../workspace-repo.js";
import { STALE_WORKTREE_RETENTION_DAYS, WorktreeRepo } from "../worktree-repo.js";

describe("WorktreeRepo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("retains stale registrations through the cutoff and gives a purged path a new identity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const db = openMemoryDatabase();
    const workspaces = new WorkspaceRepo(db);
    const worktrees = new WorktreeRepo(db);
    const workspace = workspaces.create("Workspace", "/repo");
    const input = {
      canonicalPath: "/repo/.worktrees/feature",
      label: "feature",
      branch: "feature",
      managed: true,
    };
    const originalId = worktrees.reconcile(workspace.id, [input])[0]?.worktreeId;

    vi.advanceTimersByTime(STALE_WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    worktrees.reconcile(workspace.id, []);
    expect(worktrees.reconcile(workspace.id, [input])[0]?.worktreeId).toBe(originalId);

    worktrees.reconcile(workspace.id, []);
    vi.advanceTimersByTime(STALE_WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000 + 1);
    worktrees.reconcile(workspace.id, []);
    expect(worktrees.reconcile(workspace.id, [input])[0]?.worktreeId).not.toBe(originalId);
    db.close();
  });

  it("purges only stale registrations from the reconciled workspace", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const db = openMemoryDatabase();
    const workspaces = new WorkspaceRepo(db);
    const worktrees = new WorktreeRepo(db);
    const firstWorkspace = workspaces.create("First", "/first");
    const secondWorkspace = workspaces.create("Second", "/second");
    const secondInput = {
      canonicalPath: "/second/.worktrees/feature",
      label: "feature",
      branch: "feature",
      managed: true,
    };
    worktrees.reconcile(firstWorkspace.id, [{
      canonicalPath: "/first/.worktrees/feature",
      label: "feature",
      branch: "feature",
      managed: true,
    }]);
    const secondId = worktrees.reconcile(secondWorkspace.id, [secondInput])[0]?.worktreeId;

    worktrees.reconcile(secondWorkspace.id, []);
    vi.advanceTimersByTime((STALE_WORKTREE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    worktrees.reconcile(firstWorkspace.id, []);

    expect(worktrees.reconcile(secondWorkspace.id, [secondInput])[0]?.worktreeId).toBe(secondId);
    db.close();
  });
});
