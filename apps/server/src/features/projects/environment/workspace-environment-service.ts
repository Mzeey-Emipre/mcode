import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import {
  DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
  WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION,
  WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
  WorkspaceEnvironmentDocumentSchema,
  workspaceEnvironmentValidationIssues,
  type WorkspaceEnvironmentPlatform,
  type WorkspaceEnvironmentStorageMode,
  type WorkspaceEnvironmentCommandTarget,
  type WorkspaceEnvironmentCommandApproval,
  type WorkspaceEnvironmentCommandApproveInput,
  type WorkspaceEnvironmentStorageSetInput,
  type WorkspaceEnvironmentCommand,
  type WorkspaceEnvironmentReadResult,
  type WorkspaceEnvironmentSaveInput,
  type WorkspaceEnvironmentSetupAttempt,
  type WorkspaceEnvironmentSetupGetInput,
  type WorkspaceEnvironmentSetupGetResult,
  type WorkspaceEnvironmentSetupLaunchSnapshot,
  type WorkspaceEnvironmentAction,
  type WorkspaceEnvironmentSetupOutcome,
  type WorkspaceEnvironmentAutomaticSetupReason,
  type WorkspaceEnvironmentSetupStartInput,
  type WorkspaceEnvironmentAutomaticSetupSnapshot,
  type WorkspaceEnvironmentAutomaticSetupStopInput,
  type WorkspaceEnvironmentAutomaticSetupRetryInput,
  type WorkspaceEnvironmentAutomaticSetupTerminalInput,
  type WorkspaceEnvironmentAutomaticSetupTerminal,
  type StoredAttachment,
  type MessageMention,
  type PreviewAnnotationBundle,
  type WorkspaceEnvironmentValidationIssue,
  type WorkspaceEnvironmentValidationReason,
} from "@mcode/contracts";
import { getMcodeDir } from "@mcode/shared";
import { ZodError } from "zod";
import type Database from "better-sqlite3";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import type {
  TerminalCommandCompletion,
  TerminalCommandPreparation,
  PreparedTerminalCommand,
} from "../../terminal/commands/terminal-command-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import { WorkspaceEnvironmentConfigurationRepo } from "./persistence/workspace-environment-configuration-repo.js";
import {
  WorkspaceEnvironmentAutomaticRepository,
  WorkspaceEnvironmentAutomaticQueueCapacityError,
  type WorkspaceEnvironmentQueuedTurnSubmission,
  type WorkspaceEnvironmentQueueAdmission,
} from "./workspace-environment-automatic-repository.js";

export { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const DEFAULT_MANUAL_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETAINED_COMPLETED_SETUP_ATTEMPTS = 32;
const MAX_CONCURRENT_MANUAL_SETUP_ATTEMPTS = 8;
const DEFAULT_SETUP_CANCELLATION_WAIT_MS = 1_000;

interface ActiveSetupResource {
  attempt: WorkspaceEnvironmentSetupAttempt;
  readonly command: PreparedTerminalCommand;
}

interface ActiveAutomaticSetupResource {
  readonly attemptId: string;
  readonly command: PreparedTerminalCommand;
  cleanupPending: boolean;
}

interface StartingSetupAttempt {
  readonly workspaceId: string;
  readonly promise: Promise<WorkspaceEnvironmentSetupAttempt>;
}

interface AutomaticSetupConfiguration {
  readonly platform: WorkspaceEnvironmentPlatform;
  readonly script: string | null;
  readonly storageMode: WorkspaceEnvironmentStorageMode;
}

/** Thread fields used to determine whether manual Setup can start. */
export interface WorkspaceEnvironmentSetupThread {
  readonly id: string;
  readonly workspace_id: string;
  readonly mode: string;
  readonly worktree_managed?: boolean;
  readonly worktree_path?: string | null;
  readonly deleted_at?: string | null;
  readonly cleanup_state?: string | null;
}

/** Workspace fields used to resolve the base checkout for shared Project configuration. */
export interface WorkspaceEnvironmentWorkspace {
  readonly id: string;
  readonly path: string;
}

class SetupStartCancelledError extends Error {
  constructor() {
    super("Project Setup start was cancelled");
  }
}

/** Terminal command boundary consumed by the Project Setup lifecycle. */
export interface WorkspaceEnvironmentTerminalCommandExecutor {
  prepare(input: {
    readonly scope: { readonly kind: "thread"; readonly workspaceId: string; readonly threadId: string };
    readonly script: string;
    readonly timeoutMs: number;
    readonly outputMaxBytes: number;
    readonly onOutput?: (chunk: Uint8Array) => void;
  }): Promise<TerminalCommandPreparation>;
}

/** Interactive Terminal boundary used for automatic Setup recovery. */
export interface WorkspaceEnvironmentTerminalRecoveryExecutor {
  create(threadId: string): WorkspaceEnvironmentAutomaticSetupTerminal | Promise<WorkspaceEnvironmentAutomaticSetupTerminal>;
}

/** Attachment storage boundary for automatic queued Turn cleanup. */
export interface WorkspaceEnvironmentAttachmentStorage {
  removeStoredAttachments(threadId: string, attachments: readonly StoredAttachment[]): Promise<void>;
}

/** Accepted automatic Turn dispatch whose completion releases the Thread's provider slot. */
export interface WorkspaceEnvironmentAutomaticSetupDispatch {
  readonly completion: Promise<void>;
}

/** Post-commit boundary that resolves once a claimed queued Turn has started a runtime. */
export interface WorkspaceEnvironmentAutomaticSetupDispatcher {
  dispatch(submission: WorkspaceEnvironmentQueuedTurnSubmission): Promise<WorkspaceEnvironmentAutomaticSetupDispatch>;
}

/** Dependencies that add transient manual Setup execution to environment persistence. */
export interface WorkspaceEnvironmentServiceOptions {
  readonly mcodeDir?: string;
  readonly threads?: {
    findById(id: string): WorkspaceEnvironmentSetupThread | null;
  };
  readonly workspaces?: {
    findById(id: string): WorkspaceEnvironmentWorkspace | null;
  };
  readonly terminalCommands?: WorkspaceEnvironmentTerminalCommandExecutor;
  readonly terminalRecovery?: WorkspaceEnvironmentTerminalRecoveryExecutor;
  readonly attachmentStorage?: WorkspaceEnvironmentAttachmentStorage;
  readonly threadStartups?: Pick<
    ThreadStartupService,
    "appendOutput" | "block" | "findByThreadId" | "resume" | "skip"
  >;
  readonly platform?: WorkspaceEnvironmentPlatform;
  readonly manualSetupTimeoutMs?: number;
  readonly setupCancellationWaitMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelScheduled?: (timeout: ReturnType<typeof setTimeout>) => void;
  readonly now?: () => Date;
  readonly createAttemptId?: () => string;
  readonly database?: Database.Database;
}

/** Resolved command facts shared by Setup approval and Project Action orchestration. */
export type WorkspaceEnvironmentCommandResolution =
  | {
    readonly kind: "ready";
    readonly command: PreparedTerminalCommand;
    readonly script: string;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly approval: WorkspaceEnvironmentCommandApproval | null;
    readonly action: WorkspaceEnvironmentAction | null;
  }
  | {
    readonly kind: "unavailable";
    readonly output: string;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly action: WorkspaceEnvironmentAction | null;
  }
  | {
    readonly kind: "configuration";
    readonly output: string;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly action: WorkspaceEnvironmentAction | null;
  };

function commandForTarget(
  setup: WorkspaceEnvironmentCommand | undefined,
  action: WorkspaceEnvironmentAction | null,
): WorkspaceEnvironmentCommand | undefined {
  return action?.command ?? setup;
}

function unavailableCommandResolution(
  platform: WorkspaceEnvironmentPlatform,
  action: WorkspaceEnvironmentAction | null,
): WorkspaceEnvironmentCommandResolution {
  return {
    kind: "unavailable",
    output: "This Project command is not available on this system",
    snapshot: unavailableSnapshot(platform, null),
    action,
  };
}

function queuedAutomaticAttemptId(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): string | null {
  return snapshot.attempt?.state === "queued" ? snapshot.attempt.id : null;
}

function hasAutomaticSetupScript(
  configuration: AutomaticSetupConfiguration,
): configuration is AutomaticSetupConfiguration & { script: string } {
  return Boolean(configuration.script);
}

function isConfigurationResolutionError(error: unknown): boolean {
  if (!(error instanceof WorkspaceEnvironmentServiceError)) return false;
  return error.code === "WORKSPACE_ENVIRONMENT_VALIDATION"
    || error.code === "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION";
}

function manualSetupLaunchFailure(): Extract<TerminalCommandCompletion, { kind: "launch_failure" }> {
  return {
    kind: "launch_failure",
    output: "The Terminal could not launch Setup",
    outputTruncated: false,
  };
}

function manualCompletionResult(completion: TerminalCommandCompletion): {
  status: "passed" | "failed";
  outcome: WorkspaceEnvironmentSetupOutcome;
  exitCode: number | null;
} {
  switch (completion.kind) {
    case "exited": return exitedManualCompletionResult(completion.exitCode);
    case "timeout": return { status: "failed", outcome: "timeout", exitCode: null };
    case "containment_failure": return { status: "failed", outcome: "containment_failure", exitCode: null };
    case "launch_failure": return { status: "failed", outcome: "launch_failure", exitCode: null };
  }
}

function exitedManualCompletionResult(exitCode: number | null): {
  status: "passed" | "failed";
  outcome: "success" | "command_failure";
  exitCode: number | null;
} {
  return exitCode === 0
    ? { status: "passed", outcome: "success", exitCode }
    : { status: "failed", outcome: "command_failure", exitCode };
}

function issue(
  path: (string | number)[],
  code: string,
  reason: WorkspaceEnvironmentValidationReason,
  message: string,
): WorkspaceEnvironmentValidationIssue {
  return { path, code, reason, message };
}

function revisionFor(
  bytes: Uint8Array,
  storageMode: WorkspaceEnvironmentStorageMode,
  filePath: string,
): string {
  return NodeCrypto.createHash("sha256")
    .update(storageMode)
    .update("\0")
    .update(filePath)
    .update("\0")
    .update(bytes)
    .digest("hex");
}

function validationError(error: ZodError): WorkspaceEnvironmentServiceError {
  const issues = workspaceEnvironmentValidationIssues(error);
  const unsupported = issues.some((candidate) => candidate.reason === "unsupported_version");
  return new WorkspaceEnvironmentServiceError(
    unsupported
      ? "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION"
      : "WORKSPACE_ENVIRONMENT_VALIDATION",
    unsupported ? "Workspace environment version is not supported" : "Workspace environment failed validation",
    issues,
  );
}

/** Persists one private, system-local environment document per workspace. */
export class WorkspaceEnvironmentService {
  private readonly mcodeDir: string;
  private readonly saveTails = new Map<string, Promise<void>>();
  private readonly latestSetupAttempts = new Map<string, WorkspaceEnvironmentSetupAttempt>();
  private readonly activeSetupResources = new Map<string, ActiveSetupResource>();
  private readonly startingSetupAttempts = new Map<string, StartingSetupAttempt>();
  private readonly setupGenerations = new Map<string, number>();
  private readonly completedSetupThreadIds: string[] = [];
  private readonly deletingThreadCounts = new Map<string, number>();
  private readonly deletingWorkspaceCounts = new Map<string, number>();
  private readonly options: WorkspaceEnvironmentServiceOptions;
  private readonly configuration: WorkspaceEnvironmentConfigurationRepo | null;
  private readonly inMemoryStorageModes = new Map<string, WorkspaceEnvironmentStorageMode>();
  private readonly inMemoryApprovals = new Map<string, string>();
  private readonly schedule: NonNullable<WorkspaceEnvironmentServiceOptions["schedule"]>;
  private readonly cancelScheduled: NonNullable<WorkspaceEnvironmentServiceOptions["cancelScheduled"]>;
  private readonly automaticRepository: WorkspaceEnvironmentAutomaticRepository | null;
  private readonly activeAutomaticSetupResources = new Map<string, ActiveAutomaticSetupResource>();
  private readonly startingAutomaticSetupPromises = new Map<string, Promise<void>>();
  private readonly automaticStopPromises = new Map<string, Promise<void>>();
  private readonly automaticRecoveryOperationTails = new Map<string, Promise<void>>();
  private readonly automaticStopGenerations = new Map<string, number>();
  private readonly automaticDrainLoops = new Map<string, Promise<void>>();
  private automaticDispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: string | WorkspaceEnvironmentServiceOptions = getMcodeDir()) {
    this.options = typeof options === "string" ? {} : options;
    this.mcodeDir = typeof options === "string" ? options : options.mcodeDir ?? getMcodeDir();
    this.schedule = this.options.schedule ?? setTimeout;
    this.cancelScheduled = this.options.cancelScheduled ?? clearTimeout;
    this.automaticRepository = this.options.database
      ? new WorkspaceEnvironmentAutomaticRepository(this.options.database, () => this.now())
      : null;
    this.configuration = this.options.database
      ? new WorkspaceEnvironmentConfigurationRepo(this.options.database)
      : null;
  }

  /** Returns the explicitly composed host platform for Project command resolution. */
  platform(): WorkspaceEnvironmentPlatform {
    return requireWorkspaceEnvironmentPlatform(this.options.platform);
  }

  /** Connect the one post-commit automatic Setup dispatcher during server composition. */
  setAutomaticSetupDispatcher(dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher): void {
    this.automaticDispatcher = dispatcher;
  }

  /** Queue one Turn for a managed New worktree and launch Setup after persistence commits. */
  queueAutomaticFirstTurn(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly content: string;
    readonly attachments: readonly StoredAttachment[];
    readonly mentions: readonly MessageMention[];
    readonly previewAnnotations?: PreviewAnnotationBundle;
    readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
  }): WorkspaceEnvironmentAutomaticSetupSnapshot {
    return this.admitAutomaticTurn(input).snapshot;
  }

  /** Admit one automatic Turn and report whether a concurrent release requires normal dispatch. */
  admitAutomaticTurn(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly content: string;
    readonly attachments: readonly StoredAttachment[];
    readonly mentions: readonly MessageMention[];
    readonly previewAnnotations?: PreviewAnnotationBundle;
    readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
  }): WorkspaceEnvironmentQueueAdmission {
    const thread = this.requireAutomaticSetupThread(input.threadId);
    let admission: WorkspaceEnvironmentQueueAdmission;
    try {
      admission = this.requireAutomaticRepository().queueFirstTurn(input);
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentAutomaticQueueCapacityError) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY",
          "Automatic Setup queue capacity reached for this Thread",
        );
      }
      throw error;
    }
    if (admission.queued && admission.snapshot.attempt?.state === "queued") void this.startAutomaticSetup(thread);
    return admission;
  }

  /** Return the reconnect-authoritative automatic Setup lifecycle for one Thread. */
  getAutomaticSetup(input: { readonly threadId: string }): WorkspaceEnvironmentAutomaticSetupSnapshot {
    return this.requireAutomaticRepository().snapshot(input.threadId);
  }

  /** Release queued Turns without rerunning Setup, then claim them for post-commit dispatch. */
  async continueAutomaticSetup(input: { readonly threadId: string }): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    this.requireAutomaticSetupThread(input.threadId);
    const repository = this.requireAutomaticRepository();
    const current = repository.snapshot(input.threadId);
    if (current.attempt?.state !== "failed" && current.attempt?.state !== "interrupted") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup can continue only after Setup failed or was interrupted",
      );
    }
    if (!repository.continueWithoutSetup(input.threadId)) return repository.snapshot(input.threadId);
    this.skipStartupSetup(input.threadId);
    await this.drainReleasedAutomaticTurn(input.threadId);
    this.requireAutomaticSetupThread(input.threadId);
    return repository.snapshot(input.threadId);
  }

  /** Cancel only the requested Turn that remains queued behind automatic Setup. */
  async cancelQueuedAutomaticTurn(input: {
    readonly threadId: string;
    readonly queuedTurnId: string;
  }): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    const cancelled = this.requireAutomaticRepository().cancelQueuedTurn(input);
    if (cancelled.attachments.length > 0) {
      await this.options.attachmentStorage?.removeStoredAttachments(input.threadId, cancelled.attachments);
    }
    return cancelled.snapshot;
  }

  /** Interrupt the active automatic Setup attempt without releasing the blocked gate. */
  async stopAutomaticSetup(input: WorkspaceEnvironmentAutomaticSetupStopInput): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    this.requireAutomaticSetupThread(input.threadId);
    this.invalidateAutomaticRetry(input.threadId);
    const stopping = this.automaticStopPromises.get(input.threadId);
    if (stopping) return this.snapshotAfterAutomaticStop(input.threadId, stopping);
    const repository = this.requireAutomaticRepository();
    const attemptId = repository.interruptCurrentAttempt(input.threadId);
    const starting = this.startingAutomaticSetupPromises.get(input.threadId);
    const resource = this.activeAutomaticSetupResources.get(input.threadId);
    const resourceAttemptId = attemptId ?? resource?.attemptId ?? null;
    if (resourceAttemptId && this.shouldCloseAutomaticSetup(resource, resourceAttemptId, starting)) {
      await this.stopAutomaticSetupResources(input.threadId, resourceAttemptId, resource, starting);
    }
    this.clearAutomaticRecoveryGeneration(input.threadId);
    return repository.snapshot(input.threadId);
  }

  private async snapshotAfterAutomaticStop(threadId: string, stopping: Promise<void>): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    await stopping;
    return this.requireAutomaticRepository().snapshot(threadId);
  }

  private shouldCloseAutomaticSetup(
    resource: ActiveAutomaticSetupResource | undefined,
    attemptId: string,
    starting: Promise<void> | undefined,
  ): boolean {
    return resource?.attemptId === attemptId || starting !== undefined;
  }

  private async stopAutomaticSetupResources(
    threadId: string,
    attemptId: string,
    resource: ActiveAutomaticSetupResource | undefined,
    starting: Promise<void> | undefined,
  ): Promise<void> {
    const closing = Promise.resolve().then(
      () => this.closeAutomaticSetupResources(threadId, attemptId, resource, starting),
    );
    this.automaticStopPromises.set(threadId, closing);
    let contained = false;
    try {
      await closing;
      contained = true;
    } finally {
      if (contained && this.automaticStopPromises.get(threadId) === closing) {
        this.automaticStopPromises.delete(threadId);
        this.clearAutomaticRecoveryGeneration(threadId);
      }
    }
  }

  private async closeAutomaticSetupResources(
    threadId: string,
    attemptId: string,
    resource: ActiveAutomaticSetupResource | undefined,
    starting: Promise<void> | undefined,
  ): Promise<void> {
    await this.closeMatchingAutomaticSetupResource(threadId, attemptId, resource);
    if (starting) await this.awaitCancelledAutomaticSetupStart(starting);
    await this.closeMatchingAutomaticSetupResource(
      threadId,
      attemptId,
      this.activeAutomaticSetupResources.get(threadId),
    );
  }

  private async closeMatchingAutomaticSetupResource(
    threadId: string,
    attemptId: string,
    resource: ActiveAutomaticSetupResource | undefined,
  ): Promise<void> {
    if (!resource || resource.attemptId !== attemptId) return;
    await this.closeActiveAutomaticSetupResource(threadId, resource);
  }

  private async awaitCancelledAutomaticSetupStart(starting: Promise<void>): Promise<void> {
    await starting.catch((error: unknown) => {
      if (!(error instanceof SetupStartCancelledError)) throw error;
    });
  }

  /** Re-resolve the current Project environment and start one new automatic Setup attempt. */
  async retryAutomaticSetup(input: WorkspaceEnvironmentAutomaticSetupRetryInput): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    const stopGeneration = this.automaticStopGenerations.get(input.threadId) ?? 0;
    return await this.runAutomaticRecoveryOperation(input.threadId, async () => {
      this.requireAutomaticSetupThread(input.threadId);
      const stopping = this.automaticStopPromises.get(input.threadId);
      if (stopping) await stopping;
      this.requireAutomaticSetupThread(input.threadId);
      if ((this.automaticStopGenerations.get(input.threadId) ?? 0) !== stopGeneration) {
        return this.requireAutomaticRepository().snapshot(input.threadId);
      }
      const thread = this.requireAutomaticSetupThread(input.threadId);
      this.requireAutomaticResourceReleased(input.threadId);
      if (this.requireAutomaticRepository().retryCurrentAttempt(input.threadId)) {
        this.resumeStartupSetup(input.threadId);
        await this.startAutomaticSetup(thread);
        this.requireAutomaticSetupThread(input.threadId);
      }
      return this.requireAutomaticRepository().snapshot(input.threadId);
    });
  }

  /** Create one separate interactive recovery Terminal without changing automatic Setup state. */
  async openAutomaticSetupTerminal(
    input: WorkspaceEnvironmentAutomaticSetupTerminalInput,
  ): Promise<WorkspaceEnvironmentAutomaticSetupTerminal> {
    this.requireAutomaticSetupThread(input.threadId);
    const terminalRecovery = this.options.terminalRecovery;
    if (!terminalRecovery) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Recovery Terminal is unavailable for this Thread",
      );
    }
    return await terminalRecovery.create(input.threadId);
  }

  /** Mark interrupted automatic attempts at startup and drain only committed release claims. */
  async reconcileAutomaticSetup(): Promise<void> {
    this.requireAutomaticRepository().interruptUnfinishedAttempts();
    await this.drainReleasedAutomaticTurn();
  }

  /** Resolve the exact private environment document path for one workspace. */
  filePath(workspaceId: string): string {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace id is not a safe path segment",
        [issue(["workspaceId"], "INVALID_WORKSPACE_ID", "invalid_value", "Workspace id is not a safe path segment")],
      );
    }
    return NodePath.join(this.mcodeDir, "projects", workspaceId, "environment.json");
  }

  /** Select the exclusive storage location and return its current document. */
  async setStorageMode(input: WorkspaceEnvironmentStorageSetInput): Promise<WorkspaceEnvironmentReadResult> {
    return this.enqueueSave(input.workspaceId, async () => {
      const thread = input.threadId ? this.requireSetupThread(input.threadId) : null;
      if (thread) {
        if (thread.workspace_id !== input.workspaceId) {
          throw new WorkspaceEnvironmentServiceError(
            "WORKSPACE_ENVIRONMENT_NOT_FOUND",
            "Thread does not belong to this Project",
          );
        }
      }
      if (input.storageMode === "shared") this.requireWorkspace(input.workspaceId);
      const filePath = thread
        ? this.filePathForThread(thread, input.storageMode)
        : this.filePathForWorkspace(input.workspaceId, input.storageMode);
      const result = await this.readAt(filePath, input.storageMode);
      this.persistStorageMode(input.workspaceId, input.storageMode);
      return result;
    });
  }

  /** Clear every persisted shared-command approval for one Project. */
  clearApprovals(workspaceId: string): void {
    this.configuration?.clearApprovals(workspaceId);
    for (const key of this.inMemoryApprovals.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.inMemoryApprovals.delete(key);
    }
  }

  /** Approve the current shared command only when it still matches the script the user reviewed. */
  async approveCommand(input: WorkspaceEnvironmentCommandApproveInput): Promise<void> {
    const thread = this.requireSetupThread(input.threadId);
    this.assertApprovalAllowed(thread);
    let resolved: WorkspaceEnvironmentCommandResolution;
    try {
      resolved = await this.resolveCommand(thread, input.target);
    } catch (error) {
      this.restartAutomaticApproval(thread, input.target);
      throw error;
    }
    try {
      if (resolved.kind !== "ready") {
        this.restartAutomaticApproval(thread, input.target);
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED",
          "This Project command does not require shared-command approval",
        );
      }
      const approval = resolved.approval;
      if (approval === null) {
        this.restartAutomaticApproval(thread, input.target);
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED",
          "This Project command does not require shared-command approval",
        );
      }
      if (approval.fingerprint !== input.fingerprint) {
        this.restartAutomaticApproval(thread, input.target);
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_STALE",
          "The shared Project command changed before approval",
        );
      }
      this.assertApprovalAllowed(thread);
      this.persistApproval(thread.workspace_id, approval);
    } finally {
      if (resolved.kind === "ready") await this.closeUnstartedCommand(resolved.command);
    }

    this.restartAutomaticApproval(thread, input.target);
  }

  /** Resolve one Action command and its approval state without starting a process. */
  async resolveActionCommand(threadId: string, actionId: string): Promise<WorkspaceEnvironmentCommandResolution> {
    return await this.resolveCommand(this.requireSetupThread(threadId), { kind: "action", actionId });
  }

  /** Read and validate the selected Project environment document for the base checkout or one Thread checkout. */
  async read(workspaceId: string, threadId?: string): Promise<WorkspaceEnvironmentReadResult> {
    if (threadId) {
      const thread = this.requireSetupThread(threadId);
      if (thread.workspace_id !== workspaceId) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_NOT_FOUND",
          "Thread does not belong to this Project",
        );
      }
      return await this.readForThread(thread);
    }
    const storageMode = await this.storageMode(workspaceId);
    const filePath = this.filePathForWorkspace(workspaceId, storageMode);
    return await this.readAt(filePath, storageMode);
  }

  private async readForThread(thread: WorkspaceEnvironmentSetupThread): Promise<WorkspaceEnvironmentReadResult> {
    const storageMode = await this.storageMode(thread.workspace_id);
    const filePath = this.filePathForThread(thread, storageMode);
    return await this.readAt(filePath, storageMode);
  }

  private async readAt(
    filePath: string,
    storageMode: WorkspaceEnvironmentStorageMode,
  ): Promise<WorkspaceEnvironmentReadResult> {
    const bounded = await this.readBounded(filePath);
    if (bounded.kind === "absent") {
      return {
        document: DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
        revision: null,
        status: "absent",
        storageMode,
      };
    }
    if (bounded.kind === "too_large") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment exceeds the maximum persisted size",
        [issue([], "DOCUMENT_TOO_LARGE", "document_too_large", `Environment documents must be at most ${WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES} bytes`)],
      );
    }
    const bytes = bounded.bytes;

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment is not valid JSON",
        [issue([], "INVALID_JSON", "invalid_value", "Workspace environment is not valid JSON")],
      );
    }
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(value);
    if (!parsed.success) throw validationError(parsed.error);
    return {
      document: parsed.data,
      revision: revisionFor(bytes, storageMode, filePath),
      status: "present",
      storageMode,
    };
  }

  private filePathForWorkspace(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): string {
    if (storageMode === "system") return this.filePath(workspaceId);
    return NodePath.join(this.requireWorkspace(workspaceId).path, ".mcode", "environment.json");
  }

  private filePathForThread(
    thread: WorkspaceEnvironmentSetupThread,
    storageMode: WorkspaceEnvironmentStorageMode,
  ): string {
    if (storageMode === "system") return this.filePath(thread.workspace_id);
    const checkoutPath = thread.mode === "worktree" ? thread.worktree_path : this.requireWorkspace(thread.workspace_id).path;
    if (!checkoutPath) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_NOT_FOUND",
        "The shared Project environment checkout is unavailable",
      );
    }
    return NodePath.join(checkoutPath, ".mcode", "environment.json");
  }

  private requireWorkspace(workspaceId: string): WorkspaceEnvironmentWorkspace {
    const workspace = this.options.workspaces?.findById(workspaceId);
    if (workspace) return workspace;
    throw new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_NOT_FOUND",
      "Workspace was not found for shared Project configuration",
    );
  }

  private async storageMode(workspaceId: string): Promise<WorkspaceEnvironmentStorageMode> {
    const stored = this.configuration?.storageMode(workspaceId) ?? this.inMemoryStorageModes.get(workspaceId);
    if (stored) return stored;
    const workspace = this.options.workspaces?.findById(workspaceId);
    const storageMode = workspace && await this.hasValidSharedDocument(NodePath.join(workspace.path, ".mcode", "environment.json"))
      ? "shared"
      : "system";
    this.persistStorageMode(workspaceId, storageMode);
    return storageMode;
  }

  private persistStorageMode(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): void {
    if (this.configuration) this.configuration.setStorageMode(workspaceId, storageMode);
    else this.inMemoryStorageModes.set(workspaceId, storageMode);
  }

  private async hasValidSharedDocument(filePath: string): Promise<boolean> {
    const bounded = await this.readBounded(filePath);
    if (bounded.kind !== "present") return false;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
      return WorkspaceEnvironmentDocumentSchema().safeParse(value).success;
    } catch {
      return false;
    }
  }

  private async resolveCommand(
    thread: WorkspaceEnvironmentSetupThread,
    target: WorkspaceEnvironmentCommandTarget,
    canContinue?: () => boolean,
  ): Promise<WorkspaceEnvironmentCommandResolution> {
    const platform = this.platform();
    const environment = await this.readForThread(thread);
    this.assertCommandResolutionCurrent(canContinue);
    const action = this.resolveCommandAction(environment, target);
    const command = commandForTarget(environment.document.setup, action);
    const script = command ? selectWorkspaceEnvironmentScript(command, platform) : null;
    if (!script) return unavailableCommandResolution(platform, action);
    const preparation = await this.prepareWorkspaceCommand(thread, script);
    await this.assertPreparedCommandCurrent(canContinue, preparation);
    return this.resolvePreparedCommand(environment.storageMode, thread, target, platform, script, preparation, action);
  }

  private assertCommandResolutionCurrent(canContinue: (() => boolean) | undefined): void {
    if (canContinue && !canContinue()) throw new SetupStartCancelledError();
  }

  private resolveCommandAction(
    environment: WorkspaceEnvironmentReadResult,
    target: WorkspaceEnvironmentCommandTarget,
  ): WorkspaceEnvironmentAction | null {
    if (target.kind === "setup") return null;
    const action = environment.document.actions.find((candidate) => candidate.id === target.actionId) ?? null;
    if (!action) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND",
        "Project Action not found",
      );
    }
    return action;
  }

  private async prepareWorkspaceCommand(
    thread: WorkspaceEnvironmentSetupThread,
    script: string,
  ): Promise<TerminalCommandPreparation> {
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Project command execution is unavailable for this Thread",
      );
    }
    return terminalCommands.prepare({
      scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
      script,
      timeoutMs: this.options.manualSetupTimeoutMs ?? DEFAULT_MANUAL_SETUP_TIMEOUT_MS,
      outputMaxBytes: WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
    });
  }

  private async assertPreparedCommandCurrent(
    canContinue: (() => boolean) | undefined,
    preparation: TerminalCommandPreparation,
  ): Promise<void> {
    if (!canContinue || canContinue()) return;
    if (preparation.kind === "ready") await this.closeUnstartedCommand(preparation.command);
    throw new SetupStartCancelledError();
  }

  private resolvePreparedCommand(
    storageMode: WorkspaceEnvironmentStorageMode | undefined,
    thread: WorkspaceEnvironmentSetupThread,
    target: WorkspaceEnvironmentCommandTarget,
    platform: WorkspaceEnvironmentPlatform,
    script: string,
    preparation: TerminalCommandPreparation,
    action: WorkspaceEnvironmentAction | null,
  ): WorkspaceEnvironmentCommandResolution {
    if (preparation.kind !== "ready") {
      return {
        kind: preparation.kind,
        output: preparation.output,
        snapshot: snapshotForPreparation(platform, script, preparation),
        action,
      };
    }
    const approval = storageMode === "shared"
      ? this.pendingApproval(thread.workspace_id, target, platform, script, preparation.command.snapshot)
      : null;
    return {
      kind: "ready",
      command: preparation.command,
      script,
      snapshot: snapshotForPreparation(platform, script, preparation, approval),
      approval,
      action,
    };
  }

  private pendingApproval(
    workspaceId: string,
    target: WorkspaceEnvironmentCommandTarget,
    platform: WorkspaceEnvironmentPlatform,
    script: string,
    snapshot: PreparedTerminalCommand["snapshot"],
  ): WorkspaceEnvironmentCommandApproval | null {
    const terminal = snapshot.terminal;
    if (!terminal) return null;
    const fingerprint = approvalFingerprint({ workspaceId, target, platform, script, terminal });
    return this.hasApproval(workspaceId, commandIdentity(target), fingerprint)
      ? null
      : { target, fingerprint };
  }

  private hasApproval(workspaceId: string, commandId: string, fingerprint: string): boolean {
    return this.configuration?.hasApproval(workspaceId, commandId, fingerprint)
      ?? this.inMemoryApprovals.get(`${workspaceId}:${commandId}`) === fingerprint;
  }

  private restartAutomaticApproval(
    thread: WorkspaceEnvironmentSetupThread,
    target: WorkspaceEnvironmentCommandTarget,
  ): void {
    if (target.kind !== "setup" || !this.automaticRepository?.resumeAwaitingApproval(thread.id)) return;
    this.resumeStartupSetup(thread.id);
    void this.startAutomaticSetup(thread);
  }

  private persistApproval(workspaceId: string, approval: WorkspaceEnvironmentCommandApproval): void {
    const commandId = commandIdentity(approval.target);
    if (this.configuration) this.configuration.approve(workspaceId, commandId, approval.fingerprint);
    else this.inMemoryApprovals.set(`${workspaceId}:${commandId}`, approval.fingerprint);
  }

  private async readBounded(filePath: string): Promise<
    | { kind: "absent" }
    | { kind: "too_large" }
    | { kind: "present"; bytes: Uint8Array }
  > {
    let handle: Awaited<ReturnType<typeof NodeFSPromises.open>>;
    try {
      handle = await NodeFSPromises.open(filePath, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      throw error;
    }
    const bytes = new Uint8Array(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        offset += bytesRead;
        if (bytesRead === 0) break;
      }
      return offset > WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES
        ? { kind: "too_large" }
        : { kind: "present", bytes: bytes.subarray(0, offset) };
    } finally {
      await handle.close();
    }
  }

  /** Validate and atomically replace the workspace environment when its revision is current. */
  async save(input: WorkspaceEnvironmentSaveInput): Promise<WorkspaceEnvironmentReadResult> {
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(input.document);
    if (!parsed.success) throw validationError(parsed.error);
    return this.enqueueSave(
      input.workspaceId,
      () => this.saveValidatedEnvironment(input, parsed.data),
    );
  }

  private async saveValidatedEnvironment(
    input: WorkspaceEnvironmentSaveInput,
    document: WorkspaceEnvironmentSaveInput["document"],
  ): Promise<WorkspaceEnvironmentReadResult> {
    const current = await this.read(input.workspaceId, input.threadId);
    this.assertCurrentEnvironmentRevision(current, input.sourceRevision);
    const thread = input.threadId ? this.requireSetupThread(input.threadId) : null;
    this.assertSaveThreadWorkspace(thread, input.workspaceId);
    const storageMode = current.storageMode ?? "system";
    const filePath = thread
      ? this.filePathForThread(thread, storageMode)
      : this.filePathForWorkspace(input.workspaceId, storageMode);
    const encoded = new TextEncoder().encode(JSON.stringify(document));
    await this.writeEnvironmentDocument(filePath, encoded);
    return { document, revision: revisionFor(encoded, storageMode, filePath), status: "present", storageMode: current.storageMode };
  }

  private assertCurrentEnvironmentRevision(
    current: WorkspaceEnvironmentReadResult,
    sourceRevision: string | null,
  ): void {
    if (current.revision !== sourceRevision) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_STALE",
        "Workspace environment changed since it was loaded",
      );
    }
  }

  private assertSaveThreadWorkspace(
    thread: WorkspaceEnvironmentSetupThread | null,
    workspaceId: string,
  ): void {
    if (thread && thread.workspace_id !== workspaceId) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_NOT_FOUND",
        "Thread does not belong to this Project",
      );
    }
  }

  private async writeEnvironmentDocument(filePath: string, encoded: Uint8Array): Promise<void> {
    const directory = NodePath.dirname(filePath);
    await NodeFSPromises.mkdir(directory, { recursive: true });
    const temporaryPath = NodePath.join(directory, `.environment.${NodeCrypto.randomUUID()}.tmp`);
    try {
      await NodeFSPromises.writeFile(temporaryPath, encoded);
      await NodeFSPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await this.removeTemporaryEnvironmentFile(temporaryPath);
      throw error;
    }
  }

  private async removeTemporaryEnvironmentFile(filePath: string): Promise<void> {
    try {
      await NodeFSPromises.unlink(filePath);
    } catch {
      // Cleanup is limited to this operation's own temporary file.
    }
  }

  /** Starts one private manual Setup attempt for a Thread without changing its Turn state. */
  async startSetup(input: WorkspaceEnvironmentSetupStartInput): Promise<WorkspaceEnvironmentSetupAttempt> {
    if (this.disposed) throw this.setupUnavailableError();
    const thread = this.requireSetupThread(input.threadId);
    this.assertSetupStartAllowed(thread);
    const active = this.activeSetupResources.get(input.threadId);
    if (active) return active.attempt;
    const starting = this.startingSetupAttempts.get(input.threadId);
    if (starting) return await starting.promise;
    if (this.setupWorkCount() >= MAX_CONCURRENT_MANUAL_SETUP_ATTEMPTS) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY",
        "Too many manual Setup attempts are still being cleaned up",
      );
    }
    const generation = this.setupGenerations.get(thread.id) ?? 0;
    const created = this.createSetupAttempt(thread, generation);
    this.startingSetupAttempts.set(thread.id, {
      workspaceId: thread.workspace_id,
      promise: created,
    });
    try {
      return await created;
    } finally {
      if (this.startingSetupAttempts.get(thread.id)?.promise === created) {
        this.startingSetupAttempts.delete(thread.id);
        this.clearCancelledStartTombstone(thread.id);
      }
    }
  }

  /** Returns the latest transient manual Setup attempt for a Thread. */
  getSetupAttempt(input: WorkspaceEnvironmentSetupGetInput): WorkspaceEnvironmentSetupGetResult {
    return { attempt: this.latestSetupAttempts.get(input.threadId) ?? null };
  }

  /** Blocks manual Setup starts while a Thread deletion operation is active. */
  beginThreadDeletion(threadId: string): () => void {
    return this.beginDeletion(this.deletingThreadCounts, threadId);
  }

  /** Blocks manual Setup starts while a workspace deletion operation is active. */
  beginWorkspaceDeletion(workspaceId: string): () => void {
    return this.beginDeletion(this.deletingWorkspaceCounts, workspaceId);
  }

  /** Cancels and clears manual Setup state for one Thread. */
  async cancelSetupForThread(threadId: string): Promise<void> {
    if (this.hasAutomaticSetupForThread(threadId)) {
      await this.cancelAutomaticSetupForThread(threadId);
    }
    this.setupGenerations.set(threadId, (this.setupGenerations.get(threadId) ?? 0) + 1);
    const starting = this.startingSetupAttempts.get(threadId);
    if (starting && !(await this.waitForStartingAttempt(starting.promise))) {
      this.clearSetupState(threadId, true);
      return;
    }
    if (starting) {
      try {
        await starting.promise;
      } catch (error) {
        if (!(error instanceof SetupStartCancelledError)) throw error;
      }
    }
    const resource = this.activeSetupResources.get(threadId);
    if (resource) {
      const result = await resource.command.close();
      if (result.kind === "containment_failure") {
        throw new Error("Project Setup process containment failed");
      }
    }
    this.clearSetupState(threadId);
  }

  /** Cancels and clears manual Setup state for every Thread in one workspace. */
  async cancelSetupForWorkspace(workspaceId: string): Promise<void> {
    const threadIds = this.workspaceSetupThreadIds(workspaceId);
    await this.cancelSetupThreads(threadIds);
  }

  /** Cancels every active manual Setup command before server shutdown. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return await this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeActiveSetup();
    return await this.disposePromise;
  }

  private async disposeActiveSetup(): Promise<void> {
    if (this.automaticRepository) await this.interruptActiveAutomaticSetups();
    const threadIds = new Set([
      ...this.activeSetupResources.keys(),
      ...this.startingSetupAttempts.keys(),
    ]);
    await this.cancelSetupThreads(threadIds);
    this.latestSetupAttempts.clear();
    this.completedSetupThreadIds.splice(0);
    if (this.startingSetupAttempts.size === 0) this.setupGenerations.clear();
  }

  private workspaceSetupThreadIds(workspaceId: string): Set<string> {
    const threadIds = new Set<string>();
    this.addAutomaticWorkspaceThreadIds(threadIds, workspaceId);
    this.addManualWorkspaceThreadIds(threadIds, workspaceId);
    this.addStartingWorkspaceThreadIds(threadIds, workspaceId);
    return threadIds;
  }

  private addAutomaticWorkspaceThreadIds(threadIds: Set<string>, workspaceId: string): void {
    const activeThreadIds = [
      ...this.activeAutomaticSetupResources.keys(),
      ...this.startingAutomaticSetupPromises.keys(),
      ...this.automaticDrainLoops.keys(),
    ];
    for (const threadId of activeThreadIds) {
      if (this.options.threads?.findById(threadId)?.workspace_id === workspaceId) threadIds.add(threadId);
    }
  }

  private addManualWorkspaceThreadIds(threadIds: Set<string>, workspaceId: string): void {
    for (const [threadId, resource] of this.activeSetupResources) {
      if (resource.attempt.workspaceId === workspaceId) threadIds.add(threadId);
    }
    for (const [threadId, attempt] of this.latestSetupAttempts) {
      if (attempt.workspaceId === workspaceId) threadIds.add(threadId);
    }
  }

  private addStartingWorkspaceThreadIds(threadIds: Set<string>, workspaceId: string): void {
    for (const [threadId, starting] of this.startingSetupAttempts) {
      if (starting.workspaceId === workspaceId) threadIds.add(threadId);
    }
  }

  private async cancelSetupThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(threadIds, (threadId) => this.cancelSetupForThread(threadId)),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private requireAutomaticRepository(): WorkspaceEnvironmentAutomaticRepository {
    if (this.automaticRepository) return this.automaticRepository;
    throw new Error("Automatic Project Setup requires SQLite lifecycle storage");
  }

  private requireAutomaticSetupThread(threadId: string): WorkspaceEnvironmentSetupThread {
    const thread = this.requireSetupThread(threadId);
    if (
      this.disposed ||
      thread.mode !== "worktree" ||
      thread.worktree_managed !== true ||
      thread.deleted_at !== null && thread.deleted_at !== undefined ||
      thread.cleanup_state !== null && thread.cleanup_state !== undefined ||
      this.deletingThreadCounts.has(thread.id) ||
      this.deletingWorkspaceCounts.has(thread.workspace_id)
    ) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup is unavailable for this Thread",
      );
    }
    return thread;
  }

  private startAutomaticSetup(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    const existing = this.startingAutomaticSetupPromises.get(thread.id);
    if (existing) return existing;
    const starting = this.startAutomaticSetupAttempt(thread);
    this.startingAutomaticSetupPromises.set(thread.id, starting);
    void starting.then(
      () => {
        if (this.startingAutomaticSetupPromises.get(thread.id) === starting) {
          this.startingAutomaticSetupPromises.delete(thread.id);
        }
      },
      () => {
        if (this.startingAutomaticSetupPromises.get(thread.id) === starting) {
          this.startingAutomaticSetupPromises.delete(thread.id);
        }
      },
    );
    return starting;
  }

  private async startAutomaticSetupAttempt(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    const repository = this.requireAutomaticRepository();
    const snapshot = repository.snapshot(thread.id);
    const queuedAttemptId = queuedAutomaticAttemptId(snapshot);
    if (!queuedAttemptId) return;
    const configuration = await this.resolveAutomaticSetupConfiguration(repository, thread, queuedAttemptId);
    if (!configuration) return;
    if (!this.isAutomaticAttemptReadyToStart(repository, thread.id, queuedAttemptId)) return;
    if (!hasAutomaticSetupScript(configuration)) {
      await this.releaseAutomaticSetupWithoutCommand(repository, thread.id, queuedAttemptId);
      return;
    }
    const preparation = await this.prepareAutomaticSetupCommand(
      repository,
      thread,
      queuedAttemptId,
      configuration,
    );
    if (!preparation) return;
    await this.launchPreparedAutomaticSetup(
      repository,
      thread,
      queuedAttemptId,
      configuration,
      preparation,
    );
  }

  private async resolveAutomaticSetupConfiguration(
    repository: WorkspaceEnvironmentAutomaticRepository,
    thread: WorkspaceEnvironmentSetupThread,
    attemptId: string,
  ): Promise<AutomaticSetupConfiguration | null> {
    const platform = this.platform();
    try {
      const environment = await this.readForThread(thread);
      return {
        platform,
        script: environment.document.setup
          ? selectWorkspaceEnvironmentScript(environment.document.setup, platform)
          : null,
        storageMode: environment.storageMode ?? "system",
      };
    } catch (error) {
      this.failAutomaticConfigurationRead(repository, thread.id, attemptId, platform, error);
      return null;
    }
  }

  private failAutomaticConfigurationRead(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    platform: WorkspaceEnvironmentPlatform,
    error: unknown,
  ): void {
    const invalid = error instanceof WorkspaceEnvironmentServiceError;
    repository.failQueuedAttempt({
      threadId,
      attemptId,
      reason: invalid ? "setup_configuration_invalid" : "setup_unavailable",
      snapshot: unavailableSnapshot(platform, null),
      outcome: invalid ? "configuration_failure" : "unavailable",
    });
    this.blockStartupSetup(
      threadId,
      invalid ? "SETUP_CONFIGURATION_INVALID" : "SETUP_UNAVAILABLE",
      invalid ? "Project Setup configuration is invalid" : "Project Setup is unavailable",
    );
  }

  private isAutomaticAttemptReadyToStart(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): boolean {
    return this.isAutomaticAttemptQueued(repository, threadId, attemptId)
      && this.isAutomaticSetupAdmissionAllowed(threadId);
  }

  private async releaseAutomaticSetupWithoutCommand(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): Promise<void> {
    this.skipStartupSetup(threadId);
    repository.releaseWithoutSetup(threadId, attemptId);
    await this.drainReleasedAutomaticTurn(threadId);
  }

  private async prepareAutomaticSetupCommand(
    repository: WorkspaceEnvironmentAutomaticRepository,
    thread: WorkspaceEnvironmentSetupThread,
    attemptId: string,
    configuration: AutomaticSetupConfiguration & { script: string },
  ): Promise<TerminalCommandPreparation | null> {
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      this.failAutomaticSetupUnavailable(repository, thread.id, attemptId, configuration.platform, configuration.script);
      return null;
    }
    try {
      const preparation = await terminalCommands.prepare({
        scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
        script: configuration.script,
        timeoutMs: this.options.manualSetupTimeoutMs ?? DEFAULT_MANUAL_SETUP_TIMEOUT_MS,
        outputMaxBytes: WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
        onOutput: (chunk) => this.appendStartupOutput(thread.id, chunk),
      });
      return this.acceptAutomaticSetupPreparation(repository, thread.id, attemptId, configuration, preparation);
    } catch {
      repository.failQueuedAttempt({
        threadId: thread.id,
        attemptId,
        reason: "setup_unavailable",
        snapshot: unavailableSnapshot(configuration.platform, configuration.script),
        outcome: "launch_failure",
      });
      this.blockStartupSetup(thread.id, "SETUP_UNAVAILABLE", "Project Setup could not start");
      return null;
    }
  }

  private acceptAutomaticSetupPreparation(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    configuration: AutomaticSetupConfiguration & { script: string },
    preparation: TerminalCommandPreparation,
  ): TerminalCommandPreparation | null {
    if (preparation.kind === "ready") return preparation;
    repository.failQueuedAttempt({
      threadId,
      attemptId,
      reason: preparation.kind === "unavailable" ? "setup_unavailable" : "setup_configuration_invalid",
      snapshot: snapshotForPreparation(configuration.platform, configuration.script, preparation),
      outcome: preparation.kind === "unavailable" ? "unavailable" : "configuration_failure",
    });
    this.blockStartupSetup(
      threadId,
      preparation.kind === "unavailable" ? "SETUP_UNAVAILABLE" : "SETUP_CONFIGURATION_INVALID",
      preparation.kind === "unavailable" ? "Project Setup is unavailable" : "Project Setup configuration is invalid",
    );
    return null;
  }

  private failAutomaticSetupUnavailable(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    platform: WorkspaceEnvironmentPlatform,
    script: string,
  ): void {
    repository.failQueuedAttempt({
      threadId,
      attemptId,
      reason: "setup_unavailable",
      snapshot: unavailableSnapshot(platform, script),
      outcome: "unavailable",
    });
    this.blockStartupSetup(threadId, "SETUP_UNAVAILABLE", "Project Setup is unavailable");
  }

  private async launchPreparedAutomaticSetup(
    repository: WorkspaceEnvironmentAutomaticRepository,
    thread: WorkspaceEnvironmentSetupThread,
    queuedAttemptId: string,
    configuration: AutomaticSetupConfiguration & { script: string },
    preparation: TerminalCommandPreparation,
  ): Promise<void> {
    if (preparation.kind !== "ready") return;
    const approval = this.automaticSetupApproval(thread, configuration, preparation.command);
    if (approval) {
      await this.deferAutomaticSetupForApproval(repository, thread.id, queuedAttemptId, configuration, preparation.command, approval);
      this.blockStartupSetup(thread.id, "SETUP_APPROVAL_REQUIRED", "Project Setup requires approval");
      return;
    }
    if (!this.isAutomaticSetupAdmissionAllowed(thread.id)) {
      await this.closeUnstartedCommand(preparation.command);
      return;
    }
    const attemptId = repository.beginAttempt({
      threadId: thread.id,
      attemptId: queuedAttemptId,
      snapshot: snapshotForPreparation(configuration.platform, configuration.script, preparation),
    });
    if (!attemptId) {
      await this.closeUnstartedCommand(preparation.command);
      return;
    }
    this.resumeStartupSetup(thread.id);
    this.startAutomaticSetupCommand(repository, thread, attemptId, preparation.command);
  }

  private automaticSetupApproval(
    thread: WorkspaceEnvironmentSetupThread,
    configuration: AutomaticSetupConfiguration & { script: string },
    command: PreparedTerminalCommand,
  ): WorkspaceEnvironmentCommandApproval | null {
    if (configuration.storageMode !== "shared") return null;
    return this.pendingApproval(thread.workspace_id, { kind: "setup" }, configuration.platform, configuration.script, command.snapshot);
  }

  private async deferAutomaticSetupForApproval(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    configuration: AutomaticSetupConfiguration & { script: string },
    command: PreparedTerminalCommand,
    approval: WorkspaceEnvironmentCommandApproval,
  ): Promise<void> {
    await this.closeUnstartedCommand(command);
    repository.awaitApproval({
      threadId,
      attemptId,
      snapshot: snapshotForPreparedCommand(configuration.platform, configuration.script, command, approval),
    });
  }

  private startAutomaticSetupCommand(
    repository: WorkspaceEnvironmentAutomaticRepository,
    thread: WorkspaceEnvironmentSetupThread,
    attemptId: string,
    command: PreparedTerminalCommand,
  ): void {
    const resource: ActiveAutomaticSetupResource = { attemptId, command, cleanupPending: false };
    this.activeAutomaticSetupResources.set(thread.id, resource);
    void command.waitForRelease().then(() => this.releaseAutomaticSetupResource(thread.id, resource));
    void Promise.resolve()
      .then(() => command.start())
      .then((completion) => this.completeAutomaticSetupCommand(repository, thread.id, attemptId, resource, completion))
      .catch(() => this.recordAutomaticSetupLaunchFailure(repository, thread.id, attemptId));
  }

  private releaseAutomaticSetupResource(threadId: string, resource: ActiveAutomaticSetupResource): void {
    if (this.activeAutomaticSetupResources.get(threadId) !== resource) return;
    this.activeAutomaticSetupResources.delete(threadId);
    this.automaticStopPromises.delete(threadId);
    this.clearAutomaticRecoveryGeneration(threadId);
  }

  private async completeAutomaticSetupCommand(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    resource: ActiveAutomaticSetupResource,
    completion: TerminalCommandCompletion,
  ): Promise<void> {
    const result = automaticCompletionResult(completion);
    const completed = repository.completeAttempt({ threadId, attemptId, ...result });
    if (result.outcome === "containment_failure" && this.activeAutomaticSetupResources.get(threadId) === resource) {
      resource.cleanupPending = true;
    }
    if (completed && result.state === "failed") {
      this.blockStartupSetup(threadId, "SETUP_FAILED", "Project Setup did not complete successfully");
    }
    if (completed && result.state === "passed") await this.drainReleasedAutomaticTurn(threadId);
  }

  private recordAutomaticSetupLaunchFailure(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): void {
    repository.completeAttempt({
      threadId,
      attemptId,
      state: "failed",
      reason: "setup_unavailable",
      outcome: "launch_failure",
      exitCode: null,
      output: "",
      outputTruncated: false,
    });
    this.blockStartupSetup(threadId, "SETUP_UNAVAILABLE", "Project Setup could not start");
  }

  private appendStartupOutput(threadId: string, chunk: Uint8Array): void {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup" || startup.state !== "running") return;
    const content = Buffer.from(chunk).toString("utf8");
    for (let offset = 0; offset < content.length; offset += 4_096) {
      const part = content.slice(offset, offset + 4_096);
      if (part) this.options.threadStartups?.appendOutput(startup.startupId, part);
    }
  }

  private blockStartupSetup(threadId: string, code: string, message: string): void {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup" || startup.state !== "running") return;
    this.options.threadStartups?.block(startup.startupId, { code, message, actions: ["retry", "continue"] });
  }

  private resumeStartupSetup(threadId: string): void {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup" || startup.state !== "blocked") return;
    this.options.threadStartups?.resume(startup.startupId);
  }

  private skipStartupSetup(threadId: string): void {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup" || (startup.state !== "running" && startup.state !== "blocked")) return;
    this.options.threadStartups?.skip(startup.startupId, "setup");
  }

  private async interruptActiveAutomaticSetups(): Promise<void> {
    const repository = this.automaticRepository;
    if (!repository) return;
    repository.interruptUnfinishedAttempts();
    const settling = await Promise.allSettled([
      ...this.startingAutomaticSetupPromises.values(),
      ...this.automaticStopPromises.values(),
    ]);
    const settlingFailure = settling.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (settlingFailure) throw settlingFailure.reason;
    const results = await Promise.allSettled(
      Array.from(
        this.activeAutomaticSetupResources.entries(),
        ([threadId, resource]) => this.closeActiveAutomaticSetupResource(threadId, resource),
      ),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    this.activeAutomaticSetupResources.clear();
    await Promise.allSettled(this.automaticDrainLoops.values());
  }

  private isAutomaticAttemptQueued(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): boolean {
    const snapshot = repository.snapshot(threadId);
    return snapshot.gate === "blocked"
      && snapshot.attempt?.id === attemptId
      && snapshot.attempt.state === "queued";
  }

  private isAutomaticSetupAdmissionAllowed(threadId: string): boolean {
    try {
      this.requireAutomaticSetupThread(threadId);
      return true;
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentServiceError) return false;
      throw error;
    }
  }

  private hasAutomaticSetupForThread(threadId: string): boolean {
    if (!this.automaticRepository) return false;
    return this.automaticRepository.snapshot(threadId).gate === "blocked"
      || this.activeAutomaticSetupResources.has(threadId)
      || this.startingAutomaticSetupPromises.has(threadId)
      || this.automaticDrainLoops.has(threadId);
  }

  private async cancelAutomaticSetupForThread(threadId: string): Promise<void> {
    const repository = this.automaticRepository;
    if (!repository) return;
    const stopping = this.automaticStopPromises.get(threadId);
    if (stopping) await stopping;
    repository.interruptCurrentAttempt(threadId);
    const starting = this.startingAutomaticSetupPromises.get(threadId);
    const close = async (): Promise<void> => {
      const resource = this.activeAutomaticSetupResources.get(threadId);
      if (resource) await this.closeActiveAutomaticSetupResource(threadId, resource);
    };
    await close();
    if (starting) await starting.catch((error: unknown) => {
      if (!(error instanceof SetupStartCancelledError)) throw error;
    });
    await close();
    const drain = this.automaticDrainLoops.get(threadId);
    if (drain) await drain;
  }

  private async drainReleasedAutomaticTurn(threadId?: string): Promise<void> {
    const dispatcher = this.automaticDispatcher;
    if (!dispatcher) return;
    const repository = this.requireAutomaticRepository();
    if (threadId) {
      await this.startAutomaticDrain(threadId, repository, dispatcher);
      return;
    }
    await Promise.all(repository.releasedThreadIds().map((releasedThreadId) =>
      this.startAutomaticDrain(releasedThreadId, repository, dispatcher),
    ));
  }

  private startAutomaticDrain(
    threadId: string,
    repository: WorkspaceEnvironmentAutomaticRepository,
    dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher,
  ): Promise<void> {
    const existing = this.automaticDrainLoops.get(threadId);
    if (existing) {
      void existing.then(() => this.drainReleasedAutomaticTurn(threadId));
      return Promise.resolve();
    }
    let resolveFirstDispatch!: () => void;
    const firstDispatch = new Promise<void>((resolve) => { resolveFirstDispatch = resolve; });
    const loop = this.drainAutomaticThread(threadId, repository, dispatcher, resolveFirstDispatch);
    this.automaticDrainLoops.set(threadId, loop);
    void loop.then(
      () => {
        if (this.automaticDrainLoops.get(threadId) === loop) this.automaticDrainLoops.delete(threadId);
      },
      () => {
        if (this.automaticDrainLoops.get(threadId) === loop) this.automaticDrainLoops.delete(threadId);
      },
    );
    return firstDispatch;
  }

  private async drainAutomaticThread(
    threadId: string,
    repository: WorkspaceEnvironmentAutomaticRepository,
    dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher,
    resolveFirstDispatch: () => void,
  ): Promise<void> {
    let firstDispatchResolved = false;
    const resolveWhenResponsive = () => {
      if (firstDispatchResolved) return;
      firstDispatchResolved = true;
      resolveFirstDispatch();
    };
    for (;;) {
      try {
        if (!this.isAutomaticSetupAdmissionAllowed(threadId)) {
          resolveWhenResponsive();
          return;
        }
        const claimed = repository.claimReleasedTurn(threadId);
        if (!claimed) {
          resolveWhenResponsive();
          return;
        }
        const accepted = await dispatcher.dispatch(claimed.submission);
        repository.markDispatched(claimed.id);
        resolveWhenResponsive();
        await accepted.completion.catch(() => undefined);
      } catch {
        // A malformed or provider-uncertain claim must never be replayed automatically.
        resolveWhenResponsive();
        return;
      }
    }
  }

  private invalidateAutomaticRetry(threadId: string): void {
    this.automaticStopGenerations.set(threadId, (this.automaticStopGenerations.get(threadId) ?? 0) + 1);
  }

  private runAutomaticRecoveryOperation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.automaticRecoveryOperationTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.automaticRecoveryOperationTails.set(threadId, tail);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.automaticRecoveryOperationTails.get(threadId) === tail) {
          this.automaticRecoveryOperationTails.delete(threadId);
        }
        this.clearAutomaticRecoveryGeneration(threadId);
      });
  }

  private requireAutomaticResourceReleased(threadId: string): void {
    if (this.activeAutomaticSetupResources.get(threadId)?.cleanupPending) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup is still waiting for the prior command to release",
      );
    }
  }

  private clearAutomaticRecoveryGeneration(threadId: string): void {
    if (!this.automaticRecoveryOperationTails.has(threadId) && !this.automaticStopPromises.has(threadId)) {
      this.automaticStopGenerations.delete(threadId);
    }
  }

  private async closeActiveAutomaticSetupResource(
    threadId: string,
    resource: ActiveAutomaticSetupResource,
  ): Promise<void> {
    const result = await resource.command.close();
    if (result.kind === "containment_failure") {
      resource.cleanupPending = true;
      throw new Error("Automatic Project Setup process containment failed");
    }
    if (this.activeAutomaticSetupResources.get(threadId) === resource) {
      this.activeAutomaticSetupResources.delete(threadId);
    }
  }

  private enqueueSave<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.saveTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.saveTails.set(workspaceId, current);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.saveTails.get(workspaceId) === current) this.saveTails.delete(workspaceId);
      });
  }

  private async createSetupAttempt(
    thread: WorkspaceEnvironmentSetupThread,
    generation: number,
  ): Promise<WorkspaceEnvironmentSetupAttempt> {
    const platform = this.platform();
    let resolved: WorkspaceEnvironmentCommandResolution;
    try {
      resolved = await this.resolveCommand(thread, { kind: "setup" }, () => this.isStartCurrent(thread.id, generation));
    } catch (error) {
      return this.handleSetupCommandResolutionFailure(thread, generation, platform, error);
    }
    this.ensureStartCurrent(thread.id, generation);
    return this.createSetupAttemptFromResolution(thread, resolved);
  }

  private handleSetupCommandResolutionFailure(
    thread: WorkspaceEnvironmentSetupThread,
    generation: number,
    platform: WorkspaceEnvironmentPlatform,
    error: unknown,
  ): WorkspaceEnvironmentSetupAttempt {
    this.ensureStartCurrent(thread.id, generation);
    if (!isConfigurationResolutionError(error)) throw error;
    return this.recordConfigurationFailure(thread, unavailableSnapshot(platform, null), "Project Setup configuration is invalid");
  }

  private async createSetupAttemptFromResolution(
    thread: WorkspaceEnvironmentSetupThread,
    resolved: WorkspaceEnvironmentCommandResolution,
  ): Promise<WorkspaceEnvironmentSetupAttempt> {
    if (resolved.kind === "unavailable") return this.recordUnavailableSetupAttempt(thread, resolved);
    if (resolved.kind === "configuration") return this.recordConfigurationFailure(thread, resolved.snapshot, resolved.output);
    if (resolved.approval) return this.recordSetupAwaitingApproval(thread, resolved);
    return this.startRunningSetupAttempt(thread, resolved);
  }

  private recordUnavailableSetupAttempt(
    thread: WorkspaceEnvironmentSetupThread,
    resolved: Extract<WorkspaceEnvironmentCommandResolution, { kind: "unavailable" }>,
  ): WorkspaceEnvironmentSetupAttempt {
    return this.recordFinishedAttempt({
      threadId: thread.id,
      workspaceId: thread.workspace_id,
      status: "unavailable",
      outcome: "unavailable",
      snapshot: resolved.snapshot,
      startedAt: null,
      exitCode: null,
      output: resolved.output,
      outputTruncated: false,
    });
  }

  private recordConfigurationFailure(
    thread: WorkspaceEnvironmentSetupThread,
    snapshot: WorkspaceEnvironmentSetupLaunchSnapshot,
    output: string,
  ): WorkspaceEnvironmentSetupAttempt {
    return this.recordFinishedAttempt({
      threadId: thread.id,
      workspaceId: thread.workspace_id,
      status: "failed",
      outcome: "configuration_failure",
      snapshot,
      startedAt: null,
      exitCode: null,
      output,
      outputTruncated: false,
    });
  }

  private async recordSetupAwaitingApproval(
    thread: WorkspaceEnvironmentSetupThread,
    ready: Extract<WorkspaceEnvironmentCommandResolution, { kind: "ready" }>,
  ): Promise<WorkspaceEnvironmentSetupAttempt> {
    await this.closeUnstartedCommand(ready.command);
    return this.recordAwaitingApprovalAttempt({
      threadId: thread.id,
      workspaceId: thread.workspace_id,
      status: "awaiting-approval",
      outcome: null,
      snapshot: ready.snapshot,
      startedAt: null,
      exitCode: null,
      output: "",
      outputTruncated: false,
    });
  }

  private startRunningSetupAttempt(
    thread: WorkspaceEnvironmentSetupThread,
    ready: Extract<WorkspaceEnvironmentCommandResolution, { kind: "ready" }>,
  ): WorkspaceEnvironmentSetupAttempt {
    const createdAt = this.now();
    const running = freezeSetupAttempt({
      id: this.createAttemptId(),
      threadId: thread.id,
      workspaceId: thread.workspace_id,
      status: "running",
      outcome: null,
      snapshot: ready.snapshot,
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      exitCode: null,
      output: "",
      outputTruncated: false,
      cleanupPending: false,
    });
    this.latestSetupAttempts.set(thread.id, running);
    this.activeSetupResources.set(thread.id, { attempt: running, command: ready.command });
    void ready.command.waitForRelease().then(() => this.releaseActiveResource(thread.id, running.id));
    this.startManualSetupCommand(running, ready.command);
    return running;
  }

  private startManualSetupCommand(
    running: WorkspaceEnvironmentSetupAttempt,
    command: PreparedTerminalCommand,
  ): void {
    void Promise.resolve()
      .then(() => command.start())
      .then((completion) => this.finishRunningAttempt(running, completion))
      .catch(() => this.finishRunningAttempt(running, manualSetupLaunchFailure()));
  }

  private requireSetupThread(threadId: string): WorkspaceEnvironmentSetupThread {
    const thread = this.options.threads?.findById(threadId);
    if (thread) return thread;
    throw new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_NOT_FOUND",
      "Thread was not found for manual Setup",
    );
  }

  private assertSetupStartAllowed(thread: WorkspaceEnvironmentSetupThread): void {
    const eligible = thread.mode === "direct" || (
      thread.mode === "worktree" && thread.worktree_managed === false
    );
    if (
      !eligible ||
      thread.deleted_at !== null && thread.deleted_at !== undefined ||
      thread.cleanup_state !== null && thread.cleanup_state !== undefined ||
      this.deletingThreadCounts.has(thread.id) ||
      this.deletingWorkspaceCounts.has(thread.workspace_id)
    ) {
      throw this.setupUnavailableError();
    }
  }

  private setupUnavailableError(): WorkspaceEnvironmentServiceError {
    return new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      "Manual Setup is unavailable for this Thread",
    );
  }

  private beginDeletion(counts: Map<string, number>, id: string): () => void {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = counts.get(id);
      if (count === undefined || count <= 1) counts.delete(id);
      else counts.set(id, count - 1);
    };
  }

  private isStartCurrent(threadId: string, generation: number): boolean {
    return (this.setupGenerations.get(threadId) ?? 0) === generation;
  }

  private ensureStartCurrent(threadId: string, generation: number): void {
    if (!this.isStartCurrent(threadId, generation)) throw new SetupStartCancelledError();
  }

  private async closeUnstartedCommand(command: PreparedTerminalCommand): Promise<void> {
    const result = await command.close();
    if (result.kind === "containment_failure") {
      throw new Error("Project Setup command could not be cancelled before it started");
    }
  }

  private finishRunningAttempt(
    running: WorkspaceEnvironmentSetupAttempt,
    completion: TerminalCommandCompletion,
  ): void {
    const active = this.activeSetupResources.get(running.threadId);
    const current = active?.attempt ?? this.latestSetupAttempts.get(running.threadId);
    if (!current || current.id !== running.id) return;
    const result = manualCompletionResult(completion);
    const completed = freezeSetupAttempt({
      ...current,
      ...result,
      finishedAt: this.now(),
      output: completion.output,
      outputTruncated: completion.outputTruncated,
      cleanupPending: completion.kind === "containment_failure",
    });
    this.latestSetupAttempts.set(completed.threadId, completed);
    this.finalizeRunningSetupAttempt(active, completed);
  }

  private finalizeRunningSetupAttempt(
    active: ActiveSetupResource | undefined,
    completed: WorkspaceEnvironmentSetupAttempt,
  ): void {
    if (completed.cleanupPending && active) {
      active.attempt = completed;
      return;
    }
    if (active?.attempt.id === completed.id) this.activeSetupResources.delete(completed.threadId);
    this.retainCompletedAttempt(completed);
  }

  private recordFinishedAttempt(input: Omit<WorkspaceEnvironmentSetupAttempt, "id" | "createdAt" | "finishedAt" | "cleanupPending">): WorkspaceEnvironmentSetupAttempt {
    const createdAt = this.now();
    const attempt = freezeSetupAttempt({
      ...input,
      id: this.createAttemptId(),
      createdAt,
      finishedAt: createdAt,
      cleanupPending: false,
    });
    this.latestSetupAttempts.set(attempt.threadId, attempt);
    this.retainCompletedAttempt(attempt);
    return attempt;
  }

  private assertApprovalAllowed(thread: WorkspaceEnvironmentSetupThread): void {
    if (
      thread.deleted_at !== null && thread.deleted_at !== undefined ||
      thread.cleanup_state !== null && thread.cleanup_state !== undefined ||
      this.deletingThreadCounts.has(thread.id) ||
      this.deletingWorkspaceCounts.has(thread.workspace_id)
    ) {
      throw this.setupUnavailableError();
    }
  }

  private recordAwaitingApprovalAttempt(input: Omit<WorkspaceEnvironmentSetupAttempt, "id" | "createdAt" | "finishedAt" | "cleanupPending">): WorkspaceEnvironmentSetupAttempt {
    const attempt = freezeSetupAttempt({
      ...input,
      id: this.createAttemptId(),
      createdAt: this.now(),
      finishedAt: null,
      cleanupPending: false,
    });
    this.latestSetupAttempts.set(attempt.threadId, attempt);
    return attempt;
  }

  private releaseActiveResource(threadId: string, attemptId: string): void {
    const active = this.activeSetupResources.get(threadId);
    if (!active || active.attempt.id !== attemptId) return;
    this.activeSetupResources.delete(threadId);
    if (active.attempt.status !== "running") {
      const completed = active.attempt.cleanupPending
        ? freezeSetupAttempt({ ...active.attempt, cleanupPending: false })
        : active.attempt;
      this.latestSetupAttempts.set(threadId, completed);
      this.retainCompletedAttempt(completed);
    }
  }

  private retainCompletedAttempt(attempt: WorkspaceEnvironmentSetupAttempt): void {
    if (attempt.status === "running") return;
    const existing = this.completedSetupThreadIds.indexOf(attempt.threadId);
    if (existing >= 0) this.completedSetupThreadIds.splice(existing, 1);
    this.completedSetupThreadIds.push(attempt.threadId);
    while (this.completedSetupThreadIds.length > MAX_RETAINED_COMPLETED_SETUP_ATTEMPTS) {
      const oldestThreadId = this.completedSetupThreadIds.shift();
      if (!oldestThreadId) return;
      if (this.activeSetupResources.has(oldestThreadId)) continue;
      this.latestSetupAttempts.delete(oldestThreadId);
    }
  }

  private clearSetupState(threadId: string, preserveCancellationTombstone = false): void {
    this.activeSetupResources.delete(threadId);
    this.latestSetupAttempts.delete(threadId);
    if (!preserveCancellationTombstone) this.setupGenerations.delete(threadId);
    const completedIndex = this.completedSetupThreadIds.indexOf(threadId);
    if (completedIndex >= 0) this.completedSetupThreadIds.splice(completedIndex, 1);
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private createAttemptId(): string {
    return (this.options.createAttemptId ?? NodeCrypto.randomUUID)();
  }

  private setupWorkCount(): number {
    return new Set([
      ...this.activeSetupResources.keys(),
      ...this.startingSetupAttempts.keys(),
    ]).size;
  }

  private async waitForStartingAttempt(starting: Promise<WorkspaceEnvironmentSetupAttempt>): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settled = starting.then(() => true, () => true);
    const expired = new Promise<false>((resolve) => {
      timeout = this.schedule(
        () => resolve(false),
        this.options.setupCancellationWaitMs ?? DEFAULT_SETUP_CANCELLATION_WAIT_MS,
      );
    });
    const result = await Promise.race([settled, expired]);
    if (timeout) this.cancelScheduled(timeout);
    return result;
  }

  private clearCancelledStartTombstone(threadId: string): void {
    if (!this.activeSetupResources.has(threadId) && !this.latestSetupAttempts.has(threadId)) {
      this.setupGenerations.delete(threadId);
    }
  }
}

function commandIdentity(target: WorkspaceEnvironmentCommandTarget): string {
  return target.kind === "setup" ? "setup" : `action:${target.actionId}`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, "\n");
}

function approvalFingerprint(input: {
  readonly workspaceId: string;
  readonly target: WorkspaceEnvironmentCommandTarget;
  readonly platform: WorkspaceEnvironmentPlatform;
  readonly script: string;
  readonly terminal: NonNullable<PreparedTerminalCommand["snapshot"]["terminal"]>;
}): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify({
    contractVersion: WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION,
    projectIdentity: input.workspaceId,
    commandIdentity: commandIdentity(input.target),
    operatingSystem: input.platform,
    resolvedScript: normalizeLineEndings(input.script),
    terminalExecutable: input.terminal.executable,
    terminalArguments: input.terminal.arguments.map(normalizeLineEndings),
  })).digest("hex");
}

function requireWorkspaceEnvironmentPlatform(
  platform: WorkspaceEnvironmentPlatform | undefined,
): WorkspaceEnvironmentPlatform {
  if (platform) return platform;
  throw new Error("Workspace environment platform is required");
}

/** Selects the non-empty platform override or the non-empty default command. */
export function selectWorkspaceEnvironmentScript(
  command: WorkspaceEnvironmentCommand,
  platform: WorkspaceEnvironmentPlatform,
): string | null {
  const override = command[platform];
  if (typeof override === "string" && override.trim().length > 0) return override;
  const defaultScript = command.default;
  return typeof defaultScript === "string" && defaultScript.trim().length > 0 ? defaultScript : null;
}

