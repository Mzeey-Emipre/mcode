import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { StreamingIndicator } from "./StreamingIndicator";
import { Bot, Square } from "lucide-react";

export function ChatView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const stopAgent = useThreadStore((s) => s.stopAgent);
  const messages = useThreadStore((s) => s.messages);

  const streamingByThread = useThreadStore((s) => s.streamingByThread);
  const streamingContent = activeThreadId ? (streamingByThread[activeThreadId] ?? "") : "";
  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeThread = threads.find((t) => t.id === activeThreadId);

  useEffect(() => {
    if (activeThreadId) {
      loadMessages(activeThreadId);
    } else {
      clearMessages();
    }
  }, [activeThreadId, loadMessages, clearMessages]);

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
          <span className="text-sm text-muted-foreground">New thread</span>
          <span className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-foreground">
            {workspaces.find((w) => w.id === activeThread.workspace_id)?.name ?? ""}
          </span>
        </div>
        {isAgentRunning && activeThreadId && (
          <button
            onClick={() => stopAgent(activeThreadId)}
            className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20"
          >
            <Square size={10} />
            Stop
          </button>
        )}
      </div>

      {/* Messages or empty state */}
      <div className="flex-1 overflow-hidden">
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <MessageList />
        )}
      </div>

      {/* Streaming content / indicator */}
      {isAgentRunning && streamingContent && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Bot size={14} />
            </div>
            <div className="max-w-[80%] text-sm text-foreground">
              <p className="whitespace-pre-wrap break-words">{streamingContent}</p>
            </div>
          </div>
        </div>
      )}
      {isAgentRunning && !streamingContent && <StreamingIndicator />}

      {/* Composer */}
      <Composer threadId={activeThread.id} />
    </div>
  );
}
