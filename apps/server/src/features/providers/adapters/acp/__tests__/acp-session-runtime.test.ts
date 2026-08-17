import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Client, ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpSessionRuntime } from "../acp-session-runtime.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    pid: 1234,
  }) as unknown as ChildProcess;
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
    await client.sessionUpdate({ sessionId: "pre-open", update: {} } as SessionNotification);
    expect(updates).toHaveLength(0);
    const opened = await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(opened).toEqual({ sessionId: "acp-1", reloaded: false });
    expect(calls.slice(0, 3)).toEqual(["auth", "load", "new"]);
    await client.sessionUpdate({ sessionId: "other", update: {} } as SessionNotification);
    await client.sessionUpdate({ sessionId: "acp-1", update: {} } as SessionNotification);
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
      loadSession: vi.fn(async () => ({ sessionId: "unexpected" })),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await runtime.initialize();
    await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("suppresses resume replay until the load response installs the active session", async () => {
    const child = fakeChild();
    let client!: Client;
    let finishLoad!: () => void;
    const updates: SessionNotification[] = [];
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => {
        await client.sessionUpdate({ sessionId: "resume-1", update: { kind: "historical" } } as unknown as SessionNotification);
        await new Promise<void>((resolve) => { finishLoad = resolve; });
      }),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
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
    await client.sessionUpdate({ sessionId: "other", update: {} } as SessionNotification);
    expect(updates).toHaveLength(0);
    expect(runtime.state.sessionId).toBe("");

    finishLoad();
    await expect(opening).resolves.toEqual({ sessionId: "resume-1", reloaded: true });
    await client.sessionUpdate({ sessionId: "resume-1", update: { kind: "live" } } as unknown as SessionNotification);
    expect(updates.map((update) => update.update)).toEqual([{ kind: "live" }]);
  });

  it("times out a stalled load, clears replay state, and falls back to a fresh session", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let resolveNewSession!: (value: { sessionId: string }) => void;
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
        loadSession: vi.fn(() => new Promise<never>(() => {})),
        newSession: vi.fn(() => new Promise<{ sessionId: string }>((resolve) => { resolveNewSession = resolve; })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
        transportFactory: async () => ({ child, connection }),
        sessionLoadTimeoutMs: 50,
      });

      await runtime.initialize();
      const opening = runtime.openSession({ resumeFrom: "stalled", cwd: ".", mcpServers: [] });
      await vi.advanceTimersByTimeAsync(50);
      expect(runtime.state.sessionId).toBe("");
      resolveNewSession({ sessionId: "fresh-after-timeout" });
      await expect(opening).resolves.toEqual({ sessionId: "fresh-after-timeout", reloaded: false });
      expect(connection.newSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the child when initialization fails", async () => {
    const child = fakeChild();
    const connection = {
      initialize: vi.fn(async () => { throw new Error("handshake failed"); }),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await expect(runtime.initialize()).rejects.toThrow("handshake failed");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
