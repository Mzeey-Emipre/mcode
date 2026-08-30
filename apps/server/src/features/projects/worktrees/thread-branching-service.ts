import { inject, injectable } from "tsyringe";
import { validateBranchName } from "@mcode/shared";
import type {
  ContextWindowMode,
  ForkHistoryBudget,
  InteractionMode,
  Message,
  OrchestrationMode,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  Thread,
} from "@mcode/contracts";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { ThreadService } from "../../thread-control/index.js";
import { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import { HandoffCoordinator } from "../../handoff/index.js";
import { GitWorktreeService } from "../git/git-worktree-service.js";

const FORK_HISTORY_BUDGET_BYTES = 1_000_000;
const FORK_HISTORY_PAGE_SIZE = 100;
const FORK_HISTORY_MAX_MESSAGES = 500;

/** Inputs that establish a child thread and its provider-only handoff. */
export interface CreateBranchedThreadInput {
  workspaceId: string;
  content: string;
  model: string;
  permissionMode: PermissionMode | "default";
  mode: "direct" | "worktree";
  branch: string;
  worktreeBranchMode?: "branchless" | "named";
  existingWorktreePath?: string;
  existingWorktreeBaseBranch?: string;
  reasoningLevel?: ReasoningLevel;
  provider: ProviderId;
  interactionMode?: InteractionMode;
  parentThreadId: string;
  forkedFromMessageId?: string;
  title: string;
  copilotAgent?: string;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
  orchestrationMode?: OrchestrationMode;
}

/** The fully persisted child thread and its private first-turn handoff payload. */
export interface ProvisionedBranchedThread {
  thread: Thread;
  providerWireOverride: string;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
  warnings?: string[];
}

type Fork = {
  parent: Thread;
  message: Message;
  messages: Message[];
  budget: ForkHistoryBudget;
  messageId: string;
};

type InheritedThreadSettings = {
  contextWindowMode: ContextWindowMode | undefined;
  thinking: boolean | undefined;
  codexFastMode: boolean | undefined;
};

/** Owns branch validation, workspace creation, lineage persistence, and handoff setup. */
@injectable()
export class ThreadBranchingService {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(ThreadService) private readonly threadService: ThreadService,
    @inject(GitWorktreeService) private readonly worktrees: GitWorktreeService,
    @inject(HandoffCoordinator) private readonly handoffs: HandoffCoordinator,
  ) {}

  /** Create the child and durable handoff before the runtime owner dispatches its first turn. */
  async create(input: CreateBranchedThreadInput): Promise<ProvisionedBranchedThread> {
    const fork = this.loadFork(input);
    const inherited = this.inheritSettings(fork.parent, input);
    const created = await this.createChild(input, fork.messageId);
    const thread = this.configureChild(created.thread, input, inherited, fork.messageId);
    const handoff = await this.handoffs.deliverHandoff({
      parentThread: fork.parent,
      childThreadId: thread.id,
      childProvider: input.provider,
      forkMessage: fork.message,
      forkedMessages: fork.messages,
      historyBudget: fork.budget,
      userMessage: input.content,
      model: input.model,
    });
    return {
      thread,
      providerWireOverride: handoff.providerWireOverride,
      contextWindowMode: inherited.contextWindowMode,
      thinking: inherited.thinking,
      codexFastMode: inherited.codexFastMode,
      warnings: "warnings" in created ? created.warnings : undefined,
    };
  }

  private loadFork(input: CreateBranchedThreadInput): Fork {
    const parent = this.threads.findById(input.parentThreadId);
    if (!parent) throw new Error(`Parent thread not found: ${input.parentThreadId}`);
    if (parent.workspace_id !== input.workspaceId) throw new Error("Cannot branch across workspaces");
    if (parent.deleted_at !== null) throw new Error("Cannot branch from a deleted thread");
    const messageId = input.forkedFromMessageId ?? this.lastMessageId(input.parentThreadId);
    const message = this.messages.findByIdInThread(input.parentThreadId, messageId);
    if (!message) throw new Error(`Fork message not found in parent thread: ${messageId}`);
    const history = this.messages.listByThreadUpToSequenceBudgeted(input.parentThreadId, message.sequence, {
      maxBytes: FORK_HISTORY_BUDGET_BYTES,
      pageSize: FORK_HISTORY_PAGE_SIZE,
      maxRows: FORK_HISTORY_MAX_MESSAGES,
    });
    return { parent, message, messages: history.messages, budget: history.budget, messageId };
  }

  private lastMessageId(threadId: string): string {
    const { messages } = this.messages.listByThread(threadId, 1);
    const message = messages.at(-1);
    if (!message) throw new Error("No messages in parent thread to branch from");
    return message.id;
  }

  private inheritSettings(parent: Thread, input: CreateBranchedThreadInput): InheritedThreadSettings {
    return {
      contextWindowMode: input.contextWindowMode ?? parent.context_window_mode as ContextWindowMode | null ?? undefined,
      thinking: input.thinking ?? (parent.thinking === null ? undefined : Boolean(parent.thinking)),
      codexFastMode: input.codexFastMode ?? parent.codex_fast_mode ?? undefined,
    };
  }

  private async createChild(input: CreateBranchedThreadInput, messageId: string) {
    if (input.existingWorktreePath) {
      return { thread: await this.attachExisting(input, messageId) };
    }
    if (input.mode === "worktree") return this.createManaged(input, messageId);
    return { thread: this.threads.create(input.workspaceId, input.title, "direct", input.branch, true, input.provider, {
      parentThreadId: input.parentThreadId,
      forkedFromMessageId: messageId,
    }) };
  }

  private async createManaged(input: CreateBranchedThreadInput, messageId: string) {
    const created = await this.threadService.create(input.workspaceId, input.title, "worktree", input.branch, {
      branchless: input.worktreeBranchMode !== "named",
    });
    try {
      this.threads.updateLineage(created.id, input.parentThreadId, messageId);
      this.threads.updateProvider(created.id, input.provider);
    } catch (error) {
      this.threads.softDelete(created.id);
      throw error;
    }
    return {
      thread: { ...created, provider: input.provider, parent_thread_id: input.parentThreadId, forked_from_message_id: messageId },
      warnings: created.warnings,
    };
  }

  private async attachExisting(input: CreateBranchedThreadInput, messageId: string): Promise<Thread> {
    const known = await this.worktrees.listWorktrees(input.workspaceId);
    const worktree = known.find((candidate) => this.samePath(candidate.path, input.existingWorktreePath!));
    if (!worktree) throw new Error("Path is not a recognized worktree");
    const branch = this.attachBranch(worktree.branch, input.existingWorktreeBaseBranch);
    const detached = worktree.branch === "(detached)";
    const thread = this.threads.create(input.workspaceId, input.title, "worktree", branch, false, input.provider, {
      parentThreadId: input.parentThreadId,
      forkedFromMessageId: messageId,
    }, detached ? "branchless" : "named", detached ? branch : null);
    this.threads.updateWorktreePath(thread.id, worktree.path);
    return { ...thread, worktree_path: worktree.path };
  }

  private attachBranch(branch: string, baseBranch: string | undefined): string {
    const resolved = branch === "(detached)" ? baseBranch : branch;
    if (!resolved) throw new Error("Base branch is required when attaching a detached worktree");
    if (resolved === "HEAD") throw new Error("Base branch cannot be HEAD when attaching a detached worktree");
    validateBranchName(resolved);
    return resolved;
  }

  private configureChild(
    thread: Thread,
    input: CreateBranchedThreadInput,
    inherited: InheritedThreadSettings,
    _messageId: string,
  ): Thread {
    this.threads.updateModel(thread.id, input.model);
    this.threads.updateSettings(thread.id, threadSettings(input, inherited));
    return configuredChildThread(thread, input, inherited);
  }

  private samePath(left: string, right: string): boolean {
    const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }
}

