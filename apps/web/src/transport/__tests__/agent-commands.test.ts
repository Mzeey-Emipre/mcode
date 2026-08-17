import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAndSendInput, SendMessageInput } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { createWsTransport } from "../ws-transport";

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  readonly sent: string[] = [];

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  respond(id: string, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }
}

let mockWs: MockWebSocket;

beforeEach(() => {
  useSettingsStore.setState({ loaded: false });
  vi.stubGlobal(
    "WebSocket",
    new Proxy(MockWebSocket, {
      construct(Target) {
        mockWs = new Target();
        return mockWs;
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent command transport", () => {
  it("sends completed-thread cleanup count and retry commands", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    mockWs.simulateOpen();

    const countPending = transport.countBlockedThreadCleanupCandidates();
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "thread.cleanupBlockedCount")).toBe(true);
    });
    const countRequest = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "thread.cleanupBlockedCount");
    expect(countRequest?.params).toEqual({});
    mockWs.respond(countRequest!.id, { count: 2 });
    await expect(countPending).resolves.toEqual({ count: 2 });

    const retryPending = transport.retryThreadCleanup("thread-1");
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "thread.retryCleanup")).toBe(true);
    });
    const retryRequest = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "thread.retryCleanup");
    expect(retryRequest?.params).toEqual({ threadId: "thread-1" });
    mockWs.respond(retryRequest!.id, { id: "thread-1" });
    await expect(retryPending).resolves.toEqual({ id: "thread-1" });
    transport.close();
  });

  it("sends provider catalog context through the typed RPC method", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    mockWs.simulateOpen();
    const requestParams = {
      providerId: "codex" as const,
      workspaceId: "workspace-1",
      threadId: "thread-1",
    };

    const pending = transport.getProviderCatalog(requestParams);
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "provider.catalog")).toBe(true);
    });
    const request = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "provider.catalog");

    expect(request?.params).toEqual(requestParams);
    const snapshot = {
      providerId: "codex",
      context: { scope: "workspace", workspaceId: "workspace-1", threadId: "thread-1" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [],
      selectableAgents: [],
    };
    mockWs.respond(request!.id, snapshot);
    await expect(pending).resolves.toEqual(snapshot);
    transport.close();
  });

  it("sends the typed existing-thread command without changing its RPC fields", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    mockWs.simulateOpen();

    const command = {
      threadId: "thread-1",
      content: "Inspect this change",
      displayContent: "Inspect this change",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "high",
      provider: "codex",
      interactionMode: "build",
      contextWindow: "200k",
      thinking: false,
      codexFastMode: true,
      replyToMessageId: "6b2cf031-4c42-4fe4-8dc0-938756cd31dd",
      quotedText: "Original request",
      mentions: [],
    } satisfies SendMessageInput;

    const pending = transport.sendMessage(command);
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "agent.send")).toBe(true);
    });
    const request = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "agent.send");

    expect(request?.params).toEqual(command);
    mockWs.respond(request!.id, null);
    await pending;
    transport.close();
  });

  it("preserves omission of empty reply metadata", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    mockWs.simulateOpen();

    const pending = transport.sendMessage({
      threadId: "thread-1",
      content: "Continue",
      replyToMessageId: "",
      quotedText: "",
    });
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "agent.send")).toBe(true);
    });
    const request = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "agent.send");

    expect(request?.params).toEqual({ threadId: "thread-1", content: "Continue" });
    mockWs.respond(request!.id, null);
    await pending;
    transport.close();
  });

  it("sends the typed new-thread command without changing its RPC fields", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    mockWs.simulateOpen();

    const command = {
      workspaceId: "workspace-1",
      content: "Start in isolation",
      displayContent: "Start in isolation",
      model: "gpt-5",
      permissionMode: "full",
      mode: "worktree",
      branch: "main",
      worktreeBranchMode: "branchless",
      reasoningLevel: "high",
      provider: "codex",
      interactionMode: "build",
      contextWindow: "200k",
      thinking: false,
      codexFastMode: true,
      mentions: [],
    } satisfies CreateAndSendInput;

    const pending = transport.createAndSendMessage(command);
    await vi.waitFor(() => {
      expect(mockWs.sent.some((row) => JSON.parse(row).method === "agent.createAndSend")).toBe(true);
    });
    const request = mockWs.sent
      .map((row) => JSON.parse(row) as { id: string; method: string; params: unknown })
      .find((row) => row.method === "agent.createAndSend");

    expect(request?.params).toEqual(command);
    mockWs.respond(request!.id, { thread: {}, handoff: null });
    await pending;
    transport.close();
  });
});
