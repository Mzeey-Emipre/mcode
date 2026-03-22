import type { Message } from "@/transport";
import { Bot } from "lucide-react";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message - clean card style like T3Code
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
        <Bot size={14} className="text-muted-foreground" />
      </div>
      <div className="flex-1 space-y-2">
        <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm text-foreground">
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        </div>
        {/* Metadata row */}
        <div className="flex items-center gap-3 px-1">
          {message.tokens_used != null && (
            <span className="text-[10px] text-muted-foreground">
              {message.tokens_used.toLocaleString()} tokens
            </span>
          )}
          {message.cost_usd != null && (
            <span className="text-[10px] text-muted-foreground">
              ${message.cost_usd.toFixed(4)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </div>
    </div>
  );
}
