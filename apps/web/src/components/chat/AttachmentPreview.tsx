import { X, FileText, File } from "lucide-react";

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

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex-shrink-0 rounded-lg border border-border bg-background overflow-hidden"
        >
          {att.mimeType.startsWith("image/") ? (
            <img
              src={att.previewUrl}
              alt={att.name}
              className="h-16 w-16 object-cover"
            />
          ) : (
            <div className="flex h-16 w-24 items-center gap-1.5 px-2">
              {att.mimeType === "application/pdf" ? (
                <FileText size={16} className="shrink-0 text-red-400" />
              ) : (
                <File size={16} className="shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-[11px] text-muted-foreground">
                {att.name}
              </span>
            </div>
          )}
          <button
            onClick={() => onRemove(att.id)}
            className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground shadow group-hover:flex"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
