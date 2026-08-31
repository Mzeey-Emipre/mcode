import { describe, expect, it, vi } from "vitest";
import { routeSnapshotRpc, type SnapshotRouterDeps } from "../snapshot-rpc.js";

describe("routeSnapshotRpc", () => {
  it("resolves the snapshot checkout before it filters an unattributed file", async () => {
    const getDiff = vi.fn();
    const deps = {
      turnSnapshotRepo: {
        getById: vi.fn().mockReturnValue({
          id: "snapshot-1",
          thread_id: "thread-1",
          ref_before: "before",
          ref_after: "after",
          files_changed: [],
          worktree_path: null,
        }),
      },
      snapshotService: { getDiff },
      threadService: { findById: vi.fn().mockReturnValue(null) },
    } as unknown as SnapshotRouterDeps;

    await expect(routeSnapshotRpc("snapshot.getDiff", {
      snapshotId: "snapshot-1",
      filePath: "not-attributed.ts",
    }, deps)).rejects.toThrow("Thread not found for snapshot: thread-1");

    expect(getDiff).not.toHaveBeenCalled();
  });
});
