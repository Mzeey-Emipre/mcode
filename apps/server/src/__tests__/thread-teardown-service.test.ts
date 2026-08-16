import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ThreadRepo } from "../repositories/thread-repo";
import { ThreadTeardownService } from "../services/thread-teardown-service";
import type { AgentService } from "../features/agents/index.js";
import type { TerminalBackend as TerminalService } from "../terminal/terminal-backend.js";

function build(existingThreadId: string | null = "thread-1") {
  const threadRepo = {
    findById: vi.fn((threadId: string) =>
      existingThreadId === threadId ? { id: threadId } : null,
    ),
  } as unknown as ThreadRepo;
  const agentService = {
    teardownSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentService;
  const terminalService = {
    killByThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as TerminalService;
  const service = new ThreadTeardownService(threadRepo, agentService, terminalService);
  return { threadRepo, agentService, terminalService, service };
}

describe("ThreadTeardownService", () => {
  it("stops provider sessions and kills PTYs for an existing thread", async () => {
    const { agentService, terminalService, service } = build("thread-1");

    await service.teardownThread("thread-1");

    expect(agentService.teardownSession).toHaveBeenCalledWith("thread-1");
    expect(terminalService.killByThread).toHaveBeenCalledWith("thread-1");
  });

  it("leaves resource owners untouched when the thread row is gone", async () => {
    const { agentService, terminalService, service } = build();

    await service.teardownThread("missing-thread");

    expect(agentService.teardownSession).not.toHaveBeenCalled();
    expect(terminalService.killByThread).not.toHaveBeenCalled();
  });
});
