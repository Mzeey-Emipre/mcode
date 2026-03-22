import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface MenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = () => onClose();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        ref.current.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight) {
        ref.current.style.top = `${window.innerHeight - rect.height - 8}px`;
      }
    }
  }, [x, y]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y, zIndex: 50 }}
      className="min-w-[160px] rounded-lg border border-border bg-card p-1 shadow-xl"
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick();
              onClose();
            }}
            className={cn(
              "flex w-full items-center rounded-md px-3 py-1.5 text-sm",
              item.destructive
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground hover:bg-accent"
            )}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
