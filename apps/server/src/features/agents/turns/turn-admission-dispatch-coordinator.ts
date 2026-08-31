import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AgentEventType,
  previewAnnotationSnapshotAttachments,
  type AttachmentMeta,
  type ContextWindowMode,
  type IAgentProvider,
  type IProviderRegistry,
  type InteractionMode,
  type MessageMention,
  type PermissionMode,
  type ProviderId,
  type SendMessageInput,
  type StoredAttachment,
  type Thread,
  type TurnRequest,
  type TurnRuntimeSnapshot,
} from "@mcode/contracts";
import { logger, validateBranchName } from "@mcode/shared";
import { isExplicitMcodeThreadRequest } from "@mcode/thread-orchestration";
import { broadcast } from "../../../application/transport/push.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { FileService } from "../../projects/files/file-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { WorkspaceEnvironmentService } from "../../projects/index.js";
import type { WorkspaceEnvironmentQueuedTurnSubmission } from "../../projects/environment/workspace-environment-automatic-repository.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import type { SettingsService } from "../../settings/settings-service.js";
import {
  ProviderCliMissingError,
  ProviderDisabledError,
} from "../../providers/availability/provider-availability-errors.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import {
  GoalLifecycleService,
  type GoalCommandEffectReceipt,
} from "../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import {
  type ParentTurnDurability,
} from "./parent-turn-durability.js";

const FILE_INJECTION_SEPARATOR = "\n\n---\n";

/** Automatic setup dispatch contract exposed to the turn command facade. */
export type { WorkspaceEnvironmentQueuedTurnSubmission };

/** Injection token for the complete first-turn admission coordinator. */
export const TURN_ADMISSION_DISPATCH_COORDINATOR = "TurnAdmissionDispatchCoordinator";

/** Narrow durability operation required to settle a plan-question answer. */
export interface PlanAnswerMarker {
  markAnswered(assistantMessageId: string, threadId: string): void;
}

/** A complete command accepted by a parent-turn admission coordinator. */
export type SendMessageCommand = Omit<SendMessageInput, "permissionMode" | "provider"> & {
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
  /** Assistant message whose plan-question batch is settled by this send. */
  markPlanAnswerForMessageId?: string;
  /** Provider payload used instead of the persisted user-facing content. */
  providerWireOverride?: string;
  /** Server-assigned turn identity used by thread-control creation results. */
  sourceTurnId?: string;
  /** Source thread identity for a cross-thread user message origin. */
  sourceThreadId?: string;
  /** Source provider identity for a cross-thread user message origin. */
  sourceProviderId?: string;
  /** Source turn identity for a cross-thread user message origin. */
  originSourceTurnId?: string;
  /** Existing shared mutation reservation supplied by thread-control approval dispatch. */
  mutationReservationToken?: string;
  /** Resolves the authoritative first-turn handshake before provider I/O continues. */
  onTurnStarted?: (snapshot: TurnRuntimeSnapshot) => void;
  /** Starts a new provider execution instead of continuing the thread's prior native session. */
  forceFreshSession?: boolean;
  /** Interrupted execution consumed atomically when the replacement turn starts. */
  retryOfExecutionId?: string;
  /** First-Turn message and attachment data already committed by the automatic Setup gate. */
  persistedUserMessage?: {
    readonly id: string;
    readonly sequence: number;
    readonly attachments: readonly StoredAttachment[];
    readonly persistedAttachments: readonly AttachmentMeta[];
  };
  /** Attachment records already persisted before a concurrent automatic-gate release. */
  persistedAttachmentData?: {
    readonly stored: readonly StoredAttachment[];
    readonly persisted: readonly AttachmentMeta[];
  };
  /** Whether a handled native command must clean pre-persisted automatic-gate attachments. */
  cleanupPersistedAttachmentsOnHandledCommand?: boolean;
};

/** An opaque receipt for a command effect that can be activated or rolled back. */
export type CommandEffectReceipt = GoalCommandEffectReceipt;

/** A runtime admission owned by the AgentService. */
export interface TurnRuntimeLease {
  readonly threadId: string;
  readonly turnExecutionId: string;
  readonly mutationReservationToken: string;
  readonly generation: number;
}

/** The only runtime authority available to turn admission. */
export interface TurnRuntimeAdmissionAuthority {
  reserve(command: SendMessageCommand): TurnRuntimeLease;
  activate(lease: TurnRuntimeLease): void;
  abort(lease: TurnRuntimeLease): Promise<void>;
  release(lease: TurnRuntimeLease): void;
  owns(lease: TurnRuntimeLease): boolean;
}

/** The thread-control action selected during generic dispatch preparation. */
export type ThreadControlLeaseDirective =
  | {
      readonly kind: "activate";
      readonly sessionId: string;
      readonly sourceThreadId: string;
      readonly sourceTurnId: string;
      readonly sourceProviderId: ProviderId;
      readonly permissionMode: "supervised" | "full";
    }
  | { readonly kind: "revoke"; readonly sessionId: string };

