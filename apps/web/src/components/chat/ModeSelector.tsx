import { FolderOpen, GitBranch, GitFork, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * How the user wants to run the next thread.
 * - "direct": run in the workspace directory
 * - "worktree": create a new git worktree
 * - "existing-worktree": attach to an already-created worktree
 */
export type ComposerMode = "direct" | "worktree" | "existing-worktree";

interface ModeSelectorProps {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  locked: boolean;
}

const MODE_OPTIONS: Array<{ value: ComposerMode; label: string; icon: typeof FolderOpen }> = [
  { value: "direct", label: "Local", icon: FolderOpen },
  { value: "worktree", label: "New worktree", icon: GitBranch },
  { value: "existing-worktree", label: "Existing worktree", icon: GitFork },
];

/** Dropdown for choosing how a new thread runs (local, new worktree, existing worktree). */
export function ModeSelector({ mode, onModeChange, locked }: ModeSelectorProps) {
  const selected = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0];
  const Icon = selected.icon;

  if (locked) {
    const lockedLabel =
      mode === "worktree" || mode === "existing-worktree" ? "Worktree" : "Local";
    return (
      <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70">
        <Icon size={11} />
        {lockedLabel}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon size={11} />
        {selected.label}
        <ChevronDown size={9} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[160px]">
        {MODE_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onModeChange(option.value)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-xs",
                option.value === mode
                  ? "bg-accent text-foreground"
                  : "text-popover-foreground",
              )}
            >
              <OptionIcon size={12} />
              <span className="flex-1 text-left">{option.label}</span>
              {option.value === mode && <Check size={10} className="text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