function unavailableSnapshot(
  platform: WorkspaceEnvironmentPlatform,
  script: string | null,
): WorkspaceEnvironmentSetupLaunchSnapshot {
  return { platform, script, checkoutPath: null, terminal: null, approval: null };
}

function snapshotForPreparation(
  platform: WorkspaceEnvironmentPlatform,
  script: string,
  preparation: TerminalCommandPreparation,
  approval: WorkspaceEnvironmentCommandApproval | null = null,
): WorkspaceEnvironmentSetupLaunchSnapshot {
  const snapshot = preparation.kind === "ready" ? preparation.command.snapshot : preparation.snapshot;
  return {
    platform,
    script,
    checkoutPath: snapshot.checkoutPath,
    terminal: snapshot.terminal
      ? { executable: snapshot.terminal.executable, arguments: [...snapshot.terminal.arguments] }
      : null,
    approval,
  };
}

function snapshotForPreparedCommand(
  platform: WorkspaceEnvironmentPlatform,
  script: string,
  command: PreparedTerminalCommand,
  approval: WorkspaceEnvironmentCommandApproval | null = null,
): WorkspaceEnvironmentSetupLaunchSnapshot {
  return {
    platform,
    script,
    checkoutPath: command.snapshot.checkoutPath,
    terminal: command.snapshot.terminal
      ? {
        executable: command.snapshot.terminal.executable,
        arguments: [...command.snapshot.terminal.arguments],
      }
      : null,
    approval,
  };
}