/** A provider-ready turn package with no persistence or provider-selection work left. */
export interface PreparedTurnDispatch {
  readonly kind: "dispatch";
  readonly lease: TurnRuntimeLease;
  readonly provider: IAgentProvider;
  readonly providerId: ProviderId;
  readonly request: TurnRequest;
  readonly cwd: string;
  readonly commandEffect: CommandEffectReceipt | null;
  readonly threadControl: ThreadControlLeaseDirective | null;
  readonly contextSeed: number;
  readonly contextWindow: number | null;
}

/** The stable outcome of handling a complete send command. */
export type TurnAdmissionResult =
  | { readonly kind: "handled" }
  | { readonly kind: "queued" }
  | PreparedTurnDispatch;

interface PreparedCommand {
  readonly command: SendMessageCommand;
  readonly thread: ReturnType<ThreadRepo["findById"]> extends infer T ? Exclude<T, null> : never;
  readonly workspace: ReturnType<WorkspaceRepo["findById"]> extends infer T ? Exclude<T, null> : never;
  readonly providerId: ProviderId;
  readonly provider: IAgentProvider;
  readonly mentions: readonly MessageMention[];
  readonly commandEffect: CommandEffectReceipt | null;
  readonly content: string;
  readonly automaticAttachments: PersistedAttachmentData | null;
}

interface PersistedAttachmentData {
  readonly stored: readonly StoredAttachment[];
  readonly persisted: readonly AttachmentMeta[];
}

