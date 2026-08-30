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
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [pendingSelectedTextComment, setPendingSelectedTextComment] = useState<SelectedTextComment | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [turnRecoveries, setTurnRecoveries] = useState<TurnRecovery[]>([]);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    setDismissedError(null);
    setEditingThreadId(null);
    setPendingSelectedTextComment((comment) => comment?.source.threadId === state.activeThreadId ? comment : null);
  }, [state.activeThreadId]);

  useEffect(() => {
    if (state.connectionStatus !== "connected") setBannerDismissed(false);
  }, [state.connectionStatus]);

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
    setBannerDismissed(true);
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
    setBannerDismissed(remainingRecoveries.length === 0);
  }, [turnRecoveries]);

  const handleBranch = useCallback((messageId: string) => {
    const activeThreadId = useWorkspaceStore.getState().activeThreadId;
    const message = activeThreadId
      ? readThreadRecord(activeThreadId).messages.find((candidate) => candidate.id === messageId)
      : undefined;
    if (!activeThreadId || !message) return;
    state.setForkMode(activeThreadId, {
      messageId,
      content: message.role === "user" ? message.content : null,
      role: message.role as "user" | "assistant",
    });
  }, [state.setForkMode]);

  const handleReply = useCallback((messageId: string, content: string, role: "user" | "assistant") => {
    const activeThreadId = useWorkspaceStore.getState().activeThreadId;
    if (!activeThreadId) return;
    useReplyStore.getState().setReply(activeThreadId, messageId, role, content.slice(0, 150), content.slice(0, 2000));
  }, []);

  const handleSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    setPendingSelectedTextComment(comment);
  }, []);
  const consumeSelectedTextComment = useCallback(() => {
    setPendingSelectedTextComment(null);
  }, []);
  const handleContinue = useCallback(() => {
    state.setPendingPrefill("Continue");
  }, [state.setPendingPrefill]);
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
    setDismissedError(state.sessionError);
  }, [state.sessionError]);
  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }));
  }, []);
  const handleSaveTitle = useCallback((title: string) => {
    if (state.activeThread) state.updateThreadTitle(state.activeThread.id, title);
    setEditingThreadId(null);
  }, [state.activeThread, state.updateThreadTitle]);
  const handleExitForkMode = useCallback(() => {
    if (state.activeThreadId) state.setForkMode(state.activeThreadId, null);
  }, [state.activeThreadId, state.setForkMode]);
  const interactions = useMemo<ChatViewInteractions>(() => ({
    onBranch: handleBranch,
    onReply: handleReply,
    onSelectedTextComment: handleSelectedTextComment,
    onSelectedTextCommentConsumed: consumeSelectedTextComment,
    onPromptSelect: state.setPendingPrefill,
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
    state.setPendingPrefill,
  ]);
  const recovery: ChatRecoveryBannerState = {
    turnRecoveries,
    bannerDismissed,
    onRetry: handleRetryRecoveries,
    onDismiss: () => {
      setBannerDismissed(true);
      setTurnRecoveries([]);
    },
  };

  // No `key` here: a remount would discard the virtualizer state owned by MessageList.
  return (
    <ChatViewSurface
      state={state}
      interactions={interactions}
      recovery={recovery}
      editingThreadId={editingThreadId}
      onEditingThreadIdChange={setEditingThreadId}
      pendingSelectedTextComment={pendingSelectedTextComment}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
      dismissedError={dismissedError}
    />
  );
}
