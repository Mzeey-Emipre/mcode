import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked so the busy probe does not inspect the real OS process tree.
const listDirectChildren = vi.fn();
vi.mock("../process-kill.js", () => ({
  listDirectChildren: (...args: unknown[]) => listDirectChildren(...args),
  killProcessTree: vi.fn(),
  gracefulKillProcessTree: vi.fn(),
}));

import { TerminalService } from "../terminal-service.js";

/** Build a TerminalService with stubbed deps and the given fake PTY sessions. */
function makeService(sessions: Array<{ id: string; pid: number }>): TerminalService {
  const settingsService = {
    get: () => ({ terminal: { scrollback: 1000 } }),
    on: () => () => {},
  };
  const svc = new TerminalService(
    null as never, // ThreadRepo
    null as never, // WorkspaceRepo
    null as never, // GitService
    settingsService as never,
    null as never, // EnvService
    null as never, // PtyPidRegistry
    null as never, // JobObject
  );
  (svc as unknown as { sessions: Map<string, unknown> }).sessions = new Map(
    sessions.map((s) => [s.id, { id: s.id, threadId: "t", pty: { pid: s.pid } }]),
  );
  return svc;
}

describe("TerminalService.countBusySessions", () => {
  beforeEach(() => {
    listDirectChildren.mockReset();
  });

  it("counts only sessions running a non-shell child", async () => {
    const svc = makeService([
      { id: "a", pid: 100 },
      { id: "b", pid: 200 },
      { id: "c", pid: 300 },
    ]);
    listDirectChildren.mockImplementation(async (pid: number) => {
      if (pid === 100) return [{ name: "node", pid: 101 }]; // running command
      if (pid === 200) return [{ name: "bash", pid: 201 }]; // idle shell child
      return []; // idle prompt
    });

    expect(await svc.countBusySessions()).toBe(1);
  });

  it("returns 0 when every shell is idle at a prompt", async () => {
    const svc = makeService([{ id: "a", pid: 100 }]);
    listDirectChildren.mockResolvedValue([]);

    expect(await svc.countBusySessions()).toBe(0);
  });

  it("treats an uninspectable process tree as not busy", async () => {
    const svc = makeService([{ id: "a", pid: 100 }]);
    listDirectChildren.mockRejectedValue(new Error("no such process"));

    expect(await svc.countBusySessions()).toBe(0);
  });
});
