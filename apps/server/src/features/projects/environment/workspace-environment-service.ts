import { createHash, randomUUID } from "crypto";
import { mkdir, open, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
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
  type WorkspaceEnvironmentAutomaticSetupRepairInput,
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
  type WorkspaceEnvironmentClaimedAutomaticRepair,
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

/** Terminal provider result for one automatic Setup repair Turn. */
export type WorkspaceEnvironmentAutomaticSetupRepairOutcome = "completed" | "failed" | "cancelled" | "interrupted";

/** Accepted repair dispatch whose completion reports the finalized provider Turn outcome. */
export interface WorkspaceEnvironmentAutomaticSetupRepairDispatch {
  readonly completion: Promise<WorkspaceEnvironmentAutomaticSetupRepairOutcome>;
}

/** Immutable repair prompt and execution identity for one failed automatic Setup attempt. */
export interface WorkspaceEnvironmentAutomaticSetupRepairSubmission {
  readonly repairId: string;
  readonly prompt: string;
  readonly checkoutPath: string | null;
  readonly queuedTurn: WorkspaceEnvironmentQueuedTurnSubmission;
}

/** Post-commit boundary that resolves once a claimed queued Turn has started a runtime. */
export interface WorkspaceEnvironmentAutomaticSetupDispatcher {
  dispatch(submission: WorkspaceEnvironmentQueuedTurnSubmission): Promise<WorkspaceEnvironmentAutomaticSetupDispatch>;
  dispatchRepair?(submission: WorkspaceEnvironmentAutomaticSetupRepairSubmission): Promise<WorkspaceEnvironmentAutomaticSetupRepairDispatch>;
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
    readonly kind: "unavailable" | "configuration";
    readonly output: string;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly action: WorkspaceEnvironmentAction | null;
  };

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
  return createHash("sha256")
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
    this.requireAutomaticRepairInactive(input.threadId, repository);
    const current = repository.snapshot(input.threadId);
    if (current.attempt?.state !== "failed" && current.attempt?.state !== "interrupted") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup can continue only after Setup failed or was interrupted",
      );
    }
    if (!repository.continueWithoutSetup(input.threadId)) return repository.snapshot(input.threadId);
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
    if (stopping) {
      await stopping;
      return this.requireAutomaticRepository().snapshot(input.threadId);
    }
    const repository = this.requireAutomaticRepository();
    const attemptId = repository.interruptCurrentAttempt(input.threadId);
    const starting = this.startingAutomaticSetupPromises.get(input.threadId);
    const resource = this.activeAutomaticSetupResources.get(input.threadId);
    const resourceAttemptId = attemptId ?? resource?.attemptId ?? null;
    if (resourceAttemptId && (resource?.attemptId === resourceAttemptId || starting)) {
      const closing = Promise.resolve().then(async () => {
        const closeResource = async (candidate: ActiveAutomaticSetupResource | undefined): Promise<void> => {
          if (!candidate || candidate.attemptId !== resourceAttemptId) return;
          await this.closeActiveAutomaticSetupResource(input.threadId, candidate);
        };
        await closeResource(resource);
        if (starting) {
          await starting.catch((error: unknown) => {
            if (!(error instanceof SetupStartCancelledError)) throw error;
          });
        }
        await closeResource(this.activeAutomaticSetupResources.get(input.threadId));
      });
      this.automaticStopPromises.set(input.threadId, closing);
      let contained = false;
      try {
        await closing;
        contained = true;
      } finally {
        if (contained && this.automaticStopPromises.get(input.threadId) === closing) {
          this.automaticStopPromises.delete(input.threadId);
          this.clearAutomaticRecoveryGeneration(input.threadId);
        }
      }
    }
    this.clearAutomaticRecoveryGeneration(input.threadId);
    return repository.snapshot(input.threadId);
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
      this.requireAutomaticRepairInactive(input.threadId, this.requireAutomaticRepository());
      this.requireAutomaticResourceReleased(input.threadId);
      if (this.requireAutomaticRepository().retryCurrentAttempt(input.threadId)) {
        await this.startAutomaticSetup(thread);
        this.requireAutomaticSetupThread(input.threadId);
      }
      return this.requireAutomaticRepository().snapshot(input.threadId);
    });
  }

  /** Start one provider repair Turn for the current failed automatic Setup attempt. */
  async repairAutomaticSetup(input: WorkspaceEnvironmentAutomaticSetupRepairInput): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    return await this.runAutomaticRecoveryOperation(input.threadId, async () => {
      const thread = this.requireAutomaticSetupThread(input.threadId);
      this.requireAutomaticResourceReleased(thread.id);
      const dispatcher = this.automaticDispatcher;
      if (!dispatcher?.dispatchRepair) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
          "Automatic Setup repair is unavailable for this Thread",
        );
      }
      const repository = this.requireAutomaticRepository();
      const repair = repository.claimRepair({ threadId: thread.id, repairId: this.createAttemptId() });
      if (!repair) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
          "Automatic Setup repair requires one current failed Setup attempt",
        );
      }
      let dispatch: WorkspaceEnvironmentAutomaticSetupRepairDispatch;
      try {
        dispatch = await dispatcher.dispatchRepair({
          repairId: repair.id,
          prompt: automaticRepairPrompt(repair),
          checkoutPath: repair.failure.snapshot.checkoutPath,
          queuedTurn: repair.submission,
        });
      } catch (error) {
        repository.finishRepair(repair.id, "failed");
        throw error;
      }
      void dispatch.completion.then(
        (outcome) => this.completeAutomaticRepair(thread, repair.id, outcome),
        () => { repository.finishRepair(repair.id, "failed"); },
      );
      return repository.snapshot(thread.id);
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
    return join(this.mcodeDir, "projects", workspaceId, "environment.json");
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
    return join(this.requireWorkspace(workspaceId).path, ".mcode", "environment.json");
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
    return join(checkoutPath, ".mcode", "environment.json");
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
    const storageMode = workspace && await this.hasValidSharedDocument(join(workspace.path, ".mcode", "environment.json"))
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
    const platform = this.options.platform ?? platformForCurrentProcess();
    const environment = await this.readForThread(thread);
    if (canContinue && !canContinue()) throw new SetupStartCancelledError();
    const action = target.kind === "action"
      ? environment.document.actions.find((candidate) => candidate.id === target.actionId) ?? null
      : null;
    if (target.kind === "action" && !action) {
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND", "Project Action not found");
    }
    const command = target.kind === "setup" ? environment.document.setup : action?.command;
    const script = command ? selectWorkspaceEnvironmentScript(command, platform) : null;
    if (!script) {
      return {
        kind: "unavailable",
        output: "This Project command is not available on this system",
        snapshot: unavailableSnapshot(platform, null),
        action,
      };
    }
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Project command execution is unavailable for this Thread",
      );
    }
    const preparation = await terminalCommands.prepare({
      scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
      script,
      timeoutMs: this.options.manualSetupTimeoutMs ?? DEFAULT_MANUAL_SETUP_TIMEOUT_MS,
      outputMaxBytes: WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
    });
    if (canContinue && !canContinue()) {
      if (preparation.kind === "ready") await this.closeUnstartedCommand(preparation.command);
      throw new SetupStartCancelledError();
    }
    if (preparation.kind !== "ready") {
      return {
        kind: preparation.kind,
        output: preparation.output,
        snapshot: snapshotForPreparation(platform, script, preparation, null, environment.revision),
        action,
      };
    }
    const approval = environment.storageMode === "shared"
      ? this.pendingApproval(thread.workspace_id, target, platform, script, preparation.command.snapshot)
      : null;
    return {
      kind: "ready",
      command: preparation.command,
      script,
      snapshot: snapshotForPreparation(platform, script, preparation, approval, environment.revision),
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
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, "r");
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

    return this.enqueueSave(input.workspaceId, async () => {
      const current = await this.read(input.workspaceId, input.threadId);
      if (current.revision !== input.sourceRevision) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_STALE",
          "Workspace environment changed since it was loaded",
        );
      }

      const thread = input.threadId ? this.requireSetupThread(input.threadId) : null;
      if (thread && thread.workspace_id !== input.workspaceId) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_NOT_FOUND",
          "Thread does not belong to this Project",
        );
      }
      const filePath = thread
        ? this.filePathForThread(thread, current.storageMode ?? "system")
        : this.filePathForWorkspace(input.workspaceId, current.storageMode ?? "system");
      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.environment.${randomUUID()}.tmp`);
      const encoded = new TextEncoder().encode(JSON.stringify(parsed.data));
      try {
        await writeFile(temporaryPath, encoded);
        await rename(temporaryPath, filePath);
      } catch (error) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Cleanup is limited to this operation's own temporary file.
        }
        throw error;
      }

      return {
        document: parsed.data,
        revision: revisionFor(encoded, current.storageMode ?? "system", filePath),
        status: "present",
        storageMode: current.storageMode,
      };
    });
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
    const threadIds = new Set<string>();
    for (const threadId of [
      ...this.activeAutomaticSetupResources.keys(),
      ...this.startingAutomaticSetupPromises.keys(),
      ...this.automaticDrainLoops.keys(),
    ]) {
      if (this.options.threads?.findById(threadId)?.workspace_id === workspaceId) threadIds.add(threadId);
    }
    for (const [threadId, resource] of this.activeSetupResources) {
      if (resource.attempt.workspaceId === workspaceId) threadIds.add(threadId);
    }
    for (const [threadId, attempt] of this.latestSetupAttempts) {
      if (attempt.workspaceId === workspaceId) threadIds.add(threadId);
    }
    for (const [threadId, starting] of this.startingSetupAttempts) {
      if (starting.workspaceId === workspaceId) threadIds.add(threadId);
    }
    const results = await Promise.allSettled([...threadIds].map((threadId) => this.cancelSetupForThread(threadId)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
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
    const results = await Promise.allSettled(
      [...new Set([
        ...this.activeSetupResources.keys(),
        ...this.startingSetupAttempts.keys(),
      ])].map((threadId) => this.cancelSetupForThread(threadId)),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    this.latestSetupAttempts.clear();
    this.completedSetupThreadIds.splice(0);
    if (this.startingSetupAttempts.size === 0) this.setupGenerations.clear();
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

  private async completeAutomaticRepair(
    thread: WorkspaceEnvironmentSetupThread,
    repairId: string,
    outcome: WorkspaceEnvironmentAutomaticSetupRepairOutcome,
  ): Promise<void> {
    const repository = this.requireAutomaticRepository();
    if (outcome !== "completed") {
      repository.finishRepair(repairId, outcome);
      return;
    }
    const rerun = repository.queueRepairRerun(repairId);
    if (!rerun?.queued) return;
    try {
      await this.startAutomaticSetup(thread);
    } catch {
      repository.interruptCurrentAttempt(thread.id);
    }
  }

  private async startAutomaticSetupAttempt(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    const repository = this.requireAutomaticRepository();
    const snapshot = repository.snapshot(thread.id);
    if (snapshot.attempt?.state !== "queued") return;
    const queuedAttemptId = snapshot.attempt.id;
    const platform = this.options.platform ?? platformForCurrentProcess();
    let script: string | null;
    let storageMode: WorkspaceEnvironmentStorageMode;
    let sourceRevision: string | null = null;
    try {
      const environment = await this.readForThread(thread);
      script = environment.document.setup ? selectWorkspaceEnvironmentScript(environment.document.setup, platform) : null;
      storageMode = environment.storageMode ?? "system";
      sourceRevision = environment.revision;
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentServiceError) {
        repository.failQueuedAttempt({
          threadId: thread.id,
          attemptId: queuedAttemptId,
          reason: "setup_configuration_invalid",
          snapshot: unavailableSnapshot(platform, null),
          outcome: "configuration_failure",
        });
        return;
      }
      repository.failQueuedAttempt({
        threadId: thread.id,
        attemptId: queuedAttemptId,
        reason: "setup_unavailable",
        snapshot: unavailableSnapshot(platform, null),
        outcome: "unavailable",
      });
      return;
    }
    if (!this.isAutomaticAttemptQueued(repository, thread.id, queuedAttemptId)
      || !this.isAutomaticSetupAdmissionAllowed(thread.id)) return;
    if (!script) {
      repository.releaseWithoutSetup(thread.id, queuedAttemptId);
      await this.drainReleasedAutomaticTurn(thread.id);
      return;
    }
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      repository.failQueuedAttempt({
        threadId: thread.id,
        attemptId: queuedAttemptId,
        reason: "setup_unavailable",
        snapshot: unavailableSnapshot(platform, script),
        outcome: "unavailable",
      });
      return;
    }
    let preparation: TerminalCommandPreparation;
    try {
      preparation = await terminalCommands.prepare({
        scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
        script,
        timeoutMs: this.options.manualSetupTimeoutMs ?? DEFAULT_MANUAL_SETUP_TIMEOUT_MS,
        outputMaxBytes: WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
      });
    } catch {
      repository.failQueuedAttempt({
        threadId: thread.id,
        attemptId: queuedAttemptId,
        reason: "setup_unavailable",
        snapshot: unavailableSnapshot(platform, script),
        outcome: "launch_failure",
      });
      return;
    }
    if (preparation.kind !== "ready") {
      repository.failQueuedAttempt({
        threadId: thread.id,
        attemptId: queuedAttemptId,
        reason: preparation.kind === "unavailable" ? "setup_unavailable" : "setup_configuration_invalid",
        snapshot: snapshotForPreparation(platform, script, preparation, null, sourceRevision),
        outcome: preparation.kind === "unavailable" ? "unavailable" : "configuration_failure",
      });
      return;
    }
    const approval = storageMode === "shared"
      ? this.pendingApproval(
        thread.workspace_id,
        { kind: "setup" },
        platform,
        script,
        preparation.command.snapshot,
      )
      : null;
    if (approval) {
      await this.closeUnstartedCommand(preparation.command);
      repository.awaitApproval({
        threadId: thread.id,
        attemptId: queuedAttemptId,
        snapshot: snapshotForPreparation(platform, script, preparation, approval, sourceRevision),
      });
      return;
    }
    if (!this.isAutomaticSetupAdmissionAllowed(thread.id)) {
      await this.closeUnstartedCommand(preparation.command);
      return;
    }
    const attemptId = repository.beginAttempt({
      threadId: thread.id,
      attemptId: queuedAttemptId,
      snapshot: snapshotForPreparation(platform, script, preparation, null, sourceRevision),
    });
    if (!attemptId) {
      await this.closeUnstartedCommand(preparation.command);
      return;
    }
    const resource: ActiveAutomaticSetupResource = { attemptId, command: preparation.command, cleanupPending: false };
    this.activeAutomaticSetupResources.set(thread.id, resource);
    void preparation.command.waitForRelease().then(() => {
      if (this.activeAutomaticSetupResources.get(thread.id) === resource) {
        this.activeAutomaticSetupResources.delete(thread.id);
        this.automaticStopPromises.delete(thread.id);
        this.clearAutomaticRecoveryGeneration(thread.id);
      }
    });
    void Promise.resolve()
      .then(() => preparation.command.start())
      .then(async (completion) => {
        const result = automaticCompletionResult(completion);
        const completed = repository.completeAttempt({
          threadId: thread.id,
          attemptId,
          ...result,
        });
        if (result.outcome === "containment_failure" && this.activeAutomaticSetupResources.get(thread.id) === resource) {
          resource.cleanupPending = true;
        }
        if (completed && result.state === "passed") await this.drainReleasedAutomaticTurn(thread.id);
      })
      .catch(async () => {
        repository.completeAttempt({
          threadId: thread.id,
          attemptId,
          state: "failed",
          reason: "setup_unavailable",
          outcome: "launch_failure",
          exitCode: null,
          output: "",
          outputTruncated: false,
        });
      });
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
      [...this.activeAutomaticSetupResources.entries()].map(async ([threadId, resource]) =>
        await this.closeActiveAutomaticSetupResource(threadId, resource)),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    this.activeAutomaticSetupResources.clear();
    await Promise.allSettled([...this.automaticDrainLoops.values()]);
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

  private requireAutomaticRepairInactive(
    threadId: string,
    repository: WorkspaceEnvironmentAutomaticRepository,
  ): void {
    if (repository.hasActiveRepair(threadId)) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup recovery is unavailable while its agent repair is active",
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
    const platform = this.options.platform ?? platformForCurrentProcess();
    let resolved: WorkspaceEnvironmentCommandResolution;
    try {
      resolved = await this.resolveCommand(thread, { kind: "setup" }, () => this.isStartCurrent(thread.id, generation));
    } catch (error) {
      this.ensureStartCurrent(thread.id, generation);
      if (
        error instanceof WorkspaceEnvironmentServiceError &&
        (error.code === "WORKSPACE_ENVIRONMENT_VALIDATION" ||
          error.code === "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION")
      ) {
        return this.recordFinishedAttempt({
          threadId: thread.id,
          workspaceId: thread.workspace_id,
          status: "failed",
          outcome: "configuration_failure",
          snapshot: unavailableSnapshot(platform, null),
          startedAt: null,
          exitCode: null,
          output: "Project Setup configuration is invalid",
          outputTruncated: false,
        });
      }
      throw error;
    }
    this.ensureStartCurrent(thread.id, generation);
    if (resolved.kind === "unavailable") {
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
    if (!this.isStartCurrent(thread.id, generation)) {
      if (resolved.kind === "ready") await this.closeUnstartedCommand(resolved.command);
      throw new SetupStartCancelledError();
    }
    if (resolved.kind !== "ready") {
      return this.recordFinishedAttempt({
        threadId: thread.id,
        workspaceId: thread.workspace_id,
        status: "failed",
        outcome: "configuration_failure",
        snapshot: resolved.snapshot,
        startedAt: null,
        exitCode: null,
        output: resolved.output,
        outputTruncated: false,
      });
    }
    const ready = resolved;
    if (ready.approval) {
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
    void Promise.resolve()
      .then(() => ready.command.start())
      .then((completion) => this.finishRunningAttempt(running, completion))
      .catch(() => this.finishRunningAttempt(running, {
        kind: "launch_failure",
        output: "The Terminal could not launch Setup",
        outputTruncated: false,
      }));
    return running;
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
    const result = completion.kind === "exited"
      ? completion.exitCode === 0
        ? { status: "passed" as const, outcome: "success" as const, exitCode: completion.exitCode }
        : { status: "failed" as const, outcome: "command_failure" as const, exitCode: completion.exitCode }
      : completion.kind === "timeout"
        ? { status: "failed" as const, outcome: "timeout" as const, exitCode: null }
        : completion.kind === "containment_failure"
          ? { status: "failed" as const, outcome: "containment_failure" as const, exitCode: null }
        : { status: "failed" as const, outcome: "launch_failure" as const, exitCode: null };
    const completed = freezeSetupAttempt({
      ...current,
      ...result,
      finishedAt: this.now(),
      output: completion.output,
      outputTruncated: completion.outputTruncated,
      cleanupPending: completion.kind === "containment_failure",
    });
    this.latestSetupAttempts.set(completed.threadId, completed);
    if (completion.kind === "containment_failure" && active) {
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
    return (this.options.createAttemptId ?? randomUUID)();
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
  return createHash("sha256").update(JSON.stringify({
    contractVersion: WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION,
    projectIdentity: input.workspaceId,
    commandIdentity: commandIdentity(input.target),
    operatingSystem: input.platform,
    resolvedScript: normalizeLineEndings(input.script),
    terminalExecutable: input.terminal.executable,
    terminalArguments: input.terminal.arguments.map(normalizeLineEndings),
  })).digest("hex");
}

function platformForCurrentProcess(): WorkspaceEnvironmentPlatform {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
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
  sourceRevision: string | null = null,
): WorkspaceEnvironmentSetupLaunchSnapshot {
  const snapshot = preparation.kind === "ready" ? preparation.command.snapshot : preparation.snapshot;
  return {
    platform,
    script,
    sourceRevision,
    checkoutPath: snapshot.checkoutPath,
    terminal: snapshot.terminal
      ? { executable: snapshot.terminal.executable, arguments: [...snapshot.terminal.arguments] }
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

function automaticRepairPrompt(repair: WorkspaceEnvironmentClaimedAutomaticRepair): string {
  const failure = repair.failure;
  return [
    "Repair the failed Project Setup before the queued user Turn runs.",
    "",
    `Setup attempt: ${failure.attemptId}`,
    `Configuration revision: ${failure.snapshot.sourceRevision ?? "none"}`,
    `Command: ${failure.snapshot.script ?? "none"}`,
    `Checkout: ${failure.snapshot.checkoutPath ?? "none"}`,
    `Outcome: ${failure.outcome}`,
    `Exit code: ${failure.exitCode ?? "none"}`,
    `Output truncated: ${failure.outputTruncated ? "yes" : "no"}`,
    "",
    "Setup output:",
    failure.output,
    "",
    "Do not run Setup yourself. The app will rerun it after this repair Turn completes.",
  ].join("\n");
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