function threadSettings(
  input: CreateBranchedThreadInput,
  inherited: InheritedThreadSettings,
) {
  return {
    ...reasoningLevelSetting(input),
    ...interactionModeSetting(input),
    ...orchestrationModeSetting(input),
    ...permissionModeSetting(input),
    ...contextWindowModeSetting(inherited),
    ...thinkingSetting(inherited),
    ...copilotAgentSetting(input),
    ...codexFastModeSetting(input, inherited),
  };
}

function reasoningLevelSetting(input: CreateBranchedThreadInput) {
  return input.reasoningLevel === undefined ? {} : { reasoning_level: input.reasoningLevel };
}

function interactionModeSetting(input: CreateBranchedThreadInput) {
  return input.interactionMode === undefined ? {} : { interaction_mode: input.interactionMode };
}

function orchestrationModeSetting(input: CreateBranchedThreadInput) {
  return input.orchestrationMode === undefined ? {} : { orchestration_mode: input.orchestrationMode };
}

function permissionModeSetting(input: CreateBranchedThreadInput) {
  return input.permissionMode === "default" ? {} : { permission_mode: input.permissionMode };
}

function contextWindowModeSetting(inherited: InheritedThreadSettings) {
  return inherited.contextWindowMode === undefined ? {} : { context_window_mode: inherited.contextWindowMode };
}

function thinkingSetting(inherited: InheritedThreadSettings) {
  return inherited.thinking === undefined ? {} : { thinking: inherited.thinking };
}

function copilotAgentSetting(input: CreateBranchedThreadInput) {
  return input.copilotAgent === undefined ? {} : { copilot_agent: input.copilotAgent };
}

function codexFastModeSetting(
  input: CreateBranchedThreadInput,
  inherited: InheritedThreadSettings,
) {
  if (input.provider !== "codex" || inherited.codexFastMode === undefined) return {};
  return { codex_fast_mode: inherited.codexFastMode };
}

function configuredChildThread(
  thread: Thread,
  input: CreateBranchedThreadInput,
  inherited: InheritedThreadSettings,
): Thread {
  return {
    ...thread,
    model: input.model,
    provider: input.provider,
    reasoning_level: input.reasoningLevel ?? thread.reasoning_level,
    interaction_mode: input.interactionMode ?? thread.interaction_mode,
    orchestration_mode: input.orchestrationMode ?? thread.orchestration_mode,
    permission_mode: input.permissionMode === "default" ? thread.permission_mode : input.permissionMode,
    context_window_mode: inherited.contextWindowMode ?? thread.context_window_mode,
    thinking: inherited.thinking ?? thread.thinking,
    copilot_agent: input.copilotAgent ?? thread.copilot_agent,
    codex_fast_mode: configuredCodexFastMode(thread, input, inherited),
  };
}

function configuredCodexFastMode(
  thread: Thread,
  input: CreateBranchedThreadInput,
  inherited: InheritedThreadSettings,
) {
  if (input.provider === "codex" && inherited.codexFastMode !== undefined) {
    return inherited.codexFastMode;
  }
  return thread.codex_fast_mode;
}
