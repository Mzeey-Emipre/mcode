/**
 * Tests for WorkspaceRepo pin/recency methods added in the modern project selector feature.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../workspace-repo.js";

describe("WorkspaceRepo pinning + recency", () => {
  let db: Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
  });

  it("setPinned toggles pinned flag", () => {
    const ws = repo.create("a", "/a", true);
    repo.setPinned(ws.id, true);
    expect(repo.findById(ws.id)!.pinned).toBe(true);
    repo.setPinned(ws.id, false);
    expect(repo.findById(ws.id)!.pinned).toBe(false);
  });

  it("touchLastOpened bumps last_opened_at without changing updated_at", () => {
    const ws = repo.create("a", "/a", true);
    const before = repo.findById(ws.id)!;
    repo.touchLastOpened(ws.id);
    const after = repo.findById(ws.id)!;
    expect(after.last_opened_at).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("removeRecent clears last_opened_at and unpins", () => {
    const ws = repo.create("a", "/a", true);
    repo.touchLastOpened(ws.id);
    repo.setPinned(ws.id, true);
    repo.removeRecent(ws.id);
    const after = repo.findById(ws.id)!;
    expect(after.last_opened_at).toBeNull();
    expect(after.pinned).toBe(false);
  });

  it("listAll includes never-opened workspaces and follows sort_order only", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    const c = repo.create("c", "/c", true);
    const d = repo.create("d", "/d", true); // never opened

    let tick = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => ++tick);

    try {
      repo.touchLastOpened(b.id);
      repo.touchLastOpened(c.id);
      repo.touchLastOpened(a.id);
      repo.setPinned(b.id, true);

      const list = repo.listAll();
      // Created newest-first sort_order (d,c,b,a) by create(); pin/recency does not reorder the sidebar.
      expect(list.map((w) => w.name)).toEqual(["d", "c", "b", "a"]);
      expect(list.find((w) => w.id === d.id)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
