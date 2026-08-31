import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";

const { killProcessTree, gracefulKillProcessTree, spawnPty } = vi.hoisted(() => ({
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  gracefulKillProcessTree: vi.fn().mockResolvedValue(undefined),
  spawnPty: vi.fn(),
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: () => () => ({ spawn: spawnPty }),
  };
});

vi.mock("../../../../../runtime/process/containment/process-kill.js", () => ({
  killProcessTree,
  gracefulKillProcessTree,
  listDirectChildren: vi.fn().mockResolvedValue([]),
}));

vi.mock("@mcode/shared", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "@mcode/shared";
import { TerminalService } from "../terminal-service.js";
import { TerminalReplayBuffer } from "../terminal-replay-buffer.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

function terminalServiceWithReplay(
  replay: TerminalReplayBuffer,
  data: ReturnType<typeof vi.fn>,
): TerminalService {
  const settingsService = {
    get: () => ({ terminal: { behavior: { scrollback: 1_000 } } }),
    on: () => vi.fn(),
  };
  const service = new TerminalService(
    {} as never,
    {} as never,
    {} as never,
    settingsService as never,
    {} as never,
    { clear: vi.fn() } as never,
    {} as never,
  );
  const internals = service as unknown as {
    replayBuffers: Map<string, TerminalReplayBuffer>;
    sender: { data: typeof data };
  };
  internals.replayBuffers.set("pty-1", replay);
  internals.sender = { data };
  return service;
}

describe("TerminalService replay authority", () => {
  it("does not emit retained frames for a warm reconnect gap", () => {
    const replay = new TerminalReplayBuffer(4);
    replay.record(1, new Uint8Array(4));
    replay.record(2, new Uint8Array(4));
    const data = vi.fn();
    const service = terminalServiceWithReplay(replay, data);

    expect(service.reattach("pty-1", 0)).toEqual({
      mode: "reset",
      discardThrough: 2,
    });
    expect(data).not.toHaveBeenCalled();
  });

  it("returns the checkpoint sequence before emitting its contiguous delta", () => {
    const replay = new TerminalReplayBuffer(64);
    replay.record(1, new Uint8Array([1]));
    expect(replay.checkpointAt(1, "screen")).toBe(true);
    replay.record(2, new Uint8Array([2]));
    const data = vi.fn();
    const service = terminalServiceWithReplay(replay, data);

    expect(service.reattach("pty-1", -1, true)).toEqual({
      mode: "checkpoint",
      checkpoint: "screen",
      checkpointThrough: 1,
    });
    expect(data).toHaveBeenCalledWith("pty-1", 2, new Uint8Array([2]));
  });
});

describe("TerminalService Windows teardown", () => {
  const originalPlatform = process.platform;
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  let dataDispose: ReturnType<typeof vi.fn>;
  let exitDispose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    dataDispose = vi.fn();
    exitDispose = vi.fn();
    spawnPty.mockImplementation(() => ({
      pid: 10_000 + spawnPty.mock.calls.length,
      onData: (callback: (data: string) => void) => {
        onData = callback;
        return { dispose: dataDispose };
      },
      onExit: (callback: (event: { exitCode: number; signal: number }) => void) => {
        onExit = callback;
        return { dispose: exitDispose };
      },
      kill: vi.fn(),
    }));
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("terminates the process tree before closing the Windows PTY", async () => {
    const pty = {
      pid: 12_345,
      kill: vi.fn(),
    } as unknown as IPty;
    const pidRegistry = {
      deregister: vi.fn(),
      clear: vi.fn(),
    };
    const settingsService = {
      get: () => ({ terminal: { behavior: { scrollback: 1_000 } } }),
      on: () => vi.fn(),
    };
    const service = new TerminalService(
      {} as never,
      {} as never,
      {} as never,
      settingsService as never,
      {} as never,
      pidRegistry as never,
      {} as never,
    );

    const session = {
      id: "pty-1",
      threadId: "thread-1",
      shell: "powershell.exe",
      cwd: "C:\\repo",
      pty,
      dataDisposable: { dispose: vi.fn() },
      exitDisposable: { dispose: vi.fn() },
      processScope: {
        ownsProcessTree: false,
        close: vi.fn(),
      },
      processScopeReady: Promise.resolve(false),
      headless: false,
      outputListeners: new Set(),
      exitListeners: new Set(),
      closeBarrier: Promise.resolve(),
      resolveCloseBarrier: vi.fn(),
    };
    const internals = service as unknown as {
      sessions: Map<string, typeof session>;
      threadIndex: Map<string, Set<string>>;
    };
    internals.sessions.set(session.id, session);
    internals.threadIndex.set(session.threadId, new Set([session.id]));

    await service.kill(session.id);

    expect(pty.kill).toHaveBeenCalledOnce();
    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(killProcessTree).toHaveBeenCalledWith(session.pty.pid, { platform: "win32" });
    const ptyKill = vi.mocked(pty.kill);
    expect(killProcessTree.mock.invocationCallOrder[0]).toBeLessThan(
      ptyKill.mock.invocationCallOrder[0]!,
    );
    expect(gracefulKillProcessTree).not.toHaveBeenCalled();
    expect(pidRegistry.deregister).toHaveBeenCalledWith(session.id);
  });

  it("rejects a fifth shell without evicting the existing four", () => {
    const cwd = process.cwd();
    const service = new TerminalService(
      { findById: () => ({ workspace_id: "workspace-1", mode: "direct", worktree_path: null }) } as never,
      { findById: () => ({ path: cwd }) } as never,
      { resolveWorkingDir: () => cwd } as never,
      {
        get: () => ({
          terminal: {
            behavior: { scrollback: 1_000 },
            flowControl: { serverHighBytes: 1_024, serverLowBytes: 512 },
          },
        }),
        on: () => vi.fn(),
      } as never,
      { getEnv: () => ({}) } as never,
      { register: vi.fn(), deregister: vi.fn(), clear: vi.fn() } as never,
      { assign: vi.fn(), setDescription: vi.fn() } as never,
    );

    for (let index = 0; index < 4; index += 1) service.create("thread-1");

    expect(() => service.create("thread-1")).toThrow("Maximum PTY limit (4)");
    expect(service.listActiveSessions()).toHaveLength(4);
    expect(spawnPty).toHaveBeenCalledTimes(4);
  });

  it("keeps a session connected when termination rejects, then publishes one natural exit", async () => {
    const service = createService();
    const sender = { json: vi.fn(), data: vi.fn() };
    service.setSender(sender);
    const { ptyId } = service.create("thread-1");
    service.resume(ptyId);
    killProcessTree.mockRejectedValueOnce(new Error("verification failed"));

    await expect(service.kill(ptyId)).rejects.toThrow("verification failed");
    onData?.("still connected");

    expect(sender.data).toHaveBeenCalledOnce();
    expect(service.listActiveSessions()).toEqual([{ ptyId, threadId: "thread-1" }]);
    expect(dataDispose).not.toHaveBeenCalled();
    expect(exitDispose).not.toHaveBeenCalled();

    onExit?.({ exitCode: 7, signal: 0 });
    onExit?.({ exitCode: 7, signal: 0 });

    expect(sender.json).toHaveBeenCalledOnce();
    expect(sender.json).toHaveBeenCalledWith("terminal.exit", { ptyId, code: 7 });
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("commits a requested close once when exit races successful termination", async () => {
    const service = createService();
    const sender = { json: vi.fn(), data: vi.fn() };
    service.setSender(sender);
    const { ptyId } = service.create("thread-1");
    killProcessTree.mockImplementationOnce(async () => {
      onExit?.({ exitCode: 9, signal: 0 });
    });

    await service.kill(ptyId);

    expect(sender.json).not.toHaveBeenCalled();
    expect(service.listActiveSessions()).toEqual([]);
    expect(dataDispose).toHaveBeenCalledOnce();
    expect(exitDispose).toHaveBeenCalledOnce();
  });

  it("replays fast headless output and exit exactly once after its owner attaches", () => {
    const service = createService();
    const prepared = service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Write-Output fast"],
    });

    onData?.("fast output");
    onExit?.({ exitCode: 0, signal: 0 });
    const output = vi.fn();
    const exit = vi.fn();
    prepared.onOutput(output);
    prepared.onExit(exit);

    expect(output).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(output.mock.calls[0]?.[0])).toBe("fast output");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("completes headless terminal cleanup when an Action exit listener fails", async () => {
    const service = createService();
    const prepared = service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Write-Output complete"],
    });
    prepared.onExit(() => { throw new Error("retained run persistence failed"); });

    expect(() => onExit?.({ exitCode: 0, signal: 0 })).not.toThrow();
    expect(service.listActiveSessions()).toEqual([]);
    expect(dataDispose).toHaveBeenCalledOnce();
    expect(exitDispose).toHaveBeenCalledOnce();
    await expect(prepared.stop()).resolves.toBeUndefined();
  });

  it("retains a synchronous headless exit until the Action owner attaches", () => {
    spawnPty.mockImplementationOnce(() => ({
      pid: 10_001,
      onData: (callback: (data: string) => void) => {
        callback("synchronous output");
        return { dispose: dataDispose };
      },
      onExit: (callback: (event: { exitCode: number; signal: number }) => void) => {
        callback({ exitCode: 0, signal: 0 });
        return { dispose: exitDispose };
      },
      kill: vi.fn(),
    }));
    const service = createService();

    const prepared = service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Write-Output synchronous"],
    });
    const output = vi.fn();
    const exit = vi.fn();
    prepared.onOutput(output);
    prepared.onExit(exit);

    expect(new TextDecoder().decode(output.mock.calls[0]?.[0])).toBe("synchronous output");
    expect(output).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("leaves a prepared Action session to its graceful lifecycle owner during generic thread teardown", async () => {
    const service = createService();
    service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Start-Sleep 1"],
    });

    await service.killByThread("thread-1");

    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("applies the app-wide Action capacity across threads", () => {
    const service = createService(undefined, undefined, 1);
    service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Start-Sleep 1"],
    });

    expect(() => service.startPreparedCommand("thread-2", {
      executable: "powershell.exe",
      arguments: ["-Command", "Start-Sleep 1"],
    })).toThrow();
    expect(spawnPty).toHaveBeenCalledOnce();
  });

  it("uses one bounded EnvService snapshot for the prepared process and retained names", () => {
    const environment = { PATH: "C:\\bin", MCODE_PORT: "19400" };
    const service = createService(undefined, undefined, 20, environment);

    const prepared = service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Write-Output environment"],
    });

    expect(spawnPty.mock.calls[0]?.[2]).toMatchObject({ env: environment });
    expect(prepared.environmentNames).toEqual(["MCODE_PORT", "PATH"]);
  });

  it("rejects an Action environment that cannot fit its retained launch snapshot", () => {
    const environment = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`KEY_${index}`, "value"]),
    );
    const service = createService(undefined, undefined, 20, environment);

    expect(() => service.startPreparedCommand("thread-1", {
      executable: "powershell.exe",
      arguments: ["-Command", "Write-Output environment"],
    })).toThrow();
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("publishes a raced natural exit once when termination fails", async () => {
    const service = createService();
    const sender = { json: vi.fn(), data: vi.fn() };
    service.setSender(sender);
    const { ptyId } = service.create("thread-1");
    killProcessTree.mockImplementationOnce(async () => {
      onExit?.({ exitCode: 11, signal: 0 });
      throw new Error("verification failed");
    });

    await expect(service.kill(ptyId)).rejects.toThrow("verification failed");

    expect(sender.json).toHaveBeenCalledOnce();
    expect(sender.json).toHaveBeenCalledWith("terminal.exit", { ptyId, code: 11 });
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "PTY exited",
      expect.objectContaining({
        id: ptyId,
        exitCode: 11,
        signal: 0,
        reason: "natural-exit",
      }),
    );
    expect(service.listActiveSessions()).toEqual([]);
    expect(dataDispose).toHaveBeenCalledOnce();
    expect(exitDispose).toHaveBeenCalledOnce();
  });

  it("shares one termination attempt across concurrent close requests", async () => {
    const service = createService();
    const { ptyId } = service.create("thread-1");
    let resolveTermination!: () => void;
    killProcessTree.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveTermination = resolve;
      }),
    );

    const first = service.kill(ptyId);
    const second = service.kill(ptyId);

    await vi.waitFor(() => expect(killProcessTree).toHaveBeenCalledOnce());
    expect(killProcessTree).toHaveBeenCalledOnce();
    resolveTermination();
    await Promise.all([first, second]);
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("uses the healthy Windows process scope without the slow process-tree fallback", async () => {
    const terminate = vi.fn(() => ({ ok: true }));
    const waitForEmpty = vi.fn().mockResolvedValue({ ok: true });
    const close = vi.fn();
    const processScope = {
      ready: true,
      ownsProcessTree: true,
      assign: vi.fn(() => ({ ok: true })),
      reconcile: vi.fn().mockResolvedValue({ ok: true }),
      terminate,
      waitForEmpty,
      close,
    };
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      { create: () => processScope },
    );
    const { ptyId } = service.create("thread-1");

    await service.kill(ptyId);

    expect(terminate).toHaveBeenCalledOnce();
    expect(waitForEmpty).toHaveBeenCalledWith(1_900);
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("assigns the global job before the terminal child job", () => {
    const calls: string[] = [];
    const service = createService(
      { assign: vi.fn(() => { calls.push("global"); return true; }), setDescription: vi.fn() },
      {
        create: () => ({
          ready: true,
          ownsProcessTree: true,
          assign: vi.fn(() => { calls.push("child"); return { ok: true }; }),
          reconcile: vi.fn().mockResolvedValue({ ok: true }),
          terminate: vi.fn(),
          waitForEmpty: vi.fn(),
          close: vi.fn(),
        }),
      },
    );

    service.create("thread-1");

    expect(calls).toEqual(["global", "child"]);
  });

  it("closes the child scope when the terminal exits naturally", () => {
    const close = vi.fn();
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      {
        create: () => ({
          ready: true,
          ownsProcessTree: true,
          assign: vi.fn(() => ({ ok: true })),
          reconcile: vi.fn().mockResolvedValue({ ok: true }),
          terminate: vi.fn(),
          waitForEmpty: vi.fn(),
          close,
        }),
      },
    );
    service.create("thread-1");

    onExit?.({ exitCode: 0, signal: 0 });

    expect(close).toHaveBeenCalledOnce();
  });

  it("checks the healthy Windows scope without launching child-process discovery", async () => {
    const queryProcessIds = vi.fn(() => ({
      ok: true,
      processIds: [10_001, 10_002],
      overflow: false,
    }));
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      {
        create: () => ({
          ready: true,
          ownsProcessTree: true,
          assign: vi.fn(() => ({ ok: true })),
          reconcile: vi.fn().mockResolvedValue({ ok: true }),
          queryProcessIds,
          terminate: vi.fn(),
          waitForEmpty: vi.fn(),
          close: vi.fn(),
        }),
      },
    );
    const { ptyId } = service.create("thread-1");

    await expect(service.hasChildren(ptyId)).resolves.toEqual({ hasChildren: true });
    expect(queryProcessIds).toHaveBeenCalledOnce();
  });

  it("keeps the session and listeners when scoped termination fails", async () => {
    const close = vi.fn();
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      {
        create: () => ({
          ready: true,
          ownsProcessTree: true,
          assign: vi.fn(() => ({ ok: true })),
          reconcile: vi.fn().mockResolvedValue({ ok: true }),
          terminate: vi.fn(() => ({ ok: false, error: "native termination failed" })),
          waitForEmpty: vi.fn(),
          close,
        }),
      },
    );
    const { ptyId } = service.create("thread-1");

    await expect(service.kill(ptyId)).rejects.toThrow("native termination failed");

    expect(service.listActiveSessions()).toEqual([{ ptyId, threadId: "thread-1" }]);
    expect(dataDispose).not.toHaveBeenCalled();
    expect(exitDispose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("falls back when descendant reconciliation rejects a partial enumeration", async () => {
    const processScope = {
      ready: true,
      ownsProcessTree: false,
      assign: vi.fn(() => ({ ok: true })),
      reconcile: vi.fn().mockResolvedValue({
        ok: false,
        error: "Process32NextW failed (5)",
      }),
      terminate: vi.fn(),
      waitForEmpty: vi.fn(),
      close: vi.fn(),
    };
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      { create: () => processScope },
    );
    const { ptyId } = service.create("thread-1");

    await service.kill(ptyId);

    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(processScope.terminate).not.toHaveBeenCalled();
  });

  it("falls back when descendant reconciliation rejects its promise", async () => {
    const processScope = {
      ready: true,
      ownsProcessTree: false,
      assign: vi.fn(() => ({ ok: true })),
      reconcile: vi.fn().mockRejectedValue(new Error("snapshot failed")),
      terminate: vi.fn(),
      waitForEmpty: vi.fn(),
      close: vi.fn(),
    };
    const service = createService(
      { assign: vi.fn(() => true), setDescription: vi.fn() },
      { create: () => processScope },
    );
    const { ptyId } = service.create("thread-1");

    await service.kill(ptyId);

    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(processScope.terminate).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "PTY process scope reconciliation failed; close will use process-tree fallback",
      expect.objectContaining({ error: "snapshot failed" }),
    );
  });

  it("clears the authority timeout when reconciliation settles first", async () => {
    const service = createService();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const awaitAuthority = (
      service as unknown as {
        awaitProcessScopeAuthority: (
          session: { processScopeReady: Promise<boolean> },
          timeoutMs: number,
        ) => Promise<boolean>;
      }
    ).awaitProcessScopeAuthority.bind(service);

    await expect(awaitAuthority({ processScopeReady: Promise.resolve(true) }, 500))
      .resolves.toBe(true);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
  });

  function createService(
    jobObject: object = { assign: vi.fn(), setDescription: vi.fn() },
    processScopeFactory?: object,
    sessionLimit = 20,
    environment: Record<string, string> = {},
  ): TerminalService {
    const cwd = process.cwd();
    return new TerminalService(
      { findById: () => ({ workspace_id: "workspace-1", mode: "direct", worktree_path: null }) } as never,
      { findById: () => ({ path: cwd }) } as never,
      { resolveWorkingDir: () => cwd } as never,
      {
        get: () => ({
          terminal: {
            behavior: { scrollback: 1_000, sessionLimit },
            flowControl: { serverHighBytes: 1_024, serverLowBytes: 512 },
          },
        }),
        on: () => vi.fn(),
      } as never,
      { getEnv: () => environment } as never,
      { register: vi.fn(), deregister: vi.fn(), clear: vi.fn() } as never,
      jobObject as never,
      processScopeFactory as never,
    );
  }
});
