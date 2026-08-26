import type { Thread } from "@/transport";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { ComposerExecutionTarget, ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import type { ComposerReplyContext, PreparedComposerSubmission } from "./composer-submission-types";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  createPreparedThreadMessagePayload,
  sendComposerThreadMessage,
} from "./composer-thread-message";

/** Inputs for dispatching one prepared Composer submit to its selected target. */
export interface DispatchComposerTargetOptions {
  threadId?: string;
  workspaceId?: string;
  branchFromMessageId?: string;
  activeThread?: Thread;
  target: ComposerExecutionTarget;
  execution: ComposerExecutionTargetController;
  submission: PreparedComposerSubmission;
  replyContext?: ComposerReplyContext;
  onBranchModeExit?(): void;
  onThreadCreated?(thread: Thread): void;
}

/** Dispatches a prepared Composer submit to the target selected by the user. */
export async function dispatchComposerTarget(options: DispatchComposerTargetOptions): Promise<void> {
  if (options.target.kind === "new-thread" && options.workspaceId) {
    await dispatchNewThread(options);
    return;
  }
  if (options.target.kind === "branch" && options.threadId) {
    await dispatchBranch(options, options.threadId);
    return;
  }
  if (options.threadId) await dispatchExistingThread(options, options.threadId);
}

/** Returns whether a selected target has the worktree data required for transport. */
export function isComposerTargetReady(target: ComposerExecutionTarget): boolean {
  if (target.kind === "new-thread") {
    return target.mode !== "existing-worktree" || target.hasWorktree;
  }
  if (target.kind === "branch") {
    return target.mode !== "existing-worktree" || Boolean(target.worktreePath);
  }
  return true;
}

/** Creates and sends the initial message for a new thread. */
async function dispatchNewThread(
  options: DispatchComposerTargetOptions,
): Promise<void> {
  const { target, execution, submission, onThreadCreated } = options;
  if (target.kind !== "new-thread") return;
  synchronizeNewThreadTarget(execution, target);
  const { snapshot, prepared } = submission;
  const selection = snapshot.selection;
  const thread = await useWorkspaceStore.getState().createAndSendMessage(
    prepared.content,
    selection.modelId,
    selection.permissionMode,
    submission.attachmentMetas.length > 0 ? submission.attachmentMetas : undefined,
    selection.reasoning,
    selection.provider,
    selection.interactionMode,
    selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined,
    selection.contextWindow ?? undefined,
    selection.thinking ?? undefined,
    selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined,
    prepared.displayContent,
    snapshot.mentions,
    submission.previewAnnotations,
    submission.goalObjective,
    selection.orchestrationMode,
  );
  onThreadCreated?.(thread);
}

/** Synchronizes workspace selection state before creating a new thread. */
function synchronizeNewThreadTarget(
  execution: ComposerExecutionTargetController,
  target: Extract<ComposerExecutionTarget, { kind: "new-thread" }>,
): void {
  execution.setNewThreadMode(target.mode);
  if (target.mode === "worktree" && target.branchSource === "pr") {
    execution.setNewThreadBranchFromPullRequest(target.branch);
    return;
  }
  execution.setNewThreadBranch(target.branch);
}

/** Creates a child thread from the selected source message. */
async function dispatchBranch(
  options: DispatchComposerTargetOptions,
  threadId: string,
): Promise<void> {
  const { target, activeThread, branchFromMessageId, submission, onBranchModeExit } = options;
  if (target.kind !== "branch") return;
  await useWorkspaceStore.getState().branchThread(
    createBranchThreadRequest(threadId, target, activeThread, branchFromMessageId!, submission),
  );
  onBranchModeExit?.();
}

/** Maps a prepared branch submit to the workspace-store transport shape. */
function createBranchThreadRequest(
  sourceThreadId: string,
  target: Extract<ComposerExecutionTarget, { kind: "branch" }>,
  activeThread: Thread | undefined,
  forkedFromMessageId: string,
  submission: PreparedComposerSubmission,
) {
  const { snapshot, prepared } = submission;
  return {
    sourceThreadId,
    content: prepared.content,
    displayContent: prepared.displayContent,
    attachments: submission.attachmentMetas.length > 0 ? submission.attachmentMetas : undefined,
    mode: target.mode,
    branch: target.branch || activeThread?.branch || "",
    existingWorktreePath: target.worktreePath ?? undefined,
    existingWorktreeBaseBranch: resolveDetachedBaseBranch(target, activeThread),
    forkedFromMessageId,
    mentions: snapshot.mentions,
    previewAnnotations: submission.previewAnnotations,
    goalObjective: submission.goalObjective,
    ...branchThreadAgentOptions(snapshot.selection),
  };
}

/** Maps agent selection fields used by branch-thread transport. */
function branchThreadAgentOptions(selection: ComposerAgentSelection) {
  return {
    model: selection.modelId,
    provider: selection.provider,
    permissionMode: selection.permissionMode,
    reasoningLevel: selection.reasoning,
    copilotAgent: selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined,
    contextWindow: selection.contextWindow ?? undefined,
    thinking: selection.thinking ?? undefined,
    codexFastMode: selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined,
    orchestrationMode: selection.orchestrationMode,
  };
}

/** Resolves the branch to use when branching into a detached existing worktree. */
function resolveDetachedBaseBranch(
  target: Extract<ComposerExecutionTarget, { kind: "branch" }>,
  activeThread: Thread | undefined,
): string | undefined {
  if (!target.worktreeIsDetached) return undefined;
  return target.branch || activeThread?.base_branch || activeThread?.branch || "main";
}

/** Sends a prepared message to the existing thread. */
async function dispatchExistingThread(
  options: DispatchComposerTargetOptions,
  threadId: string,
): Promise<void> {
  const { submission, replyContext } = options;
  await sendComposerThreadMessage(
    threadId,
    createPreparedThreadMessagePayload(submission, replyContext),
  );
}
