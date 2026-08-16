import { lazy, memo, Suspense } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const LazyRemoteMarkdownRenderer = lazy(
  () => import("./RemoteMarkdownRenderer"),
);

/** Props for hostile remote Markdown rendered in pull request surfaces. */
export interface RemoteMarkdownProps {
  /** Markdown source received from the remote pull request provider. */
  content: string;
  /** Optional classes applied to the renderer's local typography boundary. */
  className?: string;
}

function RemoteMarkdownComponent({ content, className }: RemoteMarkdownProps) {
  return (
    <div
      className={cn(
        "min-w-0 break-words text-sm leading-relaxed text-foreground/90",
        className,
      )}
    >
      <Suspense
        fallback={
          <Spinner
            size="sm"
            aria-label="Loading pull request content"
            className="text-muted-foreground"
          />
        }
      >
        <LazyRemoteMarkdownRenderer content={content} />
      </Suspense>
    </div>
  );
}

/** Lazy-loads the isolated pull request Markdown renderer. */
export const RemoteMarkdown = memo(RemoteMarkdownComponent);

RemoteMarkdown.displayName = "RemoteMarkdown";
