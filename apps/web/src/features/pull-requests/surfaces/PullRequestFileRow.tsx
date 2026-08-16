import type { PullRequestFile } from "@mcode/contracts";
import type { KeyboardEvent, Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";

const changeLabels: Record<PullRequestFile["changeType"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  changed: "Changed",
  unchanged: "Unchanged",
};

const changeGlyphs: Record<PullRequestFile["changeType"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  changed: "M",
  unchanged: "·",
};

const patchLabels: Partial<Record<PullRequestFile["patchStatus"], string>> = {
  binary: "Binary",
  generated: "Generated",
  unavailable: "Unavailable",
  too_large: "Too large",
};

function changeTone(changeType: PullRequestFile["changeType"]): string {
  if (changeType === "added") return "text-[var(--diff-add-strong)]";
  if (changeType === "deleted") return "text-[var(--diff-remove-strong)]";
  return "text-muted-foreground/70";
}

/** Props for one accessible file row in the pull request Change stack. */
export interface PullRequestFileRowProps {
  file: PullRequestFile;
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

/** Dense status, path, and line-count row for one changed file. */
export function PullRequestFileRow({
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
}: PullRequestFileRowProps) {
  const patchLabel = patchLabels[file.patchStatus];
  const fullLabel = file.previousPath
    ? `${changeLabels[file.changeType]} ${file.previousPath} to ${file.path}`
    : `${changeLabels[file.changeType]} ${file.path}`;

  return (
    <Button
      ref={buttonRef}
      type="button"
      role="treeitem"
      variant="ghost"
      size="sm"
      tabIndex={tabIndex}
      aria-label={fullLabel}
      aria-level={depth}
      aria-posinset={positionInSet}
      aria-setsize={setSize}
      aria-selected={active}
      data-file-path={file.path}
      title={
        file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
      }
      className={cn(
        "relative mx-1 h-8 w-[calc(100%-0.5rem)] justify-start gap-1.5 rounded-md px-2 font-normal",
        active
          ? "bg-muted/70 text-foreground"
          : "text-foreground/75 hover:bg-muted/40",
      )}
      style={{ paddingLeft: `${Math.max(8, depth * 12 - 4)}px` }}
      onClick={() => onActivate(file.path)}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <span
        data-file-icon="true"
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <FileTypeIcon filePath={file.path} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
        {file.path.split("/").at(-1)}
      </span>
      {patchLabel && (
        <Badge
          variant={file.patchStatus === "too_large" ? "destructive" : "ghost"}
          size="sm"
          className="max-w-20 px-1 font-mono uppercase tracking-wide"
        >
          {patchLabel}
        </Badge>
      )}
      <span
        data-change-type={file.changeType}
        title={changeLabels[file.changeType]}
        aria-hidden
        className={cn(
          "w-3 shrink-0 text-center font-mono text-xs font-medium",
          changeTone(file.changeType),
        )}
      >
        {changeGlyphs[file.changeType]}
      </span>
      {file.additions > 0 ? (
        <span
          aria-label={`${file.additions} additions`}
          className="shrink-0 font-mono text-xs tabular-nums text-[var(--diff-add-strong)]"
        >
          +{file.additions}
        </span>
      ) : null}
      {file.deletions > 0 ? (
        <span
          aria-label={`${file.deletions} deletions`}
          className="shrink-0 font-mono text-xs tabular-nums text-[var(--diff-remove-strong)]"
        >
          −{file.deletions}
        </span>
      ) : null}
    </Button>
  );
}
