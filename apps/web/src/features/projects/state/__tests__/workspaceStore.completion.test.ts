import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@mcode/contracts";

const {
  completeThread,
  reopenThread,
  clearScope,
  clearPreviewReferences,
  releaseBrowserScope,
} = vi.hoisted(() => ({
  completeThread: vi.fn(),
  reopenThread: vi.fn(),
  clearScope: vi.fn().mockResolvedValue(undefined),
  clearPreviewReferences: vi.fn(),
  releaseBrowserScope: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ completeThread, reopenThread }),
}));
vi.mock("@/stores/previewTabsStore", () => ({
  usePreviewTabsStore: { getState: () => ({ clearScope }) },
}));
vi.mock("@/stores/previewReferenceQueueStore", () => ({
  usePreviewReferenceQueueStore: {
    getState: () => ({ clearThread: clearPreviewReferences }),
  },
}));
vi.mock("@/stores/browserAutomationStore", () => ({
  releaseBrowserAutomationThreadScope: releaseBrowserScope,
  releaseBrowserAutomationWorkspaceScopes: vi.fn(),
}));

import { useTerminalStore } from "@/stores/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "../workspaceStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Lifecycle thread",
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    has_file_changes: false,
    sdk_session_id: null,
    created_at: "2026-08-12T08:00:00.000Z",
    updated_at: "2026-08-12T08:00:00.000Z",
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    ...overrides,
  };
}

describe("workspaceStore completion lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    useWorkspaceStore.setState({ threads: [makeThread()], error: null });
  });

  it("applies server completion before releasing renderer-owned resources", async () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    completeThread.mockResolvedValue(completed);
    const clearTerminal = vi.spyOn(useTerminalStore.getState(), "clearThread");

    await useWorkspaceStore.getState().completeThread(completed.id);

    expect(completeThread).toHaveBeenCalledWith(completed.id);
    expect(useWorkspaceStore.getState().threads[0]).toMatchObject(completed);
    expect(releaseBrowserScope).toHaveBeenCalledWith("workspace-1", completed.id);
    expect(clearScope).toHaveBeenCalledWith("workspace-1", completed.id);
    expect(clearPreviewReferences).toHaveBeenCalledWith(completed.id);
    expect(clearTerminal).toHaveBeenCalledWith(completed.id);
  });

  it("closes every right-panel tab without changing the workspace fallback", async () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    completeThread.mockResolvedValue(completed);
    const panelStore = useDiffStore.getState();
    panelStore.showRightPanel("workspace-1", null);
    panelStore.setRightPanelTab("workspace-1", null, "changes");
    panelStore.showRightPanel("workspace-1", completed.id);
    panelStore.setRightPanelTab("workspace-1", completed.id, "preview");
    panelStore.addRightPanelTerminalTab("workspace-1", completed.id, "pty-1");

    await useWorkspaceStore.getState().completeThread(completed.id);

    expect(useDiffStore.getState().getRightPanel("workspace-1", completed.id)).toMatchObject({
      visible: false,
      openTabs: [],
      tabInstances: [],
      activeTabId: null,
    });
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["changes"],
    });
  });

  it("clears tabs from a hidden panel and tolerates a repeated completion event", () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    const panelStore = useDiffStore.getState();
    panelStore.setRightPanelTab("workspace-1", completed.id, "preview");
    panelStore.addRightPanelTerminalTab("workspace-1", completed.id, "pty-1");

    useWorkspaceStore.getState().applyThreadLifecycle(completed);
    useWorkspaceStore.getState().applyThreadLifecycle(completed);

    expect(useDiffStore.getState().getRightPanel("workspace-1", completed.id)).toMatchObject({
      visible: false,
      openTabs: [],
      tabInstances: [],
      activeTabId: null,
    });
  });

  it("keeps panel resources when the server rejects completion", async () => {
    completeThread.mockRejectedValueOnce(new Error("completion rejected"));
    const panelStore = useDiffStore.getState();
    panelStore.showRightPanel("workspace-1", "thread-1");
    panelStore.setRightPanelTab("workspace-1", "thread-1", "preview");

    await expect(useWorkspaceStore.getState().completeThread("thread-1")).rejects.toThrow(
      "completion rejected",
    );

    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      visible: true,
      openTabs: ["preview"],
    });
    expect(releaseBrowserScope).not.toHaveBeenCalled();
    expect(clearScope).not.toHaveBeenCalled();
  });

  it("reopens without clearing preserved renderer state", async () => {
    const reopened = makeThread();
    useWorkspaceStore.setState({
      threads: [makeThread({
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      })],
    });
    reopenThread.mockResolvedValue(reopened);

    await useWorkspaceStore.getState().reopenThread(reopened.id);

    expect(reopenThread).toHaveBeenCalledWith(reopened.id);
    expect(useWorkspaceStore.getState().threads[0]).toMatchObject(reopened);
    expect(clearScope).not.toHaveBeenCalled();
  });
});
