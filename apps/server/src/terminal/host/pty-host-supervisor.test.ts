import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPtyHostCleanupLedger } from "../testing/in-memory-pty-host-cleanup-ledger.js";
import type {
  PtyHostEvent,
  PtyHostServerMessage,
} from "./pty-host-protocol.js";
import type { PtyHostDiagnostic } from "./pty-host-diagnostics.js";
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

function heartbeatEvent(
  hostGeneration = "1",
  monotonicMs = "2",
): Extract<PtyHostEvent, { kind: "heartbeat" }> {
  return {
    contractVersion: 1,
    kind: "heartbeat",
    hostGeneration,
    monotonicMs,
    activeSessions: 0,
    queueBytes: 0,
    rssBytes: "1",
  };
}

class FakeHostChild extends EventEmitter implements PtyHostChild {
  readonly pid = 42;
  readonly connected = true;
  respondToInspection = true;
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
      if (message.kind === "inspectChildren" && this.respondToInspection) {
        queueMicrotask(() => {
          this.emitMessage({
            contractVersion: 1,
            kind: "children",
            sessionId: message.sessionId,
            hostGeneration: message.hostGeneration,
            hasChildren: true,
          });
        });
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
  it("gates lifecycle diagnostics behind the release-test observation flag", async () => {
    const diagnostics: string[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      releaseTestDiagnostic: (diagnostic) => diagnostics.push(diagnostic.phase),
      spawnHost: () => new FakeHostChild(),
    });

    await supervisor.start();

    expect(diagnostics).toEqual([]);
    await supervisor.shutdown();
  });

