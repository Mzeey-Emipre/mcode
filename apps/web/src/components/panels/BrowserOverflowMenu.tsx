import { useEffect, useState } from "react";
import {
  Code2,
  EllipsisVertical,
  FileText,
  Plus,
  Smartphone,
  SquareDashedMousePointer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";

/** Props for the browser header's overflow (kebab) menu. */
export interface BrowserOverflowMenuProps {
  /** True once a real page is loaded; gates the page-scoped capture entries. */
  readonly hasLoadedPage: boolean;
  /** Open a new browser page (adds a tab). */
  readonly onNewPage: () => void;
  /** Drag a region on the page and attach it to the chat. */
  readonly onRegionCapture: () => void;
  /** Attach the page's structured content to the chat without a screenshot. */
  readonly onDumpContent: () => void;
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
 * minimal header deliberately omits: New page plus the page-context capture
 * utilities (region crop, page-content dump), and the planned Developer tools
 * and device-toolbar entries shown as disabled "Soon" stubs. Keeps the everyday
 * header to back/forward, the URL, design, and screenshot.
 *
 * While open it suppresses the native Electron BrowserView (which paints above
 * all HTML and would otherwise occlude this menu) via the shared
 * preview-suppression count, mirroring how modal dialogs hide the guest view.
 */
export function BrowserOverflowMenu({
  hasLoadedPage,
  onNewPage,
  onRegionCapture,
  onDumpContent,
}: BrowserOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const increment = usePreviewSuppressionStore((s) => s.increment);
  const decrement = usePreviewSuppressionStore((s) => s.decrement);

  // Hide the guest BrowserView for the menu's open lifetime so the HTML
  // popup paints on top instead of behind the native view.
  useEffect(() => {
    if (!open) return;
    increment();
    return () => decrement();
  }, [open, increment, decrement]);

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
        className="min-w-[200px]"
        data-testid="browser-overflow-menu"
      >
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          onClick={onNewPage}
        >
          <Plus size={14} className="text-muted-foreground" aria-hidden />
          New page
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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
        <DropdownMenuItem
          className="gap-2 px-3 py-1.5 text-xs"
          disabled={!hasLoadedPage}
          onClick={onDumpContent}
        >
          <FileText size={14} className="text-muted-foreground" aria-hidden />
          Dump page content
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
