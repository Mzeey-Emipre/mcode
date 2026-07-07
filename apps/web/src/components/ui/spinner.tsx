import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type SpinnerSize = "xs" | "sm" | "md" | "lg";

const SPINNER_SIZE_PX: Record<SpinnerSize, number> = {
  xs: 10,
  sm: 13,
  md: 16,
  lg: 20,
};

type SpinnerStyle = CSSProperties & {
  "--spinner-size"?: string;
};

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize | number;
}

/** Renders the shared faded-tail loading spinner used across the app. */
function Spinner({ size = "sm", className, style, "aria-label": ariaLabel, ...props }: SpinnerProps) {
  const pixelSize = typeof size === "number" ? size : SPINNER_SIZE_PX[size];
  const spinnerStyle: SpinnerStyle = {
    "--spinner-size": `${pixelSize}px`,
    ...style,
  };

  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      className={cn("spinner-tail-fade status-spin shrink-0", className)}
      style={spinnerStyle}
      {...props}
    />
  );
}

export { Spinner };
