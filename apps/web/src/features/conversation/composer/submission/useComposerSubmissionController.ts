import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Thread } from "@/transport";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { clearFileListCache } from "@/components/chat/useFileAutocomplete";
import { useToastStore } from "@/stores/toastStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { ComposerFormController } from "../draft/useComposerFormController";
import type { ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import type { ComposerQueueEdit } from "../queue/useComposerQueueEditing";
import type { HandoffQueuedSend } from "../queue/useHandoffQueuedSend";
import { completeSuccessfulComposerSubmission } from "./complete-composer-submission";
import { createComposerAnnotationDispatchGuard } from "./composer-submission-annotations";
import {
  completeQueuedComposerSubmission,
  createHandoffQueuedSend,
  queueComposerSubmission,
} from "./composer-submission-queue";
import {
  dispatchComposerTarget,
  isComposerTargetReady,
} from "./composer-submission-routes";
import type { ComposerReplyContext, PreparedComposerSubmission } from "./composer-submission-types";
import { prepareComposerSubmission } from "./prepare-composer-submission";
import { shouldQueueActiveThreadSubmit } from "./composer-submit-policy";

/** A Direct-mode checkout that must be confirmed before the prepared submit runs. */
export interface PendingCheckoutConfirmation {
  currentBranch: string;
  targetBranch: string;
  onConfirm(): Promise<void>;
}

/** Queue operations that participate in submit routing. */
export interface ComposerSubmissionQueue {
  editing: ComposerQueueEdit | null;
  queueIfGenerating(queued: HandoffQueuedSend): boolean;
  discardEmptyEdit(): boolean;
  finishEditing(): void;
  resolvePreviewAnnotations(
    annotations: PreviewAnnotationBundle | undefined,
  ): PreviewAnnotationBundle | undefined;
}

/** Inputs for the Composer submission route controller. */
export interface UseComposerSubmissionControllerOptions {
  threadId?: string;
  workspaceId?: string;
  isNewThread: boolean;
  branchFromMessageId?: string;
  activeThread?: Thread;
  isAgentRunning: boolean;
  isThreadScaffold: boolean;
  annotationScopeId?: string;
  form: ComposerFormController;
  execution: ComposerExecutionTargetController;
  queue: ComposerSubmissionQueue;
  replyContext?: ComposerReplyContext;
  onBranchModeExit?(): void;
  onThreadCreated?(thread: Thread): void;
}

type SubmitAttemptOutcome = "complete" | "checkout-pending";

/** Owns Composer submit routing, dispatch cleanup, and Direct-mode checkout confirmation. */
export function useComposerSubmissionController({
  threadId,
  workspaceId,
  isNewThread,
  branchFromMessageId,
  activeThread,
  isAgentRunning,
  isThreadScaffold,
  annotationScopeId,
  form,
  execution,
  queue,
  replyContext,
  onBranchModeExit,
  onThreadCreated,
}: UseComposerSubmissionControllerOptions) {
  const [pendingCheckoutConfirmation, setPendingCheckoutConfirmation] =
    useState<PendingCheckoutConfirmation | null>(null);
  const [checkoutConfirming, setCheckoutConfirming] = useState(false);
  const submitInFlightRef = useRef(false);

  const completeQueued = useCallback(
    (submission: PreparedComposerSubmission): void => {
      completeQueuedComposerSubmission({
        threadId,
        annotationScopeId,
        annotations: submission.currentAnnotations,
        goalObjective: submission.goalObjective,
        editing: queue.editing,
        form,
        finishEditing: queue.finishEditing,
      });
    },
    [annotationScopeId, form, queue.editing, queue.finishEditing, threadId],
  );

  const queuePrepared = useCallback(
    (submission: PreparedComposerSubmission): boolean => {
      const queued = queueComposerSubmission({
        threadId,
        editing: queue.editing,
        submission,
        replyContext,
      });
      if (queued) completeQueued(submission);
      return queued;
    },
    [completeQueued, queue.editing, replyContext, threadId],
  );

  const executePreparedDispatch = useCallback(
    async (
      submission: PreparedComposerSubmission,
      target: ComposerExecutionTargetController["target"],
    ): Promise<void> => {
      if (shouldQueueActiveSubmit({ threadId, isAgentRunning, branchFromMessageId, isNewThread, submission })) {
        queuePrepared(submission);
        return;
      }
      execution.resetDetectedPullRequest();
      const annotations = createComposerAnnotationDispatchGuard(
        annotationScopeId,
        submission.currentAnnotations,
      );
      annotations.clearBeforeDispatch();
      const dispatch = dispatchComposerTarget({
        threadId,
        workspaceId,
        branchFromMessageId,
        activeThread,
        target,
        execution,
        submission,
        replyContext,
        onBranchModeExit,
        onThreadCreated,
      });
      const draftCleared = form.clearSubmittedDraft(submission.snapshot);
      try {
        await dispatch;
      } catch (error) {
        if (draftCleared) form.restoreFailedDispatch();
        annotations.restoreAfterFailure();
        showDispatchFailure(error);
        return;
      }
      annotations.stopWatching();
      completeSuccessfulComposerSubmission({
        threadId,
        form,
        submission,
        replyContext,
        finishEditing: queue.finishEditing,
      });
    },
    [activeThread, annotationScopeId, branchFromMessageId, execution, form, isAgentRunning, isNewThread, onBranchModeExit, onThreadCreated, queue.finishEditing, queuePrepared, replyContext, threadId, workspaceId],
  );

  const runSubmissionAttempt = useCallback(async (): Promise<SubmitAttemptOutcome> => {
    if (!canSubmitWithoutWorkspace(isNewThread, workspaceId)) return "complete";
    const submission = await prepareComposerSubmission({
      annotationScopeId,
      form,
      isThreadScaffold,
      discardEmptyEdit: queue.discardEmptyEdit,
      resolvePreviewAnnotations: queue.resolvePreviewAnnotations,
    });
    if (!submission) return "complete";
    if (submission.snapshot.selectedTextComments.length === 0
      && shouldDeferToHandoff({ threadId, branchFromMessageId, isNewThread })
      && queue.queueIfGenerating(createHandoffQueuedSend({ submission, replyContext }))) {
      completeQueued(submission);
      return "complete";
    }
    if (shouldQueueActiveSubmit({ threadId, isAgentRunning, branchFromMessageId, isNewThread, submission })) {
      queuePrepared(submission);
      return "complete";
    }
    const target = execution.target;
    if (!isComposerTargetReady(target)) return "complete";
    const checkoutPending = await requestCheckoutConfirmation({
      workspaceId,
      execution,
      target,
      setPendingCheckoutConfirmation,
      onDispatch: () => executePreparedDispatch(submission, target),
      releaseSubmitLock: () => {
        submitInFlightRef.current = false;
      },
    });
    if (checkoutPending) return "checkout-pending";
    await executePreparedDispatch(submission, target);
    return "complete";
  }, [annotationScopeId, branchFromMessageId, completeQueued, executePreparedDispatch, execution, form, isAgentRunning, isNewThread, isThreadScaffold, queue.discardEmptyEdit, queue.queueIfGenerating, queue.resolvePreviewAnnotations, queuePrepared, replyContext, threadId, workspaceId]);

  const submit = useCallback(async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    let outcome: SubmitAttemptOutcome = "complete";
    try {
      outcome = await runSubmissionAttempt();
    } finally {
      if (outcome === "complete") submitInFlightRef.current = false;
    }
  }, [runSubmissionAttempt]);

  const cancelCheckoutConfirmation = useCallback(() => {
    if (checkoutConfirming) return;
    setPendingCheckoutConfirmation(null);
    submitInFlightRef.current = false;
    form.focus();
  }, [checkoutConfirming, form]);

  const confirmCheckoutAndSubmit = useCallback(async () => {
    const pending = pendingCheckoutConfirmation;
    if (!pending || checkoutConfirming) return;
    setCheckoutConfirming(true);
    try {
      await pending.onConfirm();
      setPendingCheckoutConfirmation(null);
    } finally {
      setCheckoutConfirming(false);
      form.focus();
    }
  }, [checkoutConfirming, form, pendingCheckoutConfirmation]);

  return {
    submit,
    pendingCheckoutConfirmation,
    checkoutConfirming,
    cancelCheckoutConfirmation,
    confirmCheckoutAndSubmit,
  };
}