/** Owns complete message admission, durable parent-turn projection, and dispatch preparation. */
export class TurnAdmissionDispatchCoordinator {
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly messages: MessageRepo,
    private readonly worktrees: GitWorktreeService,
    private readonly attachments: AttachmentService,
    private readonly providers: IProviderRegistry,
    private readonly availability: ProviderAvailabilityService,
    private readonly planAnswers: PlanAnswerMarker,
    private readonly parentTurns: ParentTurnDurability,
    private readonly settings: Pick<SettingsService, "get">,
    private readonly plans: PlanTurnService,
    private readonly goals: GoalLifecycleService,
    private readonly environment: WorkspaceEnvironmentService | undefined,
    private readonly files: FileService | undefined,
    private readonly platform: NodeJS.Platform,
  ) {}

  /** Admit one command and return an immutable package for the runtime owner. */
  async admit(
    command: SendMessageCommand,
    runtime: TurnRuntimeAdmissionAuthority,
  ): Promise<TurnAdmissionResult> {
    const prepared = await this.prepare(command);
    if (prepared.kind !== "ready") return prepared;
    let lease: TurnRuntimeLease | undefined;
    try {
      lease = runtime.reserve(command);
      this.reserveCommandEffect(prepared.value.commandEffect);
      return await this.commit(prepared.value, lease, runtime);
    } catch (error) {
      if (lease) {
        await runtime.abort(lease);
        runtime.release(lease);
      }
      await this.rollbackCommandEffect(prepared.value.commandEffect);
      throw error;
    }
  }

  /** Activate a deferred command effect at the provider-dispatch boundary. */
  async activateCommandEffect(receipt: CommandEffectReceipt | null): Promise<void> {
    if (receipt) await this.goals.dispatchCommandEffect(receipt);
  }

  /** Roll back a dispatched command effect after the turn can no longer run. */
  async rollbackCommandEffect(receipt: CommandEffectReceipt | null): Promise<void> {
    if (!receipt) return;
    try {
      await this.goals.rollbackCommandEffect(receipt);
    } catch (error) {
      logger.warn("Failed to roll back command side effect", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Discard a completed command effect once it no longer needs rollback. */
  completeCommandEffect(receipt: CommandEffectReceipt | null): void {
    if (receipt) this.goals.completeCommandEffect(receipt);
  }

  /** Mark a failed provider dispatch after the runtime retry policy gives up. */
  markDispatchErrored(threadId: string): void {
    this.threads.updateStatus(threadId, "errored");
  }

  /** Mark a committed turn active before its provider receives TurnStarted. */
  markDispatchActive(threadId: string): void {
    this.threads.updateStatus(threadId, "active");
  }

  /** Load the message already persisted by the automatic setup gate. */
  queuedMessage(threadId: string, messageId: string) {
    const message = this.messages.findByIdInThread(threadId, messageId);
    if (!message) throw new Error(`Queued Turn message was not found for Thread: ${threadId}`);
    return message;
  }

  /** Rehydrate an automatic-gate submission as one complete turn command. */
  queuedCommand(submission: WorkspaceEnvironmentQueuedTurnSubmission): SendMessageCommand {
    const message = this.queuedMessage(submission.threadId, submission.messageId);
    return {
      threadId: submission.threadId,
      content: submission.content,
      displayContent: submission.displayContent,
      model: submission.model,
      permissionMode: submission.permissionMode,
      attachments: [],
      provider: submission.provider as ProviderId,
      reasoningLevel: submission.reasoningLevel as SendMessageCommand["reasoningLevel"],
      interactionMode: submission.interactionMode as InteractionMode | undefined,
      orchestrationMode: submission.orchestrationMode as SendMessageCommand["orchestrationMode"],
      maxBudgetUsd: submission.maxBudgetUsd,
      maxTurns: submission.maxTurns,
      copilotAgent: submission.copilotAgent,
      contextWindow: submission.contextWindow as ContextWindowMode | undefined,
      thinking: submission.thinking,
      codexFastMode: submission.codexFastMode,
      goalObjective: submission.goalObjective,
      replyToMessageId: submission.replyToMessageId,
      quotedText: submission.quotedText,
      selectedTextComments: submission.selectedTextComments ? [...submission.selectedTextComments] : undefined,
      planAction: submission.planAction,
      markPlanAnswerForMessageId: submission.markPlanAnswerForMessageId,
      sourceTurnId: submission.sourceTurnId,
      sourceThreadId: submission.sourceThreadId,
      sourceProviderId: submission.sourceProviderId as ProviderId | undefined,
      originSourceTurnId: submission.originSourceTurnId,
      mentions: [...submission.mentions],
      previewAnnotations: submission.previewAnnotations,
      persistedUserMessage: {
        id: message.id,
        sequence: message.sequence,
        attachments: submission.attachments,
        persistedAttachments: submission.persistedAttachments,
      },
    };
  }

  /** Attach a direct thread to a verified existing worktree. */
  async createAttachedExistingWorktreeThread(params: {
    workspaceId: string;
    title: string;
    existingWorktreePath: string;
    provider: ProviderId;
    baseBranch?: string;
    lineage?: { parentThreadId: string; forkedFromMessageId: string };
  }): Promise<Thread> {
    const workspace = this.workspaces.findById(params.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${params.workspaceId}`);
    const known = await this.worktrees.listWorktrees(params.workspaceId);
    const matched = known.find((worktree) => this.sameWorktreePath(worktree.path, params.existingWorktreePath));
    if (!matched) throw new Error("Path is not a recognized worktree");
    const detached = matched.branch === "(detached)";
    const branch = detached ? params.baseBranch : matched.branch;
    if (!branch) throw new Error("Base branch is required when attaching a detached worktree");
    if (detached && branch === "HEAD") throw new Error("Base branch cannot be HEAD when attaching a detached worktree");
    validateBranchName(branch);
    const thread = this.threads.create(
      params.workspaceId, params.title, "worktree", branch, false, params.provider, params.lineage,
      detached ? "branchless" : "named", detached ? branch : null,
    );
    this.threads.updateWorktreePath(thread.id, matched.path);
    return { ...thread, worktree_path: matched.path };
  }

  /** Persist and gate a managed worktree's first turn before runtime admission starts. */
  async admitInitialAutomaticTurn(command: SendMessageCommand): Promise<
    | { readonly kind: "not-managed" }
    | { readonly kind: "queued" }
    | { readonly kind: "ready"; readonly attachments: PersistedAttachmentData }
  > {
    const thread = this.requireThread(command.threadId);
    if (thread.mode !== "worktree" || thread.worktree_managed !== true || !this.environment) {
      return { kind: "not-managed" };
    }
    const providerId = this.selectProvider(thread.provider, command.provider);
    const workspace = this.requireWorkspace(thread.workspace_id);
    const mentions = this.validateMentions({
      workspaceId: workspace.id,
      threadId: thread.id,
      content: command.content,
      mentions: command.mentions ?? [],
      providerId,
    });
    const attachments = await this.persistCommandAttachments(command);
    try {
      const admission = this.environment.admitAutomaticTurn(
        this.automaticSubmission(command, thread, providerId, mentions, attachments),
      );
      return admission.queued ? { kind: "queued" } : { kind: "ready", attachments };
    } catch (error) {
      await this.attachments.removeStoredAttachments(command.threadId, [...attachments.stored]);
      throw error;
    }
  }

  private sameWorktreePath(left: string, right: string): boolean {
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "");
    const known = normalize(left);
    const input = normalize(right);
    return this.platform === "win32" ? known.toLowerCase() === input.toLowerCase() : known === input;
  }

  private async prepare(command: SendMessageCommand): Promise<{ kind: "ready"; value: PreparedCommand } | { kind: "handled" } | { kind: "queued" }> {
    this.requireCompleteProvenance(command);
    const thread = this.requireThread(command.threadId);
    this.requireSendableThread(thread);
    const providerId = this.selectProvider(thread.provider, command.provider);
    this.assertProviderAvailable(command.threadId, providerId);
    const workspace = this.requireWorkspace(thread.workspace_id);
    const mentions = this.validateMentions({
      workspaceId: workspace.id,
      threadId: command.threadId,
      content: command.content,
      mentions: command.mentions ?? [],
      providerId,
    });
    const automatic = await this.admitAutomaticSetup(command, thread, mentions, providerId);
    if (automatic.kind !== "continue") return automatic;
    const provider = this.providers.resolve(providerId);
    const routed = await this.routeCommand(command, provider);
    if (routed.kind === "handled") {
      await this.cleanupHandledAttachments(command.threadId, automatic.handledCommandAttachmentCleanup);
      return routed;
    }
    return {
      kind: "ready",
      value: {
        command,
        thread,
        workspace,
        providerId,
        provider,
        mentions,
        commandEffect: routed.commandEffect,
        content: routed.content,
        automaticAttachments: automatic.attachments,
      },
    };
  }

  private async commit(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    runtime: TurnRuntimeAdmissionAuthority,
  ): Promise<PreparedTurnDispatch> {
    const cwd = this.resolveWorkingDirectory(prepared);
    runtime.activate(lease);
    const attachmentData = await this.persistAttachments(prepared);
    const sourceTurnId = prepared.command.sourceTurnId ?? randomUUID();
    this.startParentTurn(prepared, lease, sourceTurnId, attachmentData);
    this.publishCommittedEffects(prepared, sourceTurnId);
    const wirePayload = this.buildWirePayload(prepared);
    const request = await this.buildTurnRequest(prepared, lease, sourceTurnId, attachmentData, cwd, wirePayload);
    return {
      kind: "dispatch",
      lease,
      provider: prepared.provider,
      providerId: prepared.providerId,
      request,
      cwd,
      commandEffect: prepared.commandEffect,
      threadControl: this.threadControlDirective(prepared, sourceTurnId),
      contextSeed: prepared.thread.last_context_tokens ?? 0,
      contextWindow: prepared.thread.context_window,
    };
  }

  private requireCompleteProvenance(command: SendMessageCommand): void {
    const values = [command.sourceThreadId, command.originSourceTurnId, command.sourceProviderId];
    const any = values.some((value) => value !== undefined);
    const complete = values.every((value) => typeof value === "string" && value.length > 0);
    if (any && !complete) throw new Error("Cross-thread messages require a complete thread provenance tuple");
  }

  private requireThread(threadId: string): Exclude<ReturnType<ThreadRepo["findById"]>, null> {
    const thread = this.threads.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private requireSendableThread(thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>): void {
    if (["failed", "stopped", "archived", "deleted"].includes(thread.status)) {
      throw new Error(`Cannot send message to terminal thread: ${thread.id}`);
    }
    if (thread.deleted_at != null) throw new Error(`Cannot send message to deleted thread: ${thread.id}`);
  }

  private selectProvider(threadProvider: string | null, requested: ProviderId | undefined): ProviderId {
    return requested ?? (threadProvider as ProviderId) ?? "claude";
  }

  private assertProviderAvailable(threadId: string, providerId: ProviderId): void {
    try {
      this.availability.assertUsable(providerId);
    } catch (error) {
      this.publishProviderUnavailable(threadId, providerId, error);
      throw error;
    }
  }

  private publishProviderUnavailable(threadId: string, providerId: ProviderId, error: unknown): void {
    if (!(error instanceof ProviderDisabledError) && !(error instanceof ProviderCliMissingError)) return;
    broadcast("agent.event", {
      type: AgentEventType.ProviderUnavailable,
      threadId,
      providerId,
      reason: error instanceof ProviderDisabledError ? "disabled" : "cli_missing",
      configuredPath: error instanceof ProviderCliMissingError ? error.configuredPath : undefined,
    });
  }

  private requireWorkspace(workspaceId: string): Exclude<ReturnType<WorkspaceRepo["findById"]>, null> {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  private validateMentions(input: {
    workspaceId: string;
    threadId: string;
    content: string;
    mentions: readonly MessageMention[];
    providerId: ProviderId;
  }): MessageMention[] {
    const sorted = [...input.mentions].sort((a, b) => a.range.start - b.range.start);
    let previousEnd = 0;
    for (const mention of sorted) {
      this.validateMention(input, mention, previousEnd);
      previousEnd = mention.range.end;
    }
    return sorted;
  }

  private validateMention(
    input: { workspaceId: string; threadId: string; content: string; providerId: ProviderId },
    mention: MessageMention,
    previousEnd: number,
  ): void {
    const display = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
    if (mention.range.end > input.content.length || input.content.slice(mention.range.start, mention.range.end) !== display) {
      throw new Error(`Invalid mention range for ${display}`);
    }
    if (mention.range.start < previousEnd) throw new Error("Mention ranges must not overlap");
    if (mention.kind === "file") return this.validateFileMention(input, mention.path);
    if (mention.kind !== "command" && input.providerId !== "codex") {
      throw new Error("Provider mentions are only supported by Codex");
    }
  }

  private validateFileMention(input: { workspaceId: string; threadId: string }, path: string): void {
    if (!this.files) throw new Error("File mention validation is unavailable");
    this.files.validateMentionPath(input.workspaceId, path, input.threadId);
  }

  private async admitAutomaticSetup(
    command: SendMessageCommand,
    thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>,
    mentions: readonly MessageMention[],
    providerId: ProviderId,
  ): Promise<
    | {
      kind: "continue";
      attachments: PersistedAttachmentData | null;
      handledCommandAttachmentCleanup: readonly StoredAttachment[] | null;
    }
    | { kind: "queued" }
  > {
    if (!this.isBlockedAutomaticSetup(command, thread)) {
      const attachments = this.suppliedAttachments(command);
      return {
        kind: "continue",
        attachments,
        handledCommandAttachmentCleanup: command.cleanupPersistedAttachmentsOnHandledCommand
          ? attachments?.stored ?? null
          : null,
      };
    }
    const attachments = await this.persistCommandAttachments(command);
    try {
      const admission = this.environment!.admitAutomaticTurn(this.automaticSubmission(command, thread, providerId, mentions, attachments));
      return admission.queued
        ? { kind: "queued" }
        : {
          kind: "continue",
          attachments,
          handledCommandAttachmentCleanup: attachments.stored,
        };
    } catch (error) {
      await this.attachments.removeStoredAttachments(command.threadId, [...attachments.stored]);
      throw error;
    }
  }

  private isBlockedAutomaticSetup(command: SendMessageCommand, thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>): boolean {
    return thread.mode === "worktree"
      && thread.worktree_managed === true
      && this.environment !== undefined
      && !command.persistedUserMessage
      && this.environment.getAutomaticSetup({ threadId: command.threadId }).gate === "blocked";
  }

  private suppliedAttachments(command: SendMessageCommand): PersistedAttachmentData | null {
    if (!command.persistedAttachmentData) return null;
    return {
      stored: [...command.persistedAttachmentData.stored],
      persisted: [...command.persistedAttachmentData.persisted],
    };
  }

  private async persistCommandAttachments(command: SendMessageCommand): Promise<PersistedAttachmentData> {
    const persisted = await this.attachments.persist(command.threadId, [
      ...(command.attachments ?? []),
      ...previewAnnotationSnapshotAttachments(command.previewAnnotations),
    ]);
    return { stored: persisted.stored, persisted: persisted.persisted };
  }

  private automaticSubmission(
    command: SendMessageCommand,
    thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>,
    provider: ProviderId,
    mentions: readonly MessageMention[],
    attachments: PersistedAttachmentData,
  ) {
    const messageId = command.messageId ?? randomUUID();
    return {
      threadId: thread.id,
      messageId,
      content: command.displayContent ?? command.content,
      attachments: [...attachments.stored],
      mentions: [...mentions],
      previewAnnotations: command.previewAnnotations,
      submission: {
        threadId: thread.id,
        messageId,
        content: command.content,
        displayContent: command.displayContent ?? command.content,
        model: command.model ?? "claude-sonnet-4-6",
        permissionMode: command.permissionMode ?? "default",
        attachments: [...attachments.stored],
        persistedAttachments: [...attachments.persisted],
        mentions: [...mentions],
        previewAnnotations: command.previewAnnotations,
        provider,
        reasoningLevel: command.reasoningLevel,
        interactionMode: command.interactionMode,
        orchestrationMode: command.orchestrationMode,
        maxBudgetUsd: command.maxBudgetUsd,
        maxTurns: command.maxTurns,
        copilotAgent: command.copilotAgent,
        contextWindow: command.contextWindow,
        thinking: command.thinking,
        codexFastMode: command.codexFastMode,
        goalObjective: command.goalObjective,
        replyToMessageId: command.replyToMessageId,
        quotedText: command.quotedText,
        selectedTextComments: command.selectedTextComments,
        planAction: command.planAction,
        markPlanAnswerForMessageId: command.markPlanAnswerForMessageId,
        sourceTurnId: command.sourceTurnId,
        sourceThreadId: command.sourceThreadId,
        sourceProviderId: command.sourceProviderId,
        originSourceTurnId: command.originSourceTurnId,
      },
    };
  }

  private async routeCommand(command: SendMessageCommand, provider: IAgentProvider): Promise<{ kind: "handled" } | { kind: "ready"; content: string; commandEffect: CommandEffectReceipt | null }> {
    const outcome = await this.goals.routeCommand(
      { threadId: command.threadId, content: command.content, provider },
      command.goalObjective,
    );
    if (outcome.kind === "handled") {
      logger.info("Handled mcode-native command", { threadId: command.threadId });
      return { kind: "handled" };
    }
    if (outcome.kind === "rewrite") {
      return {
        kind: "ready",
        content: outcome.content,
        commandEffect: "commandEffect" in outcome ? outcome.commandEffect : null,
      };
    }
    return { kind: "ready", content: command.content, commandEffect: null };
  }

  private reserveCommandEffect(receipt: CommandEffectReceipt | null): void {
    if (receipt) this.goals.reserveCommandEffect(receipt);
  }

  private async cleanupHandledAttachments(
    threadId: string,
    attachments: readonly StoredAttachment[] | null,
  ): Promise<void> {
    if (attachments) await this.attachments.removeStoredAttachments(threadId, [...attachments]);
  }

  private resolveWorkingDirectory(prepared: PreparedCommand): string {
    const cwd = this.worktrees.resolveWorkingDir(prepared.workspace.path, prepared.thread.mode, prepared.thread.worktree_path);
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
    }
    return cwd;
  }

  private async persistAttachments(prepared: PreparedCommand): Promise<PersistedAttachmentData> {
    if (prepared.command.persistedUserMessage) {
      return {
        stored: [...prepared.command.persistedUserMessage.attachments],
        persisted: [...prepared.command.persistedUserMessage.persistedAttachments],
      };
    }
    return prepared.automaticAttachments ?? this.persistCommandAttachments(prepared.command);
  }

  private startParentTurn(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    sourceTurnId: string,
    attachments: PersistedAttachmentData,
  ): void {
    const command = prepared.command;
    const wasUserCompleted = prepared.thread.user_completed_at !== null;
    const nextSequence = command.persistedUserMessage?.sequence
      ?? this.messages.getLatestSequenceIncludingInternal(command.threadId) + 1;
    let reopenedThread: Exclude<ReturnType<ThreadRepo["findById"]>, null> | null = null;
    this.parentTurns.startParentTurn({
      thread: {
        id: prepared.thread.id,
        workspaceId: prepared.workspace.id,
        providerId: prepared.providerId,
        createdAt: prepared.thread.created_at,
      },
      turnId: sourceTurnId,
      executionId: lease.turnExecutionId,
      permissionMode: this.effectivePermissionMode(command.permissionMode, prepared.thread.permission_mode ?? "supervised"),
      providerIdentities: this.resumeIdentities(prepared),
      retryOfExecutionId: command.retryOfExecutionId,
      projectUserMessage: () => {
        if (wasUserCompleted) reopenedThread = this.reopenThread(command.threadId);
        const message = this.persistUserMessage(prepared, nextSequence, attachments);
        this.markPlanAnswer(command, prepared.thread.id);
        return message;
      },
    });
    if (reopenedThread) broadcast("thread.lifecycleChanged", { thread: reopenedThread });
  }

  private effectivePermissionMode(requested: PermissionMode | "default" | undefined, persisted: PermissionMode): "full" | "supervised" {
    return requested === "full" || (requested === "default" && persisted === "full") ? "full" : "supervised";
  }

  private resumeIdentities(prepared: PreparedCommand) {
    const { command, thread, providerId } = prepared;
    if (command.forceFreshSession || !thread.sdk_session_id || providerId !== thread.provider) return [];
    return [{
      providerId,
      scope: providerId === "codex" ? "thread" as const : "session" as const,
      value: thread.sdk_session_id,
      provenance: "native" as const,
    }];
  }

  private reopenThread(threadId: string): Exclude<ReturnType<ThreadRepo["findById"]>, null> {
    const reopened = this.threads.reopen(threadId);
    if (!reopened) throw new Error(`Thread not found: ${threadId}`);
    return reopened;
  }

  private persistUserMessage(prepared: PreparedCommand, sequence: number, attachments: PersistedAttachmentData) {
    const command = prepared.command;
    if (command.persistedUserMessage) return this.persistedQueuedMessage(command);
    const origin = this.messageOrigin(command);
    return this.createUserMessage(prepared, sequence, attachments, origin);
  }

  private persistedQueuedMessage(command: SendMessageCommand) {
    const message = this.messages.findByIdInThread(command.threadId, command.persistedUserMessage!.id);
    if (!message) throw new Error(`Queued Turn message was not found: ${command.persistedUserMessage!.id}`);
    return message;
  }

  private messageOrigin(command: SendMessageCommand) {
    if (!command.sourceThreadId || !command.originSourceTurnId || !command.sourceProviderId) return undefined;
    return {
      type: "thread" as const,
      sourceThreadId: command.sourceThreadId,
      sourceTurnId: command.originSourceTurnId,
      sourceProviderId: command.sourceProviderId,
    };
  }

  private createUserMessage(
    prepared: PreparedCommand,
    sequence: number,
    attachments: PersistedAttachmentData,
    origin: ReturnType<TurnAdmissionDispatchCoordinator["messageOrigin"]>,
  ) {
    const command = prepared.command;
    const args = [
      command.threadId,
      "user" as const,
      command.displayContent ?? command.content,
      sequence,
      attachments.stored.length > 0 ? [...attachments.stored] : undefined,
      command.replyToMessageId,
      command.quotedText,
      undefined,
      undefined,
      prepared.mentions.length > 0 ? [...prepared.mentions] : undefined,
      command.previewAnnotations,
    ] as const;
    if (command.selectedTextComments !== undefined) {
      return this.messages.create(...args, origin, command.messageId, command.selectedTextComments);
    }
    if (command.messageId === undefined && origin === undefined) return this.messages.create(...args);
    if (command.messageId === undefined) return this.messages.create(...args, origin);
    if (origin === undefined) return this.messages.create(...args, undefined, command.messageId);
    return this.messages.create(...args, origin, command.messageId);
  }

  private markPlanAnswer(command: SendMessageCommand, threadId: string): void {
    if (command.markPlanAnswerForMessageId) this.planAnswers.markAnswered(command.markPlanAnswerForMessageId, threadId);
  }

  private publishCommittedEffects(prepared: PreparedCommand, sourceTurnId: string): void {
    this.publishPlanAnswer(prepared.command);
    const command = prepared.command;
    if (command.planAction === "revise") this.plans.beginOutputGeneration(command.threadId);
    if (this.effectiveInteractionMode(command) === "plan") this.plans.beginQuestionGeneration(command.threadId);
    this.persistThreadSettings(prepared);
    void sourceTurnId;
  }

  private publishPlanAnswer(command: SendMessageCommand): void {
    if (!command.markPlanAnswerForMessageId) return;
    broadcast("plan.answered", { threadId: command.threadId, assistantMessageId: command.markPlanAnswerForMessageId });
  }

  private persistThreadSettings(prepared: PreparedCommand): void {
    const command = prepared.command;
    const model = command.model ?? "claude-sonnet-4-6";
    this.threads.updateModel(command.threadId, model);
    if (command.provider !== undefined) this.threads.updateProvider(command.threadId, prepared.providerId);
    this.threads.updateSettings(command.threadId, this.threadSettings(command, prepared.providerId));
    broadcast("thread.modelUpdated", {
      threadId: command.threadId,
      model,
      provider: command.provider ?? (prepared.thread.provider as ProviderId) ?? "claude",
    });
  }

  private threadSettings(command: SendMessageCommand, providerId: ProviderId) {
    const settings: Record<string, unknown> = {};
    this.assignSetting(settings, "reasoning_level", command.reasoningLevel);
    this.assignSetting(settings, "interaction_mode", command.interactionMode);
    this.assignSetting(settings, "orchestration_mode", command.orchestrationMode);
    this.assignPermissionSetting(settings, command.permissionMode);
    this.assignSetting(settings, "context_window_mode", command.contextWindow);
    this.assignSetting(settings, "thinking", command.thinking);
    this.assignSetting(settings, "copilot_agent", command.copilotAgent);
    this.assignCodexFastMode(settings, command.codexFastMode, providerId);
    return settings;
  }

  private assignSetting(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined) target[key] = value;
  }

  private assignPermissionSetting(target: Record<string, unknown>, value: PermissionMode | "default" | undefined): void {
    if (value !== undefined && value !== "default") target.permission_mode = value;
  }

  private assignCodexFastMode(target: Record<string, unknown>, value: boolean | undefined, providerId: ProviderId): void {
    if (providerId === "codex" && value !== undefined) target.codex_fast_mode = value;
  }

  private buildWirePayload(prepared: PreparedCommand): string {
    let payload = this.withPlanInstructions(prepared);
    if (this.effectiveInteractionMode(prepared.command) === "plan" && prepared.command.providerWireOverride === undefined) {
      payload = this.plans.buildQuestionPrompt(payload);
    }
    if (prepared.command.replyToMessageId && prepared.command.providerWireOverride === undefined) {
      payload = this.withReplyContext(prepared, payload);
    }
    const providerPayload = prepared.command.providerWireOverride ?? payload;
    return prepared.providerId === "codex" ? providerPayload : this.injectMentionFileContents(prepared, providerPayload);
  }

  private withPlanInstructions(prepared: PreparedCommand): string {
    const command = prepared.command;
    if (command.planAction !== "revise") return prepared.content;
    return `${prepared.content}\n\n${this.plans.buildPlanOutputInstructions()}`;
  }

  private effectiveInteractionMode(command: SendMessageCommand): InteractionMode | undefined {
    return command.planAction === "revise" || command.planAction === "implement" ? undefined : command.interactionMode;
  }

  private withReplyContext(prepared: PreparedCommand, payload: string): string {
    const command = prepared.command;
    const target = this.messages.findByIdInThread(command.threadId, command.replyToMessageId!);
    if (!target) return payload;
    const body = command.quotedText ? command.quotedText.slice(0, 2000) : target.content.slice(0, 2000);
    const original = command.quotedText ?? target.content;
    const suffix = body.length < original.length ? "..." : "";
    return `<reply-to role="${target.role}" sequence="${target.sequence}">\n${escapeXml(body)}${suffix}\n</reply-to>\n\n${payload}`;
  }

  private injectMentionFileContents(prepared: PreparedCommand, text: string): string {
    const paths = new Set<string>();
    const files: Array<{ path: string; content: string }> = [];
    for (const mention of prepared.mentions) {
      if (mention.kind !== "file" || paths.has(mention.path)) continue;
      if (!this.files) throw new Error("File mention injection is unavailable");
      paths.add(mention.path);
      files.push({ path: mention.path, content: this.files.read(prepared.workspace.id, mention.path, prepared.command.threadId) });
    }
    return buildInjectedFileMessage(text, files);
  }

  private async buildTurnRequest(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    sourceTurnId: string,
    attachments: PersistedAttachmentData,
    cwd: string,
    message: string,
  ): Promise<TurnRequest> {
    const settings = await this.settings.get();
    const model = prepared.command.model ?? "claude-sonnet-4-6";
    const guardrails = this.guardrails(prepared.command, settings);
    return {
      sessionId: `mcode-${prepared.command.threadId}`,
      turnExecutionId: lease.turnExecutionId,
      turnId: sourceTurnId,
      deliveryAttempt: 1,
      workspaceId: prepared.workspace.id,
      threadId: prepared.command.threadId,
      message,
      mentions: prepared.mentions.length > 0 ? prepared.mentions : undefined,
      cwd,
      model,
      fallbackModel: this.fallbackModel(settings, model),
      permissionMode: prepared.command.permissionMode ?? "default",
      interactionMode: this.effectiveInteractionMode(prepared.command) ?? "build",
      orchestrationMode: prepared.command.orchestrationMode ?? prepared.thread.orchestration_mode ?? "standard",
      attachments: attachments.persisted.length > 0 ? attachments.persisted : undefined,
      reasoningLevel: prepared.command.reasoningLevel,
      ...guardrails,
      threadControlEligible: this.isThreadControlEligible(prepared),
      resumeFrom: this.resumeFrom(prepared, attachments),
      providerOptions: this.providerOptions(prepared, settings),
    } as TurnRequest;
  }

  private fallbackModel(settings: ReturnType<SettingsService["get"]>, model: string): string | undefined {
    const fallback = settings.model.defaults.fallbackId;
    return fallback && fallback !== model ? fallback : undefined;
  }

  private guardrails(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>) {
    const maxBudgetUsd = this.effectiveBudget(command, settings);
    const maxTurns = this.effectiveTurns(command, settings);
    return {
      ...(maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      ...(maxTurns > 0 ? { maxTurns } : {}),
    };
  }

  private providerOptions(prepared: PreparedCommand, settings: ReturnType<SettingsService["get"]>) {
    const defaults = this.providerDefaults(prepared, settings);
    return this.providerSpecificOptions(prepared.providerId, defaults);
  }

  private providerDefaults(prepared: PreparedCommand, settings: ReturnType<SettingsService["get"]>) {
    const command = prepared.command;
    return {
      contextWindow: this.contextWindowDefault(command, prepared, settings),
      thinking: this.thinkingDefault(command, prepared, settings),
      fastMode: this.fastModeDefault(command, prepared, settings),
      copilotAgent: command.copilotAgent ?? prepared.thread.copilot_agent ?? undefined,
    };
  }

  private contextWindowDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): ContextWindowMode {
    return command.contextWindow
      ?? (prepared.thread.context_window_mode as ContextWindowMode | null)
      ?? settings.model.defaults.contextWindow;
  }

  private thinkingDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): boolean {
    return command.thinking ?? prepared.thread.thinking ?? settings.model.defaults.thinking;
  }

  private fastModeDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): boolean {
    return command.codexFastMode
      ?? prepared.thread.codex_fast_mode
      ?? settings.provider?.codex?.fastMode
      ?? false;
  }

  private providerSpecificOptions(
    providerId: ProviderId,
    defaults: { contextWindow: ContextWindowMode; thinking: boolean; fastMode: boolean; copilotAgent: string | undefined },
  ) {
    if (providerId === "claude") return { contextWindowMode: defaults.contextWindow, thinking: defaults.thinking };
    if (providerId === "codex") return { fastMode: defaults.fastMode };
    if (providerId === "copilot") return { agent: defaults.copilotAgent };
    return {};
  }

  private effectiveBudget(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>): number {
    return command.maxBudgetUsd ?? settings.agent.guardrails.maxBudgetUsd;
  }

  private effectiveTurns(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>): number {
    return command.maxTurns ?? settings.agent.guardrails.maxTurns;
  }

  private resumeFrom(prepared: PreparedCommand, attachments: PersistedAttachmentData): string | undefined {
    const nextSequence = prepared.command.persistedUserMessage?.sequence
      ?? this.messages.getLatestSequenceIncludingInternal(prepared.command.threadId);
    void attachments;
    return !prepared.command.forceFreshSession && nextSequence > 1 ? prepared.thread.sdk_session_id ?? undefined : undefined;
  }

  private isThreadControlEligible(prepared: PreparedCommand): boolean {
    return supportsInternalThreadControl(prepared.providerId) && isExplicitMcodeThreadRequest(prepared.command.content);
  }

  private threadControlDirective(prepared: PreparedCommand, sourceTurnId: string): ThreadControlLeaseDirective | null {
    if (!supportsInternalThreadControl(prepared.providerId)) return null;
    const sessionId = `mcode-${prepared.command.threadId}`;
    if (!this.isThreadControlEligible(prepared)) return { kind: "revoke", sessionId };
    return {
      kind: "activate",
      sessionId,
      sourceThreadId: prepared.command.threadId,
      sourceTurnId,
      sourceProviderId: prepared.providerId,
      permissionMode: prepared.command.permissionMode === "full" ? "full" : "supervised",
    };
  }

}

/** Return whether a provider receives the internal thread-control lease. */
export function supportsInternalThreadControl(provider: ProviderId): boolean {
  return provider === "claude" || provider === "codex" || provider === "cursor" || provider === "copilot";
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildInjectedFileMessage(text: string, files: readonly { path: string; content: string }[]): string {
  if (files.length === 0) return text;
  const blocks = files.map((file) => {
    const content = file.content.replace(/<\/file>/gi, "<\\/file>");
    const path = file.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<file path="${path}">\n${content}\n</file>`;
  }).join("\n");
  return `${text}${FILE_INJECTION_SEPARATOR}${blocks}`;
}
