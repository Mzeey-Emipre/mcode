import { inject, injectable } from "tsyringe";
import {
  THREAD_STARTUP_TRANSCRIPT_MAX_CHARS,
  THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES,
  ThreadStartupTranscriptEntrySchema,
  type ThreadStartup,
  type ThreadStartupError,
  type ThreadStartupKind,
  type ThreadStartupPhase,
  type ThreadStartupStartInput,
} from "@mcode/contracts";
import { broadcast } from "../../application/transport/push.js";
import { ThreadStartupRepo } from "./persistence/thread-startup-repo.js";

const phasesByKind: Record<ThreadStartupKind, readonly ThreadStartupPhase[]> = {
  direct: ["thread", "agent"],
  "managed-worktree": ["thread", "worktree", "setup", "agent"],
  "pull-request-review": ["thread", "worktree", "agent"],
};

const terminalStates = new Set<ThreadStartup["state"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Signals that an existing startup ID belongs to a different startup request. */
export class ThreadStartupConflictError extends Error {
  constructor(startupId: string) {
    super(`Startup ID ${startupId} is already assigned to a different request`);
  }
}

/** Owns durable lifecycle state and full-snapshot publication for thread startup. */
@injectable()
export class ThreadStartupService {
  constructor(
    @inject(ThreadStartupRepo) private readonly startupRepo: ThreadStartupRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Start one lifecycle or return its existing snapshot when the request matches. */
  start(input: ThreadStartupStartInput): ThreadStartup {
    const existing = this.startupRepo.findById(input.startupId);
    if (existing) {
      if (existing.workspaceId === input.workspaceId && existing.kind === input.kind) return existing;
      throw new ThreadStartupConflictError(input.startupId);
    }

    const timestamp = this.now().toISOString();
    const phases = phasesByKind[input.kind];
    const startup: ThreadStartup = {
      ...input,
      state: "pending",
      phase: phases[0],
      steps: phases.map((phase) => ({ phase, state: "pending" })),
      transcript: [],
      cancellation: "none",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.startupRepo.insert(startup);
    return this.publish(startup);
  }

  /** Read one authoritative lifecycle snapshot. */
  get(startupId: string): ThreadStartup | null {
    return this.startupRepo.findById(startupId);
  }

  /** List authoritative lifecycle snapshots for one workspace. */
  list(workspaceId: string): ThreadStartup[] {
    return this.startupRepo.listByWorkspace(workspaceId);
  }

  /** Mark the current phase active or move from it to the next phase. */
  advance(startupId: string, phase: ThreadStartupPhase): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const targetIndex = startup.steps.findIndex((step) => step.phase === phase);
    if (targetIndex < 0) throw new Error(`Phase ${phase} does not apply to startup ${startupId}`);

    if (startup.state === "pending") {
      if (targetIndex !== 0) throw new Error("Startup must begin with its first phase");
      return this.persistNext({
        ...startup,
        state: "running",
        phase,
        steps: startup.steps.map((step, index) => index === 0 ? { ...step, state: "running" } : step),
      });
    }

    const activeIndex = startup.steps.findIndex((step) => step.state === "running");
    if (targetIndex === activeIndex) return startup;
    if (targetIndex !== activeIndex + 1) throw new Error("Startup phases must advance in order");
    return this.persistNext({
      ...startup,
      phase,
      steps: startup.steps.map((step, index) => {
        if (index === activeIndex) return { ...step, state: "completed" };
        if (index === targetIndex) return { ...step, state: "running" };
        return step;
      }),
    });
  }

  /** Bind the durable thread identity when a startup flow creates or reuses a thread. */
  bindThread(startupId: string, threadId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) || startup.threadId === threadId) return startup;
    return this.persistNext({ ...startup, threadId });
  }

  /** Append one bounded output entry and retain only the newest bounded transcript. */
  appendOutput(startupId: string, content: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const entry = ThreadStartupTranscriptEntrySchema().parse({
      phase: startup.phase,
      content,
      createdAt: this.now().toISOString(),
    });
    return this.persistNext({
      ...startup,
      transcript: retainTranscript([...startup.transcript, entry]),
    });
  }

  /** Complete the final active phase and make the lifecycle terminal. */
  complete(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const activeIndex = this.activeIndex(startup);
    if (activeIndex !== startup.steps.length - 1) throw new Error("Startup cannot complete before its final phase");
    return this.persistNext({
      ...startup,
      state: "completed",
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "completed" }
        : step),
    });
  }

  /** Fail the current phase with structured error detail. */
  fail(startupId: string, error: ThreadStartupError): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "failed",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "failed" }
        : step),
      error,
    });
  }

  /** Record cancellation intent. Integrations must query this before they stop owned work. */
  cancel(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) || startup.cancellation === "requested") return startup;
    return this.persistNext({ ...startup, cancellation: "requested" });
  }

  /** Mark a startup cancelled only after its owning integration stops its own work. */
  markCancelled(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "cancelled",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "cancelled" }
        : step),
      cancellation: "requested",
    });
  }

  /** Return whether an integration must stop or avoid starting more owned work. */
  isCancellationRequested(startupId: string): boolean {
    return this.require(startupId).cancellation === "requested";
  }

  /** Mark all incomplete startup records as interrupted after a server restart. */
  interruptNonterminalOnStartup(): ThreadStartup[] {
    return this.startupRepo.listNonterminal().map((startup) => {
      const activeIndex = this.currentIndex(startup);
      return this.persistNext({
        ...startup,
        state: "interrupted",
        phase: startup.steps[activeIndex].phase,
        steps: startup.steps.map((step, index) => index === activeIndex
          ? { ...step, state: "interrupted" }
          : step),
      });
    });
  }

  private require(startupId: string): ThreadStartup {
    const startup = this.startupRepo.findById(startupId);
    if (!startup) throw new Error(`Startup ${startupId} was not found`);
    return startup;
  }

  private activeIndex(startup: ThreadStartup): number {
    const index = startup.steps.findIndex((step) => step.state === "running");
    if (index < 0) throw new Error(`Startup ${startup.startupId} has no active phase`);
    return index;
  }

  private currentIndex(startup: ThreadStartup): number {
    if (startup.state === "running") return this.activeIndex(startup);
    return startup.steps.findIndex((step) => step.phase === startup.phase);
  }

  private persistNext(startup: ThreadStartup): ThreadStartup {
    const persisted: ThreadStartup = {
      ...startup,
      revision: startup.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    this.startupRepo.update(persisted);
    return this.publish(persisted);
  }

  private publish(startup: ThreadStartup): ThreadStartup {
    broadcast("thread.startup.updated", startup);
    return startup;
  }
}

function retainTranscript(transcript: ThreadStartup["transcript"]): ThreadStartup["transcript"] {
  const retained = transcript.slice(-THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES);
  while (retained.reduce((total, entry) => total + entry.content.length, 0) > THREAD_STARTUP_TRANSCRIPT_MAX_CHARS) {
    retained.shift();
  }
  return retained;
}

function isTerminal(startup: ThreadStartup): boolean {
  return terminalStates.has(startup.state);
}
