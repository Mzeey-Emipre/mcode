import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SelectedTextComment } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useRecoveryIncidentStore, useVisibleRecoveryIncident } from "@/features/recovery/state/recoveryIncidentStore";
import { useReplyStore } from "@/stores/replyStore";
import { useThreadStore } from "@/stores/threadStore";
import {
  useComposerDraftStore,
  type SelectedTextCommentEditorDraft,
} from "@/stores/composerDraftStore";
import { getTransport } from "@/transport";
import type { SubagentRosterTarget } from "../narrative";
import { readThreadRecord } from "../state";
import { useThreadSubscriptionReconciler } from "../subscriptions/useThreadSubscriptionReconciler";
import { ChatViewSurface, type ChatViewInteractions, type ChatRecoveryBannerState } from "./chat-view/ChatViewSurface";
import { useChatViewState } from "./chat-view/useChatViewState";
import type { SelectedTextCommentSourceNavigationRequest } from "./MessageList";

const CACHE_PRESSURE_BYTES = 20 * 1024 * 1024;

interface DismissedSessionError {
  error: string | null;
  threadEpoch: number;
}

interface ThreadScopedState<T> {
  threadEpoch: number;
  value: T;
}

interface SelectedTextCommentEditorUpdate {
  editor: SelectedTextCommentEditorDraft | undefined;
}

function cardEditorForComment(
  comment: SelectedTextComment,
  anchor: SelectedTextCommentEditorDraft["anchor"],
): SelectedTextCommentEditorDraft {
  return {
    source: comment.source,
    commentId: comment.id,
    note: comment.note,
    mentions: comment.mentions,
    escapeWarned: false,
    outsideWarned: false,
    anchor,
  };
}

function valueForThreadEpoch<T>(state: ThreadScopedState<T>, threadEpoch: number, fallback: T): T {
  return state.threadEpoch === threadEpoch ? state.value : fallback;
}

function addUnavailableComment(
  current: ThreadScopedState<readonly string[]>,
  threadEpoch: number,
  commentId: string,
): ThreadScopedState<readonly string[]> {
  const previous = current.threadEpoch === threadEpoch ? current.value : [];
  return {
    threadEpoch,
    value: previous.includes(commentId) ? previous : [...previous, commentId],
  };
}

interface SelectedTextCommentPresentation {
  readonly pendingSelectedTextComment: SelectedTextComment | null;
  readonly pendingSelectedTextCommentDeletion: SelectedTextComment | null;
  readonly pendingSelectedTextCommentEditor: SelectedTextCommentEditorUpdate | null;
  readonly selectedTextCommentSourceNavigation: SelectedTextCommentSourceNavigationRequest | null;
  readonly unavailableSelectedTextCommentIds: readonly string[];
  readonly interactions: Pick<
    ChatViewInteractions,
    | "onSelectedTextComment"
    | "onDeleteSelectedTextComment"
    | "onSelectedTextCommentConsumed"
    | "onSelectedTextCommentDeletionConsumed"
    | "onSelectedTextCommentEditorChange"
    | "onSelectedTextCommentEditorChangeConsumed"
    | "onOpenSelectedTextCommentSource"
    | "onOpenSelectedTextCommentEditor"
    | "onSelectedTextCommentSourceOpened"
    | "onSelectedTextCommentSourceUnavailable"
    | "onSelectedTextCommentEditorSourceUnavailable"
  >;
}

