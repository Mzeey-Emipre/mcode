import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { Bug, GitFork, Hammer, SearchCode, ScanSearch } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  useActiveWorkspaceThread,
  useParentThreadExists,
} from "@/stores/workspace-selectors";
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
import { ConversationHoldOverlay } from "@/components/chat/ConversationHoldOverlay";
import { Composer } from "../composer/Composer";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { HeaderActions } from "@/components/chat/HeaderActions";
import { CliErrorBanner, isCliError } from "@/components/chat/CliErrorBanner";
import { InterruptedSessionsBanner } from "@/components/chat/InterruptedSessionsBanner";
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
  recordSubscriptionSkipped,
  recordThreadHoldEnd,
  recordThreadHoldStart,
} from "@/lib/thread-switch-telemetry";
import {
  MAX_THREAD_SUBSCRIPTIONS,
  type SetThreadSubscriptionsInput,
  type TurnRecovery,
} from "@mcode/contracts";

/** Entry point suggestions shown in the empty state — each maps to a real Mcode capability. */
const ENTRY_POINTS = [
  {
    label: "Start agent in new worktree",
    description: "Isolated branch, no stash needed",
    prompt: "Start a new worktree and run an agent to ",
  },
  {
    label: "Run agent on this branch",
    description: "Direct mode, commits to current branch",
    prompt: "On the current branch, ",
  },
  {
    label: "Orchestrate parallel tasks",
    description: "Multiple agents, one goal",
    prompt: "Spawn parallel agents to ",
  },
  {
    label: "Review open PRs",
    description: "Diff + summary for each",
    prompt: "List and summarize open pull requests in this repo",
  },
] as const;

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

/** Props for {@link EmptyState}. */
interface EmptyStateProps {
  /** Called when the user clicks an entry point — prefills the composer. */
  onPromptSelect: (text: string) => void;
}

