import {
  resetThreadStoreForTests,
  getTestThreadError,
  hasTestThreadRecord,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore, __resetThreadListMutationEpochForTests, __clearPendingThreadCreationsForTests } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewReferenceQueueStore } from "@/stores/previewReferenceQueueStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import {
  mockTransport,
  createMockWorkspace,
  createMockThread,
} from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Workspace Behavior", () => {
  beforeEach(() => {
    __resetThreadListMutationEpochForTests();
    __clearPendingThreadCreationsForTests();
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      threads: [],
      activeThreadId: null,
      loading: false,
      error: null,
    });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {} });
    usePreviewReferenceQueueStore.setState({ signal: 0, queueByThread: {} });
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    vi.clearAllMocks();
  });

  it("when the user creates a workspace, it appears in the list", async () => {
    const ws = createMockWorkspace({ name: "my-project" });
    (
      mockTransport.createWorkspace as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ws);

    const result = await useWorkspaceStore
      .getState()
      .createWorkspace("my-project", "/tmp/my-project");

    expect(result.name).toBe("my-project");
    expect(useWorkspaceStore.getState().workspaces).toContainEqual(ws);
  });

  it("when the user re-adds an existing project, it is deduped and moved to the front", async () => {
    const existing = createMockWorkspace({ id: "ws-existing", name: "existing" });
    const other = createMockWorkspace({ id: "ws-other", name: "other" });
    useWorkspaceStore.setState({ workspaces: [other, existing] });

    // Server is idempotent on path: re-adding returns the live workspace.
    (
      mockTransport.createWorkspace as ReturnType<typeof vi.fn>
    ).mockResolvedValue(existing);

    await useWorkspaceStore
      .getState()
      .createWorkspace("existing", "/tmp/existing");

    const { workspaces } = useWorkspaceStore.getState();
    expect(workspaces).toHaveLength(2);
    expect(workspaces.filter((w) => w.id === "ws-existing")).toHaveLength(1);
    expect(workspaces[0].id).toBe("ws-existing");
  });

  it("when the user deletes the active workspace, threads and selection clear", async () => {
    const ws = createMockWorkspace();
    const thread = createMockThread({ workspace_id: ws.id });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [thread],
      activeThreadId: thread.id,
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws.id);

    const state = useWorkspaceStore.getState();
    expect(state.workspaces).toHaveLength(0);
    expect(state.activeWorkspaceId).toBeNull();
    expect(state.threads).toHaveLength(0);
    expect(state.activeThreadId).toBeNull();
  });

  it("when the user deletes a non-active workspace, active selection is preserved", async () => {
    const wsActive = createMockWorkspace({ id: "ws-active" });
    const wsOther = createMockWorkspace({ id: "ws-other" });
    const thread = createMockThread({ workspace_id: wsActive.id });

    useWorkspaceStore.setState({
      workspaces: [wsActive, wsOther],
      activeWorkspaceId: wsActive.id,
      threads: [thread],
      activeThreadId: thread.id,
    });

    await useWorkspaceStore.getState().deleteWorkspace(wsOther.id);

    const state = useWorkspaceStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.activeWorkspaceId).toBe("ws-active");
    expect(state.threads).toHaveLength(1);
    expect(state.activeThreadId).toBe(thread.id);
  });

  it("when the user loads threads for multiple workspaces, all threads are merged", async () => {
    const ws1 = createMockWorkspace({ id: "ws-1" });
    const ws2 = createMockWorkspace({ id: "ws-2" });
    const threads1 = [
      createMockThread({ workspace_id: "ws-1", title: "Thread A" }),
    ];
    const threads2 = [
      createMockThread({ workspace_id: "ws-2", title: "Thread B" }),
    ];

    useWorkspaceStore.setState({ workspaces: [ws1, ws2] });

    // Make listThreads slow for ws-1 and fast for ws-2
    (mockTransport.listThreads as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(threads1), 100)),
      )
      .mockImplementationOnce(() => Promise.resolve(threads2));

    // Load threads for both workspaces (simulates expanding both folders)
    useWorkspaceStore.getState().loadThreads("ws-1");
    useWorkspaceStore.getState().loadThreads("ws-2");

    // Wait for both to resolve
    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = useWorkspaceStore.getState();
    // Both workspaces' threads should be present (merged, not replaced)
    expect(state.threads).toHaveLength(2);
    expect(state.threads.map((t) => t.title).sort()).toEqual(["Thread A", "Thread B"]);
  });

  it("when branchThread completes while loadThreads is in flight, stale listThreads does not drop the new branch", async () => {
    const ws = createMockWorkspace({ id: "ws-branch" });
    const parent = createMockThread({
      id: "parent-1",
      workspace_id: ws.id,
      title: "Parent",
    });
    let listResolve!: (value: typeof parent[]) => void;
    const listPromise = new Promise<typeof parent[]>((resolve) => {
      listResolve = resolve;
    });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [parent],
    });

    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockImplementation(() => listPromise);

    void useWorkspaceStore.getState().loadThreads(ws.id);

    const child = createMockThread({
      id: "child-1",
      workspace_id: ws.id,
      title: "Forked",
      parent_thread_id: "parent-1",
    });
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(child);

    await useWorkspaceStore.getState().branchThread({
      sourceThreadId: "parent-1",
      content: "Continue",
      model: "gpt-4",
      mode: "direct",
      forkedFromMessageId: "msg-1",
    });

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "child-1")).toBe(true);

    listResolve([parent]);

    await listPromise;
    await Promise.resolve();

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "child-1")).toBe(true);
  });

  it("when createAndSendMessage completes while loadThreads is in flight, stale listThreads does not drop the new thread", async () => {
    const ws = createMockWorkspace({ id: "ws-first-msg" });
    const existing = createMockThread({
      id: "existing-1",
      workspace_id: ws.id,
      title: "Existing",
    });
    let listResolve!: (value: typeof existing[]) => void;
    const listPromise = new Promise<typeof existing[]>((resolve) => {
      listResolve = resolve;
    });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [existing],
    });

    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockImplementation(() => listPromise);

    void useWorkspaceStore.getState().loadThreads(ws.id);

    const created = createMockThread({
      id: "new-first-send",
      workspace_id: ws.id,
      title: "New from first message",
    });
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    await useWorkspaceStore.getState().createAndSendMessage("Hello", "composer-2-fast");

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "new-first-send")).toBe(true);

    listResolve([existing]);

    await listPromise;
    await Promise.resolve();

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "new-first-send")).toBe(true);
  });

  it("when first send creates a real thread, the new thread does not inherit the threadless right panel", async () => {
    const ws = createMockWorkspace({ id: "ws-first-send-panel" });
    const created = createMockThread({
      id: "created-thread",
      workspace_id: ws.id,
      title: "New Thread",
    });
    let resolveRpc!: (value: typeof created) => void;
    const rpcPromise = new Promise<typeof created>((resolve) => {
      resolveRpc = resolve;
    });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [],
      activeThreadId: null,
      pendingNewThread: true,
      newThreadMode: "direct",
      newThreadBranch: "main",
    });
    const diff = useDiffStore.getState();
    diff.showRightPanel(ws.id, null);
    diff.setRightPanelTab(ws.id, null, "preview");
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

    const sendOp = useWorkspaceStore.getState().createAndSendMessage("Hello", "composer-2-fast");
    await Promise.resolve();

    const placeholderId = useWorkspaceStore.getState().activeThreadId;
    expect(placeholderId).not.toBeNull();
    expect(diff.getRightPanelVisible(ws.id, placeholderId)).toBe(false);

    resolveRpc(created);
    await sendOp;

    expect(useWorkspaceStore.getState().activeThreadId).toBe(created.id);
    expect(diff.getRightPanelVisible(ws.id, created.id)).toBe(false);
    expect(diff.getRightPanel(ws.id, null)).toMatchObject({
      visible: true,
      activeTab: "preview",
    });
  });

  it("when the user creates a thread, it appears in the list", async () => {
    const ws = createMockWorkspace();
    const thread = createMockThread({
      workspace_id: ws.id,
      title: "New Feature",
    });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
    });
    (
      mockTransport.createThread as ReturnType<typeof vi.fn>
    ).mockResolvedValue(thread);

    const result = await useWorkspaceStore
      .getState()
      .createThread("New Feature", "direct", "main");

    expect(result.title).toBe("New Feature");
    expect(useWorkspaceStore.getState().threads).toContainEqual(thread);
  });

  it("when creating a thread with no active workspace, it throws an error", async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: null });

    await expect(
      useWorkspaceStore.getState().createThread("Test", "direct", "main"),
    ).rejects.toThrow("No active workspace");
  });

  it("when loadWorkspaces fails, the error is captured in state", async () => {
    (
      mockTransport.listWorkspaces as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("network down"));

    await useWorkspaceStore.getState().loadWorkspaces();

    const state = useWorkspaceStore.getState();
    expect(state.error).toContain("network down");
    expect(state.loading).toBe(false);
  });

  it("when deleteWorkspace RPC fails, workspace and threads remain in state", async () => {
    const ws = createMockWorkspace();
    const thread = createMockThread({ workspace_id: ws.id });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [thread],
      activeThreadId: thread.id,
    });

    (
      mockTransport.deleteWorkspace as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("server error"));

    await expect(
      useWorkspaceStore.getState().deleteWorkspace(ws.id),
    ).rejects.toThrow("server error");

    const state = useWorkspaceStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.threads).toHaveLength(1);
    expect(state.error).toContain("server error");
  });

  it("when the user deletes a thread, it is removed and active selection clears if it was active", async () => {
    const ws = createMockWorkspace();
    const thread1 = createMockThread({
      workspace_id: ws.id,
      id: "t-1",
      title: "Thread 1",
    });
    const thread2 = createMockThread({
      workspace_id: ws.id,
      id: "t-2",
      title: "Thread 2",
    });

    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [thread1, thread2],
      activeThreadId: "t-1",
    });

    await useWorkspaceStore.getState().deleteThread("t-1", false);

    const state = useWorkspaceStore.getState();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].id).toBe("t-2");
    expect(state.activeThreadId).toBeNull();
  });

  // ── deleteThread → clearThreadState integration ──────────────────────

  describe("deleteThread clears threadStore per-thread state", () => {
    it("removes deleted thread from all per-thread maps in threadStore", async () => {
      const ws = createMockWorkspace();
      const thread = createMockThread({ workspace_id: ws.id, id: "t-del" });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [thread],
        activeThreadId: null,
      });

      // Seed per-thread maps so we can verify they get pruned.
      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set(["t-del"]),
        records: new Map<string, ThreadRecord>([
          [
            "t-del",
            {
              ...createEmptyThreadRecord(),
              error: "some error",
              streaming: "some text",
              agentStartTime: Date.now(),
            },
          ],
        ]),
      });
      useThreadStore.setState({
        recapByThread: {
          "t-del": {
            text: "Delete this thread",
            signature: "sig-del",
            coveredMessageId: "msg-del",
            generatedAt: "2026-06-25T10:00:00.000Z",
          },
        },
      });

      await useWorkspaceStore.getState().deleteThread("t-del", false);

      const ts = useThreadStore.getState();
      expect(ts.runningThreadIds.has("t-del")).toBe(false);
      expect(hasTestThreadRecord("t-del")).toBe(false);
      expect(ts.recapByThread["t-del"]).toBeUndefined();
    });

    it("preserves per-thread maps for other threads when deleting one", async () => {
      const ws = createMockWorkspace();
      const t1 = createMockThread({ workspace_id: ws.id, id: "t-keep" });
      const t2 = createMockThread({ workspace_id: ws.id, id: "t-del" });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [t1, t2],
        activeThreadId: null,
      });

      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set(["t-keep", "t-del"]),
        records: new Map<string, ThreadRecord>([
          ["t-keep", { ...createEmptyThreadRecord(), error: "keep error" }],
          ["t-del", { ...createEmptyThreadRecord(), error: "del error" }],
        ]),
      });
      useThreadStore.setState({
        recapByThread: {
          "t-keep": {
            text: "Keep this thread",
            signature: "sig-keep",
            coveredMessageId: "msg-keep",
            generatedAt: "2026-06-25T10:00:00.000Z",
          },
          "t-del": {
            text: "Delete this thread",
            signature: "sig-del",
            coveredMessageId: "msg-del",
            generatedAt: "2026-06-25T10:01:00.000Z",
          },
        },
      });

      await useWorkspaceStore.getState().deleteThread("t-del", false);

      const ts = useThreadStore.getState();
      // Deleted thread is gone.
      expect(hasTestThreadRecord("t-del")).toBe(false);
      expect(ts.runningThreadIds.has("t-del")).toBe(false);
      expect(ts.recapByThread["t-del"]).toBeUndefined();
      // Other thread is preserved.
      expect(getTestThreadError("t-keep")).toBe("keep error");
      expect(ts.runningThreadIds.has("t-keep")).toBe(true);
      expect(ts.recapByThread["t-keep"]?.text).toBe("Keep this thread");
    });

    it("clears preview browser state and queued preview references for the deleted thread", async () => {
      const ws = createMockWorkspace();
      const thread = createMockThread({ workspace_id: ws.id, id: "t-preview" });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [thread],
        activeThreadId: null,
      });
      usePreviewTabsStore.setState({
        tabSetByScope: {
          "t-preview": {
            threadId: "t-preview",
            activeTabId: "tab-1",
            tabs: [{
              id: "tab-1",
              threadId: "t-preview",
              title: null,
              url: "https://example.test",
              faviconUrl: null,
              warm: true,
              active: true,
            }],
          },
        },
        liveChromeByScope: {
          "t-preview": { title: "Example", url: "https://example.test", favicon: null },
        },
      });
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference("t-preview", {
        id: "att-1",
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: 10,
        previewUrl: "data:image/png;base64,AA==",
        filePath: null,
      });

      await useWorkspaceStore.getState().deleteThread("t-preview", false);

      expect(usePreviewTabsStore.getState().tabSetByScope["t-preview"]).toBeUndefined();
      expect(usePreviewTabsStore.getState().liveChromeByScope["t-preview"]).toBeUndefined();
      expect(usePreviewReferenceQueueStore.getState().queueByThread["t-preview"]).toBeUndefined();
    });

    it("clears all per-thread maps for all threads when deleting a workspace", async () => {
      const ws = createMockWorkspace({ id: "ws-del" });
      const t1 = createMockThread({ workspace_id: "ws-del", id: "t-1" });
      const t2 = createMockThread({ workspace_id: "ws-del", id: "t-2" });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: "ws-del",
        threads: [t1, t2],
        activeThreadId: null,
      });

      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set(["t-1", "t-2"]),
        records: new Map<string, ThreadRecord>([
          ["t-1", { ...createEmptyThreadRecord(), error: "err-1", streaming: "text-1" }],
          ["t-2", { ...createEmptyThreadRecord(), error: "err-2", streaming: "text-2" }],
        ]),
      });
      useThreadStore.setState({
        recapByThread: {
          "t-1": {
            text: "Delete one",
            signature: "sig-1",
            coveredMessageId: "msg-1",
            generatedAt: "2026-06-25T10:00:00.000Z",
          },
          "t-2": {
            text: "Delete two",
            signature: "sig-2",
            coveredMessageId: "msg-2",
            generatedAt: "2026-06-25T10:01:00.000Z",
          },
          "other-workspace-thread": {
            text: "Keep other workspace",
            signature: "sig-other",
            coveredMessageId: "msg-other",
            generatedAt: "2026-06-25T10:02:00.000Z",
          },
        },
      });

      await useWorkspaceStore.getState().deleteWorkspace("ws-del");

      const ts = useThreadStore.getState();
      expect(ts.runningThreadIds.has("t-1")).toBe(false);
      expect(ts.runningThreadIds.has("t-2")).toBe(false);
      expect(hasTestThreadRecord("t-1")).toBe(false);
      expect(hasTestThreadRecord("t-2")).toBe(false);
      expect(ts.recapByThread).toEqual({
        "other-workspace-thread": {
          text: "Keep other workspace",
          signature: "sig-other",
          coveredMessageId: "msg-other",
          generatedAt: "2026-06-25T10:02:00.000Z",
        },
      });
    });
  });

  describe("optimistic thread scaffolding", () => {
    it("createAndSendMessage sends a base branch when attaching a detached existing worktree", async () => {
      const ws = createMockWorkspace({ id: "ws-detached-existing" });
      const created = createMockThread({
        id: "detached-thread",
        workspace_id: ws.id,
        mode: "worktree",
        branch: "main",
        checkout_state: "branchless",
        base_branch: "main",
        worktree_path: "/repo/.worktrees/branchless-existing",
        worktree_managed: false,
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        newThreadMode: "existing-worktree",
        newThreadBranch: "main",
        selectedWorktree: {
          name: "branchless-existing",
          path: "/repo/.worktrees/branchless-existing",
          branch: "(detached)",
          managed: true,
        },
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      await useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");

      const call = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call.slice(0, 8)).toEqual([
        ws.id,
        "Hello",
        "gpt-5.5",
        undefined,
        "worktree",
        "main",
        "/repo/.worktrees/branchless-existing",
        "main",
      ]);
    });

    it("createAndSendMessage rejects detached existing worktree attach without a base branch", async () => {
      const ws = createMockWorkspace({ id: "ws-detached-missing-base" });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        newThreadMode: "existing-worktree",
        newThreadBranch: "",
        selectedWorktree: {
          name: "branchless-existing",
          path: "/repo/.worktrees/branchless-existing",
          branch: "(detached)",
          managed: true,
        },
      });

      await expect(
        useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5"),
      ).rejects.toThrow("Select a base branch before attaching a detached worktree");
      expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();
    });

    it("createAndSendMessage keeps named existing worktree attach metadata named", async () => {
      const ws = createMockWorkspace({ id: "ws-named-existing" });
      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        newThreadMode: "existing-worktree",
        newThreadBranch: "main",
        selectedWorktree: {
          name: "feature-existing",
          path: "/repo/.worktrees/feature-existing",
          branch: "feat/existing",
          managed: true,
        },
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const done = useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");
      await Promise.resolve();

      const mid = useWorkspaceStore.getState();
      expect(mid.threads[0]).toMatchObject({
        mode: "worktree",
        worktree_path: "/repo/.worktrees/feature-existing",
        branch: "feat/existing",
        checkout_state: "named",
        base_branch: null,
        worktree_managed: false,
      });

      const call = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call.slice(0, 8)).toEqual([
        ws.id,
        "Hello",
        "gpt-5.5",
        undefined,
        "worktree",
        "feat/existing",
        "/repo/.worktrees/feature-existing",
        undefined,
      ]);

      resolveRpc(createMockThread({
        id: "named-existing-thread",
        workspace_id: ws.id,
        mode: "worktree",
        branch: "feat/existing",
        worktree_path: "/repo/.worktrees/feature-existing",
        worktree_managed: false,
      }));
      await done;
    });

    it("createAndSendMessage shows a preparing placeholder before the RPC resolves", async () => {
      const ws = createMockWorkspace({ id: "ws-opt" });
      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const done = useWorkspaceStore.getState().createAndSendMessage(
        "Hello world",
        "gpt-5.5",
        "full",
        undefined,
        "high",
        "codex",
        "plan",
        undefined,
        undefined,
        undefined,
        true,
      );
      await Promise.resolve();

      const mid = useWorkspaceStore.getState();
      expect(mid.activeThreadId).not.toBeNull();
      expect(mid.threads[0]?.clientPreparing).toBe(true);
      expect(mid.threads[0]?.clientQueuedMessage).toBe("Hello world");
      expect(mid.threads[0]?.model).toBe("gpt-5.5");
      expect(mid.threads[0]?.provider).toBe("codex");
      expect(mid.threads[0]?.reasoning_level).toBe("high");
      expect(mid.threads[0]?.interaction_mode).toBe("plan");
      expect(mid.threads[0]?.permission_mode).toBe("full");
      expect(mid.threads[0]?.codex_fast_mode).toBe(true);

      const created = createMockThread({
        id: "server-thread-1",
        workspace_id: ws.id,
        title: "Hello world",
        model: null,
        provider: "claude",
        reasoning_level: null,
      });
      resolveRpc(created);
      await done;

      const fin = useWorkspaceStore.getState();
      expect(fin.threads.some((t) => t.id === "server-thread-1")).toBe(true);
      expect(fin.activeThreadId).toBe("server-thread-1");
      expect(fin.threads[0]?.model).toBe("gpt-5.5");
      expect(fin.threads[0]?.provider).toBe("codex");
      expect(fin.threads[0]?.reasoning_level).toBe("high");
    });

    it("branchThread placeholder preserves selected composer settings before the child exists", async () => {
      const ws = createMockWorkspace({ id: "ws-branch-placeholder" });
      const parent = createMockThread({ id: "parent-branch", workspace_id: ws.id });
      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [parent],
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const done = useWorkspaceStore.getState().branchThread({
        sourceThreadId: parent.id,
        content: "Branch this",
        model: "claude-opus-4-7",
        provider: "claude",
        mode: "direct",
        forkedFromMessageId: "msg-parent",
        permissionMode: "supervised",
        reasoningLevel: "max",
        interactionMode: "build",
        contextWindow: "1m",
        thinking: true,
      });
      await Promise.resolve();

      const mid = useWorkspaceStore.getState();
      expect(mid.threads[0]?.clientPreparing).toBe(true);
      expect(mid.threads[0]?.parent_thread_id).toBe(parent.id);
      expect(mid.threads[0]?.model).toBe("claude-opus-4-7");
      expect(mid.threads[0]?.provider).toBe("claude");
      expect(mid.threads[0]?.reasoning_level).toBe("max");
      expect(mid.threads[0]?.context_window_mode).toBe("1m");
      expect(mid.threads[0]?.thinking).toBe(true);

      resolveRpc(createMockThread({
        id: "child-branch",
        workspace_id: ws.id,
        parent_thread_id: parent.id,
        model: null,
        reasoning_level: null,
      }));
      await done;

      const fin = useWorkspaceStore.getState();
      expect(fin.activeThreadId).toBe("child-branch");
      expect(fin.threads[0]?.model).toBe("claude-opus-4-7");
      expect(fin.threads[0]?.reasoning_level).toBe("max");
      expect(fin.threads[0]?.context_window_mode).toBe("1m");
    });

    it("branchThread normalizes existing worktree paths before detached metadata lookup", async () => {
      const ws = createMockWorkspace({ id: "ws-branch-detached-normalized" });
      const parent = createMockThread({ id: "parent-detached-normalized", workspace_id: ws.id });
      const created = createMockThread({
        id: "branch-detached-thread",
        workspace_id: ws.id,
        mode: "worktree",
        branch: "main",
        checkout_state: "branchless",
        base_branch: "main",
        worktree_path: "C:/repo/.worktrees/branchless-existing",
        worktree_managed: false,
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [parent],
        worktrees: [{
          name: "branchless-existing",
          path: "C:/repo/.worktrees/branchless-existing",
          branch: "(detached)",
          managed: true,
        }],
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      await useWorkspaceStore.getState().branchThread({
        sourceThreadId: parent.id,
        content: "Branch this",
        model: "gpt-5.5",
        mode: "existing-worktree",
        branch: "main",
        existingWorktreePath: "C:\\repo\\.worktrees\\branchless-existing\\",
      });

      const call = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call.slice(0, 8)).toEqual([
        ws.id,
        "Branch this",
        "gpt-5.5",
        undefined,
        "worktree",
        "main",
        "C:\\repo\\.worktrees\\branchless-existing\\",
        "main",
      ]);
    });

    it("branchThread rejects detached existing worktree attach without a base branch", async () => {
      const ws = createMockWorkspace({ id: "ws-branch-detached-missing-base" });
      const parent = createMockThread({ id: "parent-detached-missing-base", workspace_id: ws.id });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [parent],
        worktrees: [{
          name: "branchless-existing",
          path: "/repo/.worktrees/branchless-existing",
          branch: "(detached)",
          managed: true,
        }],
      });

      await expect(
        useWorkspaceStore.getState().branchThread({
          sourceThreadId: parent.id,
          content: "Branch this",
          model: "gpt-5.5",
          mode: "existing-worktree",
          existingWorktreePath: "/repo/.worktrees/branchless-existing",
        }),
      ).rejects.toThrow("Select a base branch before attaching a detached worktree");
      expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();
    });

    it("when createAndSendMessage succeeds after the user navigates away, activeThreadId is not forced to the new thread", async () => {
      const ws = createMockWorkspace({ id: "ws-nav" });
      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const done = useWorkspaceStore.getState().createAndSendMessage("Hi", "composer-2-fast");
      await Promise.resolve();
      useWorkspaceStore.getState().setActiveThread(null);

      resolveRpc(
        createMockThread({ id: "server-thread-2", workspace_id: ws.id, title: "Hi" }),
      );
      await done;

      const fin = useWorkspaceStore.getState();
      expect(fin.activeThreadId).toBeNull();
      expect(fin.threads.some((t) => t.id === "server-thread-2")).toBe(true);
    });

    it("stale loadThreads does not drop a preparing placeholder mid-RPC", async () => {
      const ws = createMockWorkspace({ id: "ws-ph" });
      const existing = createMockThread({ id: "old-1", workspace_id: ws.id, title: "Old" });
      let listResolve!: (value: typeof existing[]) => void;
      const listPromise = new Promise<typeof existing[]>((resolve) => {
        listResolve = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [existing],
      });
      (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockImplementation(() => listPromise);

      void useWorkspaceStore.getState().loadThreads(ws.id);

      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const sendOp = useWorkspaceStore.getState().createAndSendMessage("New", "composer-2-fast");
      await Promise.resolve();

      const mid = useWorkspaceStore.getState();
      const placeholderId = mid.activeThreadId;
      expect(placeholderId).not.toBeNull();
      expect(mid.threads.some((t) => t.clientPreparing)).toBe(true);

      listResolve([existing]);
      await listPromise;
      await Promise.resolve();

      expect(useWorkspaceStore.getState().threads.some((t) => t.id === placeholderId)).toBe(true);

      resolveRpc(createMockThread({ id: "real-new", workspace_id: ws.id, title: "New" }));
      await sendOp;
    });

    it("loadThreads retains errored client placeholders for retry UI", async () => {
      const ws = createMockWorkspace({ id: "ws-err-ph" });
      const errRow = {
        ...createMockThread({
          id: "ph-err",
          workspace_id: ws.id,
          title: "Failed",
        }),
        clientPreparing: false,
        clientError: "rpc failed",
        clientQueuedMessage: "hello",
      };
      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [errRow],
      });
      (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await useWorkspaceStore.getState().loadThreads(ws.id);
      expect(useWorkspaceStore.getState().threads.some((t) => t.id === "ph-err")).toBe(true);
    });
  });
});

