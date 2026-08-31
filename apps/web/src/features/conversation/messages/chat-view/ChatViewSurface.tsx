import { useMemo, type ComponentProps, type ReactNode } from "react";
import { Bug, GitFork, Hammer, SearchCode, ScanSearch } from "lucide-react";
import type { SelectedTextComment, TurnRecovery } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CliErrorBanner, isCliError } from "@/components/chat/CliErrorBanner";
import { CollapsibleError } from "@/components/chat/CollapsibleError";
import { ConversationHoldOverlay } from "@/components/chat/ConversationHoldOverlay";
import { ErroredSessionsBanner } from "@/components/chat/ErroredSessionsBanner";
import { HandoffFallbackBanner } from "@/components/chat/HandoffFallbackBanner";
import { HeaderActions } from "@/components/chat/HeaderActions";
import { InterruptedSessionsBanner } from "@/components/chat/InterruptedSessionsBanner";
import { NewThreadProjectPicker } from "@/components/chat/NewThreadProjectPicker";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { ThreadTitleEditor } from "@/components/chat/ThreadTitleEditor";
import { ThreadWarningBanner } from "@/components/chat/ThreadWarningBanner";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { ProjectAutomaticSetupThreadBlock } from "@/features/projects/environment";
import { preparingStatusLabel, type WorkspaceThread } from "@/lib/workspace-thread";
import type { SubagentRosterTarget } from "../../narrative";
import { Composer } from "../../composer/Composer";
import { SavingDelayedDialog } from "../../saving/SavingDelayedDialog";
import { MessageList } from "../MessageList";
import type { ChatViewState } from "./useChatViewState";

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

/** Actions that the visual chat surface routes to stores, transport, and composer state. */
export interface ChatViewInteractions {
  /** Opens inline fork mode from a transcript message. */
  onBranch: (messageId: string) => void;
  /** Opens inline reply mode from a transcript message. */
  onReply: (messageId: string, content: string, role: "user" | "assistant") => void;
  /** Starts a selected-text comment in the composer. */
  onSelectedTextComment: (comment: SelectedTextComment) => void;
  /** Clears the composer selected-text comment after it is consumed. */
  onSelectedTextCommentConsumed: () => void;
  /** Prefills the new-thread composer with a starter prompt. */
  onPromptSelect: (text: string) => void;
  /** Prefills the composer for a persisted interrupted turn. */
  onContinue: () => void;
  /** Retries a persisted turn by execution identity. */
  onRetry: (executionId: string) => void;
  /** Stops the active agent after saving has stalled. */
  onStopSafely: () => Promise<void>;
  /** Continues a stalled turn without saving its recovery state. */
  onContinueWithoutSaving: () => Promise<void>;
  /** Dismisses the active CLI error. */
  onDismissCliError: () => void;
  /** Opens the model settings section. */
  onOpenSettings: () => void;
  /** Changes the current title. */
  onSaveTitle: (title: string) => void;
  /** Leaves inline fork mode. */
  onExitForkMode: () => void;
}

/** Recovery banner state and actions for the active conversation. */
export interface ChatRecoveryBannerState {
  /** Recoverable turns returned by the server. */
  turnRecoveries: TurnRecovery[];
  /** Hides recovery banners after a user action. */
  bannerDismissed: boolean;
  /** Retries the selected recoverable thread executions. */
  onRetry: (threadIds: string[]) => Promise<void>;
  /** Dismisses every visible recovery banner. */
  onDismiss: () => void;
}

/** Props for the root chat visual surface. */
export interface ChatViewSurfaceProps {
  /** Current selection and message display state. */
  state: ChatViewState;
  /** Chat UI actions. */
  interactions: ChatViewInteractions;
  /** State used by recovery banners. */
  recovery: ChatRecoveryBannerState;
  /** Current inline title editing state. */
  editingThreadId: string | null;
  /** Updates inline title editing state. */
  onEditingThreadIdChange: (threadId: string | null) => void;
  /** Pending composer comment from selected transcript text. */
  pendingSelectedTextComment: SelectedTextComment | null;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Error dismissed within the active thread. */
  dismissedError: string | null;
}

