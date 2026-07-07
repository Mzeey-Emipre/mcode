import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "flex w-full border border-input bg-input shadow-xs transition-colors file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-8 rounded-lg px-3 py-1 text-sm file:text-sm",
        sm: "h-8 rounded-lg px-3 py-1 text-sm file:text-sm",
        xs: "h-8 rounded-lg px-3 py-1 text-sm file:text-sm",
        md: "h-12 rounded-lg px-3 py-2 text-base file:text-base",
        lg: "h-14 rounded-lg px-4 py-2 text-lg file:text-lg",
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
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants> & {
    ref?: React.Ref<HTMLInputElement>;
  }) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      {...props}
    />
  )
}

export { Input, inputVariants }
