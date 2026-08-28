import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { CodexAppServer } from "../../private/codex/codex-app-server.js";
import type { PermissionRequest, PermissionDecision, ProviderRuntimeEvent } from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { logger } from "@mcode/shared";

/**
 * These tests exercise the provider-level permission plumbing in isolation:
 * handleApprovalRequest, resolvePermission, listPendingPermissions,
 * stopSession drain, shutdown drain. They do NOT spawn a codex child
 * process; we call handleApprovalRequest directly as if CodexAppServer
 * had invoked our handler.
 *
 * Session lifecycle now lives in the held SessionRuntime. The provider holds
 * `runtime`, whose private `sessions` pool keys `sessionId -> { state, pids,
 * lastUsedAt }`. `seedSession` plants a fake-server state directly in that pool
 * so the permission-drain paths have something to iterate without spawning a
 * real child.
 */
function seedSession(
  provider: CodexProvider,
  sessionId: string,
  threadId: string,
  state: Record<string, unknown>,
): { kill: ReturnType<typeof vi.fn> } {
  const fullState: Record<string, unknown> = {
    sessionId,
    threadId,
    cwd: "/",
    runTurnSeq: 0,
    pendingTurnId: null,
    ...state,
  };
  const pool = (
    provider as unknown as {
      runtime: { sessions: Map<string, { state: unknown; pids: number[]; lastUsedAt: number }> };
    }
  ).runtime.sessions;
  pool.set(sessionId, { state: fullState, pids: [], lastUsedAt: (state.lastUsedAt as number) ?? Date.now() });
  return fullState.server as { kill: ReturnType<typeof vi.fn> };
}

