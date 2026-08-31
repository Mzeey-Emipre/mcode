import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
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
import { useViewportCoordinatorState } from "./useViewportCoordinatorState";

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

interface DragHandleDetails {
  readonly axis: DragAxis;
  readonly direction: { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 };
  readonly className: string;
}

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

const DRAG_HANDLE_DETAILS: Record<DragHandlePosition, DragHandleDetails> = {
  top: { axis: "height", direction: { x: 0, y: -1 }, className: "inset-x-8 -top-4 h-8 cursor-ns-resize" },
  right: { axis: "width", direction: { x: 1, y: 0 }, className: "inset-y-8 -right-4 w-8 cursor-ew-resize" },
  bottom: { axis: "height", direction: { x: 0, y: 1 }, className: "inset-x-8 -bottom-4 h-8 cursor-ns-resize" },
  left: { axis: "width", direction: { x: -1, y: 0 }, className: "inset-y-8 -left-4 w-8 cursor-ew-resize" },
  "top-left": { axis: "both", direction: { x: -1, y: -1 }, className: "-left-4 -top-4 size-8 cursor-nwse-resize rounded-sm" },
  "top-right": { axis: "both", direction: { x: 1, y: -1 }, className: "-right-4 -top-4 size-8 cursor-nesw-resize rounded-sm" },
  "bottom-right": { axis: "both", direction: { x: 1, y: 1 }, className: "-bottom-4 -right-4 size-8 cursor-nwse-resize rounded-sm" },
  "bottom-left": { axis: "both", direction: { x: -1, y: 1 }, className: "-bottom-4 -left-4 size-8 cursor-nesw-resize rounded-sm" },
};

const CORNER_GLYPH_CLASSES: Record<Exclude<DragHandlePosition, "top" | "right" | "bottom" | "left">, string> = {
  "top-left": "border-l-2 border-t-2 border-current",
  "top-right": "border-r-2 border-t-2 border-current",
  "bottom-right": "border-b-2 border-r-2 border-current",
  "bottom-left": "border-b-2 border-l-2 border-current",
};

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

interface ViewportResizeHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function resizeFromPointer(
  details: DragHandleDetails,
  start: DragStart,
  event: PointerEvent<HTMLDivElement>,
  scale: number,
): ViewportSize {
  const divisor = scale > 0 ? scale : 1;
  const deltaX = ((event.clientX - start.x) / divisor) * details.direction.x;
  const deltaY = ((event.clientY - start.y) / divisor) * details.direction.y;
  return clampViewportSize({
    width: details.direction.x === 0 ? start.size.width : start.size.width + deltaX,
    height: details.direction.y === 0 ? start.size.height : start.size.height + deltaY,
  });
}

function resizeFromKeyboard(
  details: DragHandleDetails,
  size: ViewportSize,
  event: KeyboardEvent<HTMLDivElement>,
): ViewportSize | null {
  const step = event.shiftKey ? 48 : 16;
  const keyDelta = keyboardDelta(event.key, details.direction, step);
  if (!keyDelta) return null;
  return clampViewportSize({ width: size.width + keyDelta.x, height: size.height + keyDelta.y });
}

function keyboardDelta(
  key: string,
  direction: DragHandleDetails["direction"],
  step: number,
): { readonly x: number; readonly y: number } | null {
  const horizontal = key === "ArrowRight" ? direction.x : key === "ArrowLeft" ? -direction.x : 0;
  const vertical = key === "ArrowDown" ? direction.y : key === "ArrowUp" ? -direction.y : 0;
  if (horizontal === 0 && vertical === 0) return null;
  return { x: horizontal * step, y: vertical * step };
}

