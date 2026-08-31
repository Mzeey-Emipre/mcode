import { FileText, File } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import {
  attachmentIconKindFromMime,
  formatAttachmentByteSize,
} from "./attachment-display";

/** Layout presets for attachment tiles in composer vs transcript. */
export type FileAttachmentTileVariant = "composer" | "transcript";

/** Props for {@link FileAttachmentTile}. */
export interface FileAttachmentTileProps {
  /** Original filename for display. */
  name: string;
  sizeBytes: number;
  mimeType: string;
  variant: FileAttachmentTileVariant;
  /** Corner overlay such as remove control; parent Tile is `position: relative`. */
  accessory?: ReactNode;
  className?: string;
}

/**
 * Icon-led framed surface for non-image attachments (PDF, Office, generic).
 * Matches transcript and composer previews without rasterizing PDFs.
 */
export function FileAttachmentTile({
  name,
  sizeBytes,
  mimeType,
  variant,
  accessory,
  className,
}: FileAttachmentTileProps) {
  const kind = attachmentIconKindFromMime(mimeType);
  const icon =
    kind === "pdf" ? (
      <FileText size={18} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden />
    ) : kind === "office" ? (
      <FileText size={18} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
    ) : (
      <File size={18} className="shrink-0 text-muted-foreground" aria-hidden />
    );

  const isComposer = variant === "composer";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "relative overflow-hidden rounded-xl",
              "border border-border/60 bg-muted/45 ring-1 ring-primary/15",
              "shadow-sm shadow-black/5 dark:shadow-black/20",
              isComposer ? "h-[72px] w-[140px]" : "min-h-[72px] w-full max-w-[260px]",
              className,
            )}
          >
            {accessory}
            <div
              className={cn(
                "flex h-full flex-col justify-center gap-1",
                isComposer ? "px-3 py-2" : "px-3 py-2.5",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {icon}
                <span className="truncate text-xs font-medium text-foreground">{name}</span>
              </div>
              <span className="pl-[26px] text-xs tabular-nums text-muted-foreground">
                {formatAttachmentByteSize(sizeBytes)}
              </span>
            </div>
          </div>
        }
      />
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
