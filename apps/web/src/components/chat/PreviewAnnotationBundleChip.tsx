import type { PreviewAnnotationBundle, PreviewAnnotationPayload } from "@mcode/contracts";
import { ImageIcon, MessageCircle, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildStoredAttachmentImageSrc } from "@/lib/attachment-url";
import { cn } from "@/lib/utils";
import { useRetriableAttachmentImage } from "./useRetriableAttachmentImage";

const MAX_DETAIL_LENGTH = 220;

function annotationCountLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

function annotationTargetLabel(annotation: PreviewAnnotationPayload): string {
  return (
    annotation.targetContext.label?.trim() ||
    annotation.targetContext.selectorHint?.trim() ||
    "Element"
  );
}

function annotationDetail(annotation: PreviewAnnotationPayload): string {
  const text =
    annotation.note?.trim() ||
    annotation.changeSummary?.trim() ||
    "Visual annotation";
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH - 3).trimEnd()}...`;
}

function AnnotationSnapshotThumbnail({ src }: { readonly src: string }) {
  const image = useRetriableAttachmentImage(src);

  return (
    <span className="relative block h-14 overflow-hidden rounded-md border border-border/60 bg-muted/30">
      {image.failed ? (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon size={16} aria-hidden />
        </span>
      ) : (
        <>
          <img
            src={image.src}
            alt=""
            className={cn(
              "h-full w-full object-cover transition-opacity",
              image.retrying ? "opacity-0" : "opacity-100",
            )}
            loading="lazy"
            data-testid="preview-annotation-hover-thumbnail"
            onError={image.onError}
            onLoad={image.onLoad}
          />
          {image.retrying ? (
            <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/70">
              <ImageIcon size={14} className="animate-pulse" aria-hidden />
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

/** Props for the compact annotation chip shown in composer and transcript surfaces. */
export interface PreviewAnnotationBundleChipProps {
  /** Saved Preview annotation payloads to summarize. */
  readonly bundle: PreviewAnnotationBundle;
  /** Thread that owns the persisted annotation screenshots. */
  readonly threadId?: string;
  /** Optional removal action. Hidden until hover or focus. */
  readonly onRemove?: () => void;
  /** Extra classes for the chip root. */
  readonly className?: string;
  /** Test id for the chip root. */
  readonly testId?: string;
}

/** Renders a responsive annotation summary chip with hoverable per-annotation details. */
export function PreviewAnnotationBundleChip({
  bundle,
  threadId,
  onRemove,
  className,
  testId = "preview-annotation-bundle-chip",
}: PreviewAnnotationBundleChipProps) {
  const count = bundle.annotations.length;
  if (count === 0) return null;

  const label = annotationCountLabel(count);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            data-testid={testId}
            tabIndex={0}
            aria-label={`${label}. Annotation details available.`}
            className={cn(
              "group relative inline-flex max-w-full items-center gap-2 rounded-lg border border-accent-foreground/10 bg-accent px-2 py-1 text-xs font-medium text-accent-foreground shadow-sm transition-colors hover:border-accent-foreground/15 hover:bg-accent/90 focus-visible:border-accent-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-foreground/20",
              className,
            )}
          >
            <MessageCircle size={14} aria-hidden />
            <span className="truncate">{label}</span>
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
                className="pointer-events-none absolute -right-2 -top-2 size-5 rounded-full border border-accent-foreground/10 bg-accent text-accent-foreground/70 opacity-0 shadow-sm transition-opacity hover:bg-accent-foreground/10 hover:text-accent-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
              >
                <X size={12} aria-hidden />
              </Button>
            ) : null}
          </div>
        }
      />
      <TooltipContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-2rem))] max-w-none items-stretch rounded-xl border border-border/70 bg-popover p-2.5 text-popover-foreground shadow-xl"
        arrowClassName="bg-popover fill-popover"
      >
        <div className="max-h-72 min-w-0 space-y-2 overflow-y-auto pr-1">
          {bundle.annotations.map((annotation) => {
            const snapshotSrc = threadId
              ? buildStoredAttachmentImageSrc(
                  threadId,
                  annotation.snapshot.id,
                  annotation.snapshot.mimeType,
                )
              : null;
            return (
              <div
                key={annotation.id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_4.5rem] gap-2 border-b border-border/50 pb-2 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/80 text-xs font-semibold tabular-nums text-primary-foreground/90">
                      {annotation.displayNumber}
                    </span>
                    <Badge
                      variant="secondary"
                      size="sm"
                      className="min-w-0 max-w-full truncate font-mono font-normal text-muted-foreground"
                    >
                      {annotationTargetLabel(annotation)}
                    </Badge>
                  </div>
                  <p className="mt-1.5 min-w-0 whitespace-pre-wrap break-words text-xs leading-snug text-popover-foreground">
                    {annotationDetail(annotation)}
                  </p>
                </div>
                {snapshotSrc ? <AnnotationSnapshotThumbnail src={snapshotSrc} /> : null}
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
