import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import type {
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentActionSlotInput,
} from "@mcode/contracts";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  TERMINAL_BACKEND_TOKEN,
  PreparedTerminalCommandApprovalMismatchError,
  PreparedTerminalCommandStartError,
  type PreparedTerminalCommandSession,
  type TerminalBackend,
} from "../../terminal/backends/terminal-backend.js";
import { ProjectActionAdmissionGate, type ProjectActionStartThread } from "./project-action-admission.js";
import { compensateFailedProjectActionLaunch } from "./project-action-launch-compensation.js";
import {
  resolveApprovalAfterLaunchMismatch,
  resolveProjectAction,
  type ProjectActionResolution,
} from "./project-action-resolution.js";
import { ProjectActionRunFactory } from "./project-action-run-factory.js";
import { ProjectActionRunLifecycle } from "./project-action-run-lifecycle.js";
import { ProjectActionRunPublisher, type ProjectActionRunUpdate } from "./project-action-run-publisher.js";
import {
  createStartingProjectAction,
  type ActiveProjectAction,
  type ProjectActionSlotState,
  type StartingProjectAction,
} from "./project-action-types.js";
import { WorkspaceEnvironmentService } from "./workspace-environment-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";

/** Clock used to timestamp Project Action lifecycle transitions. */
export type ProjectActionClock = () => Date;

/** Factory used to assign a new immutable identity to each Project Action run. */
export type ProjectActionRunIdFactory = () => string;

/** Dependency-injection token for the production Project Action clock. */
export const PROJECT_ACTION_CLOCK_TOKEN = "ProjectActionClock";

/** Dependency-injection token for the production Project Action run-ID factory. */
export const PROJECT_ACTION_RUN_ID_FACTORY_TOKEN = "ProjectActionRunIdFactory";

export type { ProjectActionRunUpdate };

interface ProjectActionStartContext {
  readonly slot: string;
  readonly thread: ProjectActionStartThread;
  readonly actionId: string;
  readonly reservation: StartingProjectAction;
}

/** Owns Project Action slot exclusion, latest-run retention, and backend process lifecycle. */
@injectable()
export class ProjectActionService {
  private readonly active = new Map<string, ProjectActionSlotState>();
  private readonly admission = new ProjectActionAdmissionGate();
  private readonly publisher: ProjectActionRunPublisher;
  private readonly runFactory: ProjectActionRunFactory;
  private readonly runLifecycle: ProjectActionRunLifecycle;
  private disposePromise: Promise<void> | null = null;

  constructor(
    @inject(ProjectActionRunRepo) private readonly runs: ProjectActionRunRepo,
    @inject(WorkspaceEnvironmentService) private readonly environment: WorkspaceEnvironmentService,
    @inject("ThreadRepo") private readonly threads: ThreadRepo,
    @inject(TERMINAL_BACKEND_TOKEN) private readonly terminal: TerminalBackend,
    @inject(PROJECT_ACTION_CLOCK_TOKEN)
    now: ProjectActionClock = () => new Date(),
    @inject(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN)
    createRunId: ProjectActionRunIdFactory = randomUUID,
  ) {
    this.publisher = new ProjectActionRunPublisher(this.runs);
    this.runFactory = new ProjectActionRunFactory(now, createRunId);
    this.runLifecycle = new ProjectActionRunLifecycle(
      this.runs,
      this.active,
      this.publisher,
      () => this.runFactory.timestamp(),
    );
  }

  /** Subscribes to retained Action run changes produced by this server process. */
  onUpdate(listener: (update: ProjectActionRunUpdate) => void): () => void {
    return this.publisher.onUpdate(listener);
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
    const context = this.createStartContext(input);
    let releaseAdmission: (() => void) | null = null;
    try {
      releaseAdmission = this.admission.reserveStart(context.thread.id, context.thread.workspace_id);
      return await this.startAdmittedAction(context);
    } finally {
      this.releaseStartingReservation(context);
      releaseAdmission?.();
    }
  }

