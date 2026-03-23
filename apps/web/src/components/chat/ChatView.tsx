import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { StreamingIndicator } from "./StreamingIndicator";
import { ToolCallCard } from "./ToolCallCard";
import { HeaderActions } from "./HeaderActions";

export function ChatView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const messages = useThreadStore((s) => s.messages);

  const agentStartTimes = useThreadStore((s) => s.agentStartTimes);
  const toolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.toolCallsByThread[activeThreadId] : undefined
  );
  const toolCalls = toolCallsRaw ?? [];
  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;
  const agentStartTime = activeThreadId ? agentStartTimes[activeThreadId] : undefined;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = threads.find((t) => t.id === activeThreadId);

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
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">New thread</span>
            {activeWorkspaceId && (
              <span className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-foreground">
                {workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? ""}
              </span>
            )}
          </div>
        </div>

        {/* Empty state */}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Send a message to start the conversation.
          </p>
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
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{activeThread.title}</span>
          <span className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-foreground">
            {workspaces.find((w) => w.id === activeThread.workspace_id)?.name ?? ""}
          </span>
        </div>
        <HeaderActions thread={activeThread} />
      </div>

      {/* Messages, tool calls, and streaming - all in one scrollable area */}
      <div className="flex-1 overflow-y-auto">
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <>
            <MessageList />

            {/* Active tool calls - inline within the message flow */}
            {toolCalls.length > 0 && (
              <div className="px-4 py-2 max-h-[300px] overflow-y-auto">
                <ToolCallCard toolCalls={toolCalls} />
              </div>
            )}

            {/* Streaming indicator with timer */}
            {isAgentRunning && <StreamingIndicator startTime={agentStartTime} />}
          </>
        )}
      </div>

      {/* Composer */}
      <Composer threadId={activeThread.id} workspaceId={activeWorkspaceId ?? undefined} />
    </div>
  );
}
