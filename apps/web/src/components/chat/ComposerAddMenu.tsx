import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, FilePlus2, Goal, ListChecks, Network, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";
import type {
  ComposerCapabilityId,
  ResolvedComposerCapability,
} from "@/features/conversation/composer/composer-capabilities";

interface ComposerAddMenuProps {
  disabled: boolean;
  onAttachFiles: () => void;
  capabilities: readonly ResolvedComposerCapability[];
  attachedCapabilityIds: ReadonlySet<ComposerCapabilityId>;
  onAttachCapability: (capabilityId: ComposerCapabilityId) => void;
  getComposerRect: () => DOMRect | null;
}

const ADD_MENU_HEIGHT = 256;

const CAPABILITY_ICONS = {
  plan: ListChecks,
  goal: Goal,
  orchestration: Network,
} satisfies Record<ComposerCapabilityId, typeof ListChecks>;

interface ComposerAddMenuLabelProps {
  title: string;
  description: string;
}

function ComposerAddMenuLabel({ title, description }: ComposerAddMenuLabelProps) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
      <span className="shrink-0 text-sm font-medium leading-none text-foreground">{title}</span>
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-xs font-normal leading-none text-muted-foreground"
        style={{
          maskImage: "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
        }}
      >
        {description}
      </span>
    </span>
  );
}

/**
 * Compact menu for adding files or attaching capabilities to the composer.
 */
export function ComposerAddMenu({
  disabled,
  onAttachFiles,
  capabilities,
  attachedCapabilityIds,
  onAttachCapability,
  getComposerRect,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !anchorRect) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorRect, open]);

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

  const handleAttachCapability = (capabilityId: ComposerCapabilityId) => {
    setOpen(false);
    setAnchorRect(null);
    requestAnimationFrame(() => onAttachCapability(capabilityId));
  };

  const handleMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menuRef.current || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (buttons.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (Math.max(currentIndex, -1) + 1) % buttons.length
            : (currentIndex <= 0 ? buttons.length : currentIndex) - 1;
    buttons[nextIndex]?.focus();
  }, []);

  const addButton = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Add to composer"
      aria-expanded={open}
      aria-haspopup="menu"
      data-testid="composer-add"
      disabled={disabled}
      onClick={toggleMenu}
      className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Plus size={16} aria-hidden />
    </Button>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={disabled ? <span className="inline-flex">{addButton}</span> : addButton}
        />
        <TooltipContent>Add to composer</TooltipContent>
      </Tooltip>
      {open && anchorRect ? (
        <ComposerOverlaySurface
          data-testid="composer-add-menu"
          role="menu"
          aria-label="Add to composer"
          anchorRect={anchorRect}
          estimatedHeight={ADD_MENU_HEIGHT}
          attached
        >
          <div ref={menuRef} className="p-1" onKeyDown={handleMenuKeyDown}>
            <div
              role="presentation"
              className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground"
            >
              Attach
            </div>
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              onClick={handleAttachFiles}
              className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70"
            >
              <FilePlus2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              <ComposerAddMenuLabel
                title="Files"
                description="Images, PDFs, documents, and code"
              />
            </Button>
            {capabilities.length > 0 ? (
              <>
                <div role="separator" className="mx-2 my-1 h-px bg-border/60" />
                <div
                  role="presentation"
                  className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground"
                >
                  Capabilities
                </div>
                {capabilities.map((capability) => {
                  const Icon = CAPABILITY_ICONS[capability.id];
                  const attached = attachedCapabilityIds.has(capability.id);
                  return (
                    <Button
                      key={capability.id}
                      type="button"
                      role="menuitemcheckbox"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAttachCapability(capability.id)}
                      disabled={attached}
                      aria-checked={attached}
                      className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/70 disabled:bg-accent/45 disabled:opacity-100"
                    >
                      <Icon
                        size={15}
                        className={
                          attached ? "shrink-0 text-primary" : "shrink-0 text-muted-foreground"
                        }
                        aria-hidden
                      />
                      <ComposerAddMenuLabel
                        title={capability.label}
                        description={capability.description}
                      />
                      {attached ? (
                        <Check size={14} className="shrink-0 text-primary" aria-hidden />
                      ) : null}
                    </Button>
                  );
                })}
              </>
            ) : null}
          </div>
        </ComposerOverlaySurface>
      ) : null}
    </>
  );
}
