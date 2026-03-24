import { useState } from "react";
import { GitFork, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorktreeInfo } from "@/transport/types";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";

interface WorktreePickerProps {
  worktrees: WorktreeInfo[];
  selectedPath: string;
  onSelect: (worktree: WorktreeInfo) => void;
  loading: boolean;
}

/** Searchable dropdown listing managed worktrees for attaching to an existing one. */
export function WorktreePicker({
  worktrees,
  selectedPath,
  onSelect,
  loading,
}: WorktreePickerProps) {
  const [open, setOpen] = useState(false);

  const selectedName =
    worktrees.find((w) => w.path === selectedPath)?.name ?? "Select worktree";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <GitFork size={12} />
        <span>{selectedName}</span>
        <ChevronDown size={10} />
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={4} className="w-[300px] p-0">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Command
            filter={(value, search) => {
              const wt = worktrees.find((w) => w.path === value);
              if (!wt) return 0;
              const q = search.toLowerCase();
              if (wt.name.toLowerCase().includes(q)) return 1;
              if (wt.branch.toLowerCase().includes(q)) return 1;
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
                        w.path === selectedPath
                          ? "bg-accent text-foreground"
                          : "text-popover-foreground",
                      )}
                    >
                      <span className="font-medium">{w.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {w.branch} &middot; {truncatePath(w.path)}
                        {!w.managed && (
                          <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] leading-none">
                            external
                          </span>
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
