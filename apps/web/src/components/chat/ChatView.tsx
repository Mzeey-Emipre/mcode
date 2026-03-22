import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { StreamingIndicator } from "./StreamingIndicator";
import { GitBranch, Square } from "lucide-react";

export function ChatView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadMessages = useThreadStore((s) => s.loadMessages);
  const clearMessages = useThreadStore((s) => s.clearMessages);
  const isAgentRunning = useThreadStore((s) => s.isAgentRunning);
  const stopAgent = useThreadStore((s) => s.stopAgent);

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

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">
            {activeThread.title}
          </h2>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch size={10} />
            <span>{activeThread.branch}</span>
            {activeThread.mode === "worktree" && (
              <span className="rounded bg-primary/10 px-1 text-primary">
                worktree
              </span>
            )}
          </div>
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

      {/* Messages */}
      <div className="flex-1 overflow-hidden">
        <MessageList />
      </div>

      {/* Streaming indicator */}
      {isAgentRunning && <StreamingIndicator />}

      {/* Composer */}
      <Composer threadId={activeThread.id} />
    </div>
  );
}
