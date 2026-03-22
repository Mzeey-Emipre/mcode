import { useState, useRef, useCallback } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { SendHorizontal } from "lucide-react";

interface ComposerProps {
  threadId: string;
}

export function Composer({ threadId }: ComposerProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useThreadStore((s) => s.sendMessage);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const isAgentRunning = runningThreadIds.has(threadId);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isAgentRunning) return;

    setInput("");
    await sendMessage(threadId, trimmed);

    // Refocus textarea
    textareaRef.current?.focus();
  }, [input, isAgentRunning, threadId, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border p-3">
      <div className="flex items-end gap-2 rounded-lg border border-border bg-card p-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message... (Ctrl+Enter)"
          rows={1}
          className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          disabled={isAgentRunning}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isAgentRunning}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Ctrl+Enter to send
      </p>
    </div>
  );
}
