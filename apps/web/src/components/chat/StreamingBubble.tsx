import { Bot } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

interface StreamingBubbleProps {
  content: string;
}

export function StreamingBubble({ content }: StreamingBubbleProps) {
  if (!content) return null;

  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
        <Bot size={14} className="text-muted-foreground" />
      </div>
      <div className="flex-1">
        <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm text-foreground">
          <MarkdownContent content={content} />
        </div>
      </div>
    </div>
  );
}