describe("CodexProvider permission flow", () => {
  let provider: CodexProvider;
  const threadId = "thread-abc";
  const sessionId = "mcode-" + threadId;

  beforeEach(() => {
    vi.useFakeTimers();
    // settingsService and jobObject are unused for these paths; pass minimal stubs.
    provider = new CodexProvider(
      { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      stubEnvService() as never,
      { persistGeneratedImageFromPath: vi.fn() } as never,
      {
        currentSkills: vi.fn(() => []),
        currentPrompts: vi.fn(() => []),
        refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
        refresh: vi.fn(async () => ({ skills: [] })),
        onSkillsChanged: vi.fn(() => () => undefined),
        shutdown: vi.fn(async () => undefined),
      } as never,
    );
    // Pre-register a session entry so drain logic has something to iterate.
    seedSession(provider, sessionId, threadId, {
      server: { kill: vi.fn().mockResolvedValue(undefined), interruptTurn: vi.fn().mockResolvedValue(undefined), isAlive: true },
      mapper: { reset: vi.fn(), drainPendingAssistantBoundary: vi.fn(() => []) },
      lastUsedAt: Date.now() - 1000,
      sandboxMode: "workspace-write",
    });
  });

  it("emits permission_request and lists the pending entry when handler is invoked", async () => {
    const emitted: PermissionRequest[] = [];
    provider.on("permission_request", (r) => emitted.push(r));

    const resultPromise = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls -la", cwd: "/tmp" },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].toolName).toBe("Shell");
    expect(emitted[0].threadId).toBe(threadId);
    expect(emitted[0].input).toEqual({ command: "ls -la", cwd: "/tmp" });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(emitted[0].requestId);

    // Resolve and assert the handler's promise produces the mapped response.
    const resolved = provider.resolvePermission!(emitted[0].requestId, "allow");
    expect(resolved).toBe(true);

    const response = await resultPromise;
    expect(response).toEqual({ decision: "accept" });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });

  it("emits permission_resolved when resolvePermission fires", async () => {
    const resolved: Array<{ requestId: string; decision: PermissionDecision }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p));

    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 7,
      method: "item/fileChange/requestApproval",
      params: { itemId: "x" },
    });

    const pending = provider.listPendingPermissions!(threadId);
    provider.resolvePermission!(pending[0].requestId, "deny");

    await p;
    expect(resolved).toEqual([{ requestId: pending[0].requestId, decision: "deny" }]);
  });

  it("returns false from resolvePermission when requestId is unknown", () => {
    expect(provider.resolvePermission!("does-not-exist", "allow")).toBe(false);
  });

  it("stopSession drains pending permissions as cancelled and emits events", async () => {
    const resolved: Array<{ requestId: string; decision: PermissionDecision }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p));

    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 11,
      method: "item/commandExecution/requestApproval",
      params: { command: "sleep 999", cwd: "/" },
    });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);
    const requestId = pending[0].requestId;

    const pool = (
      provider as unknown as {
        runtime: { sessions: Map<string, { state: { server: { interruptTurn: () => Promise<void> } } }> };
      }
    ).runtime.sessions;
    const state = pool.get(sessionId)!.state;
    let releaseInterrupt!: () => void;
    const interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    state.server.interruptTurn = vi.fn(() => interruptGate);

    const stopPromise = provider.stopSession(sessionId);

    const response = await p;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toEqual([{ requestId, decision: "cancelled" }]);
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);

    releaseInterrupt();
    await stopPromise;
  });

  it("shutdown drains pending permissions across all sessions", async () => {
    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 13,
      method: "applyPatchApproval",
      params: {},
    });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);

    provider.shutdown();

    const response = await p;
    expect(response).toEqual({ decision: "abort" });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });

  it("drains pending permissions when the fatal handler fires on the app-server", async () => {
    const resolved: Array<{ requestId: string; decision: string }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p as never));

    // Re-register session with a fake server that we can drive fatal from.
    const fakeServer = new (require("events").EventEmitter)();
    fakeServer.kill = vi.fn().mockResolvedValue(undefined);
    fakeServer.interruptTurn = vi.fn().mockResolvedValue(undefined);
    fakeServer.isAlive = true;
    seedSession(provider, sessionId, threadId, {
      server: fakeServer,
      mapper: { reset: vi.fn(), drainPendingAssistantBoundary: vi.fn(() => []) },
      lastUsedAt: Date.now(),
      sandboxMode: "workspace-write",
    });

    // Install the fatal listener that sendMessage is responsible for wiring.
    (provider as unknown as {
      attachFatalDrain: (sessionId: string, server: unknown) => void;
    }).attachFatalDrain(sessionId, fakeServer);

    const p = (provider as unknown as {
      handleApprovalRequest: (s: string, t: string, r: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 202,
      method: "item/commandExecution/requestApproval",
      params: { command: "x", cwd: "/" },
    });

    fakeServer.emit("fatal", "simulated fatal");

    const response = await p;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("cancelled");
  });

  it("logs fatal breadcrumbs and preserves failure events from the app-server", async () => {
    const start = vi.spyOn(CodexAppServer.prototype, "start").mockResolvedValue(undefined);
    try {
      const events: ProviderRuntimeEvent[] = [];
      provider.on("event", (event) => events.push(event));

      const result = await (provider as unknown as {
        spawn: (args: {
          sessionId: string;
          threadId: string;
          cwd: string;
          permissionMode: string;
          env: Record<string, string>;
        }) => Promise<{ state: { server: CodexAppServer }; pids: number[] }>;
      }).spawn({
        sessionId,
        threadId,
        cwd: "/",
        permissionMode: "workspace-write",
        env: {},
      });
      const breadcrumb = {
        cause: "unexpected_exit" as const,
        pid: 4321,
        activeRequestId: null,
        activeTurnId: "turn-bounded",
        lastActivity: { method: "turn/started", timestamp: Date.now() },
        exit: { code: 2, signal: null },
        stderrTail: ["crash"],
      };
      Object.assign(result.state.server as unknown as { _lastTransportBreadcrumb: unknown }, {
        _lastTransportBreadcrumb: breadcrumb,
      });

      result.state.server.emit("fatal", "simulated fatal");

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        "CodexAppServer fatal",
        expect.objectContaining({ sessionId, error: "simulated fatal", breadcrumb }),
      );
      expect(events).toEqual([
        { event: { type: AgentEventType.Error, threadId, error: "simulated fatal" } },
      ]);
    } finally {
      start.mockRestore();
    }
  });

  it("runtime eviction spares a session with a turn in flight (busy guard)", async () => {
    // The runtime owns idle eviction now and consults the adapter's isBusy
    // guard. A pending permission only ever exists mid-turn, so the converged
    // guard derives busyness from pendingTurnId: a turn in flight => not evicted.
    const runtime = (
      provider as unknown as {
        runtime: {
          sessions: Map<string, { state: { pendingTurnId: string | null }; lastUsedAt: number }>;
          evictIdle: () => Promise<void>;
        };
      }
    ).runtime;
    const entry = runtime.sessions.get(sessionId)!;
    entry.lastUsedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
    entry.state.pendingTurnId = "turn-1"; // a turn is in flight => busy

    await runtime.evictIdle();

    // Busy session must survive the sweep regardless of idle time.
    expect(runtime.sessions.has(sessionId)).toBe(true);

    // Once the turn settles (pendingTurnId cleared) the same idle session is evictable.
    entry.state.pendingTurnId = null;
    await runtime.evictIdle();
    expect(runtime.sessions.has(sessionId)).toBe(false);
  });

  it("drains pending permissions when sendMessage detects a permission mode swap", async () => {
    const resolved: Array<{ requestId: string; decision: string }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p as never));

    // Queue a pending permission on the existing workspace-write session.
    const pendingPromise = (provider as unknown as {
      handleApprovalRequest: (s: string, t: string, r: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 55,
      method: "item/commandExecution/requestApproval",
      params: { command: "x", cwd: "/" },
    });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(1);

    // Point the settings stub at a bogus cliPath so checkCodexVersion fails
    // fast and sendMessage exits before spawning a real child process. The
    // mode-swap drain executes before the version check, which is what we
    // want to observe.
    (provider as unknown as {
      settingsService: { get: () => Promise<unknown> };
    }).settingsService.get = async () => ({
      provider: { cli: { codex: "/totally/bogus/codex-path" } },
    });

    vi.useRealTimers();
    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "hi",
      cwd: "/",
      model: "gpt-5",
      permissionMode: "full",
      interactionMode: "build",
      providerOptions: {},
    });

    const response = await pendingPromise;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("cancelled");
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });
});
