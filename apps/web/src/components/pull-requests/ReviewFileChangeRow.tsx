import type { ReviewFileChange } from "@mcode/contracts";
import type { KeyboardEvent, Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";

const changeLabels: Record<ReviewFileChange["changeType"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
};

const changeGlyphs: Record<ReviewFileChange["changeType"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

function changeTone(changeType: ReviewFileChange["changeType"]): string {
  if (changeType === "added") return "text-[var(--diff-add-strong)]";
  if (changeType === "deleted") return "text-[var(--diff-remove-strong)]";
  return "text-muted-foreground/70";
}

interface ReviewFileChangeRowProps {
  file: ReviewFileChange;
  active: boolean;
  depth: number;
  positionInSet: number;
  setSize: number;
  tabIndex: 0 | -1;
  buttonRef?: Ref<HTMLButtonElement>;
  onActivate: (path: string) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Dense status and path row for one local Review comparison file. */
export function ReviewFileChangeRow({
  file,
  active,
  depth,
  positionInSet,
  setSize,
  tabIndex,
  buttonRef,
  onActivate,
  onFocus,
  onKeyDown,
}: ReviewFileChangeRowProps) {
  const pathLabel = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  return (
    <Button
      ref={buttonRef}
      type="button"
      role="treeitem"
      variant="ghost"
      size="sm"
      tabIndex={tabIndex}
      aria-label={`${changeLabels[file.changeType]} ${pathLabel}${file.binary ? ", Binary" : ""}`}
      aria-level={depth}
      aria-posinset={positionInSet}
      aria-setsize={setSize}
      aria-selected={active}
      title={pathLabel}
      className={cn(
        "relative mx-1 h-8 w-[calc(100%-0.5rem)] justify-start gap-1.5 rounded-md px-2 font-normal",
        active ? "bg-muted/70 text-foreground" : "text-foreground/75 hover:bg-muted/40",
      )}
      style={{ paddingLeft: `${Math.max(8, depth * 12 - 4)}px` }}
      onClick={() => onActivate(file.path)}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        <FileTypeIcon filePath={file.path} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">{pathLabel}</span>
      {file.binary ? (
        <Badge variant="ghost" size="sm" className="max-w-20 px-1 font-mono uppercase tracking-wide">
          Binary
        </Badge>
      ) : null}
      <span
        data-change-type={file.changeType}
        title={changeLabels[file.changeType]}
        aria-hidden
        className={cn("w-3 shrink-0 text-center font-mono text-xs font-medium", changeTone(file.changeType))}
      >
        {changeGlyphs[file.changeType]}
      </span>
    </Button>
  );
}
