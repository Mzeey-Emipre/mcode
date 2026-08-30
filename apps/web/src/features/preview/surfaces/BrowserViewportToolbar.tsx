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
  type ViewportPreset,
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

interface ViewportPresetMenuProps {
  readonly open: boolean;
  readonly selected: ViewportPreset | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onResponsive: () => void;
  readonly onPreset: (preset: ViewportPreset) => void;
}

function ViewportPresetMenu({ open, selected, onOpenChange, onResponsive, onPreset }: ViewportPresetMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="xs" variant="outline" className="w-32 shrink-0 justify-between gap-1 px-2 @max-[520px]:w-24 @max-[520px]:px-1" aria-label="Viewport preset">
            <span className="truncate">{selected?.label ?? "Responsive"}</span>
            <ChevronDown size={13} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-[210px]">
        <DropdownMenuItem className="w-full justify-between gap-3 text-xs" onClick={onResponsive}>
          <span>Responsive</span>
          {!selected && <Check size={14} aria-hidden />}
        </DropdownMenuItem>
        {VIEWPORT_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.id} className="w-full justify-between gap-3 text-xs" onClick={() => onPreset(preset)}>
            <span className="min-w-0 truncate">{preset.label}</span>
            <span className="shrink-0 font-mono text-muted-foreground">{`${preset.width} × ${preset.height}`}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ViewportDimensionInputsProps {
  readonly width: string;
  readonly height: string;
  readonly onWidthChange: (value: string) => void;
  readonly onHeightChange: (value: string) => void;
  readonly onSubmit: () => void;
}

function ViewportDimensionInputs({ width, height, onWidthChange, onHeightChange, onSubmit }: ViewportDimensionInputsProps) {
  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onSubmit();
  };
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 @max-[520px]:gap-0.5">
      <label className="sr-only" htmlFor="browser-viewport-width">Viewport width</label>
      <Input id="browser-viewport-width" inputMode="numeric" size="xs" value={width} onChange={(event) => onWidthChange(event.target.value)} onKeyDown={submitOnEnter} aria-label="Viewport width" className="h-7 w-14 px-1.5 font-mono text-xs @max-[520px]:w-10 @max-[520px]:px-1" />
      <span className="text-muted-foreground" aria-hidden>×</span>
      <label className="sr-only" htmlFor="browser-viewport-height">Viewport height</label>
      <Input id="browser-viewport-height" inputMode="numeric" size="xs" value={height} onChange={(event) => onHeightChange(event.target.value)} onKeyDown={submitOnEnter} aria-label="Viewport height" className="h-7 w-14 px-1.5 font-mono text-xs @max-[520px]:w-10 @max-[520px]:px-1" />
    </div>
  );
}

interface ViewportPresentationMenuProps {
  readonly open: boolean;
  readonly scaleLabel: string;
  readonly presentation: ViewportPresentation;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPresentation: (presentation: ViewportPresentation) => void;
}

function ViewportPresentationMenu({ open, scaleLabel, presentation, onOpenChange, onPresentation }: ViewportPresentationMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="xs" variant="outline" className="w-16 shrink-0 justify-between gap-1 px-2 @max-[520px]:w-14 @max-[520px]:px-1" aria-label="Viewport scale and presentation">
            {scaleLabel}<ChevronDown size={13} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-[150px]">
        <DropdownMenuItem className="justify-between gap-3 text-xs" onClick={() => onPresentation("fit")}><span>Fit to panel</span>{presentation === "fit" && <Check size={14} aria-hidden />}</DropdownMenuItem>
        <DropdownMenuItem className="justify-between gap-3 text-xs" onClick={() => onPresentation("actual")}><span>Actual size</span>{presentation === "actual" && <Check size={14} aria-hidden />}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {VIEWPORT_ZOOM_PRESETS.map((nextPresentation) => (
          <DropdownMenuItem key={nextPresentation} className="justify-between gap-3 text-xs" onClick={() => onPresentation(nextPresentation)}>
            <span>{nextPresentation}</span>{presentation === nextPresentation && <Check size={14} aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  const selectResponsive = () => {
    setPresetOpen(false);
    setSelectedPresetId(null);
    onUserViewportChange?.();
    void coordinator.requestUserMode("responsive");
  };

  return (
    <div
      data-testid="browser-viewport-toolbar"
      className="@container flex h-11 min-w-0 flex-none items-center gap-1 overflow-hidden border-t border-border/40 bg-background px-2 py-1.5 text-xs @max-[520px]:gap-0.5 @max-[520px]:px-1"
      aria-label="Browser viewport controls"
    >
      <ViewportPresetMenu open={presetOpen} selected={selectedPreset} onOpenChange={setPresetOpen} onResponsive={selectResponsive} onPreset={(preset) => submitSize(preset, preset.id)} />
      <ViewportDimensionInputs width={width} height={height} onWidthChange={setWidth} onHeightChange={setHeight} onSubmit={submitInputs} />

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

      <ViewportPresentationMenu open={scaleOpen} scaleLabel={scaleLabel} presentation={state.presentation} onOpenChange={setScaleOpen} onPresentation={setPresentation} />

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
