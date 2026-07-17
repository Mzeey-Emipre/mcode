import { useEffect, useRef, useState } from "react";
import { Check, FilePlus2, Goal, ListChecks, Network, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";

interface ComposerAddMenuProps {
  disabled: boolean;
  onAttachFiles: () => void;
  onAttachPlan: () => void;
  planAttached: boolean;
  onAttachGoal: () => void;
  goalAttached: boolean;
  goalAvailable: boolean;
  onAttachOrchestration: () => void;
  orchestrationAttached: boolean;
  orchestrationLabel?: "Ultra" | "Ultracode";
  getComposerRect: () => DOMRect | null;
}

const ADD_MENU_HEIGHT = 256;

/**
 * Compact menu for adding files or attaching capabilities to the composer.
 */
export function ComposerAddMenu({
  disabled,
  onAttachFiles,
  onAttachPlan,
  planAttached,
  onAttachGoal,
  goalAttached,
  goalAvailable,
  onAttachOrchestration,
  orchestrationAttached,
  orchestrationLabel,
  getComposerRect,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      const target = event.target as Element;
      if (triggerRef.current?.contains(target) || target.closest("[data-composer-autocomplete]")) {
        return;
      }
      setOpen(false);
      setAnchorRect(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setAnchorRect(null);
    };

    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      setAnchorRect(null);
      return;
    }
    setAnchorRect(getComposerRect());
    setOpen(true);
  };

  const handleAttachFiles = () => {
    setOpen(false);
    setAnchorRect(null);
    requestAnimationFrame(onAttachFiles);
  };

  const handleAttachPlan = () => {
    setOpen(false);
    setAnchorRect(null);
    requestAnimationFrame(onAttachPlan);
  };

  const handleAttachGoal = () => {
    setOpen(false);
    setAnchorRect(null);
    requestAnimationFrame(onAttachGoal);
  };

  const handleAttachOrchestration = () => {
    setOpen(false);
    setAnchorRect(null);
    requestAnimationFrame(onAttachOrchestration);
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Add to composer"
        title="Add to composer"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="composer-add"
        disabled={disabled}
        onClick={toggleMenu}
        className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
      </Button>
      {open && anchorRect ? (
        <ComposerOverlaySurface
          data-testid="composer-add-menu"
          role="dialog"
          aria-label="Add to composer"
          anchorRect={anchorRect}
          estimatedHeight={ADD_MENU_HEIGHT}
          attached
        >
          <div className="p-1">
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
            <div className="mx-2 my-1 h-px bg-border/60" />
            <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Capabilities</div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAttachPlan}
              disabled={planAttached}
              aria-pressed={planAttached}
              className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70 disabled:bg-accent/45 disabled:opacity-100"
            >
              <ListChecks
                size={15}
                className={
                  planAttached ? "shrink-0 text-primary" : "shrink-0 text-muted-foreground"
                }
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium leading-none text-foreground">Plan</span>
                <span className="text-xs font-normal leading-snug text-muted-foreground">
                  Explore the work and propose a plan
                </span>
              </span>
              {planAttached ? (
                <Check size={14} className="shrink-0 text-primary" aria-hidden />
              ) : null}
            </Button>
            {goalAvailable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAttachGoal}
                disabled={goalAttached}
                aria-pressed={goalAttached}
                className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70 disabled:bg-accent/45 disabled:opacity-100"
              >
                <Goal
                  size={15}
                  className={
                    goalAttached ? "shrink-0 text-primary" : "shrink-0 text-muted-foreground"
                  }
                  aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium leading-none text-foreground">Goal</span>
                  <span className="text-xs font-normal leading-snug text-muted-foreground">
                    Set the objective for the next run
                  </span>
                </span>
                {goalAttached ? (
                  <Check size={14} className="shrink-0 text-primary" aria-hidden />
                ) : null}
              </Button>
            ) : null}
            {orchestrationLabel ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAttachOrchestration}
                disabled={orchestrationAttached}
                aria-pressed={orchestrationAttached}
                className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70 disabled:bg-accent/45 disabled:opacity-100"
              >
                <Network
                  size={15}
                  className={
                    orchestrationAttached
                      ? "shrink-0 text-primary"
                      : "shrink-0 text-muted-foreground"
                  }
                  aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium leading-none text-foreground">
                    {orchestrationLabel}
                  </span>
                  <span className="text-xs font-normal leading-snug text-muted-foreground">
                    Proactively delegate work to sub-agents
                  </span>
                </span>
                {orchestrationAttached ? (
                  <Check size={14} className="shrink-0 text-primary" aria-hidden />
                ) : null}
              </Button>
            ) : null}
          </div>
        </ComposerOverlaySurface>
      ) : null}
    </>
  );
}
