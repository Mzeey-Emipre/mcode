import { useEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { HeaderActions } from "./HeaderActions";

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

/** Renders the main chat UI for sending and receiving messages within a thread. */
export function ChatView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const messages = useThreadStore((s) => s.messages);
  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);

  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = threads.find((t) => t.id === activeThreadId);

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === (activeThread?.workspace_id ?? activeWorkspaceId))?.name ?? "",
    [workspaces, activeThread?.workspace_id, activeWorkspaceId],
  );

  useEffect(() => {
    if (activeThreadId) {
      loadMessages(activeThreadId);
    } else {
      clearMessages();
    }
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
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{activeThread.title}</span>
          <Badge variant="secondary">
            {activeWorkspaceName}
          </Badge>
          {activeThread.branch && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground/50">
              <GitBranch size={11} />
              <span className="max-w-[160px] truncate">{activeThread.branch}</span>
            </span>
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
          <MessageList />
        )}
      </div>

      {/* Composer */}
      <Composer threadId={activeThread.id} workspaceId={activeWorkspaceId ?? undefined} />
    </div>
  );
}
