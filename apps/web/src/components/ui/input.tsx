import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "flex w-full border border-input bg-background shadow-xs transition-colors file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-8 rounded-lg px-3 py-1 text-sm file:text-sm",
        sm: "h-7 rounded-[min(var(--radius-md),12px)] px-2 py-0.5 text-xs file:text-xs",
        xs: "h-6 rounded-[min(var(--radius-md),10px)] px-1.5 py-0.5 text-xs file:text-xs",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

/** Text input with size variants for compact contexts. */
function Input({
  className,
  type,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      {...props}
    />
  )
}

export { Input, inputVariants }
