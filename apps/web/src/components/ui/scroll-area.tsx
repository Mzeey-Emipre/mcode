import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

/** Renders a scrollable viewport with optional scrollbars. */
function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  viewportProps,
  horizontalScrollbar = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** Ref forwarded to the scrollable viewport element. */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Optional classes for the actual scrollable viewport. */
  viewportClassName?: string;
  /** Optional semantics and event handlers applied to the scrollable viewport. */
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "className" | "ref">;
  /** Whether to render a horizontal scrollbar below the viewport. */
  horizontalScrollbar?: boolean;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", horizontalScrollbar && "flex flex-col", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...viewportProps}
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          horizontalScrollbar ? "min-h-0 flex-1" : "size-full",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {horizontalScrollbar ? (
        <ScrollBar
          orientation="horizontal"
          className="w-full shrink-0"
          style={{ position: "relative", bottom: undefined, insetInlineEnd: undefined, insetInlineStart: undefined }}
        />
      ) : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

/** Renders a scrollbar for a ScrollArea viewport. */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
