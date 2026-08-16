import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ThreadDiffSource, type TurnSnapshotRow } from "../diff-summary-source.js";
import type { SnapshotService } from "../../snapshots/snapshot-service.js";
import type { GitExecutor } from "../../../git/execution/index.js";

describe("ThreadDiffSource", () => {
  it("scopes aggregate calculations to attributed workspace files", async () => {
    const getDiffStats = vi.fn(async () => [{
      filePath: "authored.ts",
      additions: 1,
      deletions: 0,
    }]);
    const getDiff = vi.fn(async () => "diff --git a/authored.ts b/authored.ts");
    const snapshotService = { getDiffStats, getDiff } as unknown as SnapshotService;
    const gitExecutor = {
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    } as unknown as GitExecutor;
    const snapshots: TurnSnapshotRow[] = [{
      id: "snapshot",
      message_id: "message",
      thread_id: "thread",
      ref_before: "abc111",
      ref_after: "def222",
      files_changed: JSON.stringify(["authored.ts"]),
      file_effects: {
        revision: 1,
        fileCount: 1,
        additions: 1,
        deletions: 0,
        effects: [{
          path: "authored.ts",
          kind: "added",
          scope: "workspace",
          additions: 1,
          deletions: 0,
          binary: false,
          toolCallIds: ["write"],
        }],
      },
      worktree_path: null,
      created_at: new Date(0).toISOString(),
    }];

    const payload = await new ThreadDiffSource(
      snapshots,
      "C:/workspace",
      snapshotService,
      gitExecutor,
    ).getDiff();

    expect(getDiffStats).toHaveBeenCalledWith(
      "C:/workspace",
      "abc111",
      "def222",
      ["authored.ts"],
      [["authored.ts"]],
    );
    expect(getDiff).toHaveBeenCalledWith(
      "C:/workspace",
      "abc111",
      "def222",
      undefined,
      undefined,
      ["authored.ts"],
      [["authored.ts"]],
    );
    expect(payload.turnCount).toBe(1);
  });
});
