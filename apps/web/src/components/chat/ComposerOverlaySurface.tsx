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
      tone = "default",
      className,
      children,
      ...props
    },
    ref,
  ) {
    const style = computeFixedPopupPosition({
      anchorRect,
      estimatedHeight,
      minWidth,
      maxWidth,
      preferredPlacement: "above",
    });

    return createPortal(
      <div
        {...props}
        ref={ref}
        data-composer-autocomplete="true"
        style={style}
        className={cn(
          "composer-autocomplete-surface overflow-hidden rounded-xl border border-border/70 animate-composer-popup-enter",
          tone === "dark"
            ? "border-white/10 bg-[#1e1e1e] text-neutral-100"
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