/** Allows only workspace-backed new-thread submissions to enter transport. */
function canSubmitWithoutWorkspace(isNewThread: boolean, workspaceId: string | undefined): boolean {
  return !isNewThread || Boolean(workspaceId);
}

/** Recognizes existing-thread sends that must wait for handoff context. */
function shouldDeferToHandoff({
  threadId,
  branchFromMessageId,
  isNewThread,
}: Pick<UseComposerSubmissionControllerOptions, "threadId" | "branchFromMessageId" | "isNewThread">): boolean {
  return Boolean(threadId && !branchFromMessageId && !isNewThread);
}

/** Checks active-turn queue policy against the stable submitted text. */
function shouldQueueActiveSubmit({
  threadId,
  isAgentRunning,
  branchFromMessageId,
  isNewThread,
  submission,
}: Pick<UseComposerSubmissionControllerOptions, "threadId" | "isAgentRunning" | "branchFromMessageId" | "isNewThread"> & {
  submission: PreparedComposerSubmission;
}): boolean {
  return shouldQueueActiveThreadSubmit(
    threadId,
    isAgentRunning,
    branchFromMessageId,
    isNewThread,
    submission.trimmed,
  ) && submission.snapshot.selectedTextComments.length === 0;
}

/** Opens checkout confirmation when a Direct new thread targets another branch. */
async function requestCheckoutConfirmation({
  workspaceId,
  execution,
  target,
  setPendingCheckoutConfirmation,
  onDispatch,
  releaseSubmitLock,
}: {
  workspaceId: string | undefined;
  execution: ComposerExecutionTargetController;
  target: ComposerExecutionTargetController["target"];
  setPendingCheckoutConfirmation: Dispatch<SetStateAction<PendingCheckoutConfirmation | null>>;
  onDispatch(): Promise<void>;
  releaseSubmitLock(): void;
}): Promise<boolean> {
  if (!requiresCheckoutConfirmation(target, execution.isGitRepo, workspaceId)) return false;
  if (!workspaceId) return false;
  const currentBranch = await useWorkspaceStore.getState().getCurrentBranch(workspaceId);
  if (!currentBranch || target.branch === currentBranch) return false;
  setPendingCheckoutConfirmation(createCheckoutConfirmation({
    workspaceId,
    targetBranch: target.branch,
    currentBranch,
    onDispatch,
    releaseSubmitLock,
  }));
  return true;
}

