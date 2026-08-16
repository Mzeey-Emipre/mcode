/**
 * Verifies that the thread list is refreshed after a WebSocket reconnect,
 * so that statuses updated on the server during a restart (e.g., "interrupted")
 * are reflected in the client without a full page reload.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { createWsTransport } from "@/transport/ws-transport";
import { mockTransport, createMockWorkspace, createMockThread } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

class ReconnectWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;

  send(data: string): void {
    const request = JSON.parse(data) as { id: string; method: string };
    const result = request.method === "agent.listRunning" || request.method === "terminal.listActive"
      ? []
      : null;
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
    });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

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

  it("revalidates the selected conversation without replacing resident rows on failure", async () => {
    const thread = createMockThread({ workspace_id: ws.id, status: "active" });
    useWorkspaceStore.setState({ threads: [thread], activeThreadId: thread.id });
    useThreadStore.setState({
      currentThreadId: thread.id,
      records: new Map([[thread.id, {
        ...createEmptyThreadRecord(),
        messages: [{ id: "resident", thread_id: thread.id, role: "assistant", content: "Kept", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
      }]]),
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));

    await useWorkspaceStore.getState().refreshActiveConversation();

    expect(useThreadStore.getState().records.get(thread.id)?.messages[0]?.content).toBe("Kept");
  });

  it("refreshes the selected conversation on every reconnect while throttling thread lists", async () => {
    vi.useFakeTimers();
    const sockets: ReconnectWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      new Proxy(ReconnectWebSocket, {
        construct(Target) {
          const socket = new Target();
          sockets.push(socket);
          return socket;
        },
      }),
    );
    const thread = createMockThread({ workspace_id: ws.id, status: "active" });
    useWorkspaceStore.setState({
      threads: [thread],
      activeWorkspaceId: ws.id,
      activeThreadId: thread.id,
    });
    (mockTransport.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([thread]);
    const transport = createWsTransport("ws://localhost:1234");

    try {
      sockets[0]?.open();
      await vi.waitFor(() => {
        expect(mockTransport.listThreads).toHaveBeenCalledTimes(1);
      });

      sockets[0]?.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[1]?.open();
      await vi.waitFor(() => {
        expect(mockTransport.listThreads).toHaveBeenCalledTimes(1);
      });
      sockets[1]?.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[2]?.open();
      await vi.waitFor(() => {
        expect(mockTransport.listThreads).toHaveBeenCalledTimes(1);
      });
    } finally {
      transport.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
