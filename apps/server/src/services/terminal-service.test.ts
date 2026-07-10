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
