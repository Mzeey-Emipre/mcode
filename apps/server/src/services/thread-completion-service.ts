import { inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { AgentService } from "./agent-service";
import { ThreadTeardownService } from "./thread-teardown-service";
import { ThreadControlMutationReservationService } from "./thread-control-mutation-reservation-service";

const DEFAULT_RETENTION_MS = 72 * 60 * 60 * 1_000;

function completionFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/** Owns durable user completion and reopen transitions for one thread. */
@injectable()
export class ThreadCompletionService {
  private readonly resourceOwners = new Map<string, (threadId: string) => Promise<void>>();

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AgentService) private readonly agentService: AgentService,
    @inject(ThreadTeardownService) private readonly teardownService: ThreadTeardownService,
    @inject(ThreadControlMutationReservationService)
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject("ThreadCompletionClock", { isOptional: true })
    private readonly clock?: () => Date,
  ) {}

  /** Register an additional server-side owner of thread runtime resources. */
  registerResourceOwner(name: string, release: (threadId: string) => Promise<void>): void {
    if (this.resourceOwners.has(name)) {
      throw new Error(`Thread resource owner is already registered: ${name}`);
    }
    this.resourceOwners.set(name, release);
  }

  /** Complete an idle thread and release its thread-owned runtime resources. */
  async complete(threadId: string): Promise<Thread> {
    const token = this.mutationReservations.reserve(threadId, "completing");
    if (!token) throw new Error(`Thread has a pending mutation: ${threadId}`);

    try {
      const thread = this.requireThread(threadId);
      if (thread.user_completed_at !== null) return thread;
      if (this.agentService.activeThreadIds().includes(threadId)) {
        throw new Error("Thread cannot be completed while it is running");
      }
      if (this.agentService.listPendingPermissions(threadId).length > 0) {
        throw new Error("Thread cannot be completed while permission is pending");
      }

      const completedAt = this.clock?.() ?? new Date();
      const completed = this.threadRepo.complete(
        thread.id,
        completedAt.toISOString(),
        new Date(completedAt.getTime() + DEFAULT_RETENTION_MS).toISOString(),
      );
      if (!completed) throw new Error(`Thread not found: ${threadId}`);
      const releases = [
        this.teardownService.teardownThread(threadId),
        ...[...this.resourceOwners.values()].map((release) => release(threadId)),
      ];
      const failures = (await Promise.allSettled(releases)).filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        this.threadRepo.reopen(threadId, thread.updated_at);
        throw new Error(
          `Thread completion failed for ${threadId}: ${failures.map(completionFailureMessage).join("; ")}`,
        );
      }
      return completed;
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  /** Reopen a completed thread and cancel its pending automatic deletion. */
  reopen(threadId: string): Thread {
    const token = this.mutationReservations.reserve(threadId, "reopening");
    if (!token) throw new Error(`Thread has a pending mutation: ${threadId}`);

    try {
      this.requireThread(threadId);
      const reopened = this.threadRepo.reopen(threadId, (this.clock?.() ?? new Date()).toISOString());
      if (!reopened) throw new Error(`Thread not found: ${threadId}`);
      return reopened;
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  private requireThread(threadId: string): Thread {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }
}
