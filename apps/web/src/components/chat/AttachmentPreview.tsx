import { FileText, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactElement } from "react";
import type { McodeBrowserCapture } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { ATTACHMENT_REMOVE_HIT_AREA } from "@/lib/ui-hit-target";
import { useHorizontalScrollEdges } from "@/hooks/useHorizontalScrollEdges";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { FileAttachmentTile } from "./FileAttachmentTile";
import { ImageAttachmentLightbox } from "./ImageAttachmentLightbox";

/** Represents a user-selected file staged on the composer before send (preview URL may be an object URL). */
export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
  filePath: string | null;
  /** Structured Browser preview context bundled with PNG references from desktop. */
  browserCapture?: McodeBrowserCapture;
  /** When true, only structured `browserCapture` is sent (no image file). */
  contextOnly?: boolean;
}

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

/** Spill file hints for v2 preview captures (Mcode app data dir, not the project). */
function getBrowserCaptureSpillHints(capture: McodeBrowserCapture | undefined): {
  line: string;
  title: string;
} | undefined {
  if (capture?.schemaVersion !== 2) return undefined;
  const rel = capture.spillAppDataPath;
  const abs = capture.spillAbsolutePath;
  if (!rel && !abs) return undefined;
  const line = rel ?? abs ?? "";
  const title = [
    "Full preview text is stored in the Mcode application data directory (for example ~/.mcode or %USERPROFILE%\\.mcode in production, ~/.mcode-dev in development), not inside your project folder.",
    abs ? `Open this file:\n${abs}` : null,
    rel ? `Relative to that folder:\n${rel}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { line, title };
}

function BrowserCaptureTooltip({
  title,
  children,
}: {
  title: string | undefined;
  children: ReactElement;
}) {
  if (!title) return children;

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** Horizontal strip of pending attachment thumbnails or file tiles with per-item remove actions. */
export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollEdges = useHorizontalScrollEdges(scrollRef, attachments.length);

  const previewableImages = useMemo(
    () => attachments.filter((a) => a.mimeType.startsWith("image/") && !!a.previewUrl),
    [attachments],
  );

  const [imagePreview, setImagePreview] = useState<{
    items: { src: string; title: string }[];
    initialIndex: number;
  } | null>(null);

  if (attachments.length === 0) return null;

  const removeButton = (name: string, id: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={(e) => {
        e.stopPropagation();
        onRemove(id);
      }}
      className={cn(
        ATTACHMENT_REMOVE_HIT_AREA,
        "flex rounded-full p-0 opacity-0 transition-all duration-150",
        "hover:bg-transparent",
        "group-hover:opacity-100 focus-visible:opacity-100",
      )}
      aria-label={`Remove ${name}`}
    >
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full",
          "bg-foreground/75 text-background",
          "group-hover:bg-destructive group-hover:text-white",
          "hover:bg-destructive hover:text-white",
        )}
        aria-hidden
      >
        <X size={12} strokeWidth={2.5} />
      </span>
    </Button>
  );

  return (
    <>
      <div className="relative min-w-0">
        {scrollEdges.left ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r from-background to-transparent"
          />
        ) : null}
        {scrollEdges.right ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-gradient-to-l from-background to-transparent"
          />
        ) : null}
        <div
          ref={scrollRef}
          className={cn(
            "flex gap-2 overflow-x-auto px-3 py-2",
            "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
        {attachments.map((att) => {
          // Image tiles need a blob preview URL. Attachments rehydrated from
          // disk-side metadata (e.g. restored from the message queue) have no
          // blob URL, so they fall through to the generic file tile instead of
          // rendering a broken <img>.
          const isImage = att.mimeType.startsWith("image/") && !!att.previewUrl;
          const isContextOnly =
            att.contextOnly === true || isVirtualBrowserContextAttachment(att.mimeType);
          const spill = getBrowserCaptureSpillHints(att.browserCapture);

          if (isContextOnly) {
            return (
              <BrowserCaptureTooltip key={att.id} title={spill?.title}>
                <div
                  className={cn(
                    "group relative flex-shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted/60 transition-all duration-150",
                    "hover:border-primary/40 hover:bg-muted/80",
                  )}
                >
                  <div className="flex h-[72px] w-[140px] flex-col justify-center gap-0.5 px-3 py-1">
                    <div className="flex min-h-0 items-center gap-2">
                      <FileText size={18} className="shrink-0 text-primary" />
                      <span className="truncate text-xs font-medium text-foreground">Page context</span>
                    </div>
                    <span className="block max-w-[120px] truncate pl-[26px] text-xs leading-tight text-muted-foreground">
                      {spill ? spill.line : "No image"}
                    </span>
                    {removeButton(att.name, att.id)}
                  </div>
                </div>
              </BrowserCaptureTooltip>
            );
          }

          if (isImage) {
            const slideIndex = previewableImages.findIndex((x) => x.id === att.id);
            // Remove control is a sibling of the preview button, not a child:
            // <button> inside <button> is invalid HTML and triggers a React
            // hydration warning. The wrapper div carries the "group" so
            // group-hover still reveals the remove control.
            return (
              <BrowserCaptureTooltip key={att.id} title={spill?.title}>
                <div className="group relative h-[72px] w-[72px] flex-shrink-0">
                  <button
                    type="button"
                    className={cn(
                      "relative flex h-full w-full cursor-pointer overflow-hidden rounded-lg border p-0 text-left outline-none",
                      "border-border/60 bg-muted/60 transition-[border-color,background-color,filter]",
                      "hover:border-primary/45 hover:bg-muted/80 hover:brightness-[1.04]",
                      "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    )}
                    aria-label={`Preview image ${att.name}`}
                    onClick={() =>
                      setImagePreview({
                        items: previewableImages.map((a) => ({
                          src: a.previewUrl,
                          title: a.name,
                        })),
                        initialIndex: slideIndex >= 0 ? slideIndex : 0,
                      })
                    }
                  >
                    {spill ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="absolute bottom-0.5 left-0.5 right-0.5 z-10 truncate rounded bg-background/85 px-0.5 text-center text-xs font-medium text-foreground/90 shadow-sm" />}
                        >
                          + spill file
                        </TooltipTrigger>
                        <TooltipContent>{spill.title}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/25 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                  {removeButton(att.name, att.id)}
                </div>
              </BrowserCaptureTooltip>
            );
          }

          return (
            <div
              key={att.id}
              className={cn(
                "group relative flex-shrink-0 overflow-hidden rounded-lg transition-all duration-150",
                "border border-transparent hover:border-primary/40 hover:bg-muted/50",
              )}
            >
              <FileAttachmentTile
                variant="composer"
                name={att.name}
                sizeBytes={att.sizeBytes}
                mimeType={att.mimeType}
                accessory={removeButton(att.name, att.id)}
              />
            </div>
          );
        })}
        </div>
      </div>
      <ImageAttachmentLightbox
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
        items={imagePreview?.items ?? []}
        initialIndex={imagePreview?.initialIndex ?? 0}
      />
    </>
  );
}
