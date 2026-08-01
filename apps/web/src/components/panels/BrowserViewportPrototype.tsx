import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  Check,
  ChevronDown,
  EllipsisVertical,
  Expand,
  ExternalLink,
  Hand,
  Laptop,
  Monitor,
  MoveHorizontal,
  PenTool,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PrototypeSwitcher,
  type PrototypeVariantOption,
} from "@/components/ui/prototype-switcher";
import { cn } from "@/lib/utils";

type PresentationMode = "fit" | "actual";
type ViewportMode = "regular" | "responsive";
type ViewportSource = "agent" | "user";
type DragAxis = "width" | "height" | "both";

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

interface ViewportPrototypeState extends ViewportSize {
  readonly mode: ViewportMode;
  readonly presentation: PresentationMode;
  readonly source: ViewportSource;
  readonly preset: string | null;
}

interface ViewportPreset extends ViewportSize {
  readonly id: string;
  readonly label: string;
  readonly icon: typeof Smartphone;
}

const VARIANTS = [
  { id: "A", label: "Instrument strip" },
  { id: "B", label: "Device toolbar" },
  { id: "C", label: "Canvas HUD" },
] as const satisfies readonly PrototypeVariantOption[];

const PRESETS = [
  { id: "mobile", label: "Mobile", width: 390, height: 844, icon: Smartphone },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, icon: Tablet },
  { id: "laptop", label: "Laptop", width: 1280, height: 800, icon: Laptop },
  { id: "desktop", label: "Desktop", width: 1440, height: 900, icon: Monitor },
] as const satisfies readonly ViewportPreset[];

const TOOLBAR_PRESETS = [
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852, icon: Smartphone },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915, icon: Smartphone },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180, icon: Tablet },
  { id: "surface-pro-7", label: "Surface Pro 7", width: 912, height: 1368, icon: Tablet },
  { id: "laptop", label: "Laptop", width: 1280, height: 800, icon: Laptop },
  { id: "desktop", label: "Desktop", width: 1440, height: 900, icon: Monitor },
] as const satisfies readonly ViewportPreset[];

const DEFAULT_VIEWPORT: ViewportPrototypeState = {
  width: 520,
  height: 900,
  mode: "responsive",
  presentation: "fit",
  source: "agent",
  preset: null,
};

const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 2560;

function clampDimension(value: number): number {
  return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(value)));
}

function variantFromUrl(): string {
  const requested = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((variant) => variant.id === requested)
    ? requested!
    : VARIANTS[0].id;
}

function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (): void => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function useFitScale(
  ref: RefObject<HTMLElement | null>,
  viewport: ViewportSize,
  maximum: number,
): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (): void => {
      const availableWidth = Math.max(1, element.clientWidth - 64);
      const availableHeight = Math.max(1, element.clientHeight - 64);
      setScale(
        Math.max(
          0.2,
          Math.min(
            maximum,
            availableWidth / viewport.width,
            availableHeight / viewport.height,
          ),
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maximum, ref, viewport.height, viewport.width]);
  return scale;
}

function PrototypeBrowserHeader({
  toolbarVisible,
  onToggleToolbar,
}: {
  readonly toolbarVisible?: boolean;
  readonly onToggleToolbar?: () => void;
}) {
  return (
    <div className="flex h-10 flex-none items-center gap-1 border-b border-border/60 bg-background px-2">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Back">
        <ArrowLeft size={16} aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward">
        <ArrowRight size={16} aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload">
        <RotateCw size={16} aria-hidden />
      </Button>
      <div className="mx-1 flex min-w-0 flex-1 items-center justify-center rounded-full px-3 py-1.5 hover:bg-input/60">
        <span className="truncate text-sm font-medium">Acme operations</span>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Design">
        <PenTool size={16} aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Screenshot">
        <Camera size={16} aria-hidden />
      </Button>
      {onToggleToolbar ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More browser actions"
              >
                <EllipsisVertical size={16} aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem>New page</DropdownMenuItem>
            <DropdownMenuItem>Force reload</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onToggleToolbar}>
              <Smartphone size={14} aria-hidden />
              {toolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Camera size={14} aria-hidden />
              Take a screenshot
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="More browser actions"
        >
          <EllipsisVertical size={16} aria-hidden />
        </Button>
      )}
    </div>
  );
}

