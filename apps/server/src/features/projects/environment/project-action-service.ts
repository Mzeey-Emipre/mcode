import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import {
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  type WorkspaceEnvironmentActionRun,
  type WorkspaceEnvironmentActionSlotInput,
} from "@mcode/contracts";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  TERMINAL_BACKEND_TOKEN,
  PreparedTerminalCommandStartError,
  type PreparedTerminalCommandSession,
  type TerminalBackend,
} from "../../terminal/backends/terminal-backend.js";
import {
  WorkspaceEnvironmentService,
  selectWorkspaceEnvironmentScript,
} from "./workspace-environment-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";

interface ActiveProjectAction {
  state: "running" | "pending-finalization";
  readonly threadId: string;
  readonly actionId: string;
  readonly session: PreparedTerminalCommandSession;
  run: WorkspaceEnvironmentActionRun;
  pendingFinalization: WorkspaceEnvironmentActionRun | null;
  stopping: boolean;
}

interface StartingProjectAction {
  readonly state: "starting";
  readonly threadId: string;
  readonly actionId: string;
  readonly settled: Promise<ActiveProjectAction | null>;
  resolve(active: ActiveProjectAction | null): void;
}

type ProjectActionSlotState = ActiveProjectAction | StartingProjectAction;

interface ThreadActionLifecycle {
  closing: boolean;
  teardownCount: number;
  readonly starts: Set<Promise<void>>;
}

interface WorkspaceActionLifecycle {
  closing: boolean;
  teardownCount: number;
  readonly starts: Set<Promise<void>>;
}

/** Clock used to timestamp Project Action lifecycle transitions. */
export type ProjectActionClock = () => Date;

/** Factory used to assign a new immutable identity to each Project Action run. */
export type ProjectActionRunIdFactory = () => string;

/** Dependency-injection token for the production Project Action clock. */
export const PROJECT_ACTION_CLOCK_TOKEN = "ProjectActionClock";

/** Dependency-injection token for the production Project Action run-ID factory. */
export const PROJECT_ACTION_RUN_ID_FACTORY_TOKEN = "ProjectActionRunIdFactory";

/** Validated durable Project Action update delivered to connected Thread views. */
export interface ProjectActionRunUpdate {
  readonly threadId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly run: WorkspaceEnvironmentActionRun;
}

/** Owns Project Action slot exclusion, latest-run retention, and backend process lifecycle. */
@injectable()
export class ProjectActionService {
  private readonly active = new Map<string, ProjectActionSlotState>();
  private readonly listeners = new Set<(update: ProjectActionRunUpdate) => void>();
  private readonly threadLifecycles = new Map<string, ThreadActionLifecycle>();
  private readonly workspaceLifecycles = new Map<string, WorkspaceActionLifecycle>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private lastTimestampMs = Number.NEGATIVE_INFINITY;

  constructor(
    @inject(ProjectActionRunRepo) private readonly runs: ProjectActionRunRepo,
    @inject(WorkspaceEnvironmentService) private readonly environment: WorkspaceEnvironmentService,
    @inject("ThreadRepo") private readonly threads: ThreadRepo,
    @inject(TERMINAL_BACKEND_TOKEN) private readonly terminal: TerminalBackend,
    @inject(PROJECT_ACTION_CLOCK_TOKEN)
    private readonly now: ProjectActionClock = () => new Date(),
    @inject(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN)
    private readonly createRunId: ProjectActionRunIdFactory = randomUUID,
  ) {}

