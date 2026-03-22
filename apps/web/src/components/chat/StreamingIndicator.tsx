export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-card/50 px-4 py-2">
      <div className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
      </div>
      <span className="text-xs text-muted-foreground">Agent is working...</span>
    </div>
  );
}
