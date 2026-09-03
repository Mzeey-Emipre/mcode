import { inject, injectable } from "tsyringe";
import type {
  ContextWindowMode,
  CreateAndSendInput,
  InteractionMode,
  OrchestrationMode,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  Thread,
} from "@mcode/contracts";

import { ThreadService } from "../../thread-control/index.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { ThreadBranchingService } from "../../projects/worktrees/thread-branching-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import {
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  type SendMessageCommand,
  TurnAdmissionDispatchCoordinator,
} from "./turn-admission-dispatch-coordinator.js";

const nonterminalStartupStates = new Set(["pending", "running", "blocked"]);

/** Command that provisions a thread and starts its first runtime turn. */
export type CreateAndSendCommand = Omit<
  CreateAndSendInput,
  "model" | "permissionMode" | "provider"
> & {
  model?: string;
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
};

/** A newly provisioned thread plus its first admitted runtime command. */
export type CreatedInitialTurn =
  | { readonly kind: "queued"; readonly thread: Thread & { warnings?: string[] }; readonly startupId?: string }
  | { readonly kind: "dispatch"; readonly thread: Thread & { warnings?: string[] }; readonly command: SendMessageCommand; readonly startupId?: string };

/** Input for a direct or managed-worktree thread provisioned before its first turn. */
export interface CreateThreadForTurnInput {
  workspaceId: string;
  title: string;
  mode: "direct" | "worktree";
  branch: string;
  worktreeBranchMode?: "branchless" | "named";
  provider: ProviderId;
  model: string;
  permissionMode: PermissionMode | "default";
  reasoningLevel?: ReasoningLevel;
  interactionMode?: InteractionMode;
  orchestrationMode?: OrchestrationMode;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  copilotAgent?: string;
  codexFastMode?: boolean;
}

interface BranchedInitialTurnParams {
  workspaceId: string;
  content: string;
  model: string;
  permissionMode: PermissionMode | "default";
  mode: "direct" | "worktree";
  branch: string;
  worktreeBranchMode?: "branchless" | "named";
  existingWorktreePath?: string;
  existingWorktreeBaseBranch?: string;
  attachments: SendMessageCommand["attachments"];
  reasoningLevel?: ReasoningLevel;
  provider: ProviderId;
  interactionMode?: InteractionMode;
  parentThreadId: string | undefined;
  forkedFromMessageId?: string;
  title: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  copilotAgent?: string;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
  displayContent?: string;
  mentions: SendMessageCommand["mentions"];
  previewAnnotations?: SendMessageCommand["previewAnnotations"];
  selectedTextComments?: SendMessageCommand["selectedTextComments"];
  goalObjective?: string;
  orchestrationMode?: OrchestrationMode;
}

class StartupCancelledError extends Error {
  constructor() {
    super("Thread startup was cancelled");
  }
}

