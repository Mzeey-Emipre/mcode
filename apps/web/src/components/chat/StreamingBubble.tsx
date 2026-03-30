import { MarkdownContent } from "./MarkdownContent";

/** Props for {@link StreamingBubble}. */
interface StreamingBubbleProps {
  /** Partial markdown content accumulated so far during streaming. */
  content: string;
}

/** Renders an assistant message bubble during active streaming with a blinking cursor. */
export function StreamingBubble({ content }: StreamingBubbleProps) {
  if (!content) return null;

  return (
    <div className="text-sm text-foreground">
      <span className="inline">
        <MarkdownContent content={content} isStreaming />
      </span>
      <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-primary/70" />
    </div>
  );
}
