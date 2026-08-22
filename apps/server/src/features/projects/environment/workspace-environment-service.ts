import { createHash, randomUUID } from "crypto";
import { mkdir, open, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
  WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
  WorkspaceEnvironmentDocumentSchema,
  workspaceEnvironmentValidationIssues,
  type WorkspaceEnvironmentPlatform,
  type WorkspaceEnvironmentCommand,
  type WorkspaceEnvironmentReadResult,
  type WorkspaceEnvironmentSaveInput,
  type WorkspaceEnvironmentSetupAttempt,
  type WorkspaceEnvironmentSetupGetInput,
  type WorkspaceEnvironmentSetupGetResult,
  type WorkspaceEnvironmentSetupLaunchSnapshot,
  type WorkspaceEnvironmentSetupStartInput,
  type WorkspaceEnvironmentValidationIssue,
  type WorkspaceEnvironmentValidationReason,
} from "@mcode/contracts";
import { getMcodeDir } from "@mcode/shared";
import { ZodError } from "zod";
import type {
  TerminalCommandCompletion,
  TerminalCommandPreparation,
  PreparedTerminalCommand,
} from "../../terminal/commands/terminal-command-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

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
  readonly deleted_at?: string | null;
  readonly cleanup_state?: string | null;
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

/** Dependencies that add transient manual Setup execution to environment persistence. */
export interface WorkspaceEnvironmentServiceOptions {
  readonly mcodeDir?: string;
  readonly threads?: {
    findById(id: string): WorkspaceEnvironmentSetupThread | null;
  };
  readonly terminalCommands?: WorkspaceEnvironmentTerminalCommandExecutor;
  readonly platform?: WorkspaceEnvironmentPlatform;
  readonly manualSetupTimeoutMs?: number;
  readonly setupCancellationWaitMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelScheduled?: (timeout: ReturnType<typeof setTimeout>) => void;
  readonly now?: () => Date;
  readonly createAttemptId?: () => string;
}

function issue(
  path: (string | number)[],
  code: string,
  reason: WorkspaceEnvironmentValidationReason,
  message: string,
): WorkspaceEnvironmentValidationIssue {
  return { path, code, reason, message };
}

function revisionFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  private readonly schedule: NonNullable<WorkspaceEnvironmentServiceOptions["schedule"]>;
  private readonly cancelScheduled: NonNullable<WorkspaceEnvironmentServiceOptions["cancelScheduled"]>;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: string | WorkspaceEnvironmentServiceOptions = getMcodeDir()) {
    this.options = typeof options === "string" ? {} : options;
    this.mcodeDir = typeof options === "string" ? options : options.mcodeDir ?? getMcodeDir();
    this.schedule = this.options.schedule ?? setTimeout;
    this.cancelScheduled = this.options.cancelScheduled ?? clearTimeout;
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

  /** Read and validate the current document, returning an absent default when no file exists. */
  async read(workspaceId: string): Promise<WorkspaceEnvironmentReadResult> {
    const filePath = this.filePath(workspaceId);
    const bounded = await this.readBounded(filePath);
    if (bounded.kind === "absent") {
      return {
        document: DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
        revision: null,
        status: "absent",
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
      revision: revisionFor(bytes),
      status: "present",
    };
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
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
    const filePath = this.filePath(input.workspaceId);
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(input.document);
    if (!parsed.success) throw validationError(parsed.error);

    return this.enqueueSave(input.workspaceId, async () => {
      const current = await this.read(input.workspaceId);
      if (current.revision !== input.sourceRevision) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_STALE",
          "Workspace environment changed since it was loaded",
        );
      }

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
        revision: revisionFor(encoded),
        status: "present",
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
    let environment: WorkspaceEnvironmentReadResult;
    try {
      environment = await this.read(thread.workspace_id);
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
    const script = environment.document.setup
      ? scriptForPlatform(environment.document.setup, platform)
      : null;
    if (!script) {
      return this.recordFinishedAttempt({
        threadId: thread.id,
        workspaceId: thread.workspace_id,
        status: "unavailable",
        outcome: "unavailable",
        snapshot: unavailableSnapshot(platform, null),
        startedAt: null,
        exitCode: null,
        output: "Setup is not available on this system",
        outputTruncated: false,
      });
    }
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      throw new Error("Workspace Environment manual Setup requires the Terminal command service");
    }
    const preparation = await terminalCommands.prepare({
      scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
      script,
      timeoutMs: this.options.manualSetupTimeoutMs ?? DEFAULT_MANUAL_SETUP_TIMEOUT_MS,
      outputMaxBytes: WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES,
    });
    if (!this.isStartCurrent(thread.id, generation)) {
      if (preparation.kind === "ready") await this.closeUnstartedCommand(preparation.command);
      throw new SetupStartCancelledError();
    }
    if (preparation.kind !== "ready") {
      return this.recordFinishedAttempt({
        threadId: thread.id,
        workspaceId: thread.workspace_id,
        status: preparation.kind === "unavailable" ? "unavailable" : "failed",
        outcome: preparation.kind === "unavailable" ? "unavailable" : "configuration_failure",
        snapshot: snapshotForPreparation(platform, script, preparation),
        startedAt: null,
        exitCode: null,
        output: preparation.output,
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
      snapshot: snapshotForPreparation(platform, script, preparation),
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      exitCode: null,
      output: "",
      outputTruncated: false,
      cleanupPending: false,
    });
    this.latestSetupAttempts.set(thread.id, running);
    this.activeSetupResources.set(thread.id, { attempt: running, command: preparation.command });
    void preparation.command.waitForRelease().then(() => this.releaseActiveResource(thread.id, running.id));
    void Promise.resolve()
      .then(() => preparation.command.start())
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

function platformForCurrentProcess(): WorkspaceEnvironmentPlatform {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

function scriptForPlatform(
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
  return { platform, script, checkoutPath: null, terminal: null };
}

function snapshotForPreparation(
  platform: WorkspaceEnvironmentPlatform,
  script: string,
  preparation: TerminalCommandPreparation,
): WorkspaceEnvironmentSetupLaunchSnapshot {
  const snapshot = preparation.kind === "ready" ? preparation.command.snapshot : preparation.snapshot;
  return {
    platform,
    script,
    checkoutPath: snapshot.checkoutPath,
    terminal: snapshot.terminal
      ? { executable: snapshot.terminal.executable, arguments: [...snapshot.terminal.arguments] }
      : null,
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
    }),
  }) as WorkspaceEnvironmentSetupAttempt;
}