/** Owns persistence and worktree provisioning for a thread before first-turn admission. */
@injectable()
export class ThreadCreationCoordinator {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    private readonly threadService: () => ThreadService,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR) private readonly admissions: TurnAdmissionDispatchCoordinator,
    private readonly branching?: () => ThreadBranchingService | undefined,
    private readonly plans: () => PlanTurnService | undefined = () => undefined,
    private readonly startups: () => ThreadStartupService | undefined = () => undefined,
  ) {}

  /** Provision a thread and prepare its first command without acquiring runtime authority. */
  async createInitialTurn(command: CreateAndSendCommand): Promise<CreatedInitialTurn> {
    const params = this.initialTurnParams(command);
    return params.parentThreadId
      ? this.createBranchedInitialTurn(params as BranchedInitialTurnParams & { parentThreadId: string })
      : this.createStandaloneInitialTurn(command, params);
  }

  /** Enter the first runtime phase after direct thread provisioning. */
  startInitialAgent(startupId: string | undefined): void {
    if (startupId) this.startups()?.advance(startupId, "agent");
  }

  /** Complete a startup only after its first provider runtime has authoritative admission. */
  completeInitialAgent(startupId: string | undefined): void {
    if (startupId) this.startups()?.complete(startupId);
  }

  /** Preserve an initial provider dispatch failure on its current startup phase. */
  failInitialAgent(startupId: string | undefined): void {
    if (startupId) this.startups()?.fail(startupId, {
      code: "AGENT_START_FAILED",
      message: "Agent startup failed",
      retryable: true,
    });
  }

  /** Advance a released automatic Setup Turn into agent startup. */
  startQueuedAgent(threadId: string): string | null | undefined {
    const startup = this.startups()?.findByThreadId(threadId);
    if (!startup) return undefined;
    if (startup.cancellation === "requested") {
      if (nonterminalStartupStates.has(startup.state)) {
        this.startups()?.markCancelled(startup.startupId);
      }
      return null;
    }
    if (startup.state !== "running") return undefined;
    if (startup.phase === "setup") {
      this.startups()?.advance(startup.startupId, "agent");
    }
    return startup.startupId;
  }

  /** Confirm that cancellation has not won before the queued provider turn reserves runtime ownership. */
  canAdmitQueuedAgent(threadId: string, startupId: string | undefined): boolean {
    const startup = this.startups()?.findByThreadId(threadId);
    if (!startup) return startupId === undefined;
    if (startup.startupId !== startupId) return false;
    if (startup.cancellation === "requested") {
      if (nonterminalStartupStates.has(startup.state)) {
        this.startups()?.markCancelled(startup.startupId);
      }
      return false;
    }
    return startup.state === "running" && startup.phase === "agent";
  }

  private initialTurnParams(command: CreateAndSendCommand): BranchedInitialTurnParams {
    const {
      workspaceId,
      content,
      model = "claude-sonnet-4-6",
      permissionMode = "default",
      mode = "direct",
      branch = "main",
      worktreeBranchMode = "branchless",
      existingWorktreePath,
      existingWorktreeBaseBranch,
      attachments = [],
      reasoningLevel,
      provider = "claude",
      interactionMode,
      parentThreadId,
      forkedFromMessageId,
      maxBudgetUsd,
      maxTurns,
      copilotAgent,
      contextWindow: contextWindowMode,
      thinking,
      codexFastMode,
      displayContent,
      mentions = [],
      previewAnnotations,
      selectedTextComments,
      goalObjective,
      orchestrationMode,
    } = command;
    const params: BranchedInitialTurnParams = {
      workspaceId, content, model, permissionMode, mode, branch, worktreeBranchMode,
      existingWorktreePath, existingWorktreeBaseBranch, attachments, reasoningLevel,
      provider, interactionMode, parentThreadId, forkedFromMessageId,
      title: titleFrom(displayContent ?? content), maxBudgetUsd, maxTurns, copilotAgent,
      contextWindowMode, thinking, codexFastMode, displayContent, mentions,
      previewAnnotations, selectedTextComments, goalObjective, orchestrationMode,
    };
    return params;
  }

  private async createStandaloneInitialTurn(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
  ): Promise<CreatedInitialTurn> {
    const startup = this.startStartup(command, params);
    const creation = {
      workspaceId: params.workspaceId,
      title: params.title,
      mode: params.mode,
      branch: params.branch,
      worktreeBranchMode: params.worktreeBranchMode,
      provider: params.provider,
      model: params.model,
      permissionMode: params.permissionMode,
      reasoningLevel: params.reasoningLevel,
      interactionMode: params.interactionMode,
      orchestrationMode: params.orchestrationMode,
      contextWindowMode: params.contextWindowMode,
      thinking: params.thinking,
      copilotAgent: params.copilotAgent,
      codexFastMode: params.codexFastMode,
    };
    try {
      const thread = await this.createStandaloneThread(params, creation, startup?.startupId);
      this.startManagedSetup(startup?.startupId, startup?.kind);
      const automatic = await this.admitInitialTurn(command, params, thread.id);
      return this.initialTurnResult(command, params, thread, automatic, startup?.startupId);
    } catch (error) {
      if (error instanceof StartupCancelledError) throw error;
      this.failStartup(startup?.startupId);
      throw error;
    }
  }

  /** Create and configure a thread without starting a provider runtime. */
  async create(input: CreateThreadForTurnInput, startupId?: string): Promise<Thread & { warnings?: string[] }> {
    const created = input.mode === "worktree"
      ? await this.createManagedThread(input, startupId)
      : this.threads.create(input.workspaceId, input.title, "direct", input.branch, true, input.provider);
    if (startupId && input.mode === "direct") this.startups()?.bindThread(startupId, created.id);
    return this.configure(created, input);
  }

  private async createStandaloneThread(
    params: BranchedInitialTurnParams,
    creation: CreateThreadForTurnInput,
    startupId: string | undefined,
  ): Promise<Thread & { warnings?: string[] }> {
    if (!params.existingWorktreePath) return await this.create(creation, startupId);
    const attached = await this.admissions.createAttachedExistingWorktreeThread({
      workspaceId: params.workspaceId,
      title: params.title,
      existingWorktreePath: params.existingWorktreePath,
      provider: params.provider,
      baseBranch: params.existingWorktreeBaseBranch,
    });
    const thread = this.configure(attached, creation);
    if (startupId) this.startups()?.bindThread(startupId, thread.id);
    this.cancelIfRequested(startupId);
    return thread;
  }

  private startManagedSetup(startupId: string | undefined, kind: string | undefined): void {
    if (startupId && kind === "managed-worktree") this.startups()?.advance(startupId, "setup");
  }

  private async admitInitialTurn(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    threadId: string,
  ) {
    return await this.admissions.admitInitialAutomaticTurn({
      ...command,
      threadId,
      content: params.content,
      permissionMode: params.permissionMode,
      model: params.model,
      attachments: params.attachments,
      provider: params.provider,
      reasoningLevel: params.reasoningLevel,
      interactionMode: params.interactionMode,
      maxBudgetUsd: params.maxBudgetUsd,
      maxTurns: params.maxTurns,
      copilotAgent: params.copilotAgent,
      contextWindow: params.contextWindowMode,
      thinking: params.thinking,
      displayContent: params.displayContent,
      mentions: params.mentions,
      previewAnnotations: params.previewAnnotations,
      selectedTextComments: params.selectedTextComments,
      goalObjective: params.goalObjective,
      orchestrationMode: params.orchestrationMode,
      codexFastMode: params.codexFastMode,
    });
  }

  private initialTurnResult(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    thread: Thread & { warnings?: string[] },
    automatic: Awaited<ReturnType<TurnAdmissionDispatchCoordinator["admitInitialAutomaticTurn"]>>,
    startupId: string | undefined,
  ): CreatedInitialTurn {
    if (automatic.kind === "queued") return { kind: "queued", thread, ...(startupId ? { startupId } : {}) };
    return {
      kind: "dispatch",
      thread,
      ...(startupId ? { startupId } : {}),
      command: {
        ...command,
        threadId: thread.id,
        content: params.content,
        permissionMode: params.permissionMode,
        model: params.model,
        attachments: automatic.kind === "ready" ? [] : params.attachments,
        provider: params.provider,
        reasoningLevel: params.reasoningLevel,
        interactionMode: params.interactionMode,
        maxBudgetUsd: params.maxBudgetUsd,
        maxTurns: params.maxTurns,
        copilotAgent: params.copilotAgent,
        contextWindow: params.contextWindowMode,
        thinking: params.thinking,
        displayContent: params.displayContent,
        mentions: params.mentions,
        previewAnnotations: params.previewAnnotations,
        selectedTextComments: params.selectedTextComments,
        goalObjective: params.goalObjective,
        orchestrationMode: params.orchestrationMode,
        ...(automatic.kind === "ready" ? {
          persistedAttachmentData: automatic.attachments,
          cleanupPersistedAttachmentsOnHandledCommand: true,
        } : {}),
      },
    };
  }

  private async createManagedThread(
    input: CreateThreadForTurnInput,
    startupId: string | undefined,
  ): Promise<Thread & { warnings?: string[] }> {
    const created = await this.threadService().create(input.workspaceId, input.title, "worktree", input.branch, {
      branchless: input.worktreeBranchMode !== "named",
      ...this.managedLifecycle(startupId),
    });
    if (startupId && this.startups()?.isCancellationRequested(startupId)) {
      await this.threadService().delete(created.id, true);
      this.startups()?.markCancelled(startupId);
      throw new StartupCancelledError();
    }
    return created;
  }

  private managedLifecycle(startupId: string | undefined): { lifecycle?: { onThreadPersisted(thread: Thread): void } } {
    if (!startupId) return {};
    return {
      lifecycle: {
        onThreadPersisted: (thread) => {
          this.startups()?.bindThread(startupId, thread.id);
          this.startups()?.advance(startupId, "worktree");
          this.cancelIfRequested(startupId);
        },
      },
    };
  }

  private startStartup(command: CreateAndSendCommand, params: BranchedInitialTurnParams) {
    if (!command.startupId) return undefined;
    const startupService = this.startups();
    if (!startupService) return undefined;
    const startup = startupService.start({
      startupId: command.startupId,
      workspaceId: params.workspaceId,
      kind: params.mode === "worktree" && !params.existingWorktreePath
        ? "managed-worktree"
        : "direct",
    });
    startupService.advance(startup.startupId, "thread");
    this.cancelIfRequested(startup.startupId);
    return startup;
  }

  private cancelIfRequested(startupId: string | undefined): void {
    if (!startupId || !this.startups()?.isCancellationRequested(startupId)) return;
    this.startups()?.markCancelled(startupId);
    throw new StartupCancelledError();
  }

  private failStartup(startupId: string | undefined): void {
    if (!startupId) return;
    const startup = this.startups()?.get(startupId);
    if (!startup || startup.state === "blocked") return;
    const error = startup.phase === "thread"
      ? { code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true }
      : startup.phase === "worktree"
        ? { code: "WORKTREE_PREPARATION_FAILED", message: "Worktree preparation failed", retryable: true }
        : { code: "SETUP_ADMISSION_FAILED", message: "Project Setup admission failed", retryable: true };
    this.startups()?.fail(startupId, error);
  }

  /** Apply first-turn provider settings to an already-provisioned thread. */
  configure(
    created: Thread & { warnings?: string[] },
    input: CreateThreadForTurnInput,
  ): Thread & { warnings?: string[] } {
    this.threads.updateProvider(created.id, input.provider);
    this.threads.updateModel(created.id, input.model);
    this.threads.updateSettings(created.id, this.settings(input));
    return this.configuredThread(created, input);
  }

  private configuredThread(
    created: Thread & { warnings?: string[] },
    input: CreateThreadForTurnInput,
  ): Thread & { warnings?: string[] } {
    return {
      ...created,
      provider: input.provider,
      model: input.model,
      ...this.retainedSettings(created, input),
      ...this.fastModeSetting(created, input),
      ...this.warnings(created),
    };
  }

  private retainedSettings(created: Thread, input: CreateThreadForTurnInput) {
    return {
      reasoning_level: input.reasoningLevel ?? created.reasoning_level,
      interaction_mode: input.interactionMode ?? created.interaction_mode,
      orchestration_mode: input.orchestrationMode ?? created.orchestration_mode,
      permission_mode: input.permissionMode === "default" ? created.permission_mode : input.permissionMode,
      context_window_mode: input.contextWindowMode ?? created.context_window_mode,
      thinking: input.thinking ?? created.thinking,
      copilot_agent: input.copilotAgent ?? created.copilot_agent,
    };
  }

  private fastModeSetting(created: Thread, input: CreateThreadForTurnInput) {
    return {
      codex_fast_mode: input.provider === "codex" && input.codexFastMode !== undefined
        ? input.codexFastMode
        : created.codex_fast_mode,
    };
  }

  private warnings(created: Thread & { warnings?: string[] }) {
    return created.warnings?.length ? { warnings: created.warnings } : {};
  }

  private settings(input: CreateThreadForTurnInput): {
    reasoning_level?: string;
    interaction_mode?: string;
    orchestration_mode?: string;
    permission_mode?: string;
    context_window_mode?: ContextWindowMode;
    thinking?: boolean;
    copilot_agent?: string;
    codex_fast_mode?: boolean;
  } {
    return {
      ...(input.reasoningLevel !== undefined && { reasoning_level: input.reasoningLevel }),
      ...(input.interactionMode !== undefined && { interaction_mode: input.interactionMode }),
      ...(input.orchestrationMode !== undefined && { orchestration_mode: input.orchestrationMode }),
      ...(input.permissionMode !== "default" && { permission_mode: input.permissionMode }),
      ...(input.contextWindowMode !== undefined && { context_window_mode: input.contextWindowMode }),
      ...(input.thinking !== undefined && { thinking: input.thinking }),
      ...(input.copilotAgent !== undefined && { copilot_agent: input.copilotAgent }),
      ...(input.provider === "codex" && input.codexFastMode !== undefined && { codex_fast_mode: input.codexFastMode }),
    };
  }

  private async createBranchedInitialTurn(
    params: BranchedInitialTurnParams & { parentThreadId: string },
  ): Promise<CreatedInitialTurn> {
    const branching = this.branching?.();
    if (!branching) throw new Error("Thread branching is not configured");
    const provisioned = await branching.create({
      workspaceId: params.workspaceId,
      content: params.content,
      model: params.model,
      permissionMode: params.permissionMode,
      mode: params.mode,
      branch: params.branch,
      worktreeBranchMode: params.worktreeBranchMode,
      existingWorktreePath: params.existingWorktreePath,
      existingWorktreeBaseBranch: params.existingWorktreeBaseBranch,
      reasoningLevel: params.reasoningLevel,
      provider: params.provider,
      interactionMode: params.interactionMode,
      parentThreadId: params.parentThreadId,
      forkedFromMessageId: params.forkedFromMessageId,
      title: params.title,
      copilotAgent: params.copilotAgent,
      contextWindowMode: params.contextWindowMode,
      thinking: params.thinking,
      codexFastMode: params.codexFastMode,
      orchestrationMode: params.orchestrationMode,
    });
    const providerWireOverride = params.interactionMode === "plan"
      ? this.plans()?.buildQuestionPrompt(provisioned.providerWireOverride) ?? provisioned.providerWireOverride
      : provisioned.providerWireOverride;
    return {
      kind: "dispatch",
      thread: {
        ...provisioned.thread,
        ...(provisioned.warnings?.length ? { warnings: provisioned.warnings } : {}),
      },
      command: {
        threadId: provisioned.thread.id,
        content: params.content,
        permissionMode: params.permissionMode,
        model: params.model,
        attachments: params.attachments,
        reasoningLevel: params.reasoningLevel,
        provider: params.provider,
        interactionMode: params.interactionMode,
        maxBudgetUsd: params.maxBudgetUsd,
        maxTurns: params.maxTurns,
        copilotAgent: params.copilotAgent,
        contextWindow: provisioned.contextWindowMode,
        thinking: provisioned.thinking,
        codexFastMode: provisioned.codexFastMode,
        providerWireOverride,
        displayContent: params.displayContent,
        mentions: params.mentions,
        previewAnnotations: params.previewAnnotations,
        selectedTextComments: params.selectedTextComments,
        goalObjective: params.goalObjective,
        orchestrationMode: params.orchestrationMode,
      },
    };
  }
}

function titleFrom(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 50) return firstLine || "New Thread";
  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > 0 ? lastSpace : 50;
  return truncated.slice(0, cutPoint) + "...";
}
