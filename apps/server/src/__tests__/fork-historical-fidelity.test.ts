import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { resolveForkSnapshot } from "../services/handoff-builder.js";
import type { TurnSnapshot } from "@mcode/contracts";

function makeSnapshot(
  id: string,
  messageId: string,
  refAfter: string,
  filesChanged: string[],
): TurnSnapshot {
  return {
    id,
    message_id: messageId,
    thread_id: "t-1",
    ref_before: "abc000",
    ref_after: refAfter,
    files_changed: filesChanged,
    worktree_path: null,
    created_at: "2026-04-08T00:00:00.000Z",
  };
}

describe("resolveForkSnapshot", () => {
  it("returns the last snapshot at or before the fork point", () => {
    // Three turns; fork after turn 2 (msg-3). Turn 3 (msg-5) must be excluded.
    const snapshots = [
      makeSnapshot("s1", "msg-1", "sha-1", ["a.ts"]),
      makeSnapshot("s2", "msg-3", "sha-3", ["b.ts"]),
      makeSnapshot("s3", "msg-5", "sha-5", ["c.ts"]),
    ];
    const forkedIds = new Set(["msg-1", "msg-2", "msg-3"]);

    const result = resolveForkSnapshot(snapshots, forkedIds);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("s2");
    expect(result!.ref_after).toBe("sha-3");
    expect(result!.files_changed).toEqual(["b.ts"]);
  });

  it("excludes files changed after the fork point", () => {
    const snapshots = [
      makeSnapshot("s1", "msg-1", "sha-1", ["a.ts"]),
      makeSnapshot("s2", "msg-3", "sha-3", ["b.ts", "c.ts"]),
    ];
    // Fork from msg-1 only — msg-3 snapshot must be excluded
    const forkedIds = new Set(["msg-1"]);

    const result = resolveForkSnapshot(snapshots, forkedIds);

    expect(result!.id).toBe("s1");
    expect(result!.files_changed).toEqual(["a.ts"]);
    expect(result!.ref_after).toBe("sha-1");
  });

  it("returns null when no snapshot falls within the fork range", () => {
    // Snapshot only exists for a message after the fork point
    const snapshots = [makeSnapshot("s1", "msg-5", "sha-5", ["c.ts"])];
    const forkedIds = new Set(["msg-1", "msg-2", "msg-3"]);

    const result = resolveForkSnapshot(snapshots, forkedIds);

    expect(result).toBeNull();
  });

  it("returns null for an empty snapshot list", () => {
    const result = resolveForkSnapshot([], new Set(["msg-1"]));

    expect(result).toBeNull();
  });

  it("returns the single snapshot when it falls within the fork range", () => {
    const snapshots = [makeSnapshot("s1", "msg-2", "sha-2", ["x.ts"])];
    const forkedIds = new Set(["msg-1", "msg-2"]);

    const result = resolveForkSnapshot(snapshots, forkedIds);

    expect(result!.id).toBe("s1");
  });

  it("returns the latest snapshot when forking from the tail", () => {
    // All messages included — same behaviour as the previous code
    const snapshots = [
      makeSnapshot("s1", "msg-1", "sha-1", ["a.ts"]),
      makeSnapshot("s2", "msg-3", "sha-3", ["b.ts"]),
      makeSnapshot("s3", "msg-5", "sha-5", ["c.ts"]),
    ];
    const allIds = new Set(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);

    const result = resolveForkSnapshot(snapshots, allIds);

    expect(result!.id).toBe("s3");
    expect(result!.ref_after).toBe("sha-5");
  });

  it("handles the case where none of the snapshot message IDs are in the fork set", () => {
    const snapshots = [
      makeSnapshot("s1", "unrelated-msg-a", "sha-a", ["x.ts"]),
      makeSnapshot("s2", "unrelated-msg-b", "sha-b", ["y.ts"]),
    ];
    const forkedIds = new Set(["msg-1", "msg-2"]);

    const result = resolveForkSnapshot(snapshots, forkedIds);

    expect(result).toBeNull();
  });
});
