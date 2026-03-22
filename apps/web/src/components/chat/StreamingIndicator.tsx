import { Bot } from "lucide-react";

export function StreamingIndicator() {
  return (
    <div className="flex gap-3 px-4 py-2">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
        <Bot size={14} className="text-muted-foreground" />
      </div>
      <div className="flex items-center gap-1.5 rounded-xl bg-muted/50 px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
      </div>
    </div>
  );
}
