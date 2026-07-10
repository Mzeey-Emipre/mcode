import { useState } from "react";
import { FilePlus2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface ComposerAddMenuProps {
  disabled: boolean;
  onAttachFiles: () => void;
}

/**
 * Compact attachment menu for adding files to the current composer message.
 */
export function ComposerAddMenu({
  disabled,
  onAttachFiles,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);

  const handleAttachFiles = () => {
    setOpen(false);
    requestAnimationFrame(onAttachFiles);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Add attachment"
        title="Add attachment"
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
        className="w-64 max-w-[calc(100vw-2rem)] border-border/70 p-1.5 shadow-none animate-composer-popup-enter"
      >
        <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Attach</div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAttachFiles}
          className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70"
        >
          <FilePlus2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium leading-none text-foreground">Files</span>
            <span className="text-xs font-normal leading-snug text-muted-foreground">
              Images, PDFs, documents, and code
            </span>
          </span>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
