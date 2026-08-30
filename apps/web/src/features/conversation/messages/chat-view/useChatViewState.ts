import { useMemo, useRef, useSyncExternalStore } from "react";
import { MAX_THREAD_SUBSCRIPTIONS } from "@mcode/contracts";
import { useElementWidth } from "@/hooks/useElementWidth";
import { overviewResponsivePaddingRight } from "@/lib/composer-layout";
import { useConnectionStore } from "@/stores/connectionStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useActiveWorkspaceThread, useParentThreadExists } from "@/features/projects/state/workspace-selectors";
import { hasResidentContent } from "../../hydration/resident-content";
import { getConversationResidency } from "../../residency/conversation-residency";
import { useActiveThreadRecord } from "../../state";
import { useOutgoingTranscriptHold } from "./useOutgoingTranscriptHold";

const EMPTY_DISPLAYED_THREAD_IDS: readonly string[] = [];

/** Subscribes to retained conversations that remain visible after selection changes. */
function subscribeDisplayedConversations(listener: () => void): () => void {
  return getConversationResidency().subscribeDisplayConversations(listener);
}

/** Reads retained conversations that remain visible after selection changes. */
function getDisplayedConversationSnapshot(): readonly string[] {
  return getConversationResidency().getDisplayConversationSnapshot();
}

/** Selects bounded subscriptions for the active, visible, and running conversations. */
function getDesiredThreadIds(
  activeThreadId: string | null,
  displayedThreadIds: readonly string[],
  runningThreadIds: ReadonlySet<string>,
): string[] {
  return [
    ...(activeThreadId ? [activeThreadId] : []),
    ...displayedThreadIds,
    ...Array.from(runningThreadIds).filter((threadId) => threadId !== activeThreadId).sort(),
  ].filter((threadId, index, threadIds) => threadIds.indexOf(threadId) === index)
    .slice(0, MAX_THREAD_SUBSCRIPTIONS);
}

/** Derives whether the selected conversation has enough resident content to paint. */
function getConversationPaintState(
  activeThreadId: string | null,
  hydratedThreadId: string | null,
  messageCount: number,
  isAgentRunning: boolean,
  residentContent: boolean,
) {
  const targetPaintable = hydratedThreadId === activeThreadId
    && (messageCount > 0 || (isAgentRunning && residentContent));
  return { isAgentRunning, targetPaintable };
}

/** Collects the active chat data and display state without owning message scroll behavior. */
export function useChatViewState() {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const updateThreadTitle = useWorkspaceStore((state) => state.updateThreadTitle);
  const setActiveThread = useWorkspaceStore((state) => state.setActiveThread);
  const setForkMode = useThreadStore((state) => state.setForkMode);
  const activeForkMode = useActiveThreadRecord((record) => record.forkMode);
  const runningThreadIds = useThreadStore((state) => state.runningThreadIds);
  const displayedThreadIds = useSyncExternalStore(
    subscribeDisplayedConversations,
    getDisplayedConversationSnapshot,
    () => EMPTY_DISPLAYED_THREAD_IDS,
  );
  const canonicalRecoverySignature = useThreadStore((state) =>
    Array.from(state.records)
      .filter(([, record]) => record.canonicalAgent.recoveryRequired)
      .map(([threadId]) => threadId)
      .sort()
      .join("\u0000"),
  );
  const hydratedThreadId = useThreadStore((state) => state.currentThreadId);
  const savingStatus = useActiveThreadRecord((record) => record.savingStatus);
  const messageCount = useActiveThreadRecord((record) => record.messages.length);
  const residentContent = useActiveThreadRecord(hasResidentContent);
  const historyLoading = useActiveThreadRecord((record) => record.loading);
  const sessionError = useActiveThreadRecord((record) => record.error);
  const setPendingPrefill = useComposerDraftStore((state) => state.setPendingPrefill);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeThread = useActiveWorkspaceThread((thread) => thread);
  const parentThreadExists = useParentThreadExists(activeThread?.parent_thread_id);
  const connectionStatus = useConnectionStore((state) => state.status);
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const threadPaneWidth = useElementWidth(chatPaneRef, activeThreadId);
  const reserveOverviewSpace = useOverviewStore((state) => state.reserveSpace);
  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;
  const { targetPaintable } = getConversationPaintState(
    activeThreadId,
    hydratedThreadId,
    messageCount,
    isAgentRunning,
    residentContent,
  );
  const displayHoldThreadId = useOutgoingTranscriptHold(activeThreadId, targetPaintable);
  const activeWorkspaceName = useMemo(
    () => workspaces.find((workspace) => workspace.id === (activeThread?.workspace_id ?? activeWorkspaceId))?.name ?? "",
    [workspaces, activeThread?.workspace_id, activeWorkspaceId],
  );
  const desiredThreadIds = useMemo(
    () => getDesiredThreadIds(activeThreadId, displayedThreadIds, runningThreadIds),
    [activeThreadId, displayedThreadIds, runningThreadIds],
  );

  return {
    activeThreadId,
    activeWorkspaceId,
    activeThread,
    activeWorkspaceName,
    branchFromMessageId: activeForkMode?.messageId,
    branchFromMessageContent: activeForkMode?.content ?? undefined,
    canonicalRecoverySignature,
    chatPaneRef,
    connectionStatus,
    desiredThreadIds,
    displayHoldThreadId,
    historyLoading,
    hydratedThreadId,
    isAgentRunning,
    messageCount,
    parentThreadExists,
    reserveOverviewSpace,
    residentContent,
    runningThreadIds,
    savingStatus,
    sessionError,
    setPendingPrefill,
    setActiveThread,
    setForkMode,
    sidebarCollapsed,
    targetPaintable,
    threadPaneWidth,
    updateThreadTitle,
    overviewPaddingRight: reserveOverviewSpace ? overviewResponsivePaddingRight() : undefined,
  };
}

/** Aggregates the current data and display state for the chat composition root. */
export type ChatViewState = ReturnType<typeof useChatViewState>;
