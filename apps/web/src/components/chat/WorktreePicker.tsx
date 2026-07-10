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
          {selectedName === null
            ? <Spinner size={11} className="text-current" />
            : <span>{selectedName}</span>}
          <ChevronDown size={Math.max(10, iconSize - 2)} className={triggerClassName ? "size-3" : undefined} />
        </Button>
      } />

      <PopoverContent align="end" sideOffset={4} className="w-[300px] p-0">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Spinner size={16} className="text-muted-foreground" />
          </div>
        ) : (
          <Command
            filter={(value, search) => {
              const wt = worktrees.find((w) => w.path === value);
              if (!wt) return 0;
              const q = search.toLowerCase();
              const branchLabel = worktreeBranchLabel(wt);
              if (wt.name.toLowerCase().includes(q)) return 1;
              if (branchLabel.toLowerCase().includes(q)) return 1;
              if (wt.path.toLowerCase().includes(q)) return 1;
              return 0;
            }}
          >
            <CommandInput placeholder="Search worktrees..." />
            <CommandList>
              {worktrees.length === 0 ? (
                <CommandEmpty>No worktrees found in this workspace</CommandEmpty>
              ) : (
                <CommandGroup>
                  <CommandEmpty>No worktrees match</CommandEmpty>
                  {worktrees.map((w) => (
                    <CommandItem
                      key={w.path}
                      value={w.path}
                      onSelect={() => {
                        onSelect(w);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex flex-col items-start px-3 py-1.5 text-xs",
                        normalizeWorktreePath(w.path) === normalizedSelected
                          ? "bg-accent text-foreground"
                          : "text-popover-foreground",
                      )}
                    >
                      <span className="font-medium">{w.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {worktreeBranchLabel(w)} &middot; {truncatePath(w.path)}
                        {!w.managed && (
                          <Badge variant="secondary" size="sm" className="ml-1">external</Badge>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
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
