import { useState } from "react";
import { AtSign, FilePlus2, ListChecks, Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

interface ComposerAddMenuProps {
  disabled: boolean;
  planActive: boolean;
  supportsGoals: boolean;
  onAttachFiles: () => void;
  onInsertGoal: () => void;
  onTogglePlan: () => void;
  onMention: () => void;
}

interface AddActionProps {
  icon: typeof FilePlus2;
  label: string;
  detail: string;
  onSelect: () => void;
}

function AddAction({ icon: Icon, label, detail, onSelect }: AddActionProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className="h-auto w-full justify-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/70"
    >
      <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-none text-foreground">{label}</span>
        <span className="text-xs font-normal leading-snug text-muted-foreground">{detail}</span>
      </span>
    </Button>
  );
}

/**
 * Compact composer menu for adding attachments, changing intent, and opening
 * the existing mention search without introducing a permanent toolbar.
 */
export function ComposerAddMenu({
  disabled,
  planActive,
  supportsGoals,
  onAttachFiles,
  onInsertGoal,
  onTogglePlan,
  onMention,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);

  const select = (action: () => void) => {
    setOpen(false);
    requestAnimationFrame(action);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Add to message"
        title="Add"
        data-testid="composer-add"
        disabled={disabled}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground data-[popup-open]:bg-muted/40 data-[popup-open]:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        data-testid="composer-add-menu"
        className="w-[22rem] max-w-[calc(100vw-2rem)] border-border/70 p-1.5 shadow-none animate-composer-popup-enter"
      >
        <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Add</div>
        <AddAction
          icon={FilePlus2}
          label="Files"
          detail="Attach documents and images"
          onSelect={() => select(onAttachFiles)}
        />
        {supportsGoals ? (
          <AddAction
            icon={Target}
            label="Goal"
            detail="Set a goal to keep pursuing"
            onSelect={() => select(onInsertGoal)}
          />
        ) : null}
        <AddAction
          icon={ListChecks}
          label={planActive ? "Build mode" : "Plan mode"}
          detail={planActive ? "Turn plan mode off" : "Turn plan mode on"}
          onSelect={() => select(onTogglePlan)}
        />
        <Separator className="my-1" />
        <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Agents</div>
        <AddAction
          icon={AtSign}
          label="Mention an agent or file"
          detail="Search available context with @"
          onSelect={() => select(onMention)}
        />
      </PopoverContent>
    </Popover>
  );
}
