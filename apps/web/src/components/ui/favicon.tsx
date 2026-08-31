import { useState, type ReactNode } from "react";

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
  /**
   * When true (default), wraps the image in a neutral contrast frame and adds
   * the dual-halo shadow. Set false for marks that carry their own theming
   * (e.g. a monochrome GitHub mark) so they read bare and inline.
   */
  framed?: boolean;
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
  ...props
}: FaviconProps) {
  if (!src) return <>{props.fallback}</>;

  return <FaviconImage key={src} src={src} {...props} />;
}

function FaviconImage({
  src,
  alt = "",
  fallback = null,
  frameTestId,
  imageTestId,
  className,
  imageClassName,
  framed = true,
}: Omit<FaviconProps, "src"> & { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <>{fallback}</>;

  return (
    <span
      data-testid={frameTestId}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]",
        framed && "bg-background/85 ring-1 ring-border/70",
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
        className={cn("size-3.5 rounded-[3px]", framed && "favicon-image-shadow", imageClassName)}
      />
    </span>
  );
}

/** The favicon URL GitHub serves; used to switch to the bare themed mark. */
const GITHUB_FAVICON_URL = "https://github.com/favicon.ico";

/** Props for {@link SiteFavicon}. */
export interface SiteFaviconProps {
  /** HTTPS favicon URL, or null to render the fallback. */
  src: string | null;
  /** Fallback rendered when no favicon is available or loading fails. */
  fallback?: ReactNode;
  /** Test id for the outer frame. */
  frameTestId?: string;
  /** Test id for the image element. */
  imageTestId?: string;
}

/**
 * Renders a site favicon at link scale with one shared treatment: the GitHub
 * mark drops the contrast frame and themes to the foreground (white on dark),
 * every other favicon keeps the small contrast frame. Used by the Overview
 * repository row and inline Markdown links so both render links identically.
 */
export function SiteFavicon({ src, fallback = null, frameTestId, imageTestId }: SiteFaviconProps) {
  const isGitHub = src === GITHUB_FAVICON_URL;

  return (
    <Favicon
      src={src}
      fallback={fallback}
      framed={!isGitHub}
      frameTestId={frameTestId}
      imageTestId={imageTestId}
      className="size-3.5 rounded-[3px]"
      imageClassName={cn(
        "size-3 rounded-[2px]",
        isGitHub && "size-3.5 rounded-none github-favicon-mark",
      )}
    />
  );
}
