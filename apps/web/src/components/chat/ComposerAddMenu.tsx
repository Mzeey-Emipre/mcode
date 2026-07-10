import { useEffect, useRef, useState } from "react";
import { FilePlus2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";

interface ComposerAddMenuProps {
  disabled: boolean;
  onAttachFiles: () => void;
  getComposerRect: () => DOMRect | null;
}

const ADD_MENU_HEIGHT = 96;

/**
 * Compact attachment menu for adding files to the current composer message.
 */
export function ComposerAddMenu({
  disabled,
  onAttachFiles,
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

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Add attachment"
        title="Add attachment"
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
          aria-label="Add attachment"
          anchorRect={anchorRect}
          estimatedHeight={ADD_MENU_HEIGHT}
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
          </div>
        </ComposerOverlaySurface>
      ) : null}
    </>
  );
}
