import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
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
} from "../automation/services/viewportCoordinator";

type DragAxis = "width" | "height" | "both";
type DragHandlePosition =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-right"
  | "bottom-left";

const DRAG_HANDLE_POSITIONS: readonly DragHandlePosition[] = [
  "top",
  "right",
  "bottom",
  "left",
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];

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

function dragAxis(position: DragHandlePosition): DragAxis {
  const horizontal = position.includes("left") || position.includes("right");
  const vertical = position.includes("top") || position.includes("bottom");
  if (horizontal && vertical) return "both";
  return horizontal ? "width" : "height";
}

function dragDirection(position: DragHandlePosition): { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 } {
  return {
    x: position.includes("left") ? -1 : position.includes("right") ? 1 : 0,
    y: position.includes("top") ? -1 : position.includes("bottom") ? 1 : 0,
  };
}

function resizeFromPointer(
  position: DragHandlePosition,
  start: DragStart,
  event: PointerEvent<HTMLDivElement>,
  scale: number,
): ViewportSize {
  const divisor = scale > 0 ? scale : 1;
  const direction = dragDirection(position);
  const deltaX = ((event.clientX - start.x) / divisor) * direction.x;
  const deltaY = ((event.clientY - start.y) / divisor) * direction.y;
  return clampViewportSize({
    width: direction.x === 0 ? start.size.width : start.size.width + deltaX,
    height: direction.y === 0 ? start.size.height : start.size.height + deltaY,
  });
}

function resizeFromKeyboard(
  position: DragHandlePosition,
  size: ViewportSize,
  event: KeyboardEvent<HTMLDivElement>,
): ViewportSize | null {
  const step = event.shiftKey ? 48 : 16;
  const direction = dragDirection(position);
  if (direction.x !== 0 && event.key === "ArrowRight") {
    return clampViewportSize({ ...size, width: size.width + step * direction.x });
  }
  if (direction.x !== 0 && event.key === "ArrowLeft") {
    return clampViewportSize({ ...size, width: size.width - step * direction.x });
  }
  if (direction.y !== 0 && event.key === "ArrowDown") {
    return clampViewportSize({ ...size, height: size.height + step * direction.y });
  }
  if (direction.y !== 0 && event.key === "ArrowUp") {
    return clampViewportSize({ ...size, height: size.height - step * direction.y });
  }
  return null;
}

function BrowserViewportDragHandle({
  position,
  coordinator,
  state,
  scale,
  onUserViewportChange,
}: {
  readonly position: DragHandlePosition;
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly scale: number;
  readonly onUserViewportChange?: () => void;
}) {
  const axis = dragAxis(position);
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
    const nextSize = resizeFromPointer(position, start, event, scale);
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
    const next = resizeFromKeyboard(position, state.confirmed, event);
    if (!next) return;
    event.preventDefault();
    requestResize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize viewport from ${position}`}
      aria-orientation={axis === "both" ? undefined : axis === "height" ? "horizontal" : "vertical"}
      aria-valuemin={axis === "both" ? undefined : MIN_VIEWPORT_CSS_PX}
      aria-valuemax={axis === "both" ? undefined : MAX_VIEWPORT_CSS_PX}
      aria-valuenow={axis === "both" ? undefined : state.confirmed[axis === "height" ? "height" : "width"]}
      aria-valuetext={axis === "both" ? `${state.confirmed.width} by ${state.confirmed.height} pixels` : undefined}
      data-position={position}
      className={cn(
        "pointer-events-auto absolute z-30 flex touch-none select-none items-center justify-center text-muted-foreground opacity-75 outline-none transition-colors hover:bg-accent/70 hover:text-foreground hover:opacity-100 focus-visible:bg-accent/70 focus-visible:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        position === "top" && "inset-x-8 -top-4 h-8 cursor-ns-resize",
        position === "right" && "inset-y-8 -right-4 w-8 cursor-ew-resize",
        position === "bottom" && "inset-x-8 -bottom-4 h-8 cursor-ns-resize",
        position === "left" && "inset-y-8 -left-4 w-8 cursor-ew-resize",
        position === "top-left" && "-left-4 -top-4 size-8 cursor-nwse-resize rounded-sm",
        position === "top-right" && "-right-4 -top-4 size-8 cursor-nesw-resize rounded-sm",
        position === "bottom-right" && "-bottom-4 -right-4 size-8 cursor-nwse-resize rounded-sm",
        position === "bottom-left" && "-bottom-4 -left-4 size-8 cursor-nesw-resize rounded-sm",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {position === "left" || position === "right" ? (
        <span className="flex gap-1" aria-hidden>
          <span className="h-8 w-px rounded-full bg-current" />
          <span className="h-8 w-px rounded-full bg-current" />
        </span>
      ) : position === "top" || position === "bottom" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          <span className="h-px w-8 rounded-full bg-current" />
          <span className="h-px w-8 rounded-full bg-current" />
        </span>
      ) : (
        <span
          className={cn(
            "size-3",
            position === "top-left" && "border-l-2 border-t-2 border-current",
            position === "top-right" && "border-r-2 border-t-2 border-current",
            position === "bottom-right" && "border-b-2 border-r-2 border-current",
            position === "bottom-left" && "border-b-2 border-l-2 border-current",
          )}
        />
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
        "pointer-events-none relative h-full min-h-0",
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
            DRAG_HANDLE_POSITIONS.map((position) => (
              <BrowserViewportDragHandle
                key={position}
                position={position}
                coordinator={coordinator}
                state={currentState}
                scale={safeScale}
                onUserViewportChange={onUserViewportChange}
              />
            ))
          ) : null}
        </div>
      </div>
    </div>
  );
}
