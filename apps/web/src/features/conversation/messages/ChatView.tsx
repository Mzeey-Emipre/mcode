import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SelectedTextComment, TurnRecovery } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useReplyStore } from "@/stores/replyStore";
import { useThreadStore } from "@/stores/threadStore";
import { getTransport } from "@/transport";
import type { SubagentRosterTarget } from "../narrative";
import { readThreadRecord } from "../state";
import { useThreadSubscriptionReconciler } from "../subscriptions/useThreadSubscriptionReconciler";
import { ChatViewSurface, type ChatViewInteractions, type ChatRecoveryBannerState } from "./chat-view/ChatViewSurface";
import { useChatViewState } from "./chat-view/useChatViewState";

const CACHE_PRESSURE_BYTES = 20 * 1024 * 1024;

interface DismissedSessionError {
  error: string | null;
  threadEpoch: number;
}

interface ThreadScopedState<T> {
  threadEpoch: number;
  value: T;
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
  const [pendingSelectedTextCommentState, setPendingSelectedTextCommentState] = useState<ThreadScopedState<SelectedTextComment | null>>({
    threadEpoch: 0,
    value: null,
  });
  const [dismissedErrorState, setDismissedErrorState] = useState<DismissedSessionError | null>(null);
  const [turnRecoveries, setTurnRecoveries] = useState<TurnRecovery[]>([]);
  const [dismissedBannerEpoch, setDismissedBannerEpoch] = useState<number | null>(null);
  const threadEpochRef = useRef({ epoch: 0, threadId: state.activeThreadId });
  if (threadEpochRef.current.threadId !== state.activeThreadId) {
    threadEpochRef.current = {
      epoch: threadEpochRef.current.epoch + 1,
      threadId: state.activeThreadId,
    };
  }
  const threadEpoch = threadEpochRef.current.epoch;
  const connectionEpochRef = useRef({ epoch: 0, status: state.connectionStatus });
  if (connectionEpochRef.current.status !== state.connectionStatus) {
    connectionEpochRef.current = {
      epoch: connectionEpochRef.current.epoch + 1,
      status: state.connectionStatus,
    };
  }
  const connectionEpoch = connectionEpochRef.current.epoch;
  const bannerDismissed = dismissedBannerEpoch === connectionEpoch;
  const visibleEditingThreadId = editingThreadState.threadEpoch === threadEpoch
    ? editingThreadState.value
    : null;
  const visiblePendingSelectedTextComment = pendingSelectedTextCommentState.threadEpoch === threadEpoch
    ? pendingSelectedTextCommentState.value
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

  useEffect(() => {
    if (state.connectionStatus !== "connected" || bannerDismissed) return;
    let cancelled = false;
    void getTransport().listTurnRecoveries().then((recoveries) => {
      if (!cancelled) setTurnRecoveries(recoveries);
    }).catch((error: unknown) => {
      console.error("Failed to load turn recoveries", error);
    });
    return () => {
      cancelled = true;
    };
  }, [state.connectionStatus, bannerDismissed]);

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

  const handleRetryRecoveries = useCallback(async (threadIds: string[]) => {
    setDismissedBannerEpoch(connectionEpoch);
    const failedIds: string[] = [];
    for (const threadId of threadIds) {
      try {
        const recovery = turnRecoveries.find((candidate) => candidate.threadId === threadId);
        if (!recovery || !recovery.actions.includes("retry")) throw new Error("Retry is unavailable");
        await getTransport().retryTurn(recovery.executionId);
      } catch (error) {
        console.error("Failed to retry recoverable thread", threadId, error);
        failedIds.push(threadId);
      }
    }
    const remainingRecoveries = turnRecoveries.filter((recovery) =>
      !threadIds.includes(recovery.threadId) || failedIds.includes(recovery.threadId));
    setTurnRecoveries(remainingRecoveries);
    setDismissedBannerEpoch(remainingRecoveries.length === 0 ? connectionEpoch : null);
  }, [connectionEpoch, turnRecoveries]);

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

  const handleSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    setPendingSelectedTextCommentState({ threadEpoch, value: comment });
  }, [threadEpoch]);
  const consumeSelectedTextComment = useCallback(() => {
    setPendingSelectedTextCommentState({ threadEpoch, value: null });
  }, [threadEpoch]);
  const handleContinue = useCallback(() => {
    setPendingPrefill("Continue");
  }, [setPendingPrefill]);
  const handleRetry = useCallback((executionId: string) => {
    void getTransport().retryTurn(executionId);
  }, []);
  const handleStopSafely = useCallback(async () => {
    if (state.activeThreadId) await useThreadStore.getState().stopAgent(state.activeThreadId);
  }, [state.activeThreadId]);
  const handleContinueWithoutSaving = useCallback(async () => {
    if (state.savingStatus?.mode === "saving-delayed") await getTransport().continueWithoutSaving(state.savingStatus.executionId);
  }, [state.savingStatus]);
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
    onSelectedTextComment: handleSelectedTextComment,
    onSelectedTextCommentConsumed: consumeSelectedTextComment,
    onPromptSelect: setPendingPrefill,
    onContinue: handleContinue,
    onRetry: handleRetry,
    onStopSafely: handleStopSafely,
    onContinueWithoutSaving: handleContinueWithoutSaving,
    onDismissCliError: handleDismissCliError,
    onOpenSettings: handleOpenSettings,
    onSaveTitle: handleSaveTitle,
    onExitForkMode: handleExitForkMode,
  }), [
    consumeSelectedTextComment,
    handleBranch,
    handleContinue,
    handleContinueWithoutSaving,
    handleDismissCliError,
    handleExitForkMode,
    handleOpenSettings,
    handleReply,
    handleRetry,
    handleSaveTitle,
    handleSelectedTextComment,
    handleStopSafely,
    setPendingPrefill,
  ]);
  const recovery: ChatRecoveryBannerState = {
    turnRecoveries,
    bannerDismissed,
    onRetry: handleRetryRecoveries,
    onDismiss: () => {
      setDismissedBannerEpoch(connectionEpoch);
      setTurnRecoveries([]);
    },
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
      pendingSelectedTextComment={visiblePendingSelectedTextComment}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
      dismissedError={dismissedError}
    />
  );
}
