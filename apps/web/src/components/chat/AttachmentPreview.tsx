import { X, FileText, File } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
  filePath: string | null;
}

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-3 py-2">
      {attachments.map((att) => {
        const isImage = att.mimeType.startsWith("image/");
        const isPdf = att.mimeType === "application/pdf";

        return (
          <div
            key={att.id}
            className={cn(
              "group relative flex-shrink-0 overflow-hidden rounded-lg",
              "border border-border/60 bg-muted/60",
              "transition-all duration-150 hover:border-primary/40 hover:bg-muted/80",
            )}
          >
            {isImage ? (
              <div className="relative h-[72px] w-[72px]">
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="h-full w-full object-cover"
                />
                {/* Subtle gradient overlay so the X button is always readable */}
                <div className="absolute inset-0 bg-gradient-to-br from-black/30 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            ) : (
              <div className="flex h-[72px] w-[140px] flex-col justify-center gap-1 px-3">
                <div className="flex items-center gap-2">
                  {isPdf ? (
                    <FileText size={18} className="shrink-0 text-red-600 dark:text-red-400" />
                  ) : (
                    <File size={18} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">
                    {att.name}
                  </span>
                </div>
                <span className="pl-[26px] text-[10px] text-muted-foreground">
                  {formatSize(att.sizeBytes)}
                </span>
              </div>
            )}

            {/* Always-visible remove button with clear contrast */}
            <button
              type="button"
              onClick={() => onRemove(att.id)}
              className={cn(
                "absolute right-1 top-1 flex items-center justify-center",
                "h-5 w-5 rounded-full",
                "bg-foreground/75 text-background",
                "opacity-0 transition-all duration-150",
                "hover:bg-destructive hover:text-white",
                "group-hover:opacity-100",
                "focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-primary",
              )}
              aria-label={`Remove ${att.name}`}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
