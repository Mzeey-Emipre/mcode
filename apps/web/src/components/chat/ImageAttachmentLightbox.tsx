import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** One slide in the image attachment lightbox. */
export interface ImageLightboxSlide {
  src: string;
  title: string;
}

export interface ImageAttachmentLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slides to show; must be non-empty while `open`. One slide hides carousel chrome. */
  items: ImageLightboxSlide[];
  /** Active slide index when the dialog opens (clamped to `items`). */
  initialIndex?: number;
}

/**
 * Full-viewport image preview with optional carousel (prev/next controls, dots,
 * ArrowLeft / ArrowRight / Home / End). Dimmed scrim, floating close control,
 * tap-away dismiss behind the raster; navigation sits above the dismiss layer.
 */
export const ImageAttachmentLightbox = memo(function ImageAttachmentLightbox({
  open,
  onOpenChange,
  items,
  initialIndex = 0,
}: ImageAttachmentLightboxProps) {
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wasOpen = useRef(false);
  const captionId = useId();
  const liveId = useId();
  const carousel = items.length > 1;

  const clampIndex = useCallback(
    (i: number) =>
      items.length === 0 ? 0 : Math.min(Math.max(0, i), items.length - 1),
    [items.length],
  );

  const safeIndex = clampIndex(activeIndex);
  const current = items[safeIndex] ?? items[0];
  const src = current?.src ?? "";
  const rawTitle = current?.title ?? "";
  const displayTitle = rawTitle.trim() || "Untitled attachment";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setFailed(false);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  /** Set the opening slide once, then preserve it while the tray refreshes. */
  useEffect(() => {
    if (!open || items.length === 0) {
      wasOpen.current = false;
      return;
    }

    setActiveIndex((index) =>
      wasOpen.current ? clampIndex(index) : clampIndex(initialIndex),
    );
    if (!wasOpen.current) setFailed(false);
    wasOpen.current = true;
  }, [clampIndex, initialIndex, items.length, open]);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  /** Capture phase on `document` so shortcuts work even when the portal mounts lazily. */
  useLayoutEffect(() => {
    if (!open || !carousel) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(items.length - 1);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((i) =>
        e.key === "ArrowLeft"
          ? (i - 1 + items.length) % items.length
          : (i + 1) % items.length,
      );
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, carousel, items.length]);

  const liveAnnouncement = useMemo(() => {
    if (!carousel) return `${displayTitle}`;
    return `Slide ${safeIndex + 1} of ${items.length}. ${displayTitle}`;
  }, [carousel, displayTitle, items.length, safeIndex]);

  const goPrev = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (items.length === 0) return;
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    },
    [items.length],
  );

  const goNext = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (items.length === 0) return;
      setActiveIndex((i) => (i + 1) % items.length);
    },
    [items.length],
  );

  const navBtnClass = cn(
    "pointer-events-auto flex size-11 shrink-0 items-center justify-center rounded-full",
    "border border-white/14 bg-black/45 text-white backdrop-blur-md",
    "shadow-lg shadow-black/40 transition-[background-color,border-color,opacity]",
    "hover:bg-black/60 hover:border-white/22",
    "focus-visible:border-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
    "motion-reduce:transition-none",
    "dark:border-white/12 dark:bg-black/55 dark:hover:bg-black/70",
  );

  const closeBtnClass = cn(
    "absolute right-4 top-4 z-[70] flex size-11 items-center justify-center rounded-full",
    "border border-white/14 bg-black/45 text-white backdrop-blur-md",
    "shadow-lg shadow-black/40 transition-[background-color,border-color,opacity]",
    "hover:bg-black/60 hover:border-white/22",
    "focus-visible:border-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
    "motion-reduce:transition-none",
    "dark:border-white/12 dark:bg-black/55 dark:hover:bg-black/70",
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "bg-black/72",
            "motion-reduce:backdrop-blur-none",
            "motion-safe:supports-backdrop-filter:backdrop-blur-[2px]",
            "data-open:duration-200 data-closed:duration-150",
          )}
        />
        <DialogPrimitive.Popup
          data-slot="image-attachment-lightbox-popup"
          className={cn(
            "app-viewport-fixed fixed z-50 flex flex-col bg-transparent p-0 shadow-none ring-0 outline-none",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
          )}
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
            <span id={liveId} className="sr-only" aria-live="polite" aria-atomic="true">
              {open && items.length > 0 ? liveAnnouncement : ""}
            </span>

            <DialogTitle className="sr-only">
              {carousel
                ? `Image ${safeIndex + 1} of ${items.length}: ${displayTitle}`
                : `Image preview: ${displayTitle}`}
            </DialogTitle>

            <DialogClose
              render={
                <button type="button" className={closeBtnClass} aria-label="Close image preview" />
              }
            >
              <XIcon className="size-[18px]" strokeWidth={2.25} aria-hidden />
            </DialogClose>

            <div
              className="relative flex min-h-0 flex-1 flex-col pt-14"
              data-testid="image-attachment-lightbox"
            >
              {open && items.length > 0 ? (
                <>
                  <button
                    type="button"
                    className={cn(
                      "absolute inset-0 z-0 cursor-pointer border-0 bg-transparent outline-none",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25",
                    )}
                    aria-label="Dismiss preview"
                    aria-describedby={`${captionId} ${liveId}`}
                    onClick={() => handleOpenChange(false)}
                  />

                  <div className="relative z-10 flex min-h-0 flex-1 flex-col pointer-events-none">
                    <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-2 pt-2 sm:px-10">
                      {carousel ? (
                        <>
                          <div className="pointer-events-none absolute inset-y-8 left-2 z-20 flex items-center sm:left-5">
                            <button
                              type="button"
                              className={navBtnClass}
                              aria-label="Previous image"
                              onClick={goPrev}
                            >
                              <ChevronLeft className="size-6" strokeWidth={2} aria-hidden />
                            </button>
                          </div>
                          <div className="pointer-events-none absolute inset-y-8 right-2 z-20 flex items-center sm:right-5">
                            <button
                              type="button"
                              className={navBtnClass}
                              aria-label="Next image"
                              onClick={goNext}
                            >
                              <ChevronRight className="size-6" strokeWidth={2} aria-hidden />
                            </button>
                          </div>
                        </>
                      ) : null}

                      <span className="flex min-h-0 max-h-full w-full min-w-0 flex-1 items-center justify-center">
                        {failed || src.trim() === "" ? (
                          <span className="max-w-[min(280px,90vw)] px-3 text-center text-sm leading-snug text-white/75">
                            Could not load this image. Close the preview or press Escape.
                          </span>
                        ) : (
                          <img
                            src={src}
                            alt={displayTitle}
                            decoding="async"
                            draggable={false}
                            className={cn(
                              "pointer-events-none max-h-[min(82dvh,calc(100vh-11rem))] max-w-[min(94vw,calc(100vw-2rem))]",
                              "h-auto w-auto object-contain select-none",
                              "rounded-[3px]",
                              "shadow-[0_28px_90px_-20px_rgba(0,0,0,0.85)]",
                              "motion-reduce:shadow-xl motion-reduce:shadow-black/60",
                            )}
                            style={{ imageOrientation: "from-image" }}
                            onError={() => setFailed(true)}
                          />
                        )}
                      </span>
                    </div>

                    <div
                      className="pointer-events-auto relative z-20 mx-auto flex w-full max-w-[min(94vw,42rem)] min-w-0 flex-col items-center gap-2.5 px-4 pb-6 pt-1"
                      id={captionId}
                    >
                      {carousel ? (
                        <div
                          role="group"
                          aria-label={`Image slides, ${String(items.length)} total`}
                          className={cn(
                            "flex max-w-full justify-center gap-x-0.5 gap-y-2 overflow-x-auto px-2 pb-1",
                            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                          )}
                        >
                          {items.map((_, i) => (
                            <button
                              key={i}
                              type="button"
                              aria-label={`Go to image ${String(i + 1)} of ${String(items.length)}`}
                              aria-current={i === safeIndex ? "true" : undefined}
                              className={cn(
                                "flex h-11 min-h-[44px] shrink-0 items-center justify-center px-1",
                                "rounded-full outline-none",
                                "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveIndex(i);
                              }}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "block h-2 bg-white/42 motion-safe:transition-[width,border-radius,background-color] motion-safe:duration-200 motion-safe:ease-out",
                                  i === safeIndex
                                    ? "w-[1.625rem] rounded-sm bg-white/[0.92]"
                                    : "w-2 rounded-full hover:bg-white/62",
                                )}
                              />
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex w-full min-w-0 flex-col items-center gap-1 border-t border-white/[0.08] pt-3 text-center">
                        <p
                          className="line-clamp-2 max-w-full min-w-0 break-words px-1 text-sm font-medium leading-snug tracking-tight text-white/[0.94]"
                          title={rawTitle.trim() ? rawTitle : undefined}
                        >
                          {displayTitle}
                        </p>
                        {carousel ? (
                          <p className="text-xs tabular-nums tracking-wide text-white/48">
                            {safeIndex + 1} / {items.length}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
});

ImageAttachmentLightbox.displayName = "ImageAttachmentLightbox";
