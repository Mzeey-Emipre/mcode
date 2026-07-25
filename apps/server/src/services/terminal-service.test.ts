import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";

const { killProcessTree, gracefulKillProcessTree } = vi.hoisted(() => ({
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  gracefulKillProcessTree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./process-kill.js", () => ({
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

import { TerminalService } from "./terminal-service";
import { TerminalReplayBuffer } from "./terminal-replay-buffer";

function terminalServiceWithReplay(
  replay: TerminalReplayBuffer,
  data: ReturnType<typeof vi.fn>,
): TerminalService {
  const settingsService = {
    get: () => ({ terminal: { scrollback: 1_000 } }),
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

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("uses the ConPTY DLL session as the single Windows process-tree owner", async () => {
    const pty = {
      pid: 12_345,
      kill: vi.fn(),
    } as unknown as IPty;
    const pidRegistry = {
      deregister: vi.fn(),
      clear: vi.fn(),
    };
    const settingsService = {
      get: () => ({ terminal: { scrollback: 1_000 } }),
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
    };
    const internals = service as unknown as {
      sessions: Map<string, typeof session>;
      threadIndex: Map<string, Set<string>>;
    };
    internals.sessions.set(session.id, session);
    internals.threadIndex.set(session.threadId, new Set([session.id]));

    await service.kill(session.id);

    expect(pty.kill).toHaveBeenCalledOnce();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(gracefulKillProcessTree).not.toHaveBeenCalled();
    expect(pidRegistry.deregister).toHaveBeenCalledWith(session.id);
  });
});