function PrototypePage({
  source,
  viewportWidth,
}: {
  readonly source: ViewportSource;
  readonly viewportWidth: number;
}) {
  const compact = viewportWidth < 640;
  return (
    <div className="relative h-full min-h-full w-full overflow-hidden bg-[#f5f6f8] font-sans text-[#1f2937]">
      <header className="flex h-14 items-center justify-between border-b border-[#d9dde5] bg-white px-5">
        <div className="flex items-center gap-3">
          <div className="size-6 rounded-md bg-[#20242b]" />
          <span className="text-sm font-semibold">Acme operations</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[#eef0f4] px-3 py-1 text-xs">Search</span>
          <div className="size-7 rounded-full bg-[#d7dbe3]" />
        </div>
      </header>
      <div className="flex h-[calc(100%-3.5rem)]">
        {!compact ? (
          <aside className="w-44 flex-none border-r border-[#d9dde5] bg-[#fbfbfc] p-4">
            <div className="mb-4 h-7 rounded-md bg-[#e6e9ee]" />
            <div className="space-y-2">
              <div className="h-6 rounded bg-[#eceef2]" />
              <div className="h-6 rounded bg-[#eceef2]" />
              <div className="h-6 rounded bg-[#eceef2]" />
            </div>
          </aside>
        ) : null}
        <main className={cn("min-w-0 flex-1", compact ? "p-4" : "p-5")}>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Deployments</h1>
              <p className="mt-1 text-xs text-[#667085]">Production activity across services</p>
            </div>
            <span className="shrink-0 rounded-md bg-[#20242b] px-3 py-2 text-xs font-medium text-white">
              {compact ? "Deploy" : "New deploy"}
            </span>
          </div>
          <div className="border-y border-[#d9dde5] bg-white">
            {["API gateway", "Web application", "Worker queue", "Event relay"].map(
              (name, index) => (
                <div
                  key={name}
                  className="flex items-center gap-4 border-b border-[#e8eaf0] px-4 py-3 last:border-b-0"
                >
                  <span className="size-2 rounded-full bg-[#3f8f62]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                  {!compact ? (
                    <span className="text-xs text-[#667085]">main · a8{index}f2c</span>
                  ) : null}
                  <span className="text-xs text-[#667085]">{index + 2}m</span>
                </div>
              ),
            )}
          </div>
        </main>
      </div>
      {source === "agent" ? (
        <div
          className="pointer-events-none absolute left-[72%] top-[44%] size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-200 bg-amber-500 shadow-sm"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

function DragHandle({
  axis,
  viewport,
  scale,
  onResize,
}: {
  readonly axis: DragAxis;
  readonly viewport: ViewportSize;
  readonly scale: number;
  readonly onResize: (size: ViewportSize) => void;
}) {
  const startRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: viewport.width,
      height: viewport.height,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current;
    if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const width =
      axis === "height"
        ? start.width
        : clampDimension(start.width + (event.clientX - start.x) / scale);
    const height =
      axis === "width"
        ? start.height
        : clampDimension(start.height + (event.clientY - start.y) / scale);
    onResize({ width, height });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    let next = viewport;
    if (axis !== "height" && event.key === "ArrowRight") {
      next = { ...next, width: clampDimension(next.width + step) };
    } else if (axis !== "height" && event.key === "ArrowLeft") {
      next = { ...next, width: clampDimension(next.width - step) };
    } else if (axis !== "width" && event.key === "ArrowDown") {
      next = { ...next, height: clampDimension(next.height + step) };
    } else if (axis !== "width" && event.key === "ArrowUp") {
      next = { ...next, height: clampDimension(next.height - step) };
    } else {
      return;
    }
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize viewport ${axis}`}
      aria-orientation={axis === "height" ? "horizontal" : "vertical"}
      aria-valuemin={MIN_VIEWPORT}
      aria-valuemax={MAX_VIEWPORT}
      aria-valuenow={axis === "height" ? viewport.height : viewport.width}
      className={cn(
        "absolute z-20 flex items-center justify-center text-muted-foreground opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        axis === "width" && "inset-y-8 -right-4 w-8 cursor-ew-resize",
        axis === "height" && "inset-x-8 -bottom-4 h-8 cursor-ns-resize",
        axis === "both" && "-bottom-4 -right-4 size-8 cursor-nwse-resize rounded-sm",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        startRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
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

function ViewportCanvas({
  state,
  fitMaximum,
  onResize,
  onScaleChange,
  showStatus = true,
}: {
  readonly state: ViewportPrototypeState;
  readonly fitMaximum: number;
  readonly onResize: (size: ViewportSize) => void;
  readonly onScaleChange?: (scale: number) => void;
  readonly showStatus?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fitScale = useFitScale(stageRef, state, fitMaximum);
  const scale = state.presentation === "fit" ? fitScale : 1;
  const renderedWidth = state.width * scale;
  const renderedHeight = state.height * scale;

  useEffect(() => onScaleChange?.(scale), [onScaleChange, scale]);

  if (state.mode === "regular") {
    return (
      <div ref={stageRef} className="relative h-full min-h-0 bg-muted/20 p-3">
        <div className="h-full overflow-hidden rounded-md border border-border bg-background">
          <PrototypePage source={state.source} viewportWidth={900} />
        </div>
        <Badge variant="secondary" className="absolute bottom-5 left-5">Regular view</Badge>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      className={cn(
        "relative h-full min-h-0 bg-muted/30",
        state.presentation === "actual" ? "overflow-auto" : "overflow-hidden",
      )}
      data-testid="viewport-prototype-stage"
    >
      <div
        className="flex items-center justify-center p-8"
        style={{
          width: Math.max(renderedWidth + 64, stageRef.current?.clientWidth ?? 0),
          height: Math.max(renderedHeight + 64, stageRef.current?.clientHeight ?? 0),
        }}
      >
        <div
          className="relative flex-none"
          style={{ width: renderedWidth, height: renderedHeight }}
        >
          <div
            className="absolute left-0 top-0 overflow-hidden rounded-md border border-border bg-background shadow-sm"
            style={{
              width: state.width,
              height: state.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <PrototypePage source={state.source} viewportWidth={state.width} />
          </div>
          <DragHandle axis="width" viewport={state} scale={scale} onResize={onResize} />
          <DragHandle axis="height" viewport={state} scale={scale} onResize={onResize} />
          <DragHandle axis="both" viewport={state} scale={scale} onResize={onResize} />
        </div>
      </div>
      {showStatus ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-sm">
          <span className="font-mono tabular-nums">{state.width} × {state.height}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono tabular-nums">{Math.round(scale * 100)}%</span>
          {state.source === "agent" ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <Bot size={12} aria-hidden /> Agent applied
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PresetControls({
  state,
  onPreset,
  compact = false,
}: {
  readonly state: ViewportPrototypeState;
  readonly onPreset: (preset: ViewportPreset) => void;
  readonly compact?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1", compact && "grid grid-cols-2")}>
      {PRESETS.map((preset) => {
        const Icon = preset.icon;
        const selected = state.preset === preset.id;
        return (
          <Button
            key={preset.id}
            type="button"
            variant={selected ? "secondary" : "ghost"}
            size={compact ? "sm" : "icon-sm"}
            className={cn(compact && "justify-start")}
            onClick={() => onPreset(preset)}
            aria-pressed={selected}
            aria-label={`${preset.label} ${preset.width} by ${preset.height}`}
          >
            <Icon size={15} aria-hidden />
            {compact ? <span>{preset.label}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

function DimensionControls({
  state,
  onDimension,
}: {
  readonly state: ViewportPrototypeState;
  readonly onDimension: (axis: keyof ViewportSize, value: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Input
        type="number"
        min={MIN_VIEWPORT}
        max={MAX_VIEWPORT}
        size="sm"
        className="w-16 shrink-0 bg-input px-2 text-center font-mono font-normal tabular-nums shadow-none [appearance:textfield] min-[600px]:w-20 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        aria-label="Viewport width"
        value={state.width}
        onChange={(event) => onDimension("width", Number(event.target.value))}
      />
      <span className="flex w-3 shrink-0 justify-center text-xs text-muted-foreground">
        ×
      </span>
      <Input
        type="number"
        min={MIN_VIEWPORT}
        max={MAX_VIEWPORT}
        size="sm"
        className="w-16 shrink-0 bg-input px-2 text-center font-mono font-normal tabular-nums shadow-none [appearance:textfield] min-[600px]:w-20 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        aria-label="Viewport height"
        value={state.height}
        onChange={(event) => onDimension("height", Number(event.target.value))}
      />
    </div>
  );
}

function PresentationControls({
  value,
  onChange,
  labels = true,
}: {
  readonly value: PresentationMode;
  readonly onChange: (value: PresentationMode) => void;
  readonly labels?: boolean;
}) {
  return (
    <div className="flex items-center rounded-md bg-muted p-0.5" role="group" aria-label="Viewport presentation">
      <Button
        type="button"
        variant={value === "fit" ? "secondary" : "ghost"}
        size={labels ? "sm" : "icon-sm"}
        className="h-7"
        onClick={() => onChange("fit")}
        aria-pressed={value === "fit"}
        aria-label="Fit viewport"
      >
        <Expand size={14} aria-hidden />
        {labels ? "Fit" : null}
      </Button>
      <Button
        type="button"
        variant={value === "actual" ? "secondary" : "ghost"}
        size={labels ? "sm" : "icon-sm"}
        className="h-7"
        onClick={() => onChange("actual")}
        aria-pressed={value === "actual"}
        aria-label="Actual size"
      >
        <ExternalLink size={14} aria-hidden />
        {labels ? "Actual" : null}
      </Button>
    </div>
  );
}

function ViewportOrientationIcon({
  landscape,
}: {
  readonly landscape: boolean;
}) {
  return (
    <span className="relative flex size-5 items-center justify-center" aria-hidden>
      <Smartphone
        className={cn("size-4", landscape && "rotate-90")}
        strokeWidth={1.8}
      />
      <RotateCw
        className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-background p-px"
        strokeWidth={2}
      />
    </span>
  );
}

function DeviceToolbar({
  state,
  scale,
  onPreset,
  onCustom,
  onDimension,
  onRotate,
  onPresentation,
  onHide,
}: {
  readonly state: ViewportPrototypeState;
  readonly scale: number;
  readonly onPreset: (preset: ViewportPreset) => void;
  readonly onCustom: () => void;
  readonly onDimension: (axis: keyof ViewportSize, value: number) => void;
  readonly onRotate: () => void;
  readonly onPresentation: (presentation: PresentationMode) => void;
  readonly onHide: () => void;
}) {
  const selectedPreset = TOOLBAR_PRESETS.find(
    (preset) => preset.id === state.preset,
  );
  const landscape = state.width > state.height;

  return (
    <div
      className="flex h-11 flex-none items-center gap-1 overflow-x-hidden border-b border-border/60 bg-background px-2"
      data-testid="device-toolbar"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-36 shrink-0 justify-between bg-input px-2.5 shadow-none hover:bg-muted aria-expanded:bg-muted min-[600px]:w-40"
              aria-label="Viewport preset"
            >
              <span className="truncate">
                {selectedPreset?.label ?? "Responsive"}
              </span>
              <ChevronDown size={14} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem
            className={cn(state.preset === null && "bg-muted text-foreground")}
            onClick={onCustom}
          >
            Responsive
          </DropdownMenuItem>
          {TOOLBAR_PRESETS.map((preset) => {
            return (
              <DropdownMenuItem
                key={preset.id}
                className={cn(
                  state.preset === preset.id && "bg-muted text-foreground",
                )}
                onClick={() => onPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {preset.width} × {preset.height}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <DimensionControls state={state} onDimension={onDimension} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onRotate}
        aria-label={
          landscape
            ? "Rotate viewport to portrait"
            : "Rotate viewport to landscape"
        }
      >
        <ViewportOrientationIcon landscape={landscape} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1 px-2.5 font-mono tabular-nums"
              aria-label="Viewport scale and presentation"
            >
              {Math.round(scale * 100)}%
              <ChevronDown size={13} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => onPresentation("fit")}>
            <span className="w-4">
              {state.presentation === "fit" ? (
                <Check size={14} aria-hidden />
              ) : null}
            </span>
            Fit to panel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPresentation("actual")}>
            <span className="w-4">
              {state.presentation === "actual" ? (
                <Check size={14} aria-hidden />
              ) : null}
            </span>
            Actual size
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="min-w-2 flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onHide}
        aria-label="Hide device toolbar"
      >
        <X size={15} aria-hidden />
      </Button>
    </div>
  );
}

function VariantA({
  state,
  setState,
  applyPreset,
  applyDimension,
  applyResize,
  reset,
}: VariantProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PrototypeBrowserHeader />
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border/60 bg-background px-2 py-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={() => setState((current) => ({ ...current, mode: "responsive", source: "user" }))}
        >
          <SlidersHorizontal size={14} aria-hidden /> Responsive
        </Button>
        <PresetControls state={state} onPreset={applyPreset} />
        <DimensionControls state={state} onDimension={applyDimension} />
        <div className="ml-auto flex items-center gap-1">
          <PresentationControls
            value={state.presentation}
            onChange={(presentation) => setState((current) => ({ ...current, presentation, source: "user" }))}
          />
          <Button type="button" variant="ghost" size="icon-sm" onClick={reset} aria-label="Exit responsive mode">
            <X size={15} aria-hidden />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ViewportCanvas state={state} fitMaximum={1} onResize={applyResize} />
      </div>
    </div>
  );
}

function VariantB({
  state,
  setState,
  applyPreset,
  applyDimension,
  applyResize,
  reset,
}: VariantProps) {
  const [scale, setScale] = useState(1);
  const toolbarVisible = state.mode === "responsive";
  const toggleToolbar = (): void => {
    setState((current) => ({
      ...current,
      mode: current.mode === "responsive" ? "regular" : "responsive",
      source: "user",
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PrototypeBrowserHeader
        toolbarVisible={toolbarVisible}
        onToggleToolbar={toggleToolbar}
      />
      {toolbarVisible ? (
        <DeviceToolbar
          state={state}
          scale={scale}
          onPreset={applyPreset}
          onCustom={() =>
            setState((current) => ({
              ...current,
              mode: "responsive",
              source: "user",
              preset: null,
            }))
          }
          onDimension={applyDimension}
          onRotate={() =>
            setState((current) => ({
              ...current,
              width: current.height,
              height: current.width,
              source: "user",
              preset: null,
            }))
          }
          onPresentation={(presentation) =>
            setState((current) => ({
              ...current,
              presentation,
              source: "user",
            }))
          }
          onHide={reset}
        />
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        <ViewportCanvas
          state={state}
          fitMaximum={1.25}
          onResize={applyResize}
          onScaleChange={setScale}
          showStatus={false}
        />
      </div>
    </div>
  );
}

function VariantC({
  state,
  setState,
  applyPreset,
  applyDimension,
  applyResize,
  reset,
}: VariantProps) {
  const [controlsOpen, setControlsOpen] = useState(true);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PrototypeBrowserHeader />
      <div className="relative min-h-0 flex-1">
        <ViewportCanvas state={state} fitMaximum={1} onResize={applyResize} showStatus={false} />
        <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-1 shadow-sm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 font-mono tabular-nums"
              onClick={() => setControlsOpen((open) => !open)}
              aria-expanded={controlsOpen}
            >
              <SlidersHorizontal size={14} aria-hidden />
              {state.width} × {state.height}
            </Button>
            <PresentationControls
              value={state.presentation}
              labels={false}
              onChange={(presentation) => setState((current) => ({ ...current, presentation, source: "user" }))}
            />
            <Button type="button" variant="ghost" size="icon-sm" className="h-7" onClick={reset} aria-label="Exit responsive mode">
              <X size={14} aria-hidden />
            </Button>
          </div>
          {controlsOpen ? (
            <div className="mx-auto mt-2 flex w-max max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2 shadow-md">
              <PresetControls state={state} onPreset={applyPreset} />
              <DimensionControls state={state} onDimension={applyDimension} />
            </div>
          ) : null}
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 z-30 flex items-center gap-2 rounded-md border border-amber-500/25 bg-background/95 px-2.5 py-1.5 text-xs text-amber-700 shadow-sm dark:text-amber-300">
          {state.source === "agent" ? <Bot size={13} aria-hidden /> : <Hand size={13} aria-hidden />}
          <span>{state.source === "agent" ? "Agent applied viewport" : "Your viewport"}</span>
          <Check size={12} aria-hidden />
        </div>
      </div>
    </div>
  );
}

interface VariantProps {
  readonly state: ViewportPrototypeState;
  readonly setState: Dispatch<SetStateAction<ViewportPrototypeState>>;
  readonly applyPreset: (preset: ViewportPreset) => void;
  readonly applyDimension: (axis: keyof ViewportSize, value: number) => void;
  readonly applyResize: (size: ViewportSize) => void;
  readonly reset: () => void;
  readonly compact: boolean;
}

/**
 * Disposable UI prototype for comparing Browser viewport controls and canvas
 * presentation. Activate with `?viewport-prototype=1&variant=A` in development.
 */
export function BrowserViewportPrototype() {
  const [variant, setVariant] = useState(variantFromUrl);
  const [state, setState] = useState<ViewportPrototypeState>(DEFAULT_VIEWPORT);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelWidth = useMeasuredWidth(rootRef);
  const compact = panelWidth > 0 && panelWidth < 560;

  const selectVariant = useCallback((next: string): void => {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("viewport-prototype", "1");
    url.searchParams.set("variant", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const applyPreset = useCallback((preset: ViewportPreset): void => {
    setState((current) => ({
      ...current,
      width: preset.width,
      height: preset.height,
      mode: "responsive",
      source: "user",
      preset: preset.id,
    }));
  }, []);

  const applyDimension = useCallback(
    (axis: keyof ViewportSize, value: number): void => {
      if (!Number.isFinite(value)) return;
      setState((current) => ({
        ...current,
        [axis]: clampDimension(value),
        mode: "responsive",
        source: "user",
        preset: null,
      }));
    },
    [],
  );

  const applyResize = useCallback((size: ViewportSize): void => {
    setState((current) => ({
      ...current,
      ...size,
      source: "user",
      preset: null,
    }));
  }, []);

  const reset = useCallback((): void => {
    setState((current) => ({
      ...current,
      mode: "regular",
      source: "user",
      preset: null,
    }));
  }, []);

  const props = useMemo<VariantProps>(
    () => ({ state, setState, applyPreset, applyDimension, applyResize, reset, compact }),
    [applyDimension, applyPreset, applyResize, compact, reset, state],
  );

  return (
    <div
      ref={rootRef}
      className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="browser-viewport-prototype"
      data-variant={variant}
    >
      {variant === "A" ? <VariantA {...props} /> : null}
      {variant === "B" ? <VariantB {...props} /> : null}
      {variant === "C" ? <VariantC {...props} /> : null}
      <PrototypeSwitcher variants={VARIANTS} current={variant} onSelect={selectVariant} />
    </div>
  );
}
