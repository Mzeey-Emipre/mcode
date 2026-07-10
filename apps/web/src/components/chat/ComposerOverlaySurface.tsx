import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { computeFixedPopupPosition } from "./popup-position";

interface ComposerOverlaySurfaceProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "style"> {
  /** Viewport anchor for the composer overlay. */
  anchorRect: DOMRect;
  /** Height used to keep the overlay inside the viewport. */
  estimatedHeight: number;
  /** Smallest allowed surface width. Defaults to the anchor's width. */
  minWidth?: number;
  /** Optional cap for compact non-composer contexts. */
  maxWidth?: number;
  /** Whether the overlay should join the composer as a context rail. */
  attached?: boolean;
  /** Visual palette used when the overlay appears in a preview annotation. */
  tone?: "default" | "dark";
  /** Additional surface classes for the owning autocomplete. */
  className?: string;
  /** Contents rendered inside the shared surface. */
  children: ReactNode;
}

/** Shared fixed overlay used by the composer autocomplete and attachment surfaces. */
export const ComposerOverlaySurface = forwardRef<HTMLDivElement, ComposerOverlaySurfaceProps>(
  function ComposerOverlaySurface(
    {
      anchorRect,
      estimatedHeight,
      minWidth = 0,
      maxWidth,
      attached = false,
      tone = "default",
      className,
      children,
      ...props
    },
    ref,
  ) {
    const overlayAnchorRect = attached
      ? new DOMRect(
          anchorRect.left + 14,
          anchorRect.top,
          Math.max(anchorRect.width - 28, 0),
          anchorRect.height,
        )
      : anchorRect;
    const style = computeFixedPopupPosition({
      anchorRect: overlayAnchorRect,
      estimatedHeight,
      minWidth,
      maxWidth,
      preferredPlacement: "above",
      gap: attached ? 0 : undefined,
    });

    return createPortal(
      <div
        {...props}
        ref={ref}
        data-composer-autocomplete="true"
        style={style}
        className={cn(
          "composer-autocomplete-surface overflow-hidden animate-composer-popup-enter",
          attached
            ? "rounded-t-xl bg-muted/45 ring-1 ring-inset ring-border/60"
            : "rounded-xl border border-border/70",
          tone === "dark"
            ? "border-white/10 bg-[#1e1e1e] text-neutral-100"
            : attached
              ? "text-popover-foreground"
              : "bg-popover text-popover-foreground",
          className,
        )}
      >
        {children}
      </div>,
      document.body,
    );
  },
);
