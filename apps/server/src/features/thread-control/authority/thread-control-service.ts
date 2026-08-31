import * as NodeCrypto from "node:crypto";
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
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { WorktreeRepo, type InternalRegisteredWorktree } from "../../projects/persistence/worktree-repo.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { MessageRepo, type ThreadControlMessageRecord } from "../../agents/conversation/persistence/message-repo.js";
import {
  ThreadControlApprovalRepo,
  type RecoverableThreadCreateApproval,
  type PendingThreadSendApproval,
  type PendingThreadStopApproval,
  type PendingThreadCreateApproval,
} from "./persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "./persistence/thread-control-audit-repo.js";
import { ProviderRegistry } from "../../providers/composition/provider-registry.js";
import { AgentService, DelegationTargetResolver } from "../../agents/index.js";
import {
  ThreadControlMutationReservationService,
  type ThreadMutationReservationState,
} from "./thread-control-mutation-reservation-service.js";
import { ProjectWorktreeService } from "../../projects/index.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { ModelCacheService } from "../../providers/models/model-cache-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { broadcast } from "../../../application/transport/push.js";

const THREAD_WAIT_POLL_INTERVAL_MS = 250;

const PERSISTED_THREAD_STATES: Record<string, ThreadObservedState> = {
  completed: { status: "completed" },
  errored: { status: "failed" },
  interrupted: { status: "stopped" },
  paused: { status: "waiting_for_user" },
  deleted: { status: "stopped" },
  archived: { status: "stopped" },
  active: { status: "idle" },
};

type MutableThread = NonNullable<ReturnType<ThreadRepo["findById"]>>;
type ExistingWorktreeResolution =
  | { worktree: InternalRegisteredWorktree | null }
  | { rejection: ThreadCreateItemResult };
type ThreadPersistenceDetails = {
  branch: string;
  mode: "direct" | "worktree";
  managed: boolean;
  checkoutState: "named" | "branchless";
  baseBranch: string | null;
};

/** Sole server authority boundary for internal thread-control operations. */
@injectable()
export class ThreadControlService {
  private capacityTail: Promise<void> = Promise.resolve();
  private readonly externalReservations = new Map<string, number>();
  private readonly mutationReservations: ThreadControlMutationReservationService;

  constructor(
    @inject(WorkspaceRepo) private readonly workspaces: WorkspaceRepo,
    @inject(WorktreeRepo) private readonly worktrees: WorktreeRepo,
    @inject(delay(() => GitWorktreeService)) private readonly gitWorktrees: GitWorktreeService,
    @inject(delay(() => GitRepositoryService)) private readonly gitRepository: GitRepositoryService,
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(delay(() => ProjectWorktreeService)) private readonly projectWorktreeService: ProjectWorktreeService,
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
      sourceTurnId: NodeCrypto.randomUUID(),
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
      sourceTurnId: NodeCrypto.randomUUID(),
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
    const discovered = await this.gitWorktrees.listWorktrees(input.workspaceId);
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
    const items = this.resolveBatchItems(authority, validatedInput);
    const reservations = await this.reserveBatchCapacity(authority, items);
    const results: ThreadCreateItemResult[] = [];
    for (let index = 0; index < items.length; index += 1) {
      results.push(await this.createBatchItem(authority, items[index]!, index, reservations[index]));
    }
    return { results };
  }

  private resolveBatchItems(authority: ThreadControlAuthority, input: ThreadCreateBatchInput): ThreadCreateInput[] {
    const sourceWorkspaceId = authority.type === "internal" && input.items.some((item) => item.workspaceId === undefined)
      ? this.resolveInternalSourceWorkspaceId(authority)
      : undefined;
    return input.items.map((item) => item.workspaceId === undefined && sourceWorkspaceId
      ? { ...item, workspaceId: sourceWorkspaceId }
      : item);
  }

  private async reserveBatchCapacity(authority: ThreadControlAuthority, items: ThreadCreateInput[]): Promise<boolean[]> {
    return authority.type === "external"
      ? this.reserveExternalCapacity(authority, { items })
      : items.map(() => false);
  }

  private async createBatchItem(
    authority: ThreadControlAuthority,
    item: ThreadCreateInput,
    index: number,
    reserved: boolean,
  ): Promise<ThreadCreateItemResult> {
    const rejected = this.batchItemRejection(authority, item, index, reserved);
    if (rejected) return rejected;
    try {
      const result = await this.createOne(authority, item, index);
      this.auditCreateResult(authority, result);
      if ("threadId" in result && result.threadId) this.broadcastControlState(result.workspaceId, result.threadId);
      return result;
    } finally {
      if (authority.type === "external" && reserved) await this.releaseExternalReservation(authority.integrationId);
    }
  }

  private batchItemRejection(
    authority: ThreadControlAuthority,
    item: ThreadCreateInput,
    index: number,
    reserved: boolean,
  ): ThreadCreateItemResult | null {
    const sourceMissing = authority.type === "internal" && item.workspaceId === undefined;
    const capacityExceeded = authority.type === "external" && this.externalItemCanCreate(authority, item) && !reserved;
    if (!sourceMissing && !capacityExceeded) return null;
    const result: ThreadCreateItemResult = sourceMissing
      ? { index, status: "rejected", error: this.error("not_found", "Source thread not found", false) }
      : { index, status: "rejected", workspaceId: item.workspaceId, error: this.error("limit_exceeded", "External active-thread limit reached", true) };
    this.auditCreateResult(authority, result);
    return result;
  }

