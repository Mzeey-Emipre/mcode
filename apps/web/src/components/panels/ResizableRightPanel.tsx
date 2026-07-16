import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const KEYBOARD_RESIZE_STEP_PX = 10;

/** Ownership source reported when a controlled panel width changes. */
export type ResizablePanelWidthSource = "preserve" | "user";

/** Props for the shared controlled right-panel resize shell. */
export interface ResizableRightPanelProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "style"
> {
  children: ReactNode;
  width: number;
  minWidth: number;
  maxWidth: CSSProperties["maxWidth"];
  getMaxWidth: (panel: HTMLDivElement | null) => number;
  defaultWidth: number;
  wideWidth: number;
  separatorLabel: string;
  onWidthChange: (width: number, source: ResizablePanelWidthSource) => void;
  resizeEnabled?: boolean;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

/** Provides the shared drag, keyboard, snap, and clamp behavior for right panels. */
export function ResizableRightPanel({
  children,
  width,
  minWidth,
  maxWidth,
  getMaxWidth,
  defaultWidth,
  wideWidth,
  separatorLabel,
  onWidthChange,
  resizeEnabled = true,
  className,
  style,
  testId,
  ...panelProps
}: ResizableRightPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{
    move: (event: globalThis.MouseEvent) => void;
    up: () => void;
  } | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const clampWidth = useCallback(
    (candidate: number) =>
      Math.max(minWidth, Math.min(candidate, getMaxWidth(panelRef.current))),
    [getMaxWidth, minWidth],
  );

  useEffect(() => {
    if (!resizeEnabled || typeof ResizeObserver === "undefined") return;
    const parent = panelRef.current?.parentElement;
    if (!parent) return;

    const clampToParent = () => {
      const nextWidth = clampWidth(widthRef.current);
      if (nextWidth !== widthRef.current) {
        onWidthChange(nextWidth, "preserve");
      }
    };

    clampToParent();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        clampToParent();
      });
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [clampWidth, onWidthChange, resizeEnabled]);

  const stopDragging = useCallback(() => {
    draggingRef.current = false;
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    document.removeEventListener("mousemove", listeners.move);
    document.removeEventListener("mouseup", listeners.up);
    dragListenersRef.current = null;
  }, []);

  useEffect(() => stopDragging, [stopDragging]);

  const handleDragStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      stopDragging();
      draggingRef.current = true;
      const startX = event.clientX;
      const startWidth = width;
      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        onWidthChange(
          clampWidth(startWidth + startX - moveEvent.clientX),
          "user",
        );
      };
      const handleUp = () => stopDragging();
      dragListenersRef.current = { move: handleMove, up: handleUp };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [clampWidth, onWidthChange, stopDragging, width],
  );

  const toggleSnapWidth = useCallback(() => {
    const target = width >= wideWidth ? defaultWidth : wideWidth;
    onWidthChange(clampWidth(target), "user");
  }, [clampWidth, defaultWidth, onWidthChange, wideWidth, width]);

  return (
    <div
      ref={panelRef}
      {...panelProps}
      data-testid={testId}
      style={resizeEnabled ? { width, minWidth, maxWidth, ...style } : style}
      className={cn("relative min-h-0 min-w-0", className)}
    >
      {resizeEnabled && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={separatorLabel}
          aria-valuemin={minWidth}
          aria-valuemax={getMaxWidth(panelRef.current)}
          aria-valuenow={width}
          tabIndex={0}
          className="group absolute inset-y-0 left-0 z-20 flex w-2 cursor-col-resize items-stretch justify-start focus:outline-none"
          onMouseDown={handleDragStart}
          onDoubleClick={toggleSnapWidth}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleSnapWidth();
              return;
            }
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta =
              event.key === "ArrowLeft"
                ? KEYBOARD_RESIZE_STEP_PX
                : -KEYBOARD_RESIZE_STEP_PX;
            onWidthChange(clampWidth(width + delta), "user");
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none w-px shrink-0 bg-border/45 transition-colors group-hover:bg-border group-focus-visible:w-0.5 group-focus-visible:bg-ring group-active:w-0.5 group-active:bg-muted-foreground/60"
          />
        </div>
      )}
      {children}
    </div>
  );
}
