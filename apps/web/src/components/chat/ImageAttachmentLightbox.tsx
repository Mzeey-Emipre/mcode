import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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

function clampLightboxIndex(index: number, itemCount: number): number {
  if (itemCount === 0) return 0;
  return Math.min(Math.max(0, index), itemCount - 1);
}

function useLightboxActiveIndex(open: boolean, itemsLength: number, initialIndex: number) {
  const [activeIndex, setActiveIndex] = useState(0);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open || itemsLength === 0) {
      wasOpen.current = false;
      return;
    }
    setActiveIndex((index) => wasOpen.current ? clampLightboxIndex(index, itemsLength) : clampLightboxIndex(initialIndex, itemsLength));
    wasOpen.current = true;
  }, [initialIndex, itemsLength, open]);

  return { activeIndex, setActiveIndex };
}

function useLightboxKeyboard(open: boolean, carousel: boolean, itemsLength: number, setActiveIndex: (update: (index: number) => number) => void) {
  useLayoutEffect(() => {
    if (!open || !carousel) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(() => 0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(() => itemsLength - 1);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setActiveIndex((index) => event.key === "ArrowLeft" ? (index - 1 + itemsLength) % itemsLength : (index + 1) % itemsLength);
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, carousel, itemsLength, setActiveIndex]);
}

interface LightboxControls {
  failed: boolean;
  setFailed: (failed: boolean) => void;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  handleOpenChange: (open: boolean) => void;
  goPrev: (event: MouseEvent) => void;
  goNext: (event: MouseEvent) => void;
}

function useLightboxControls(
  open: boolean,
  onOpenChange: (open: boolean) => void,
  items: ImageLightboxSlide[],
  initialIndex: number,
): LightboxControls {
  const [failed, setFailed] = useState(false);
  const { activeIndex, setActiveIndex } = useLightboxActiveIndex(open, items.length, initialIndex);
  const carousel = items.length > 1;
  const activeSource = items[clampLightboxIndex(activeIndex, items.length)]?.src;

  useEffect(() => {
    setFailed(false);
  }, [activeSource]);

  useLightboxKeyboard(open, carousel, items.length, setActiveIndex);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) setFailed(false);
    onOpenChange(next);
  }, [onOpenChange]);
  const goPrev = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    if (items.length > 0) setActiveIndex((index) => (index - 1 + items.length) % items.length);
  }, [items.length, setActiveIndex]);
  const goNext = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    if (items.length > 0) setActiveIndex((index) => (index + 1) % items.length);
  }, [items.length, setActiveIndex]);

  return { failed, setFailed, activeIndex, setActiveIndex, handleOpenChange, goPrev, goNext };
}

function LightboxNavigation({ onPrevious, onNext }: { onPrevious: (event: MouseEvent) => void; onNext: (event: MouseEvent) => void }) {
  const navBtnClass = cn(
    "pointer-events-auto flex size-11 shrink-0 items-center justify-center rounded-full",
    "border border-white/14 bg-black/45 text-white backdrop-blur-md",
    "shadow-lg shadow-black/40 transition-[background-color,border-color,opacity]",
    "hover:bg-black/60 hover:border-white/22",
    "focus-visible:border-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
    "motion-reduce:transition-none",
    "dark:border-white/12 dark:bg-black/55 dark:hover:bg-black/70",
  );
  return (
    <>
      <div className="pointer-events-none absolute inset-y-8 left-2 z-20 flex items-center sm:left-5">
        <button type="button" className={navBtnClass} aria-label="Previous image" onClick={onPrevious}>
          <ChevronLeft className="size-6" strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="pointer-events-none absolute inset-y-8 right-2 z-20 flex items-center sm:right-5">
        <button type="button" className={navBtnClass} aria-label="Next image" onClick={onNext}>
          <ChevronRight className="size-6" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </>
  );
}

function LightboxImage({ failed, src, title, onError }: { failed: boolean; src: string; title: string; onError: () => void }) {
  if (failed || src.trim() === "") {
    return <span className="max-w-[min(280px,90vw)] px-3 text-center text-sm leading-snug text-white/75">Could not load this image. Close the preview or press Escape.</span>;
  }
  return (
    <img
      src={src}
      alt={title}
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
      onError={onError}
    />
  );
}

function LightboxDots({ items, activeIndex, onSelect }: { items: ImageLightboxSlide[]; activeIndex: number; onSelect: (index: number) => void }) {
  return (
    <div role="group" aria-label={`Image slides, ${String(items.length)} total`} className={cn("flex max-w-full justify-center gap-x-0.5 gap-y-2 overflow-x-auto px-2 pb-1", "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}>
      {items.map((_, index) => (
        <button
          key={index}
          type="button"
          aria-label={`Go to image ${String(index + 1)} of ${String(items.length)}`}
          aria-current={index === activeIndex ? "true" : undefined}
          className={cn("flex h-11 min-h-[44px] shrink-0 items-center justify-center px-1", "rounded-full outline-none", "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent")}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(index);
          }}
        >
          <span aria-hidden className={cn("block h-2 bg-white/42 motion-safe:transition-[width,border-radius,background-color] motion-safe:duration-200 motion-safe:ease-out", index === activeIndex ? "w-[1.625rem] rounded-sm bg-white/[0.92]" : "w-2 rounded-full hover:bg-white/62")} />
        </button>
      ))}
    </div>
  );
}

