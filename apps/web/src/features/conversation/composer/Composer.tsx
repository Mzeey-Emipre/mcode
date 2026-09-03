import { useRef, useCallback, useEffect, useMemo } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord, getThreadRecord, getHandoffStatus } from "../state";
import { useWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import type { Thread } from "@/transport";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { useFileAutocomplete, type MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { useFileTagPopup } from "@/components/chat/FileTagPopup";
import {
  createMentionNodeData,
  insertMentionNode,
  insertSelectedPluginMention,
  insertSlashCommandNode,
  removeSlashCommandTrigger,
} from "@/components/chat/lexical";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { useDiffStore } from "@/stores/diffStore";

import { handleSlashCommandPopupKey, useSlashCommand } from "@/components/chat/useSlashCommand";
import type { Command } from "@/components/chat/useSlashCommand";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import { useReplyStore } from "@/stores/replyStore";
import { useQueueStore } from "@/stores/queueStore";
import { attachmentAcceptAttribute, isGoalOpen } from "@mcode/contracts";
import type { MessageMention, SelectedTextComment } from "@mcode/contracts";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useComposerFormController } from "./draft/useComposerFormController";
import { useComposerExecutionTarget } from "./execution/useComposerExecutionTarget";
import { useComposerAgentControlState } from "./controls/useComposerAgentControlState";
import { useComposerQueueController } from "./submission/useComposerQueueController";
import {
  useComposerSubmissionController,
  type PendingCheckoutConfirmation,
} from "./submission/useComposerSubmissionController";
import { ComposerContentSurface } from "./ComposerContentSurface";
import { ComposerStatusStrip } from "./ComposerStatusStrip";
import { useComposerSurfaceState } from "./useComposerSurfaceState";
import {
  removeSelectedTextComment,
  saveSelectedTextComment,
} from "./draft/composer-selected-text-comments";

export {
  isThreadRunningForSubmit,
  shouldQueueActiveThreadSubmit,
} from "./submission/composer-submit-policy";

const EMPTY_TASK_BUBBLE_TASKS: readonly TaskItem[] = [];

/** `accept` list for the composer's hidden file input. */
const ATTACHMENT_INPUT_ACCEPT = attachmentAcceptAttribute();

/** Creates the minimal keyboard event accepted by the file picker. */
function createPopupKeyboardEvent(key: string): React.KeyboardEvent {
  return {
    key,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.KeyboardEvent;
}

function showComposerOptionsInline(composerWidth: number): boolean {
  return composerWidth === 0 || composerWidth >= 640;
}

function popupAnchorRect(
  isOpen: boolean,
  container: React.RefObject<HTMLDivElement | null>,
): DOMRect | null {
  if (!isOpen) return null;
  return container.current?.getBoundingClientRect() ?? null;
}

function resetPendingGoal(
  activeGoal: Parameters<typeof isGoalOpen>[0],
  goalPending: boolean,
  setGoalPending: (value: boolean) => void,
): void {
  if (isGoalOpen(activeGoal) && goalPending) setGoalPending(false);
}

function ComposerTopFade({ isNewThread }: { isNewThread: boolean | undefined }) {
  if (isNewThread) return null;
  return <div className="pointer-events-none absolute inset-x-0 -top-3 h-3 bg-gradient-to-t from-background/70 to-transparent" />;
}

function ComposerQueueToast({ toast }: { toast: string | null }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
      <Check size={10} className="text-primary" />
      {toast}
    </div>
  );
}

function ComposerCheckoutDialog({
  pending,
  confirming,
  onCancel,
  onConfirm,
}: {
  pending: PendingCheckoutConfirmation | null;
  confirming: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const description = pending
    ? `You're on "${pending.currentBranch}" but selected "${pending.targetBranch}". Switch to "${pending.targetBranch}" before starting the thread?`
    : "";
  const confirmLabel = confirming ? "Switching..." : "Switch and send";

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch branch?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={confirming} />}>
            Cancel
          </DialogClose>
          <Button onClick={onConfirm} disabled={confirming}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useSelectedTextCommentComposerHandoffs({
  threadId,
  selectedTextComment,
  onSelectedTextCommentConsumed,
  selectedTextCommentDeletion,
  onSelectedTextCommentDeletionConsumed,
  selectedTextCommentEditorUpdate,
  onSelectedTextCommentEditorUpdateConsumed,
  selectedTextComments,
  selectedTextCommentEditor,
  setSelectedTextComments,
  setSelectedTextCommentEditor,
}: {
  readonly threadId: string | undefined;
  readonly selectedTextComment: SelectedTextComment | undefined;
  readonly onSelectedTextCommentConsumed: (() => void) | undefined;
  readonly selectedTextCommentDeletion: SelectedTextComment | undefined;
  readonly onSelectedTextCommentDeletionConsumed: (() => void) | undefined;
  readonly selectedTextCommentEditorUpdate: { editor: SelectedTextCommentEditorDraft | undefined } | undefined;
  readonly onSelectedTextCommentEditorUpdateConsumed: (() => void) | undefined;
  readonly selectedTextComments: readonly SelectedTextComment[];
  readonly selectedTextCommentEditor: SelectedTextCommentEditorDraft | undefined;
  readonly setSelectedTextComments: (
    comments: readonly SelectedTextComment[],
    editor?: SelectedTextCommentEditorDraft,
  ) => void;
  readonly setSelectedTextCommentEditor: (editor: SelectedTextCommentEditorDraft | undefined) => void;
}): void {
  const handledDeletionRef = useRef<SelectedTextComment | undefined>(undefined);
  useEffect(() => {
    if (!threadId || !selectedTextComment || selectedTextComment.source.threadId !== threadId) return;
    setSelectedTextComments(saveSelectedTextComment(selectedTextComments, selectedTextComment));
    onSelectedTextCommentConsumed?.();
  }, [
    onSelectedTextCommentConsumed,
    selectedTextComment,
    selectedTextComments,
    setSelectedTextComments,
    threadId,
  ]);
  useEffect(() => {
    if (!selectedTextCommentDeletion) {
      handledDeletionRef.current = undefined;
      return;
    }
    if (
      !threadId
      || selectedTextCommentDeletion.source.threadId !== threadId
      || handledDeletionRef.current === selectedTextCommentDeletion
    ) return;
    handledDeletionRef.current = selectedTextCommentDeletion;
    setSelectedTextComments(
      removeSelectedTextComment(selectedTextComments, selectedTextCommentDeletion.id),
      selectedTextCommentEditor?.commentId === selectedTextCommentDeletion.id
        ? undefined
        : selectedTextCommentEditor,
    );
    onSelectedTextCommentDeletionConsumed?.();
  }, [
    onSelectedTextCommentDeletionConsumed,
    selectedTextCommentDeletion,
    selectedTextCommentEditor,
    selectedTextComments,
    setSelectedTextComments,
    threadId,
  ]);
  useEffect(() => {
    if (!threadId || !selectedTextCommentEditorUpdate) return;
    const { editor } = selectedTextCommentEditorUpdate;
    if (editor && editor.source.threadId !== threadId) return;
    setSelectedTextCommentEditor(editor);
    onSelectedTextCommentEditorUpdateConsumed?.();
  }, [
    onSelectedTextCommentEditorUpdateConsumed,
    selectedTextCommentEditorUpdate,
    setSelectedTextCommentEditor,
    threadId,
  ]);
}

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
  /** Locks normal input while automatic Setup holds the first Turn. */
  setupBlocked?: boolean;
  /** When set, the composer is in fork mode; submit creates a forked thread instead of sending. */
  branchFromMessageId?: string;
  /** Preview content of the message being forked from, shown as a quote. */
  branchFromMessageContent?: string;
  /** Called when the user exits fork mode (X button or Escape). */
  onBranchModeExit?: () => void;
  /** Called after a new-thread submission has created its durable thread. */
  onThreadCreated?: (thread: Thread) => void;
  /** Selected-text comment created from the active transcript. */
  selectedTextComment?: SelectedTextComment;
  /** Clears the one-shot transcript handoff after this Composer stores it. */
  onSelectedTextCommentConsumed?: () => void;
  /** Saved transcript comment to remove from this Composer draft. */
  selectedTextCommentDeletion?: SelectedTextComment;
  /** Clears the one-shot transcript deletion after this Composer applies it. */
  onSelectedTextCommentDeletionConsumed?: () => void;
  /** Pending editor update from the transcript for this ComposerDraft. */
  selectedTextCommentEditorUpdate?: { editor: SelectedTextCommentEditorDraft | undefined };
  /** Clears the consumed transcript editor update. */
  onSelectedTextCommentEditorUpdateConsumed?: () => void;
  /** Requests source navigation from the transcript owner. */
  onOpenSelectedTextCommentSource?: (comment: SelectedTextComment) => void;
  /** Comment IDs whose transcript sources failed to load or reconstruct. */
  unavailableSelectedTextCommentIds?: readonly string[];
}

/**
 * Main message composer with model/mode selectors and branch controls.
 *
 * Status bar layout varies by mode:
 * - **Direct:** `[Local v]` … `[From branch v]`
 * - **Worktree:** `[Worktree v]` … `[From branch v] [Auto v] [branch-name]`
 * - **Existing worktree:** `[Worktree v]` … `[Select worktree v]`
 * - **Locked (existing thread):** read-only branch badge
 */
export function Composer({
  threadId,
  isNewThread,
  workspaceId,
  setupBlocked = false,
  branchFromMessageId,
  branchFromMessageContent,
  onBranchModeExit,
  onThreadCreated,
  selectedTextComment,
  onSelectedTextCommentConsumed,
  selectedTextCommentDeletion,
  onSelectedTextCommentDeletionConsumed,
  selectedTextCommentEditorUpdate,
  onSelectedTextCommentEditorUpdateConsumed,
  onOpenSelectedTextCommentSource,
  unavailableSelectedTextCommentIds = [],
}: ComposerProps) {
  // Mode/permissions/tasks toggles render inline when the composer's own
  // container is wide enough; below the threshold they collapse behind a
  // single overflow trigger so the send button never wraps to a new row.
  // Container-based (not viewport-based) so the layout responds to the right
  // panel opening, sidebar resizing, etc. — not just window resizes.
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const composerWidth = useElementWidth(composerContainerRef);
  // Threshold tuned so model + reasoning + Chat + Full access + Tasks +
  // token-count badge + send button fit comfortably on one row with the
  // standard gaps and breathing room. Below this the row collapses to a
  // single "Composer options" trigger so the send button never gets clipped.
  // Keep the compact 600px layout behind the overflow trigger while allowing
  // the widened desktop rail to keep its inline controls.
  // Default to inline before the first measurement lands so the first frame
  // doesn't briefly render the popover trigger and snap to inline buttons.
  const showInlineComposerOptions = showComposerOptionsInline(composerWidth);

  const replyContext = useReplyStore((s) => threadId ? s.replyByThread[threadId] : undefined);
  const clearReply = useReplyStore((s) => s.clearReply);
  const planPreview = usePlanStore((s) =>
    threadId ? s.livePreviewByThread[threadId] : undefined,
  );
  const planPanelOpen = useDiffStore((s) => {
    if (!workspaceId || !threadId) return false;
    const panel = s.getRightPanel(workspaceId, threadId);
    return panel.visible && panel.activeTab === "tasks" && panel.openTabs.includes("tasks");
  });
  const taskBubbleTasks = useTaskStore((s) =>
    threadId ? s.taskBubbleByThread[threadId] ?? EMPTY_TASK_BUBBLE_TASKS : EMPTY_TASK_BUBBLE_TASKS,
  );
  const fileEffectSummary = useThreadStore((s) =>
    threadId ? s.records.get(threadId)?.fileEffectSummary : undefined,
  );

  const activeThread = useWorkspaceThread(threadId, (thread) => thread);
  const form = useComposerFormController({
    threadId,
    isNewThread: isNewThread === true,
    workspaceId,
    branchFromMessageId,
    branchFromMessageContent,
    activeThread,
  });
  const {
    text: input,
    attachments,
    selection: {
      modelId,
      provider,
      interactionMode: mode,
      permissionMode: access,
      orchestrationMode,
      contextWindow,
    },
    goalPending,
    isDragOver,
  } = form.state;
  const { editorRef } = form;
  const {
    contextWindow: settingsDefaultContextWindow,
  } = form.defaults;
  const {
    attachmentInputRef,
    preparationRevision: attachmentPreparationRevision,
    remove: removeAttachment,
    consumeDeferredSubmit,
    inputChange: handleAttachmentInputChange,
    pick: handleAttachPick,
    paste: handlePaste,
    dragEnter: handleDragEnter,
    dragLeave: handleDragLeave,
    dragOver: handleDragOver,
    drop: handleDrop,
  } = form.attachmentBindings;
  const {
    markAgentSettingsTouched,
    replaceDraft,
    setSelectedTextComments,
    setSelectedTextCommentEditor,
    setGoalPending,
    updateDraft,
    updateSelection,
  } = form;
  useSelectedTextCommentComposerHandoffs({
    threadId,
    selectedTextComment,
    onSelectedTextCommentConsumed,
    selectedTextCommentDeletion,
    onSelectedTextCommentDeletionConsumed,
    selectedTextCommentEditorUpdate,
    onSelectedTextCommentEditorUpdateConsumed,
    selectedTextComments: form.state.selectedTextComments,
    selectedTextCommentEditor: form.state.selectedTextCommentEditor,
    setSelectedTextComments,
    setSelectedTextCommentEditor,
  });
  const execution = useComposerExecutionTarget({
    input,
    activeThread,
    branchFromMessageId,
    isNewThread: isNewThread === true,
    workspaceId,
  });
  const {
    mode: composerMode,
    modeOptions,
    isGitRepo,
    needsWorkspace,
    isStaleWorktree,
    workspacePath,
    branchExecMode,
    fetchingBranch,
    detectedPullRequest: detectedPr,
    setMode: setComposerMode,
    setBranchMode: setBranchExecMode,
    dismissDetectedPullRequest: dismissDetectedPr,
    reviewDetectedPullRequest,
  } = execution;
  useEffect(() => {
    if (threadId && planPanelOpen) {
      usePlanStore.getState().clearLivePreview(threadId);
    }
  }, [planPanelOpen, threadId]);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const handleAttachmentDrop = useCallback((event: React.DragEvent) => {
    if (handleDrop(event)) editorRef.current?.focus();
  }, [editorRef, handleDrop]);


  const stopAgent = useThreadStore((s) => s.stopAgent);
  // Subscribe to just the boolean for this thread instead of the full Set.
  // Avoids Composer re-renders when other threads start/stop their agents.
  const isAgentRunning = useThreadStore(
    (s) => threadId ? s.runningThreadIds.has(threadId) : false,
  );
  const surfaceState = useComposerSurfaceState({
    threadId,
    workspaceId,
    isNewThread: isNewThread === true,
    branchFromMessageId,
    activeThread,
    composerMode,
    provider,
    hasDraftContent: form.state.hasContent,
    isAgentRunning,
  });
  const annotationScopeId = surfaceState.annotationScopeId;
  const isThreadScaffold = surfaceState.isThreadScaffold;
  const contextEntry = useThreadRecord(threadId, (r) => r.context);
  const isCompacting = useThreadRecord(threadId, (r) => r.isCompacting);
  const handoffStatus = useThreadStore((s) =>
    threadId ? getHandoffStatus(getThreadRecord(s.records, threadId)) : undefined,
  );
  const hasRetryState = useThreadRecord(
    threadId,
    (r) => !!(r.rateLimit || r.apiRetry),
  );
  const planPending = useThreadRecord(
    threadId,
    (r) => r.planQuestionsStatus === "pending",
  );
  const activeGoal = useThreadRecord(threadId, (r) => r.goal ?? null);
  const focusEditor = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);
  const agentControls = useComposerAgentControlState({
    threadId,
    provider: surfaceState.effectiveProviderId,
    modelId,
    permissionMode: access,
    interactionMode: mode,
    orchestrationMode,
    goalPending,
    activeGoal,
    onSelectionChange: updateSelection,
    onGoalPendingChange: setGoalPending,
    onSelectionTouched: markAgentSettingsTouched,
    focusEditor,
  });

  resetPendingGoal(activeGoal, goalPending, setGoalPending);

  const activeProviderId = activeThread?.provider ?? "claude";
  const usageInfo = useThreadRecord(threadId, (r) => r.usageByProvider[activeProviderId]);
  const hasLowQuota = usageInfo?.quotaCategories.some((c) => !c.isUnlimited && c.remainingPercent < 0.2) ?? false;

  const fileAutocomplete = useFileAutocomplete({
    workspaceId,
    threadId: surfaceState.catalogThreadId,
    providerId: surfaceState.effectiveProviderId,
    cwd: surfaceState.catalogCwd,
  });

  const handleMentionSelect = useCallback((item: MentionSuggestion) => {
    fileAutocomplete.selectSuggestion(item);
    const editor = editorRef.current;
    if (!editor) return;
    insertMentionNode(editor, createMentionNodeData(item), fileAutocomplete.triggerStart, fileAutocomplete.query.length);
  }, [editorRef, fileAutocomplete]);

  const filePopup = useFileTagPopup({
    items: fileAutocomplete.suggestions,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleMentionSelect,
    onDismiss: fileAutocomplete.dismiss,
  });

  const filePopupAnchorRect = popupAnchorRect(fileAutocomplete.isOpen, composerContainerRef);


  const slashCommand = useSlashCommand({
    anchorRef: composerContainerRef,
    workspaceId: workspaceId ?? undefined,
    threadId: surfaceState.catalogThreadId,
    providerId: surfaceState.effectiveProviderId,
    modelId,
    onMcodeCommand: (action) => {
      if (action === "attach-plan") {
        agentControls.attachCapability("plan");
      } else if (action === "attach-goal") {
        agentControls.attachCapability("goal");
      } else if (action === "attach-orchestration") {
        agentControls.attachCapability("orchestration");
      }
    },
  });
  // Dismiss reply when the user clicks outside both the composer and any message bubble.
  // Portaled overlays (popovers, dropdowns) render outside the composer DOM tree,
  // so we also check for popover-content markers to avoid false dismissals.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!threadId) return;
      const target = e.target as Element;
      const composerEl = composerContainerRef.current;
      if (composerEl && !composerEl.contains(target)) {
        if (target.closest?.("[data-message-id]")) return;
        if (target.closest?.('[data-slot="popover-content"], [role="dialog"], [role="listbox"], [role="menu"]')) return;
        clearReply(threadId);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [threadId, clearReply]);

  const handleStop = useCallback(() => {
    if (threadId) {
      stopAgent(threadId);
    }
  }, [threadId, stopAgent]);

  const {
    queuedSend,
    queueIfGenerating,
    resumeQueuedMessage,
    sendQueuedMessageNow,
    editing: editingFromQueue,
    loadIntoComposer,
    cancelEdit: cancelEditFromQueue,
    discardEmptyEdit,
    finishEditing,
    resolvePreviewAnnotations,
    markRestoredPreviewAnnotationsCleared,
  } = useComposerQueueController({
    threadId,
    annotationScopeId,
    handoffStatus,
    form,
    replyContext,
  });

  const handlePrReview = useCallback(async () => {
    const prefill = await reviewDetectedPullRequest();
    if (prefill) replaceDraft(prefill);
  }, [replaceDraft, reviewDetectedPullRequest]);

  const submissionQueue = useMemo(
    () => ({
      editing: editingFromQueue,
      queueIfGenerating,
      discardEmptyEdit,
      finishEditing,
      resolvePreviewAnnotations,
    }),
    [discardEmptyEdit, editingFromQueue, finishEditing, queueIfGenerating, resolvePreviewAnnotations],
  );
  const {
    submit: handleSend,
    pendingCheckoutConfirmation: routedPendingCheckoutConfirmation,
    checkoutConfirming: routedCheckoutConfirming,
    cancelCheckoutConfirmation: cancelRoutedCheckoutConfirmation,
    confirmCheckoutAndSubmit: confirmRoutedCheckoutAndSubmit,
  } = useComposerSubmissionController({
    threadId,
    workspaceId,
    isNewThread: isNewThread === true,
    branchFromMessageId,
    activeThread,
    isAgentRunning,
    isThreadScaffold,
    annotationScopeId,
    form,
    execution,
    queue: submissionQueue,
    replyContext,
    onBranchModeExit,
    onThreadCreated,
  });


  useEffect(() => {
    if (!consumeDeferredSubmit()) return;
    void handleSend();
  }, [attachmentPreparationRevision, consumeDeferredSubmit, handleSend]);

  useEffect(() => {
    if (!annotationScopeId) return;
    const onSubmitComposer = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly threadId?: string }>).detail;
      if (detail?.threadId && detail.threadId !== annotationScopeId) return;
      void handleSend();
    };
    window.addEventListener("mcode:submit-composer", onSubmitComposer);
    return () =>
      window.removeEventListener("mcode:submit-composer", onSubmitComposer);
  }, [handleSend, annotationScopeId]);

  const handleEditorChange = useCallback((text: string, nextMentions: MessageMention[]) => {
    updateDraft(text, nextMentions);
  }, [updateDraft]);

  const handleSlashSelect = useCallback((cmd: Command) => {
    // No-op replaceText: Lexical handles text replacement via insertSlashCommandNode
    slashCommand.onSelect(cmd, () => {});
    if (editorRef.current) {
      if (cmd.action) {
        removeSlashCommandTrigger(editorRef.current);
      } else if (!insertSelectedPluginMention(editorRef.current, cmd)) {
        insertSlashCommandNode(editorRef.current, cmd.name, cmd.namespace, cmd.identity);
      }
    }
  }, [editorRef, slashCommand]);

  // Unified popup keyboard handler for Lexical's KeyboardPlugin.
  // Delegates to the file tag popup or slash command popup depending on which is open.
  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      return filePopup.handleKeyDown(createPopupKeyboardEvent(key));
    }
    if (slashCommand.isOpen) {
      return handleSlashCommandPopupKey(
        key,
        slashCommand.items,
        slashCommand.selectedIndex,
        handleSlashSelect,
        slashCommand.onDismiss,
        slashCommand.onKeyDown,
      );
    }
    if (key === "Escape" && branchFromMessageId) {
      onBranchModeExit?.();
      return true;
    }
    return false;
  }, [fileAutocomplete.isOpen, filePopup, slashCommand, handleSlashSelect, branchFromMessageId, onBranchModeExit]);

  const toast = useQueueStore((s) => s.toast);


  const showComposerStatusBar = !!branchFromMessageId;

  return (
    <div className="relative px-4 py-4 sm:px-8">
      <ComposerTopFade isNewThread={isNewThread} />
      <ComposerQueueToast toast={toast} />

      {/* Max-width wrapper to align with message list column */}
      <div className={PRIMARY_CONTENT_RAIL_CLASS}>
        <ComposerContentSurface
          model={{
            threadId,
            workspaceId,
            isNewThread: isNewThread === true,
            branchFromMessageId,
            branchFromMessageContent,
            activeThread,
            planPreview,
            planPanelOpen,
            taskBubbleTasks,
            fileEffectSummary,
            isAgentRunning,
            setupBlocked,
            provider,
            planPending,
            queuedSend: Boolean(queuedSend),
            needsWorkspace,
            editingFromQueue,
            composerMode,
            isDragOver,
            replyContext,
            detectedPullRequest: detectedPr,
            fetchingBranch: Boolean(fetchingBranch),
            effectiveProviderId: surfaceState.effectiveProviderId,
            providerReason: surfaceState.providerReason,
            goalPending,
            isStaleWorktree,
            fileAutocomplete,
            filePopup,
            filePopupAnchorRect,
            slashCommand,
            attachmentBundle: surfaceState.annotationBundleForDisplay,
            annotationScopeId: surfaceState.annotationScopeId,
            attachments,
            selectedTextComments: form.state.selectedTextComments,
            selectedTextCommentEditor: form.state.selectedTextCommentEditor,
            unavailableSelectedTextCommentIds,
            isCompacting,
            hasRetryState,
            isThreadScaffold: surfaceState.isThreadScaffold,
            hasContent: surfaceState.hasContent,
            showInlineComposerOptions,
            attachmentInputRef,
            attachmentInputAccept: ATTACHMENT_INPUT_ACCEPT,
            composerContainerRef,
            editorContainerRef,
            editorRef,
            selection: form.state.selection,
            defaults: form.defaults,
            agentControls: {
              reasoningLevels: agentControls.reasoningLevels,
              capabilities: agentControls.capabilities,
              attachedCapabilityIds: agentControls.attachedCapabilityIds,
              permissionLocked: agentControls.permissionLocked,
            },
            activeGoal,
            isModelFullyLocked: surfaceState.isModelFullyLocked,
            isProviderLocked: surfaceState.isProviderLocked,
            contextWindow,
            settingsDefaultContextWindow,
            modelId,
            contextEntry,
            hasLowQuota,
          }}
          actions={{
            onBranchModeExit,
            onComposerModeChange: setComposerMode,
            onLoadIntoComposer: loadIntoComposer,
            onResumeQueuedMessage: resumeQueuedMessage,
            onSendQueuedMessageNow: sendQueuedMessageNow,
            onDragEnter: handleDragEnter,
            onDragLeave: handleDragLeave,
            onDragOver: handleDragOver,
            onDrop: handleAttachmentDrop,
            onClearReply: clearReply,
            onReviewDetectedPullRequest: handlePrReview,
            onDismissDetectedPullRequest: dismissDetectedPr,
            onCancelEdit: cancelEditFromQueue,
            onEditorChange: handleEditorChange,
            onSubmit: handleSend,
            onPopupKeyDown: handlePopupKeyDown,
            onMentionSelect: handleMentionSelect,
            onPaste: handlePaste,
            onMarkRestoredPreviewAnnotationsCleared: markRestoredPreviewAnnotationsCleared,
            onRemoveAttachment: removeAttachment,
            onAttachmentInputChange: handleAttachmentInputChange,
            onAttachPick: handleAttachPick,
            onAttachCapability: agentControls.attachCapability,
            onSelectionChange: updateSelection,
            onSelectionTouched: markAgentSettingsTouched,
            onDetachPlan: agentControls.detachPlan,
            onDetachGoal: agentControls.detachGoal,
            onDetachOrchestration: agentControls.detachOrchestration,
            onStop: handleStop,
            onClearSelectedTextComments: () => setSelectedTextComments([], undefined),
            onOpenSelectedTextCommentSource: (comment) => onOpenSelectedTextCommentSource?.(comment),
            onEditSelectedTextComment: (comment) => setSelectedTextCommentEditor({
              source: comment.source,
              commentId: comment.id,
              note: comment.note,
              mentions: comment.mentions,
              escapeWarned: false,
              outsideWarned: false,
              anchor: "card",
            }),
            onDeleteSelectedTextComment: (comment) => setSelectedTextComments(
              removeSelectedTextComment(form.state.selectedTextComments, comment.id),
              form.state.selectedTextCommentEditor?.commentId === comment.id
                ? undefined
                : form.state.selectedTextCommentEditor,
            ),
            onFocusComposer: focusEditor,
            onSaveSelectedTextComment: (comment) => setSelectedTextComments(
              saveSelectedTextComment(form.state.selectedTextComments, comment),
              undefined,
            ),
            onSelectedTextCommentEditorChange: setSelectedTextCommentEditor,
          }}
        />
        <ComposerStatusStrip
          visible={showComposerStatusBar}
          isGitRepo={isGitRepo}
          isNewThread={isNewThread === true}
          branchFromMessageId={branchFromMessageId}
          composerMode={composerMode}
          branchExecMode={branchExecMode}
          modeOptions={modeOptions}
          workspaceId={workspaceId}
          activeThread={activeThread}
          onComposerModeChange={setComposerMode}
          onBranchModeChange={setBranchExecMode}
        />
      </div>{/* end max-width wrapper */}

      <SlashCommandPopup
        state={slashCommand.state}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        workspacePath={workspacePath}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
        onRetry={slashCommand.onRetry}
      />
      <ComposerCheckoutDialog
        pending={routedPendingCheckoutConfirmation}
        confirming={routedCheckoutConfirming}
        onCancel={cancelRoutedCheckoutConfirmation}
        onConfirm={confirmRoutedCheckoutAndSubmit}
      />
    </div>
  );
}