  /** Stops one running Action and waits for its backend close barrier. */
  async stop(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun | null> {
    const active = await this.activeForSlot(slotKey(input.threadId, input.actionId));
    if (!active) return this.runs.get(input.threadId, input.actionId);
    if (active.state === "pending-finalization") return this.retryFinalization(input, active);
    return await this.stopRunningAction(input, active);
  }

  /** Restarts a slot only after its prior terminal fully closes. */
  async restart(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    await this.stop(input);
    return await this.start(input);
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
    return await this.admission.beginThreadTeardown(threadId);
  }

  /** Blocks new starts for every Thread in a Workspace while deletion tears it down. */
  async beginWorkspaceTeardown(workspaceId: string): Promise<() => void> {
    return await this.admission.beginWorkspaceTeardown(workspaceId);
  }

  /** Restores Action admission after a completed Thread is reopened. */
  reopenThread(threadId: string): void {
    this.admission.reopenThread(threadId);
  }

  /** Stops all active Action sessions before the selected terminal backend shuts down. */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  /** Converts surviving persisted running rows to interrupted after startup recovery has reaped terminals. */
  recoverStaleRuns(): WorkspaceEnvironmentActionRun[] {
    const interrupted: WorkspaceEnvironmentActionRun[] = [];
    while (true) {
      const runs = this.runs.interruptRunning(this.runFactory.timestamp());
      for (const run of runs) this.publisher.publish(run);
      interrupted.push(...runs);
      if (runs.length < 256) return interrupted;
    }
  }

  private createStartContext(input: WorkspaceEnvironmentActionSlotInput): ProjectActionStartContext {
    const slot = slotKey(input.threadId, input.actionId);
    if (this.active.has(slot)) throw actionAlreadyRunningError();
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at) throw threadNotFoundError();
    this.admission.assertThreadCanStart(thread, this.threads.findById(thread.id));
    const reservation = createStartingProjectAction(thread.id, input.actionId);
    this.active.set(slot, reservation);
    return { slot, thread, actionId: input.actionId, reservation };
  }

  private async startAdmittedAction(context: ProjectActionStartContext): Promise<WorkspaceEnvironmentActionRun> {
    const resolved = await resolveProjectAction(this.environment, context.thread.id, context.actionId);
    this.admission.assertThreadCanStart(context.thread, this.threads.findById(context.thread.id));
    return await this.startResolvedAction(context, resolved);
  }

  private async startResolvedAction(
    context: ProjectActionStartContext,
    resolved: ProjectActionResolution,
  ): Promise<WorkspaceEnvironmentActionRun> {
    if (resolved.kind === "launch") return await this.launchResolvedAction(context, resolved);
    if (resolved.kind === "unavailable") return this.publisher.persistAndPublish(this.runFactory.createUnavailable(this.runInput(context, resolved)));
    if (resolved.kind === "configuration") return this.publisher.persistAndPublish(this.runFactory.createFailed({ ...this.runInput(context, resolved), script: null }));
    return this.publisher.persistAndPublish(this.runFactory.createAwaitingApproval(this.runInput(context, resolved)));
  }

  private async launchResolvedAction(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
  ): Promise<WorkspaceEnvironmentActionRun> {
    let session: PreparedTerminalCommandSession | null = null;
    try {
      session = await this.terminal.startPreparedCommand({
        threadId: context.thread.id,
        script: resolved.script,
        expectedLaunch: { terminal: resolved.snapshot.terminal },
      });
      return this.retainLaunchedAction(context, resolved, session);
    } catch (error) {
      return await this.handleLaunchFailure(context, resolved, session, error);
    }
  }

  private retainLaunchedAction(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
    session: PreparedTerminalCommandSession,
  ): WorkspaceEnvironmentActionRun {
    const active: ActiveProjectAction = {
      state: "running",
      threadId: context.thread.id,
      actionId: resolved.action.id,
      session,
      run: this.runFactory.createActive({
        ...this.runInput(context, resolved),
        session,
      }),
      pendingFinalization: null,
      outputRemainder: new Uint8Array(),
      stopping: false,
    };
    this.active.set(context.slot, active);
    this.publisher.persistAndPublish(active.run);
    session.onOutput((data) => this.runLifecycle.recordOutput(context.slot, active.run.runId, data));
    session.onExit((exit) => this.runLifecycle.finish(context.slot, active.run.runId, exit.exitCode));
    this.settleStartingReservation(context);
    return active.run;
  }

