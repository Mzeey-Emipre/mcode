import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspaceStore";
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
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      threads: [],
      activeThreadId: null,
      loading: false,
      error: null,
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
});
