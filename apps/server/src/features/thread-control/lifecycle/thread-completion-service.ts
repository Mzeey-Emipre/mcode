import { inject, injectable } from "tsyringe";
import type { CompletedThreadRetentionDays, Settings, Thread } from "@mcode/contracts";
import { ThreadRepo } from "../../../repositories/thread-repo";
import { AgentService } from "../../agents/index.js";
import { SettingsService } from "../../../shared/settings/settings-service";
import { ThreadTeardownService } from "./thread-teardown-service";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OVERDUE_SAFETY_MS = DAY_MS;
const RETENTION_RECALCULATION_BATCH_SIZE = 100;

function completionFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/** Owns durable user completion and reopen transitions for one thread. */
@injectable()
export class ThreadCompletionService {
  private readonly resourceOwners = new Map<string, (threadId: string) => Promise<void>>();
  private deadlineChangesListener: ((threads: readonly Thread[]) => void) | null = null;
  private lastRetentionDays: CompletedThreadRetentionDays | undefined;
  private unsubscribeSettings: (() => void) | null = null;
  private retentionRecalculationGeneration = 0;

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AgentService) private readonly agentService: AgentService,
    @inject(ThreadTeardownService) private readonly teardownService: ThreadTeardownService,
    @inject(ThreadControlMutationReservationService)
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("ThreadCompletionClock", { isOptional: true })
    private readonly clock?: () => Date,
  ) {}

  /** Start retention reconciliation for settings changes. */
  start(): void {
    if (this.unsubscribeSettings) return;
    this.lastRetentionDays = this.retentionDays(this.settingsService.get());
    this.unsubscribeSettings = this.settingsService.on("change", (settings) => {
      const nextRetentionDays = this.retentionDays(settings);
      const previousRetentionDays = this.lastRetentionDays;
      if (previousRetentionDays === nextRetentionDays) return;
      if (previousRetentionDays === undefined) {
        this.lastRetentionDays = nextRetentionDays;
        return;
      }
      this.lastRetentionDays = nextRetentionDays;
      const generation = ++this.retentionRecalculationGeneration;
      this.recalculateDeadlineBatch(
        previousRetentionDays,
        nextRetentionDays,
        null,
        generation,
      );
    });
  }

  /** Stop retention reconciliation for settings changes. */
  stop(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.retentionRecalculationGeneration += 1;
  }

  /** Register the push publisher for recalculated thread deadlines. */
  onDeadlineChanges(listener: (threads: readonly Thread[]) => void): void {
    this.deadlineChangesListener = listener;
  }

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
      const retentionDays = this.retentionDays(this.settingsService.get());
      const completed = this.threadRepo.complete(
        thread.id,
        completedAt.toISOString(),
        retentionDays === null
          ? null
          : new Date(completedAt.getTime() + retentionDays * DAY_MS).toISOString(),
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
      if (!reopened) {
        const current = this.threadRepo.findById(threadId);
        if (
          current?.cleanup_state === "running"
          || (current?.cleanup_state === "blocked" && this.threadRepo.hasRetentionCleanupJob(threadId))
        ) {
          throw new Error("Thread cleanup has already started");
        }
        throw new Error(`Thread not found: ${threadId}`);
      }
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

  private retentionDays(settings: Settings): CompletedThreadRetentionDays {
    return settings.thread.completion.retentionDays;
  }

  private recalculateDeadlineBatch(
    previousRetentionDays: CompletedThreadRetentionDays,
    nextRetentionDays: CompletedThreadRetentionDays,
    afterId: string | null,
    generation: number,
  ): void {
    if (generation !== this.retentionRecalculationGeneration) return;
    const now = this.clock?.() ?? new Date();
    const nowMs = now.getTime();
    const safetyDeadline = new Date(nowMs + OVERDUE_SAFETY_MS).toISOString();
    const shorter = nextRetentionDays !== null
      && (previousRetentionDays === null || nextRetentionDays < previousRetentionDays);
    const records = this.threadRepo.listCompletedRetentionRecords(
      afterId,
      RETENTION_RECALCULATION_BATCH_SIZE,
    );
    const updates = records.flatMap((record) => {
      const calculatedDeadline = nextRetentionDays === null
        ? null
        : new Date(
          new Date(record.userCompletedAt).getTime() + nextRetentionDays * DAY_MS,
        ).toISOString();
      const newlyOverdue = shorter
        && calculatedDeadline !== null
        && new Date(calculatedDeadline).getTime() <= nowMs
        && (
          record.scheduledDeletionAt === null
          || new Date(record.scheduledDeletionAt).getTime() > nowMs
        );
      const nextScheduledDeletionAt = newlyOverdue ? safetyDeadline : calculatedDeadline;
      return nextScheduledDeletionAt === record.scheduledDeletionAt
        ? []
        : [{ ...record, nextScheduledDeletionAt }];
    });
    const changed = this.threadRepo.updateCompletedThreadDeadlines(updates);
    if (changed.length > 0) this.deadlineChangesListener?.(changed);
    if (records.length < RETENTION_RECALCULATION_BATCH_SIZE) return;
    const nextAfterId = records.at(-1)!.id;
    setTimeout(() => {
      this.recalculateDeadlineBatch(
        previousRetentionDays,
        nextRetentionDays,
        nextAfterId,
        generation,
      );
    }, 0);
  }
}
