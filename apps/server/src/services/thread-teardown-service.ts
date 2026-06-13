/**
 * Central teardown boundary for resources owned by a single thread.
 */
import { injectable, inject } from "tsyringe";
import { AgentService } from "./agent-service";
import { TerminalService } from "./terminal-service";
import { ThreadRepo } from "../repositories/thread-repo";

function failureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/** Tears down active and pooled runtime resources before a thread is deleted. */
@injectable()
export class ThreadTeardownService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AgentService) private readonly agentService: AgentService,
    @inject(TerminalService) private readonly terminalService: TerminalService,
  ) {}

  /** Stop provider sessions and kill PTYs for a thread before its row is deleted. */
  async teardownThread(threadId: string): Promise<void> {
    if (!this.threadRepo.findById(threadId)) return;

    const results = await Promise.allSettled([
      this.agentService.teardownSession(threadId),
      this.terminalService.killByThread(threadId),
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
      throw new Error(
        `Thread teardown failed for ${threadId}: ${failures.map(failureMessage).join("; ")}`,
      );
    }
  }
}
