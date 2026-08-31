import { useState } from "react";
import { Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Props for the Preview annotation mode header. */
export interface PreviewAnnotationHeaderProps {
  /** Number of saved annotations on the current page identity. */
  readonly pageCount: number;
  /** Number of saved annotations in the full thread bundle. */
  readonly bundleCount: number;
  /** Current page identity shown in the annotation bar. */
  readonly pageLabel: string;
  /** Discard saved annotations for the current page identity. */
  readonly onDiscardPage: () => void;
  /** Send the current annotation bundle to the thread composer. */
  readonly onSend: () => void;
  /** Exit Preview annotation mode. */
  readonly onExit: () => void;
}

/** Header shown while the Preview is in annotation mode, replacing normal browser chrome. */
export function PreviewAnnotationHeader({
  pageCount,
  bundleCount,
  pageLabel,
  onDiscardPage,
  onSend,
  onExit,
}: PreviewAnnotationHeaderProps) {
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const countLabel = `${bundleCount} annotation${bundleCount === 1 ? "" : "s"}`;
  const hasAnnotations = bundleCount > 0;
  const titleLabel = hasAnnotations ? `Designing · ${pageLabel}` : "Designing";
  const pageAnnotationLabel = `${pageCount} saved annotation${pageCount === 1 ? "" : "s"}`;

  return (
    <>
      <div
        data-testid="preview-annotation-header"
        className="flex h-10 flex-none items-center gap-2 border-b border-border/60 bg-background px-2 text-foreground"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Exit Design"
                className="text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={onExit}
              >
                <X size={15} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="top">Exit Design</TooltipContent>
        </Tooltip>
        {pageCount > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Discard page annotations"
                  className="text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  onClick={() => setDiscardDialogOpen(true)}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top">Discard current page annotations</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                className="flex min-w-0 flex-1 items-center"
                data-testid="preview-annotation-title"
              >
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {titleLabel}
                </span>
              </div>
            }
          />
          <TooltipContent side="top">{titleLabel}</TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={!hasAnnotations}
          className="h-7 rounded-lg px-2.5"
          data-testid="preview-annotation-send-state"
          aria-label={`Send ${countLabel}`}
          onClick={onSend}
        >
          <Send size={14} aria-hidden />
          Send
          {hasAnnotations ? (
            <span className="ml-0.5 rounded-full bg-primary-foreground/15 px-1 text-xs leading-4">
              {bundleCount}
            </span>
          ) : null}
        </Button>
      </div>
      {pageCount > 0 ? (
        <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Delete page annotations?</DialogTitle>
              <DialogDescription>
                This removes {pageAnnotationLabel} from this page.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDiscardDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setDiscardDialogOpen(false);
                  onDiscardPage();
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
