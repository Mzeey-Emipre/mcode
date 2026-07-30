import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { AcpSessionRuntime } from "./acp-session-runtime.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  return child;
}

describe("AcpSessionRuntime", () => {
  it("negotiates auth, falls back from load, serializes prompts, and cancels the active session", async () => {
    const child = fakeChild();
    const promptResolvers: Array<(value: unknown) => void> = [];
    const calls: string[] = [];
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
        onSessionUpdate: async () => {},
      },
      transportFactory: async () => ({ child, connection }),
    });

    await runtime.initialize();
    const opened = await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(opened).toEqual({ sessionId: "acp-1", reloaded: false });
    expect(calls.slice(0, 3)).toEqual(["auth", "load", "new"]);

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
