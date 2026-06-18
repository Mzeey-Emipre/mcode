import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Props for {@link Favicon}. */
export interface FaviconProps {
  /** HTTPS favicon image URL. Null renders the fallback. */
  src: string | null;
  /** Accessible image alt text. Use an empty string for decorative favicons. */
  alt?: string;
  /** Optional fallback rendered when no favicon is available or loading fails. */
  fallback?: ReactNode;
  /** Test id for the outer contrast frame. */
  frameTestId?: string;
  /** Test id for the image element. */
  imageTestId?: string;
  /** Additional classes for the outer frame. */
  className?: string;
  /** Additional classes for the image. */
  imageClassName?: string;
}

/**
 * Renders a favicon inside a neutral contrast frame.
 *
 * Transparent monochrome favicons can vanish on either dark or light themes.
 * The neutral frame plus dual halo preserves colored marks while keeping black
 * and white edges visible.
 */
export function Favicon({
  src,
  alt = "",
  fallback = null,
  frameTestId,
  imageTestId,
  className,
  imageClassName,
}: FaviconProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return <>{fallback}</>;

  return (
    <span
      data-testid={frameTestId}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-background/85 ring-1 ring-border/70",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        width={14}
        height={14}
        data-testid={imageTestId}
        onError={() => setFailed(true)}
        className={cn("size-3.5 rounded-[3px]", imageClassName)}
        style={{
          filter:
            "drop-shadow(0 0 1px rgb(255 255 255 / 0.95)) drop-shadow(0 0 1px rgb(0 0 0 / 0.75))",
        }}
      />
    </span>
  );
}