function automaticCompletionResult(completion: TerminalCommandCompletion): {
  readonly state: "passed" | "failed";
  readonly reason: WorkspaceEnvironmentAutomaticSetupReason | null;
  readonly outcome: WorkspaceEnvironmentSetupOutcome;
  readonly exitCode: number | null;
  readonly output: string;
  readonly outputTruncated: boolean;
} {
  if (completion.kind === "exited" && completion.exitCode === 0) {
    return {
      state: "passed",
      reason: null,
      outcome: "success",
      exitCode: completion.exitCode,
      output: completion.output,
      outputTruncated: completion.outputTruncated,
    };
  }
  if (completion.kind === "exited") {
    return {
      state: "failed",
      reason: "setup_failed",
      outcome: "command_failure",
      exitCode: completion.exitCode,
      output: completion.output,
      outputTruncated: completion.outputTruncated,
    };
  }
  if (completion.kind === "timeout") {
    return {
      state: "failed",
      reason: "setup_failed",
      outcome: "timeout",
      exitCode: null,
      output: completion.output,
      outputTruncated: completion.outputTruncated,
    };
  }
  if (completion.kind === "containment_failure") {
    return {
      state: "failed",
      reason: "setup_failed",
      outcome: "containment_failure",
      exitCode: null,
      output: completion.output,
      outputTruncated: completion.outputTruncated,
    };
  }
  return {
    state: "failed",
    reason: "setup_unavailable",
    outcome: "launch_failure",
    exitCode: null,
    output: completion.output,
    outputTruncated: completion.outputTruncated,
  };
}

function freezeSetupAttempt(attempt: WorkspaceEnvironmentSetupAttempt): WorkspaceEnvironmentSetupAttempt {
  return Object.freeze({
    ...attempt,
    snapshot: Object.freeze({
      ...attempt.snapshot,
      terminal: attempt.snapshot.terminal
        ? Object.freeze({
          executable: attempt.snapshot.terminal.executable,
          arguments: Object.freeze([...attempt.snapshot.terminal.arguments]),
        })
        : null,
      approval: attempt.snapshot.approval
        ? Object.freeze({
          target: attempt.snapshot.approval.target.kind === "setup"
            ? Object.freeze({ kind: "setup" as const })
            : Object.freeze({ kind: "action" as const, actionId: attempt.snapshot.approval.target.actionId }),
          fingerprint: attempt.snapshot.approval.fingerprint,
        })
        : null,
    }),
  }) as WorkspaceEnvironmentSetupAttempt;
}
