import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostDiagnostics,
  PtyHostHealth,
  PtyHostRunning,
} from "../../../host/pty-host-adapter.js";
import {
  PtyHostEventSchema,
  type PtyHostEvent,
} from "../../../host/pty-host-protocol.js";
import { TerminalService } from "../terminal-service.js";

class FakeHost implements PtyHostAdapter {
  readonly creates: PtyHostCreate[] = [];
  readonly commands: PtyHostCommand[] = [];
  readonly closes: PtyHostClose[] = [];
  closeError: Error | undefined;
  shutdownError: Error | undefined;
  startError: Error | undefined;
  closeGate: Promise<void> | undefined;
  sendGate: Promise<void> | undefined;
  onCreate: ((input: PtyHostCreate) => void) | undefined;
  readonly shutdown = vi.fn(async () => {
    if (this.shutdownError) throw this.shutdownError;
  });
  private listener: (event: PtyHostEvent) => void = () => undefined;

  async start(): Promise<PtyHostHealth> {
    if (this.startError) throw this.startError;
    return { hostGeneration: "1", state: "healthy" };
  }

  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.creates.push(input);
    this.onCreate?.(input);
    return {
      sessionId: input.sessionId,
      hostGeneration: "1",
      state: "running",
      containment: "job-object",
    };
  }

  async send(command: PtyHostCommand): Promise<void> {
    this.commands.push(command);
    await this.sendGate;
  }

  async inspectChildren(): Promise<{ hasChildren: boolean }> {
    return { hasChildren: false };
  }

  async close(input: PtyHostClose): Promise<void> {
    this.closes.push(input);
    await this.closeGate;
    if (this.closeError) throw this.closeError;
  }

  subscribe(listener: (event: PtyHostEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = () => undefined;
    };
  }

  diagnostics(): PtyHostDiagnostics {
    return {
      lastHeartbeatMsAgo: 0,
      queueBytes: 0,
      eventLoopLagMs: 0,
      hostRssBytes: "0",
    };
  }

  emit(event: unknown): void {
    this.listener(PtyHostEventSchema().parse(event));
  }
}

function createService(options: {
  readonly environment?: Record<string, string>;
  readonly sessionLimit?: number;
} = {}) {
  const environment = options.environment ?? { PATH: process.env.PATH ?? "" };
  const host = new FakeHost();
  const settings = {
    get: () => ({
      terminal: {
        behavior: { scrollback: 1_000, sessionLimit: options.sessionLimit ?? 20 },
        flowControl: { serverHighBytes: 1_024, serverLowBytes: 512 },
      },
    }),
    on: () => () => undefined,
  };
  const service = new TerminalService(
    {
      findById: (id: string) => id.startsWith("thread")
        ? { id, workspace_id: "workspace", mode: "direct", worktree_path: null }
        : null,
    } as never,
    { findById: () => ({ path: process.cwd() }) } as never,
    { resolveWorkingDir: () => process.cwd() } as never,
    settings as never,
    { getEnv: () => environment } as never,
    host,
  );
  const launch = {
    executable: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    arguments: [],
    requestedProfileId: "automatic",
    resolvedProfile: {
      kind: "certified",
      id: "powershell",
      executable: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      arguments: [],
    },
    headless: false,
  } as never;
  return { host, service, launch };
}

