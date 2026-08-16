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
  type ThreadGetInput,
  type ThreadGetResult,
  type ThreadControlReadInput,
  type ThreadControlReadResult,
  type ThreadControlProjection,
  type ThreadControlThreadRef,
  type ThreadControlUserSendInput,
  type ThreadControlUserStopInput,
  type ThreadSendInput,
  type ThreadSendResult,
  type ThreadStopInput,
  type ThreadStopResult,
  type ThreadObservedState,
  type ThreadReadMessage,
  type ThreadSearchInput,
  type ThreadSearchResult,
  type ThreadWaitInput,
  type ThreadWaitResult,
  type ThreadWaitItem,
  type WorkspaceSearchInput,
  type WorkspaceSearchResult,
  type WorktreeListInput,
  type WorktreeListResult,
  type ThreadTargetListResult,
  ThreadCreateBatchInputSchema,
  ThreadGetInputSchema,
  ThreadControlReadInputSchema,
  ThreadControlUserSendInputSchema,
  ThreadControlUserStopInputSchema,
  ThreadSendInputSchema,
  ThreadStopInputSchema,
  ThreadSearchInputSchema,
  ThreadWaitInputSchema,
  ThreadTargetListResultSchema,
  THREAD_GET_TRANSCRIPT_MAX_BYTES,
  THREAD_SEARCH_LIMIT_MAX,
  THREAD_CREATE_TITLE_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
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
import { WorkspaceRepo } from "../../../repositories/workspace-repo.js";
import { WorktreeRepo, type InternalRegisteredWorktree } from "../../../repositories/worktree-repo.js";
import { ThreadRepo } from "../../../repositories/thread-repo.js";
import { MessageRepo, type ThreadControlMessageRecord } from "../../../repositories/message-repo.js";
import {
  ThreadControlApprovalRepo,
  type RecoverableThreadCreateApproval,
  type PendingThreadSendApproval,
  type PendingThreadStopApproval,
} from "../../../repositories/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../../../repositories/thread-control-audit-repo.js";
import { ProviderRegistry } from "../../../providers/provider-registry.js";
import { AgentService } from "../orchestration/agent-service.js";
import {
  ThreadControlMutationReservationService,
  type ThreadMutationReservationState,
} from "../../../services/thread-control-mutation-reservation-service.js";
import { GitService } from "../../../services/git-service.js";
import { ModelCacheService } from "../../../services/model-cache-service.js";
import { SettingsService } from "../../../services/settings-service.js";
import { ThreadService } from "../../../services/thread-service.js";
import { DelegationTargetResolver } from "./delegation-target-resolver.js";
import { broadcast } from "../../../transport/push.js";

