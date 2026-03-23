import { useState, useEffect, useRef } from "react";
import { ChevronDown, FolderOpen, GitBranch, GitFork, Check } from "lucide-react";
import { cn } from "@/lib/utils";

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

const BASE_OPTIONS: Array<{ value: ComposerMode; label: string; icon: typeof FolderOpen }> = [
  { value: "direct", label: "Local", icon: FolderOpen },
  { value: "worktree", label: "New worktree", icon: GitBranch },
];

const ALL_OPTIONS: Array<{ value: ComposerMode; label: string; icon: typeof FolderOpen }> = [
  ...BASE_OPTIONS,
  { value: "existing-worktree", label: "Existing worktree", icon: GitFork },
];

/** Dropdown for choosing how a new thread runs (local, new worktree, existing worktree). */
export function ModeSelector({ mode, onModeChange, locked }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const options = ALL_OPTIONS;
  const selected = options.find((o) => o.value === mode) ?? options[0];
  const Icon = selected.icon;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon size={11} />
        {selected.label}
        <ChevronDown size={9} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.value}
                onClick={() => {
                  onModeChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                  option.value === mode
                    ? "bg-accent text-foreground"
                    : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <OptionIcon size={12} />
                <span className="flex-1 text-left">{option.label}</span>
                {option.value === mode && <Check size={10} className="text-muted-foreground" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
