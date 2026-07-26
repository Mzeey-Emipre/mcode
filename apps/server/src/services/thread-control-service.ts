import { randomUUID } from "node:crypto";
import { logger } from "@mcode/shared";
import {
  type IProviderRegistry,
  type PermissionDecision,
  type PermissionRequest,
  type ProviderId,
  type ResolvedExecution,
  type ResolvedPlacement,
  type ThreadCreateBatchInput,
  type ThreadCreateBatchResult,
  type ThreadCreateInput,
  type ThreadCreateItemResult,
  type ThreadControlError,
  type WorkspaceSearchInput,
  type WorkspaceSearchResult,
  type WorktreeListInput,
  type WorktreeListResult,
  ThreadCreateBatchInputSchema,
} from "@mcode/contracts";
import type {
  ExternalThreadControlAuthority,
  InternalThreadControlAuthority,
  ThreadControlAuthority,
} from "@mcode/thread-orchestration";
export type {
  ExternalThreadControlAuthority,
  InternalThreadControlAuthority,
  ThreadControlAuthority,
} from "@mcode/thread-orchestration";
import { delay, inject, injectable } from "tsyringe";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { WorktreeRepo, type InternalRegisteredWorktree } from "../repositories/worktree-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { ThreadControlApprovalRepo } from "../repositories/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../repositories/thread-control-audit-repo.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { AgentService } from "./agent-service.js";
import { GitService } from "./git-service.js";
import { ModelCacheService } from "./model-cache-service.js";
import { SettingsService } from "./settings-service.js";
import { ThreadService } from "./thread-service.js";
import { broadcast } from "../transport/push.js";

/** Git operations required by thread-control discovery and placement. */
export interface ThreadControlGitDiscovery {
  listWorktrees(workspaceId: string): Promise<Array<{ name: string; path: string; branch: string; managed: boolean }>>;
  getCurrentBranch(workspaceId: string): Promise<string | null>;
}

/** Sole server authority boundary for internal thread-control operations. */
@injectable()
export class ThreadControlService {
  private capacityTail: Promise<void> = Promise.resolve();
  private readonly externalReservations = new Map<string, number>();

  constructor(
    @inject(WorkspaceRepo) private readonly workspaces: WorkspaceRepo,
    @inject(WorktreeRepo) private readonly worktrees: WorktreeRepo,
    @inject(GitService) private readonly git: ThreadControlGitDiscovery,
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(ThreadService) private readonly threadService: ThreadService,
    @inject(delay(() => AgentService)) private readonly agentService: AgentService,
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject(delay(() => ProviderRegistry)) private readonly providers: IProviderRegistry,
    @inject(delay(() => ModelCacheService)) private readonly models: ModelCacheService,
    @inject(ThreadControlApprovalRepo) private readonly approvals: ThreadControlApprovalRepo,
    @inject(ThreadControlAuditRepo) private readonly audit: ThreadControlAuditRepo,
  ) {}

