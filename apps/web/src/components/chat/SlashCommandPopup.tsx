import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { Terminal, Zap, Puzzle } from "lucide-react";
import type { Command } from "./useSlashCommand";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const VIRTUAL_THRESHOLD = 20; // use virtual scroll only above this count

interface SlashCommandPopupProps {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onSelect: (cmd: Command) => void;
  onDismiss: () => void;
}

export function SlashCommandPopup({
  isOpen,
  isLoading,
  items,
  selectedIndex,
  anchorRect,
  onSelect,
  onDismiss,
}: SlashCommandPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length > VIRTUAL_THRESHOLD ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 2,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    if (items.length > VIRTUAL_THRESHOLD) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    } else {
      const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, isOpen, items.length, virtualizer]);

  // Dismiss on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-slash-popup]")) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onDismiss]);

  if (!isOpen || !anchorRect) return null;

  // Position: default above the anchor rect, flip below if not enough space
  const spaceAbove = anchorRect.top;
  const maxHeight = Math.min(VISIBLE_ITEMS * ITEM_HEIGHT, items.length * ITEM_HEIGHT || ITEM_HEIGHT * 2);
  const placeAbove = spaceAbove > maxHeight + 8;

  const style: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    width: Math.max(anchorRect.width, 320),
    maxHeight,
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
  };

  const useVirtual = items.length > VIRTUAL_THRESHOLD;

  return (
    <div
      data-slash-popup
      role="listbox"
      aria-label="Slash commands"
      aria-activedescendant={items[selectedIndex] ? `slash-cmd-${items[selectedIndex].name}` : undefined}
      style={style}
      className={cn(
        "z-50 overflow-hidden rounded-lg border border-border bg-card shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-[120ms]",
      )}
    >
      {isLoading ? (
        <SkeletonRows />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          ref={scrollRef}
          role="presentation"
          style={{ maxHeight, overflowY: "auto" }}
        >
          {useVirtual ? (
            <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={vi.key}
                  role="presentation"
                  style={{ position: "absolute", top: vi.start, width: "100%", height: vi.size }}
                  data-index={vi.index}
                >
                  <CommandRow
                    cmd={items[vi.index]}
                    selected={vi.index === selectedIndex}
                    onSelect={onSelect}
                  />
                </div>
              ))}
            </div>
          ) : (
            items.map((cmd, i) => (
              <div key={cmd.name} role="presentation" data-index={i}>
                <CommandRow
                  cmd={cmd}
                  selected={i === selectedIndex}
                  onSelect={onSelect}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function CommandRow({
  cmd,
  selected,
  onSelect,
}: {
  cmd: Command;
  selected: boolean;
  onSelect: (cmd: Command) => void;
}) {
  return (
    <button
      type="button"
      id={`slash-cmd-${cmd.name}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
        selected
          ? "bg-accent border-l-2 border-primary"
          : "hover:bg-accent/50 border-l-2 border-transparent",
      )}
    >
      {/* Icon column */}
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground">
        {cmd.namespace === "mcode" ? (
          <Zap size={12} />
        ) : cmd.namespace === "plugin" ? (
          <Puzzle size={12} />
        ) : (
          <Terminal size={12} />
        )}
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          /{cmd.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {cmd.description}
        </span>
      </span>

      {/* Namespace badge */}
      <span
        className={cn(
          "ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          cmd.namespace === "mcode"
            ? "bg-primary/15 text-primary"
            : cmd.namespace === "plugin"
              ? "bg-orange-500/15 text-orange-500"
              : "bg-muted text-muted-foreground",
        )}
      >
        {cmd.namespace}
      </span>
    </button>
  );
}

function SkeletonRows() {
  return (
    <div aria-busy="true" aria-label="Loading commands" className="p-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <div className="h-5 w-5 rounded bg-muted animate-pulse" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
            <div className="h-2 w-40 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div aria-live="polite" role="status" className="flex items-center gap-3 px-3 py-2">
      <span className="flex h-5 w-5 flex-shrink-0" /> {/* icon placeholder */}
      <span className="text-sm text-muted-foreground">No commands match</span>
    </div>
  );
}