function useViewportResizeHandlers(
  details: DragHandleDetails,
  coordinator: ViewportCoordinator,
  state: ViewportCoordinatorState,
  scale: number,
  onUserViewportChange: (() => void) | undefined,
): ViewportResizeHandlers {
  const startRef = useRef<DragStart | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<ViewportSize | null>(null);

  const requestResize = (size: ViewportSize): void => {
    onUserViewportChange?.();
    coordinator.setMode("responsive");
    void coordinator.requestUserResize(size);
  };

  const flushResize = (): void => {
    const pending = pendingSizeRef.current;
    pendingSizeRef.current = null;
    if (pending) requestResize(pending);
  };

  const cancelScheduledResize = (): void => {
    if (frameRef.current === null) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };

  useEffect(() => cancelScheduledResize, []);

  const scheduleResize = (size: ViewportSize): void => {
    if (typeof requestAnimationFrame !== "function") {
      requestResize(size);
      return;
    }
    pendingSizeRef.current = size;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      flushResize();
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startRef.current = { x: event.clientX, y: event.clientY, size: state.confirmed };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current;
    if (!start || !holdsPointerCapture(event)) return;
    scheduleResize(resizeFromPointer(details, start, event, scale));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    startRef.current = null;
    cancelScheduledResize();
    flushResize();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = resizeFromKeyboard(details, state.confirmed, event);
    if (!next) return;
    event.preventDefault();
    requestResize(next);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}

function holdsPointerCapture(event: PointerEvent<HTMLDivElement>): boolean {
  return !event.currentTarget.hasPointerCapture || event.currentTarget.hasPointerCapture(event.pointerId);
}

function BrowserViewportDragHandleGlyph({ position }: { readonly position: DragHandlePosition }) {
  if (position === "left" || position === "right") {
    return (
      <span className="flex gap-1" aria-hidden>
        <span className="h-8 w-px rounded-full bg-current" />
        <span className="h-8 w-px rounded-full bg-current" />
      </span>
    );
  }
  if (position === "top" || position === "bottom") {
    return (
      <span className="flex flex-col gap-1" aria-hidden>
        <span className="h-px w-8 rounded-full bg-current" />
        <span className="h-px w-8 rounded-full bg-current" />
      </span>
    );
  }
  return <span className={cn("size-3", CORNER_GLYPH_CLASSES[position])} />;
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
  const details = DRAG_HANDLE_DETAILS[position];
  const handlers = useViewportResizeHandlers(details, coordinator, state, scale, onUserViewportChange);
  const dimension = details.axis === "height" ? "height" : "width";
  const isCorner = details.axis === "both";

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize viewport from ${position}`}
      aria-orientation={isCorner ? undefined : details.axis === "height" ? "horizontal" : "vertical"}
      aria-valuemin={isCorner ? undefined : MIN_VIEWPORT_CSS_PX}
      aria-valuemax={isCorner ? undefined : MAX_VIEWPORT_CSS_PX}
      aria-valuenow={isCorner ? undefined : state.confirmed[dimension]}
      aria-valuetext={isCorner ? `${state.confirmed.width} by ${state.confirmed.height} pixels` : undefined}
      data-position={position}
      className={cn(
        "pointer-events-auto absolute z-30 flex touch-none select-none items-center justify-center text-muted-foreground opacity-75 outline-none transition-colors hover:bg-accent/70 hover:text-foreground hover:opacity-100 focus-visible:bg-accent/70 focus-visible:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        details.className,
      )}
      {...handlers}
      onPointerCancel={handlers.onPointerUp}
    >
      <BrowserViewportDragHandleGlyph position={position} />
    </div>
  );
}

function canvasClassName(
  responsive: boolean,
  presentation: ViewportCoordinatorState["presentation"],
  className: string | undefined,
): string {
  const overflow = presentation === "actual" ? "overflow-auto" : "overflow-hidden";
  return cn("pointer-events-none relative h-full min-h-0", responsive && "bg-muted/30", responsive && overflow, className);
}

function stageSize(
  state: ViewportCoordinatorState,
  bounds: ViewportCanvasBounds,
  scale: number,
): { readonly width: number; readonly height: number; readonly stageWidth: number; readonly stageHeight: number } {
  const width = Math.round(state.confirmed.width * scale);
  const height = Math.round(state.confirmed.height * scale);
  return {
    width,
    height,
    stageWidth: Math.max(width + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.width) ? bounds.width : 0),
    stageHeight: Math.max(height + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.height) ? bounds.height : 0),
  };
}

function stageStyle(
  responsive: boolean,
  size: ReturnType<typeof stageSize>,
): { readonly width: number | string; readonly height: number | string; readonly padding: number } {
  return {
    width: responsive ? size.stageWidth : "100%",
    height: responsive ? size.stageHeight : "100%",
    padding: responsive ? BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX / 2 : 0,
  };
}

function viewportCanvasStyle(
  responsive: boolean,
  size: ReturnType<typeof stageSize>,
): { readonly width: number | string; readonly height: number | string } {
  return { width: responsive ? size.width : "100%", height: responsive ? size.height : "100%" };
}

function viewportContentStyle(
  responsive: boolean,
  state: ViewportCoordinatorState,
  scale: number,
): { readonly width: number | string; readonly height: number | string; readonly transform?: string; readonly transformOrigin: "top left" } {
  return {
    width: responsive ? state.confirmed.width : "100%",
    height: responsive ? state.confirmed.height : "100%",
    transform: responsive ? `scale(${scale})` : undefined,
    transformOrigin: "top left",
  };
}

function BrowserViewportResizeHandles({
  responsive,
  coordinator,
  state,
  scale,
  onUserViewportChange,
}: {
  readonly responsive: boolean;
  readonly coordinator: ViewportCoordinator | undefined;
  readonly state: ViewportCoordinatorState;
  readonly scale: number;
  readonly onUserViewportChange: (() => void) | undefined;
}) {
  if (!responsive || !coordinator) return null;
  return DRAG_HANDLE_POSITIONS.map((position) => (
    <BrowserViewportDragHandle
      key={position}
      position={position}
      coordinator={coordinator}
      state={state}
      scale={scale}
      onUserViewportChange={onUserViewportChange}
    />
  ));
}

function BrowserViewportStage({
  coordinator,
  state,
  bounds,
  scale,
  children,
  className,
  onUserViewportChange,
}: Required<Pick<BrowserViewportCanvasProps, "bounds" | "scale" | "children">> & Omit<BrowserViewportCanvasProps, "bounds" | "scale" | "children" | "state"> & { readonly state: ViewportCoordinatorState }) {
  const responsive = state.mode === "responsive";
  const size = stageSize(state, bounds, scale);

  return (
    <div data-testid="browser-viewport-stage" className={canvasClassName(responsive, state.presentation, className)}>
      <div className="flex min-h-full min-w-full items-center justify-center" style={stageStyle(responsive, size)}>
        <div
          data-testid="responsive-viewport-canvas"
          className={cn("relative flex-none", responsive && "overflow-visible rounded-md border border-border bg-background shadow-sm")}
          style={viewportCanvasStyle(responsive, size)}
        >
          <div
            className={cn("absolute left-0 top-0 overflow-hidden", responsive && "rounded-md")}
            style={viewportContentStyle(responsive, state, scale)}
          >
            {children}
          </div>
          <BrowserViewportResizeHandles
            responsive={responsive}
            coordinator={coordinator}
            state={state}
            scale={scale}
            onUserViewportChange={onUserViewportChange}
          />
        </div>
      </div>
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
  const currentState = useViewportCoordinatorState(coordinator, resolvedState);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return (
    <BrowserViewportStage
      coordinator={coordinator}
      state={currentState}
      bounds={bounds}
      scale={safeScale}
      className={className}
      onUserViewportChange={onUserViewportChange}
    >
      {children}
    </BrowserViewportStage>
  );
}
