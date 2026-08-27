import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { Bug, GitFork, Hammer, SearchCode, ScanSearch } from "lucide-react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { ProjectAutomaticSetupThreadBlock } from "@/features/projects/environment";
import {
  useActiveWorkspaceThread,
  useParentThreadExists,
} from "@/features/projects/state/workspace-selectors";
import { useThreadStore } from "@/stores/threadStore";
import { useActiveThreadRecord, readThreadRecord } from "../state";
import { getConversationResidency } from "../residency/conversation-residency";
import { useConnectionStore } from "@/stores/connectionStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MessageList } from "./MessageList";
import { SavingDelayedDialog } from "../saving/SavingDelayedDialog";
import type { SubagentRosterTarget } from "../narrative";
import { ConversationHoldOverlay } from "@/components/chat/ConversationHoldOverlay";
import { Composer } from "../composer/Composer";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { HeaderActions } from "@/components/chat/HeaderActions";
import { CliErrorBanner, isCliError } from "@/components/chat/CliErrorBanner";
import { InterruptedSessionsBanner } from "@/components/chat/InterruptedSessionsBanner";
import { ErroredSessionsBanner } from "@/components/chat/ErroredSessionsBanner";
import { CollapsibleError } from "@/components/chat/CollapsibleError";
import { ThreadWarningBanner } from "@/components/chat/ThreadWarningBanner";
import { HandoffFallbackBanner } from "@/components/chat/HandoffFallbackBanner";
import { ThreadTitleEditor } from "@/components/chat/ThreadTitleEditor";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { useUiStore } from "@/stores/uiStore";
import { preparingStatusLabel, type WorkspaceThread } from "@/lib/workspace-thread";
import { useReplyStore } from "@/stores/replyStore";
import { getTransport } from "@/transport";
import { useElementWidth } from "@/hooks/useElementWidth";
import { overviewResponsivePaddingRight } from "@/lib/composer-layout";
import { hasResidentContent } from "../hydration/resident-content";
import { Button } from "@/components/ui/button";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { NewThreadProjectPicker } from "@/components/chat/NewThreadProjectPicker";
import {
  recordFirstMessageVisible,
  recordThreadHoldEnd,
  recordThreadHoldStart,
} from "@/lib/thread-switch-telemetry";
import {
  MAX_THREAD_SUBSCRIPTIONS,
  type SelectedTextComment,
  type TurnRecovery,
} from "@mcode/contracts";
import { useThreadSubscriptionReconciler } from "../subscriptions/useThreadSubscriptionReconciler";

const EMPTY_DISPLAYED_THREAD_IDS: readonly string[] = [];

function subscribeDisplayedConversations(listener: () => void): () => void {
  return getConversationResidency().subscribeDisplayConversations(listener);
}

function getDisplayedConversationSnapshot(): readonly string[] {
  return getConversationResidency().getDisplayConversationSnapshot();
}

const NEW_THREAD_STARTERS = [
  {
    label: "Explore and understand code",
    prompt: "Explore this codebase and explain how it works.",
    icon: ScanSearch,
  },
  {
    label: "Build a new feature, app, or tool",
    prompt: "Build a new feature, app, or tool in this project.",
    icon: Hammer,
  },
  {
    label: "Review code and suggest changes",
    prompt: "Review this codebase and suggest concrete improvements.",
    icon: SearchCode,
  },
  {
    label: "Fix issues and failures",
    prompt: "Find and fix issues or failures in this project.",
    icon: Bug,
  },
] as const;

