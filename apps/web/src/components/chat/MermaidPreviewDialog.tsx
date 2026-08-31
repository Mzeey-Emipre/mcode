import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Minus, Plus, RotateCcw, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

interface ViewportState {
  scale: number;
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

/** Props for the full-screen Mermaid diagram preview. */
export interface MermaidPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mermaid-generated SVG sanitized under strict security mode. */
  svg: string;
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Displays a Mermaid SVG on a focused canvas with pointer panning, wheel zoom,
 * explicit zoom controls, and a one-click reset.
 */
export const MermaidPreviewDialog = memo(function MermaidPreviewDialog(props: MermaidPreviewDialogProps) {
  return <MermaidPreviewDialogCanvas key={props.open ? props.svg : "closed"} {...props} />;
});

function MermaidPreviewDialogCanvas({
  open,
  onOpenChange,
  svg,
}: MermaidPreviewDialogProps) {
  const [viewport, setViewport] = useState<ViewportState>({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  const resetView = useCallback(() => {
    setViewport({ scale: 1, x: 0, y: 0 });
  }, []);

  const changeScale = useCallback((delta: number) => {
    setViewport((current) => ({
      ...current,
      scale: clampScale(current.scale + delta),
    }));
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeScale(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
  }, [changeScale]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
  }, [viewport.x, viewport.y]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setViewport((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  }, []);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const controlClass = cn(
    "flex size-10 items-center justify-center rounded-md text-foreground/75",
    "transition-colors hover:bg-muted hover:text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-none",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-background/92 supports-backdrop-filter:backdrop-blur-sm" />
        <DialogPrimitive.Popup
          className={cn(
            "app-viewport-fixed fixed z-50 flex min-h-0 flex-col bg-background outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:duration-150",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100",
            "motion-reduce:animate-none",
          )}
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
            <DialogTitle className="text-sm font-medium">Diagram preview</DialogTitle>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Scroll to zoom, drag to pan
            </span>
            <DialogClose
              render={
                <button
                  type="button"
                  className={cn(controlClass, "ml-auto")}
                  aria-label="Close diagram preview"
                />
              }
            >
              <XIcon className="size-4" aria-hidden />
            </DialogClose>
          </header>

          <div
            role="application"
            aria-label="Interactive diagram canvas"
            tabIndex={0}
            className={cn(
              "relative min-h-0 flex-1 touch-none overflow-hidden bg-muted/10 outline-none",
              "cursor-grab active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onDoubleClick={resetView}
          >
            <div className="absolute inset-8 flex items-center justify-center sm:inset-14">
              <div
                className={cn(
                  "h-[calc(100dvh-10rem)] w-[calc(100vw-3rem)] select-none sm:w-[min(82vw,72rem)]",
                  "[&_svg]:block [&_svg]:size-full",
                )}
                style={{
                  transform: `translate3d(${String(viewport.x)}px, ${String(viewport.y)}px, 0) scale(${String(viewport.scale)})`,
                  transformOrigin: "center",
                }}
                // Mermaid sanitizes this SVG with securityLevel "strict" before it reaches the dialog.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>

            <div className="absolute inset-x-0 bottom-5 flex justify-center px-4">
              <div className="flex items-center rounded-lg bg-popover p-1 ring-1 ring-border shadow-sm">
                <button
                  type="button"
                  className={controlClass}
                  aria-label="Zoom out"
                  disabled={viewport.scale <= MIN_SCALE}
                  onClick={() => changeScale(-SCALE_STEP)}
                >
                  <Minus className="size-4" aria-hidden />
                </button>
                <output
                  aria-live="polite"
                  className="w-14 text-center text-xs tabular-nums text-muted-foreground"
                >
                  {Math.round(viewport.scale * 100)}%
                </output>
                <button
                  type="button"
                  className={controlClass}
                  aria-label="Zoom in"
                  disabled={viewport.scale >= MAX_SCALE}
                  onClick={() => changeScale(SCALE_STEP)}
                >
                  <Plus className="size-4" aria-hidden />
                </button>
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <button
                  type="button"
                  className={controlClass}
                  aria-label="Reset view"
                  onClick={resetView}
                >
                  <RotateCcw className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

MermaidPreviewDialog.displayName = "MermaidPreviewDialog";