  it("records ordered release lifecycle phases and original child failure facts", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeHostChild();
      const diagnostics: PtyHostDiagnostic[] = [];
      const supervisor = new PtyHostSupervisor({
        platform: "windows",
        cleanupLedger: new InMemoryPtyHostCleanupLedger(),
        releaseTestObservationsEnabled: true,
        releaseTestDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        spawnHost: () => child,
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
      await creating;
      await vi.advanceTimersByTimeAsync(2_000);
      child.crash();

      expect(diagnostics.map(({ phase }) => phase)).toEqual([
        "supervisor.spawn",
        "supervisor.ready",
        "supervisor.heartbeat.first",
        "supervisor.create",
        "supervisor.degraded",
        "supervisor.probe",
        "supervisor.child.exit",
        "supervisor.unhealthy",
      ]);
      expect(diagnostics.find(({ phase }) => phase === "supervisor.child.exit")).toMatchObject({
        code: 1,
        pid: 42,
        signal: null,
      });
      expect(diagnostics.find(({ phase }) => phase === "supervisor.unhealthy")).toMatchObject({
        error: "PTY host process exited",
        generation: "1",
        state: "degraded",
      });
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one healthy generation and replaces one crashed host", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      releaseTestFault: "post-start-host-exit",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    const events: PtyHostEvent[] = [];
    supervisor.subscribe((event) => events.push(event));

    await expect(supervisor.start()).resolves.toEqual({
      hostGeneration: "1",
      state: "healthy",
    });
    expect(supervisor.diagnostics()).toMatchObject({
      lastHeartbeatMsAgo: 0,
      queueBytes: 0,
      eventLoopLagMs: 0,
      hostRssBytes: "1",
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "handshake",
        releaseTestFault: "post-start-host-exit",
      }),
      expect.any(Function),
    );

    children[0]!.crash();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "failure",
        hostGeneration: "1",
        code: "HOST_UNHEALTHY",
        recoverable: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(children[0]!.disposeContainment).toHaveBeenCalledOnce();
    await expect(supervisor.whenHealthy()).resolves.toEqual({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);
    expect(children[1]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "handshake", requestedGeneration: "2" }),
      expect.any(Function),
    );
    expect(children[1]!.send.mock.calls[0]?.[0]).not.toHaveProperty("releaseTestFault");

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

  it("stays healthy through 1999ms with the default heartbeat bounds", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(supervisor.health().state).toBe("healthy");
    expect(
      children[0]!.send.mock.calls.filter(([message]) => message.kind === "probe"),
    ).toHaveLength(0);
    const creating = supervisor.create(createRequest);
    expect(children[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create", sessionId: UUID }),
      expect.any(Function),
    );
    children[0]!.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await expect(creating).resolves.toMatchObject({
      sessionId: UUID,
      hostGeneration: "1",
      state: "running",
    });
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("degrades and sends exactly one probe at 2000ms", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(supervisor.health().state).toBe("degraded");
    expect(
      children[0]!.send.mock.calls.filter(([message]) => message.kind === "probe"),
    ).toHaveLength(1);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("returns to healthy when a heartbeat arrives during the probe window", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(500);
    children[0]!.emitMessage(heartbeatEvent());
    expect(supervisor.health().state).toBe("healthy");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.health().state).toBe("healthy");
    expect(children).toHaveLength(1);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("publishes unhealthy at 3000ms and starts one replacement after 250ms", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const events: PtyHostEvent[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    supervisor.subscribe((event) => events.push(event));
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(supervisor.health().state).toBe("unhealthy");
    expect(
      events.filter((event) => event.kind === "failure"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: "failure",
      code: "HOST_UNHEALTHY",
    });
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(supervisor.whenHealthy()).resolves.toMatchObject({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(children).toHaveLength(2);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("rejects invalid and equal heartbeat bounds", () => {
    const options = {
      platform: "windows" as const,
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => new FakeHostChild(),
    };
    expect(() =>
      new PtyHostSupervisor({
        ...options,
        heartbeatDegradedMs: 0,
        heartbeatUnhealthyMs: 3_000,
      }),
    ).toThrow(/invalid/);
    expect(() =>
      new PtyHostSupervisor({
        ...options,
        heartbeatDegradedMs: 2_000,
        heartbeatUnhealthyMs: 2_000,
      }),
    ).toThrow(/invalid/);
  });

  it("waits for running and exit events at the adapter boundary", async () => {
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
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
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inspectChildren", sessionId: UUID }),
      expect.any(Function),
    );

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
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "PTY host channel is unavailable",
    );
    expect(supervisor.health().state).toBe("unhealthy");
  });

  it("rejects child inspection when the session exits before the host responds", async () => {
    const child = new FakeHostChild();
    child.respondToInspection = false;
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
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
    await creating;

    const inspection = supervisor.inspectChildren(UUID, "1");
    child.emitMessage({
      contractVersion: 1,
      kind: "exit",
      sessionId: UUID,
      hostGeneration: "1",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "natural",
    });

    await expect(inspection).rejects.toThrow("PTY session exited");
    await supervisor.shutdown();
  });

  it("retains failed cleanup records and blocks replacement", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const reapProcessTree = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
      reapProcessTree,
    });
    const events: PtyHostEvent[] = [];
    supervisor.subscribe((event) => events.push(event));
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
    expect(events.filter((event) => event.kind === "failure").at(-1)).toMatchObject({
      kind: "failure",
      hostGeneration: "1",
      code: "HOST_UNHEALTHY",
      recoverable: false,
    });
    await expect(supervisor.shutdown()).rejects.toThrow(
      "PTY host shutdown cleanup failed",
    );
    expect(reapProcessTree).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("reaps durable records before it starts a new host generation", async () => {
    const ledger = new InMemoryPtyHostCleanupLedger();
    ledger.record({
      sessionId: UUID,
      hostGeneration: "7",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    const order: string[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: ledger,
      reapProcessTree: vi.fn(async () => {
        order.push("reap");
      }),
      spawnHost: () => {
        order.push("spawn");
        return new FakeHostChild();
      },
    });

    await expect(supervisor.start()).resolves.toMatchObject({
      hostGeneration: "1",
      state: "healthy",
    });
    expect(order).toEqual(["reap", "spawn"]);
    expect(ledger.list()).toEqual([]);
    await supervisor.shutdown();
  });

  it("reaps sessions that do not confirm exit before host shutdown", async () => {
    const ledger = new InMemoryPtyHostCleanupLedger();
    const child = new FakeHostChild();
    const reapProcessTree = vi.fn(async () => undefined);
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: ledger,
      reapProcessTree,
      spawnHost: () => child,
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
    await creating;

    await supervisor.shutdown();

    expect(reapProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: UUID, hostGeneration: "1" }),
    );
    expect(ledger.list()).toEqual([]);
  });
});
