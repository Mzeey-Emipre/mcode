import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ComposerCapabilityChipProps {
  /** Stable label shown for the attached composer capability. */
  label: string;
  /** Icon that identifies the capability in the compact composer row. */
  icon: LucideIcon;
  /** Accessible explanation for removing the attached capability. */
  removeLabel: string;
  /** Removes or clears the attached capability. */
  onRemove: () => void;
  /** Optional stable selector for focused UI verification. */
  testId?: string;
}

/** Renders an attached composer capability as a compact removable chip. */
export function ComposerCapabilityChip({
  label,
  icon: Icon,
  removeLabel,
  onRemove,
  testId,
}: ComposerCapabilityChipProps) {
  return (
    <span
      data-testid={testId}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent/70 pl-2.5 text-xs font-semibold text-foreground ring-1 ring-inset ring-primary/30"
    >
      <Icon size={14} className="text-primary" aria-hidden />
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onRemove}
              aria-label={removeLabel}
              className="rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X size={13} aria-hidden />
            </Button>
          }
        />
        <TooltipContent>{removeLabel}</TooltipContent>
      </Tooltip>
    </span>
  );
}
