import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Client, ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpSessionRuntime, SessionRecoveryFailedError } from "../acp-session-runtime.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    pid: 1234,
  }) as unknown as ChildProcess;
}

function fakeProcesses() {
  return {
    attach: vi.fn(),
    terminateTree: vi.fn(async () => undefined),
  };
}

describe("AcpSessionRuntime", () => {
  it("negotiates auth, falls back from load, serializes prompts, and cancels the active session", async () => {
    const child = fakeChild();
    const promptResolvers: Array<(value: unknown) => void> = [];
    const calls: string[] = [];
    const updates: SessionNotification[] = [];
    let client!: Client;
    const connection = {
      initialize: vi.fn(async () => ({
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "login" }],
      })),
      authenticate: vi.fn(async () => { calls.push("auth"); }),
      loadSession: vi.fn(async () => { calls.push("load"); throw new Error("stale"); }),
      newSession: vi.fn(async () => { calls.push("new"); return { sessionId: "acp-1" }; }),
      prompt: vi.fn(({ sessionId }: { sessionId: string }) => {
        calls.push(`prompt:${sessionId}`);
        return new Promise((resolve) => promptResolvers.push(resolve));
      }),
      cancel: vi.fn(async ({ sessionId }: { sessionId: string }) => { calls.push(`cancel:${sessionId}`); }),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({ child, connection }),
    });

    await runtime.initialize();
    await client.sessionUpdate({ sessionId: "pre-open", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates).toHaveLength(0);
    const opened = await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(opened).toEqual({ sessionId: "acp-1", reloaded: false });
    expect(calls.slice(0, 3)).toEqual(["auth", "load", "new"]);
    await client.sessionUpdate({ sessionId: "other", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    await client.sessionUpdate({ sessionId: "acp-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.sessionId)).toEqual(["acp-1"]);

    const first = runtime.prompt({ prompt: [] });
    const second = runtime.prompt({ prompt: [] });
    await Promise.resolve();
    expect(calls).toContain("prompt:acp-1");
    promptResolvers.shift()?.({ stopReason: "end_turn" });
    await first;
    expect(calls.filter((call) => call === "prompt:acp-1")).toHaveLength(2);
    promptResolvers.shift()?.({ stopReason: "end_turn" });
    await second;
    await runtime.cancel();
    expect(calls).toContain("cancel:acp-1");
  });

  it("creates a fresh session without calling load when the capability is absent", async () => {
    const child = fakeChild();
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({ sessionId: "unexpected" })),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await runtime.initialize();
    await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(connection.resumeSession).not.toHaveBeenCalled();
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("forwards matching load replay updates before the load response installs the active session", async () => {
    const child = fakeChild();
    let client!: Client;
    let finishLoad!: () => void;
    const updates: SessionNotification[] = [];
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => {
        await client.sessionUpdate({ sessionId: "resume-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
        await new Promise<void>((resolve) => { finishLoad = resolve; });
      }),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({ child, connection }),
      sessionLoadTimeoutMs: 100,
    });

    await runtime.initialize();
    const opening = runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] });
    await Promise.resolve();
    await client.sessionUpdate({ sessionId: "other", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.sessionId)).toEqual(["resume-1"]);
    expect(runtime.state.sessionId).toBe("");

    finishLoad();
    await expect(opening).resolves.toEqual({ sessionId: "resume-1", reloaded: true });
    await client.sessionUpdate({ sessionId: "resume-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.update)).toEqual([
      { sessionUpdate: "session_info_update" },
      { sessionUpdate: "session_info_update" },
    ]);
  });

  it("preserves the generic fallback after a rejected load recovery", async () => {
    const child = fakeChild();
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => { throw new Error("stale"); }),
      newSession: vi.fn(async () => ({ sessionId: "fresh-after-failure" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "stalled", cwd: ".", mcpServers: [] })).resolves.toEqual({
      sessionId: "fresh-after-failure",
      reloaded: false,
    });
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("preserves the generic fallback after a recovery inactivity timeout", async () => {
    vi.useFakeTimers();
    try {
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
        loadSession: vi.fn(() => new Promise<never>(() => {})),
        newSession: vi.fn(async () => ({ sessionId: "fresh-after-timeout" })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        processes: fakeProcesses(),
        callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
        transportFactory: async () => ({ child: fakeChild(), connection }),
        recoveryInactivityTimeoutMs: 50,
      });

      await runtime.initialize();
      const opening = runtime.openSession({ resumeFrom: "stalled", cwd: ".", mcpServers: [] });
      await vi.advanceTimersByTimeAsync(50);
      await expect(opening).resolves.toEqual({ sessionId: "fresh-after-timeout", reloaded: false });
      expect(connection.newSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a closed never-resolving recovery without creating a replacement session", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(() => new Promise<never>(() => {})),
      newSession: vi.fn(async () => ({ sessionId: "replacement" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    const opening = runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledOnce());
    await runtime.close();

    await expect(opening).rejects.toBeInstanceOf(SessionRecoveryFailedError);
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("prefers advertised session resume over load and new", async () => {
    const connection = {
      initialize: vi.fn(async () => ({
        agentCapabilities: { sessionCapabilities: { resume: {} }, loadSession: true },
        authMethods: [],
      })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({ sessionId: "unexpected" })),
      newSession: vi.fn(async () => ({ sessionId: "unexpected" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] })).resolves.toEqual({
      sessionId: "resume-1",
      reloaded: true,
    });
    expect(connection.resumeSession).toHaveBeenCalledWith({ sessionId: "resume-1", cwd: ".", mcpServers: [] });
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("uses load only when resume is not advertised", async () => {
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "unexpected" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    await runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] });
    expect(connection.resumeSession).not.toHaveBeenCalled();
    expect(connection.loadSession).toHaveBeenCalledWith({
      sessionId: "resume-1",
      cwd: ".",
      mcpServers: [],
    });
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("fails closed without replacing a Cursor recovery session", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => { throw new Error("provider failure"); }),
      newSession: vi.fn(async () => ({ sessionId: "replacement" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
      recoveryFailurePolicy: "fail-without-replacement",
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] })).rejects.toBeInstanceOf(
      SessionRecoveryFailedError,
    );
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
  });

  it("resets recovery inactivity only for matching replay updates", async () => {
    vi.useFakeTimers();
    try {
      let client!: Client;
      const terminateTree = vi.fn(async () => undefined);
      const updates: SessionNotification[] = [];
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
        loadSession: vi.fn(() => new Promise<never>(() => {})),
        newSession: vi.fn(async () => ({ sessionId: "replacement" })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        processes: { attach: vi.fn(), terminateTree },
        callbacks: {
          onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
          onSessionUpdate: async (update) => { updates.push(update); },
        },
        clientFactory: (handlers) => {
          client = {
            requestPermission: handlers.onPermissionRequest,
            sessionUpdate: handlers.onSessionUpdate,
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
            extMethod: async () => ({}),
            extNotification: async () => {},
          };
          return client;
        },
        transportFactory: async () => ({ child: fakeChild(), connection }),
        recoveryFailurePolicy: "fail-without-replacement",
        recoveryInactivityTimeoutMs: 50,
      });

      await runtime.initialize();
      const opening = runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] });
      const recoveryFailure = expect(opening).rejects.toBeInstanceOf(SessionRecoveryFailedError);
      await vi.advanceTimersByTimeAsync(40);
      await client.sessionUpdate({ sessionId: "preserved", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
      await vi.advanceTimersByTimeAsync(40);
      await client.sessionUpdate({ sessionId: "foreign", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
      await vi.advanceTimersByTimeAsync(10);

      await recoveryFailure;
      expect(updates.map((update) => update.sessionId)).toEqual(["preserved"]);
      expect(connection.newSession).not.toHaveBeenCalled();
      expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the process authority when initialization fails", async () => {
    const child = fakeChild();
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => { throw new Error("handshake failed"); }),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await expect(runtime.initialize()).rejects.toThrow("handshake failed");
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects malformed nested ACP data before it reaches provider mapping", async () => {
    const child = fakeChild();
    let client!: Client;
    const updates: SessionNotification[] = [];
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({
        child,
        connection: {
          initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
          newSession: vi.fn(async () => ({ sessionId: "acp-1" })),
        } as unknown as ClientSideConnection,
      }),
    });

    await runtime.initialize();
    await runtime.openSession({ cwd: ".", mcpServers: [] });
    await expect(client.sessionUpdate({
      sessionId: "acp-1",
      update: { sessionUpdate: "agent_message_chunk", content: null },
    } as never)).rejects.toMatchObject({ code: "INVALID_ACP_PAYLOAD" });
    expect(updates).toEqual([]);
  });

  it("rejects malformed nested capabilities during initialization", async () => {
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({
        child: fakeChild(),
        connection: {
          initialize: vi.fn(async () => ({ agentCapabilities: { mcpCapabilities: { http: "yes" } } })),
        } as unknown as ClientSideConnection,
      }),
    });

    await expect(runtime.initialize()).rejects.toMatchObject({ code: "INVALID_ACP_PAYLOAD" });
  });
});