/** Renders the welcome canvas for a workspace without an active thread. */
function NewThreadWelcome({ projectName, onPromptSelect }: { projectName?: string; onPromptSelect: (text: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div key={projectName ?? "projectless"} data-testid="new-thread-welcome" className="animate-fade-up-in flex w-full max-w-[80rem] flex-col items-center gap-7 text-center">
        <McodeLogo variant="newThread" markOnly />
        <h1 aria-label={projectName ? `What should we build in ${projectName}?` : undefined} className="text-balance text-2xl font-medium tracking-[-0.025em] text-foreground sm:text-[28px]">
          {projectName ? (
            <>
              What should we build in{" "}
              <NewThreadProjectPicker
                placement="bottom"
                triggerTooltip="Change project"
                trigger={
                  <Button type="button" variant="link" size="sm" data-testid="new-thread-active-project-picker" className="h-auto min-h-0 gap-0 rounded-sm px-0 py-0 align-baseline !text-2xl font-[inherit] leading-[inherit] text-primary no-underline hover:bg-transparent hover:text-primary/80 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60 sm:!text-[28px]">
                    {projectName}<span className="text-foreground">?</span>
                  </Button>
                }
              />
            </>
          ) : "What should we work on?"}
        </h1>
        <div data-testid="new-thread-starters" className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-3">
          {NEW_THREAD_STARTERS.map(({ label, prompt, icon: Icon }) => (
            <Button key={label} type="button" variant="outline" onClick={() => onPromptSelect(prompt)} className="group h-auto min-h-24 flex-col items-start justify-between rounded-xl border-border/70 bg-transparent px-4 py-4 text-left shadow-none hover:border-primary/35 hover:bg-accent/45">
              <Icon className="size-4 text-primary transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transform-none" aria-hidden />
              <span className="w-full max-w-[18ch] text-wrap text-sm font-medium leading-5 text-foreground/90">{label}</span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Renders the welcome canvas and new-thread composer. */
function NewThreadSurface({ state, onPromptSelect }: { state: ChatViewState; onPromptSelect: (text: string) => void }) {
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {state.sidebarCollapsed && <div className="absolute left-2 top-2 z-10"><SidebarRevealButton /></div>}
      <NewThreadWelcome projectName={state.activeWorkspaceName || undefined} onPromptSelect={onPromptSelect} />
      <Composer isNewThread workspaceId={state.activeWorkspaceId ?? undefined} />
    </div>
  );
}

/** Renders a selected row while the server creates the backing thread. */
function ThreadPreparingShell({ thread, state }: { thread: WorkspaceThread; state: ChatViewState }) {
  const statusLabel = thread.clientPreparingContext ? preparingStatusLabel(thread.clientPreparingContext) : "Preparing…";
  return (
    <div className="flex h-full flex-col bg-background" data-testid="thread-preparing-shell">
      <div className="flex h-11 items-center justify-between border-b border-border pr-4 pl-2">
        <div className="flex min-w-0 items-center gap-2">
          {state.sidebarCollapsed && <SidebarRevealButton />}
          <span data-testid="chat-header-title" className="truncate text-sm font-medium">
            {thread.title}
            {thread.clientPreparing && <span className="ml-2 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary/60 align-middle" aria-hidden />}
          </span>
          {state.activeWorkspaceId && <Badge variant="secondary">{state.activeWorkspaceName}</Badge>}
          {thread.parent_thread_id && state.parentThreadExists && (
            <Tooltip>
              <TooltipTrigger render={<button type="button" onClick={() => useWorkspaceStore.getState().setActiveThread(thread.parent_thread_id!)} className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"><GitFork size={10} /><span>Forked</span></button>} />
              <TooltipContent side="bottom" className="text-xs">Go to parent thread</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col items-stretch justify-center gap-6 px-6 py-8">
        <div className="mx-auto w-full max-w-xl rounded-xl border border-border/50 bg-muted/15 px-4 py-3 text-sm text-foreground/90"><p className="whitespace-pre-wrap break-words">{thread.clientQueuedMessage ?? ""}</p></div>
        {thread.clientError ? (
          <CollapsibleError error={thread.clientError} onRetry={() => { void useWorkspaceStore.getState().retryPreparingThread(thread.id); }} onDismiss={() => useWorkspaceStore.getState().dismissPreparingThread(thread.id)} />
        ) : <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm"><Spinner size={16} /><span>{statusLabel}</span></div>}
      </div>
      <Composer threadId={thread.id} workspaceId={state.activeWorkspaceId ?? undefined} />
    </div>
  );
}

/** Renders the selected-row shell when no matching workspace thread remains. */
function MissingThreadSurface({ sidebarCollapsed }: { sidebarCollapsed: boolean }) {
  return (
    <div className="flex h-full flex-col bg-background">
      {sidebarCollapsed && <div className="flex h-11 items-center border-b border-border/40 pl-2"><SidebarRevealButton /></div>}
      <div className="flex flex-1 items-center justify-center"><div className="text-center"><h2 className="text-lg font-medium text-foreground">Select a thread</h2><p className="mt-1 text-sm text-muted-foreground">Choose a thread from the sidebar or create a new one.</p></div></div>
    </div>
  );
}

/** Renders the active thread header and navigation controls. */
function ActiveThreadHeader({ state, editingThreadId, onEditingThreadIdChange, onSaveTitle }: { state: ChatViewState; editingThreadId: string | null; onEditingThreadIdChange: (threadId: string | null) => void; onSaveTitle: (title: string) => void }) {
  const thread = state.activeThread!;
  return (
    <div className="flex h-11 items-center justify-between border-b border-border pr-4 pl-2">
      <div className="flex items-center gap-2">
        {state.sidebarCollapsed && <SidebarRevealButton />}
        <div data-testid="chat-header-title" onDoubleClick={() => onEditingThreadIdChange(thread.id)} className="cursor-text">
          <ThreadTitleEditor title={thread.title} isEditing={editingThreadId === thread.id} onSave={onSaveTitle} onCancel={() => onEditingThreadIdChange(null)} />
        </div>
        {thread.parent_thread_id && state.parentThreadExists && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => state.setActiveThread(thread.parent_thread_id!)} className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"><GitFork size={10} /><span>Forked</span></button>} />
            <TooltipContent side="bottom" className="text-xs">Go to parent thread</TooltipContent>
          </Tooltip>
        )}
      </div>
      <HeaderActions thread={thread} threadPaneWidth={state.threadPaneWidth} />
    </div>
  );
}

/** Renders restart recovery and worktree warning banners. */
function ActiveThreadBanners({ state, recovery }: { state: ChatViewState; recovery: ChatRecoveryBannerState }) {
  const interruptedThreadIds = recovery.turnRecoveries.filter((recovery) => recovery.phase === "interrupted").map((recovery) => recovery.threadId);
  const erroredThreadIds = recovery.turnRecoveries.filter((recovery) => recovery.phase === "errored").map((recovery) => recovery.threadId);
  const thread = state.activeThread!;
  return (
    <>
      {interruptedThreadIds.length > 0 && !recovery.bannerDismissed && <div className="px-4 pt-2"><InterruptedSessionsBanner threadIds={interruptedThreadIds} onRetry={recovery.onRetry} onDismiss={recovery.onDismiss} /></div>}
      {erroredThreadIds.length > 0 && !recovery.bannerDismissed && <div className="px-4 pt-2"><ErroredSessionsBanner threadIds={erroredThreadIds} onRetry={recovery.onRetry} onDismiss={recovery.onDismiss} /></div>}
      {thread.clientWarnings?.length ? <div className="px-4 pt-2"><ThreadWarningBanner warnings={thread.clientWarnings} onDismiss={() => useWorkspaceStore.getState().dismissWarnings(thread.id)} /></div> : null}
    </>
  );
}

type ConversationStage = "hold" | "transition" | "error" | "messages";

/** Checks whether a retained outgoing transcript must remain visible. */
function hasConversationHold(state: ChatViewState): boolean {
  return state.displayHoldThreadId !== null && !state.targetPaintable;
}

/** Checks whether the selected conversation still needs its hydration shell. */
function hasConversationTransition(state: ChatViewState): boolean {
  const conversationLoading = state.hydratedThreadId !== state.activeThreadId || state.historyLoading;
  return conversationLoading && !state.targetPaintable && !state.isAgentRunning;
}

/** Checks whether a hydration failure replaces the transcript stage. */
function hasFullConversationError(state: ChatViewState): boolean {
  return isConversationError(state.sessionError)
    && state.messageCount === 0
    && !state.isAgentRunning;
}

/** Checks whether an error belongs in the conversation rather than the CLI banner. */
function isConversationError(error: string | null): boolean {
  return error !== null && !isCliError(error);
}

/** Checks whether an undisposed CLI error should remain visible. */
function isVisibleCliError(error: string | null, dismissedError: string | null): boolean {
  return error !== null && isCliError(error) && error !== dismissedError;
}

/** Selects the visible conversation stage while MessageList remains the scroll owner. */
function getConversationStage(state: ChatViewState): ConversationStage {
  if (hasConversationHold(state)) return "hold";
  if (hasConversationTransition(state)) return "transition";
  if (hasFullConversationError(state)) return "error";
  return "messages";
}

/** Renders one selected conversation stage without taking over MessageList scrolling. */
function ConversationStageContent({
  stage,
  state,
  thread,
  leadingContent,
  messageListProps,
}: {
  stage: ConversationStage;
  state: ChatViewState;
  thread: WorkspaceThread;
  leadingContent: ReactNode;
  messageListProps: Omit<ComponentProps<typeof MessageList>, "leadingContent" | "displayThreadId">;
}) {
  if (stage === "hold") {
    return <div className="relative h-full" aria-busy="true"><div className="pointer-events-none h-full" inert><MessageList {...messageListProps} displayThreadId={state.displayHoldThreadId!} /></div><ConversationHoldOverlay targetTitle={thread.title || "Conversation"} /></div>;
  }
  if (stage === "transition") return <ConversationTransitionState threadId={thread.id} threadTitle={thread.title || "Conversation"} />;
  if (stage === "error") return <ConversationErrorState error={state.sessionError ?? ""} />;
  return <MessageList {...messageListProps} leadingContent={leadingContent} />;
}

/** Renders the conversation stage without taking over MessageList scrolling. */
function ChatMessageStage({ state, interactions, onSubagentSelect, onOpenSubagents }: Pick<ChatViewSurfaceProps, "state" | "interactions" | "onSubagentSelect" | "onOpenSubagents">) {
  const thread = state.activeThread!;
  const automaticSetupTranscriptBlock = useMemo(() => (
    thread.mode === "worktree" && thread.worktree_managed === true
      ? <ProjectAutomaticSetupThreadBlock threadId={thread.id} workspaceId={thread.workspace_id} />
      : undefined
  ), [thread.id, thread.mode, thread.workspace_id, thread.worktree_managed]);
  const messageListProps = {
    onBranch: interactions.onBranch,
    onReply: interactions.onReply,
    onSelectedTextComment: interactions.onSelectedTextComment,
    onSubagentSelect,
    onOpenSubagents,
    onContinue: interactions.onContinue,
    onRetry: interactions.onRetry,
  };
  return (
    <div data-testid="chat-message-stage" className="animate-fade-up-in flex-1 min-h-0 transition-[padding] duration-200" style={{ paddingRight: state.overviewPaddingRight }}>
      <ConversationStageContent stage={getConversationStage(state)} state={state} thread={thread} leadingContent={automaticSetupTranscriptBlock} messageListProps={messageListProps} />
    </div>
  );
}

/** Renders the composer and plan question wizard for an active thread. */
function ActiveThreadComposer({ state, interactions, pendingSelectedTextComment }: Pick<ChatViewSurfaceProps, "state" | "interactions" | "pendingSelectedTextComment">) {
  const thread = state.activeThread!;
  return (
    <div data-testid="chat-composer-stage" className="relative flex-shrink-0 transition-[padding] duration-200" style={{ paddingRight: state.overviewPaddingRight }}>
      <PlanQuestionWizard threadId={thread.id} />
      <Composer threadId={thread.id} workspaceId={state.activeWorkspaceId ?? undefined} branchFromMessageId={state.branchFromMessageId} branchFromMessageContent={state.branchFromMessageContent} selectedTextComment={pendingSelectedTextComment ?? undefined} onSelectedTextCommentConsumed={interactions.onSelectedTextCommentConsumed} onBranchModeExit={interactions.onExitForkMode} />
    </div>
  );
}

/** Shows the selected conversation's non-provider hydration failure. */
function ConversationErrorState({ error }: { error: string }) {
  return <div data-testid="conversation-error" role="alert" className="flex h-full items-center justify-center px-4"><div className="max-w-md space-y-1 text-center"><p className="font-medium text-foreground">Could not load conversation</p><p className="text-sm text-muted-foreground">{error}</p></div></div>;
}

/** Keeps a cold switch target visible without rendering stale transcript content. */
function ConversationTransitionState({ threadId, threadTitle }: { threadId: string; threadTitle: string }) {
  return <div data-testid="conversation-transition-shell" data-thread-id={threadId} role="status" aria-label={`Loading ${threadTitle}`} className="flex h-full items-center justify-center px-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={16} /><span>{threadTitle}</span></div></div>;
}

/** Renders the fully active conversation surface. */
function ActiveThreadSurface(props: ChatViewSurfaceProps) {
  const { state, interactions, recovery, editingThreadId, onEditingThreadIdChange, pendingSelectedTextComment, onSubagentSelect, onOpenSubagents, dismissedError } = props;
  const thread = state.activeThread!;
  const showConversationError = isConversationError(state.sessionError);
  const showConversationErrorBanner = showConversationError && (state.messageCount > 0 || state.isAgentRunning);
  const showCliError = isVisibleCliError(state.sessionError, dismissedError);
  return (
    <div ref={state.chatPaneRef} className="flex h-full flex-col bg-background" data-testid="chat-view">
      <ActiveThreadHeader state={state} editingThreadId={editingThreadId} onEditingThreadIdChange={onEditingThreadIdChange} onSaveTitle={interactions.onSaveTitle} />
      <ActiveThreadBanners state={state} recovery={recovery} />
      {showConversationErrorBanner ? <div className="mx-3 mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"><p data-testid="conversation-error-banner" role="alert" className="text-sm text-destructive">Could not refresh conversation: {state.sessionError}</p></div> : null}
      <HandoffFallbackBanner threadId={thread.id} />
      <SavingDelayedDialog open={state.savingStatus?.mode === "saving-delayed"} onStopSafely={interactions.onStopSafely} onContinueWithoutSaving={interactions.onContinueWithoutSaving} />
      <ChatMessageStage state={state} interactions={interactions} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} />
      {showCliError && <CliErrorBanner error={state.sessionError!} onDismiss={interactions.onDismissCliError} onOpenSettings={interactions.onOpenSettings} />}
      <ActiveThreadComposer state={state} interactions={interactions} pendingSelectedTextComment={pendingSelectedTextComment} />
    </div>
  );
}

/** Selects the visual chat shell for the current workspace selection. */
export function ChatViewSurface(props: ChatViewSurfaceProps) {
  const { state } = props;
  if (!state.activeThreadId) return <NewThreadSurface state={state} onPromptSelect={props.interactions.onPromptSelect} />;
  if (state.activeThread?.clientPreparing || state.activeThread?.clientError) return <ThreadPreparingShell thread={state.activeThread} state={state} />;
  if (!state.activeThread) return <MissingThreadSurface sidebarCollapsed={state.sidebarCollapsed} />;
  return <ActiveThreadSurface {...props} />;
}
