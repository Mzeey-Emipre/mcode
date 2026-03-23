import type { Message, StoredAttachment } from "@/transport";
import { Bot, FileText, File } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

interface MessageBubbleProps {
  message: Message;
}

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}

function AttachmentDisplay({ attachments, threadId }: { attachments: StoredAttachment[]; threadId: string }) {
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));

  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="grid max-w-[320px] grid-cols-2 gap-1.5">
          {images.map((img) => (
            <div key={img.id} className="overflow-hidden rounded-lg">
              <img
                src={`mcode-attachment://${threadId}/${img.id}${extFromMime(img.mimeType)}`}
                alt={img.name}
                className="h-auto max-h-[160px] w-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}
      {files.map((file) => (
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
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentDisplay attachments={message.attachments} threadId={message.thread_id} />
            </div>
          )}
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
        <Bot size={14} className="text-muted-foreground" />
      </div>
      <div className="flex-1 space-y-2">
        <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm text-foreground">
          <MarkdownContent content={message.content} />
        </div>
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