/** Identifies a Direct-mode new-thread target that may mutate the active checkout. */
function requiresCheckoutConfirmation(
  target: ComposerExecutionTargetController["target"],
  isGitRepo: boolean,
  workspaceId: string | undefined,
): target is Extract<ComposerExecutionTargetController["target"], { kind: "new-thread" }> {
  return Boolean(
    isGitRepo
    && workspaceId
    && target.kind === "new-thread"
    && target.mode === "direct"
    && target.branch,
  );
}

/** Creates the confirmation action while retaining the submit lock until it finishes. */
function createCheckoutConfirmation({
  workspaceId,
  targetBranch,
  currentBranch,
  onDispatch,
  releaseSubmitLock,
}: {
  workspaceId: string;
  targetBranch: string;
  currentBranch: string;
  onDispatch(): Promise<void>;
  releaseSubmitLock(): void;
}): PendingCheckoutConfirmation {
  return {
    currentBranch,
    targetBranch,
    onConfirm: async () => {
      try {
        await useWorkspaceStore.getState().checkoutBranch(workspaceId, targetBranch);
        clearFileListCache(workspaceId);
        await onDispatch();
      } finally {
        releaseSubmitLock();
      }
    },
  };
}

/** Displays a failed transport without clearing the submitted form state. */
function showDispatchFailure(error: unknown): void {
  useToastStore.getState().show(
    "error",
    "Could not send message",
    error instanceof Error ? error.message : "Message dispatch failed",
  );
}
