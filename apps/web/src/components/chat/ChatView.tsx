import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Bug, GitFork, Hammer, SearchCode, ScanSearch } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  useActiveWorkspaceThread,
  useInterruptedThreadIds,
  useParentThreadExists,
} from "@/stores/workspace-selectors";
import { useThreadStore } from "@/stores/threadStore";
import { useActiveThreadRecord, readThreadRecord } from "@/stores/thread-selectors";
import { useConnectionStore } from "@/stores/connectionStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { HeaderActions } from "./HeaderActions";
import { CliErrorBanner, isCliError } from "./CliErrorBanner";
import { InterruptedSessionsBanner } from "./InterruptedSessionsBanner";
import { CollapsibleError } from "./CollapsibleError";
import { ThreadWarningBanner } from "./ThreadWarningBanner";
import { HandoffFallbackBanner } from "./HandoffFallbackBanner";
import { ThreadTitleEditor } from "./ThreadTitleEditor";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { useUiStore } from "@/stores/uiStore";
import { preparingStatusLabel, type WorkspaceThread } from "@/lib/workspace-thread";
import { useReplyStore } from "@/stores/replyStore";
import { getTransport } from "@/transport";
import { useElementWidth } from "@/hooks/useElementWidth";
import { overviewResponsivePaddingRight } from "@/lib/composer-layout";
import { Button } from "@/components/ui/button";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { NewThreadProjectPicker } from "./NewThreadProjectPicker";

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
            <span className="text-[11px] text-muted-foreground/60">{ep.description}</span>
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
        className="animate-fade-up-in flex w-full max-w-3xl flex-col items-center gap-7 text-center"
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
                    className="h-auto min-h-0 gap-0 rounded-sm px-0 py-0 align-baseline text-[inherit] font-[inherit] leading-[inherit] text-primary no-underline hover:bg-transparent hover:text-primary/80 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60"
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
        <div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {NEW_THREAD_STARTERS.map(({ label, prompt, icon: Icon }) => (
            <Button
              key={label}
              type="button"
              variant="outline"
              onClick={() => onPromptSelect(prompt)}
              className="group h-auto min-h-24 flex-col items-start justify-between rounded-xl border-border/70 bg-transparent px-4 py-3.5 text-left shadow-none hover:border-primary/35 hover:bg-accent/45"
            >
              <Icon size={15} className="text-primary transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transform-none" aria-hidden />
              <span className="max-w-32 text-wrap text-[13px] font-medium leading-5 text-foreground/90">
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
                    className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
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

/** Renders the main chat UI for sending and receiving messages within a thread. */
export function ChatView() {
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
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const messageCount = useActiveThreadRecord((r) => r.messages.length);
  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);

  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = useActiveWorkspaceThread((t) => t);
  const parentThreadExists = useParentThreadExists(activeThread?.parent_thread_id);
  const interruptedCandidates = useInterruptedThreadIds();
  const sessionError = useActiveThreadRecord((r) => r.error);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [interruptedThreadIds, setInterruptedThreadIds] = useState<string[]>([]);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const connectionStatus = useConnectionStore((s) => s.status);
  const sendMessage = useThreadStore((s) => s.sendMessage);
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

  // Detect interrupted threads whenever the connection is re-established so the
  // banner can offer to resume any sessions that were cut off by a server restart.
  // Always update so the banner clears when threads recover on their own.
  useEffect(() => {
    if (connectionStatus === "connected" && !bannerDismissed) {
      setInterruptedThreadIds((prev) => {
        if (
          prev.length === interruptedCandidates.length &&
          prev.every((id, i) => id === interruptedCandidates[i])
        ) {
          return prev;
        }
        return interruptedCandidates;
      });
    }
  }, [connectionStatus, interruptedCandidates, bannerDismissed]);

  /** Sends a continuation message to each interrupted thread, then hides the banner. */
  const handleResumeInterrupted = useCallback(
    async (threadIds: string[]) => {
      // Dismiss immediately so the effect does not repopulate the banner while
      // resume messages are in flight and threads still read as "interrupted".
      setBannerDismissed(true);
      // Read threads from store at call time to avoid closing over a stale
      // `threads` array, which would also make this callback unstable.
      const currentThreads = useWorkspaceStore.getState().threads;
      const failedIds: string[] = [];
      for (const threadId of threadIds) {
        try {
          const thread = currentThreads.find((t) => t.id === threadId);
          if (!thread) {
            failedIds.push(threadId);
            continue;
          }
          await sendMessage(
            threadId,
            "Continue where you left off. The server was restarted.",
            thread.model ?? undefined,
            thread.permission_mode ?? undefined,
          );
        } catch (err) {
          console.error("Failed to resume thread", threadId, err);
          failedIds.push(threadId);
        }
      }
      if (failedIds.length > 0) {
        // Keep banner visible for threads that failed to resume.
        setInterruptedThreadIds(failedIds);
        setBannerDismissed(false);
      } else {
        setInterruptedThreadIds([]);
      }
    },
    [sendMessage],
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

  useEffect(() => {
    if (!activeThreadId) return;
    void getTransport().subscribeThread(activeThreadId).catch(() => {});
    return () => {
      void getTransport().unsubscribeThread(activeThreadId).catch(() => {});
    };
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) {
      clearMessages();
    } else {
      const row = useWorkspaceStore.getState().threads.find((t) => t.id === activeThreadId);
      if (row?.clientPreparing || row?.clientError) {
        clearMessages();
      } else {
        loadMessages(activeThreadId);
      }
    }
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
  }, [activeThreadId, loadMessages, clearMessages]);

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
  const showEmptyState = !hasMessages && !isAgentRunning;

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
                    className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
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
            onResume={handleResumeInterrupted}
            onDismiss={() => {
              setBannerDismissed(true);
              setInterruptedThreadIds([]);
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
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState onPromptSelect={setPendingPrefill} />
          </div>
        ) : (
          <MessageList onBranch={handleBranch} onReply={handleReply} />
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
