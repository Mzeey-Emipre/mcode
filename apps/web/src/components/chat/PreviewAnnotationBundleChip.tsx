import type { PreviewAnnotationBundle, PreviewAnnotationPayload } from "@mcode/contracts";
import { MessageCircle, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

/** Props for the compact annotation chip shown in composer and transcript surfaces. */
export interface PreviewAnnotationBundleChipProps {
  /** Saved Preview annotation payloads to summarize. */
  readonly bundle: PreviewAnnotationBundle;
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
              "group inline-flex max-w-full items-center gap-2 rounded-lg border border-primary/35 bg-primary/10 px-2 py-1 text-xs font-medium text-primary shadow-sm transition-colors hover:border-primary/55 hover:bg-primary/15 focus-visible:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35",
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
                className="pointer-events-none -ml-1 text-primary opacity-0 transition-opacity hover:bg-primary/10 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
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
      >
        <div className="max-h-72 min-w-0 space-y-2 overflow-y-auto pr-1">
          {bundle.annotations.map((annotation) => (
            <div
              key={annotation.id}
              className="min-w-0 border-b border-border/50 pb-2 last:border-b-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold tabular-nums text-primary-foreground">
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
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