/** Premium blank-thread welcome that turns common coding tasks into composer prefills. */
function NewThreadWelcome({
  projectName,
  onPromptSelect,
}: {
  projectName?: string;
  onPromptSelect: (text: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div
        key={projectName ?? "projectless"}
        data-testid="new-thread-welcome"
        className="animate-fade-up-in flex w-full max-w-[80rem] flex-col items-center gap-7 text-center"
      >
        <McodeLogo variant="newThread" markOnly />
        <h1
          aria-label={projectName ? `What should we build in ${projectName}?` : undefined}
          className="text-balance text-2xl font-medium tracking-[-0.025em] text-foreground sm:text-[28px]"
        >
          {projectName ? (
            <>
              What should we build in{" "}
              <NewThreadProjectPicker
                placement="bottom"
                trigger={
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    data-testid="new-thread-active-project-picker"
                    title="Change project"
                    className="h-auto min-h-0 gap-0 rounded-sm px-0 py-0 align-baseline !text-2xl font-[inherit] leading-[inherit] text-primary no-underline hover:bg-transparent hover:text-primary/80 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60 sm:!text-[28px]"
                  >
                    {projectName}<span className="text-foreground">?</span>
                  </Button>
                }
              />
            </>
          ) : (
            "What should we work on?"
          )}
        </h1>
        <div
          data-testid="new-thread-starters"
          className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-3"
        >
          {NEW_THREAD_STARTERS.map(({ label, prompt, icon: Icon }) => (
            <Button
              key={label}
              type="button"
              variant="outline"
              onClick={() => onPromptSelect(prompt)}
              className="group h-auto min-h-24 flex-col items-start justify-between rounded-xl border-border/70 bg-transparent px-4 py-4 text-left shadow-none hover:border-primary/35 hover:bg-accent/45"
            >
              <Icon className="size-4 text-primary transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transform-none" aria-hidden />
              <span className="w-full max-w-[18ch] text-wrap text-sm font-medium leading-5 text-foreground/90">
                {label}
              </span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Props for {@link ThreadPreparingShell}. */
interface ThreadPreparingShellProps {
  /** Placeholder or errored row until the server thread exists. */
  thread: WorkspaceThread;
  workspaceName: string;
  sidebarCollapsed: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  activeWorkspaceId: string | null;
}

/** Full-height chat layout while a thread row is still being created on the server. */
function ThreadPreparingShell({
  thread,
  workspaceName,
  sidebarCollapsed,
  onRetry,
  onDismiss,
  activeWorkspaceId,
}: ThreadPreparingShellProps) {
  const statusLabel = thread.clientPreparingContext
    ? preparingStatusLabel(thread.clientPreparingContext)
    : "Preparing…";
  const parentThreadExists = useParentThreadExists(thread.parent_thread_id);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="thread-preparing-shell">
      <div className="flex h-11 items-center justify-between border-b border-border pr-4 pl-2">
        <div className="flex min-w-0 items-center gap-2">
          {sidebarCollapsed && <SidebarRevealButton />}
          <span
            data-testid="chat-header-title"
            className="truncate text-sm font-medium"
          >
            {thread.title}
            {thread.clientPreparing && (
              <span className="ml-2 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary/60 align-middle" aria-hidden />
            )}
          </span>
          {activeWorkspaceId && (
            <Badge variant="secondary">{workspaceName}</Badge>
          )}
          {thread.parent_thread_id && parentThreadExists && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => useWorkspaceStore.getState().setActiveThread(thread.parent_thread_id!)}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                  >
                    <GitFork size={10} />
                    <span>Forked</span>
                  </button>
                }
              />
              <TooltipContent side="bottom" className="text-xs">Go to parent thread</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col items-stretch justify-center gap-6 px-6 py-8">
        <div className="mx-auto w-full max-w-xl rounded-xl border border-border/50 bg-muted/15 px-4 py-3 text-sm text-foreground/90 shadow-sm">
          <p className="whitespace-pre-wrap break-words">{thread.clientQueuedMessage ?? ""}</p>
        </div>

        {thread.clientError ? (
          <CollapsibleError
            error={thread.clientError}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        ) : (
          <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
            <Spinner size={16} />
            <span>{statusLabel}</span>
          </div>
        )}
      </div>

      <Composer threadId={thread.id} workspaceId={activeWorkspaceId ?? undefined} />
    </div>
  );
}
const CACHE_PRESSURE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Keeps a cold switch target visible without rendering stale transcript content. */
function ConversationTransitionState({
  threadId,
  threadTitle,
}: {
  threadId: string;
  threadTitle: string;
}) {
  return (
    <div
      data-testid="conversation-transition-shell"
      data-thread-id={threadId}
      role="status"
      aria-label={`Loading ${threadTitle}`}
      className="flex h-full items-center justify-center px-4"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size={16} />
        <span>{threadTitle}</span>
      </div>
    </div>
  );
}

/** Shows a selected conversation's non-provider hydration failure. */
function ConversationErrorState({ error }: { error: string }) {
  return (
    <div
      data-testid="conversation-error"
      role="alert"
      className="flex h-full items-center justify-center px-4"
    >
      <div className="max-w-md space-y-1 text-center">
        <p className="font-medium text-foreground">Could not load conversation</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    </div>
  );
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
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [pendingSelectedTextComment, setPendingSelectedTextComment] = useState<SelectedTextComment | null>(null);
  const setForkMode = useThreadStore((s) => s.setForkMode);
  const activeForkMode = useActiveThreadRecord((r) => r.forkMode);
  const branchFromMessageId = activeForkMode?.messageId;
  const branchFromMessageContent = activeForkMode?.content ?? undefined;
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
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
      .join("\u0000")
  );
  const hydratedThreadId = useThreadStore((s) => s.currentThreadId);
  const savingStatus = useActiveThreadRecord((record) => record.savingStatus);
  const messageCount = useActiveThreadRecord((r) => r.messages.length);
  const residentContent = useActiveThreadRecord(hasResidentContent);
  const historyLoading = useActiveThreadRecord((r) => r.loading);
  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);

  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;
  const targetPaintable = hydratedThreadId === activeThreadId
    && (messageCount > 0 || (isAgentRunning && residentContent));
  const previousActiveThreadIdRef = useRef<string | null>(activeThreadId);
  const [heldOutgoingThreadId, setHeldOutgoingThreadId] = useState<string | null>(null);
  const previousThreadId = previousActiveThreadIdRef.current;
  const immediateHeldOutgoingThreadId =
    !targetPaintable
    && previousThreadId
    && previousThreadId !== activeThreadId
    && readThreadRecord(previousThreadId).messages.length > 0
      ? previousThreadId
      : null;
  const displayHoldThreadId = targetPaintable
    ? null
    : immediateHeldOutgoingThreadId ?? heldOutgoingThreadId;

  useEffect(() => {
    const outgoingThreadId = previousActiveThreadIdRef.current;
    previousActiveThreadIdRef.current = activeThreadId;
    if (
      targetPaintable
      || !activeThreadId
      || !outgoingThreadId
      || outgoingThreadId === activeThreadId
      || readThreadRecord(outgoingThreadId).messages.length === 0
    ) {
      setHeldOutgoingThreadId(null);
      return;
    }

    setHeldOutgoingThreadId(outgoingThreadId);
    recordThreadHoldStart(activeThreadId);
    const timeout = setTimeout(() => {
      setHeldOutgoingThreadId((heldThreadId) => {
        if (heldThreadId === outgoingThreadId) recordThreadHoldEnd(activeThreadId);
        return heldThreadId === outgoingThreadId ? null : heldThreadId;
      });
    }, 500);
    return () => clearTimeout(timeout);
  }, [activeThreadId, targetPaintable]);

  useEffect(() => {
    if (!activeThreadId || !targetPaintable) return;
    if (heldOutgoingThreadId) recordThreadHoldEnd(activeThreadId);
    recordFirstMessageVisible(activeThreadId);
  }, [activeThreadId, heldOutgoingThreadId, targetPaintable]);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = useActiveWorkspaceThread((t) => t);
  const automaticSetupTranscriptBlock = useMemo(() => (
    activeThread?.mode === "worktree" && activeThread.worktree_managed === true
      ? (
          <ProjectAutomaticSetupThreadBlock
            threadId={activeThread.id}
            workspaceId={activeThread.workspace_id}
          />
        )
      : undefined
  ), [activeThread?.id, activeThread?.mode, activeThread?.workspace_id, activeThread?.worktree_managed]);
  const parentThreadExists = useParentThreadExists(activeThread?.parent_thread_id);
  const sessionError = useActiveThreadRecord((r) => r.error);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [turnRecoveries, setTurnRecoveries] = useState<TurnRecovery[]>([]);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const interruptedThreadIds = turnRecoveries
    .filter((recovery) => recovery.phase === "interrupted")
    .map((recovery) => recovery.threadId);
  const erroredThreadIds = turnRecoveries
    .filter((recovery) => recovery.phase === "errored")
    .map((recovery) => recovery.threadId);

  const connectionStatus = useConnectionStore((s) => s.status);
  const chatPaneRef = useRef<HTMLDivElement>(null);
  // ChatView also renders the projectless/new-thread canvas, where the measured
  // chat pane does not exist yet. Reattach the observer when a thread becomes
  // active so responsive Overview state uses the real pane width.
  const threadPaneWidth = useElementWidth(chatPaneRef, activeThreadId);
  const reserveOverviewSpace = useOverviewStore((s) => s.reserveSpace);
  const overviewPaddingRight = reserveOverviewSpace ? overviewResponsivePaddingRight() : undefined;

  const handleDismissCliError = useCallback(() => {
    setDismissedError(sessionError);
  }, [sessionError]);

  // Reset dismissed state when the active thread changes
  useEffect(() => {
    setDismissedError(null);
  }, [activeThreadId]);

  // Reset edit mode when the active thread changes (fork mode is preserved in the store)
  useEffect(() => {
    setEditingThreadId(null);
  }, [activeThreadId]);

  useEffect(() => {
    setPendingSelectedTextComment((comment) =>
      comment?.source.threadId === activeThreadId ? comment : null);
  }, [activeThreadId]);

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }));
  }, []);

  // Reset the banner dismissal on each new disconnect so a second server restart
  // in the same session can show the banner again.
  useEffect(() => {
    if (connectionStatus !== "connected") setBannerDismissed(false);
  }, [connectionStatus]);

  // Load only canonical recoverable executions. Legacy thread status alone does
  // not prove that Mcode has accepted input which it can retry safely.
  useEffect(() => {
    if (connectionStatus !== "connected" || bannerDismissed) return;
    let cancelled = false;
    void getTransport().listTurnRecoveries().then((recoveries) => {
      if (!cancelled) setTurnRecoveries(recoveries);
    }).catch((error: unknown) => {
      console.error("Failed to load turn recoveries", error);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, bannerDismissed]);

  /** Retries each selected recovery as a new execution, then hides its banner. */
  const handleRetryRecoveries = useCallback(
    async (threadIds: string[]) => {
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
    },
    [turnRecoveries],
  );

  /** Prefills the active composer with the existing interrupted-turn continuation prompt. */
  const handleContinueTurn = useCallback(() => {
    setPendingPrefill("Continue");
  }, [setPendingPrefill]);

  /** Retries one persisted turn by its exact execution identity. */
  const handleRetryTurn = useCallback((executionId: string) => {
    void getTransport().retryTurn(executionId);
  }, []);

  const handleStopSafely = useCallback(async () => {
    if (!activeThreadId) return;
    await useThreadStore.getState().stopAgent(activeThreadId);
  }, [activeThreadId]);

  const handleContinueWithoutSaving = useCallback(async () => {
    if (savingStatus?.mode !== "saving-delayed") return;
    await getTransport().continueWithoutSaving(savingStatus.executionId);
  }, [savingStatus]);

  /** Activates inline fork mode on the composer for the given message. */
  const handleBranch = useCallback((messageId: string) => {
    // Read messages and threadId from store at call time to avoid re-creating this callback on every streaming token.
    const threadId = useWorkspaceStore.getState().activeThreadId;
    const msg = threadId ? readThreadRecord(threadId).messages.find((m) => m.id === messageId) : undefined;
    if (!threadId || !msg) return;
    setForkMode(threadId, {
      messageId,
      content: msg.role === "user" ? msg.content : null,
      role: msg.role as "user" | "assistant",
    });
  }, [setForkMode]);

  /** Activates reply mode on the composer for the given message. */
  const handleReply = useCallback((messageId: string, content: string, role: "user" | "assistant") => {
    // Read threadId from store at call time to avoid re-creating this callback
    // on every status change, matching the pattern used by handleBranch.
    const threadId = useWorkspaceStore.getState().activeThreadId;
    if (!threadId) return;
    useReplyStore.getState().setReply(threadId, messageId, role, content.slice(0, 150), content.slice(0, 2000));
  }, []);

  const handleSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    setPendingSelectedTextComment(comment);
  }, []);

  const consumeSelectedTextComment = useCallback(() => {
    setPendingSelectedTextComment(null);
  }, []);

  const showCliError =
    !!sessionError &&
    isCliError(sessionError) &&
    sessionError !== dismissedError;
  const showConversationError = !!sessionError && !isCliError(sessionError);

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === (activeThread?.workspace_id ?? activeWorkspaceId))?.name ?? "",
    [workspaces, activeThread?.workspace_id, activeWorkspaceId],
  );

  const prevConnectionStatusRef = useRef(connectionStatus);

  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = connectionStatus;
    if (prev !== "connected") return;
    if (connectionStatus !== "reconnecting" && connectionStatus !== "authFailed") return;
    const id = useWorkspaceStore.getState().activeThreadId;
    if (!id) return;
    const row = useWorkspaceStore.getState().threads.find((t) => t.id === id);
    if (row?.clientPreparing) {
      useWorkspaceStore.getState().failPreparingThreadOnConnectionLost(id);
    }
  }, [connectionStatus]);

  const desiredThreadIds = useMemo(() => [
    ...(activeThreadId ? [activeThreadId] : []),
    ...displayedThreadIds,
    ...Array.from(runningThreadIds).filter((threadId) => threadId !== activeThreadId).sort(),
  ].filter((threadId, index, threadIds) => threadIds.indexOf(threadId) === index)
    .slice(0, MAX_THREAD_SUBSCRIPTIONS), [activeThreadId, displayedThreadIds, runningThreadIds]);

  useThreadSubscriptionReconciler({
    activeThreadId,
    desiredThreadIds,
    connectionStatus,
    runningThreadIds,
    canonicalRecoverySignature,
  });

  const prevThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Only evict Blink's resource cache when it exceeds the pressure threshold.
    // Avoids unnecessary re-fetches on routine thread switches.
    // Gracefully no-ops in the web-only dev server.
    if (prevThreadIdRef.current !== null) {
      const cacheBytes = window.desktopBridge?.getRendererCacheBytes?.() ?? 0;
      if (cacheBytes > CACHE_PRESSURE_BYTES) {
        window.desktopBridge?.clearRendererCache?.();
      }
    }
    prevThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  // A threadless workspace is always the new-thread workbench. This also covers
  // cold start before the user has chosen a project.
  if (!activeThreadId) {
    return (
      <div className="relative flex h-full min-h-0 flex-col bg-background">
        {sidebarCollapsed && (
          <div className="absolute left-2 top-2 z-10">
            <SidebarRevealButton />
          </div>
        )}
        <NewThreadWelcome
          projectName={activeWorkspaceName || undefined}
          onPromptSelect={setPendingPrefill}
        />
        <Composer isNewThread workspaceId={activeWorkspaceId ?? undefined} />
      </div>
    );
  }

  if (
    activeThread &&
    (activeThread.clientPreparing || activeThread.clientError)
  ) {
    return (
      <ThreadPreparingShell
        thread={activeThread}
        workspaceName={activeWorkspaceName}
        sidebarCollapsed={sidebarCollapsed}
        activeWorkspaceId={activeWorkspaceId}
        onRetry={() => {
          void useWorkspaceStore.getState().retryPreparingThread(activeThread.id);
        }}
        onDismiss={() => {
          useWorkspaceStore.getState().dismissPreparingThread(activeThread.id);
        }}
      />
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full flex-col bg-background">
        {/* Minimal top bar — only renders the reveal button when the sidebar is
            collapsed, so the user always has a way back to the project tree. */}
        {sidebarCollapsed && (
          <div className="flex h-11 items-center border-b border-border/40 pl-2">
            <SidebarRevealButton />
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h2 className="text-lg font-medium text-foreground">
              Select a thread
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a thread from the sidebar or create a new one.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const hasMessages = messageCount > 0;
  const conversationLoading = hydratedThreadId !== activeThreadId || historyLoading;
  const showHold = displayHoldThreadId !== null && !targetPaintable;
  const showTransition = conversationLoading && !targetPaintable && !showHold && !isAgentRunning;
  const showFullConversationError = showConversationError && !hasMessages && !isAgentRunning;
  const showConversationErrorBanner = showConversationError && (hasMessages || isAgentRunning);

  return (
    <div ref={chatPaneRef} className="flex h-full flex-col bg-background" data-testid="chat-view">
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border pr-4 pl-2">
        <div className="flex items-center gap-2">
          {sidebarCollapsed && <SidebarRevealButton />}
          <div
            data-testid="chat-header-title"
            onDoubleClick={() => setEditingThreadId(activeThread.id)}
            className="cursor-text"
          >
            <ThreadTitleEditor
              title={activeThread.title}
              isEditing={editingThreadId === activeThread.id}
              onSave={(newTitle) => {
                updateThreadTitle(activeThread.id, newTitle);
                setEditingThreadId(null);
              }}
              onCancel={() => setEditingThreadId(null)}
            />
          </div>
          {activeThread.parent_thread_id && parentThreadExists && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setActiveThread(activeThread.parent_thread_id!)}
                    className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                  >
                    <GitFork size={10} />
                    <span>Forked</span>
                  </button>
                }
              />
              <TooltipContent side="bottom" className="text-xs">Go to parent thread</TooltipContent>
            </Tooltip>
          )}
        </div>
        <HeaderActions thread={activeThread} threadPaneWidth={threadPaneWidth} />
      </div>

      {/* Interrupted sessions banner — shown after server restart when threads were mid-task */}
      {interruptedThreadIds.length > 0 && !bannerDismissed && (
        <div className="px-4 pt-2">
          <InterruptedSessionsBanner
            threadIds={interruptedThreadIds}
            onRetry={handleRetryRecoveries}
            onDismiss={() => {
              setBannerDismissed(true);
              setTurnRecoveries([]);
            }}
          />
        </div>
      )}

      {erroredThreadIds.length > 0 && !bannerDismissed && (
        <div className="px-4 pt-2">
          <ErroredSessionsBanner
            threadIds={erroredThreadIds}
            onRetry={handleRetryRecoveries}
            onDismiss={() => {
              setBannerDismissed(true);
              setTurnRecoveries([]);
            }}
          />
        </div>
      )}

      {/* Post-checkout warning banner — shown when worktree created but hook failed */}
      {activeThread.clientWarnings?.length ? (
        <div className="px-4 pt-2">
          <ThreadWarningBanner
            warnings={activeThread.clientWarnings}
            onDismiss={() => useWorkspaceStore.getState().dismissWarnings(activeThread.id)}
          />
        </div>
      ) : null}

      {showConversationErrorBanner ? (
        <div className="mx-3 mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p data-testid="conversation-error-banner" role="alert" className="text-sm text-destructive">
            Could not refresh conversation: {sessionError}
          </p>
        </div>
      ) : null}

      {/* Fallback handoff banner: shown when the fork's handoff was produced
          locally because the AI provider was unavailable. */}
      <HandoffFallbackBanner threadId={activeThread.id} />

      <SavingDelayedDialog
        open={savingStatus?.mode === "saving-delayed"}
        onStopSafely={handleStopSafely}
        onContinueWithoutSaving={handleContinueWithoutSaving}
      />

      {/* Messages, tool calls, and streaming — all in one scrollable area.
          No `key` here: forcing remount on thread switch would destroy the
          virtualizer and discard cached row heights. MessageList resets its
          own per-thread state imperatively in a useEffect on activeThreadId. */}
      <div
        data-testid="chat-message-stage"
        className="animate-fade-up-in flex-1 min-h-0 transition-[padding] duration-200"
        style={{ paddingRight: overviewPaddingRight }}
      >
        {showHold ? (
          <div className="relative h-full" aria-busy="true">
            <div className="pointer-events-none h-full" inert>
              <MessageList
                displayThreadId={displayHoldThreadId}
                onBranch={handleBranch}
                onReply={handleReply}
                onSelectedTextComment={handleSelectedTextComment}
                onSubagentSelect={onSubagentSelect}
                onOpenSubagents={onOpenSubagents}
                onContinue={handleContinueTurn}
                onRetry={handleRetryTurn}
              />
            </div>
            <ConversationHoldOverlay targetTitle={activeThread.title || "Conversation"} />
          </div>
        ) : showTransition ? (
          <ConversationTransitionState
            threadId={activeThread.id}
            threadTitle={activeThread.title || "Conversation"}
          />
        ) : showFullConversationError ? (
          <ConversationErrorState error={sessionError ?? ""} />
        ) : (
          <MessageList
            leadingContent={automaticSetupTranscriptBlock}
            onBranch={handleBranch}
            onReply={handleReply}
            onSelectedTextComment={handleSelectedTextComment}
            onSubagentSelect={onSubagentSelect}
            onOpenSubagents={onOpenSubagents}
            onContinue={handleContinueTurn}
            onRetry={handleRetryTurn}
          />
        )}
      </div>

      {/* CLI error banner — shown when the provider binary is not found */}
      {showCliError && (
        <CliErrorBanner
          error={sessionError!}
          onDismiss={handleDismissCliError}
          onOpenSettings={handleOpenSettings}
        />
      )}

      {/* Composer area — plan question wizard floats above the composer input */}
      <div
        data-testid="chat-composer-stage"
        className="relative flex-shrink-0 transition-[padding] duration-200"
        style={{ paddingRight: overviewPaddingRight }}
      >
        <PlanQuestionWizard threadId={activeThread.id} />
        <Composer
          threadId={activeThread.id}
          workspaceId={activeWorkspaceId ?? undefined}
          branchFromMessageId={branchFromMessageId}
          branchFromMessageContent={branchFromMessageContent}
          selectedTextComment={pendingSelectedTextComment ?? undefined}
          onSelectedTextCommentConsumed={consumeSelectedTextComment}
          onBranchModeExit={() => {
            if (activeThreadId) setForkMode(activeThreadId, null);
          }}
        />
      </div>
    </div>
  );
}
