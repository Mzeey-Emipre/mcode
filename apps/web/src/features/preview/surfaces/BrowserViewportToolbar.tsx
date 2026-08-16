import { useEffect, useState } from "react";
import { Check, ChevronDown, RotateCw, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  clampViewportSize,
  VIEWPORT_PRESETS,
  ViewportCoordinator,
  type ViewportCoordinatorState,
  type ViewportPresentation,
  type ViewportSize,
} from "../automation/services/viewportCoordinator";

const VIEWPORT_ZOOM_PRESETS = ["50%", "75%", "100%", "125%", "150%", "200%"] as const;

/** Props for the responsive Browser viewport toolbar. */
export interface BrowserViewportToolbarProps {
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly onClose: () => void;
  readonly onUserViewportChange?: () => void;
  readonly scale?: number;
}

function parseDimension(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameSize(left: ViewportSize, right: ViewportSize): boolean {
  return left.width === right.width && left.height === right.height;
}

/** Compact Variant B toolbar for responsive viewport controls. */
export function BrowserViewportToolbar({
  coordinator,
  state,
  onClose,
  onUserViewportChange,
  scale = 1,
}: BrowserViewportToolbarProps) {
  const requested = state.pending?.requested ?? state.confirmed;
  const [width, setWidth] = useState(String(requested.width));
  const [height, setHeight] = useState(String(requested.height));
  const [presetOpen, setPresetOpen] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  useEffect(() => {
    setWidth(String(requested.width));
    setHeight(String(requested.height));
  }, [requested.height, requested.width]);

  const selectedPreset = state.mode === "responsive"
    ? VIEWPORT_PRESETS.find((preset) => preset.id === selectedPresetId && sameSize(preset, requested))
    : undefined;
  const isLandscape = state.mode === "responsive" && requested.width > requested.height;
  const scaleLabel = `${Math.round(scale * 100)}%`;

  const submitSize = (size: ViewportSize, presetId: string | null = null) => {
    setPresetOpen(false);
    setSelectedPresetId(presetId);
    onUserViewportChange?.();
    coordinator.setUserMode("responsive");
    void coordinator.requestUserResize(clampViewportSize(size));
  };

  const submitInputs = () => {
    const nextWidth = parseDimension(width);
    const nextHeight = parseDimension(height);
    if (nextWidth === null || nextHeight === null) {
      setWidth(String(requested.width));
      setHeight(String(requested.height));
      return;
    }
    submitSize({ width: nextWidth, height: nextHeight });
  };

  const setPresentation = (presentation: ViewportPresentation) => {
    setScaleOpen(false);
    onUserViewportChange?.();
    void coordinator.setPresentation(presentation);
  };

  return (
    <div
      data-testid="browser-viewport-toolbar"
      className="@container flex h-11 min-w-0 flex-none items-center gap-1 overflow-hidden border-t border-border/40 bg-background px-2 py-1.5 text-xs @max-[520px]:gap-0.5 @max-[520px]:px-1"
      aria-label="Browser viewport controls"
    >
      <DropdownMenu open={presetOpen} onOpenChange={setPresetOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-32 shrink-0 justify-between gap-1 px-2 @max-[520px]:w-24 @max-[520px]:px-1"
              aria-label="Viewport preset"
            >
              <span className="truncate">{selectedPreset?.label ?? "Responsive"}</span>
              <ChevronDown size={13} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-[210px]">
          <DropdownMenuItem
            className="w-full justify-between gap-3 text-xs"
            onClick={() => {
              setPresetOpen(false);
              setSelectedPresetId(null);
              onUserViewportChange?.();
              void coordinator.requestUserMode("responsive");
            }}
          >
            <span>Responsive</span>
            {!selectedPreset && <Check size={14} aria-hidden />}
          </DropdownMenuItem>
          {VIEWPORT_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              className="w-full justify-between gap-3 text-xs"
              onClick={() => submitSize(preset, preset.id)}
            >
              <span className="min-w-0 truncate">{preset.label}</span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {`${preset.width} × ${preset.height}`}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex min-w-0 shrink-0 items-center gap-1 @max-[520px]:gap-0.5">
        <label className="sr-only" htmlFor="browser-viewport-width">Viewport width</label>
        <Input
          id="browser-viewport-width"
          inputMode="numeric"
          size="xs"
          value={width}
          onChange={(event) => setWidth(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitInputs();
          }}
          aria-label="Viewport width"
          className="h-7 w-14 px-1.5 font-mono text-xs @max-[520px]:w-10 @max-[520px]:px-1"
        />
        <span className="text-muted-foreground" aria-hidden>×</span>
        <label className="sr-only" htmlFor="browser-viewport-height">Viewport height</label>
        <Input
          id="browser-viewport-height"
          inputMode="numeric"
          size="xs"
          value={height}
          onChange={(event) => setHeight(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitInputs();
          }}
          aria-label="Viewport height"
          className="h-7 w-14 px-1.5 font-mono text-xs @max-[520px]:w-10 @max-[520px]:px-1"
        />
      </div>

      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="@max-[520px]:size-7"
        onClick={() => submitSize({ width: requested.height, height: requested.width })}
        aria-label={isLandscape ? "Rotate viewport to portrait" : "Rotate viewport to landscape"}
        title={isLandscape ? "Rotate viewport to portrait" : "Rotate viewport to landscape"}
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <Smartphone className={cn("size-3.5 transition-transform", isLandscape && "rotate-90")} aria-hidden />
          <RotateCw className="absolute -right-1 -bottom-1 size-2.5" aria-hidden />
        </span>
      </Button>

      <DropdownMenu open={scaleOpen} onOpenChange={setScaleOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-16 shrink-0 justify-between gap-1 px-2 @max-[520px]:w-14 @max-[520px]:px-1"
              aria-label="Viewport scale and presentation"
            >
              {scaleLabel}
              <ChevronDown size={13} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-[150px]">
          <DropdownMenuItem
            className="justify-between gap-3 text-xs"
            onClick={() => setPresentation("fit")}
          >
            <span>Fit to panel</span>
            {state.presentation === "fit" && <Check size={14} aria-hidden />}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="justify-between gap-3 text-xs"
            onClick={() => setPresentation("actual")}
          >
            <span>Actual size</span>
            {state.presentation === "actual" && <Check size={14} aria-hidden />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {VIEWPORT_ZOOM_PRESETS.map((presentation) => (
            <DropdownMenuItem
              key={presentation}
              className="justify-between gap-3 text-xs"
              onClick={() => setPresentation(presentation)}
            >
              <span>{presentation}</span>
              {state.presentation === presentation && <Check size={14} aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="ml-auto shrink-0 @max-[520px]:size-7"
        onClick={() => {
          onUserViewportChange?.();
          onClose();
        }}
        aria-label="Close viewport toolbar"
        title="Close viewport toolbar"
      >
        <X size={14} aria-hidden />
      </Button>
    </div>
  );
}
