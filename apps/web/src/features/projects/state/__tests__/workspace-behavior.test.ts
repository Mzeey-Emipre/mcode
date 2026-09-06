import {
  resetThreadStoreForTests,
  getTestThreadError,
  hasTestThreadRecord,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useWorkspaceStore, __resetThreadListMutationEpochForTests, __clearPendingThreadCreationsForTests } from "../workspaceStore";
import { scheduleDrainAfterEdit, useThreadStore } from "@/stores/threadStore";
import { useQueueStore } from "@/stores/queueStore";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import { toComposerAttachmentMetas } from "@/features/conversation/composer/draft/composer-attachment-operations";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewReferenceQueueStore } from "@/features/preview/state/previewReferenceQueueStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import {
  mockTransport,
  createMockWorkspace,
  createMockThread,
} from "../../../../__tests__/mocks/transport";
import type { CreateAndSendResult, SelectedTextComment, TurnRuntimeSnapshot } from "@mcode/contracts";
import { act, renderHook } from "@testing-library/react";
import { useQueuedMessageDispatch } from "@/features/conversation/composer/queue/useQueuedMessageDispatch";

const selectedTextComments: SelectedTextComment[] = [{
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: {
    threadId: "parent-thread",
    messageId: "message-1",
    sourceRole: "assistant",
    start: 0,
    end: 5,
    quote: "focus",
  },
  note: "Explain this choice.",
  mentions: [],
}];

const pendingComposerDraft: ComposerDraft = {
  input: "Keep this request.",
  mentions: [],
  selectedTextComments,
  selectedTextCommentEditor: {
    source: selectedTextComments[0]!.source,
    note: "Keep this editor open.",
    mentions: [],
    escapeWarned: false,
    outsideWarned: false,
    anchor: "card",
  },
  attachments: [],
  modelId: "gpt-5.5",
  provider: "codex",
  reasoning: "high",
  contextWindow: "1m",
  codexFastMode: true,
};

function createMockCreateAndSendResult(
  overrides?: Parameters<typeof createMockThread>[0],
  runtimeSnapshot?: Partial<TurnRuntimeSnapshot>,
): CreateAndSendResult {
  const thread = createMockThread(overrides);
  return {
    ...thread,
    runtimeSnapshot: {
      threadId: thread.id,
      turnExecutionId: null,
      phase: "running",
      ...runtimeSnapshot,
    },
  };
}

function expectPreparedCodexThread(
  thread: ReturnType<typeof useWorkspaceStore.getState>["threads"][number] | undefined,
) {
  expect(thread?.clientPreparing).toBe(true);
  expect(thread?.clientQueuedMessage).toBe("Hello world");
  expect(thread?.model).toBe("gpt-5.5");
  expect(thread?.provider).toBe("codex");
  expect(thread?.reasoning_level).toBe("high");
  expect(thread?.interaction_mode).toBe("plan");
  expect(thread?.permission_mode).toBe("full");
  expect(thread?.codex_fast_mode).toBe(true);
}

function expectPreparedBranchThread(
  thread: ReturnType<typeof useWorkspaceStore.getState>["threads"][number] | undefined,
  parentId: string,
) {
  expect(thread?.clientPreparing).toBe(true);
  expect(thread?.parent_thread_id).toBe(parentId);
  expect(thread?.model).toBe("claude-opus-4-7");
  expect(thread?.provider).toBe("claude");
  expect(thread?.reasoning_level).toBe("max");
  expect(thread?.context_window_mode).toBe("1m");
  expect(thread?.thinking).toBe(true);
}

function expectPersistedBranchSettings(
  thread: ReturnType<typeof useWorkspaceStore.getState>["threads"][number] | undefined,
) {
  expect(thread?.model).toBe("claude-opus-4-7");
  expect(thread?.reasoning_level).toBe("max");
  expect(thread?.context_window_mode).toBe("1m");
}

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/features/preview/capture/browser-capture-spill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/preview/capture/browser-capture-spill")>()),
  releaseBrowserCaptureSpills: vi.fn(),
}));

function claimQueuedMessage(threadId: string, spillPath: string) {
  useQueueStore.getState().enqueue(threadId, {
    content: "queued follow-up",
    displayContent: "queued follow-up",
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
    browserCaptureSpillPaths: [spillPath],
  });
  return useQueueStore.getState().claimNextQueuedMessage(threadId)!;
}

function queueMessage(threadId: string) {
  expect(useQueueStore.getState().enqueue(threadId, {
    content: "queued follow-up",
    displayContent: "queued follow-up",
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  })).toBe(true);
}

