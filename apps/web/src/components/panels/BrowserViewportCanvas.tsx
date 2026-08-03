import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { MoveHorizontal } from "lucide-react";
import { BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import {
  clampViewportSize,
  DEFAULT_VIEWPORT_SIZE,
  MAX_VIEWPORT_CSS_PX,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportCoordinatorState,
  type ViewportCanvasBounds,
  type ViewportSize,
} from "@/services/browser-automation/viewportCoordinator";

type DragAxis = "width" | "height" | "both";

/** Props for the responsive Browser viewport canvas and its resize affordances. */
export interface BrowserViewportCanvasProps {
  readonly coordinator?: ViewportCoordinator;
  readonly state?: ViewportCoordinatorState;
  readonly bounds: ViewportCanvasBounds;
  readonly scale: number;
  readonly children: ReactNode;
  readonly className?: string;
  readonly onUserViewportChange?: () => void;
}

const INACTIVE_VIEWPORT_STATE: ViewportCoordinatorState = {
  mode: "regular",
  presentation: "fit",
  confirmed: DEFAULT_VIEWPORT_SIZE,
  userConfirmed: DEFAULT_VIEWPORT_SIZE,
  targetGeneration: 0,
  pending: null,
  pendingReset: null,
  pendingPresentation: null,
  presentationError: null,
  agentActive: false,
};

interface DragStart {
  readonly x: number;
  readonly y: number;
  readonly size: ViewportSize;
}

function axisLabel(axis: DragAxis): string {
  return axis === "both" ? "both" : axis;
}

function resizeFromPointer(axis: DragAxis, start: DragStart, event: PointerEvent<HTMLDivElement>, scale: number): ViewportSize {
  const divisor = scale > 0 ? scale : 1;
  const deltaX = (event.clientX - start.x) / divisor;
  const deltaY = (event.clientY - start.y) / divisor;
  return clampViewportSize({
    width: axis === "height" ? start.size.width : start.size.width + deltaX,
    height: axis === "width" ? start.size.height : start.size.height + deltaY,
  });
}

function resizeFromKeyboard(axis: DragAxis, size: ViewportSize, event: KeyboardEvent<HTMLDivElement>): ViewportSize | null {
  const step = event.shiftKey ? 48 : 16;
  if (axis !== "height" && event.key === "ArrowRight") {
    return clampViewportSize({ ...size, width: size.width + step });
  }
  if (axis !== "height" && event.key === "ArrowLeft") {
    return clampViewportSize({ ...size, width: size.width - step });
  }
  if (axis !== "width" && event.key === "ArrowDown") {
    return clampViewportSize({ ...size, height: size.height + step });
  }
  if (axis !== "width" && event.key === "ArrowUp") {
    return clampViewportSize({ ...size, height: size.height - step });
  }
  return null;
}

function BrowserViewportDragHandle({
  axis,
  coordinator,
  state,
  scale,
  onUserViewportChange,
}: {
  readonly axis: DragAxis;
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly scale: number;
  readonly onUserViewportChange?: () => void;
}) {
  const startRef = useRef<DragStart | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<ViewportSize | null>(null);

  const requestResize = (size: ViewportSize): void => {
    onUserViewportChange?.();
    coordinator.setMode("responsive");
    void coordinator.requestUserResize(size);
  };

  useEffect(() => () => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameRef.current);
    }
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startRef.current = {
      x: event.clientX,
      y: event.clientY,
      size: state.confirmed,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current;
    if (!start) return;
    if (event.currentTarget.hasPointerCapture && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const nextSize = resizeFromPointer(axis, start, event, scale);
    if (typeof requestAnimationFrame !== "function") {
      requestResize(nextSize);
      return;
    }
    pendingSizeRef.current = nextSize;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingSizeRef.current;
      pendingSizeRef.current = null;
      if (pending) requestResize(pending);
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    startRef.current = null;
    if (frameRef.current !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingSizeRef.current;
    pendingSizeRef.current = null;
    if (pending) requestResize(pending);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = resizeFromKeyboard(axis, state.confirmed, event);
    if (!next) return;
    event.preventDefault();
    requestResize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize viewport ${axisLabel(axis)}`}
      aria-orientation={axis === "height" ? "horizontal" : "vertical"}
      aria-valuemin={MIN_VIEWPORT_CSS_PX}
      aria-valuemax={MAX_VIEWPORT_CSS_PX}
      aria-valuenow={state.confirmed[axis === "height" ? "height" : "width"]}
      className={cn(
        "absolute z-20 flex items-center justify-center text-muted-foreground opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        axis === "width" && "inset-y-8 -right-4 w-8 cursor-ew-resize",
        axis === "height" && "inset-x-8 -bottom-4 h-8 cursor-ns-resize",
        axis === "both" && "-bottom-4 -right-4 size-8 cursor-nwse-resize rounded-sm",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {axis === "width" ? (
        <MoveHorizontal size={14} aria-hidden />
      ) : axis === "height" ? (
        <span className="h-1 w-5 rounded-full bg-current" />
      ) : (
        <span className="size-2 border-b-2 border-r-2 border-current" />
      )}
    </div>
  );
}

/** Render a centered responsive viewport with keyboard and pointer resize handles. */
export function BrowserViewportCanvas({
  coordinator,
  state,
  bounds,
  scale,
  children,
  className,
  onUserViewportChange,
}: BrowserViewportCanvasProps) {
  const resolvedState = state ?? INACTIVE_VIEWPORT_STATE;
  const [currentState, setCurrentState] = useState(resolvedState);
  useEffect(() => setCurrentState(resolvedState), [resolvedState]);
  useEffect(() => coordinator?.subscribe(setCurrentState), [coordinator]);
  const responsive = currentState.mode === "responsive";
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const renderedWidth = Math.round(currentState.confirmed.width * safeScale);
  const renderedHeight = Math.round(currentState.confirmed.height * safeScale);
  const stageWidth = Math.max(renderedWidth + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.width) ? bounds.width : 0);
  const stageHeight = Math.max(renderedHeight + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.height) ? bounds.height : 0);

  return (
    <div
      data-testid="browser-viewport-stage"
      className={cn(
        "relative h-full min-h-0",
        responsive && "bg-muted/30",
        responsive && currentState.presentation === "actual" ? "overflow-auto" : "overflow-hidden",
        className,
      )}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={{
          width: responsive ? stageWidth : "100%",
          height: responsive ? stageHeight : "100%",
          padding: responsive ? BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX / 2 : 0,
        }}
      >
        <div
          data-testid="responsive-viewport-canvas"
          className={cn(
            "relative flex-none",
            responsive && "overflow-visible rounded-md border border-border bg-background shadow-sm",
          )}
          style={{
            width: responsive ? renderedWidth : "100%",
            height: responsive ? renderedHeight : "100%",
          }}
        >
          <div
            className={cn(
              "absolute left-0 top-0 overflow-hidden",
              responsive && "rounded-md",
            )}
            style={{
              width: responsive ? currentState.confirmed.width : "100%",
              height: responsive ? currentState.confirmed.height : "100%",
              transform: responsive ? `scale(${safeScale})` : undefined,
              transformOrigin: "top left",
            }}
          >
            {children}
          </div>
          {responsive && coordinator ? (
            <>
              <BrowserViewportDragHandle axis="width" coordinator={coordinator} state={currentState} scale={safeScale} onUserViewportChange={onUserViewportChange} />
              <BrowserViewportDragHandle axis="height" coordinator={coordinator} state={currentState} scale={safeScale} onUserViewportChange={onUserViewportChange} />
              <BrowserViewportDragHandle axis="both" coordinator={coordinator} state={currentState} scale={safeScale} onUserViewportChange={onUserViewportChange} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