function useSelectedTextCommentPresentation(
  activeThreadId: string | null,
  threadEpoch: number,
): SelectedTextCommentPresentation {
  const [pendingCommentState, setPendingCommentState] = useState<ThreadScopedState<SelectedTextComment | null>>({
    threadEpoch: 0,
    value: null,
  });
  const [pendingEditorState, setPendingEditorState] =
    useState<ThreadScopedState<SelectedTextCommentEditorUpdate | null>>({
      threadEpoch: 0,
      value: null,
    });
  const [pendingCommentDeletionState, setPendingCommentDeletionState] =
    useState<ThreadScopedState<SelectedTextComment | null>>({ threadEpoch: 0, value: null });
  const [sourceNavigationState, setSourceNavigationState] =
    useState<ThreadScopedState<SelectedTextCommentSourceNavigationRequest | null>>({
      threadEpoch: 0,
      value: null,
    });
  const [unavailableCommentIdsState, setUnavailableCommentIdsState] =
    useState<ThreadScopedState<readonly string[]>>({ threadEpoch: 0, value: [] });
  const sourceNavigationIdRef = useRef(0);
  const activeSourceNavigationRequestRef = useRef<SelectedTextCommentSourceNavigationRequest | null>(null);
  const handleSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    setPendingCommentState({ threadEpoch, value: comment });
  }, [threadEpoch]);
  const consumeSelectedTextComment = useCallback(() => {
    setPendingCommentState({ threadEpoch, value: null });
  }, [threadEpoch]);
  const handleEditorChange = useCallback((editor: SelectedTextCommentEditorDraft | undefined) => {
    setPendingEditorState({ threadEpoch, value: { editor } });
  }, [threadEpoch]);
  const consumeEditorChange = useCallback(() => {
    setPendingEditorState({ threadEpoch, value: null });
  }, [threadEpoch]);
  const startSourceNavigation = useCallback((comment: SelectedTextComment, intent?: "edit") => {
    const request = { id: ++sourceNavigationIdRef.current, comment, intent };
    setUnavailableCommentIdsState((current) => ({
      threadEpoch,
      value: current.threadEpoch === threadEpoch
        ? current.value.filter((commentId) => commentId !== comment.id)
        : [],
    }));
    activeSourceNavigationRequestRef.current = request;
    setSourceNavigationState({
      threadEpoch,
      value: request,
    });
  }, [threadEpoch]);
  const handleDeleteSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    setPendingCommentDeletionState({ threadEpoch, value: comment });
  }, [threadEpoch]);
  const consumeSelectedTextCommentDeletion = useCallback(() => {
    setPendingCommentDeletionState({ threadEpoch, value: null });
  }, [threadEpoch]);
  const handleOpenSource = useCallback((comment: SelectedTextComment) => {
    startSourceNavigation(comment);
  }, [startSourceNavigation]);
  const handleOpenSourceEditor = useCallback((comment: SelectedTextComment) => {
    startSourceNavigation(comment, "edit");
  }, [startSourceNavigation]);
  const handleSourceOpened = useCallback((request: SelectedTextCommentSourceNavigationRequest) => {
    if (request.comment.source.threadId !== activeThreadId) return;
    if (activeSourceNavigationRequestRef.current?.id !== request.id) return;
    activeSourceNavigationRequestRef.current = null;
    setSourceNavigationState({ threadEpoch, value: null });
    if (request.intent === "edit") {
      setPendingEditorState({
        threadEpoch,
        value: { editor: cardEditorForComment(request.comment, "source") },
      });
    }
  }, [activeThreadId, threadEpoch]);
  const handleSourceUnavailable = useCallback((request: SelectedTextCommentSourceNavigationRequest) => {
    if (request.comment.source.threadId !== activeThreadId) return;
    if (activeSourceNavigationRequestRef.current?.id !== request.id) return;
    activeSourceNavigationRequestRef.current = null;
    setSourceNavigationState({ threadEpoch, value: null });
    setUnavailableCommentIdsState((current) => addUnavailableComment(current, threadEpoch, request.comment.id));
    setPendingEditorState({
      threadEpoch,
      value: { editor: cardEditorForComment(request.comment, "card") },
    });
  }, [activeThreadId, threadEpoch]);
  const handleRestoredEditorUnavailable = useCallback((editor: SelectedTextCommentEditorDraft) => {
    if (editor.source.threadId !== activeThreadId) return;
    setPendingEditorState({ threadEpoch, value: { editor: { ...editor, anchor: "card" } } });
    const commentId = editor.commentId;
    if (!commentId) return;
    setUnavailableCommentIdsState((current) => addUnavailableComment(current, threadEpoch, commentId));
  }, [activeThreadId, threadEpoch]);
  return {
    pendingSelectedTextComment: valueForThreadEpoch(pendingCommentState, threadEpoch, null),
    pendingSelectedTextCommentDeletion: valueForThreadEpoch(pendingCommentDeletionState, threadEpoch, null),
    pendingSelectedTextCommentEditor: valueForThreadEpoch(pendingEditorState, threadEpoch, null),
    selectedTextCommentSourceNavigation: valueForThreadEpoch(sourceNavigationState, threadEpoch, null),
    unavailableSelectedTextCommentIds: valueForThreadEpoch(unavailableCommentIdsState, threadEpoch, []),
    interactions: {
      onSelectedTextComment: handleSelectedTextComment,
      onDeleteSelectedTextComment: handleDeleteSelectedTextComment,
      onSelectedTextCommentConsumed: consumeSelectedTextComment,
      onSelectedTextCommentDeletionConsumed: consumeSelectedTextCommentDeletion,
      onSelectedTextCommentEditorChange: handleEditorChange,
      onSelectedTextCommentEditorChangeConsumed: consumeEditorChange,
      onOpenSelectedTextCommentSource: handleOpenSource,
      onOpenSelectedTextCommentEditor: handleOpenSourceEditor,
      onSelectedTextCommentSourceOpened: handleSourceOpened,
      onSelectedTextCommentSourceUnavailable: handleSourceUnavailable,
      onSelectedTextCommentEditorSourceUnavailable: handleRestoredEditorUnavailable,
    },
  };
}