/** Centered empty state selling Mcode's multi-agent, worktree-based value. */
function EmptyState({ onPromptSelect }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-8 px-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <span aria-hidden="true" className="font-mono text-[36px] leading-none text-muted-foreground/15">⊕</span>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/55">no messages yet</p>
      </div>
      <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
        {ENTRY_POINTS.map((ep) => (
          <button
            key={ep.label}
            type="button"
            onClick={() => onPromptSelect(ep.prompt)}
            className="flex flex-col items-start gap-0.5 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:border-border/70 hover:bg-muted/40"
          >
            <span className="text-xs font-medium text-foreground/80">{ep.label}</span>
            <span className="text-xs text-muted-foreground/60">{ep.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
const THREAD_SUBSCRIPTION_RETRY_BASE_MS = 100;
const THREAD_SUBSCRIPTION_RETRY_MAX_MS = 1_600;
const THREAD_SUBSCRIPTION_MAX_RETRIES = 4;

type ThreadSubscriptionAction = "subscribe" | "unsubscribe";
type AtomicSubscriptionRequest = {
  epoch: number;
  signature: string;
  id: number;
};

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
  onSubagentSelect?: (id: string) => void;
}

/** Renders the main chat UI for sending and receiving messages within a thread. */
export function ChatView({ onSubagentSelect }: ChatViewProps = {}) {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const setForkMode = useThreadStore((s) => s.setForkMode);
  const activeForkMode = useActiveThreadRecord((r) => r.forkMode);
  const branchFromMessageId = activeForkMode?.messageId;
  const branchFromMessageContent = activeForkMode?.content ?? undefined;
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const canonicalRecoverySignature = useThreadStore((state) =>
    Array.from(state.records)
      .filter(([, record]) => record.canonicalAgent.recoveryRequired)
      .map(([threadId]) => threadId)
      .sort()
      .join("\u0000")
  );
  const hydratedThreadId = useThreadStore((s) => s.currentThreadId);
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
  const parentThreadExists = useParentThreadExists(activeThread?.parent_thread_id);
  const sessionError = useActiveThreadRecord((r) => r.error);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [turnRecoveries, setTurnRecoveries] = useState<TurnRecovery[]>([]);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const interruptedThreadIds = turnRecoveries.map((recovery) => recovery.threadId);

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

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }));
  }, []);

  // Reset the banner dismissal on each new disconnect so a second server restart
  // in the same session can show the banner again.
  useEffect(() => {
    if (connectionStatus !== "connected") setBannerDismissed(false);
  }, [connectionStatus]);

  // Load only canonical interrupted executions. Legacy thread status alone does
  // not prove that Mcode has accepted input which it can retry safely.
  useEffect(() => {
    if (connectionStatus !== "connected" || bannerDismissed) return;
    let cancelled = false;
    void getTransport().listTurnRecoveries().then((recoveries) => {
      if (!cancelled) setTurnRecoveries(recoveries);
    }).catch((error: unknown) => {
      console.error("Failed to load interrupted turn recoveries", error);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, bannerDismissed]);

  /** Retries each selected interruption as a new execution, then hides the banner. */
  const handleRetryInterrupted = useCallback(
    async (threadIds: string[]) => {
      setBannerDismissed(true);
      const failedIds: string[] = [];
      for (const threadId of threadIds) {
        try {
          const recovery = turnRecoveries.find((candidate) => candidate.threadId === threadId);
          if (!recovery || !recovery.actions.includes("retry")) throw new Error("Retry is unavailable");
          await getTransport().retryTurn(recovery.executionId);
        } catch (error) {
          console.error("Failed to retry interrupted thread", threadId, error);
          failedIds.push(threadId);
        }
      }
      if (failedIds.length > 0) {
        setTurnRecoveries((recoveries) =>
          recoveries.filter((recovery) => failedIds.includes(recovery.threadId)));
        setBannerDismissed(false);
      } else {
        setTurnRecoveries([]);
      }
    },
    [turnRecoveries],
  );

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

  const prevThreadIdRef = useRef<string | null>(null);
  const confirmedThreadIdsRef = useRef<Set<string>>(new Set());
  const desiredThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingThreadChangesRef = useRef<Map<string, symbol>>(new Map());
  const previousSubscriptionStatusRef = useRef<typeof connectionStatus | null>(null);
  const subscriptionEpochRef = useRef(0);
  const subscriptionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionRetryAttemptRef = useRef(0);
  const subscriptionRetryExhaustedRef = useRef(false);
  const subscriptionTargetSignatureRef = useRef("");
  const atomicSubscriptionRequestIdRef = useRef(0);
  const atomicSubscriptionRequestRef = useRef<AtomicSubscriptionRequest | null>(null);
  const pendingAtomicThreadIdsRef = useRef<Map<number, string[]>>(new Map());
  const subscriptionMountedRef = useRef(true);
  const [subscriptionReconcileVersion, setSubscriptionReconcileVersion] = useState(0);

  useEffect(() => {
    const orderedDesiredThreadIds = [
      ...(activeThreadId ? [activeThreadId] : []),
      ...Array.from(runningThreadIds).filter((threadId) => threadId !== activeThreadId).sort(),
    ].slice(0, MAX_THREAD_SUBSCRIPTIONS);
    const desired = new Set(orderedDesiredThreadIds);
    desiredThreadIdsRef.current = desired;

    const targetSignature = `${connectionStatus}:${orderedDesiredThreadIds.join("\u0000")}`;
    if (subscriptionTargetSignatureRef.current !== targetSignature) {
      subscriptionTargetSignatureRef.current = targetSignature;
      subscriptionRetryAttemptRef.current = 0;
      subscriptionRetryExhaustedRef.current = false;
      if (subscriptionRetryTimerRef.current !== null) {
        clearTimeout(subscriptionRetryTimerRef.current);
        subscriptionRetryTimerRef.current = null;
      }
    }

    const reconnected = connectionStatus === "connected"
      && previousSubscriptionStatusRef.current !== "connected";
    const disconnected = connectionStatus !== "connected"
      && previousSubscriptionStatusRef.current === "connected";
    if (reconnected || disconnected) {
      subscriptionEpochRef.current += 1;
      confirmedThreadIdsRef.current.clear();
      pendingThreadChangesRef.current.clear();
    }
    previousSubscriptionStatusRef.current = connectionStatus;

    if (connectionStatus !== "connected" || subscriptionRetryExhaustedRef.current) return;

    const epoch = subscriptionEpochRef.current;
    const setThreadSubscriptions = getTransport().setThreadSubscriptions;
    if (setThreadSubscriptions) {
      const sortedThreadIds = orderedDesiredThreadIds;
      const sentThreadIds = new Set(sortedThreadIds);
      const confirmed = confirmedThreadIdsRef.current;
      const needsCanonicalRecovery = sortedThreadIds.some((threadId) =>
        readThreadRecord(threadId).canonicalAgent.recoveryRequired
      );
      const alreadyApplied = confirmed.size === desired.size
        && Array.from(confirmed).every((threadId) => desired.has(threadId))
        && !needsCanonicalRecovery;
      const pending = atomicSubscriptionRequestRef.current;
      if (alreadyApplied) {
        const telemetryThreadId = activeThreadId ?? sortedThreadIds[0];
        if (telemetryThreadId) recordSubscriptionSkipped(telemetryThreadId);
        return;
      }
      if (pending?.epoch === epoch) return;
      const requestId = atomicSubscriptionRequestIdRef.current + 1;
      atomicSubscriptionRequestIdRef.current = requestId;
      atomicSubscriptionRequestRef.current = {
        epoch,
        signature: targetSignature,
        id: requestId,
      };
      pendingAtomicThreadIdsRef.current.set(requestId, sortedThreadIds);
      const cursors: NonNullable<SetThreadSubscriptionsInput["cursors"]> = {};
      const revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]> = {};
      const cursorAuthority = new Map<string, { epoch?: string; sequence?: number }>();
      for (const threadId of sortedThreadIds) {
        const record = readThreadRecord(threadId);
        revisions[threadId] = record.canonicalAgent.revision;
        const sequence = record.lastAgentEventSequence;
        if (typeof sequence === "number" && sequence > 0) {
          cursorAuthority.set(threadId, {
            epoch: record.lastAgentEventEpoch,
            sequence,
          });
          cursors[threadId] = record.lastAgentEventEpoch
            ? { epoch: record.lastAgentEventEpoch, sequence }
            : sequence;
        }
      }
      const input = Object.keys(cursors).length > 0
        ? { threadIds: sortedThreadIds, cursors, revisions }
        : { threadIds: sortedThreadIds, revisions };
      const isCurrentAtomicResponse = () => {
        const currentRequest = atomicSubscriptionRequestRef.current;
        const latestDesired = desiredThreadIdsRef.current;
        return subscriptionMountedRef.current
          && subscriptionEpochRef.current === epoch
          && currentRequest?.epoch === epoch
          && currentRequest?.id === requestId
          && currentRequest?.signature === targetSignature
          && subscriptionTargetSignatureRef.current === targetSignature
          && latestDesired.size === sentThreadIds.size
          && Array.from(latestDesired).every((threadId) => sentThreadIds.has(threadId));
      };
      void setThreadSubscriptions(input).then((result) => {
        if (!isCurrentAtomicResponse()) return;
        const canonicalRecoveries = result?.canonicalRecoveries ?? [];
        if (canonicalRecoveries.length > 0) {
          useThreadStore.getState().applyCanonicalReconnectRecoveries(canonicalRecoveries);
        }
        const residency = getConversationResidency();
        for (const recovery of canonicalRecoveries) {
          const requested = revisions[recovery.threadId];
          const through = recovery.mode === "snapshot"
            ? recovery.snapshot.revision
            : recovery.through;
          const changed = recovery.mode === "snapshot"
            || !requested
            || through.conversationRevision > requested.conversationRevision
            || through.rosterRevision > requested.rosterRevision;
          if (!changed) continue;
          residency.invalidateConversation(recovery.threadId);
          if (recovery.threadId === activeThreadId) {
            void residency.refresh(
              activeThreadId,
              useWorkspaceStore.getState().threads,
            ).catch(() => {});
          }
        }
        if (result?.hydrationRequiredThreadIds?.length) {
          for (const threadId of result.hydrationRequiredThreadIds) {
            const expected = cursorAuthority.get(threadId);
            if (!isCurrentAtomicResponse()) return;
            useThreadStore.setState((state) => {
              const record = state.records.get(threadId);
              if (!record) return state;
              const stillOwnsCursor = expected?.epoch
                ? record.lastAgentEventEpoch === expected.epoch
                  && record.lastAgentEventSequence === expected.sequence
                : record.lastAgentEventEpoch === undefined
                  && record.lastAgentEventSequence === expected?.sequence;
              if (!stillOwnsCursor) return state;
              const records = new Map(state.records);
              records.set(threadId, {
                ...record,
                lastAgentEventEpoch: undefined,
                lastAgentEventSequence: undefined,
              });
              return { records };
            });
            if (!isCurrentAtomicResponse()) return;
            residency.invalidateConversation(threadId);
            if (threadId === activeThreadId && runningThreadIds.has(threadId)) {
              if (!isCurrentAtomicResponse()) return;
              void residency.refresh(threadId, useWorkspaceStore.getState().threads).catch(() => {});
            }
          }
        }
        if (!isCurrentAtomicResponse()) return;
        confirmedThreadIdsRef.current = sentThreadIds;
        subscriptionRetryAttemptRef.current = 0;
        subscriptionRetryExhaustedRef.current = false;
      }).catch(() => {
        if (!subscriptionMountedRef.current || subscriptionEpochRef.current !== epoch) return;
        const currentRequest = atomicSubscriptionRequestRef.current;
        if (currentRequest?.epoch !== epoch || currentRequest.id !== requestId) return;
        if (subscriptionTargetSignatureRef.current !== targetSignature) return;
        if (subscriptionRetryAttemptRef.current >= THREAD_SUBSCRIPTION_MAX_RETRIES) {
          subscriptionRetryExhaustedRef.current = true;
          return;
        }
        const delay = Math.min(
          THREAD_SUBSCRIPTION_RETRY_BASE_MS * (2 ** subscriptionRetryAttemptRef.current),
          THREAD_SUBSCRIPTION_RETRY_MAX_MS,
        );
        subscriptionRetryAttemptRef.current += 1;
        subscriptionRetryTimerRef.current = setTimeout(() => {
          subscriptionRetryTimerRef.current = null;
          if (subscriptionMountedRef.current) {
            setSubscriptionReconcileVersion((version) => version + 1);
          }
        }, delay);
      }).finally(() => {
        pendingAtomicThreadIdsRef.current.delete(requestId);
        if (atomicSubscriptionRequestRef.current?.epoch === epoch
          && atomicSubscriptionRequestRef.current.id === requestId) {
          atomicSubscriptionRequestRef.current = null;
          if (subscriptionMountedRef.current
            && subscriptionEpochRef.current === epoch
            && subscriptionTargetSignatureRef.current !== targetSignature) {
            setSubscriptionReconcileVersion((version) => version + 1);
          }
        }
      });
      return;
    }

    const operations: Promise<boolean>[] = [];
    const startChange = (threadId: string, action: ThreadSubscriptionAction) => {
      const change = Symbol();
      pendingThreadChangesRef.current.set(threadId, change);
      const request = action === "subscribe"
        ? getTransport().subscribeThread(threadId)
        : getTransport().unsubscribeThread(threadId);

      operations.push(request.then(() => {
        if (subscriptionEpochRef.current !== epoch) return true;
        if (action === "subscribe") confirmedThreadIdsRef.current.add(threadId);
        else confirmedThreadIdsRef.current.delete(threadId);
        return true;
      }, () => false).finally(() => {
        if (pendingThreadChangesRef.current.get(threadId) === change) {
          pendingThreadChangesRef.current.delete(threadId);
        }
      }));
    };

    for (const threadId of desired) {
      if (!confirmedThreadIdsRef.current.has(threadId)
        && !pendingThreadChangesRef.current.has(threadId)) {
        startChange(threadId, "subscribe");
      }
    }
    for (const threadId of confirmedThreadIdsRef.current) {
      if (!desired.has(threadId) && !pendingThreadChangesRef.current.has(threadId)) {
        startChange(threadId, "unsubscribe");
      }
    }

    if (operations.length === 0) return;

    void Promise.all(operations).then((results) => {
      if (!subscriptionMountedRef.current || subscriptionEpochRef.current !== epoch) return;
      if (subscriptionTargetSignatureRef.current !== targetSignature) {
        setSubscriptionReconcileVersion((version) => version + 1);
        return;
      }

      if (results.every(Boolean)) {
        subscriptionRetryAttemptRef.current = 0;
        subscriptionRetryExhaustedRef.current = false;
        const confirmed = confirmedThreadIdsRef.current;
        const latestDesired = desiredThreadIdsRef.current;
        const needsReconcile = confirmed.size !== latestDesired.size
          || Array.from(confirmed).some((threadId) => !latestDesired.has(threadId));
        if (needsReconcile) {
          setSubscriptionReconcileVersion((version) => version + 1);
        }
        return;
      }

      if (subscriptionRetryAttemptRef.current >= THREAD_SUBSCRIPTION_MAX_RETRIES) {
        subscriptionRetryExhaustedRef.current = true;
        return;
      }

      const delay = Math.min(
        THREAD_SUBSCRIPTION_RETRY_BASE_MS * (2 ** subscriptionRetryAttemptRef.current),
        THREAD_SUBSCRIPTION_RETRY_MAX_MS,
      );
      subscriptionRetryAttemptRef.current += 1;
      subscriptionRetryTimerRef.current = setTimeout(() => {
        subscriptionRetryTimerRef.current = null;
        if (subscriptionMountedRef.current) {
          setSubscriptionReconcileVersion((version) => version + 1);
        }
      }, delay);
    });
  }, [activeThreadId, canonicalRecoverySignature, connectionStatus, runningThreadIds, subscriptionReconcileVersion]);

  useEffect(() => {
    subscriptionMountedRef.current = true;
    return () => {
      subscriptionMountedRef.current = false;
      const pendingAtomicThreadIds = Array.from(pendingAtomicThreadIdsRef.current.values()).flat();
      subscriptionEpochRef.current += 1;
      if (subscriptionRetryTimerRef.current !== null) {
        clearTimeout(subscriptionRetryTimerRef.current);
        subscriptionRetryTimerRef.current = null;
      }
      const threadIds = new Set([
        ...confirmedThreadIdsRef.current,
        ...desiredThreadIdsRef.current,
        ...pendingAtomicThreadIds,
      ]);
      if (threadIds.size > 0) {
        const setThreadSubscriptions = getTransport().setThreadSubscriptions;
        if (setThreadSubscriptions) {
          void setThreadSubscriptions({ threadIds: [] }).catch(() => {});
        } else {
          for (const threadId of threadIds) {
            void getTransport().unsubscribeThread(threadId).catch(() => {});
          }
        }
      }
      confirmedThreadIdsRef.current.clear();
      desiredThreadIdsRef.current.clear();
      pendingThreadChangesRef.current.clear();
      pendingAtomicThreadIdsRef.current.clear();
    };
  }, []);

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
  const showEmptyState = !hasMessages && !isAgentRunning && !conversationLoading && !showHold;
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
            onRetry={handleRetryInterrupted}
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
                onSubagentSelect={onSubagentSelect}
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
        ) : showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState onPromptSelect={setPendingPrefill} />
          </div>
        ) : (
          <MessageList
            onBranch={handleBranch}
            onReply={handleReply}
            onSubagentSelect={onSubagentSelect}
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
          onBranchModeExit={() => {
            if (activeThreadId) setForkMode(activeThreadId, null);
          }}
        />
      </div>
    </div>
  );
}
