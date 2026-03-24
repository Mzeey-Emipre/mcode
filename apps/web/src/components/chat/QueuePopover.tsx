import { useState, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { X, Paperclip, Trash2, Play } from "lucide-react";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface QueuePopoverProps {
  threadId: string;
  isAgentRunning: boolean;
  onResume: () => void;
}

export function QueuePopover({ threadId, isAgentRunning, onResume }: QueuePopoverProps) {
  const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
  const removeFromQueue = useQueueStore((s) => s.removeFromQueue);
  const clearQueue = useQueueStore((s) => s.clearQueue);
  const [open, setOpen] = useState(false);

  // Close popover when queue empties
  useEffect(() => {
    if (queue.length === 0) setOpen(false);
  }, [queue.length]);

  if (queue.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${queue.length} queued message${queue.length !== 1 ? "s" : ""}`}
        className="flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary tabular-nums transition-all hover:bg-primary/25"
      >
        {queue.length}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-64 p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Next up
          </span>
          <button
            onClick={() => clearQueue(threadId)}
            aria-label="Clear all queued messages"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 size={10} />
            Clear all
          </button>
        </div>
        <div className="max-h-48 overflow-y-auto p-1">
          {queue.map((msg, i) => (
            <div
              key={msg.id}
              className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
            >
              <span className="mt-px text-[10px] font-medium text-muted-foreground/50 tabular-nums">
                {i + 1}.
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {msg.displayContent || msg.content}
                </p>
                {msg.attachments.length > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                    <Paperclip size={8} />
                    {msg.attachments.length}
                  </span>
                )}
              </div>
              <button
                onClick={() => removeFromQueue(threadId, msg.id)}
                aria-label={`Remove queued message ${i + 1}`}
                className="mt-px rounded p-0.5 text-muted-foreground/30 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
        {!isAgentRunning && (
          <div className="border-t border-border px-3 py-2">
            <button
              onClick={() => { setOpen(false); onResume(); }}
              aria-label="Send next queued message"
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Play size={10} />
              Continue
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
