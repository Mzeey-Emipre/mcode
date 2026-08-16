import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkspaceStore, type WorkspaceRpcCall } from "../workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import type { Workspace } from "@/transport/types";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import * as conversationResidency from "@/features/conversation/residency/conversation-residency";
import type { ConversationResidency } from "@/features/conversation/residency/conversation-residency";

function makeWs(overrides?: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    name: "test",
    path: "/tmp/test",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: null,
    sort_order: 0,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceStore.setState({ workspaces: [makeWs()], activeWorkspaceId: null });
  useDiffStore.setState({
    rightPanelByThread: {},
    rightPanelFallbackByWorkspace: {},
  });
});

describe("workspaceStore pin/remove/touch", () => {
  it("setActiveWorkspace calls touchLastOpened RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().setActiveWorkspace("ws-1", call as unknown as WorkspaceRpcCall);
    expect(call).toHaveBeenCalledWith("workspace.touchLastOpened", { id: "ws-1" });
  });

  it("pinWorkspace updates local state optimistically and calls RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(true);
    expect(call).toHaveBeenCalledWith("workspace.pin", { id: "ws-1", pinned: true });
  });

  it("pinWorkspace reverts on RPC failure", async () => {
    const call = vi.fn().mockRejectedValue(new Error("network error"));
    try {
      await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    } catch { /* expected */ }
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(false);
  });

  it("removeRecent updates local state optimistically and calls RPC", async () => {
    useWorkspaceStore.setState({
      workspaces: [makeWs({ last_opened_at: Date.now(), pinned: true })],
    });
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().removeRecent("ws-1", call as unknown as WorkspaceRpcCall);
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.last_opened_at).toBeNull();
    expect(ws.pinned).toBe(false);
    expect(call).toHaveBeenCalledWith("workspace.removeRecent", { id: "ws-1" });
  });
});

describe("workspaceStore reorderWorkspace", () => {
  it("splices order locally and calls workspace.reorder with the bounded index", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWs({ id: "a", name: "a", sort_order: 0 }),
        makeWs({ id: "b", name: "b", sort_order: 1 }),
        makeWs({ id: "c", name: "c", sort_order: 2 }),
      ],
    });
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().reorderWorkspace("c", 0, call as unknown as WorkspaceRpcCall);
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(call).toHaveBeenCalledWith("workspace.reorder", { id: "c", newIndex: 0 });
  });

  it("reverts workspaces order when RPC fails", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWs({ id: "a", name: "a", sort_order: 0 }),
        makeWs({ id: "b", name: "b", sort_order: 1 }),
      ],
    });
    const call = vi.fn().mockRejectedValue(new Error("offline"));
    try {
      await useWorkspaceStore.getState().reorderWorkspace("b", 0, call as unknown as WorkspaceRpcCall);
    } catch { /* expected */ }
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(useWorkspaceStore.getState().error).toMatch(/offline/);
  });
});

describe("workspaceStore new-thread panel transition", () => {
  it("activates a selected resident thread before returning to the event loop", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    useWorkspaceStore.setState({
      threads: [
        { id: "thread-a" } as WorkspaceThread,
        { id: "thread-b" } as WorkspaceThread,
      ],
      activeThreadId: "thread-a",
    });

    useWorkspaceStore.getState().setActiveThread("thread-b");

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("thread-b", expect.any(Array));
    residencySpy.mockRestore();
  });

  it("coalesces non-selection reconciliation until the microtask boundary", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    const touch = vi.fn().mockResolvedValue(undefined) as unknown as WorkspaceRpcCall;
    useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null });

    useWorkspaceStore.getState().setActiveWorkspace("ws-1", touch, false);
    useWorkspaceStore.getState().setActiveWorkspace(null, touch, false);

    expect(activate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(null, expect.any(Array));
    residencySpy.mockRestore();
  });

  it("cancels stale reconciliation after workspace selection but allows a later reconcile", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    const touch = vi.fn().mockResolvedValue(undefined) as unknown as WorkspaceRpcCall;
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      activeThreadId: "thread-a",
      threads: [
        { id: "thread-a", workspace_id: "ws-1" } as WorkspaceThread,
        { id: "thread-b", workspace_id: "ws-1" } as WorkspaceThread,
      ],
    });

    useWorkspaceStore.getState().setActiveWorkspace("ws-1", touch, false);
    useWorkspaceStore.getState().setActiveThread("thread-b");

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenLastCalledWith("thread-b", expect.any(Array));

    useWorkspaceStore.getState().setActiveWorkspace(null, touch, false);
    await Promise.resolve();

    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith(null, expect.any(Array));
    residencySpy.mockRestore();
  });

  it("opens the projectless composer without inventing a workspace", () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      activeThreadId: "thread-1",
      pendingNewThread: false,
    });

    useWorkspaceStore.getState().beginNewThread();

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: null,
      activeThreadId: null,
      pendingNewThread: true,
    });
  });

  it("enters a clean pending composer with the last selected mode", () => {
    rememberComposerMode("existing-worktree");
    useWorkspaceStore.setState({
      workspaces: [makeWs(), makeWs({ id: "ws-2", name: "second" })],
      activeWorkspaceId: "ws-2",
      activeThreadId: "thread-1",
      pendingNewThread: false,
      newThreadMode: "worktree",
      newThreadBranch: "feature/old",
    });

    useWorkspaceStore.getState().beginNewThread("ws-2");

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: "ws-2",
      activeThreadId: null,
      pendingNewThread: true,
      newThreadMode: "existing-worktree",
      newThreadBranch: "",
    });
  });

  it("closes the threadless right panel without clearing the active thread panel", () => {
    useWorkspaceStore.setState({
      workspaces: [makeWs()],
      activeWorkspaceId: "ws-1",
      activeThreadId: "thread-1",
    });
    const diff = useDiffStore.getState();
    diff.showRightPanel("ws-1", null);
    diff.setRightPanelTab("ws-1", null, "preview");
    diff.showRightPanel("ws-1", "thread-1");
    diff.setRightPanelTab("ws-1", "thread-1", "changes");

    useWorkspaceStore.getState().setPendingNewThread(true);

    expect(diff.getRightPanelVisible("ws-1", null)).toBe(false);
    expect(diff.getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTab: "changes",
      openTabs: expect.arrayContaining(["changes"]),
    });
  });
});
