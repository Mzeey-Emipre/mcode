import { useEffect, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  VIEWPORT_PRESETS,
  ViewportCoordinator,
  type ViewportCoordinatorState,
  type ViewportSize,
} from "@/services/browser-automation/viewportCoordinator";

/** Props for the responsive Browser viewport toolbar. */
export interface BrowserViewportToolbarProps {
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly onClose: () => void;
}

function parseDimension(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Compact Variant B toolbar for Regular/Responsive viewport controls. */
export function BrowserViewportToolbar({
  coordinator,
  state,
  onClose,
}: BrowserViewportToolbarProps) {
  const requested = state.pending?.requested ?? state.confirmed;
  const [width, setWidth] = useState(String(requested.width));
  const [height, setHeight] = useState(String(requested.height));

  useEffect(() => {
    setWidth(String(requested.width));
    setHeight(String(requested.height));
  }, [requested.height, requested.width]);

  const submitSize = (size: ViewportSize) => {
    coordinator.setMode("responsive");
    void coordinator.requestUserResize(size);
  };

  const setRegular = () => {
    coordinator.setMode("regular");
    void window.desktopBridge?.preview?.design?.resetViewport();
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

  return (
    <div
      data-testid="browser-viewport-toolbar"
      className="flex min-w-0 flex-none flex-wrap items-center gap-1.5 overflow-hidden border-t border-border/40 bg-background px-2 py-1.5 text-xs"
      aria-label="Browser viewport controls"
    >
      <div className="flex shrink-0 items-center rounded-md border border-border/60 p-0.5">
        <Button
          type="button"
          size="xs"
          variant={state.mode === "regular" ? "secondary" : "ghost"}
          onClick={setRegular}
          aria-pressed={state.mode === "regular"}
        >
          Regular
        </Button>
        <Button
          type="button"
          size="xs"
          variant={state.mode === "responsive" ? "secondary" : "ghost"}
          onClick={() => coordinator.setMode("responsive")}
          aria-pressed={state.mode === "responsive"}
        >
          Responsive
        </Button>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" size="xs" variant="outline" className="shrink-0">
              Presets
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-[170px]">
          {VIEWPORT_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              className="justify-between gap-3 text-xs"
              onClick={() => submitSize(preset)}
            >
              <span>{preset.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex shrink-0 items-center gap-1">
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
          className="w-16 font-mono text-xs"
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
          className="w-16 font-mono text-xs"
        />
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        onClick={() => submitSize({ width: requested.height, height: requested.width })}
        aria-label="Rotate viewport"
        title="Rotate viewport"
      >
        <RotateCw size={14} aria-hidden />
      </Button>
      <div className="flex shrink-0 items-center rounded-md border border-border/60 p-0.5">
        <Button
          type="button"
          size="xs"
          variant={state.presentation === "fit" ? "secondary" : "ghost"}
          onClick={() => coordinator.setPresentation("fit")}
          aria-pressed={state.presentation === "fit"}
        >
          Fit
        </Button>
        <Button
          type="button"
          size="xs"
          variant={state.presentation === "actual" ? "secondary" : "ghost"}
          onClick={() => coordinator.setPresentation("actual")}
          aria-pressed={state.presentation === "actual"}
        >
          Actual
        </Button>
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className={cn("ml-auto shrink-0")}
        onClick={onClose}
        aria-label="Close viewport toolbar"
        title="Close viewport toolbar"
      >
        <X size={14} aria-hidden />
      </Button>
    </div>
  );
}
