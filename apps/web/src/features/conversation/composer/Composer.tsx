import { useState, useRef, useCallback, useEffect, useMemo } from "react";
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
  createMentionId,
  insertMentionNode,
  insertSelectedPluginMention,
  insertSlashCommandNode,
  removeSlashCommandTrigger,
  type MentionNodeData,
} from "@/components/chat/lexical";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { useDiffStore } from "@/stores/diffStore";

import { useSlashCommand } from "@/components/chat/useSlashCommand";
import type { Command } from "@/components/chat/useSlashCommand";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import { useReplyStore } from "@/stores/replyStore";
import { useQueueStore } from "@/stores/queueStore";
import { attachmentAcceptAttribute, isGoalOpen } from "@mcode/contracts";
import type { MessageMention, SelectedTextComment } from "@mcode/contracts";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useComposerFormController } from "./draft/useComposerFormController";
import { useComposerExecutionTarget } from "./execution/useComposerExecutionTarget";
import { useComposerAgentControlState } from "./controls/useComposerAgentControlState";
import { useComposerQueueController } from "./submission/useComposerQueueController";
import { useComposerSubmissionController } from "./submission/useComposerSubmissionController";
import { ComposerContentSurface } from "./ComposerContentSurface";
import { ComposerStatusStrip } from "./ComposerStatusStrip";
import { useComposerSurfaceState } from "./useComposerSurfaceState";

export {
  isThreadRunningForSubmit,
  shouldQueueActiveThreadSubmit,
} from "./submission/composer-submit-policy";

const EMPTY_TASK_BUBBLE_TASKS: readonly TaskItem[] = [];

/** `accept` list for the composer's hidden file input. */
const ATTACHMENT_INPUT_ACCEPT = attachmentAcceptAttribute();

/** Maps a file-autocomplete result to the matching Lexical mention payload. */
function createMentionNodeData(item: MentionSuggestion): MentionNodeData {
  if (item.kind === "agent") {
    return {
      id: createMentionId(),
      kind: "agent",
      label: item.label,
      name: item.name,
      path: item.path,
      provider: item.provider,
    };
  }
  if (item.kind === "plugin") {
    return {
      id: createMentionId(),
      kind: "plugin",
      label: item.label,
      name: item.name,
      path: item.path,
    };
  }
  return {
    id: createMentionId(),
    kind: "file",
    label: item.label,
    path: item.path,
  };
}

/** Creates the minimal keyboard event accepted by popup navigation handlers. */
function createPopupKeyboardEvent(key: string): React.KeyboardEvent {
  return {
    key,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.KeyboardEvent;
}

/** Handles slash-popup navigation that stays outside the Lexical editor. */
function handleSlashPopupKey(
  key: string,
  items: readonly Command[],
  selectedIndex: number,
  onSelect: (command: Command) => void,
  onDismiss: () => void,
  onKeyDown: (event: React.KeyboardEvent) => void,
): boolean {
  if (key === "Enter" || key === "Tab") {
    const command = items[selectedIndex];
    if (command) {
      onSelect(command);
      return true;
    }
  }
  if (key === "Escape") {
    onDismiss();
    return true;
  }
  onKeyDown(createPopupKeyboardEvent(key));
  return key === "ArrowDown" || key === "ArrowUp";
}

function showComposerOptionsInline(composerWidth: number): boolean {
  return composerWidth === 0 || composerWidth >= 640;
}

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
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
  branchFromMessageId,
  branchFromMessageContent,
  onBranchModeExit,
  onThreadCreated,
  selectedTextComment,
  onSelectedTextCommentConsumed,
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
    setGoalPending,
    updateDraft,
    updateSelection,
  } = form;
  useEffect(() => {
    if (!threadId || !selectedTextComment || selectedTextComment.source.threadId !== threadId) return;
    setSelectedTextComments([selectedTextComment]);
    onSelectedTextCommentConsumed?.();
  }, [onSelectedTextCommentConsumed, selectedTextComment, setSelectedTextComments, threadId]);
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
  const [filePopupAnchorRect, setFilePopupAnchorRect] = useState<DOMRect | null>(null);
  const handleAttachmentDrop = useCallback((event: React.DragEvent) => {
    if (handleDrop(event)) editorRef.current?.focus();
  }, [handleDrop]);


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

  useEffect(() => {
    if (isGoalOpen(activeGoal)) setGoalPending(false);
  }, [activeGoal]);

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
  }, [fileAutocomplete]);

  const filePopup = useFileTagPopup({
    items: fileAutocomplete.suggestions,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleMentionSelect,
    onDismiss: fileAutocomplete.dismiss,
  });

  useEffect(() => {
    if (!fileAutocomplete.isOpen) {
      setFilePopupAnchorRect(null);
      return;
    }
    setFilePopupAnchorRect(composerContainerRef.current?.getBoundingClientRect() ?? null);
  }, [fileAutocomplete.isOpen]);


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
  }, [slashCommand]);

  // Unified popup keyboard handler for Lexical's KeyboardPlugin.
  // Delegates to the file tag popup or slash command popup depending on which is open.
  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      return filePopup.handleKeyDown(createPopupKeyboardEvent(key));
    }
    if (slashCommand.isOpen) {
      return handleSlashPopupKey(
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
      {/* Soft gradient hint above the composer — short enough that it doesn't
          bury the last line of content (e.g. the turn footer) when the chat is
          scrolled to its tail. Reduced from h-5/opaque to h-3/70% so the band
          reads as edge-softening rather than a mask. */}
      {!isNewThread && (
        <div className="pointer-events-none absolute inset-x-0 -top-3 h-3 bg-gradient-to-t from-background/70 to-transparent" />
      )}
      {/* Queue toast */}
      {toast && (
        <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
          <Check size={10} className="text-primary" />
          {toast}
        </div>
      )}

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
      <Dialog
        open={routedPendingCheckoutConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) cancelRoutedCheckoutConfirmation();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch branch?</DialogTitle>
            <DialogDescription>
              {routedPendingCheckoutConfirmation
                ? `You're on "${routedPendingCheckoutConfirmation.currentBranch}" but selected "${routedPendingCheckoutConfirmation.targetBranch}". Switch to "${routedPendingCheckoutConfirmation.targetBranch}" before starting the thread?`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={routedCheckoutConfirming} />}>
              Cancel
            </DialogClose>
            <Button onClick={confirmRoutedCheckoutAndSubmit} disabled={routedCheckoutConfirming}>
              {routedCheckoutConfirming ? "Switching..." : "Switch and send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
