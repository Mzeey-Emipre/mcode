"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** Renders collision-aware popover content in a portal. */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  alignOffset,
  anchor,
  collisionBoundary,
  collisionPadding,
  collisionAvoidance,
  positionMethod,
  side,
  sticky,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionBoundary" | "collisionPadding" | "collisionAvoidance" | "positionMethod" | "side" | "sticky"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        positionMethod={positionMethod}
        side={side}
        sticky={sticky}
        className="pointer-events-none isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "pointer-events-auto w-72 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
