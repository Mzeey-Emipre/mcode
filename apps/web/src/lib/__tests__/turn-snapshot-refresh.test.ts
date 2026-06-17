import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { refreshTurnSnapshotsAfterPersist } from "@/lib/turn-snapshot-refresh";
import { mockTransport, createMockThread } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-refresh";

describe("refreshTurnSnapshotsAfterPersist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      snapshotsByThread: {},
      snapshotsPendingByThread: {},
      diffRevisionByScope: {},
      rightPanelByWorkspace: {},
      rightPanelVisibleByThread: {},
      viewMode: "last-turn",
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [
        createMockThread({
          id: THREAD_ID,
          workspace_id: "ws-1",
          has_file_changes: true,
        }),
      ],
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "snap-1",
        thread_id: THREAD_ID,
        message_id: "msg-1",
        files_changed: ["src/a.ts"],
        ref_before: "aaa",
        ref_after: "bbb",
        worktree_path: null,
        created_at: new Date().toISOString(),
      },
    ]);
  });

  it("loaded snapshots when the Review panel had never fetched them", async () => {
    refreshTurnSnapshotsAfterPersist(THREAD_ID, ["src/a.ts"]);
    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
    });
    expect(useDiffStore.getState().snapshotsByThread[THREAD_ID]).toHaveLength(1);
  });

  it("skipped refetch while the cumulative view is open on the active thread", () => {
    useDiffStore.setState({
      snapshotsByThread: { [THREAD_ID]: [] },
      rightPanelByWorkspace: {
        "ws-1": { visible: true, activeTab: "changes", openTabs: ["changes"], width: 400 },
      },
      rightPanelVisibleByThread: { [THREAD_ID]: true },
      viewMode: "cumulative",
    });

    refreshTurnSnapshotsAfterPersist(THREAD_ID, ["src/a.ts"]);

    expect(mockTransport.listSnapshots).not.toHaveBeenCalled();
    expect(useDiffStore.getState().snapshotsPendingByThread[THREAD_ID]).toBe(true);
  });
});
