import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  PtyHostEvent,
  PtyHostServerMessage,
} from "./pty-host-protocol.js";
import { PtyHostSupervisor, type PtyHostChild } from "./pty-host-supervisor.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const createRequest = {
  sessionId: UUID,
  hostGeneration: "1",
  launch: {
    requestedProfileId: "automatic" as const,
    resolvedProfile: {
      id: "certified:windows-powershell-7" as const,
      name: "PowerShell 7",
      executable: "pwsh.exe",
      arguments: [],
      source: "certified" as const,
      platform: "windows" as const,
    },
    scope: { kind: "workspace" as const, workspaceId: UUID },
    arguments: [],
  },
  cwd: "C:\\repo",
  protectedEnv: [],
  cols: 80,
  rows: 24,
};

class FakeHostChild extends EventEmitter implements PtyHostChild {
  readonly pid = 42;
  readonly connected = true;
  readonly send = vi.fn(
    (
      message: PtyHostServerMessage,
      callback?: (error: Error | null) => void,
    ) => {
      queueMicrotask(() => callback?.(null));
      if (message.kind === "shutdown") {
        this.emit("exit", 0, null);
        return true;
      }
      if (message.kind !== "handshake") return true;
      queueMicrotask(() => {
        this.emitMessage({
          contractVersion: 1,
          kind: "ready",
          hostGeneration: message.requestedGeneration,
          platform: message.platform,
          nativeAbi: "fake-v1",
          capabilities: {
            pty: message.platform === "windows" ? "conpty" : "posix-pty",
            containment:
              message.platform === "windows" ? "job-object" : "process-group",
            maxSessions: 20,
            protocolVersion: 1,
          },
        });
        this.emitMessage({
          contractVersion: 1,
          kind: "heartbeat",
          hostGeneration: message.requestedGeneration,
          monotonicMs: "1",
          activeSessions: 0,
          queueBytes: 0,
          rssBytes: "1",
        });
      });
      return true;
    },
  );
  readonly kill = vi.fn(() => true);
  readonly disposeContainment = vi.fn();

  emitMessage(event: PtyHostEvent): void {
    this.emit("message", event);
  }

  crash(): void {
    this.emit("exit", 1, null);
  }
}

describe("PtyHostSupervisor", () => {
  it("starts one healthy generation and replaces one crashed host", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });

    await expect(supervisor.start()).resolves.toEqual({
      hostGeneration: "1",
      state: "healthy",
    });
    expect(children).toHaveLength(1);

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(250);
    expect(children[0]!.disposeContainment).toHaveBeenCalledOnce();
    await expect(supervisor.whenHealthy()).resolves.toEqual({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);

    children[1]!.crash();
    await vi.advanceTimersByTimeAsync(250);
    expect(supervisor.health()).toEqual({
      hostGeneration: "2",
      state: "unhealthy",
    });
    expect(children).toHaveLength(2);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("probes a missed heartbeat and replaces the unresponsive host once", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(750);
    expect(supervisor.health().state).toBe("degraded");
    expect(children[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "probe" }),
      expect.any(Function),
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(supervisor.whenHealthy()).resolves.toMatchObject({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("waits for running and exit events at the adapter boundary", async () => {
    const child = new FakeHostChild();
    const inspectProcessTree = vi.fn(async () => true);
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => child,
      inspectProcessTree,
    });
    await supervisor.start();

    const creating = supervisor.create(createRequest);
    child.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await expect(creating).resolves.toMatchObject({ state: "running" });
    await expect(supervisor.inspectChildren(UUID, "1")).resolves.toEqual({
      hasChildren: true,
    });

    let closed = false;
    const closing = supervisor
      .close({
        sessionId: UUID,
        hostGeneration: "1",
        closeSeq: "1",
        reason: "user",
      })
      .then(() => {
        closed = true;
      });
    await Promise.resolve();
    expect(closed).toBe(false);
    child.emitMessage({
      contractVersion: 1,
      kind: "exit",
      sessionId: UUID,
      hostGeneration: "1",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "user-close",
    });
    await closing;
    await supervisor.shutdown();
  });

  it("rejects startup when the handshake channel is unavailable", async () => {
    const child = new FakeHostChild();
    Object.defineProperty(child, "connected", { value: false });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => child,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "PTY host channel is unavailable",
    );
    expect(supervisor.health().state).toBe("unhealthy");
  });

  it("retains failed cleanup records and blocks replacement", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const reapProcessTree = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
      reapProcessTree,
    });
    await supervisor.start();
    const creating = supervisor.create(createRequest);
    children[0]!.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await creating;

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(250);

    expect(reapProcessTree).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    expect(supervisor.health().state).toBe("unhealthy");
    await supervisor.shutdown();
    vi.useRealTimers();
  });
});
