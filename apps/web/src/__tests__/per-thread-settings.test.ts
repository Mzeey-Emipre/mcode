import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, TOOL_CALL_CACHE_SIZE } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { LruCache } from "@/lib/lru-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("per-thread settings", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      currentThreadId: null,
      persistedToolCallCounts: {},
      serverMessageIds: {},
      toolCallRecordCache: new LruCache(TOOL_CALL_CACHE_SIZE),
      currentTurnMessageIdByThread: {},
      agentStartTimes: {},
      settingsByThread: {},
      activeSubagentsByThread: {},
      oldestLoadedSequence: {},
      hasMoreMessages: {},
      isLoadingMore: {},
      loadEpochByThread: {},
    });
    useWorkspaceStore.setState({ threads: [] });
    vi.clearAllMocks();
  });

  it("hydrates from DB-persisted thread fields when no in-memory override exists", () => {
    const thread = createMockThread({
      id: "thread-db",
      reasoning_level: "max",
      interaction_mode: "plan",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    const settings = useThreadStore.getState().getThreadSettings("thread-db");

    expect(settings.reasoningLevel).toBe("max");
    expect(settings.interactionMode).toBe("plan");
    expect(settings.permissionMode).toBe("supervised");
  });

  it("falls back to global defaults when all thread settings are null", () => {
    const thread = createMockThread({
      id: "thread-null",
      reasoning_level: null,
      interaction_mode: null,
      permission_mode: null,
    });
    useWorkspaceStore.setState({ threads: [thread] });

    const settings = useThreadStore.getState().getThreadSettings("thread-null");

    expect(settings.interactionMode).toBe("chat");
    expect(settings.permissionMode).toBe("full");
    expect(settings.reasoningLevel).toBeUndefined();
  });

  it("in-memory override takes precedence over DB-persisted values", () => {
    const thread = createMockThread({
      id: "thread-override",
      reasoning_level: "max",
      interaction_mode: "plan",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    // Apply an in-memory override
    useThreadStore.setState({
      settingsByThread: {
        "thread-override": {
          permissionMode: "full",
          interactionMode: "chat",
          reasoningLevel: undefined,
        },
      },
    });

    const settings = useThreadStore.getState().getThreadSettings("thread-override");

    expect(settings.permissionMode).toBe("full");
    expect(settings.interactionMode).toBe("chat");
    expect(settings.reasoningLevel).toBeUndefined();
  });

  it("setThreadSettings persists to server via updateThreadSettings RPC", async () => {
    const thread = createMockThread({ id: "thread-rpc" });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-rpc", {
      permissionMode: "supervised",
    });

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("thread-rpc", {
      permissionMode: "supervised",
    });
  });
});
