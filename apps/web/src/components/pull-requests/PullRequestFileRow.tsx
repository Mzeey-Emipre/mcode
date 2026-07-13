import type { PullRequestFile } from "@mcode/contracts";
import type { KeyboardEvent, Ref } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
      title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
      className={cn(
        "relative h-8 w-full justify-start gap-1.5 rounded-none px-2 font-normal",
        active
          ? "bg-primary/9 text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
          : "text-foreground/75 hover:bg-muted/45",
      )}
      style={{ paddingLeft: `${Math.max(8, depth * 12)}px` }}
      onClick={() => onActivate(file.path)}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[10px] font-semibold",
          file.changeType === "added" && "text-primary",
          file.changeType === "deleted" && "text-destructive/80",
          file.changeType !== "added" &&
            file.changeType !== "deleted" &&
            "text-muted-foreground",
        )}
      >
        {changeGlyphs[file.changeType]}
      </span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px]">
        {file.path.split("/").at(-1)}
      </span>
      {patchLabel && (
        <Badge
          variant={file.patchStatus === "too_large" ? "destructive" : "ghost"}
          size="sm"
          className="max-w-20 px-1 font-mono text-[9px] uppercase tracking-wide"
        >
          {patchLabel}
        </Badge>
      )}
      <span
        aria-label={`${file.additions} additions and ${file.deletions} deletions`}
        className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/75"
      >
        <span className="text-primary/80">+{file.additions}</span>{" "}
        <span className="text-destructive/70">−{file.deletions}</span>
      </span>
    </Button>
  );
}
