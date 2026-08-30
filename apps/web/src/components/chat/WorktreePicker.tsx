import { useState } from "react";
import { GitFork, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WorktreeInfo } from "@/transport/types";
import { normalizeWorktreePath, worktreeBranchLabel } from "@/lib/worktree";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";

interface WorktreePickerProps {
  worktrees: WorktreeInfo[];
  selectedPath: string;
  onSelect: (worktree: WorktreeInfo) => void;
  loading: boolean;
  /** Optional trigger styling for compact context rails. */
  triggerClassName?: string;
  /** Primary glyph size for the trigger. */
  iconSize?: number;
}

function worktreeFilter(worktrees: WorktreeInfo[]) {
  return (value: string, search: string): number => {
    const worktree = worktrees.find((candidate) => candidate.path === value);
    if (!worktree) return 0;
    const query = search.toLowerCase();
    return [worktree.name, worktreeBranchLabel(worktree), worktree.path]
      .some((candidate) => candidate.toLowerCase().includes(query))
      ? 1
      : 0;
  };
}

function WorktreePickerContent({
  worktrees,
  normalizedSelected,
  loading,
  onSelect,
  onClose,
}: {
  worktrees: WorktreeInfo[];
  normalizedSelected: string;
  loading: boolean;
  onSelect: (worktree: WorktreeInfo) => void;
  onClose: () => void;
}) {
  if (loading) {
    return <div className="flex items-center justify-center py-4"><Spinner size={16} className="text-muted-foreground" /></div>;
  }
  return (
    <Command filter={worktreeFilter(worktrees)}>
      <CommandInput placeholder="Search worktrees..." />
      <CommandList>
        {worktrees.length === 0 ? <CommandEmpty>No worktrees found in this workspace</CommandEmpty> : (
          <CommandGroup>
            <CommandEmpty>No worktrees match</CommandEmpty>
            {worktrees.map((worktree) => (
              <CommandItem
                key={worktree.path}
                value={worktree.path}
                onSelect={() => {
                  onSelect(worktree);
                  onClose();
                }}
                className={cn(
                  "flex flex-col items-start px-3 py-1.5 text-xs",
                  normalizeWorktreePath(worktree.path) === normalizedSelected
                    ? "bg-accent text-foreground"
                    : "text-popover-foreground",
                )}
              >
                <span className="font-medium">{worktree.name}</span>
                <span className="text-xs text-muted-foreground">
                  {worktreeBranchLabel(worktree)} &middot; {truncatePath(worktree.path)}
                  {!worktree.managed && <Badge variant="secondary" size="sm" className="ml-1">external</Badge>}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

/** Searchable dropdown listing managed worktrees for attaching to an existing one. */
export function WorktreePicker({
  worktrees,
  selectedPath,
  onSelect,
  loading,
  triggerClassName,
  iconSize = 12,
}: WorktreePickerProps) {
  const [open, setOpen] = useState(false);

  const normalizedSelected = normalizeWorktreePath(selectedPath);
  const matched = worktrees.find((w) => normalizeWorktreePath(w.path) === normalizedSelected);
  // When a path is pre-selected but the list hasn't loaded yet, show a spinner
  // rather than "Select worktree" so the user knows something is already chosen.
  const selectedName = matched?.name ?? (loading && selectedPath ? null : "Select worktree");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button variant="ghost" size="xs" className={cn("text-muted-foreground", triggerClassName)}>
          <GitFork size={iconSize} className={triggerClassName ? "size-3.5" : undefined} />
          {selectedName === null ? <Spinner size={11} className="text-current" /> : <span>{selectedName}</span>}
          <ChevronDown size={Math.max(10, iconSize - 2)} className={triggerClassName ? "size-3" : undefined} />
        </Button>
      } />

      <PopoverContent align="end" sideOffset={4} className="w-[300px] p-0">
        <WorktreePickerContent
          worktrees={worktrees}
          normalizedSelected={normalizedSelected}
          loading={loading}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function truncatePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return path;
  return ".../" + parts.slice(-3).join("/");
}

export default WorktreePicker;
