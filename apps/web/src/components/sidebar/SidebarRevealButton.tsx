import { useUiStore } from "@/stores/uiStore";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Custom icon showing a vertical rail with a chevron pointing right.
 * Used as the "reveal sidebar" affordance when the sidebar is collapsed.
 * The chevron direction communicates the action: panel slides out from the left.
 */
export function PanelRevealIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 3v10" />
      <path d="M8 5.5l2.5 2.5L8 10.5" />
    </svg>
  );
}

/**
 * Mirrored companion icon: vertical rail on the right with a chevron pointing left.
 * Used inside the expanded sidebar header to collapse the panel.
 */
export function PanelCollapseIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v10" />
      <path d="M8 5.5L5.5 8 8 10.5" />
    </svg>
  );
}

/**
 * Compact inline control rendered inside the chat panel's header when the
 * sidebar is collapsed. Lives as the first child of the header row so it
 * naturally reserves space without colliding with the thread title. The
 * chevron slides outward on hover to telegraph the reveal action.
 */
export function SidebarRevealButton() {
  const expandSidebar = useUiStore((s) => s.expandSidebar);
  if (window.desktopBridge) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={expandSidebar}
        aria-label="Expand sidebar"
        className={cn(
          "group inline-flex size-7 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-[color,transform,background-color]",
          "hover:bg-muted hover:text-foreground",
          "active:translate-y-px",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <PanelRevealIcon className="transition-transform duration-200 group-hover:translate-x-px" />
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        Expand sidebar
      </TooltipContent>
    </Tooltip>
  );
}
