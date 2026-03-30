import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NamingMode } from "@mcode/contracts";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export type { NamingMode };

interface NamingModeSelectorProps {
  mode: NamingMode;
  onModeChange: (mode: NamingMode) => void;
}

const NAMING_OPTIONS: Array<{ value: NamingMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "custom", label: "Custom" },
];

/** Toggle between Auto and Custom branch naming for new worktrees. */
export function NamingModeSelector({ mode, onModeChange }: NamingModeSelectorProps) {
  const selected = NAMING_OPTIONS.find((o) => o.value === mode) ?? NAMING_OPTIONS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Branch naming mode"
        className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {selected.label}
        <ChevronDown size={10} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[100px]">
        {NAMING_OPTIONS.map((option) => (
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
            <span className="flex-1 text-left">{option.label}</span>
            {option.value === mode && <Check size={10} className="text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
