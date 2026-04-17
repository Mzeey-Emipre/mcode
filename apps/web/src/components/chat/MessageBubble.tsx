import { memo, useMemo, useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import type { Message } from "@/transport";
import { FileText, File, ImageIcon, RotateCcw, Copy, Check, GitBranch, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
const LazyMarkdownContent = lazy(() => import("./MarkdownContent"));
import { stripInjectedFiles } from "@/lib/file-tags";
import { isHandoffMessage, parseHandoffJson } from "./handoff-utils";
import { HandoffCard } from "./HandoffCard";

/** Parses the message content of a synthetic agent-error system message. Returns the error text, or null if not an agent error. */
function parseAgentError(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { __type?: string; message?: string };
    if (parsed.__type === "agent_error" && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // not JSON
  }
  return null;
}
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for {@link MessageBubble}. */
interface MessageBubbleProps {
  /** The message object to render. */
  message: Message;
  /** Called when the user clicks the branch icon on this message. */
  onBranch?: (messageId: string) => void;
}

/** Maps a MIME type to a file extension for attachment URLs. */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function extFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? "";
}

/** Single image thumbnail with error fallback. */
function ImageThumbnail({ src, name, single }: { src: string; name: string; single: boolean }) {
  const [failed, setFailed] = useState(false);
  const handleError = useCallback(() => setFailed(true), []);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl ring-1 ring-border/40",
        single ? "max-w-[240px]" : "max-w-[140px]"
      )}
    >
      {failed ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
          <ImageIcon size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-xs text-muted-foreground">{name}</span>
        </div>
      ) : (
        <img
          src={src}
          alt={name}
          className="block h-auto max-h-[160px] w-full object-contain bg-muted"
          loading="lazy"
          onError={handleError}
          style={{ imageOrientation: "from-image" }}
        />
      )}
    </div>
  );
}

/** Copy button with check feedback, visible on parent hover. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write failed — don't show copied state
    }
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/msg:opacity-100"
      aria-label="Copy message"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Branch button visible on hover, matching CopyButton style. */
function BranchButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground opacity-0 scale-90 transition-all duration-150 hover:bg-primary/10 hover:text-primary group-hover/msg:opacity-100 group-hover/msg:scale-100"
            aria-label="Branch from this message"
          >
            <GitBranch size={14} />
          </button>
        }
      />
      <TooltipContent side="top" className="text-xs">Branch from here</TooltipContent>
    </Tooltip>
  );
}

/** Renders a single chat message (system, user, or assistant). Memoized to prevent re-renders when the message ref is unchanged. */
export const MessageBubble = memo(function MessageBubble({ message, onBranch }: MessageBubbleProps) {
  const formattedTime = useMemo(
    () => new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [message.timestamp],
  );

  const imageAttachments = useMemo(
    () => message.attachments?.filter((a) => a.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const fileAttachments = useMemo(
    () => message.attachments?.filter((a) => !a.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const textContent = useMemo(() => stripInjectedFiles(message.content), [message.content]);

  if (message.role === "system") {
    if (isHandoffMessage(message.role, message.content)) {
      if (parseHandoffJson(message.content)) {
        return <HandoffCard content={message.content} />;
      }
      // Malformed handoff JSON: fall through to normal system-message rendering.
    }

    const agentError = parseAgentError(message.content);
    if (agentError) {
      return (
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-destructive/60" />
          <p className="text-muted-foreground leading-relaxed">{agentError}</p>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-3 py-2">
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RotateCcw size={12} />
          <span>{message.content}</span>
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const isUser = message.role === "user";

  if (isUser) {

    return (
      <div className="group/msg flex justify-end">
        <div className="max-w-[75%] space-y-1.5">
          {/* Image attachments — standalone thumbnails above the bubble */}
          {imageAttachments.length > 0 && (
            <div className={cn(
              "flex justify-end gap-1.5",
              imageAttachments.length > 2 ? "flex-wrap" : ""
            )}>
              {imageAttachments.map((img) => (
                <ImageThumbnail
                  key={img.id}
                  src={`mcode-attachment://${message.thread_id}/${img.id}${extFromMime(img.mimeType)}`}
                  name={img.name}
                  single={imageAttachments.length === 1}
                />
              ))}
            </div>
          )}

          {/* Text bubble — only if there's text or file attachments */}
          {(textContent.trim() || fileAttachments.length > 0) && (
            <div className="rounded-lg rounded-br-md bg-primary px-3 py-1.5 text-sm text-primary-foreground shadow-sm shadow-primary/15">
              {fileAttachments.length > 0 && (
                <div className="mb-2 space-y-1">
                  {fileAttachments.map((file) => (
                    <div key={file.id} className="flex items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1">
                      {file.mimeType === "application/pdf" ? (
                        <FileText size={14} className="text-primary-foreground/80" />
                      ) : (
                        <File size={14} className="text-primary-foreground/80" />
                      )}
                      <span className="truncate text-xs text-primary-foreground/90">{file.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {textContent.trim() && (
                <Suspense fallback={null}>
                  <LazyMarkdownContent content={textContent} isStreaming={false} variant="user" />
                </Suspense>
              )}
            </div>
          )}

          <div className="flex flex-col items-end gap-0.5 pr-1">
            <div className="flex items-center gap-1.5">
              {onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
              {textContent.trim() && <CopyButton content={textContent} />}
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/55">{formattedTime}</span>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message — borderless prose flowing directly on the page
  return (
    <div className="group/msg space-y-2">
      <div className="flex items-baseline gap-2">
        <span aria-hidden="true" className="font-mono text-[10px] leading-none text-muted-foreground/50">▸</span>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground/55">assistant</span>
      </div>
      <div className="text-sm text-foreground">
        <Suspense fallback={null}>
          <LazyMarkdownContent content={message.content} isStreaming={false} />
        </Suspense>
      </div>
      <div className="flex items-center gap-3 px-1">
        {onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
        <CopyButton content={textContent} />
        {(message.tokens_used != null || message.cost_usd != null || formattedTime) && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/55 transition-colors group-hover/msg:text-muted-foreground/80">
            {[
              message.tokens_used != null ? `${message.tokens_used.toLocaleString()} tok` : null,
              message.cost_usd != null ? `$${message.cost_usd.toFixed(4)}` : null,
              formattedTime,
            ].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
});