/** Props for the composed Conversation chat surface. */
export interface ChatViewProps {
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/** Renders the main chat UI for sending and receiving messages within a thread. */
export function ChatView({ onSubagentSelect, onOpenSubagents }: ChatViewProps = {}) {
  const state = useChatViewState();
  const [editingThreadState, setEditingThreadState] = useState<ThreadScopedState<string | null>>({
    threadEpoch: 0,
    value: null,
  });
  const [dismissedErrorState, setDismissedErrorState] = useState<DismissedSessionError | null>(null);
  const recoveryIncident = useVisibleRecoveryIncident();
  const dismissRecoveryIncident = useRecoveryIncidentStore((store) => store.dismissIncident);
  const markRecoveryEntriesRetried = useRecoveryIncidentStore((store) => store.markEntriesRetried);
  const threadEpochRef = useRef({ epoch: 0, threadId: state.activeThreadId });
  if (threadEpochRef.current.threadId !== state.activeThreadId) {
    threadEpochRef.current = {
      epoch: threadEpochRef.current.epoch + 1,
      threadId: state.activeThreadId,
    };
  }
  const threadEpoch = threadEpochRef.current.epoch;
  const visibleEditingThreadId = editingThreadState.threadEpoch === threadEpoch
    ? editingThreadState.value
    : null;
  const dismissedError = dismissedErrorState?.threadEpoch === threadEpoch
    ? dismissedErrorState.error
    : null;
  const {
    activeThread,
    activeThreadId,
    setForkMode,
    setPendingPrefill,
    updateThreadTitle,
  } = state;
  const selectedTextCommentEditor = useComposerDraftStore((store) =>
    activeThreadId ? store.drafts[activeThreadId]?.selectedTextCommentEditor : undefined,
  );
  const selectedTextComments = useSelectedTextCommentPresentation(activeThreadId, threadEpoch);

  const previousConnectionStatusRef = useRef(state.connectionStatus);
  useEffect(() => {
    const previousStatus = previousConnectionStatusRef.current;
    previousConnectionStatusRef.current = state.connectionStatus;
    if (previousStatus !== "connected") return;
    if (state.connectionStatus !== "reconnecting" && state.connectionStatus !== "authFailed") return;
    const activeThreadId = useWorkspaceStore.getState().activeThreadId;
    if (!activeThreadId) return;
    const thread = useWorkspaceStore.getState().threads.find((candidate) => candidate.id === activeThreadId);
    if (thread?.clientPreparing) useWorkspaceStore.getState().failPreparingThreadOnConnectionLost(activeThreadId);
  }, [state.connectionStatus]);

  useThreadSubscriptionReconciler({
    activeThreadId: state.activeThreadId,
    desiredThreadIds: state.desiredThreadIds,
    connectionStatus: state.connectionStatus,
    runningThreadIds: state.runningThreadIds,
    canonicalRecoverySignature: state.canonicalRecoverySignature,
  });

  const previousThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (previousThreadIdRef.current !== null) {
      const cacheBytes = window.desktopBridge?.getRendererCacheBytes?.() ?? 0;
      if (cacheBytes > CACHE_PRESSURE_BYTES) window.desktopBridge?.clearRendererCache?.();
    }
    previousThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  const handleBranch = useCallback((messageId: string) => {
    const activeThreadId = useWorkspaceStore.getState().activeThreadId;
    const message = activeThreadId
      ? readThreadRecord(activeThreadId).messages.find((candidate) => candidate.id === messageId)
      : undefined;
    if (!activeThreadId || !message) return;
    setForkMode(activeThreadId, {
      messageId,
      content: message.role === "user" ? message.content : null,
      role: message.role as "user" | "assistant",
    });
  }, [setForkMode]);

  const handleReply = useCallback((messageId: string, content: string, role: "user" | "assistant") => {
    const activeThreadId = useWorkspaceStore.getState().activeThreadId;
    if (!activeThreadId) return;
    useReplyStore.getState().setReply(activeThreadId, messageId, role, content.slice(0, 150), content.slice(0, 2000));
  }, []);

  const handleStopSafely = useCallback(async () => {
    if (state.activeThreadId) await useThreadStore.getState().stopAgent(state.activeThreadId);
  }, [state.activeThreadId]);
  const handleContinueWithoutSaving = useCallback(async () => {
    if (state.savingStatus?.mode === "saving-delayed") await getTransport().continueWithoutSaving(state.savingStatus.executionId);
  }, [state.savingStatus]);
  const retryRecoveryEntries = useCallback(async (executionIds: readonly string[]) => {
    const retried: string[] = [];
    for (const executionId of executionIds) {
      try {
        await getTransport().retryTurn(executionId);
        retried.push(executionId);
      } catch (error) {
        console.error("Failed to retry interrupted turn", executionId, error);
      }
    }
    if (retried.length > 0) markRecoveryEntriesRetried(retried);
  }, [markRecoveryEntriesRetried]);
  const handleDismissCliError = useCallback(() => {
    setDismissedErrorState({ error: state.sessionError, threadEpoch });
  }, [state.sessionError, threadEpoch]);
  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }));
  }, []);
  const handleSaveTitle = useCallback((title: string) => {
    if (activeThread) updateThreadTitle(activeThread.id, title);
    setEditingThreadState({ threadEpoch, value: null });
  }, [activeThread, threadEpoch, updateThreadTitle]);
  const handleExitForkMode = useCallback(() => {
    if (activeThreadId) setForkMode(activeThreadId, null);
  }, [activeThreadId, setForkMode]);
  const interactions = useMemo<ChatViewInteractions>(() => ({
    onBranch: handleBranch,
    onReply: handleReply,
    ...selectedTextComments.interactions,
    onPromptSelect: setPendingPrefill,
    onStopSafely: handleStopSafely,
    onContinueWithoutSaving: handleContinueWithoutSaving,
    onDismissCliError: handleDismissCliError,
    onOpenSettings: handleOpenSettings,
    onSaveTitle: handleSaveTitle,
    onExitForkMode: handleExitForkMode,
  }), [
    handleBranch,
    handleContinueWithoutSaving,
    handleDismissCliError,
    handleExitForkMode,
    handleOpenSettings,
    handleReply,
    handleSaveTitle,
    handleStopSafely,
    selectedTextComments.interactions,
    setPendingPrefill,
  ]);
  const recovery: ChatRecoveryBannerState = {
    incident: recoveryIncident,
    onDismiss: dismissRecoveryIncident,
    onRetry: retryRecoveryEntries,
  };

  // No `key` here: a remount would discard the virtualizer state owned by MessageList.
  return (
    <ChatViewSurface
      state={state}
      interactions={interactions}
      recovery={recovery}
      editingThreadId={visibleEditingThreadId}
      onEditingThreadIdChange={(threadId) =>
        setEditingThreadState({ threadEpoch, value: threadId })
      }
      pendingSelectedTextComment={selectedTextComments.pendingSelectedTextComment}
      pendingSelectedTextCommentDeletion={selectedTextComments.pendingSelectedTextCommentDeletion}
      pendingSelectedTextCommentEditor={selectedTextComments.pendingSelectedTextCommentEditor ?? undefined}
      selectedTextCommentEditor={selectedTextCommentEditor}
      selectedTextCommentSourceNavigation={selectedTextComments.selectedTextCommentSourceNavigation ?? undefined}
      unavailableSelectedTextCommentIds={selectedTextComments.unavailableSelectedTextCommentIds}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
      dismissedError={dismissedError}
    />
  );
}