  /** Send one cross-thread message through the shared agent turn gate. */
  async threadSend(
    authority: ThreadControlAuthority,
    input: ThreadSendInput,
  ): Promise<ThreadSendResult> {
    const validated = ThreadSendInputSchema().parse(input);
    const target = this.findMutableThread(authority, validated.threadId, "send");
    if (!target) return this.rejectMissingSendTarget(authority, validated.threadId);
    const targetRejection = this.sendTargetRejection(authority, target);
    if (targetRejection) return targetRejection;
    const execution = await this.resolveSendExecution(authority, target, validated);
    if ("error" in execution) {
      this.auditMutation(authority, "thread_send", execution.error.code, target.id, target.workspace_id);
      return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error: execution.error };
    }
    return execution.value.permissionMode === "supervised"
      ? this.createSendApproval(authority, target, validated, execution.value)
      : this.dispatchThreadSend(authority, target, validated, execution.value);
  }

  private sendTargetRejection(
    authority: ThreadControlAuthority,
    target: MutableThread,
  ): ThreadSendResult | null {
    const state = this.observedState(target);
    if (state.status === "running" || state.status === "waiting_for_approval") {
      return this.rejectSendTarget(authority, target, "thread_busy", "Thread is already running", true);
    }
    if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
      return this.rejectSendTarget(authority, target, "conflict", "Thread is terminal", false);
    }
    return null;
  }

  private rejectMissingSendTarget(authority: ThreadControlAuthority, threadId: string): ThreadSendResult {
    this.auditMutation(authority, "thread_send", "not_found", threadId);
    return { status: "rejected", threadId, error: this.error("not_found", "Thread not found", false) };
  }

  private rejectSendTarget(
    authority: ThreadControlAuthority,
    target: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    code: ThreadControlError["code"],
    message: string,
    retryable: boolean,
  ): ThreadSendResult {
    const error = this.error(code, message, retryable);
    this.auditMutation(authority, "thread_send", code, target.id, target.workspace_id);
    return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error };
  }

  private createSendApproval(
    authority: ThreadControlAuthority,
    target: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    input: ThreadSendInput,
    execution: ResolvedExecution,
  ): ThreadSendResult {
    const reservationToken = this.mutationReservations.reserve(target.id, "pendingApproval");
    if (!reservationToken) return this.rejectSendTarget(authority, target, "thread_busy", "Thread mutation is already pending", true);
    const approvalId = this.persistSendApproval(authority, target, input, execution, reservationToken);
    if (!approvalId) return this.rejectSendTarget(authority, target, "internal_error", "Thread send approval could not be created", true);
    if (approvalId !== reservationToken && !this.mutationReservations.replaceToken(target.id, reservationToken, approvalId)) {
      this.mutationReservations.release(target.id, reservationToken);
      return this.rejectSendTarget(authority, target, "internal_error", "Thread send reservation could not be retained", true);
    }
    this.publishSendApproval(authority, target, input, execution, approvalId);
    return { status: "pending_approval", workspaceId: target.workspace_id, threadId: target.id, approvalId, state: { status: "waiting_for_approval", approvalId } };
  }

  private persistSendApproval(
    authority: ThreadControlAuthority,
    target: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    input: ThreadSendInput,
    execution: ResolvedExecution,
    reservationToken: string,
  ): string | null {
    try {
      return this.approvals.createSend({
        approvalId: reservationToken, threadId: target.id, workspaceId: target.workspace_id,
        message: input.message, execution, turnId: NodeCrypto.randomUUID(),
        callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
        ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId, sourceTurnId: authority.sourceTurnId, sourceProviderId: authority.sourceProviderId } : {}),
      });
    } catch {
      this.mutationReservations.release(target.id, reservationToken);
      return null;
    }
  }

  private publishSendApproval(
    authority: ThreadControlAuthority,
    target: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    input: ThreadSendInput,
    execution: ResolvedExecution,
    approvalId: string,
  ): void {
    broadcast("permission.request", {
      requestId: approvalId, threadId: target.id, toolName: "thread_send", title: "Send a message to another thread",
      input: { threadId: target.id, message: input.message, execution }, ownerWorkspaceId: target.workspace_id,
      ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : target.id,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}), operation: "thread_send" as const,
    });
    this.auditMutation(authority, "thread_send", "pending_approval", target.id, target.workspace_id, approvalId);
  }

  private async dispatchThreadSend(
    authority: ThreadControlAuthority,
    target: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    input: ThreadSendInput,
    execution: ResolvedExecution,
  ): Promise<ThreadSendResult> {
    const reservationToken = this.mutationReservations.reserve(target.id, "activeTurn");
    if (!reservationToken) return this.rejectSendTarget(authority, target, "thread_busy", "Thread mutation is already pending", true);
    const turnId = NodeCrypto.randomUUID();
    try {
      await this.startTurn(target.id, input.message, execution, turnId, this.sendOrigin(authority), reservationToken);
    } catch (error) {
      this.mutationReservations.release(target.id, reservationToken);
      const code = error instanceof Error && /already has an active agent session/.test(error.message) ? "thread_busy" : "internal_error";
      return this.rejectSendTarget(authority, target, code, code === "thread_busy" ? "Thread is already running" : "Thread send failed", true);
    }
    this.auditMutation(authority, "thread_send", "accepted", target.id, target.workspace_id);
    return { status: "accepted", workspaceId: target.workspace_id, threadId: target.id, turnId, execution, state: { status: "starting" } };
  }

  private sendOrigin(authority: ThreadControlAuthority): { sourceThreadId: string; sourceTurnId: string; sourceProviderId: string } | undefined {
    return authority.type === "internal"
      ? { sourceThreadId: authority.sourceThreadId, sourceTurnId: authority.sourceTurnId, sourceProviderId: authority.sourceProviderId }
      : undefined;
  }

  /** Stop one cross-thread target, using durable approval when supervised. */
  async threadStop(
    authority: ThreadControlAuthority,
    input: ThreadStopInput,
  ): Promise<ThreadStopResult> {
    const validated = ThreadStopInputSchema().parse(input);
    const target = this.findMutableThread(authority, validated.threadId, "stop");
    if (!target) return this.rejectMissingStopTarget(authority, validated.threadId);
    const rejection = this.stopTargetRejection(authority, target);
    if (rejection) return rejection;
    const execution = this.stopExecution(authority, target);
    return execution.permissionMode === "supervised"
      ? this.requestStopApproval(authority, target, execution)
      : this.dispatchThreadStop(authority, target);
  }

  private stopTargetRejection(
    authority: ThreadControlAuthority,
    target: MutableThread,
  ): ThreadStopResult | null {
    const observed = this.observedState(target);
    if (observed.status === "stopped") return this.acceptStop(authority, target);
    if (observed.status === "waiting_for_approval") return this.rejectStop(authority, target, "thread_busy", "Thread mutation is already pending", true);
    if (observed.status === "completed" || observed.status === "failed") return this.rejectStop(authority, target, "conflict", "Thread is terminal", false);
    return null;
  }

  private rejectMissingStopTarget(authority: ThreadControlAuthority, threadId: string): ThreadStopResult {
    this.auditMutation(authority, "thread_stop", "not_found", threadId);
    return { status: "rejected", threadId, error: this.error("not_found", "Thread not found", false) };
  }

  private stopExecution(authority: ThreadControlAuthority, target: MutableThread): ResolvedExecution {
    return {
      providerId: target.provider || this.settings.get().model.defaults.provider,
      modelId: target.model || this.settings.get().model.defaults.id,
      permissionMode: authority.type === "internal" ? authority.permissionMode : "supervised",
      interactionMode: "build",
    };
  }

  private requestStopApproval(
    authority: ThreadControlAuthority,
    target: MutableThread,
    execution: ResolvedExecution,
  ): ThreadStopResult {
    const reservationToken = this.mutationReservations.reserve(target.id, "pendingApproval");
    if (!reservationToken) return this.rejectStop(authority, target, "thread_busy", "Thread mutation is already pending", true);
    const approvalId = this.persistStopApproval(authority, target, execution, reservationToken);
    if (!approvalId) return this.rejectStop(authority, target, "internal_error", "Thread stop approval could not be created", true);
    if (approvalId !== reservationToken && !this.mutationReservations.replaceToken(target.id, reservationToken, approvalId)) {
      this.mutationReservations.release(target.id, reservationToken);
      return this.rejectStop(authority, target, "internal_error", "Thread stop reservation could not be retained", true);
    }
    this.publishStopApproval(authority, target, approvalId);
    return { status: "pending_approval", workspaceId: target.workspace_id, threadId: target.id, approvalId, state: { status: "waiting_for_approval", approvalId } };
  }

  private persistStopApproval(
    authority: ThreadControlAuthority,
    target: MutableThread,
    execution: ResolvedExecution,
    reservationToken: string,
  ): string | null {
    try {
      return this.approvals.createStop({
        approvalId: reservationToken, threadId: target.id, workspaceId: target.workspace_id, execution, turnId: NodeCrypto.randomUUID(),
        callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
        ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
      });
    } catch {
      this.mutationReservations.release(target.id, reservationToken);
      return null;
    }
  }

  private publishStopApproval(authority: ThreadControlAuthority, target: MutableThread, approvalId: string): void {
    broadcast("permission.request", {
      requestId: approvalId, threadId: target.id, toolName: "thread_stop", title: "Stop another thread", input: { threadId: target.id },
      ownerWorkspaceId: target.workspace_id, ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : target.id,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}), operation: "thread_stop" as const,
    });
    this.auditMutation(authority, "thread_stop", "pending_approval", target.id, target.workspace_id, approvalId);
  }

  private async dispatchThreadStop(authority: ThreadControlAuthority, target: MutableThread): Promise<ThreadStopResult> {
    const reservationToken = this.reserveStopMutation(target.id);
    if (!reservationToken) return this.rejectStop(authority, target, "thread_busy", "Thread mutation is already pending", true);
    try {
      await this.stopTarget(target.id);
      this.mutationReservations.release(target.id, reservationToken);
    } catch {
      this.mutationReservations.release(target.id, reservationToken);
      return this.rejectStop(authority, target, "internal_error", "Thread stop failed", true);
    }
    return this.acceptStop(authority, target);
  }

  private reserveStopMutation(threadId: string): string | null {
    const existing = this.mutationReservations.get(threadId);
    if (existing?.state !== "activeTurn") return this.mutationReservations.reserve(threadId, "stopping");
    return this.mutationReservations.transition(threadId, existing.token, "activeTurn", "stopping")
      ? existing.token
      : null;
  }

  private acceptStop(authority: ThreadControlAuthority, target: MutableThread): ThreadStopResult {
    this.auditMutation(authority, "thread_stop", "accepted", target.id, target.workspace_id);
    return { status: "accepted", workspaceId: target.workspace_id, threadId: target.id, state: { status: "stopped" } };
  }

  private rejectStop(
    authority: ThreadControlAuthority,
    target: MutableThread,
    code: "thread_busy" | "conflict" | "internal_error",
    message: string,
    retryable: boolean,
  ): ThreadStopResult {
    this.auditMutation(authority, "thread_stop", code, target.id, target.workspace_id);
    return { status: "rejected", workspaceId: target.workspace_id, threadId: target.id, error: this.error(code, message, retryable) };
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
      const provisioned = await this.projectWorktreeService.provisionWorktree(
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
    const pendingApproval = this.readPendingApproval(thread.id);
    if (pendingApproval) return { status: "waiting_for_approval", approvalId: pendingApproval.approvalId };
    if (this.agentService.runtimeAccess().activeThreadIds().includes(thread.id)) return { status: "running" };
    return PERSISTED_THREAD_STATES[thread.status] ?? { status: "idle" };
  }

  private readPendingApproval(threadId: string): ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>[number] | undefined {
    try {
      return this.approvals.listPendingByThread(threadId)[0];
    } catch {
      return undefined;
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
    if (message.role === "assistant") return this.readAssistantMessage(message, threadProvider, threadModel);
    if (message.role === "system") return this.readSystemMessage(message);
    return this.readUserMessage(message);
  }

  private readAssistantMessage(
    message: ThreadControlMessageRecord,
    threadProvider: string,
    threadModel: string | null,
  ): ThreadReadMessage {
    return {
      messageId: message.id,
      role: "assistant",
      content: message.content,
      createdAt: message.timestamp,
      providerId: message.provider || threadProvider || "unknown",
      modelId: message.model || threadModel || "unknown",
    };
  }

  private readSystemMessage(message: ThreadControlMessageRecord): ThreadReadMessage {
    return { messageId: message.id, role: "system", content: message.content, createdAt: message.timestamp };
  }

  private readUserMessage(message: ThreadControlMessageRecord): ThreadReadMessage {
    const source = this.readUserMessageSource(message.sourceThreadId);
    const origin = this.readMessageOrigin(
      message,
      source.thread,
      source.workspaceName,
      source.threadRef,
      source.unavailable,
    );
    return {
      messageId: message.id,
      role: "user",
      content: message.content,
      createdAt: message.timestamp,
      origin,
    };
  }

  private readUserMessageSource(sourceThreadId: string | null | undefined): {
    thread: ReturnType<ThreadRepo["findById"]>;
    workspaceName: string;
    threadRef: ReturnType<ThreadControlService["threadRef"]> | null;
    unavailable: boolean;
  } {
    const thread = sourceThreadId ? this.threads.findById(sourceThreadId) : null;
    const workspace = this.sourceWorkspace(thread);
    const threadRef = this.boundedThreadRef(thread);
    return {
      thread,
      workspaceName: workspace?.name.trim().slice(0, WORKSPACE_SEARCH_QUERY_MAX_LENGTH) || "Unavailable Project",
      threadRef,
      unavailable: this.sourceUnavailable(thread, workspace),
    };
  }

  private sourceWorkspace(thread: ReturnType<ThreadRepo["findById"]>) {
    if (!thread) return null;
    return this.workspaces.findByIdIncludeDeleted?.(thread.workspace_id)
      ?? this.workspaces.findById(thread.workspace_id);
  }

  private boundedThreadRef(thread: ReturnType<ThreadRepo["findById"]>): ReturnType<ThreadControlService["threadRef"]> | null {
    if (!thread) return null;
    const reference = this.threadRef(thread, this.observedState(thread));
    return { ...reference, title: reference.title.slice(0, THREAD_CREATE_TITLE_MAX_LENGTH) };
  }

  private sourceUnavailable(
    thread: ReturnType<ThreadRepo["findById"]>,
    workspace: ReturnType<WorkspaceRepo["findByIdIncludeDeleted"]>,
  ): boolean {
    return !thread || !workspace || thread.deleted_at != null || workspace.deleted_at != null;
  }

  private readMessageOrigin(
    message: ThreadControlMessageRecord,
    sourceThread: ReturnType<ThreadRepo["findById"]>,
    sourceWorkspaceName: string,
    sourceThreadRef: ReturnType<ThreadControlService["threadRef"]> | null,
    sourceUnavailable: boolean,
  ): Extract<ThreadReadMessage, { role: "user" }>["origin"] {
    if (message.originType === "composer") return { type: "composer" };
    if (message.originType !== "thread" || !message.sourceThreadId || !message.sourceTurnId || !message.sourceProviderId) {
      return { type: "legacy" };
    }
    return {
      type: "thread",
      sourceThreadId: message.sourceThreadId,
      sourceTurnId: message.sourceTurnId,
      sourceProviderId: message.sourceProviderId,
      sourceWorkspaceId: sourceThread?.workspace_id ?? null,
      sourceWorkspaceName,
      sourceThread: sourceThreadRef,
      sourceUnavailable,
    };
  }

  private async recoverApproval(approval: RecoverableThreadCreateApproval): Promise<void> {
    if ("invalid" in approval) {
      this.failInvalidApprovalRecovery(approval);
      return;
    }
    if ("operation" in approval && (approval.operation === "thread_send" || approval.operation === "thread_stop")) {
      this.recoverMutationApproval(approval);
      return;
    }
    await this.recoverCreateApproval(approval as PendingThreadCreateApproval);
  }

  private failInvalidApprovalRecovery(approval: RecoverableThreadCreateApproval): void {
    logger.error("Thread-control approval payload is invalid during recovery", {
      approvalId: approval.approvalId,
      threadId: approval.threadId,
    });
    this.failRecovery(approval);
  }

  private recoverMutationApproval(approval: PendingThreadSendApproval | PendingThreadStopApproval): void {
    if (approval.operationPhase !== "pre_dispatch" || !this.approvals.requeueDispatch(approval.approvalId)) {
      this.failRecovery(approval);
      return;
    }
    if (!this.mutationReservations.rehydrate(approval.threadId, approval.approvalId)) {
      logger.error("Thread-control processing approval reservation conflict", {
        approvalId: approval.approvalId,
        threadId: approval.threadId,
      });
    }
    this.writeRecoveryAudit(approval, "recovery-requeued");
  }

  private async recoverCreateApproval(approval: PendingThreadCreateApproval): Promise<void> {
    if (approval.operationPhase === "pre_provision") {
      this.requeuePreProvisionApproval(approval);
      return;
    }
    if (approval.operationPhase === "provisioning") {
      await this.recoverInterruptedProvisioning(approval);
      return;
    }
    this.failRecovery(approval);
  }

  private requeuePreProvisionApproval(approval: PendingThreadCreateApproval): void {
    if (!this.approvals.requeue(approval.approvalId)) {
      this.failRecovery(approval);
      return;
    }
    this.writeRecoveryAudit(approval, "recovery-requeued");
  }

  private async recoverInterruptedProvisioning(approval: PendingThreadCreateApproval): Promise<void> {
    const cleaned = await this.projectWorktreeService.cleanupInterruptedProvisioning(
      approval.threadId,
      approval.workspaceId,
      approval.placement,
    );
    if (!cleaned) {
      this.failRecovery(approval);
      return;
    }
    const reset = this.threads.clearWorktreePath(approval.threadId)
      && this.threads.updateStatus(approval.threadId, "paused")
      && this.approvals.requeueRecoveredProvisioning(approval.approvalId);
    if (reset) this.writeRecoveryAudit(approval, "recovery-requeued");
    else this.failRecovery(approval);
  }

  /** Return durable thread-control approvals for frontend rehydration. */
  listPendingApprovals(threadId: string): PermissionRequest[] {
    const byTarget = this.approvals.listPendingByThread(threadId);
    const bySource = this.approvals.listPendingBySourceThread?.(threadId) ?? [];
    return this.uniquePendingApprovals(byTarget, bySource).map((approval) => this.permissionRequestForApproval(approval));
  }

  private uniquePendingApprovals(
    byTarget: ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>,
    bySource: ReturnType<NonNullable<ThreadControlApprovalRepo["listPendingBySourceThread"]>>,
  ) {
    const seen = new Set<string>();
    return [...byTarget, ...bySource].filter((approval) => {
      if (seen.has(approval.approvalId)) return false;
      seen.add(approval.approvalId);
      return true;
    });
  }

  private permissionRequestForApproval(
    approval: ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>[number],
  ): PermissionRequest {
    const owner = this.permissionOwner(approval);
    if ("operation" in approval && approval.operation === "thread_send") {
      return this.sendPermissionRequest(approval, owner);
    }
    if ("operation" in approval && approval.operation === "thread_stop") {
      return this.stopPermissionRequest(approval, owner);
    }
    return this.createPermissionRequest(approval, owner);
  }

  private permissionOwner(approval: ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>[number]) {
    const ownerThread = approval.sourceThreadId ? this.threads.findById(approval.sourceThreadId) : null;
    return { workspaceId: ownerThread?.workspace_id ?? approval.workspaceId, threadId: ownerThread?.id ?? approval.threadId };
  }

  private sendPermissionRequest(
    approval: PendingThreadSendApproval,
    owner: { workspaceId: string; threadId: string },
  ): PermissionRequest {
    return {
      requestId: approval.approvalId, threadId: approval.threadId, toolName: "thread_send", title: "Send a message to another thread",
      input: { threadId: approval.threadId, message: approval.message, execution: approval.execution },
      ownerWorkspaceId: owner.workspaceId, ownerThreadId: owner.threadId,
      ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}), operation: approval.operation,
    };
  }

  private stopPermissionRequest(
    approval: PendingThreadStopApproval,
    owner: { workspaceId: string; threadId: string },
  ): PermissionRequest {
    return {
      requestId: approval.approvalId, threadId: approval.threadId, toolName: "thread_stop", title: "Stop another thread",
      input: { threadId: approval.threadId }, ownerWorkspaceId: owner.workspaceId, ownerThreadId: owner.threadId,
      ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}), operation: approval.operation,
    };
  }

  private createPermissionRequest(
    approval: Exclude<ReturnType<ThreadControlApprovalRepo["listPendingByThread"]>[number], PendingThreadSendApproval | PendingThreadStopApproval>,
    owner: { workspaceId: string; threadId: string },
  ): PermissionRequest {
    return {
      requestId: approval.approvalId, threadId: approval.threadId, toolName: "thread_create_batch", title: "Create a new worktree",
      input: { workspaceId: approval.workspaceId, placement: approval.placement, execution: approval.execution },
      ownerWorkspaceId: owner.workspaceId, ownerThreadId: owner.threadId,
      ...(approval.sourceThreadId ? { sourceThreadId: approval.sourceThreadId } : {}), operation: approval.operation,
    };
  }

  private async createOne(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
    index: number,
  ): Promise<ThreadCreateItemResult> {
    const inputRejection = this.createInputRejection(authority, input, index);
    if (inputRejection) return inputRejection;
    const execution = await this.resolveExecution(authority, input);
    if ("error" in execution) {
      return { index, status: "rejected", workspaceId: input.workspaceId, error: execution.error };
    }
    const confirmedInput = input as ThreadCreateInput & { workspaceId: string };
    const existingWorktree = this.resolveExistingWorktree(confirmedInput, index);
    if ("rejection" in existingWorktree) return existingWorktree.rejection;
    return this.persistCreateOne(authority, confirmedInput, index, execution.value, existingWorktree.worktree);
  }

  private createInputRejection(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
    index: number,
  ): ThreadCreateItemResult | null {
    if (!this.canCreateInWorkspace(authority, input.workspaceId)) {
      return { index, status: "rejected", error: this.error("not_found", "Workspace not found", false) };
    }
    if (!this.workspaces.findById(input.workspaceId)) {
      return { index, status: "rejected", error: this.error("not_found", "Workspace not found", false) };
    }
    if (this.canCreateWorktree(authority, input)) return null;
    return {
      index,
      status: "rejected",
      workspaceId: input.workspaceId,
      error: this.error("forbidden", "New worktree creation is not permitted", false),
    };
  }

  private canCreateInWorkspace(authority: ThreadControlAuthority, workspaceId: string | undefined): workspaceId is string {
    if (!workspaceId) return false;
    return authority.type === "internal"
      || (authority.allowedWorkspaceIds.includes(workspaceId) && authority.scopes.includes("threads:create"));
  }

  private canCreateWorktree(authority: ThreadControlAuthority, input: ThreadCreateInput): boolean {
    return authority.type === "internal"
      || input.placement.type !== "new_worktree"
      || authority.scopes.includes("worktrees:create");
  }

  private resolveExistingWorktree(input: ThreadCreateInput & { workspaceId: string }, index: number): ExistingWorktreeResolution {
    if (input.placement.type !== "existing_worktree") return { worktree: null };
    const worktree = this.worktrees.findCurrentById(input.workspaceId, input.placement.worktreeId);
    if (!worktree) {
      return {
        rejection: {
          index, status: "rejected", workspaceId: input.workspaceId,
          error: this.error("invalid_placement", "Worktree does not belong to the selected workspace", false),
        },
      };
    }
    if (this.existingWorktreeBranch(worktree)) return { worktree };
    return {
      rejection: {
        index, status: "rejected", workspaceId: input.workspaceId,
        error: this.error("invalid_placement", "Detached worktree does not have a registered base ref", false),
      },
    };
  }

  private async persistCreateOne(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput & { workspaceId: string },
    index: number,
    execution: ResolvedExecution,
    existingWorktree: InternalRegisteredWorktree | null,
  ): Promise<ThreadCreateItemResult> {
    let threadId: string | undefined;
    try {
      const persisted = await this.persistThread(input, execution, existingWorktree);
      threadId = persisted.threadId;
      this.recordThreadCreator(authority, threadId);
      const approval = this.createWorktreeApproval(authority, input, index, threadId, execution);
      if (approval) return approval;
      return this.provisionAndStartThread(input, index, threadId, execution);
    } catch {
      return this.createOneFailure(index, input.workspaceId, threadId);
    }
  }

  private recordThreadCreator(authority: ThreadControlAuthority, threadId: string): void {
    if (authority.type === "internal") {
      this.threads.updateDelegationLineage(threadId, {
        coordinatorThreadId: authority.sourceThreadId,
        creatorTurnId: authority.sourceTurnId,
        creatorToolCallId: authority.sourceToolCallId,
        creationKind: "thread_delegation",
      });
      return;
    }
    this.threads.updateExternalCreator(threadId, authority.integrationId);
  }

  private createWorktreeApproval(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput & { workspaceId: string },
    index: number,
    threadId: string,
    execution: ResolvedExecution,
  ): ThreadCreateItemResult | null {
    if (input.placement.type !== "new_worktree" || !this.requiresWorktreeApproval(authority, execution)) return null;
    this.threads.updateStatus(threadId, "paused");
    const approvalId = this.approvals.create({
      threadId, workspaceId: input.workspaceId, prompt: input.prompt, execution, placement: input.placement, turnId: NodeCrypto.randomUUID(),
      callerId: authority.type === "internal" ? authority.userId : authority.integrationId,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}),
    });
    broadcast("permission.request", {
      requestId: approvalId, threadId, toolName: "thread_create_batch", title: "Create a new worktree",
      input: { workspaceId: input.workspaceId, placement: input.placement, execution }, ownerWorkspaceId: input.workspaceId,
      ownerThreadId: authority.type === "internal" ? authority.sourceThreadId : threadId,
      ...(authority.type === "internal" ? { sourceThreadId: authority.sourceThreadId } : {}), operation: "thread_create_batch" as const,
    });
    return {
      index, status: "pending_approval", workspaceId: input.workspaceId, threadId, approvalId, execution,
      requestedPlacement: input.placement, state: { status: "waiting_for_approval", approvalId },
    };
  }

  private requiresWorktreeApproval(authority: ThreadControlAuthority, execution: ResolvedExecution): boolean {
    return authority.type === "internal"
      ? authority.permissionMode === "supervised"
      : execution.permissionMode === "supervised";
  }

  private async provisionAndStartThread(
    input: ThreadCreateInput & { workspaceId: string },
    index: number,
    threadId: string,
    execution: ResolvedExecution,
  ): Promise<ThreadCreateItemResult> {
    const placement = await this.resolveCreatedPlacement(threadId, input);
    const turnId = NodeCrypto.randomUUID();
    await this.startTurn(threadId, input.prompt, execution, turnId);
    return { index, status: "created", workspaceId: input.workspaceId, threadId, turnId, execution, placement, state: { status: "starting" } };
  }

  private async resolveCreatedPlacement(
    threadId: string,
    input: ThreadCreateInput & { workspaceId: string },
  ): Promise<ResolvedPlacement> {
    if (input.placement.type !== "new_worktree") return input.placement;
    const provisioned = await this.projectWorktreeService.provisionWorktree(threadId, input.workspaceId, input.placement);
    const registered = this.registerProvisionedWorktree(input.workspaceId, provisioned, input.placement);
    return { ...input.placement, worktreeId: registered.worktreeId };
  }

  private createOneFailure(index: number, workspaceId: string, threadId: string | undefined): ThreadCreateItemResult {
    if (!threadId) {
      return { index, status: "rejected", workspaceId, error: this.error("internal_error", "Thread creation failed", true) };
    }
    this.threads.updateStatus(threadId, "errored");
    return {
      index, status: "failed", workspaceId, threadId,
      error: this.error("internal_error", "Thread creation failed", true), state: { status: "failed" },
    };
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
    const permissionError = this.createPermissionError(authority, input);
    if (permissionError) return { error: permissionError };
    const resolver = this.targetResolver ?? new DelegationTargetResolver(this.providers, this.models, this.settings);
    const target = await resolver.resolve(input);
    if (target.status !== "resolved") return { error: this.executionTargetError(target.status) };
    return { value: this.resolvedCreateExecution(authority, input, target.providerId, target.modelId) };
  }

  private createPermissionError(authority: ThreadControlAuthority, input: ThreadCreateInput): ThreadControlError | null {
    const forbidden = authority.type === "external"
      && input.permissionMode === "full"
      && !authority.scopes.includes("execution:full");
    return forbidden ? this.error("forbidden", "Full execution is not permitted", false) : null;
  }

  private executionTargetError(status: string): ThreadControlError {
    const errors: Record<string, ThreadControlError> = {
      invalid_provider: this.error("invalid_provider", "Provider is not available", false),
      model_required: this.error("invalid_model", "A model is required when selecting a provider", false),
      discovery_failed: this.error("internal_error", "Provider model discovery failed", true),
    };
    return errors[status] ?? this.error("invalid_model", "Model is not available for the selected provider", false);
  }

  private resolvedCreateExecution(
    authority: ThreadControlAuthority,
    input: ThreadCreateInput,
    providerId: string,
    modelId: string,
  ): ResolvedExecution {
    return {
      providerId,
      modelId,
      permissionMode: this.createPermissionMode(authority, input.permissionMode),
      interactionMode: input.interactionMode ?? "build",
    };
  }

  private createPermissionMode(
    authority: ThreadControlAuthority,
    permissionMode: ThreadCreateInput["permissionMode"],
  ): ResolvedExecution["permissionMode"] {
    if (permissionMode) return permissionMode;
    if (authority.type === "external" && !authority.scopes.includes("execution:full")) return "supervised";
    return this.settings.get().agent.defaults.permission;
  }

  private async persistThread(
    input: ThreadCreateInput & { workspaceId: string },
    execution: ResolvedExecution,
    existingWorktree: InternalRegisteredWorktree | null,
  ): Promise<{ threadId: string }> {
    const details = await this.threadPersistenceDetails(input, existingWorktree);
    const thread = this.threads.create(
      input.workspaceId,
      input.title,
      details.mode,
      details.branch,
      details.managed,
      execution.providerId,
      undefined,
      details.checkoutState,
      details.baseBranch,
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

  private async threadPersistenceDetails(
    input: ThreadCreateInput & { workspaceId: string },
    existingWorktree: InternalRegisteredWorktree | null,
  ): Promise<ThreadPersistenceDetails> {
    if (input.placement.type === "direct") return this.directThreadPersistence(input.workspaceId);
    if (input.placement.type === "new_worktree") return this.newWorktreePersistence(input.placement);
    return this.existingWorktreePersistence(existingWorktree!);
  }

  private async directThreadPersistence(workspaceId: string): Promise<ThreadPersistenceDetails> {
    const branch = await this.gitRepository.getCurrentBranch(workspaceId).catch(() => null) ?? "HEAD";
    return { branch, mode: "direct", managed: true, checkoutState: "named", baseBranch: null };
  }

  private newWorktreePersistence(
    placement: Extract<ThreadCreateInput["placement"], { type: "new_worktree" }>,
  ): ThreadPersistenceDetails {
    const branchless = !placement.branchName;
    return {
      branch: placement.branchName ?? placement.baseRef,
      mode: "worktree",
      managed: true,
      checkoutState: branchless ? "branchless" : "named",
      baseBranch: branchless ? placement.baseRef : null,
    };
  }

  private existingWorktreePersistence(worktree: InternalRegisteredWorktree): ThreadPersistenceDetails {
    const branchless = worktree.branch === "(detached)";
    return {
      branch: this.existingWorktreeBranch(worktree)!,
      mode: "worktree",
      managed: false,
      checkoutState: branchless ? "branchless" : "named",
      baseBranch: branchless ? worktree.baseRef ?? null : null,
    };
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
    if (this.hasIncompleteSendProvenance(pending)) return this.failMutationApproval(pending, decision);
    if (decision === "deny" || decision === "cancelled") return this.rejectMutationApproval(pending, decision);
    try {
      await this.executeMutationApproval(pending);
      return this.approveMutationApproval(pending, decision);
    } catch (error) {
      logger.error("Thread-control mutation approval failed", { approvalId: pending.approvalId, threadId: pending.threadId, error: String(error) });
      return this.failMutationApproval(pending, decision);
    }
  }

  private hasIncompleteSendProvenance(pending: PendingThreadSendApproval | PendingThreadStopApproval): boolean {
    if (pending.operation !== "thread_send") return false;
    const provenance = [pending.sourceThreadId, pending.sourceTurnId, pending.sourceProviderId];
    const hasAnyProvenance = provenance.some((value) => value !== undefined);
    return hasAnyProvenance && !provenance.every((value) => typeof value === "string" && value.length > 0);
  }

  private async executeMutationApproval(pending: PendingThreadSendApproval | PendingThreadStopApproval): Promise<void> {
    const nextState: ThreadMutationReservationState = pending.operation === "thread_send" ? "activeTurn" : "stopping";
    if (!this.mutationReservations.transition(pending.threadId, pending.approvalId, "pendingApproval", nextState)) {
      throw new Error("Thread mutation reservation is no longer available");
    }
    this.requirePhase(pending.approvalId, "dispatching");
    await this.dispatchApprovedMutation(pending);
    this.requirePhase(pending.approvalId, "dispatched");
  }

  private async dispatchApprovedMutation(pending: PendingThreadSendApproval | PendingThreadStopApproval): Promise<void> {
    if (pending.operation === "thread_stop") {
      await this.stopTarget(pending.threadId);
      this.mutationReservations.release(pending.threadId, pending.approvalId);
      return;
    }
    await this.startTurn(
      pending.threadId,
      pending.message,
      pending.execution,
      pending.turnId,
      this.pendingSendOrigin(pending),
      pending.approvalId,
    );
  }

  private pendingSendOrigin(pending: PendingThreadSendApproval) {
    if (!pending.sourceThreadId || !pending.sourceTurnId || !pending.sourceProviderId) return undefined;
    return {
      sourceThreadId: pending.sourceThreadId,
      sourceTurnId: pending.sourceTurnId,
      sourceProviderId: pending.sourceProviderId,
    };
  }

  private approveMutationApproval(
    pending: PendingThreadSendApproval | PendingThreadStopApproval,
    decision: PermissionDecision,
  ): boolean {
    return this.settleMutationApproval(pending, decision, "approved", "resumed-approved", false);
  }

  private rejectMutationApproval(
    pending: PendingThreadSendApproval | PendingThreadStopApproval,
    decision: PermissionDecision,
  ): boolean {
    return this.settleMutationApproval(pending, decision, "rejected", "denied", true);
  }

  private failMutationApproval(
    pending: PendingThreadSendApproval | PendingThreadStopApproval,
    decision: PermissionDecision,
  ): boolean {
    return this.settleMutationApproval(pending, decision, "failed", "resumed-failed", true);
  }

  private settleMutationApproval(
    pending: PendingThreadSendApproval | PendingThreadStopApproval,
    decision: PermissionDecision,
    status: "approved" | "rejected" | "failed",
    outcome: "resumed-approved" | "denied" | "resumed-failed",
    releaseReservation: boolean,
  ): boolean {
    this.approvals.settle(pending.approvalId, status);
    if (releaseReservation) this.mutationReservations.release(pending.threadId, pending.approvalId);
    this.writeAudit(
      {
        callerId: pending.callerId, sourceThreadId: pending.sourceThreadId, workspaceId: pending.workspaceId,
        threadId: pending.threadId, operation: pending.operation, outcome,
      },
      { approvalId: pending.approvalId, threadId: pending.threadId },
    );
    broadcast("permission.resolved", { requestId: pending.approvalId, decision });
    return true;
  }

  private findMutableThread(
    authority: ThreadControlAuthority,
    threadId: string,
    operation: "send" | "stop",
  ) {
    const thread = this.threads.findById(threadId);
    if (!this.mutableThreadIsAvailable(thread)) return null;
    if (authority.type === "internal") return thread.id === authority.sourceThreadId ? null : thread;
    return this.findExternalMutableThread(authority, thread, operation);
  }

  private mutableThreadIsAvailable(thread: MutableThread | null): thread is MutableThread {
    return !!thread && thread.deleted_at == null && !!this.workspaces.findById(thread.workspace_id);
  }

  private findExternalMutableThread(
    authority: ExternalThreadControlAuthority,
    thread: MutableThread,
    operation: "send" | "stop",
  ): MutableThread | null {
    if (!authority.allowedWorkspaceIds.includes(thread.workspace_id)) return null;
    const scope = operation === "send" ? "threads:send" : "threads:stop";
    if (authority.scopes.includes(`${scope}-project`)) return thread;
    if (!authority.scopes.includes(`${scope}-owned`)) return null;
    return this.threads.findById(thread.id, { createdByIntegrationId: authority.integrationId });
  }

  private async resolveSendExecution(
    authority: ThreadControlAuthority,
    target: { provider: string; model: string | null; interaction_mode?: string | null; permission_mode?: string | null },
    input: ThreadSendInput,
  ): Promise<{ value: ResolvedExecution } | { error: ThreadControlError }> {
    const permissionError = this.sendPermissionError(authority, input);
    if (permissionError) return { error: permissionError };
    const providerId = target.provider || this.settings.get().model.defaults.provider;
    const providerError = this.sendProviderError(providerId);
    if (providerError) return { error: providerError };
    const modelId = target.model || this.settings.get().model.defaults.id;
    const modelError = await this.sendModelError(providerId, modelId);
    if (modelError) return { error: modelError };
    return {
      value: {
        providerId,
        modelId,
        permissionMode: this.sendPermissionMode(authority, input),
        interactionMode: input.interactionMode ?? (target.interaction_mode === "plan" ? "plan" : "build"),
      },
    };
  }

  private sendPermissionError(authority: ThreadControlAuthority, input: ThreadSendInput): ThreadControlError | null {
    const forbidden = authority.type === "external"
      && input.permissionMode === "full"
      && !authority.scopes.includes("execution:full");
    return forbidden ? this.error("forbidden", "Full execution is not permitted", false) : null;
  }

  private sendProviderError(providerId: string): ThreadControlError | null {
    try {
      this.providers.resolve(providerId as ProviderId);
    } catch {
      return this.error("invalid_provider", "Provider is not available", false);
    }
    return null;
  }

  private async sendModelError(providerId: string, modelId: string): Promise<ThreadControlError | null> {
    try {
      const available = await this.models.listModels(providerId);
      return available.some((model) => model.id === modelId && model.policy?.state !== "disabled")
        ? null
        : this.error("invalid_model", "Model is not available for the selected provider", false);
    } catch {
      return this.error("internal_error", "Provider model discovery failed", true);
    }
  }

  private sendPermissionMode(authority: ThreadControlAuthority, input: ThreadSendInput): ResolvedExecution["permissionMode"] {
    if (authority.type === "internal") return authority.permissionMode;
    if (input.permissionMode) return input.permissionMode;
    return authority.scopes.includes("execution:full")
      ? this.settings.get().agent.defaults.permission
      : "supervised";
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
