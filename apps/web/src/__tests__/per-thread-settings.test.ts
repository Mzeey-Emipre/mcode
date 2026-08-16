import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { mockTransport, createMockThread } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("per-thread settings", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      currentThreadId: null,
      runningThreadIds: new Set(),
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

    expect(settings.interactionMode).toBe("build");
    expect(settings.permissionMode).toBe("full");
    expect(settings.reasoningLevel).toBeUndefined();
    expect(settings.codexFastMode).toBeNull();
  });

  it("hydrates codex_fast_mode from the thread row", () => {
    const thread = createMockThread({
      id: "thread-codex",
      codex_fast_mode: true,
    });
    useWorkspaceStore.setState({ threads: [thread] });
    expect(useThreadStore.getState().getThreadSettings("thread-codex").codexFastMode).toBe(true);
  });

  it("setThreadSettings forwards codexFastMode to updateThreadSettings", async () => {
    const thread = createMockThread({ id: "thread-codex-patch" });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-codex-patch", { codexFastMode: false });

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("thread-codex-patch", {
      codexFastMode: false,
    });
    const updated = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-codex-patch");
    expect(updated?.codex_fast_mode).toBe(false);
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
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-override",
          {
            ...createEmptyThreadRecord(),
            settings: {
              permissionMode: "full",
              interactionMode: "build",
              reasoningLevel: undefined,
            },
          },
        ],
      ]),
    });

    const settings = useThreadStore.getState().getThreadSettings("thread-override");

    expect(settings.permissionMode).toBe("full");
    expect(settings.interactionMode).toBe("build");
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

  it("partial setThreadSettings does not clear other persisted settings", () => {
    // Seed thread with all three settings in DB
    useWorkspaceStore.setState({
      threads: [
        createMockThread({
          id: "thread-1",
          reasoning_level: "high",
          interaction_mode: "plan",
          permission_mode: "supervised",
        }),
      ],
    });

    // Set only interactionMode
    useThreadStore.getState().setThreadSettings("thread-1", { interactionMode: "build" });

    // Other settings should be preserved from DB, not cleared
    const settings = useThreadStore.getState().getThreadSettings("thread-1");
    expect(settings.interactionMode).toBe("build");
    expect(settings.reasoningLevel).toBe("high");
    expect(settings.permissionMode).toBe("supervised");
  });

  it("setThreadSettings mirrors the patch into workspaceStore.threads", async () => {
    const thread = createMockThread({
      id: "thread-sync",
      reasoning_level: null,
      interaction_mode: "build",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore
      .getState()
      .setThreadSettings("thread-sync", { permissionMode: "full" });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync");
    expect(updated?.permission_mode).toBe("full");
  });

  it("setThreadSettings mirrors all provided fields, leaving others untouched", async () => {
    const thread = createMockThread({
      id: "thread-sync-2",
      reasoning_level: "max",
      interaction_mode: "build",
      permission_mode: "supervised",
      copilot_agent: "code",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-sync-2", {
      permissionMode: "full",
      interactionMode: "plan",
    });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync-2");
    expect(updated?.permission_mode).toBe("full");
    expect(updated?.interaction_mode).toBe("plan");
    expect(updated?.reasoning_level).toBe("max");
    expect(updated?.copilot_agent).toBe("code");
  });

  it("setThreadSettings with copilotAgent: null clears the cached value", async () => {
    const thread = createMockThread({
      id: "thread-sync-3",
      copilot_agent: "code",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore
      .getState()
      .setThreadSettings("thread-sync-3", { copilotAgent: null });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync-3");
    expect(updated?.copilot_agent).toBeNull();
  });

  it("sendPlanAction implement switches interaction mode to build", async () => {
    const thread = createMockThread({
      id: "thread-implement",
      interaction_mode: "plan",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().sendPlanAction(
      "thread-implement",
      "Implement the plan.",
      "implement",
    );

    expect(useThreadStore.getState().getThreadSettings("thread-implement").interactionMode).toBe("build");
    expect(
      useWorkspaceStore.getState().threads.find((t) => t.id === "thread-implement")?.interaction_mode,
    ).toBe("build");
    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith(
      "thread-implement",
      expect.objectContaining({ interactionMode: "build" }),
    );

    const calls = vi.mocked(mockTransport.sendMessage).mock.calls;
    const sendCall = calls[calls.length - 1]?.[0];
    expect(sendCall?.interactionMode).toBe("build");
  });
});
