import { useCallback, useEffect, useState } from "react";
import {
  Code2,
  Cookie,
  EllipsisVertical,
  FileText,
  Minus,
  Plus,
  RotateCw,
  Smartphone,
  SquareDashedMousePointer,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";

/** Step applied per zoom in/out click (10 percentage points). */
const ZOOM_STEP = 0.1;

/** Props for the browser header's overflow (kebab) menu. */
export interface BrowserOverflowMenuProps {
  /** True once a real page is loaded; gates the page-scoped tools. */
  readonly hasLoadedPage: boolean;
  /** Open a new browser page (adds a tab). */
  readonly onNewPage: () => void;
  /** Hard reload that bypasses the guest cache. */
  readonly onForceReload: () => void;
  /** Attach the page's structured content to the chat without a screenshot. */
  readonly onDumpContent: () => void;
  /** Drag a region on the page and attach it to the chat. */
  readonly onRegionCapture: () => void;
  /** Clear the preview session's cookies. */
  readonly onClearCookies: () => void;
  /** Clear the preview session's HTTP cache. */
  readonly onClearCache: () => void;
  /** Read the guest's current zoom factor (1 = 100%). */
  readonly onGetZoom: () => Promise<number>;
  /** Set the guest's zoom factor; resolves to the clamped factor applied. */
  readonly onSetZoom: (factor: number) => Promise<number>;
}

/** "Soon" pill for menu entries that are planned but not yet wired. */
function SoonTag() {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      Soon
    </span>
  );
}

/**
 * Overflow menu for the browser header. Holds the rarely-used tools that the
 * minimal header deliberately omits, in the order set by the right-panel epic:
 * New page, Force reload, Dump page content, Region capture, Developer tools
 * (disabled "Soon" stub), Show device toolbar (disabled "Soon" stub), Zoom,
 * Clear cookies, Clear cache. Keeps the everyday header to back/forward, the
 * URL, design, and screenshot.
 *
 * While open it suppresses the native Electron BrowserView (which paints above
 * all HTML and would otherwise occlude this menu) via the shared
 * preview-suppression count, mirroring how modal dialogs hide the guest view.
 */
export function BrowserOverflowMenu({
  hasLoadedPage,
  onNewPage,
  onForceReload,
  onDumpContent,
  onRegionCapture,
  onClearCookies,
  onClearCache,
  onGetZoom,
  onSetZoom,
}: BrowserOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const increment = usePreviewSuppressionStore((s) => s.increment);
  const decrement = usePreviewSuppressionStore((s) => s.decrement);

  // Hide the guest BrowserView for the menu's open lifetime so the HTML
  // popup paints on top instead of behind the native view.
  useEffect(() => {
    if (!open) return;
    increment();
    return () => decrement();
  }, [open, increment, decrement]);

  // Read the live zoom factor when the menu opens so the readout reflects the
  // guest's actual state (which navigation can reset) rather than a stale value.
  useEffect(() => {
    if (!open || !hasLoadedPage) return;
    let cancelled = false;
    void onGetZoom().then((factor) => {
      if (!cancelled) setZoom(factor);
    });
    return () => {
      cancelled = true;
    };
  }, [open, hasLoadedPage, onGetZoom]);

  const applyZoom = useCallback(
    (factor: number) => {
      void onSetZoom(factor).then(setZoom);
    },
    [onSetZoom],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="More browser tools"
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            <EllipsisVertical size={15} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-[210px]"
        data-testid="browser-overflow-menu"
      >
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          onClick={onNewPage}
        >
          <Plus size={14} className="text-muted-foreground" aria-hidden />
          New page
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onForceReload}
        >
          <RotateCw size={14} className="text-muted-foreground" aria-hidden />
          Force reload
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onDumpContent}
        >
          <FileText size={14} className="text-muted-foreground" aria-hidden />
          Dump page content
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onRegionCapture}
        >
          <SquareDashedMousePointer
            size={14}
            className="text-muted-foreground"
            aria-hidden
          />
          Region capture
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled
          className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
        >
          <span className="flex items-center gap-2">
            <Code2 size={14} className="text-muted-foreground" aria-hidden />
            Developer tools
          </span>
          <SoonTag />
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled
          className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
        >
          <span className="flex items-center gap-2">
            <Smartphone size={14} className="text-muted-foreground" aria-hidden />
            Show device toolbar
          </span>
          <SoonTag />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Zoom is a control row, not a closeable menu item: a plain div keeps
            the popup open so −/+ can be tapped repeatedly without dismissing it,
            and avoids menu-item keyboard semantics fighting the nested buttons. */}
        <div
          className={cn(
            "flex items-center justify-between px-3 py-1.5 text-xs",
            !hasLoadedPage && "opacity-50",
          )}
        >
          <span className="text-muted-foreground">Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom out"
              disabled={!hasLoadedPage}
              className="size-5"
              onClick={() => applyZoom(zoom - ZOOM_STEP)}
            >
              <Minus size={12} aria-hidden />
            </Button>
            <span className="w-9 text-center tabular-nums" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom in"
              disabled={!hasLoadedPage}
              className="size-5"
              onClick={() => applyZoom(zoom + ZOOM_STEP)}
            >
              <Plus size={12} aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Reset zoom"
              disabled={!hasLoadedPage}
              className="ml-1 size-5"
              onClick={() => applyZoom(1)}
            >
              <RotateCw size={11} aria-hidden />
            </Button>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onClearCookies}
        >
          <Cookie size={14} className="text-muted-foreground" aria-hidden />
          Clear cookies
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onClearCache}
        >
          <Trash2 size={14} className="text-muted-foreground" aria-hidden />
          Clear cache
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
