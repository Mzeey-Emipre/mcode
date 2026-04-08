import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { GitBranch } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { HeaderActions } from "./HeaderActions";
import { CliErrorBanner, isCliError } from "./CliErrorBanner";
import { ThreadTitleEditor } from "./ThreadTitleEditor";

/** Prompt suggestions shown in the empty state. */
const PROMPT_CHIPS = [
  "Explain the current architecture",
  "Find and fix bugs in this codebase",
  "Write tests for the main module",
  "Refactor for better readability",
] as const;

/** Props for {@link EmptyState}. */
interface EmptyStateProps {
  /** Called when the user clicks a prompt suggestion chip. */
  onPromptSelect: (text: string) => void;
}

/** Centered empty state with logo and clickable prompt suggestion chips. */
function EmptyState({ onPromptSelect }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-base font-semibold tracking-tight text-foreground">Mcode</p>
        <p className="text-sm text-muted-foreground">What would you like to work on?</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {PROMPT_CHIPS.map((chip) => (
          <Button
            key={chip}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPromptSelect(chip)}
            className="rounded-full border-border/50 text-xs text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground"
          >
            {chip}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Blink cache threshold (bytes) above which we evict on thread switch. */
const CACHE_PRESSURE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Renders the main chat UI for sending and receiving messages within a thread. */
export function ChatView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  const threads = useWorkspaceStore((s) => s.threads);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [branchFromMessageId, setBranchFromMessageId] = useState<string | undefined>(undefined);
  const [branchFromMessageContent, setBranchFromMessageContent] = useState<string | undefined>(undefined);
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const messages = useThreadStore((s) => s.messages);
  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);

  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = threads.find((t) => t.id === activeThreadId);
  const sessionError = useThreadStore((s) => s.error);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const handleDismissCliError = useCallback(() => {
    setDismissedError(sessionError);
  }, [sessionError]);

  // Reset dismissed state when the active thread changes
  useEffect(() => {
    setDismissedError(null);
  }, [activeThreadId]);

  // Reset edit mode when the active thread changes
  useEffect(() => {
    setEditingThreadId(null);
  }, [activeThreadId]);

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }));
  }, []);

  /** Activates inline branch mode on the composer for the given message. */
  const handleBranch = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    setBranchFromMessageId(messageId);
    setBranchFromMessageContent(msg?.content);
  }, [messages]);

  const showCliError =
    !!sessionError &&
    isCliError(sessionError) &&
    sessionError !== dismissedError;

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === (activeThread?.workspace_id ?? activeWorkspaceId))?.name ?? "",
    [workspaces, activeThread?.workspace_id, activeWorkspaceId],
  );

  const prevThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeThreadId) {
      loadMessages(activeThreadId);
    } else {
      clearMessages();
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

  // New thread state: show empty composer when pending
  if (pendingNewThread && !activeThreadId) {
    return (
      <div className="flex h-full flex-col bg-background">
        {/* Header */}
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">New thread</span>
            {activeWorkspaceId && (
              <Badge variant="secondary">
                {activeWorkspaceName}
              </Badge>
            )}
          </div>
        </div>

        {/* Empty state */}
        <div className="flex flex-1 items-center justify-center">
          <EmptyState onPromptSelect={setPendingPrefill} />
        </div>

        {/* Composer for new thread */}
        <Composer isNewThread workspaceId={activeWorkspaceId ?? undefined} />
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-center">
          <h2 className="text-lg font-medium text-foreground">
            Select a thread
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a thread from the sidebar or create a new one.
          </p>
        </div>
      </div>
    );
  }

  const hasMessages = messages.length > 0;
  const showEmptyState = !hasMessages && !isAgentRunning;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="chat-view">
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
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
          <Badge variant="secondary">
            {activeWorkspaceName}
          </Badge>
          {activeThread.parent_thread_id && threads.some((t) => t.id === activeThread.parent_thread_id) && (
            <button
              type="button"
              onClick={() => setActiveThread(activeThread.parent_thread_id!)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Navigate to parent thread"
            >
              <GitBranch size={11} />
              <span>Branched</span>
            </button>
          )}
        </div>
        <HeaderActions thread={activeThread} />
      </div>

      {/* Messages, tool calls, and streaming - all in one scrollable area */}
      <div key={activeThread.id} className="animate-fade-up-in flex-1 min-h-0">
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState onPromptSelect={setPendingPrefill} />
          </div>
        ) : (
          <MessageList onBranch={handleBranch} />
        )}
      </div>

      {/* Plan question wizard — shown while plan questions are pending */}
      <PlanQuestionWizard threadId={activeThread.id} />

      {/* CLI error banner — shown when the provider binary is not found */}
      {showCliError && (
        <CliErrorBanner
          error={sessionError!}
          onDismiss={handleDismissCliError}
          onOpenSettings={handleOpenSettings}
        />
      )}

      {/* Composer — enters branch mode inline when a message bubble's branch action is used */}
      <Composer
        threadId={activeThread.id}
        workspaceId={activeWorkspaceId ?? undefined}
        branchFromMessageId={branchFromMessageId}
        branchFromMessageContent={branchFromMessageContent}
        onBranchModeExit={() => {
          setBranchFromMessageId(undefined);
          setBranchFromMessageContent(undefined);
        }}
      />
    </div>
  );
}
