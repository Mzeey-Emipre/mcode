import { describe, it, expect } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { SnapshotBuilder } from "../snapshot-builder";
import { createMockMessage } from "@/__tests__/mocks/transport";

describe("SnapshotBuilder", () => {
  const builder = new SnapshotBuilder();

  it("rolled up tool-call counts and pagination cursors from messages", () => {
    const messages = [
      createMockMessage({ id: "m1", sequence: 10, tool_call_count: 2 }),
      createMockMessage({ id: "m2", sequence: 11 }),
    ];

    const snapshot = builder.build({ messages, hasMore: true, answeredPlanMessageIds: ["m1"] });

    expect(snapshot.persistedToolCallCounts).toEqual({ m1: 2 });
    expect(snapshot.oldestLoadedSequence).toBe(10);
    expect(snapshot.hasMoreMessages).toBe(true);
    expect(snapshot.answeredPlanMessageIds).toEqual(new Set(["m1"]));
  });

  it("derived latest turn with file changes from snapshot rows", () => {
    const snapshots: TurnSnapshot[] = [
      {
        message_id: "old",
        files_changed: ["a.ts"],
        thread_id: "t1",
        created_at: "2026-01-01T00:00:00Z",
      } as TurnSnapshot,
      {
        message_id: "new",
        files_changed: ["b.ts"],
        thread_id: "t1",
        created_at: "2026-01-02T00:00:00Z",
      } as TurnSnapshot,
    ];

    const result = SnapshotBuilder.deriveFileChanges(snapshots);

    expect(result.persistedFilesChanged).toEqual({
      old: ["a.ts"],
      new: ["b.ts"],
    });
    expect(result.latestTurnWithChanges).toBe("new");
  });

  it("hydrates the newest empty authored summary after an earlier changed turn", () => {
    const changed = {
      revision: 2,
      fileCount: 1,
      additions: 3,
      deletions: 0,
      effects: [],
    };
    const empty = { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] };
    const result = SnapshotBuilder.deriveFileChanges([
      { message_id: "changed", files_changed: ["a.ts"], file_effects: changed } as unknown as TurnSnapshot,
      { message_id: "unchanged", files_changed: [], file_effects: empty } as unknown as TurnSnapshot,
    ]);

    expect(result.persistedFilesChanged).toEqual({ changed: ["a.ts"] });
    expect(result.fileEffectSummary).toEqual(empty);
  });
});