  private async handleLaunchFailure(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
    session: PreparedTerminalCommandSession | null,
    error: unknown,
  ): Promise<WorkspaceEnvironmentActionRun> {
    const renewedApproval = await this.renewedApprovalAfterMismatch(context, error);
    if (renewedApproval) return this.publisher.persistAndPublish(this.runFactory.createAwaitingApproval(this.runInput(context, renewedApproval)));
    if (session) return await this.compensateLaunchFailure(context, session, error);
    return this.publisher.persistAndPublish(this.runFactory.createFailed({
      ...this.runInput(context, resolved),
      script: resolved.script,
      snapshot: error instanceof PreparedTerminalCommandStartError ? error.snapshot : resolved.snapshot,
    }));
  }

  private async renewedApprovalAfterMismatch(
    context: ProjectActionStartContext,
    error: unknown,
  ): Promise<Extract<ProjectActionResolution, { readonly kind: "awaiting-approval" }> | null> {
    if (!(error instanceof PreparedTerminalCommandApprovalMismatchError)) return null;
    return await resolveApprovalAfterLaunchMismatch(this.environment, context.thread.id, context.actionId);
  }

  private async compensateLaunchFailure(
    context: ProjectActionStartContext,
    session: PreparedTerminalCommandSession,
    error: unknown,
  ): Promise<never> {
    const active = this.active.get(context.slot);
    return await compensateFailedProjectActionLaunch({
      error,
      session,
      active: active?.state === "starting" ? null : active ?? null,
      onExit: (runId, exit) => this.runLifecycle.finish(context.slot, runId, exit.exitCode),
      settleStart: () => this.settleStartingReservation(context),
    });
  }

  private runInput(
    context: ProjectActionStartContext,
    resolved: ProjectActionResolution,
  ): {
    readonly threadId: string;
    readonly workspaceId: string;
    readonly actionId: string;
    readonly actionName: string;
    readonly snapshot: ProjectActionResolution["snapshot"];
  } {
    return {
      threadId: context.thread.id,
      workspaceId: context.thread.workspace_id,
      actionId: resolved.action.id,
      actionName: resolved.action.name,
      snapshot: resolved.snapshot,
    };
  }

  private releaseStartingReservation(context: ProjectActionStartContext): void {
    if (this.active.get(context.slot) !== context.reservation) return;
    this.active.delete(context.slot);
    context.reservation.resolve(null);
  }

  private settleStartingReservation(context: ProjectActionStartContext): void {
    const retained = this.active.get(context.slot);
    context.reservation.resolve(retained?.state === "running" ? retained : null);
  }

  private async activeForSlot(slot: string): Promise<ActiveProjectAction | null> {
    const state = this.active.get(slot);
    if (!state) return null;
    return state.state === "starting" ? await state.settled : state;
  }

  private retryFinalization(
    input: WorkspaceEnvironmentActionSlotInput,
    active: ActiveProjectAction,
  ): WorkspaceEnvironmentActionRun | null {
    this.runLifecycle.retryPendingFinalization(slotKey(input.threadId, input.actionId), active);
    return this.runs.get(input.threadId, input.actionId);
  }

  private async stopRunningAction(
    input: WorkspaceEnvironmentActionSlotInput,
    active: ActiveProjectAction,
  ): Promise<WorkspaceEnvironmentActionRun | null> {
    active.stopping = true;
    try {
      await active.session.stop();
    } finally {
      const current = this.active.get(slotKey(input.threadId, input.actionId));
      if (current?.state === "pending-finalization") this.runLifecycle.retryPendingFinalization(slotKey(input.threadId, input.actionId), current);
    }
    return this.runs.get(input.threadId, input.actionId);
  }

  private async disposeOnce(): Promise<void> {
    this.admission.beginDisposal();
    const threadIds = new Set([...this.admission.threadIds(), ...this.activeThreadIds()]);
    const barriers = await Promise.all([...threadIds].map((threadId) => this.beginThreadTeardown(threadId)));
    try {
      await Promise.all([...threadIds].map((threadId) => this.stopForThread(threadId)));
    } finally {
      for (const release of barriers) release();
      this.admission.clear();
    }
  }

  private activeThreadIds(): string[] {
    return [...new Set([...this.active.values()].map((active) => active.threadId))];
  }
}

function actionAlreadyRunningError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    "This Project Action is already running for this Thread",
  );
}

function threadNotFoundError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread not found");
}

function slotKey(threadId: string, actionId: string): string {
  return `${threadId}\u0000${actionId}`;
}
