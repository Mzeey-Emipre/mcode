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
import {
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  type SendMessageCommand,
  TurnAdmissionDispatchCoordinator,
} from "./turn-admission-dispatch-coordinator.js";

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
  | { readonly kind: "queued"; readonly thread: Thread & { warnings?: string[] } }
  | { readonly kind: "dispatch"; readonly thread: Thread & { warnings?: string[] }; readonly command: SendMessageCommand };

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

/** Owns persistence and worktree provisioning for a thread before first-turn admission. */
@injectable()
export class ThreadCreationCoordinator {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    private readonly threadService: () => ThreadService,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR) private readonly admissions: TurnAdmissionDispatchCoordinator,
    private readonly branching?: () => ThreadBranchingService | undefined,
    private readonly plans: () => PlanTurnService | undefined = () => undefined,
  ) {}

  /** Provision a thread and prepare its first command without acquiring runtime authority. */
  async createInitialTurn(command: CreateAndSendCommand): Promise<CreatedInitialTurn> {
    const params = this.initialTurnParams(command);
    return params.parentThreadId
      ? this.createBranchedInitialTurn(params as BranchedInitialTurnParams & { parentThreadId: string })
      : this.createStandaloneInitialTurn(command, params);
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
    const thread = params.existingWorktreePath
      ? this.configure(await this.admissions.createAttachedExistingWorktreeThread({
        workspaceId: params.workspaceId,
        title: params.title,
        existingWorktreePath: params.existingWorktreePath,
        provider: params.provider,
        baseBranch: params.existingWorktreeBaseBranch,
      }), creation)
      : await this.create(creation);
    const automatic = await this.admissions.admitInitialAutomaticTurn({
      ...command,
      threadId: thread.id,
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
    if (automatic.kind === "queued") return { kind: "queued", thread };
    return {
      kind: "dispatch",
      thread,
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

  /** Create and configure a thread without starting a provider runtime. */
  async create(input: CreateThreadForTurnInput): Promise<Thread & { warnings?: string[] }> {
    const created = input.mode === "worktree"
      ? await this.threadService().create(input.workspaceId, input.title, "worktree", input.branch, {
        branchless: input.worktreeBranchMode !== "named",
      })
      : this.threads.create(input.workspaceId, input.title, "direct", input.branch, true, input.provider);
    return this.configure(created, input);
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
