/**
 * Verifies that the thread list is refreshed after a WebSocket reconnect,
 * so that statuses updated on the server during a restart (e.g., "interrupted")
 * are reflected in the client without a full page reload.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockWorkspace, createMockThread } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("thread status refresh after reconnect", () => {
  const ws = createMockWorkspace();

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      threads: [],
      activeThreadId: null,
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it("replaces stale 'active' status with 'interrupted' from the server after loadThreads", async () => {
    // Simulate pre-restart client state: thread is active
    const thread = createMockThread({ workspace_id: ws.id, status: "active" });
    useWorkspaceStore.setState({ threads: [thread] });

    // Server returns the same thread marked interrupted (set during graceful shutdown)
    const interruptedThread = { ...thread, status: "interrupted" as const };
    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([interruptedThread]);

    // This is what ws-transport.ts calls in the ws.onopen handler after reconnect
    await useWorkspaceStore.getState().loadThreads(ws.id);

    const updated = useWorkspaceStore.getState().threads.find((t) => t.id === thread.id);
    expect(updated?.status).toBe("interrupted");
  });

  it("loadThreads on reconnect does not clobber threads from other workspaces", async () => {
    const otherWs = createMockWorkspace();
    const myThread = createMockThread({ workspace_id: ws.id, status: "active" });
    const otherThread = createMockThread({ workspace_id: otherWs.id, status: "active" });

    useWorkspaceStore.setState({ threads: [myThread, otherThread] });

    // Server returns only the active workspace's threads
    const fresh = { ...myThread, status: "interrupted" as const };
    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([fresh]);

    await useWorkspaceStore.getState().loadThreads(ws.id);

    const threads = useWorkspaceStore.getState().threads;
    expect(threads.find((t) => t.id === myThread.id)?.status).toBe("interrupted");
    // Other workspace's thread is preserved unchanged
    expect(threads.find((t) => t.id === otherThread.id)?.status).toBe("active");
  });

  it("restores the unchanged selected conversation after a reconnect row refresh", async () => {
    const thread = createMockThread({ workspace_id: ws.id, status: "active" });
    const originalLoadMessages = useThreadStore.getState().loadMessages;
    const loadMessages = vi.fn().mockResolvedValue(undefined);
    useThreadStore.setState({ loadMessages });
    useWorkspaceStore.setState({ threads: [thread], activeThreadId: thread.id });
    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...thread, status: "interrupted" as const },
    ]);

    try {
      await useWorkspaceStore.getState().loadThreads(ws.id);

      expect(loadMessages).toHaveBeenCalledWith(thread.id);
    } finally {
      useThreadStore.setState({ loadMessages: originalLoadMessages });
    }
  });
});