const THREAD_WAIT_POLL_INTERVAL_MS = 250;

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
  private readonly mutationReservations: ThreadControlMutationReservationService;

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
    @inject("MessageRepo", { isOptional: true }) private readonly messages?: MessageRepo,
    @inject(ThreadControlMutationReservationService) mutationReservations?: ThreadControlMutationReservationService,
    @inject(delay(() => DelegationTargetResolver), { isOptional: true }) private readonly targetResolver?: DelegationTargetResolver,
  ) {
    this.mutationReservations = mutationReservations ?? new ThreadControlMutationReservationService();
  }

  /** Search registered workspaces within the caller's server-owned authority. */
  workspaceSearch(authority: ThreadControlAuthority, input: WorkspaceSearchInput): WorkspaceSearchResult {
    const query = input.query?.trim() ?? "";
    const searchLimit = authority.type === "external"
      ? Math.max(input.limit, authority.allowedWorkspaceIds.length)
      : input.limit;
    const workspaces = this.workspaces.search(query, searchLimit)
      .filter((workspace) => authority.type === "internal"
        ? true
        : authority.scopes.includes("projects:read") && authority.allowedWorkspaceIds.includes(workspace.id));
    return {
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        ...(workspace.last_opened_at ? { lastUsedAt: new Date(workspace.last_opened_at).toISOString() } : {}),
      })),
    };
  }

  /** Return provider/model targets currently usable for delegated thread creation. */
  async threadTargetList(authority: ThreadControlAuthority): Promise<ThreadTargetListResult> {
    if (authority.type === "external" && !authority.scopes.includes("threads:create")) {
      return { providers: [] };
    }
    const resolver = this.targetResolver ?? new DelegationTargetResolver(this.providers, this.models, this.settings);
    return ThreadTargetListResultSchema().parse(await resolver.listTargets());
  }

  /** Search readable registered Projects using authoritative observed state. */
  threadSearch(
    authority: ThreadControlAuthority,
    input: ThreadSearchInput,
  ): ThreadSearchResult {
    const validated = ThreadSearchInputSchema().parse(input);
    if (validated.workspaceIds && new Set(validated.workspaceIds).size !== validated.workspaceIds.length) {
      throw new Error("workspaceIds must be unique");
    }
    if (validated.statuses && new Set(validated.statuses).size !== validated.statuses.length) {
      throw new Error("statuses must be unique");
    }
    const searchOptions: Parameters<ThreadRepo["search"]>[0] = {
      query: validated.query?.trim() ?? "",
      workspaceIds: validated.workspaceIds,
      excludeThreadId: authority.type === "internal" ? authority.sourceThreadId : undefined,
      limit: 200,
    };
    const ownedIntegrationId = this.readOwnedIntegrationId(authority);
    if (ownedIntegrationId !== undefined) searchOptions.createdByIntegrationId = ownedIntegrationId;
    const rows = this.threads.search(searchOptions).threads;
    const threads = rows
      .filter((thread) => this.canReadThread(authority, thread.id, thread.workspace_id))
      .map((thread) => ({ thread, state: this.observedState(thread) }))
      .filter(({ state }) => !validated.statuses || validated.statuses.some((status) => status === state.status))
      .sort((left, right) => right.thread.updated_at.localeCompare(left.thread.updated_at) || left.thread.id.localeCompare(right.thread.id))
      .slice(0, validated.limit)
      .map(({ thread, state }) => this.threadRef(thread, state));
    this.auditRead(authority, "thread_search", "success");
    return { threads };
  }

  /** Read one bounded transcript window without exposing filesystem metadata. */
  threadGet(
    authority: ThreadControlAuthority,
    input: ThreadGetInput,
  ): ThreadGetResult {
    const validated = ThreadGetInputSchema().parse(input);
    const thread = this.findReadableThread(authority, validated.threadId);
    if (!thread || thread.deleted_at != null || !this.canReadThread(authority, thread.id, thread.workspace_id)) {
      this.auditRead(authority, "thread_get", "not_found");
      return {
        status: "rejected",
        threadId: validated.threadId,
        error: this.error("not_found", "Thread not found", false),
      };
    }
    const state = this.observedState(thread);
    if (!this.messages) {
      return {
        status: "rejected",
        workspaceId: thread.workspace_id,
        threadId: validated.threadId,
        error: this.error("internal_error", "Thread transcript is unavailable", true),
      };
    }
    const transcript = this.messages.listByThreadForThreadControl(
      validated.threadId,
      validated.messageLimit,
      THREAD_GET_TRANSCRIPT_MAX_BYTES,
    );
    const result: ThreadGetResult = {
      status: "found",
      workspaceId: thread.workspace_id,
      thread: this.threadRef(thread, state),
      messages: transcript.messages.map((message) => this.readMessage(message, thread.provider, thread.model)),
      hasMoreMessages: transcript.hasMore,
    };
    this.auditRead(authority, "thread_get", "success", thread.workspace_id, thread.id);
    return result;
  }

  /** Read one canonical user-facing coordination projection by explicit identity. */
  threadControlRead(input: ThreadControlReadInput): ThreadControlReadResult {
    const validated = ThreadControlReadInputSchema().parse(input);
    const identity = validated.identity;
    const thread = this.threads.findById(identity.threadId);
    if (!thread || thread.deleted_at != null || thread.workspace_id !== identity.workspaceId) {
      return {
        status: "rejected",
        identity,
        error: this.error("not_found", "Thread not found", false),
      };
    }

    const projection = this.buildThreadControlProjection(thread, validated.messageLimit);
    return { status: "found", projection };
  }

  /** Send a cross-thread message on behalf of the local human user. */
  async threadControlSend(input: ThreadControlUserSendInput): Promise<ThreadSendResult> {
    const validated = ThreadControlUserSendInputSchema().parse(input);
    const source = this.threads.findById(validated.source.threadId);
    const target = this.threads.findById(validated.target.threadId);
    if (!source || source.deleted_at != null || source.workspace_id !== validated.source.workspaceId) {
      return { status: "rejected", threadId: validated.target.threadId, error: this.error("not_found", "Source thread not found", false) };
    }
    if (!target || target.deleted_at != null || target.workspace_id !== validated.target.workspaceId) {
      return { status: "rejected", threadId: validated.target.threadId, error: this.error("not_found", "Target thread not found", false) };
    }
    const authority: InternalThreadControlAuthority = {
      type: "internal",
      userId: "local-user",
      sourceThreadId: source.id,
      sourceTurnId: randomUUID(),
      sourceToolCallId: "ui-thread-control",
      sourceProviderId: source.provider || "unknown",
      permissionMode: this.resolveInternalPermissionMode(source.permission_mode),
    };
    const result = await this.threadSend(authority, {
      threadId: validated.target.threadId,
      message: validated.message,
      interactionMode: validated.interactionMode,
    });
    this.broadcastControlState(validated.target.workspaceId, validated.target.threadId);
    this.broadcastControlState(validated.source.workspaceId, validated.source.threadId);
    return result;
  }

  /** Stop a destination thread on behalf of the local human user. */
  async threadControlStop(input: ThreadControlUserStopInput): Promise<ThreadStopResult> {
    const validated = ThreadControlUserStopInputSchema().parse(input);
    const source = this.threads.findById(validated.source.threadId);
    const target = this.threads.findById(validated.target.threadId);
    if (!source || source.deleted_at != null || source.workspace_id !== validated.source.workspaceId) {
      return { status: "rejected", threadId: validated.target.threadId, error: this.error("not_found", "Source thread not found", false) };
    }
    if (!target || target.deleted_at != null || target.workspace_id !== validated.target.workspaceId) {
      return { status: "rejected", threadId: validated.target.threadId, error: this.error("not_found", "Target thread not found", false) };
    }
    const authority: InternalThreadControlAuthority = {
      type: "internal",
      userId: "local-user",
      sourceThreadId: source.id,
      sourceTurnId: randomUUID(),
      sourceToolCallId: "ui-thread-control",
      sourceProviderId: source.provider || "unknown",
      permissionMode: this.resolveInternalPermissionMode(source.permission_mode),
    };
    const result = await this.threadStop(authority, { threadId: validated.target.threadId });
    this.broadcastControlState(validated.target.workspaceId, validated.target.threadId);
    this.broadcastControlState(validated.source.workspaceId, validated.source.threadId);
    return result;
  }

  /** Wait until every exact readable target reaches the requested boundary. */
  async threadWait(
    authority: ThreadControlAuthority,
    input: ThreadWaitInput,
    signal?: AbortSignal,
  ): Promise<ThreadWaitResult> {
    const validated = ThreadWaitInputSchema().parse(input);
    if (new Set(validated.threadIds).size !== validated.threadIds.length) {
      throw new Error("threadIds must be unique");
    }
    const targets = validated.threadIds.map((threadId) => this.findReadableThread(authority, threadId));
    if (targets.some((thread) => !thread || thread.deleted_at != null || !this.canReadThread(authority, thread.id, thread.workspace_id))) {
      this.auditRead(authority, "thread_wait", "not_found");
      return { status: "rejected", error: this.error("not_found", "Thread not found", false) };
    }
    const targetThreads = targets as NonNullable<typeof targets[number]>[];
    const readCurrent = (): ThreadWaitItem[] => targetThreads.map((thread) => ({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      state: this.observedState(this.threads.findById(thread.id) ?? thread),
    }));
    const satisfied = (state: ThreadObservedState): boolean => {
      if (validated.until === "terminal") return state.status === "completed" || state.status === "failed" || state.status === "stopped";
      return state.status === "waiting_for_approval" || state.status === "waiting_for_user"
        || state.status === "completed" || state.status === "failed" || state.status === "stopped";
    };
    const timeoutAt = Date.now() + validated.timeoutSeconds * 1000;
    const result = await new Promise<ThreadWaitResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ status: "success", timedOut, results: readCurrent() });
      };
      const onAbort = (): void => finish(true);
      const check = (): void => {
        const current = readCurrent();
        if (current.every((item) => satisfied(item.state))) {
          finish(false);
          return;
        }
        const remaining = timeoutAt - Date.now();
        if (remaining <= 0) {
          finish(true);
          return;
        }
        timer = setTimeout(check, Math.min(THREAD_WAIT_POLL_INTERVAL_MS, remaining));
      };
      if (signal?.aborted) {
        finish(true);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
    if (result.status === "success") this.auditRead(authority, "thread_wait", "success");
    return result;
  }

  /** Revalidate workspace registration and return only opaque worktree identities. */
  async worktreeList(authority: ThreadControlAuthority, input: WorktreeListInput): Promise<WorktreeListResult> {
    if (!this.workspaces.findById(input.workspaceId)
      || (authority.type === "external" && (!authority.allowedWorkspaceIds.includes(input.workspaceId)
        || !authority.scopes.includes("worktrees:read")))) {
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
    const sourceWorkspaceId = authority.type === "internal"
      && validatedInput.items.some((item) => item.workspaceId === undefined)
      ? this.resolveInternalSourceWorkspaceId(authority)
      : undefined;
    const items = validatedInput.items.map((item) => item.workspaceId === undefined && sourceWorkspaceId
      ? { ...item, workspaceId: sourceWorkspaceId }
      : item);
    const normalizedInput = { items };
    const reservations = authority.type === "external"
      ? await this.reserveExternalCapacity(authority, normalizedInput)
      : items.map(() => false);
    const results: ThreadCreateItemResult[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (authority.type === "internal" && item.workspaceId === undefined) {
        const result: ThreadCreateItemResult = {
          index,
          status: "rejected",
          error: this.error("not_found", "Source thread not found", false),
        };
        this.auditCreateResult(authority, result);
        results.push(result);
        continue;
      }
      if (
        authority.type === "external"
        && this.externalItemCanCreate(authority, item)
        && !reservations[index]
      ) {
        const result: ThreadCreateItemResult = {
          index,
          status: "rejected",
          workspaceId: item.workspaceId,
          error: this.error("limit_exceeded", "External active-thread limit reached", true),
        };
        this.auditCreateResult(authority, result);
        results.push(result);
        continue;
      }
      try {
        const result = await this.createOne(authority, item, index);
        this.auditCreateResult(authority, result);
        results.push(result);
        if ("threadId" in result && result.threadId) {
          this.broadcastControlState(result.workspaceId, result.threadId);
        }
      } finally {
        if (authority.type === "external" && reservations[index]) {
          await this.releaseExternalReservation(authority.integrationId);
        }
      }
    }
    return { results };
  }

  /** Send one cross-thread message through the shared agent turn gate. */
  async threadSend(
    authority: ThreadControlAuthority,
    input: ThreadSendInput,
  ): Promise<ThreadSendResult> {
    const validated = ThreadSendInputSchema().parse(input);
    const target = this.findMutableThread(authority, validated.threadId, "send");
    if (!target) {
      this.auditMutation(authority, "thread_send", "not_found", validated.threadId);
      return { status: "rejected", threadId: validated.threadId, error: this.error("not_found", "Thread not found", false) };
    }
    const observed = this.observedState(target);
    if (observed.status === "running" || observed.status === "waiting_for_approval") {
      const error = this.error("thread_busy", "Thread is already running", true);
      this.auditMutation(authority, "thread_send", "thread_busy", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    if (observed.status === "completed" || observed.status === "failed" || observed.status === "stopped") {
      const error = this.error("conflict", "Thread is terminal", false);
      this.auditMutation(authority, "thread_send", "conflict", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    const execution = await this.resolveSendExecution(authority, target, validated);
    if ("error" in execution) {
      this.auditMutation(authority, "thread_send", execution.error.code, target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error: execution.error };
    }
    if (execution.value.permissionMode === "supervised") {
      const reservationToken = this.mutationReservations.reserve(target.id, "pendingApproval");
      if (!reservationToken) {
        const error = this.error("thread_busy", "Thread mutation is already pending", true);
        this.auditMutation(authority, "thread_send", "thread_busy", target.id, target.workspace_id);
        return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
      }
      let approvalId: string;
      try {
        approvalId = this.approvals.createSend({
          approvalId: reservationToken,
          threadId: target.id,
          workspaceId: target.workspace_id,
          message: validated.message,
          execution: execution.value,
          turnId: randomUUID(),
          callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
          ...(authority.type === "internal"
            ? {
                sourceThreadId: authority.sourceThreadId,
                sourceTurnId: authority.sourceTurnId,
                sourceProviderId: authority.sourceProviderId,
              }
            : {}),
        });
      } catch (error) {
        this.mutationReservations.release(target.id, reservationToken);
        this.auditMutation(authority, "thread_send", "internal_error", target.id, target.workspace_id);
        return {
          status: "rejected",
          workspaceId: target.workspace_id,
          threadId: target.id,
          error: this.error("internal_error", "Thread send approval could not be created", true),
        };
      }
      if (approvalId !== reservationToken && !this.mutationReservations.replaceToken(target.id, reservationToken, approvalId)) {
        this.mutationReservations.release(target.id, reservationToken);
        this.auditMutation(authority, "thread_send", "internal_error", target.id, target.workspace_id);
        return {
          status: "rejected",
          workspaceId: target.workspace_id,
          threadId: target.id,
          error: this.error("internal_error", "Thread send reservation could not be retained", true),
        };
      }
      broadcast("permission.request", {
        requestId: approvalId,
        threadId: target.id,
        toolName: "thread_send",
        title: "Send a message to another thread",
        input: { threadId: target.id, message: validated.message, execution: execution.value },
        ownerWorkspaceId: target.workspace_id,
        ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : target.id,
        ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
        operation: "thread_send" as const,
      });
      this.auditMutation(authority, "thread_send", "pending_approval", target.id, target.workspace_id, approvalId);
      return {
        status: "pending_approval",
        workspaceId: target.workspace_id,
        threadId: target.id,
        approvalId,
        state: { status: "waiting_for_approval", approvalId },
      };
    }
    const reservationToken = this.mutationReservations.reserve(target.id, "activeTurn");
    if (!reservationToken) {
      const error = this.error("thread_busy", "Thread mutation is already pending", true);
      this.auditMutation(authority, "thread_send", "thread_busy", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    const turnId = randomUUID();
    try {
      await this.startTurn(target.id, validated.message, execution.value, turnId, authority.type === "internal" ? {
        sourceThreadId: authority.sourceThreadId,
        sourceTurnId: authority.sourceTurnId,
        sourceProviderId: authority.sourceProviderId,
      } : undefined, reservationToken);
    } catch (error) {
      this.mutationReservations.release(target.id, reservationToken);
      const busy = error instanceof Error && /already has an active agent session/.test(error.message);
      const controlError = busy
        ? this.error("thread_busy", "Thread is already running", true)
        : this.error("internal_error", "Thread send failed", true);
      this.auditMutation(authority, "thread_send", controlError.code, target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error: controlError };
    }
    this.auditMutation(authority, "thread_send", "accepted", target.id, target.workspace_id);
    return {
      status: "accepted",
      workspaceId: target.workspace_id,
      threadId: target.id,
      turnId,
      execution: execution.value,
      state: { status: "starting" },
    };
  }

  /** Stop one cross-thread target, using durable approval when supervised. */
  async threadStop(
    authority: ThreadControlAuthority,
    input: ThreadStopInput,
  ): Promise<ThreadStopResult> {
    const validated = ThreadStopInputSchema().parse(input);
    const target = this.findMutableThread(authority, validated.threadId, "stop");
    if (!target) {
      this.auditMutation(authority, "thread_stop", "not_found", validated.threadId);
      return { status: "rejected", threadId: validated.threadId, error: this.error("not_found", "Thread not found", false) };
    }
    const observed = this.observedState(target);
    if (observed.status === "stopped") {
      this.auditMutation(authority, "thread_stop", "accepted", target.id, target.workspace_id);
      return { status: "accepted", workspaceId: target.workspace_id, threadId: target.id, state: { status: "stopped" } };
    }
    if (observed.status === "waiting_for_approval") {
      this.auditMutation(authority, "thread_stop", "thread_busy", target.id, target.workspace_id);
      return {
        status: "rejected",
        workspaceId: target.workspace_id,
        threadId: target.id,
        error: this.error("thread_busy", "Thread mutation is already pending", true),
      };
    }
    if (observed.status === "completed" || observed.status === "failed") {
      const error = this.error("conflict", "Thread is terminal", false);
      this.auditMutation(authority, "thread_stop", "conflict", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    const execution: ResolvedExecution = {
      providerId: target.provider || this.settings.get().model.defaults.provider,
      modelId: target.model || this.settings.get().model.defaults.id,
      permissionMode: authority.type === "internal" ? authority.permissionMode : "supervised",
      interactionMode: "build",
    };
    if (execution.permissionMode === "supervised") {
      const reservationToken = this.mutationReservations.reserve(target.id, "pendingApproval");
      if (!reservationToken) {
        const error = this.error("thread_busy", "Thread mutation is already pending", true);
        this.auditMutation(authority, "thread_stop", "thread_busy", target.id, target.workspace_id);
        return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
      }
      let approvalId: string;
      try {
        approvalId = this.approvals.createStop({
          approvalId: reservationToken,
          threadId: target.id,
          workspaceId: target.workspace_id,
          execution,
          turnId: randomUUID(),
          callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
          ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
        });
      } catch {
        this.mutationReservations.release(target.id, reservationToken);
        this.auditMutation(authority, "thread_stop", "internal_error", target.id, target.workspace_id);
        return {
          status: "rejected",
          workspaceId: target.workspace_id,
          threadId: target.id,
          error: this.error("internal_error", "Thread stop approval could not be created", true),
        };
      }
      if (approvalId !== reservationToken && !this.mutationReservations.replaceToken(target.id, reservationToken, approvalId)) {
        this.mutationReservations.release(target.id, reservationToken);
        this.auditMutation(authority, "thread_stop", "internal_error", target.id, target.workspace_id);
        return {
          status: "rejected",
          workspaceId: target.workspace_id,
          threadId: target.id,
          error: this.error("internal_error", "Thread stop reservation could not be retained", true),
        };
      }
      broadcast("permission.request", {
        requestId: approvalId,
        threadId: target.id,
        toolName: "thread_stop",
        title: "Stop another thread",
        input: { threadId: target.id },
        ownerWorkspaceId: target.workspace_id,
        ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : target.id,
        ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
        operation: "thread_stop" as const,
      });
      this.auditMutation(authority, "thread_stop", "pending_approval", target.id, target.workspace_id, approvalId);
      return { status: "pending_approval", workspaceId: target.workspace_id, threadId: target.id, approvalId, state: { status: "waiting_for_approval", approvalId } };
    }
    const existingReservation = this.mutationReservations.get(target.id);
    const reservationToken = existingReservation?.state === "activeTurn"
      ? existingReservation.token
      : this.mutationReservations.reserve(target.id, "stopping");
    if (!reservationToken) {
      const error = this.error("thread_busy", "Thread mutation is already pending", true);
      this.auditMutation(authority, "thread_stop", "thread_busy", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    if (existingReservation?.state === "activeTurn"
      && !this.mutationReservations.transition(target.id, reservationToken, "activeTurn", "stopping")) {
      const error = this.error("thread_busy", "Thread mutation is already pending", true);
      this.auditMutation(authority, "thread_stop", "thread_busy", target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    try {
      await this.stopTarget(target.id);
      this.mutationReservations.release(target.id, reservationToken);
    } catch {
      this.mutationReservations.release(target.id, reservationToken);
      this.auditMutation(authority, "thread_stop", "internal_error", target.id, target.workspace_id);
      const error = this.error("internal_error", "Thread stop failed", true);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
    }
    this.auditMutation(authority, "thread_stop", "accepted", target.id, target.workspace_id);
    return { status: "accepted", workspaceId: target.workspace_id, threadId: target.id, state: { status: "stopped" } };
  }

  /** Resolve a durable delegated-thread approval before provider permission handlers. */
  async respondToApproval(requestId: string, decision: PermissionDecision): Promise<boolean> {
    const pending = this.approvals.claim(requestId);
    if (!pending) return false;

    if ("operation" in pending && (pending.operation === "thread_send" || pending.operation === "thread_stop")) {
      return this.respondToMutationApproval(pending, decision);
    }

    if (decision === "deny" || decision === "cancelled") {
      this.approvals.settle(requestId, "rejected");
      this.threads.updateStatus(pending.threadId, "errored");
      this.writeAudit(
        { callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "denied" },
        { approvalId: requestId, threadId: pending.threadId },
      );
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
      this.writeAudit(
        { callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "resumed-approved" },
        { approvalId: requestId, threadId: pending.threadId },
      );
      broadcast("permission.resolved", { requestId, decision });
      broadcast("thread.status", { threadId: pending.threadId, status: "active" });
      return true;
    } catch (error) {
      logger.error("Delegated thread approval failed", {
        approvalId: requestId,
        threadId: pending.threadId,
        error: String(error),
      });
      this.approvals.settle(requestId, "failed");
      this.writeAudit(
        { callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation: "thread_create_batch", outcome: "resumed-failed" },
        { approvalId: requestId, threadId: pending.threadId },
      );
      this.threads.updateStatus(pending.threadId, "errored");
      broadcast("permission.resolved", { requestId, decision });
      broadcast("thread.status", { threadId: pending.threadId, status: "errored" });
      return true;
    }
  }

  /** Restore stranded approvals without replaying an ambiguous external side effect. */
  async recoverApprovals(): Promise<void> {
    const pendingApprovals = this.approvals.listPending();
    for (const approval of pendingApprovals) {
      if ("invalid" in approval) {
        logger.error("Thread-control pending approval payload is invalid during recovery", {
          approvalId: approval.approvalId,
          threadId: approval.threadId,
        });
        this.failRecovery(approval);
        continue;
      }
      if (!("operation" in approval) || (approval.operation !== "thread_send" && approval.operation !== "thread_stop")) continue;
      if (!this.mutationReservations.rehydrate(approval.threadId, approval.approvalId)) {
        logger.error("Thread-control pending approval reservation conflict", {
          approvalId: approval.approvalId,
          threadId: approval.threadId,
        });
      }
    }
    for (const approval of this.approvals.listProcessing()) {
      try {
        await this.recoverApproval(approval);
      } catch {
        logger.error("Thread-control approval recovery item failed", {
          approvalId: approval.approvalId,
          threadId: approval.threadId,
        });
        this.failRecovery(approval);
      }
    }
  }

  private canReadThread(authority: ThreadControlAuthority, threadId: string, workspaceId: string): boolean {
    if (!this.workspaces.findById(workspaceId)) return false;
    if (authority.type === "internal") {
      return threadId !== authority.sourceThreadId;
    }
    if (!authority.allowedWorkspaceIds.includes(workspaceId)) return false;
    return authority.scopes.includes("threads:read-project") || authority.scopes.includes("threads:read-owned");
  }

  private readOwnedIntegrationId(authority: ThreadControlAuthority): string | undefined {
    if (authority.type !== "external") return undefined;
    if (authority.scopes.includes("threads:read-project")) return undefined;
    return authority.scopes.includes("threads:read-owned") ? authority.integrationId : undefined;
  }

  private findReadableThread(authority: ThreadControlAuthority, threadId: string) {
    const ownedIntegrationId = this.readOwnedIntegrationId(authority);
    return ownedIntegrationId === undefined
      ? this.threads.findById(threadId)
      : this.threads.findById(threadId, { createdByIntegrationId: ownedIntegrationId });
  }

  private auditRead(
    authority: ThreadControlAuthority,
    operation: "thread_search" | "thread_get" | "thread_wait",
    outcome: string,
    workspaceId?: string,
    threadId?: string,
  ): void {
    this.writeAudit({
      callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(threadId ? { threadId } : {}),
      operation,
      outcome,
    }, threadId ? { threadId } : {});
  }

  private observedState(thread: { id: string; status: string }): ThreadObservedState {
    let pendingApproval: ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>[number] | undefined;
    try {
      pendingApproval = this.approvals.listPendingByThread(thread.id)[0];
    } catch {
      pendingApproval = undefined;
    }
    if (pendingApproval) return { status: "waiting_for_approval", approvalId: pendingApproval.approvalId };
    if (this.agentService.activeThreadIds?.().includes(thread.id)) return { status: "running" };
    switch (thread.status) {
      case "completed": return { status: "completed" };
      case "errored": return { status: "failed" };
      case "interrupted": return { status: "stopped" };
      case "paused": return { status: "waiting_for_user" };
      case "deleted":
      case "archived": return { status: "stopped" };
      case "active": return { status: "idle" };
      default: return { status: "idle" };
    }
  }

  private buildThreadControlProjection(
    thread: {
      id: string;
      workspace_id: string;
      title: string;
      provider: string;
      model: string | null;
      created_at: string;
      updated_at: string;
      status: string;
    },
    messageLimit: number,
  ): ThreadControlProjection {
    const state = this.observedState(thread);
    if (!this.messages) {
      return {
        identity: { workspaceId: thread.workspace_id, threadId: thread.id },
        thread: this.threadRef(thread, state),
        messages: [],
        hasMoreMessages: false,
        relation: null,
        children: [],
        approvals: this.listPendingApprovals(thread.id).slice(0, THREAD_SEARCH_LIMIT_MAX),
      };
    }
    const transcript = this.messages.listByThreadForThreadControl(thread.id, messageLimit, THREAD_GET_TRANSCRIPT_MAX_BYTES);
    const lineage = this.threads.findDelegationLineage(thread.id);
    const relation = lineage?.creationKind && lineage.creatorTurnId && lineage.creatorToolCallId
      ? {
        source: lineage.coordinatorThreadId
          ? this.threadControlRef(this.threads.findById(lineage.coordinatorThreadId))
          : null,
        destination: this.threadControlRef(thread)!,
        creatorTurnId: lineage.creatorTurnId,
        creatorToolCallId: lineage.creatorToolCallId,
        creationKind: "thread_delegation" as const,
      }
      : null;
    const children = this.threads.listDelegationChildren(thread.id).map(({ thread: child, lineage: childLineage }) => ({
      source: this.threadControlRef(thread)!,
      destination: this.threadControlRef(child)!,
      creatorTurnId: childLineage.creatorTurnId!,
      creatorToolCallId: childLineage.creatorToolCallId!,
      creationKind: "thread_delegation" as const,
    }));
    return {
      identity: { workspaceId: thread.workspace_id, threadId: thread.id },
      thread: this.threadRef(thread, state),
      messages: transcript.messages.map((message) => this.readMessage(message, thread.provider, thread.model)),
      hasMoreMessages: transcript.hasMore,
      relation,
      children: children.slice(0, THREAD_SEARCH_LIMIT_MAX),
      approvals: this.listPendingApprovals(thread.id).slice(0, THREAD_SEARCH_LIMIT_MAX),
    };
  }

  private threadControlRef(thread: {
    id: string;
    workspace_id: string;
    title: string;
    provider: string;
    model: string | null;
    created_at: string;
    updated_at: string;
    status: string;
    deleted_at?: string | null;
  } | null): ThreadControlThreadRef | null {
    if (!thread || thread.deleted_at != null) return null;
    const state = this.observedState(thread);
    return {
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      title: thread.title.trim().length === 0 ? "Untitled thread" : thread.title,
      providerId: thread.provider || "unknown",
      modelId: thread.model || "unknown",
      state,
    };
  }

  private broadcastControlState(workspaceId: string, threadId: string): void {
    const thread = this.threads.findById(threadId);
    if (!thread || thread.workspace_id !== workspaceId) return;
    broadcast("thread.controlChanged", {
      workspaceId,
      threadId,
      state: this.observedState(thread),
    });
  }

  private threadRef(thread: {
    id: string;
    workspace_id: string;
    title: string;
    provider: string;
    model: string | null;
    created_at: string;
    updated_at: string;
  }, state: ThreadObservedState) {
    return {
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      title: thread.title.trim().length === 0 ? "Untitled thread" : thread.title,
      providerId: thread.provider || "unknown",
      modelId: thread.model || "unknown",
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      state,
    };
  }

  private readMessage(
    message: ThreadControlMessageRecord,
    threadProvider: string,
    threadModel: string | null,
  ): ThreadReadMessage {
    if (message.role === "assistant") {
      return {
        messageId: message.id,
        role: "assistant",
        content: message.content,
        createdAt: message.timestamp,
        providerId: message.provider || threadProvider || "unknown",
        modelId: message.model || threadModel || "unknown",
      };
    }
    if (message.role === "system") {
      return { messageId: message.id, role: "system", content: message.content, createdAt: message.timestamp };
    }
    const sourceThread = message.sourceThreadId ? this.threads.findById(message.sourceThreadId) : null;
    const sourceWorkspace = sourceThread
      ? (this.workspaces.findByIdIncludeDeleted?.(sourceThread.workspace_id)
        ?? this.workspaces.findById(sourceThread.workspace_id))
      : null;
    const sourceRef = sourceThread ? this.threadRef(sourceThread, this.observedState(sourceThread)) : null;
    const boundedSourceRef = sourceRef
      ? { ...sourceRef, title: sourceRef.title.slice(0, THREAD_CREATE_TITLE_MAX_LENGTH) }
      : null;
    const sourceWorkspaceName = sourceWorkspace?.name.trim().slice(0, WORKSPACE_SEARCH_QUERY_MAX_LENGTH) || "Unavailable Project";
    const sourceUnavailable = !sourceThread
      || !sourceWorkspace
      || sourceThread.deleted_at != null
      || sourceWorkspace.deleted_at != null;
    const origin = message.originType === "thread"
      && message.sourceThreadId && message.sourceTurnId && message.sourceProviderId
      ? {
          type: "thread" as const,
          sourceThreadId: message.sourceThreadId,
          sourceTurnId: message.sourceTurnId,
          sourceProviderId: message.sourceProviderId,
          sourceWorkspaceId: sourceThread?.workspace_id ?? null,
          sourceWorkspaceName,
          sourceThread: boundedSourceRef,
          sourceUnavailable,
        }
      : message.originType === "composer"
        ? { type: "composer" as const }
        : { type: "legacy" as const };
    return {
      messageId: message.id,
      role: "user",
      content: message.content,
      createdAt: message.timestamp,
      origin,
    };
  }

  private async recoverApproval(approval: RecoverableThreadCreateApproval): Promise<void> {
    if ("invalid" in approval) {
      logger.error("Thread-control approval payload is invalid during recovery", {
        approvalId: approval.approvalId,
        threadId: approval.threadId,
      });
      this.failRecovery(approval);
      return;
    }
    if ("operation" in approval && (approval.operation === "thread_send" || approval.operation === "thread_stop")) {
      if (approval.operationPhase === "pre_dispatch" && this.approvals.requeueDispatch(approval.approvalId)) {
        const rehydrated = this.mutationReservations.rehydrate(approval.threadId, approval.approvalId);
        if (!rehydrated) {
          logger.error("Thread-control processing approval reservation conflict", {
            approvalId: approval.approvalId,
            threadId: approval.threadId,
          });
        }
        this.writeRecoveryAudit(approval, "recovery-requeued");
      } else {
        this.failRecovery(approval);
      }
      return;
    }
    if (approval.operationPhase === "pre_provision") {
      if (!this.approvals.requeue(approval.approvalId)) {
        this.failRecovery(approval);
        return;
      }
      this.writeRecoveryAudit(approval, "recovery-requeued");
      return;
    }
    if (approval.operationPhase === "provisioning") {
      const cleaned = await this.threadService.cleanupInterruptedProvisioning(
        approval.threadId,
        approval.workspaceId,
        approval.placement,
      );
      if (!cleaned) {
        this.failRecovery(approval);
        return;
      }
      if (
        this.threads.clearWorktreePath(approval.threadId)
        && this.threads.updateStatus(approval.threadId, "paused")
        && this.approvals.requeueRecoveredProvisioning(approval.approvalId)
      ) {
        this.writeRecoveryAudit(approval, "recovery-requeued");
      } else {
        this.failRecovery(approval);
      }
      return;
    }
    this.failRecovery(approval);
  }

  /** Return durable thread-control approvals for frontend rehydration. */
  listPendingApprovals(threadId: string): PermissionRequest[] {
    const byTarget = this.approvals.listPendingByThread(threadId);
    const bySource = this.approvals.listPendingBySourceThread?.(threadId) ?? [];
    const seen = new Set<string>();
    return [...byTarget, ...bySource].filter((approval) => {
      if (seen.has(approval.approvalId)) return false;
      seen.add(approval.approvalId);
      return true;
    }).map((approval) => {
      const ownerThread = approval.sourceThreadId
        ? this.threads.findById(approval.sourceThreadId)
        : null;
      const ownerWorkspaceId = ownerThread?.workspace_id ?? approval.workspaceId;
      const ownerThreadId = ownerThread?.id ?? approval.threadId;
      if ("operation" in approval && approval.operation === "thread_send") {
        return {
          requestId: approval.approvalId,
          threadId: approval.threadId,
          toolName: "thread_send",
          title: "Send a message to another thread",
          input: { threadId: approval.threadId, message: approval.message, execution: approval.execution },
          ownerWorkspaceId,
          ownerThreadId,
          ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}),
          operation: approval.operation,
        };
      }
      if ("operation" in approval && approval.operation === "thread_stop") {
        return {
          requestId: approval.approvalId,
          threadId: approval.threadId,
          toolName: "thread_stop",
          title: "Stop another thread",
          input: { threadId: approval.threadId },
          ownerWorkspaceId,
          ownerThreadId,
          ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}),
          operation: approval.operation,
        };
      }
      return {
        requestId: approval.approvalId,
        threadId: approval.threadId,
        toolName: "thread_create_batch",
        title: "Create a new worktree",
        input: {
          workspaceId: approval.workspaceId,
          placement: approval.placement,
          execution: approval.execution,
        },
        ownerWorkspaceId,
        ownerThreadId,
        ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}),
        operation: approval.operation,
      };
    });
  }

  private async createOne(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
    index: number,
  ): Promise<ThreadCreateItemResult> {
    if (
      input.workspaceId === undefined
      || (
      authority.type === "external"
      && (
        !authority.allowedWorkspaceIds.includes(input.workspaceId)
        || !authority.scopes.includes("threads:create")
      )
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
      const persisted = await this.persistThread(
        input as ThreadCreateInput & { workspaceId: string },
        execution.value,
        existingWorktree,
      );
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
          ownerWorkspaceId: input.workspaceId,
          ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : threadId,
          ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
          operation: "thread_create_batch" as const,
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
    const threadId = "threadId" in result ? result.threadId : undefined;
    this.writeAudit(
      {
        callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
        ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
        workspaceId: result.workspaceId,
        ...(threadId ? { threadId } : {}),
        operation: "thread_create_batch",
        outcome: result.status,
      },
      threadId ? { threadId } : {},
    );
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
    const resolver = this.targetResolver ?? new DelegationTargetResolver(this.providers, this.models, this.settings);
    const target = await resolver.resolve(input);
    if (target.status !== "resolved") {
      if (target.status === "invalid_provider") {
        return { error: this.error("invalid_provider", "Provider is not available", false) };
      }
      if (target.status === "model_required") {
        return { error: this.error("invalid_model", "A model is required when selecting a provider", false) };
      }
      if (target.status === "discovery_failed") {
        return { error: this.error("internal_error", "Provider model discovery failed", true) };
      }
      return { error: this.error("invalid_model", "Model is not available for the selected provider", false) };
    }

    const permissionMode = input.permissionMode ?? (
      authority.type === "external" && !authority.scopes.includes("execution:full")
        ? "supervised"
        : settings.agent.defaults.permission
    );

    return {
      value: {
        providerId: target.providerId,
        modelId: target.modelId,
        permissionMode,
        interactionMode: input.interactionMode ?? "build",
      },
    };
  }

  private async persistThread(
    input: ThreadCreateInput & { workspaceId: string },
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
    origin?: { sourceThreadId: string; sourceTurnId: string; sourceProviderId: string },
    mutationReservationToken?: string,
  ): Promise<void> {
    await this.agentService.sendMessage({
      threadId,
      content: prompt,
      provider: execution.providerId as ProviderId,
      model: execution.modelId,
      permissionMode: execution.permissionMode,
      interactionMode: execution.interactionMode,
      sourceTurnId,
      ...(origin
        ? {
            sourceThreadId: origin.sourceThreadId,
            originSourceTurnId: origin.sourceTurnId,
            sourceProviderId: origin.sourceProviderId,
          }
        : {}),
      ...(mutationReservationToken ? { mutationReservationToken } : {}),
    });
  }

  private async respondToMutationApproval(
    pending: PendingThreadSendApproval | PendingThreadStopApproval,
    decision: PermissionDecision,
  ): Promise<boolean> {
    const operation = pending.operation;
    if (operation === "thread_send") {
      const provenance = [pending.sourceThreadId, pending.sourceTurnId, pending.sourceProviderId];
      const hasAnyProvenance = provenance.some((value) => value !== undefined);
      const hasCompleteProvenance = provenance.every((value) => typeof value === "string" && value.length > 0);
      if (hasAnyProvenance && !hasCompleteProvenance) {
        this.approvals.settle(pending.approvalId, "failed");
        this.mutationReservations.release(pending.threadId, pending.approvalId);
        this.writeAudit({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation, outcome: "resumed-failed" }, { approvalId: pending.approvalId, threadId: pending.threadId });
        broadcast("permission.resolved", { requestId: pending.approvalId, decision });
        return true;
      }
    }
    if (decision === "deny" || decision === "cancelled") {
      this.approvals.settle(pending.approvalId, "rejected");
      this.mutationReservations.release(pending.threadId, pending.approvalId);
      this.writeAudit({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation, outcome: "denied" }, { approvalId: pending.approvalId, threadId: pending.threadId });
      broadcast("permission.resolved", { requestId: pending.approvalId, decision });
      return true;
    }
    try {
      const nextState: ThreadMutationReservationState = operation === "thread_send" ? "activeTurn" : "stopping";
      if (!this.mutationReservations.transition(pending.threadId, pending.approvalId, "pendingApproval", nextState)) {
        throw new Error("Thread mutation reservation is no longer available");
      }
      this.requirePhase(pending.approvalId, "dispatching");
      if (operation === "thread_send") {
        await this.startTurn(
          pending.threadId,
          pending.message,
          pending.execution,
          pending.turnId,
          pending.sourceThreadId && pending.sourceTurnId && pending.sourceProviderId
            ? { sourceThreadId: pending.sourceThreadId, sourceTurnId: pending.sourceTurnId, sourceProviderId: pending.sourceProviderId }
            : undefined,
          pending.approvalId,
        );
      } else {
        await this.stopTarget(pending.threadId);
        this.mutationReservations.release(pending.threadId, pending.approvalId);
      }
      this.requirePhase(pending.approvalId, "dispatched");
      this.approvals.settle(pending.approvalId, "approved");
      this.writeAudit({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation, outcome: "resumed-approved" }, { approvalId: pending.approvalId, threadId: pending.threadId });
      broadcast("permission.resolved", { requestId: pending.approvalId, decision });
      return true;
    } catch (error) {
      logger.error("Thread-control mutation approval failed", { approvalId: pending.approvalId, threadId: pending.threadId, error: String(error) });
      this.approvals.settle(pending.approvalId, "failed");
      this.mutationReservations.release(pending.threadId, pending.approvalId);
      this.writeAudit({ callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId, threadId: pending.threadId, operation, outcome: "resumed-failed" }, { approvalId: pending.approvalId, threadId: pending.threadId });
      broadcast("permission.resolved", { requestId: pending.approvalId, decision });
      return true;
    }
  }

  private findMutableThread(
    authority: ThreadControlAuthority,
    threadId: string,
    operation: "send" | "stop",
  ) {
    const thread = this.threads.findById(threadId);
    if (!thread || thread.deleted_at != null || !this.workspaces.findById(thread.workspace_id)) return null;
    if (authority.type === "internal") return thread.id === authority.sourceThreadId ? null : thread;
    if (!authority.allowedWorkspaceIds.includes(thread.workspace_id)) return null;
    const projectScope = operation === "send" ? "threads:send-project" : "threads:stop-project";
    const ownedScope = operation === "send" ? "threads:send-owned" : "threads:stop-owned";
    if (authority.scopes.includes(projectScope)) return thread;
    if (!authority.scopes.includes(ownedScope)) return null;
    return this.threads.findById(threadId, { createdByIntegrationId: authority.integrationId });
  }

  private async resolveSendExecution(
    authority: ThreadControlAuthority,
    target: { provider: string; model: string | null; interaction_mode?: string | null; permission_mode?: string | null },
    input: ThreadSendInput,
  ): Promise<{ value: ResolvedExecution } | { error: ThreadControlError }> {
    if (authority.type === "external" && input.permissionMode === "full" && !authority.scopes.includes("execution:full")) {
      return { error: this.error("forbidden", "Full execution is not permitted", false) };
    }
    const providerId = target.provider || this.settings.get().model.defaults.provider;
    try {
      this.providers.resolve(providerId as ProviderId);
    } catch {
      return { error: this.error("invalid_provider", "Provider is not available", false) };
    }
    const modelId = target.model || this.settings.get().model.defaults.id;
    try {
      const available = await this.models.listModels(providerId);
      if (!available.some((model) => model.id === modelId && model.policy?.state !== "disabled")) {
        return { error: this.error("invalid_model", "Model is not available for the selected provider", false) };
      }
    } catch {
      return { error: this.error("internal_error", "Provider model discovery failed", true) };
    }
    const permissionMode = authority.type === "internal"
      ? authority.permissionMode
      : input.permissionMode ?? (
          !authority.scopes.includes("execution:full")
            ? "supervised"
            : this.settings.get().agent.defaults.permission
        );
    return {
      value: {
        providerId,
        modelId,
        permissionMode,
        interactionMode: input.interactionMode ?? (target.interaction_mode === "plan" ? "plan" : "build"),
      },
    };
  }

  private resolveInternalPermissionMode(permissionMode: string | null | undefined): "full" | "supervised" {
    if (permissionMode === "supervised") return "supervised";
    if (permissionMode === "full") return "full";
    return this.settings.get().agent.defaults.permission === "supervised" ? "supervised" : "full";
  }

  private async stopTarget(threadId: string): Promise<void> {
    await this.agentService.stopSession(threadId);
    this.threads.updateStatus(threadId, "interrupted");
    broadcast("thread.status", { threadId, status: "interrupted" });
  }

  private auditMutation(
    authority: ThreadControlAuthority,
    operation: "thread_send" | "thread_stop",
    outcome: string,
    threadId?: string,
    workspaceId?: string,
    approvalId?: string,
  ): void {
    this.writeAudit({
      callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(threadId ? { threadId } : {}),
      operation,
      outcome,
    }, { ...(threadId ? { threadId } : {}), ...(approvalId ? { approvalId } : {}) });
  }

  private requirePhase(approvalId: string, phase: "pre_provision" | "provisioning" | "provisioned" | "dispatching" | "dispatched"): void {
    if (!this.approvals.setOperationPhase(approvalId, phase)) {
      throw new Error(`Could not persist approval phase: ${phase}`);
    }
  }

  private failRecovery(approval: RecoverableThreadCreateApproval): void {
    const identity = { approvalId: approval.approvalId, threadId: approval.threadId };
    try {
      if (!this.approvals.settle(approval.approvalId, "failed")) {
        logger.error("Could not fail recovered approval", identity);
      }
    } catch {
      logger.error("Could not fail recovered approval", identity);
    }
    if (approval.operation === "thread_create_batch") {
      try {
        if (!this.threads.updateStatus(approval.threadId, "errored")) {
          logger.error("Could not mark recovered thread errored", identity);
        }
      } catch {
        logger.error("Could not mark recovered thread errored", identity);
      }
    }
    this.writeRecoveryAudit(approval, "recovery-failed");
    if (approval.operation === "thread_create_batch") broadcast("thread.status", { threadId: approval.threadId, status: "errored" });
  }

  private writeRecoveryAudit(
    approval: RecoverableThreadCreateApproval,
    outcome: "recovery-failed" | "recovery-requeued",
  ): void {
    this.writeAudit(
      { callerId: approval.callerId, sourceThreadId: approval.sourceThreadId, workspaceId: approval.workspaceId, threadId: approval.threadId, operation: approval.operation ?? "unknown", outcome },
      { approvalId: approval.approvalId, threadId: approval.threadId },
    );
  }

  private writeAudit(
    input: { callerId: string; sourceThreadId?: string; workspaceId?: string; threadId?: string; operation: string; outcome: string },
    identity: { approvalId?: string; threadId?: string },
  ): void {
    try {
      this.audit.write(input);
    } catch {
      logger.error("Thread-control audit write failed", identity);
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
    if (input.workspaceId === undefined) return false;
    return authority.allowedWorkspaceIds.includes(input.workspaceId)
      && authority.scopes.includes("threads:create")
      && (
        input.placement.type !== "new_worktree"
        || authority.scopes.includes("worktrees:create")
      );
  }

  private resolveInternalSourceWorkspaceId(authority: InternalThreadControlAuthority): string | undefined {
    const source = this.threads.findById(authority.sourceThreadId);
    if (!source || source.deleted_at != null) return undefined;
    return source.workspace_id;
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
