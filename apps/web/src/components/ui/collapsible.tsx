"use client"

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

/** Root container that manages open/closed state. */
const Collapsible = CollapsiblePrimitive.Root

/** Button that toggles the collapsible open/closed. Exposes `aria-expanded`. */
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger

/** Content region that is shown/hidden by the trigger. */
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