function output(sessionId: string, text: string, outputSeq = "1") {
  return {
    contractVersion: 1,
    kind: "output" as const,
    sessionId,
    hostGeneration: "1",
    outputSeq,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function exit(sessionId: string, code = 0) {
  return {
    contractVersion: 1,
    kind: "exit" as const,
    sessionId,
    hostGeneration: "1",
    finalOutputSeq: "1",
    code,
    signal: null,
    reason: "natural" as const,
  };
}

describe("TerminalService host ownership", () => {
  it("retains and replays output through the legacy sender", async () => {
    const { service, host, launch } = createService();
    const data = vi.fn();
    service.setSender({ data, json: vi.fn() });

    const created = await service.create("thread", launch);
    service.resume(created.ptyId);
    host.emit(output(created.ptyId, "one"));

    expect(service.reattach(created.ptyId, 0)).toEqual({ mode: "delta" });
    expect(data).toHaveBeenCalledWith(created.ptyId, 1, expect.any(Uint8Array));
  });

  it("returns a checkpoint before replaying the retained delta", async () => {
    const { service, host, launch } = createService();
    const data = vi.fn();
    service.setSender({ data, json: vi.fn() });

    const created = await service.create("thread", launch);
    service.resume(created.ptyId);
    host.emit(output(created.ptyId, "one", "1"));
    expect(service.checkpoint(created.ptyId, 1, "screen").accepted).toBe(true);
    host.emit(output(created.ptyId, "two", "2"));

    expect(service.reattach(created.ptyId, -1, true)).toEqual({
      mode: "checkpoint",
      checkpoint: "screen",
      checkpointThrough: 1,
    });
    expect(data).toHaveBeenCalledWith(created.ptyId, 2, expect.any(Uint8Array));
  });

  it("enforces the per-scope session limit while creates are active", async () => {
    const { service, launch } = createService();
    await Promise.all(Array.from({ length: 4 }, () => service.create("thread", launch)));

    await expect(service.create("thread", launch)).rejects.toThrow(
      "Maximum PTY limit (4)",
    );
  });

  it("applies the app-wide headless capacity across threads", async () => {
    const { service, launch } = createService({ sessionLimit: 1 });
    await service.startPreparedCommand("thread", launch);

    await expect(service.startPreparedCommand("thread-two", launch)).rejects.toThrow(
      "app-wide Terminal session limit",
    );
  });

  it("releases a failed host-start reservation without creating a session", async () => {
    const { service, host, launch } = createService();
    host.startError = new Error("host unavailable");

    await expect(service.create("thread", launch)).rejects.toThrow(Error);
    expect(service.listActiveSessions()).toEqual([]);
    expect(host.creates).toEqual([]);
  });

  it("uses one bounded environment snapshot for the host launch", async () => {
    const { service, host, launch } = createService({
      environment: { PATH: "safe", HOME: "home", "ProgramFiles(x86)": "windows" },
    });

    await service.create("thread", launch);

    expect(host.creates[0]?.protectedEnv).toEqual([
      { name: "HOME", value: "home" },
      { name: "PATH", value: "safe" },
    ]);
  });

  it("rejects an environment beyond the host boundary before creating", async () => {
    const { service, host, launch } = createService({
      environment: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`V${index}`, "x"]),
      ),
    });

    await expect(service.create("thread", launch)).rejects.toThrow(
      "environment exceeds",
    );
    expect(host.creates).toHaveLength(0);
  });

  it("serializes input before resize with host command sequences", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);

    await Promise.all([
      service.write(created.ptyId, "input"),
      service.resize(created.ptyId, 120, 30),
    ]);

    expect(host.commands.map(({ kind, commandSeq }) => [kind, commandSeq])).toEqual([
      ["input", "1"],
      ["resize", "2"],
    ]);
  });

  it("closes after accepted commands and rejects commands admitted after close", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    let releaseSend!: () => void;
    host.sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const input = service.write(created.ptyId, "input");
    await Promise.resolve();
    const close = service.kill(created.ptyId);

    expect(() => service.write(created.ptyId, "late")).toThrow(Error);
    expect(() => service.resize(created.ptyId, 120, 30)).toThrow(Error);
    expect(host.closes).toHaveLength(0);

    releaseSend();
    await Promise.all([input, close]);

    expect(host.commands).toMatchObject([{ kind: "input", commandSeq: "1" }]);
    expect(host.closes).toMatchObject([{ closeSeq: "2" }]);
  });

  it("shares one host close attempt across concurrent close requests", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    let releaseClose!: () => void;
    host.closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });

    const first = service.kill(created.ptyId);
    const second = service.kill(created.ptyId);
    await vi.waitFor(() => expect(host.closes).toHaveLength(1));

    releaseClose();
    await Promise.all([first, second]);
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("keeps a session when host close rejects", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    host.closeError = new Error("close failed");

    await expect(service.kill(created.ptyId)).rejects.toThrow(Error);
    expect(service.listActiveSessions()).toEqual([
      { ptyId: created.ptyId, threadId: "thread" },
    ]);
  });

  it("publishes one natural exit when a close rejection races it", async () => {
    const { service, host, launch } = createService();
    const json = vi.fn();
    service.setSender({ data: vi.fn(), json });
    const created = await service.create("thread", launch);
    host.closeError = new Error("close failed");

    await expect(service.kill(created.ptyId)).rejects.toThrow(Error);
    host.emit(exit(created.ptyId, 11));
    host.emit(exit(created.ptyId, 11));

    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith("terminal.exit", {
      ptyId: created.ptyId,
      code: 11,
    });
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("publishes a nonzero exit when the host generation fails", async () => {
    const { service, host, launch } = createService();
    const json = vi.fn();
    service.setSender({ data: vi.fn(), json });
    const created = await service.create("thread", launch);

    host.emit({
      contractVersion: 1,
      kind: "failure",
      hostGeneration: "1",
      boundary: "command",
      recoverable: false,
      code: "HOST_UNHEALTHY",
    });

    expect(json).toHaveBeenCalledWith("terminal.exit", {
      ptyId: created.ptyId,
      code: 1,
    });
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("keeps prepared sessions out of generic thread teardown", async () => {
    const { service, host, launch } = createService();
    await service.startPreparedCommand("thread", launch);

    await service.killByThread("thread");

    expect(host.closes).toEqual([]);
  });

  it("retains a synchronous headless exit until its owner attaches", async () => {
    const { service, host, launch } = createService();
    host.onCreate = (input) => {
      host.emit(output(input.sessionId, "complete"));
      host.emit(exit(input.sessionId));
    };

    const prepared = await service.startPreparedCommand("thread", launch);
    const received: Uint8Array[] = [];
    const exits: Array<number | null> = [];
    prepared.onOutput((data) => received.push(data));
    prepared.onExit((code) => exits.push(code));

    expect(Buffer.concat(received).toString()).toBe("complete");
    expect(exits).toEqual([0]);
  });

  it("continues cleanup when an Action exit listener throws", async () => {
    const { service, host, launch } = createService();
    const prepared = await service.startPreparedCommand("thread", launch);
    prepared.onExit(() => {
      throw new Error("persistence failed");
    });

    expect(() => host.emit(exit(prepared.terminalSessionId))).not.toThrow();
    expect(service.listActiveSessions()).toEqual([]);
    await expect(prepared.stop()).resolves.toBeUndefined();
  });

  it("uses graceful host close only after app shutdown enables it", async () => {
    const { service, host, launch } = createService();
    const first = await service.create("thread", launch);
    service.setGracefulKill(true);

    await service.kill(first.ptyId, "app-shutdown");
    const second = await service.create("thread", launch);
    await service.kill(second.ptyId);

    expect(host.closes.map(({ reason }) => reason)).toEqual([
      "app-shutdown",
      "user",
    ]);
  });

  it("shuts down the host even when a session close rejects", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    host.closeError = new Error("close failed");

    await expect(service.shutdown()).rejects.toThrow("Terminal shutdown failed");

    expect(host.shutdown).toHaveBeenCalledOnce();
    expect(service.listActiveSessions()).toEqual([
      { ptyId: created.ptyId, threadId: "thread" },
    ]);
  });
});