  /** Search only registered workspaces; authority is intentionally not tool input. */
  workspaceSearch(_authority: InternalThreadControlAuthority, input: WorkspaceSearchInput): WorkspaceSearchResult {
    const query = input.query?.trim() ?? "";
    return {
      workspaces: this.workspaces.search(query, input.limit).map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        ...(workspace.last_opened_at ? { lastUsedAt: new Date(workspace.last_opened_at).toISOString() } : {}),
      })),
    };
  }

  /** Revalidate workspace registration and return only opaque worktree identities. */
  async worktreeList(authority: InternalThreadControlAuthority, input: WorktreeListInput): Promise<WorktreeListResult> {
    void authority;
    if (!this.workspaces.findById(input.workspaceId)) {
      return { status: "rejected", error: this.error("not_found", "Workspace not found", false) };
    }
    const discovered = await this.git.listWorktrees(input.workspaceId);
    const worktrees = this.worktrees.reconcile(input.workspaceId, discovered.map((worktree) => ({
      canonicalPath: worktree.path,
      label: worktree.name,
      branch: worktree.branch || undefined,
      managed: worktree.managed,
    })));
    return { status: "found", workspaceId: input.workspaceId, worktrees };
  }

  /** Create one to twenty independent delegated threads while preserving input order. */
  async threadCreateBatch(
    authority: ThreadControlAuthority,
    input: ThreadCreateBatchInput,
  ): Promise<ThreadCreateBatchResult> {
    const validatedInput = ThreadCreateBatchInputSchema().parse(input);
    const reservations = authority.type === "external"
      ? await this.reserveExternalCapacity(authority, validatedInput)
      : validatedInput.items.map(() => false);
    const results: ThreadCreateItemResult[] = [];
    for (let index = 0; index < validatedInput.items.length; index += 1) {
      if (
        authority.type === "external"
        && this.externalItemCanCreate(authority, validatedInput.items[index]!)
        && !reservations[index]
      ) {
        const result: ThreadCreateItemResult = {
          index,
          status: "rejected",
          workspaceId: validatedInput.items[index]!.workspaceId,
          error: this.error("limit_exceeded", "External active-thread limit reached", true),
        };
        this.auditCreateResult(authority, result);
        results.push(result);
        continue;
      }
      try {
        const result = await this.createOne(authority, validatedInput.items[index]!, index);
        this.auditCreateResult(authority, result);
        results.push(result);
      } finally {
        if (authority.type === "external" && reservations[index]) {
          await this.releaseExternalReservation(authority.integrationId);
        }
      }
    }
    return { results };
  }

  /** Resolve a durable delegated-thread approval before provider permission handlers. */
  async respondToApproval(requestId: string, decision: PermissionDecision): Promise<boolean> {
    const pending = this.approvals.claim(requestId);
    if (!pending) return false;

    if (decision === "deny" || decision === "cancelled") {
      this.approvals.settle(requestId, "rejected");
      this.threads.updateStatus(pending.threadId, "errored");
      this.audit.write({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "denied" });
      broadcast("permission.resolved", { requestId, decision });
      broadcast("thread.status", { threadId: pending.threadId, status: "errored" });
      return true;
    }

    try {
      this.requirePhase(requestId, "provisioning");
      const provisioned = await this.threadService.provisionWorktree(
        pending.threadId,
        pending.workspaceId,
        pending.placement,
      );
      this.registerProvisionedWorktree(pending.workspaceId, provisioned, pending.placement);
      this.requirePhase(requestId, "provisioned");
      this.requirePhase(requestId, "dispatching");
      await this.startTurn(
        pending.threadId,
        pending.prompt,
        pending.execution,
        pending.turnId,
      );
      this.requirePhase(requestId, "dispatched");
      this.approvals.settle(requestId, "approved");
      this.audit.write({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "resumed-approved" });
      broadcast("permission.resolved", { requestId, decision });
      return true;
    } catch (error) {
      logger.error("Delegated thread approval failed", {
        approvalId: requestId,
        threadId: pending.threadId,
        error: String(error),
      });
      this.approvals.settle(requestId, "failed");
      this.audit.write({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "resumed-failed" });
      this.threads.updateStatus(pending.threadId, "errored");
      broadcast("permission.resolved", { requestId, decision });
      broadcast("thread.status", { threadId: pending.threadId, status: "errored" });
      return true;
    }
  }

  /** Restore stranded approvals without replaying an ambiguous external side effect. */
  recoverApprovals(): void {
    for (const approval of this.approvals.listProcessing()) {
      if (approval.operationPhase === "pre_provision") {
        if (this.approvals.requeue(approval.approvalId)) {
          this.audit.write({ callerId: approval.callerId, sourceThreadId: approval.sourceThreadId, workspaceId: approval.workspaceId, threadId: approval.threadId, operation: "thread_create_batch", outcome: "recovery-requeued" });
        }
        continue;
      }
      this.approvals.settle(approval.approvalId, "failed");
      this.audit.write({ callerId: approval.callerId, sourceThreadId: approval.sourceThreadId, workspaceId: approval.workspaceId, threadId: approval.threadId, operation: "thread_create_batch", outcome: "recovery-failed" });
      this.threads.updateStatus(approval.threadId, "errored");
      broadcast("thread.status", { threadId: approval.threadId, status: "errored" });
    }
  }

  /** Return durable thread-control approvals for frontend rehydration. */
  listPendingApprovals(threadId: string): PermissionRequest[] {
    return this.approvals.listPendingByThread(threadId).map((approval) => ({
      requestId: approval.approvalId,
      threadId: approval.threadId,
      toolName: "thread_create_batch",
      title: "Create a new worktree",
      input: {
        workspaceId: approval.workspaceId,
        placement: approval.placement,
        execution: approval.execution,
      },
    }));
  }

  private async createOne(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
    index: number,
  ): Promise<ThreadCreateItemResult> {
    if (
      authority.type === "external"
      && (
        !authority.allowedWorkspaceIds.includes(input.workspaceId)
        || !authority.scopes.includes("threads:create")
      )
    ) {
      return {
        index,
        status: "rejected",
        error: this.error("not_found", "Workspace not found", false),
      };
    }
    const workspace = this.workspaces.findById(input.workspaceId);
    if (!workspace) {
      return {
        index,
        status: "rejected",
        error: this.error("not_found", "Workspace not found", false),
      };
    }

    if (
      authority.type === "external"
      && input.placement.type === "new_worktree"
      && !authority.scopes.includes("worktrees:create")
    ) {
      return {
        index,
        status: "rejected",
        workspaceId: input.workspaceId,
        error: this.error("forbidden", "New worktree creation is not permitted", false),
      };
    }

    const execution = await this.resolveExecution(authority, input);
    if ("error" in execution) {
      return { index, status: "rejected", workspaceId: input.workspaceId, error: execution.error };
    }

    let existingWorktree: InternalRegisteredWorktree | null = null;
    if (input.placement.type === "existing_worktree") {
      existingWorktree = this.worktrees.findCurrentById(input.workspaceId, input.placement.worktreeId);
      if (!existingWorktree) {
        return {
          index,
          status: "rejected",
          workspaceId: input.workspaceId,
          error: this.error(
            "invalid_placement",
            "Worktree does not belong to the selected workspace",
            false,
          ),
        };
      }
      if (!this.existingWorktreeBranch(existingWorktree)) {
        return {
          index,
          status: "rejected",
          workspaceId: input.workspaceId,
          error: this.error(
            "invalid_placement",
            "Detached worktree does not have a registered base ref",
            false,
          ),
        };
      }
    }

    let threadId: string | undefined;
    try {
      const persisted = await this.persistThread(input, execution.value, existingWorktree);
      threadId = persisted.threadId;
      if (authority.type === "internal") {
        this.threads.updateDelegationLineage(threadId, {
          coordinatorThreadId: authority.sourceThreadId,
          creatorTurnId: authority.sourceTurnId,
          creatorToolCallId: authority.sourceToolCallId,
          creationKind: "thread_delegation",
        });
      } else {
        this.threads.updateExternalCreator(threadId, authority.integrationId);
      }

      const protectedMutationNeedsApproval =
        authority.type === "internal"
          ? authority.permissionMode === "supervised"
          : execution.value.permissionMode === "supervised";
      if (input.placement.type === "new_worktree" && protectedMutationNeedsApproval) {
        this.threads.updateStatus(threadId, "paused");
        const approvalId = this.approvals.create({
          threadId,
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          execution: execution.value,
          placement: input.placement,
          turnId: randomUUID(),
          callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
          ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
        });
        broadcast("permission.request", {
          requestId: approvalId,
          threadId,
          toolName: "thread_create_batch",
          title: "Create a new worktree",
          input: {
            workspaceId: input.workspaceId,
            placement: input.placement,
            execution: execution.value,
          },
        });
        return {
          index,
          status: "pending_approval",
          workspaceId: input.workspaceId,
          threadId,
          approvalId,
          execution: execution.value,
          requestedPlacement: input.placement,
          state: { status: "waiting_for_approval", approvalId },
        };
      }

      let placement: ResolvedPlacement;
      if (input.placement.type === "new_worktree") {
        const provisioned = await this.threadService.provisionWorktree(
          threadId,
          input.workspaceId,
          input.placement,
        );
        const registered = this.registerProvisionedWorktree(
          input.workspaceId,
          provisioned,
          input.placement,
        );
        placement = {
          ...input.placement,
          worktreeId: registered.worktreeId,
        };
      } else {
        placement = input.placement;
      }

      const turnId = randomUUID();
      await this.startTurn(threadId, input.prompt, execution.value, turnId);
      return {
        index,
        status: "created",
        workspaceId: input.workspaceId,
        threadId,
        turnId,
        execution: execution.value,
        placement,
        state: { status: "starting" },
      };
    } catch {
      if (!threadId) {
        return {
          index,
          status: "rejected",
          workspaceId: input.workspaceId,
          error: this.error("internal_error", "Thread creation failed", true),
        };
      }
      this.threads.updateStatus(threadId, "errored");
      return {
        index,
        status: "failed",
        workspaceId: input.workspaceId,
        threadId,
        error: this.error("internal_error", "Thread creation failed", true),
        state: { status: "failed" },
      };
    }
  }

  private auditCreateResult(authority: ThreadControlAuthority, result: ThreadCreateItemResult): void {
    this.audit.write({
      callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
      workspaceId: result.workspaceId,
      ...("threadId" in result ? { threadId: result.threadId } : {}),
      operation: "thread_create_batch",
      outcome: result.status,
    });
  }

  private async resolveExecution(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
  ): Promise<{ value: ResolvedExecution } | { error: ThreadControlError }> {
    const settings = this.settings.get();
    if (
      authority.type === "external"
      && input.permissionMode === "full"
      && !authority.scopes.includes("execution:full")
    ) {
      return {
        error: this.error("forbidden", "Full execution is not permitted", false),
      };
    }
    const providerId = input.providerId ?? settings.model.defaults.provider;
    try {
      this.providers.resolve(providerId as ProviderId);
    } catch {
      return { error: this.error("invalid_provider", "Provider is not available", false) };
    }

    const modelId = input.modelId ?? settings.model.defaults.id;
    let models;
    try {
      models = await this.models.listModels(providerId);
    } catch {
      return { error: this.error("internal_error", "Provider model discovery failed", true) };
    }
    if (!models.some((model) => model.id === modelId && model.policy?.state !== "disabled")) {
      return {
        error: this.error(
          "invalid_model",
          "Model is not available for the selected provider",
          false,
        ),
      };
    }

    const permissionMode = input.permissionMode ?? (
      authority.type === "external" && !authority.scopes.includes("execution:full")
        ? "supervised"
        : settings.agent.defaults.permission
    );

    return {
      value: {
        providerId,
        modelId,
        permissionMode,
        interactionMode: input.interactionMode ?? "build",
      },
    };
  }

  private async persistThread(
    input: ThreadCreateInput,
    execution: ResolvedExecution,
    existingWorktree: InternalRegisteredWorktree | null,
  ): Promise<{ threadId: string }> {
    let branch: string;
    let mode: "direct" | "worktree";
    let managed = true;
    let checkoutState: "named" | "branchless" = "named";
    let baseBranch: string | null = null;

    if (input.placement.type === "direct") {
      mode = "direct";
      branch = await this.git.getCurrentBranch(input.workspaceId).catch(() => null) ?? "HEAD";
    } else if (input.placement.type === "new_worktree") {
      mode = "worktree";
      branch = input.placement.branchName ?? input.placement.baseRef;
      checkoutState = input.placement.branchName ? "named" : "branchless";
      baseBranch = input.placement.branchName ? null : input.placement.baseRef;
    } else {
      mode = "worktree";
      managed = false;
      branch = this.existingWorktreeBranch(existingWorktree!)!;
      checkoutState = existingWorktree!.branch === "(detached)" ? "branchless" : "named";
      baseBranch = checkoutState === "branchless" ? existingWorktree!.baseRef ?? null : null;
    }

    const thread = this.threads.create(
      input.workspaceId,
      input.title,
      mode,
      branch,
      managed,
      execution.providerId,
      undefined,
      checkoutState,
      baseBranch,
    );
    this.threads.updateModel(thread.id, execution.modelId);
    this.threads.updateSettings(thread.id, {
      permission_mode: execution.permissionMode,
      interaction_mode: execution.interactionMode,
    });
    if (existingWorktree) {
      this.threads.updateWorktreePath(thread.id, existingWorktree.canonicalPath);
    }
    return { threadId: thread.id };
  }

  private existingWorktreeBranch(worktree: InternalRegisteredWorktree): string | undefined {
    return worktree.branch && worktree.branch !== "(detached)"
      ? worktree.branch
      : worktree.baseRef;
  }

  private registerProvisionedWorktree(
    workspaceId: string,
    thread: { id: string; worktree_path?: string | null },
    placement: Extract<ThreadCreateInput["placement"], { type: "new_worktree" }>,
  ) {
    if (!thread.worktree_path) {
      throw new Error("Provisioned worktree path was not persisted");
    }
    return this.worktrees.register(workspaceId, {
      canonicalPath: thread.worktree_path,
      label: placement.branchName ?? placement.baseRef,
      branch: placement.branchName,
      baseRef: placement.branchName ? undefined : placement.baseRef,
      managed: true,
    });
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    execution: ResolvedExecution,
    sourceTurnId: string,
  ): Promise<void> {
    await this.agentService.sendMessage({
      threadId,
      content: prompt,
      provider: execution.providerId as ProviderId,
      model: execution.modelId,
      permissionMode: execution.permissionMode,
      interactionMode: execution.interactionMode,
      sourceTurnId,
    });
  }

  private requirePhase(approvalId: string, phase: "pre_provision" | "provisioning" | "provisioned" | "dispatching" | "dispatched"): void {
    if (!this.approvals.setOperationPhase(approvalId, phase)) {
      throw new Error(`Could not persist approval phase: ${phase}`);
    }
  }

  private error(
    code: ThreadControlError["code"],
    message: string,
    retryable: boolean,
  ): ThreadControlError {
    return { code, message, retryable };
  }

  private externalItemCanCreate(
    authority: ExternalThreadControlAuthority,
    input: ThreadCreateInput,
  ): boolean {
    return authority.allowedWorkspaceIds.includes(input.workspaceId)
      && authority.scopes.includes("threads:create")
      && (
        input.placement.type !== "new_worktree"
        || authority.scopes.includes("worktrees:create")
      );
  }

  private async reserveExternalCapacity(
    authority: ExternalThreadControlAuthority,
    input: ThreadCreateBatchInput,
  ): Promise<boolean[]> {
    return this.withCapacityLock(() => {
      const persisted = this.threads.countActiveByIntegration(authority.integrationId);
      let available = Math.max(
        0,
        authority.limits.maxActiveThreads
          - persisted
          - (this.externalReservations.get(authority.integrationId) ?? 0),
      );
      const reservations = input.items.map((item) => {
        if (!this.externalItemCanCreate(authority, item) || available === 0) return false;
        available -= 1;
        return true;
      });
      const reservedCount = reservations.filter(Boolean).length;
      if (reservedCount > 0) {
        this.externalReservations.set(
          authority.integrationId,
          (this.externalReservations.get(authority.integrationId) ?? 0) + reservedCount,
        );
      }
      return reservations;
    });
  }

  private async releaseExternalReservation(integrationId: string): Promise<void> {
    await this.withCapacityLock(() => {
      const remaining = (this.externalReservations.get(integrationId) ?? 1) - 1;
      if (remaining > 0) this.externalReservations.set(integrationId, remaining);
      else this.externalReservations.delete(integrationId);
    });
  }

  private async withCapacityLock<T>(operation: () => T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.capacityTail;
    this.capacityTail = next;
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}