  /** Subscribes to retained Action run changes produced by this server process. */
  onUpdate(listener: (update: ProjectActionRunUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lists bounded retained Action results for one Thread. */
  list(threadId: string): WorkspaceEnvironmentActionRun[] {
    return this.runs.list(threadId);
  }

  /** Returns one retained Action result for a stable Thread and Action slot. */
  get(input: WorkspaceEnvironmentActionSlotInput): WorkspaceEnvironmentActionRun | null {
    return this.runs.get(input.threadId, input.actionId);
  }

  /** Starts one configured Action in its private retained terminal session. */
  async start(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    const slot = slotKey(input.threadId, input.actionId);
    if (this.active.has(slot)) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
        "This Project Action is already running for this Thread",
      );
    }
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at) {
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread not found");
    }
    this.assertThreadCanStart(thread);
    const reservation = createStartingProjectAction(thread.id, input.actionId);
    this.active.set(slot, reservation);
    let releaseAdmission: (() => void) | null = null;
    try {
      releaseAdmission = this.reserveThreadStart(thread.id, thread.workspace_id);
      const document = await this.environment.read(thread.workspace_id);
      this.assertThreadCanStart(thread);
      const action = document.document.actions.find((candidate) => candidate.id === input.actionId);
      if (!action) {
        throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND", "Project Action not found");
      }
      const script = selectWorkspaceEnvironmentScript(action.command, platform());
      if (script === null) return this.persistAndPublish(
        this.createUnavailableRun(thread.id, thread.workspace_id, action.id, action.name),
      );

      let session: PreparedTerminalCommandSession | null = null;
      try {
        session = await this.terminal.startPreparedCommand({ threadId: thread.id, script });
        const timestamp = this.timestamp();
        const active: ActiveProjectAction = {
          state: "running",
          threadId: thread.id,
          actionId: action.id,
          session,
          run: {
            threadId: thread.id,
            workspaceId: thread.workspace_id,
            actionId: action.id,
            runId: this.createRunId(),
            revision: 0,
            terminalSessionId: session.terminalSessionId,
            actionName: action.name,
            status: "running",
            snapshot: session.snapshot,
            createdAt: timestamp,
            startedAt: timestamp,
            finishedAt: null,
            exitCode: null,
            transcript: "",
            transcriptTruncated: false,
          },
          pendingFinalization: null,
          stopping: false,
        };
        this.active.set(slot, active);
        this.persistAndPublish(active.run);
        session.onOutput((data) => this.recordOutput(slot, active.run.runId, data));
        session.onExit((exit) => this.finish(slot, active.run.runId, exit.exitCode));
        reservation.resolve(this.active.get(slot) === active ? active : null);
        return active.run;
      } catch (error) {
        if (session) {
          const active = this.active.get(slot);
          if (active?.state === "running") {
            active.stopping = true;
            session.onExit((exit) => this.finish(slot, active.run.runId, exit.exitCode));
          }
          try {
            await session.stop();
          } catch (cleanupError) {
            const retained = this.active.get(slot);
            reservation.resolve(retained?.state === "running" ? retained : null);
            throw new AggregateError([error, cleanupError], "Project Action launch and cleanup failed", { cause: error });
          }
          const retained = this.active.get(slot);
          reservation.resolve(retained?.state === "running" ? retained : null);
          throw error;
        }
        return this.persistAndPublish(this.createFailedRun(
          thread.id,
          thread.workspace_id,
          action.id,
          action.name,
          script,
          error instanceof PreparedTerminalCommandStartError ? error.snapshot : null,
        ));
      }
    } finally {
      if (this.active.get(slot) === reservation) {
        this.active.delete(slot);
        reservation.resolve(null);
      }
      releaseAdmission?.();
    }
  }

  /** Stops one running Action and waits for its backend close barrier. */
  async stop(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun | null> {
    const slot = slotKey(input.threadId, input.actionId);
    const state = this.active.get(slot);
    if (!state) return this.runs.get(input.threadId, input.actionId);
    const active = state.state === "starting" ? await state.settled : state;
    if (!active) return this.runs.get(input.threadId, input.actionId);
    if (active.state === "pending-finalization") {
      this.retryPendingFinalization(slot, active);
      return this.runs.get(input.threadId, input.actionId);
    }
    active.stopping = true;
    try {
      await active.session.stop();
    } finally {
      const current = this.active.get(slot);
      if (current?.state === "pending-finalization") this.retryPendingFinalization(slot, current);
    }
    return this.runs.get(input.threadId, input.actionId);
  }

  /** Restarts a slot only after its prior terminal fully closes. */
  async restart(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    await this.stop(input);
    return this.start(input);
  }

  /** Stops all active Action sessions owned by one Thread. */
  async stopForThread(threadId: string): Promise<void> {
    const actions = [...this.active.values()]
      .filter((active) => active.threadId === threadId)
      .map((active) => this.stop({ threadId, actionId: active.actionId }));
    await Promise.all(actions);
  }

  /** Blocks new starts for one Thread and waits for starts already admitted to settle. */
  async beginThreadTeardown(threadId: string): Promise<() => void> {
    const lifecycle = this.lifecycleFor(threadId);
    lifecycle.teardownCount += 1;
    lifecycle.closing = true;
    await Promise.all([...lifecycle.starts]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lifecycle.teardownCount -= 1;
      if (!this.disposed && lifecycle.teardownCount === 0) lifecycle.closing = false;
      this.removeLifecycleIfIdle(threadId, lifecycle);
    };
  }

  /** Blocks new starts for every Thread in a Workspace while deletion tears it down. */
  async beginWorkspaceTeardown(workspaceId: string): Promise<() => void> {
    const lifecycle = this.workspaceLifecycleFor(workspaceId);
    lifecycle.teardownCount += 1;
    lifecycle.closing = true;
    await Promise.all([...lifecycle.starts]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lifecycle.teardownCount -= 1;
      if (!this.disposed && lifecycle.teardownCount === 0) lifecycle.closing = false;
      this.removeWorkspaceLifecycleIfIdle(workspaceId, lifecycle);
    };
  }

  /** Restores Action admission after a completed Thread is reopened. */
  reopenThread(threadId: string): void {
    const lifecycle = this.lifecycleFor(threadId);
    if (lifecycle.teardownCount === 0) lifecycle.closing = false;
    this.removeLifecycleIfIdle(threadId, lifecycle);
  }

  /** Stops all active Action sessions before the selected terminal backend shuts down. */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    const barriers = await Promise.all([...this.threadLifecycles.keys()]
      .map((threadId) => this.beginThreadTeardown(threadId)));
    try {
      await Promise.all([...new Set([...this.active.values()].map((active) => active.threadId))]
        .map((threadId) => this.stopForThread(threadId)));
    } finally {
      for (const release of barriers) release();
      this.threadLifecycles.clear();
      this.workspaceLifecycles.clear();
    }
  }

  /** Converts surviving persisted running rows to interrupted after startup recovery has reaped terminals. */
  recoverStaleRuns(): WorkspaceEnvironmentActionRun[] {
    const interrupted: WorkspaceEnvironmentActionRun[] = [];
    while (true) {
      const runs = this.runs.interruptRunning(this.timestamp());
      for (const run of runs) this.publish(run);
      interrupted.push(...runs);
      if (runs.length < 256) return interrupted;
    }
  }

  private recordOutput(slot: string, runId: string, data: Uint8Array): void {
    const active = this.active.get(slot);
    if (!active || active.state !== "running" || active.run.runId !== runId) return;
    const next = appendTranscript(active.run.transcript, active.run.transcriptTruncated, data);
    active.run = { ...active.run, ...next, revision: active.run.revision + 1 };
    try {
      if (this.runs.updateIfCurrent(active.run)) this.publish(active.run);
    } catch (error) {
      logger.warn("Project Action output persistence failed; retaining output for the next durable update", {
        threadId: active.threadId,
        actionId: active.actionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private finish(slot: string, runId: string, exitCode: number | null): void {
    const active = this.active.get(slot);
    if (!active || active.state !== "running" || active.run.runId !== runId) return;
    const status = active.stopping
      ? "interrupted"
      : exitCode === 0
        ? "completed"
        : "failed";
    const finalRun: WorkspaceEnvironmentActionRun = {
      ...active.run,
      revision: active.run.revision + 1,
      status,
      finishedAt: this.timestamp(),
      exitCode: status === "interrupted" ? null : exitCode,
    };
    active.run = finalRun;
    active.pendingFinalization = finalRun;
    active.state = "pending-finalization";
    this.retryPendingFinalization(slot, active);
  }

  private retryPendingFinalization(slot: string, active: ActiveProjectAction): void {
    const finalRun = active.pendingFinalization;
    if (active.state !== "pending-finalization" || !finalRun) return;
    let persisted: boolean;
    try {
      persisted = this.runs.updateIfCurrent(finalRun);
    } catch (error) {
      logger.warn("Project Action finalization persistence failed; retaining the slot for retry", {
        threadId: active.threadId,
        actionId: active.actionId,
        runId: finalRun.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.active.get(slot) !== active) return;
    this.active.delete(slot);
    if (persisted) this.publish(finalRun);
  }

  private createUnavailableRun(
    threadId: string,
    workspaceId: string,
    actionId: string,
    actionName: string,
  ): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return {
      threadId,
      workspaceId,
      actionId,
      runId: this.createRunId(),
      revision: 0,
      terminalSessionId: null,
      actionName,
      status: "unavailable",
      snapshot: {
        platform: platform(),
        script: null,
        checkoutPath: null,
        terminal: null,
        environmentNames: [],
      },
      createdAt: timestamp,
      startedAt: null,
      finishedAt: timestamp,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    };
  }

  private createFailedRun(
    threadId: string,
    workspaceId: string,
    actionId: string,
    actionName: string,
    script: string,
    plannedSnapshot: WorkspaceEnvironmentActionRun["snapshot"] | null,
  ): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return {
      threadId,
      workspaceId,
      actionId,
      runId: this.createRunId(),
      revision: 0,
      terminalSessionId: null,
      actionName,
      status: "failed",
      snapshot: plannedSnapshot ?? {
        platform: platform(),
        script,
        checkoutPath: null,
        terminal: null,
        environmentNames: [],
      },
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    };
  }

  private persistAndPublish(run: WorkspaceEnvironmentActionRun): WorkspaceEnvironmentActionRun {
    const retained = this.runs.replace(run);
    this.publish(retained);
    return retained;
  }

  private assertThreadCanStart(thread: { readonly id: string; readonly workspace_id: string; readonly deleted_at: string | null; readonly user_completed_at: string | null }): void {
    const current = this.threads.findById(thread.id);
    if (
      this.disposed ||
      this.threadLifecycles.get(thread.id)?.closing === true ||
      this.workspaceLifecycles.get(thread.workspace_id)?.closing === true ||
      !current ||
      current.deleted_at ||
      current.user_completed_at !== null
    ) {
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread is unavailable for Project Actions");
    }
  }

  private reserveThreadStart(threadId: string, workspaceId: string): () => void {
    if (this.disposed) {
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread is unavailable for Project Actions");
    }
    const lifecycle = this.lifecycleFor(threadId);
    const workspaceLifecycle = this.workspaceLifecycleFor(workspaceId);
    if (lifecycle.closing || workspaceLifecycle.closing) {
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread is unavailable for Project Actions");
    }
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    lifecycle.starts.add(settled);
    workspaceLifecycle.starts.add(settled);
    return () => {
      lifecycle.starts.delete(settled);
      workspaceLifecycle.starts.delete(settled);
      resolve();
      this.removeLifecycleIfIdle(threadId, lifecycle);
      this.removeWorkspaceLifecycleIfIdle(workspaceId, workspaceLifecycle);
    };
  }

  private lifecycleFor(threadId: string): ThreadActionLifecycle {
    const existing = this.threadLifecycles.get(threadId);
    if (existing) return existing;
    const lifecycle: ThreadActionLifecycle = { closing: false, teardownCount: 0, starts: new Set() };
    this.threadLifecycles.set(threadId, lifecycle);
    return lifecycle;
  }

  private removeLifecycleIfIdle(threadId: string, lifecycle: ThreadActionLifecycle): void {
    if (!lifecycle.closing && lifecycle.starts.size === 0) this.threadLifecycles.delete(threadId);
  }

  private workspaceLifecycleFor(workspaceId: string): WorkspaceActionLifecycle {
    const existing = this.workspaceLifecycles.get(workspaceId);
    if (existing) return existing;
    const lifecycle: WorkspaceActionLifecycle = { closing: false, teardownCount: 0, starts: new Set() };
    this.workspaceLifecycles.set(workspaceId, lifecycle);
    return lifecycle;
  }

  private removeWorkspaceLifecycleIfIdle(workspaceId: string, lifecycle: WorkspaceActionLifecycle): void {
    if (!lifecycle.closing && lifecycle.starts.size === 0) this.workspaceLifecycles.delete(workspaceId);
  }

  private publish(run: WorkspaceEnvironmentActionRun): void {
    const update: ProjectActionRunUpdate = {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
    };
    for (const listener of this.listeners) listener(update);
  }

  private timestamp(): string {
    const nextMs = Math.max(this.now().getTime(), this.lastTimestampMs + 1);
    this.lastTimestampMs = nextMs;
    return new Date(nextMs).toISOString();
  }
}

function createStartingProjectAction(threadId: string, actionId: string): StartingProjectAction {
  let resolve: (active: ActiveProjectAction | null) => void = () => undefined;
  const settled = new Promise<ActiveProjectAction | null>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { state: "starting", threadId, actionId, settled, resolve };
}

function slotKey(threadId: string, actionId: string): string {
  return `${threadId}\u0000${actionId}`;
}

function platform(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  return process.platform === "darwin" ? "macos" : "linux";
}

function appendTranscript(
  current: string,
  alreadyTruncated: boolean,
  data: Uint8Array,
): Pick<WorkspaceEnvironmentActionRun, "transcript" | "transcriptTruncated"> {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(data)]);
  if (combined.byteLength <= WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES) {
    return { transcript: combined.toString("utf8"), transcriptTruncated: alreadyTruncated };
  }
  return {
    transcript: combined.subarray(combined.byteLength - WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES).toString("utf8"),
    transcriptTruncated: true,
  };
}