describe("Workspace Behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    usePreviewReferenceQueueStore.setState({ signal: 0, queueByThread: {} });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      autoDrainSuppressedThreadIds: new Set<string>(),
      toast: null,
      editingThreadId: null,
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

  it("does not drain while workspace deletion is awaiting the server", async () => {
    vi.useFakeTimers();
    const ws = createMockWorkspace({ id: "workspace-delete-pending" });
    const thread = createMockThread({ id: "thread-delete-pending", workspace_id: ws.id });
    useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, threads: [thread], activeThreadId: thread.id });
    resetThreadStoreForTests({ currentThreadId: thread.id });
    queueMessage(thread.id);
    let resolveDelete!: () => void;
    (mockTransport.deleteWorkspace as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDelete = resolve; }),
    );

    scheduleDrainAfterEdit(thread.id);
    const deleting = useWorkspaceStore.getState().deleteWorkspace(ws.id);
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();

    resolveDelete();
    await deleting;
    vi.useRealTimers();
  });

  it("re-arms a queued drain when workspace deletion fails", async () => {
    vi.useFakeTimers();
    const ws = createMockWorkspace({ id: "workspace-delete-reject" });
    const thread = createMockThread({ id: "thread-delete-reject", workspace_id: ws.id });
    useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, threads: [thread], activeThreadId: thread.id });
    resetThreadStoreForTests({ currentThreadId: thread.id });
    queueMessage(thread.id);
    (mockTransport.deleteWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("delete failed"));

    await expect(useWorkspaceStore.getState().deleteWorkspace(ws.id)).rejects.toThrow("delete failed");
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("disposes queued leases when deleting a workspace and releases their spills only after failure settles", async () => {
    const ws = createMockWorkspace({ id: "workspace-delete-lease" });
    const thread = createMockThread({ id: "thread-delete-lease", workspace_id: ws.id });
    useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, threads: [thread], activeThreadId: thread.id });
    const claimed = claimQueuedMessage(thread.id, "browser-capture-spill/workspace-delete.json");

    await useWorkspaceStore.getState().deleteWorkspace(ws.id);

    expect(useQueueStore.getState().queues[thread.id]).toBeUndefined();
    expect(useQueueStore.getState().inFlightQueuedMessages[thread.id]).toBeUndefined();
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(thread.id)).toBe(false);
    expect(useQueueStore.getState().queueGenerations[thread.id]).toBe(1);
    expect(releaseBrowserCaptureSpills).not.toHaveBeenCalled();

    useQueueStore.getState().settleQueuedDispatch(thread.id, claimed.id, false);

    expect(useQueueStore.getState().queues[thread.id]).toBeUndefined();
    expect(releaseBrowserCaptureSpills).toHaveBeenCalledWith(["browser-capture-spill/workspace-delete.json"]);
    expect(useQueueStore.getState().enqueue(thread.id, {
      content: "new queue after delete",
      displayContent: "new queue after delete",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    })).toBe(true);
    expect(useQueueStore.getState().claimNextQueuedMessage(thread.id)?.content).toBe("new queue after delete");
  });

  it("disposes queued leases when dismissing a preparing thread", () => {
    const ws = createMockWorkspace({ id: "workspace-dismiss-lease" });
    const thread = { ...createMockThread({ id: "thread-dismiss-lease", workspace_id: ws.id }), clientPreparing: true };
    useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, threads: [thread], activeThreadId: thread.id });
    const claimed = claimQueuedMessage(thread.id, "browser-capture-spill/preparing-dismiss.json");

    useWorkspaceStore.getState().dismissPreparingThread(thread.id);

    expect(useQueueStore.getState().queues[thread.id]).toBeUndefined();
    expect(useQueueStore.getState().inFlightQueuedMessages[thread.id]).toBeUndefined();
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(thread.id)).toBe(false);
    expect(useQueueStore.getState().queueGenerations[thread.id]).toBe(1);
    expect(releaseBrowserCaptureSpills).not.toHaveBeenCalled();

    useQueueStore.getState().settleQueuedDispatch(thread.id, claimed.id, false);

    expect(useQueueStore.getState().queues[thread.id]).toBeUndefined();
    expect(releaseBrowserCaptureSpills).toHaveBeenCalledWith(["browser-capture-spill/preparing-dismiss.json"]);
    expect(useQueueStore.getState().enqueue(thread.id, {
      content: "new queue after dismiss",
      displayContent: "new queue after dismiss",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    })).toBe(true);
  });

  it("does not dispatch from a Continue callback captured before workspace teardown", async () => {
    const ws = createMockWorkspace({ id: "workspace-stale-continue" });
    const thread = createMockThread({ id: "thread-stale-continue", workspace_id: ws.id });
    useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, threads: [thread], activeThreadId: thread.id });
    claimQueuedMessage(thread.id, "browser-capture-spill/stale-continue.json");
    useQueueStore.getState().settleQueuedDispatch(thread.id, useQueueStore.getState().inFlightQueuedMessages[thread.id]!.message.id, false);
    const { result } = renderHook(() => useQueuedMessageDispatch(thread.id));
    const staleContinue = result.current.resumeNext;

    await useWorkspaceStore.getState().deleteWorkspace(ws.id);
    await act(async () => {
      await staleContinue();
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
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
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockCreateAndSendResult(child),
    );

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
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockCreateAndSendResult(created),
    );

    await useWorkspaceStore.getState().createAndSendMessage("Hello", "composer-2-fast");

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "new-first-send")).toBe(true);

    listResolve([existing]);

    await listPromise;
    await Promise.resolve();

    expect(useWorkspaceStore.getState().threads.some((t) => t.id === "new-first-send")).toBe(true);
  });

  it("keeps saved cards in comment-only new and prompt-and-card branch creation transport", async () => {
    const workspace = createMockWorkspace({ id: "workspace-comments" });
    const created = createMockThread({ id: "thread-comments", workspace_id: workspace.id });
    const parent = createMockThread({ id: "parent-thread", workspace_id: workspace.id });
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createMockCreateAndSendResult(created))
      .mockResolvedValueOnce(createMockCreateAndSendResult(created));
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      newThreadMode: "direct",
      newThreadBranch: "main",
    });

    await useWorkspaceStore.getState().createAndSendMessage(
      "",
      "composer-2-fast",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      [],
      undefined,
      undefined,
      "standard",
      selectedTextComments,
      undefined,
      "automatic",
    );
    useWorkspaceStore.setState({ threads: [parent], activeThreadId: parent.id });
    await useWorkspaceStore.getState().branchThread({
      sourceThreadId: parent.id,
      content: "Continue from this point.",
      model: "composer-2-fast",
      mode: "direct",
      selectedTextComments,
    });

    const [newThreadCommand, branchCommand] = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(newThreadCommand?.[0]).toEqual(expect.objectContaining({
      content: "",
      selectedTextComments,
      approvalReviewMode: "automatic",
    }));
    expect(branchCommand?.[0]).toEqual(expect.objectContaining({
      content: "Continue from this point.",
      parentThreadId: parent.id,
      selectedTextComments,
    }));
  });

  it("when first send creates a real thread, the new thread does not inherit the threadless right panel", async () => {
    const ws = createMockWorkspace({ id: "ws-first-send-panel" });
    const created = createMockThread({
      id: "created-thread",
      workspace_id: ws.id,
      title: "New Thread",
    });
    let resolveRpc!: (value: CreateAndSendResult) => void;
    const rpcPromise = new Promise<CreateAndSendResult>((resolve) => {
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

    resolveRpc(createMockCreateAndSendResult(created));
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

  describe("selected conversation reconciliation after removal", () => {
    type RemovalPath = "workspace" | "preparing" | "client-only" | "persisted";

    async function removeThread(path: RemovalPath, threadId: string, workspaceId: string): Promise<void> {
      switch (path) {
        case "workspace":
          await useWorkspaceStore.getState().deleteWorkspace(workspaceId);
          return;
        case "preparing":
          useWorkspaceStore.getState().dismissPreparingThread(threadId);
          return;
        case "client-only":
        case "persisted":
          await useWorkspaceStore.getState().deleteThread(threadId, false);
      }
    }

    it.each<RemovalPath>(["workspace", "preparing", "client-only", "persisted"])(
      "does not reload the selected conversation after removing an unrelated %s",
      async (path) => {
        const activeWorkspace = createMockWorkspace({ id: "ws-active" });
        const removedWorkspace = createMockWorkspace({ id: "ws-removed" });
        const activeThread = createMockThread({ id: "thread-active", workspace_id: activeWorkspace.id });
        const removedThread = {
          ...createMockThread({ id: "thread-removed", workspace_id: path === "workspace" ? removedWorkspace.id : activeWorkspace.id }),
          ...(path === "preparing" || path === "client-only" ? { clientPreparing: true } : {}),
        };
        useWorkspaceStore.setState({
          workspaces: path === "workspace" ? [activeWorkspace, removedWorkspace] : [activeWorkspace],
          activeWorkspaceId: activeWorkspace.id,
          threads: [activeThread, removedThread],
          activeThreadId: activeThread.id,
        });

        await removeThread(path, path === "workspace" ? activeThread.id : removedThread.id, removedWorkspace.id);

        expect(useWorkspaceStore.getState().activeThreadId).toBe(activeThread.id);
      },
    );

    it.each<RemovalPath>(["workspace", "preparing", "client-only", "persisted"])(
      "deactivates the selected conversation after removing the selected %s",
      async (path) => {
        const workspace = createMockWorkspace({ id: "ws-selected" });
        const selectedThread = {
          ...createMockThread({ id: "thread-selected", workspace_id: workspace.id }),
          ...(path === "preparing" || path === "client-only" ? { clientPreparing: true } : {}),
        };
        useWorkspaceStore.setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [selectedThread],
          activeThreadId: selectedThread.id,
        });

        await removeThread(path, selectedThread.id, workspace.id);

        expect(useWorkspaceStore.getState().activeThreadId).toBeNull();
      },
    );
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
              runtimePhase: "running",
              turnExecutionId: "00000000-0000-4000-8000-000000000001",
            },
          ],
          ["other-thread", createEmptyThreadRecord()],
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
          ["t-keep", {
            ...createEmptyThreadRecord(),
            error: "keep error",
            runtimePhase: "running",
            turnExecutionId: "00000000-0000-4000-8000-000000000001",
          }],
          ["t-del", {
            ...createEmptyThreadRecord(),
            error: "del error",
            runtimePhase: "running",
            turnExecutionId: "00000000-0000-4000-8000-000000000002",
          }],
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
          [previewTabsScopeKey(ws.id, "t-preview")]: {
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
          [previewTabsScopeKey(ws.id, "t-preview")]: { title: "Example", url: "https://example.test", favicon: null },
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

      expect(usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey(ws.id, "t-preview")]).toBeUndefined();
      expect(usePreviewTabsStore.getState().liveChromeByScope[previewTabsScopeKey(ws.id, "t-preview")]).toBeUndefined();
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
          ["t-1", {
            ...createEmptyThreadRecord(),
            error: "err-1",
            streaming: "text-1",
            runtimePhase: "running",
            turnExecutionId: "00000000-0000-4000-8000-000000000001",
          }],
          ["t-2", {
            ...createEmptyThreadRecord(),
            error: "err-2",
            streaming: "text-2",
            runtimePhase: "running",
            turnExecutionId: "00000000-0000-4000-8000-000000000002",
          }],
          ["other-workspace-thread", createEmptyThreadRecord()],
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
    it.each(["direct", "worktree"] as const)(
      "retains the pending composer draft through a cancelled new %s creation until acknowledgement",
      async (mode) => {
        const ws = createMockWorkspace({ id: `ws-retain-${mode}` });
        const cancellation = new Error("Creation cancelled before acknowledgement");
        useWorkspaceStore.setState({
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          newThreadMode: mode,
          newThreadBranch: "main",
        });
        (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(cancellation)
          .mockResolvedValueOnce(createMockCreateAndSendResult({
            id: `persisted-${mode}`,
            workspace_id: ws.id,
          }));

        await expect(useWorkspaceStore.getState().createAndSendMessage(
          pendingComposerDraft.input,
          pendingComposerDraft.modelId,
          undefined,
          undefined,
          pendingComposerDraft.reasoning,
          pendingComposerDraft.provider,
          undefined,
          undefined,
          pendingComposerDraft.contextWindow,
          true,
          pendingComposerDraft.codexFastMode ?? undefined,
          pendingComposerDraft.input,
          pendingComposerDraft.mentions,
          undefined,
          undefined,
          undefined,
          pendingComposerDraft.selectedTextComments,
          pendingComposerDraft,
        )).rejects.toBe(cancellation);

        const placeholderId = useWorkspaceStore.getState().activeThreadId!;
        expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === placeholderId))
          .toMatchObject({ clientPreparing: false, clientError: String(cancellation) });
        expect(useComposerDraftStore.getState().getDraft(placeholderId)).toEqual(pendingComposerDraft);

        const editedComment = {
          ...selectedTextComments[0]!,
          note: "Use the edited comment.",
        };
        const editedDraft = {
          ...pendingComposerDraft,
          input: "Send the edited request.",
          selectedTextComments: [editedComment],
        };
        useComposerDraftStore.getState().saveDraft(placeholderId, editedDraft);

        await useWorkspaceStore.getState().retryPreparingThread(placeholderId);

        expect(useComposerDraftStore.getState().getDraft(placeholderId)).toBeUndefined();
        expect(mockTransport.createAndSendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
          content: editedDraft.input,
          displayContent: editedDraft.input,
          selectedTextComments: [editedComment],
        }));
      },
    );

    it("retains a branch composer draft through rejection until acknowledgement", async () => {
      const ws = createMockWorkspace({ id: "ws-retain-branch" });
      const parent = createMockThread({ id: "parent-retain-branch", workspace_id: ws.id });
      const rejection = new Error("Creation rejected before acknowledgement");
      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [parent],
      });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(createMockCreateAndSendResult({
          id: "persisted-branch",
          workspace_id: ws.id,
          parent_thread_id: parent.id,
        }));

      await expect(useWorkspaceStore.getState().branchThread({
        sourceThreadId: parent.id,
        content: pendingComposerDraft.input,
        displayContent: pendingComposerDraft.input,
        model: pendingComposerDraft.modelId,
        mode: "direct",
        selectedTextComments: pendingComposerDraft.selectedTextComments,
        composerDraft: pendingComposerDraft,
      })).rejects.toBe(rejection);

      const placeholderId = useWorkspaceStore.getState().activeThreadId!;
      expect(useComposerDraftStore.getState().getDraft(placeholderId)).toEqual(pendingComposerDraft);

      const commentOnlyDraft = {
        ...pendingComposerDraft,
        input: "",
        selectedTextComments: [{
          ...selectedTextComments[0]!,
          note: "Retry only this edited comment.",
        }],
      };
      useComposerDraftStore.getState().saveDraft(placeholderId, commentOnlyDraft);

      await useWorkspaceStore.getState().retryPreparingThread(placeholderId);

      expect(useComposerDraftStore.getState().getDraft(placeholderId)).toBeUndefined();
      expect(mockTransport.createAndSendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        content: "",
        displayContent: "",
        selectedTextComments: commentOnlyDraft.selectedTextComments,
      }));
    });

    it("keeps attachment preview ownership with the submitting composer after acknowledgement", async () => {
      const ws = createMockWorkspace({ id: "ws-preview-ownership" });
      const previewUrl = "blob:pending-preview";
      const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const draft = {
        ...pendingComposerDraft,
        attachments: [{
          id: "attachment-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 128,
          previewUrl,
          filePath: "C:/tmp/preview.png",
        }],
      };
      useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockCreateAndSendResult({ id: "persisted-preview", workspace_id: ws.id }),
      );

      await useWorkspaceStore.getState().createAndSendMessage(
        draft.input,
        draft.modelId,
        undefined,
        toComposerAttachmentMetas(draft.attachments),
        draft.reasoning,
        draft.provider,
        undefined,
        undefined,
        draft.contextWindow,
        true,
        draft.codexFastMode ?? undefined,
        draft.input,
        draft.mentions,
        undefined,
        undefined,
        undefined,
        draft.selectedTextComments,
        draft,
      );

      expect(revokeObjectUrl).not.toHaveBeenCalled();

      const retryPreviewUrl = "blob:retry-preview";
      const retryDraft = {
        ...draft,
        attachments: [{ ...draft.attachments[0]!, previewUrl: retryPreviewUrl }],
      };
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Creation failed"))
        .mockResolvedValueOnce(createMockCreateAndSendResult({
          id: "persisted-retry-preview",
          workspace_id: ws.id,
        }));
      await expect(useWorkspaceStore.getState().createAndSendMessage(
        retryDraft.input,
        retryDraft.modelId,
        undefined,
        toComposerAttachmentMetas(retryDraft.attachments),
        retryDraft.reasoning,
        retryDraft.provider,
        undefined,
        undefined,
        retryDraft.contextWindow,
        true,
        retryDraft.codexFastMode ?? undefined,
        retryDraft.input,
        retryDraft.mentions,
        undefined,
        undefined,
        undefined,
        retryDraft.selectedTextComments,
        retryDraft,
      )).rejects.toThrow("Creation failed");

      const placeholderId = useWorkspaceStore.getState().activeThreadId!;
      await useWorkspaceStore.getState().retryPreparingThread(placeholderId);

      expect(revokeObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith(retryPreviewUrl);
      revokeObjectUrl.mockRestore();
    });

    it.each(["dismiss", "workspace-removal"] as const)(
      "releases an abandoned placeholder draft on %s",
      async (abandonment) => {
        const ws = createMockWorkspace({ id: `ws-abandon-${abandonment}` });
        const previewUrl = `blob:${abandonment}`;
        const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const draft = {
          ...pendingComposerDraft,
          attachments: [{
            id: `attachment-${abandonment}`,
            name: "preview.png",
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl,
            filePath: "C:/tmp/preview.png",
          }],
        };
        useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
        (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
          .mockRejectedValue(new Error("Creation failed"));

        await expect(useWorkspaceStore.getState().createAndSendMessage(
          draft.input,
          draft.modelId,
          undefined,
          toComposerAttachmentMetas(draft.attachments),
          draft.reasoning,
          draft.provider,
          undefined,
          undefined,
          draft.contextWindow,
          true,
          draft.codexFastMode ?? undefined,
          draft.input,
          draft.mentions,
          undefined,
          undefined,
          undefined,
          draft.selectedTextComments,
          draft,
        )).rejects.toThrow("Creation failed");

        const placeholderId = useWorkspaceStore.getState().activeThreadId!;
        if (abandonment === "dismiss") {
          useWorkspaceStore.getState().dismissPreparingThread(placeholderId);
        } else {
          useWorkspaceStore.getState().removeWorkspaceFromState(ws.id);
        }

        expect(useComposerDraftStore.getState().getDraft(placeholderId)).toBeUndefined();
        expect(revokeObjectUrl).toHaveBeenCalledOnce();
        expect(revokeObjectUrl).toHaveBeenCalledWith(previewUrl);
        revokeObjectUrl.mockRestore();
      },
    );

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
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockCreateAndSendResult(created),
      );

      await useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");

      const command = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(command).toEqual({
        workspaceId: ws.id,
        startupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: "Hello",
        model: "gpt-5.5",
        permissionMode: undefined,
        mode: "worktree",
        branch: "main",
        worktreeBranchMode: undefined,
        existingWorktreePath: "/repo/.worktrees/branchless-existing",
        existingWorktreeBaseBranch: "main",
        attachments: undefined,
        reasoningLevel: undefined,
        provider: undefined,
        interactionMode: undefined,
        parentThreadId: undefined,
        forkedFromMessageId: undefined,
        copilotAgent: undefined,
        contextWindow: undefined,
        thinking: undefined,
        codexFastMode: undefined,
        displayContent: undefined,
        mentions: undefined,
        previewAnnotations: undefined,
        goalObjective: undefined,
        orchestrationMode: undefined,
      });
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

    it("createAndSendMessage requests a named worktree for a PR-selected branch", async () => {
      const ws = createMockWorkspace({ id: "ws-pr-branch" });
      let resolveRpc!: (value: ReturnType<typeof createMockThread>) => void;
      const rpcPromise = new Promise<ReturnType<typeof createMockThread>>((resolve) => {
        resolveRpc = resolve;
      });

      useWorkspaceStore.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        newThreadMode: "worktree",
      });
      useWorkspaceStore.getState().setNewThreadBranchFromPr("contributor/pr-branch", 42);
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const done = useWorkspaceStore.getState().createAndSendMessage("Review this", "gpt-5.5");
      await Promise.resolve();

      expect(useWorkspaceStore.getState().threads[0]).toMatchObject({
        mode: "worktree",
        branch: "contributor/pr-branch",
        checkout_state: "named",
        base_branch: null,
      });

      const command = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(command).toEqual({
        workspaceId: ws.id,
        startupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: "Review this",
        model: "gpt-5.5",
        permissionMode: undefined,
        mode: "worktree",
        branch: "contributor/pr-branch",
        pullRequestNumber: 42,
        worktreeBranchMode: "named",
        existingWorktreePath: undefined,
        existingWorktreeBaseBranch: undefined,
        attachments: undefined,
        reasoningLevel: undefined,
        provider: undefined,
        interactionMode: undefined,
        parentThreadId: undefined,
        forkedFromMessageId: undefined,
        copilotAgent: undefined,
        contextWindow: undefined,
        thinking: undefined,
        codexFastMode: undefined,
        displayContent: undefined,
        mentions: undefined,
        previewAnnotations: undefined,
        goalObjective: undefined,
        orchestrationMode: undefined,
      });
      expect(useWorkspaceStore.getState().newThreadBranchSource).toBe("branch");
      expect(useWorkspaceStore.getState().newThreadPullRequestNumber).toBeUndefined();

      resolveRpc(createMockCreateAndSendResult({
        id: "pr-branch-thread",
        workspace_id: ws.id,
        mode: "worktree",
        branch: "contributor/pr-branch",
        checkout_state: "named",
        base_branch: null,
      }));
      await done;
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

      const command = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(command).toEqual({
        workspaceId: ws.id,
        startupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: "Hello",
        model: "gpt-5.5",
        permissionMode: undefined,
        mode: "worktree",
        branch: "feat/existing",
        worktreeBranchMode: undefined,
        existingWorktreePath: "/repo/.worktrees/feature-existing",
        existingWorktreeBaseBranch: undefined,
        attachments: undefined,
        reasoningLevel: undefined,
        provider: undefined,
        interactionMode: undefined,
        parentThreadId: undefined,
        forkedFromMessageId: undefined,
        copilotAgent: undefined,
        contextWindow: undefined,
        thinking: undefined,
        codexFastMode: undefined,
        displayContent: undefined,
        mentions: undefined,
        previewAnnotations: undefined,
        goalObjective: undefined,
        orchestrationMode: undefined,
      });

      resolveRpc(createMockCreateAndSendResult({
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
      expectPreparedCodexThread(mid.threads[0]);
      expect(mid.threads[0]?.clientStartupId).toBe(mid.activeThreadId);

      const created = createMockThread({
        id: "server-thread-1",
        workspace_id: ws.id,
        title: "Hello world",
        model: null,
        provider: "claude",
        reasoning_level: null,
      });
      resolveRpc(createMockCreateAndSendResult(created));
      await done;

      const fin = useWorkspaceStore.getState();
      expect(fin.threads.some((t) => t.id === "server-thread-1")).toBe(true);
      expect(fin.activeThreadId).toBe("server-thread-1");
      expect(fin.threads[0]?.model).toBe("gpt-5.5");
      expect(fin.threads[0]?.provider).toBe("codex");
      expect(fin.threads[0]?.reasoning_level).toBe("high");
      expect(fin.threads[0]?.clientStartupId).toBe(mid.activeThreadId);
    });

    it("keeps the startup identity after an early cancellation rejects optimistic creation", async () => {
      const ws = createMockWorkspace({ id: "ws-cancelled-startup" });
      useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Thread startup was cancelled"));

      await expect(useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5")).rejects.toThrow("Thread startup was cancelled");

      expect(useWorkspaceStore.getState().threads[0]).toMatchObject({
        clientPreparing: false,
        clientError: "Error: Thread startup was cancelled",
        clientStartupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    });

    it("transfers placeholder runtime identity and narrative state to the persisted first turn", async () => {
      const ws = createMockWorkspace({ id: "ws-runtime-transfer" });
      let resolveRpc!: (value: CreateAndSendResult) => void;
      const rpcPromise = new Promise<CreateAndSendResult>((resolve) => {
        resolveRpc = resolve;
      });
      useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const sendOp = useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");
      await Promise.resolve();
      const placeholderId = useWorkspaceStore.getState().activeThreadId!;
      const toolCall = {
        id: "tool-1",
        toolName: "Read",
        input: "file.ts",
        output: "",
        isComplete: false,
      } as never;
      useThreadStore.setState((state) => ({
        records: patchThreadRecord(state.records, placeholderId, {
          runtimePhase: "running",
          turnExecutionId: null,
          currentTurnResponseKey: "response-placeholder",
          streaming: "thinking",
          thoughtSegments: [{ id: "thought-1", text: "thinking" } as never],
          toolCalls: [toolCall],
          agentStartTime: 123,
        }),
      }));

      resolveRpc(createMockCreateAndSendResult({ id: "persisted-runtime", workspace_id: ws.id, title: "Hello" }, {
        turnExecutionId: "authoritative-first-turn",
      }));
      await sendOp;

      const record = useThreadStore.getState().records.get("persisted-runtime");
      expect(useWorkspaceStore.getState().activeThreadId).toBe("persisted-runtime");
      expect(useThreadStore.getState().runningThreadIds.has("persisted-runtime")).toBe(true);
      expect(record?.runtimePhase).toBe("running");
      expect(record?.turnExecutionId).toBe("authoritative-first-turn");
      expect(record?.currentTurnResponseKey).toBe("response-placeholder");
      expect(record?.streaming).toBe("thinking");
      expect(record?.thoughtSegments).toHaveLength(1);
      expect(record?.toolCalls).toHaveLength(1);
      expect(useThreadStore.getState().records.has(placeholderId)).toBe(false);

      useThreadStore.getState().handleAgentEvent({
        type: "turnComplete",
        threadId: "persisted-runtime",
        turnExecutionId: "stale-first-turn",
      } as never);
      expect(useThreadStore.getState().runningThreadIds.has("persisted-runtime")).toBe(true);

      useThreadStore.getState().handleAgentEvent({
        type: "turnComplete",
        threadId: "persisted-runtime",
        turnExecutionId: "authoritative-first-turn",
      } as never);
      expect(useThreadStore.getState().runningThreadIds.has("persisted-runtime")).toBe(false);
      expect(useThreadStore.getState().records.get("persisted-runtime")?.runtimePhase).toBe("completed");
    });

    it("keeps newer persisted runtime identity and fields during the handoff", async () => {
      const ws = createMockWorkspace({ id: "ws-runtime-authoritative" });
      let resolveRpc!: (value: CreateAndSendResult) => void;
      const rpcPromise = new Promise<CreateAndSendResult>((resolve) => {
        resolveRpc = resolve;
      });
      useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockReturnValue(rpcPromise);

      const sendOp = useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");
      await Promise.resolve();
      const placeholderId = useWorkspaceStore.getState().activeThreadId!;
      const persistedTool = {
        id: "server-tool",
        toolName: "Read",
        input: "server.ts",
        output: "done",
        isComplete: true,
      } as never;
      useThreadStore.setState((state) => ({
        records: patchThreadRecord(
          patchThreadRecord(state.records, placeholderId, {
            runtimePhase: "running",
            turnExecutionId: "stale-placeholder-turn",
            streaming: "stale thinking",
            toolCalls: [{ id: "placeholder-tool" } as never],
          }),
          "persisted-authoritative",
          {
            runtimePhase: "finalizing",
            turnExecutionId: "authoritative-turn",
            currentTurnResponseKey: "authoritative-response",
            streaming: "authoritative response",
            toolCalls: [persistedTool],
            lastAgentEventSequence: 4,
            lastAgentEventEpoch: "server-epoch",
          },
        ),
      }));

      resolveRpc(createMockCreateAndSendResult(
        { id: "persisted-authoritative", workspace_id: ws.id, title: "Hello" },
        { phase: "finalizing", turnExecutionId: "authoritative-turn" },
      ));
      await sendOp;

      const record = useThreadStore.getState().records.get("persisted-authoritative");
      expect(record?.runtimePhase).toBe("finalizing");
      expect(record?.turnExecutionId).toBe("authoritative-turn");
      expect(record?.currentTurnResponseKey).toBe("authoritative-response");
      expect(record?.streaming).toBe("authoritative response");
      expect(record?.toolCalls).toEqual([persistedTool]);
      expect(record?.toolCalls).not.toContainEqual({ id: "placeholder-tool" });
      expect(record?.lastAgentEventSequence).toBe(4);
      expect(record?.lastAgentEventEpoch).toBe("server-epoch");
      expect(useThreadStore.getState().runningThreadIds.has("persisted-authoritative")).toBe(true);
      expect(useThreadStore.getState().records.has(placeholderId)).toBe(false);
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
      expectPreparedBranchThread(mid.threads[0], parent.id);

      resolveRpc(createMockCreateAndSendResult({
        id: "child-branch",
        workspace_id: ws.id,
        parent_thread_id: parent.id,
        model: null,
        reasoning_level: null,
      }));
      await done;

      const fin = useWorkspaceStore.getState();
      expect(fin.activeThreadId).toBe("child-branch");
      expectPersistedBranchSettings(fin.threads[0]);
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
      (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockCreateAndSendResult(created),
      );

      await useWorkspaceStore.getState().branchThread({
        sourceThreadId: parent.id,
        content: "Branch this",
        model: "gpt-5.5",
        mode: "existing-worktree",
        branch: "main",
        existingWorktreePath: "C:\\repo\\.worktrees\\branchless-existing\\",
      });

      const command = (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(command).toEqual({
        workspaceId: ws.id,
        startupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: "Branch this",
        model: "gpt-5.5",
        permissionMode: undefined,
        mode: "worktree",
        branch: "main",
        worktreeBranchMode: undefined,
        existingWorktreePath: "C:\\repo\\.worktrees\\branchless-existing\\",
        existingWorktreeBaseBranch: "main",
        attachments: undefined,
        reasoningLevel: undefined,
        provider: undefined,
        interactionMode: undefined,
        parentThreadId: parent.id,
        forkedFromMessageId: undefined,
        copilotAgent: undefined,
        contextWindow: undefined,
        thinking: undefined,
        codexFastMode: undefined,
        displayContent: undefined,
        mentions: undefined,
        previewAnnotations: undefined,
        goalObjective: undefined,
        orchestrationMode: undefined,
      });
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
        createMockCreateAndSendResult({ id: "server-thread-2", workspace_id: ws.id, title: "Hi" }),
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

      resolveRpc(createMockCreateAndSendResult({ id: "real-new", workspace_id: ws.id, title: "New" }));
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

