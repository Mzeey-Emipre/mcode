import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** One named option in a disposable UI prototype. */
export interface PrototypeVariantOption {
  readonly id: string;
  readonly label: string;
}

/** Props for the development-only prototype variant switcher. */
export interface PrototypeSwitcherProps {
  readonly variants: readonly PrototypeVariantOption[];
  readonly current: string;
  readonly onSelect: (id: string) => void;
}

/** Development-only bottom bar for cycling shareable UI prototype variants. */
export function PrototypeSwitcher({
  variants,
  current,
  onSelect,
}: PrototypeSwitcherProps) {
  const currentIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.id === current),
  );

  const selectOffset = (offset: number): void => {
    const nextIndex =
      (currentIndex + offset + variants.length) % variants.length;
    const next = variants[nextIndex];
    if (next) onSelect(next.id);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "button, input, textarea, select, a[href], [contenteditable], [role='separator']",
        )
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectOffset(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectOffset(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (import.meta.env.PROD || variants.length === 0) return null;
  const selected = variants[currentIndex];

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-foreground px-1.5 py-1 text-background shadow-lg"
      role="group"
      aria-label="Prototype variants"
      data-testid="prototype-switcher"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-background hover:bg-background/10 hover:text-background"
        onClick={() => selectOffset(-1)}
        aria-label="Previous prototype variant"
      >
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <span className="min-w-48 px-2 text-center text-xs font-medium">
        {selected?.id} · {selected?.label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-background hover:bg-background/10 hover:text-background"
        onClick={() => selectOffset(1)}
        aria-label="Next prototype variant"
      >
        <ChevronRight size={16} aria-hidden />
      </Button>
    </div>
  );
}
