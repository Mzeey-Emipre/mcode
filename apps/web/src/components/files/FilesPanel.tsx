import { X } from "lucide-react";
import type { ReactNode } from "react";
import {
  ResizableRightPanel,
  type ResizablePanelWidthSource,
} from "@/components/panels/ResizableRightPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Props for the reusable file navigator shell. */
export interface FilesPanelProps {
  title: string;
  count: number;
  ariaLabel: string;
  children: ReactNode;
  controls?: ReactNode;
  className?: string;
  testId?: string;
  onClose?: () => void;
  width?: number;
  minWidth?: number;
  maxWidth?: number | string;
  defaultWidth?: number;
  wideWidth?: number;
  getMaxWidth?: (panel: HTMLDivElement | null) => number;
  onWidthChange?: (width: number, source: ResizablePanelWidthSource) => void;
}

function FilesPanelHeader({ title, count, onClose }: Pick<FilesPanelProps, "title" | "count" | "onClose">) {
  return <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/35 px-3">
    <span className="text-xs font-medium text-foreground/90">{title}</span>
    <Badge variant="ghost" size="sm" className="px-1 font-mono font-normal tabular-nums text-muted-foreground">{count}</Badge>
    {onClose ? <Button type="button" variant="ghost" size="icon-xs" className="ml-auto rounded-md text-muted-foreground" aria-label={`Hide ${title.toLowerCase()}`} onClick={onClose}><X size={13} aria-hidden /></Button> : null}
  </header>;
}

function resolveResizableWidth(width: number | undefined, defaultWidth: number): number {
  return width ?? defaultWidth;
}

function noopWidthChange(): void {
  return undefined;
}

/** Renders a dockable file navigator with optional shared right-panel resizing. */
export function FilesPanel({
  title,
  count,
  ariaLabel,
  children,
  controls,
  className,
  testId = "files-panel",
  onClose,
  width,
  minWidth = 220,
  maxWidth = "100%",
  defaultWidth = 256,
  wideWidth = 480,
  getMaxWidth = () => Number.MAX_SAFE_INTEGER,
  onWidthChange,
}: FilesPanelProps) {
  const resizable = width !== undefined && onWidthChange !== undefined;

  return (
    <ResizableRightPanel
      width={resolveResizableWidth(width, defaultWidth)}
      minWidth={minWidth}
      maxWidth={maxWidth}
      getMaxWidth={getMaxWidth}
      defaultWidth={defaultWidth}
      wideWidth={wideWidth}
      separatorLabel={`Resize ${ariaLabel}`}
      resizeEnabled={resizable}
      onWidthChange={onWidthChange ?? noopWidthChange}
      className={cn("flex min-h-0 shrink-0", className)}
    >
      <aside
        data-testid={testId}
        aria-label={`${ariaLabel} navigator`}
        className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/55 bg-page"
      >
        <FilesPanelHeader title={title} count={count} onClose={onClose} />
        {controls}
        {children}
      </aside>
    </ResizableRightPanel>
  );
}
