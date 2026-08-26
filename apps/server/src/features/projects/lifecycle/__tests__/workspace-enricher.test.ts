/**
 * Tests for WorkspaceEnricher — verifies that git and thread metadata are
 * correctly assembled for the project selector.
 */

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkspaceEnricher } from "../../index.js";

const mockGit = {
  getCurrentBranchAt: vi.fn(),
  isWorkingTreeClean: vi.fn(),
};
const mockThreads = {
  countActiveByWorkspaceIds: vi.fn(),
};

describe("WorkspaceEnricher", () => {
  it("returns branch, isGit, isClean, threadCount for each item", async () => {
    mockGit.getCurrentBranchAt.mockResolvedValue("main");
    mockGit.isWorkingTreeClean.mockResolvedValue(true);
    mockThreads.countActiveByWorkspaceIds.mockReturnValue(new Map([["ws-1", 3]]));

    const enricher = new WorkspaceEnricher(mockGit as any, mockGit as any, mockThreads as any);
    const result = await enricher.enrich([{ id: "ws-1", path: "/tmp/proj" }]);

    expect(result).toEqual([{ id: "ws-1", branch: "main", isGit: true, isClean: true, threadCount: 3 }]);
  });

  it("returns isGit=false when branch is null", async () => {
    mockGit.getCurrentBranchAt.mockResolvedValue(null);
    mockGit.isWorkingTreeClean.mockResolvedValue(true);
    mockThreads.countActiveByWorkspaceIds.mockReturnValue(new Map());

    const enricher = new WorkspaceEnricher(mockGit as any, mockGit as any, mockThreads as any);
    const result = await enricher.enrich([{ id: "ws-2", path: "/tmp/notgit" }]);

    expect(result[0].isGit).toBe(false);
    // Non-git workspaces default to clean
    expect(result[0].isClean).toBe(true);
  });

  it("returns threadCount=0 when workspace has no threads", async () => {
    mockGit.getCurrentBranchAt.mockResolvedValue("main");
    mockGit.isWorkingTreeClean.mockResolvedValue(true);
    mockThreads.countActiveByWorkspaceIds.mockReturnValue(new Map());

    const enricher = new WorkspaceEnricher(mockGit as any, mockGit as any, mockThreads as any);
    const result = await enricher.enrich([{ id: "ws-3", path: "/tmp/proj" }]);

    expect(result[0].threadCount).toBe(0);
  });
});