function LightboxCaption({ carousel, items, activeIndex, rawTitle, displayTitle, captionId, children }: {
  carousel: boolean;
  items: ImageLightboxSlide[];
  activeIndex: number;
  rawTitle: string;
  displayTitle: string;
  captionId: string;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-auto relative z-20 mx-auto flex w-full max-w-[min(94vw,42rem)] min-w-0 flex-col items-center gap-2.5 px-4 pb-6 pt-1" id={captionId}>
      {children}
      <div className="flex w-full min-w-0 flex-col items-center gap-1 border-t border-white/[0.08] pt-3 text-center">
        <p className="line-clamp-2 max-w-full min-w-0 break-words px-1 text-sm font-medium leading-snug tracking-tight text-white/[0.94]" title={rawTitle.trim() ? rawTitle : undefined}>{displayTitle}</p>
        {carousel ? <p className="text-xs tabular-nums tracking-wide text-white/48">{activeIndex + 1} / {items.length}</p> : null}
      </div>
    </div>
  );
}

interface LightboxBodyProps {
  open: boolean;
  items: ImageLightboxSlide[];
  activeIndex: number;
  failed: boolean;
  onOpenChange: (open: boolean) => void;
  onPrevious: (event: MouseEvent) => void;
  onNext: (event: MouseEvent) => void;
  onSelectIndex: (index: number) => void;
  onImageError: () => void;
  captionId: string;
  liveId: string;
}

interface ResolvedLightboxSlide {
  safeIndex: number;
  src: string;
  rawTitle: string;
  displayTitle: string;
  carousel: boolean;
}

function resolveLightboxSlide(items: ImageLightboxSlide[], activeIndex: number): ResolvedLightboxSlide {
  const safeIndex = clampLightboxIndex(activeIndex, items.length);
  const current = items[safeIndex] ?? items[0];
  const rawTitle = current?.title ?? "";
  return {
    safeIndex,
    src: current?.src ?? "",
    rawTitle,
    displayTitle: rawTitle.trim() || "Untitled attachment",
    carousel: items.length > 1,
  };
}

function LightboxAccessibleStatus({ slide, itemCount, liveId }: {
  slide: ResolvedLightboxSlide;
  itemCount: number;
  liveId: string;
}) {
  const slideNumber = slide.safeIndex + 1;
  const announcement = slide.carousel ? `Slide ${slideNumber} of ${itemCount}. ${slide.displayTitle}` : slide.displayTitle;
  const dialogTitle = slide.carousel ? `Image ${slideNumber} of ${itemCount}: ${slide.displayTitle}` : `Image preview: ${slide.displayTitle}`;
  return (
    <>
      <span id={liveId} className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
      <DialogTitle className="sr-only">{dialogTitle}</DialogTitle>
    </>
  );
}

function LightboxCanvas({
  slide,
  items,
  failed,
  onPrevious,
  onNext,
  onSelectIndex,
  onImageError,
  captionId,
}: {
  slide: ResolvedLightboxSlide;
  items: ImageLightboxSlide[];
  failed: boolean;
  onPrevious: (event: MouseEvent) => void;
  onNext: (event: MouseEvent) => void;
  onSelectIndex: (index: number) => void;
  onImageError: () => void;
  captionId: string;
}) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col pointer-events-none">
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-2 pt-2 sm:px-10">
        {slide.carousel ? <LightboxNavigation onPrevious={onPrevious} onNext={onNext} /> : null}
        <span className="flex min-h-0 max-h-full w-full min-w-0 flex-1 items-center justify-center"><LightboxImage failed={failed} src={slide.src} title={slide.displayTitle} onError={onImageError} /></span>
      </div>
      <LightboxCaption carousel={slide.carousel} items={items} activeIndex={slide.safeIndex} rawTitle={slide.rawTitle} displayTitle={slide.displayTitle} captionId={captionId}>
        {slide.carousel ? <LightboxDots items={items} activeIndex={slide.safeIndex} onSelect={onSelectIndex} /> : null}
      </LightboxCaption>
    </div>
  );
}

function LightboxBody({ open, items, activeIndex, failed, onOpenChange, onPrevious, onNext, onSelectIndex, onImageError, captionId, liveId }: LightboxBodyProps) {
  if (!open || items.length === 0) return null;
  const slide = resolveLightboxSlide(items, activeIndex);

  return (
    <>
      <LightboxAccessibleStatus slide={slide} itemCount={items.length} liveId={liveId} />
      <button type="button" className={cn("absolute inset-0 z-0 cursor-pointer border-0 bg-transparent outline-none", "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25")} aria-label="Dismiss preview" aria-describedby={`${captionId} ${liveId}`} onClick={() => onOpenChange(false)} />
      <LightboxCanvas slide={slide} items={items} failed={failed} onPrevious={onPrevious} onNext={onNext} onSelectIndex={onSelectIndex} onImageError={onImageError} captionId={captionId} />
    </>
  );
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
  const captionId = useId();
  const liveId = useId();
  const { failed, setFailed, activeIndex, setActiveIndex, handleOpenChange, goPrev, goNext } = useLightboxControls(open, onOpenChange, items, initialIndex);
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
              <LightboxBody
                open={open}
                items={items}
                activeIndex={activeIndex}
                failed={failed}
                onOpenChange={handleOpenChange}
                onPrevious={goPrev}
                onNext={goNext}
                onSelectIndex={setActiveIndex}
                onImageError={() => setFailed(true)}
                captionId={captionId}
                liveId={liveId}
              />
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
});

ImageAttachmentLightbox.displayName = "ImageAttachmentLightbox";
