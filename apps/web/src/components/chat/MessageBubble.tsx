import { memo, useMemo, useState, useCallback, useRef, useEffect } from "react";
import type { Message } from "@/transport";
import { FileText, File, ImageIcon, RotateCcw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import { stripInjectedFiles } from "@/lib/file-tags";

/** Props for {@link MessageBubble}. */
interface MessageBubbleProps {
  /** The message object to render. */
  message: Message;
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
          <ImageIcon size={14} className="shrink-0 text-muted-foreground/60" />
          <span className="truncate text-xs text-muted-foreground/70">{name}</span>
        </div>
      ) : (
        <img
          src={src}
          alt={name}
          className="block h-auto max-h-[160px] w-full object-contain bg-black/20"
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
      className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/msg:opacity-100"
      aria-label="Copy message"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Renders a single chat message (system, user, or assistant). Memoized to prevent re-renders when the message ref is unchanged. */
export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
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
            <div className="rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-md shadow-primary/25">
              {fileAttachments.length > 0 && (
                <div className="mb-2 space-y-1">
                  {fileAttachments.map((file) => (
                    <div key={file.id} className="flex items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1">
                      {file.mimeType === "application/pdf" ? (
                        <FileText size={14} className="text-primary-foreground/70" />
                      ) : (
                        <File size={14} className="text-primary-foreground/70" />
                      )}
                      <span className="truncate text-xs text-primary-foreground/80">{file.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {textContent.trim() && (
                <p className="whitespace-pre-wrap break-words">{textContent}</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-1.5 pr-1">
            {textContent.trim() && <CopyButton content={textContent} />}
            <span className="text-[11px] text-muted-foreground/40">{formattedTime}</span>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message — borderless prose flowing directly on the page
  return (
    <div className="group/msg space-y-2">
      <div className="text-sm text-foreground">
        <MarkdownContent content={message.content} isStreaming={false} />
      </div>
      <div className="flex items-center gap-3 px-1">
        <CopyButton content={message.content} />
        {message.tokens_used != null && (
          <span className="text-xs text-muted-foreground/50 transition-opacity group-hover/msg:text-muted-foreground/80">
            {message.tokens_used.toLocaleString()} tokens
          </span>
        )}
        {message.cost_usd != null && (
          <span className="text-xs text-muted-foreground/50 transition-opacity group-hover/msg:text-muted-foreground/80">
            ${message.cost_usd.toFixed(4)}
          </span>
        )}
        <span className="text-xs text-muted-foreground/50 transition-opacity group-hover/msg:text-muted-foreground/80">
          {formattedTime}
        </span>
      </div>
    </div>
  );
});
