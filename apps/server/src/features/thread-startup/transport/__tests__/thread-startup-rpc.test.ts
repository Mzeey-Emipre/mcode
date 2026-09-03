import { describe, expect, it, vi } from "vitest";
import type { ThreadStartup, WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { routeThreadStartupRpc } from "../thread-startup-rpc.js";

const startup: ThreadStartup = {
  startupId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-1",
  kind: "direct",
  state: "pending",
  phase: "thread",
  steps: [
    { phase: "thread", state: "pending" },
    { phase: "agent", state: "pending" },
  ],
  transcript: [],
  cancellation: "none",
  revision: 1,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const stoppedSetup = {
  gate: "blocked",
  attempt: null,
  queuedTurns: [],
} satisfies WorkspaceEnvironmentAutomaticSetupSnapshot;

describe("thread startup RPC", () => {
  it("routes get, list, and cancellation intent through the typed WebSocket router", async () => {
    const get = vi.fn(() => startup);
    const list = vi.fn(() => [startup]);
    const cancel = vi.fn(() => ({ ...startup, cancellation: "requested" as const, revision: 2 }));
    const deps = { threadStartupService: { get, list, cancel } } as unknown as RouterDeps;

    const getResponse = await routeMessage(JSON.stringify({
      id: "get",
      method: "thread.startup.get",
      params: { startupId: startup.startupId },
    }), deps);
    const listResponse = await routeMessage(JSON.stringify({
      id: "list",
      method: "thread.startup.list",
      params: { workspaceId: startup.workspaceId },
    }), deps);
    const cancelResponse = await routeMessage(JSON.stringify({
      id: "cancel",
      method: "thread.startup.cancel",
      params: { startupId: startup.startupId },
    }), deps);

    expect(getResponse).toEqual({ id: "get", result: startup });
    expect(listResponse).toEqual({ id: "list", result: { records: [startup] } });
    expect(cancelResponse).toMatchObject({
      id: "cancel",
      result: { cancellation: "requested", revision: 2 },
    });
    expect(get).toHaveBeenCalledWith(startup.startupId);
    expect(list).toHaveBeenCalledWith(startup.workspaceId);
    expect(cancel).toHaveBeenCalledWith(startup.startupId);
  });

  it("contains managed Setup before it records cancellation as terminal", async () => {
    const cancellationRequested: ThreadStartup = {
      ...startup,
      kind: "managed-worktree",
      state: "running",
      phase: "setup",
      threadId: "thread-1",
      cancellation: "requested",
    };
    const cancelled: ThreadStartup = {
      ...cancellationRequested,
      state: "cancelled",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "cancelled" },
        { phase: "agent", state: "pending" },
      ],
    };
    const markCancelled = vi.fn(() => cancelled);
    const stopAutomaticSetup = vi.fn(async () => {
      expect(markCancelled).not.toHaveBeenCalled();
      return stoppedSetup;
    });
    const deps = {
      threadStartupService: {
        get: vi.fn(() => cancellationRequested),
        list: vi.fn(() => []),
        cancel: vi.fn(() => cancellationRequested),
        markCancelled,
      },
      workspaceEnvironmentService: { stopAutomaticSetup },
    };

    const result = await routeThreadStartupRpc(
      "thread.startup.cancel",
      { startupId: startup.startupId },
      deps,
    );

    expect(stopAutomaticSetup).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(result).toMatchObject({ state: "cancelled", cancellation: "requested" });
    expect(markCancelled).toHaveBeenCalledWith(startup.startupId);
  });

  it("contains bound managed Setup before terminalizing cancellation during worktree preparation", async () => {
    const cancellationRequested: ThreadStartup = {
      ...startup,
      kind: "managed-worktree",
      state: "running",
      phase: "worktree",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "running" },
        { phase: "setup", state: "pending" },
        { phase: "agent", state: "pending" },
      ],
      threadId: "thread-1",
      cancellation: "requested",
    };
    const cancelled: ThreadStartup = {
      ...cancellationRequested,
      state: "cancelled",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "cancelled" },
        { phase: "setup", state: "pending" },
        { phase: "agent", state: "pending" },
      ],
    };
    let allowStop!: () => void;
    const stopped = new Promise<void>((resolve) => { allowStop = resolve; });
    const markCancelled = vi.fn(() => cancelled);
    const stopAutomaticSetup = vi.fn(async () => {
      await stopped;
      return stoppedSetup;
    });
    const result = routeThreadStartupRpc("thread.startup.cancel", { startupId: startup.startupId }, {
      threadStartupService: {
        get: vi.fn(() => cancellationRequested),
        list: vi.fn(() => []),
        cancel: vi.fn(() => cancellationRequested),
        markCancelled,
      },
      workspaceEnvironmentService: { stopAutomaticSetup },
    });

    expect(stopAutomaticSetup).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(markCancelled).not.toHaveBeenCalled();
    allowStop();
    await expect(result).resolves.toEqual(cancelled);
    expect(markCancelled).toHaveBeenCalledWith(startup.startupId);
  });

  it("records cancellation intent during managed agent startup without stopping Setup", async () => {
    const agentStartup: ThreadStartup = {
      ...startup,
      kind: "managed-worktree",
      state: "running",
      phase: "agent",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "completed" },
        { phase: "agent", state: "running" },
      ],
      threadId: "thread-1",
    };
    const requested = { ...agentStartup, cancellation: "requested" as const, revision: 2 };
    const cancel = vi.fn(() => requested);
    const stopAutomaticSetup = vi.fn();
    const markCancelled = vi.fn();

    await expect(routeThreadStartupRpc("thread.startup.cancel", { startupId: agentStartup.startupId }, {
      threadStartupService: { get: vi.fn(() => agentStartup), list: vi.fn(), cancel, markCancelled },
      workspaceEnvironmentService: { stopAutomaticSetup },
    })).resolves.toEqual(requested);

    expect(cancel).toHaveBeenCalledWith(agentStartup.startupId);
    expect(stopAutomaticSetup).not.toHaveBeenCalled();
    expect(markCancelled).not.toHaveBeenCalled();
  });

  it("keeps cancellation nonterminal when Setup containment fails", async () => {
    const cancellationRequested: ThreadStartup = {
      ...startup,
      kind: "managed-worktree",
      state: "running",
      phase: "setup",
      threadId: "thread-1",
      cancellation: "requested",
    };
    const markCancelled = vi.fn();
    const deps = {
      threadStartupService: {
        get: vi.fn(() => cancellationRequested),
        list: vi.fn(() => []),
        cancel: vi.fn(() => cancellationRequested),
        markCancelled,
      },
      workspaceEnvironmentService: {
        stopAutomaticSetup: vi.fn(() => Promise.reject(new Error("containment failed"))),
      },
    };

    await expect(routeThreadStartupRpc(
      "thread.startup.cancel",
      { startupId: startup.startupId },
      deps,
    )).rejects.toThrow("containment failed");

    expect(markCancelled).not.toHaveBeenCalled();
  });
});
