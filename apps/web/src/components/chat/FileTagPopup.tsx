// apps/web/src/components/chat/FileTagPopup.tsx
import { useRef, useEffect, useCallback, useState, memo } from "react";
import { cn } from "@/lib/utils";
import { getFileIcon, getFileIconColor } from "@/lib/file-icons";
import type { MentionSuggestion } from "./useFileAutocomplete";
import { StackedLayersIcon } from "./narrative/StackedLayersIcon";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";

const ITEM_HEIGHT = 28; // px per row (py-1.5 + 14px icon)
const VISIBLE_ITEMS = 8;

/** Options for the useFileTagPopup keyboard-navigation hook. */
interface FileTagPopupOptions {
  items: MentionSuggestion[];
  query: string;
  isOpen: boolean;
  onSelect: (item: MentionSuggestion) => void;
  onDismiss: () => void;
}

/** Props for the FileTagPopup display component. */
interface FileTagPopupProps {
  items: MentionSuggestion[];
  isOpen: boolean;
  onSelect: (item: MentionSuggestion) => void;
  /** Ref forwarded from useFileTagPopup, used by the parent for focus management. */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Controlled selection index driven by useFileTagPopup state. */
  selectedIndex: number;
  /**
   * When provided, the popup renders at a fixed position derived from this
   * rect (anchored above the rect, like SlashCommandPopup) instead of using
   * `absolute bottom-full`. Required when the popup would otherwise be clipped
   * by an `overflow-hidden` ancestor (e.g. the annotation bubble).
   */
  anchorRect?: DOMRect | null;
  /**
   * `"dark"` switches every surface, text, hover, and border token to dark
   * hardcoded values so the popup coheres with the annotation bubble's
   * intentionally dark palette (which must stay readable over arbitrary user
   * web content regardless of the app theme). `"default"` (the default) leaves
   * the Tailwind theme tokens untouched so the Composer's rendering is
   * byte-identical to before this prop was added.
   */
  tone?: "default" | "dark";
  /** Extra class names for border/positioning overrides that don't belong in tone. */
  className?: string;
  /** Whether the popup occupies the full composer width or a compact preview-bubble width. */
  presentation?: "composer" | "compact";
}

/** Split a file path into directory + filename for styled rendering. */
function splitPath(path: string): { dir: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", name: path };
  return { dir: path.slice(0, lastSlash + 1), name: path.slice(lastSlash + 1) };
}

/** Hook for keyboard navigation within the file tag popup. */
export function useFileTagPopup({
  items,
  query,
  isOpen,
  onSelect,
  onDismiss,
}: FileTagPopupOptions) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Mirror of selectedIndex read by event handlers to avoid stale closure
  // when Enter/Tab fires in the same synchronous batch as a preceding Arrow key.
  const selectedIndexRef = useRef(0);

  // Reset selection when items or query change
  useEffect(() => {
    setSelectedIndex(0);
    selectedIndexRef.current = 0;
  }, [items, query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!isOpen || items.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(prev + 1, items.length - 1);
          selectedIndexRef.current = next;
          return next;
        });
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          selectedIndexRef.current = next;
          return next;
        });
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        // Read from ref so we get the value set by a preceding Arrow key in
        // the same synchronous event batch, not the stale closure snapshot.
        const selected = items[selectedIndexRef.current];
        if (selected) onSelect(selected);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return true;
      }
      return false;
    },
    [isOpen, items, onSelect, onDismiss],
  );

  return { handleKeyDown, listRef, selectedIndex };
}

/**
 * Single file row rendered in both the virtual and non-virtual list paths.
 * Memoized so only the two rows whose `selected` prop flips re-render on
 * each navigation keypress.
 */
const SuggestionRow = memo(function SuggestionRow({
  item,
  selected,
  onSelect,
  tone = "default",
}: {
  item: MentionSuggestion;
  selected: boolean;
  onSelect: (item: MentionSuggestion) => void;
  tone?: "default" | "dark";
}) {
  const isFile = item.kind === "file";
  const { dir, name } = isFile ? splitPath(item.path) : { dir: "", name: item.label };
  const Icon = isFile ? getFileIcon(item.path) : StackedLayersIcon;

  const isDark = tone === "dark";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-file-item
      onClick={() => onSelect(item)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-100",
        isDark
          ? cn(
              "focus-visible:outline-none",
              selected
                ? "bg-white/[0.12] text-neutral-100"
                : "hover:bg-white/[0.06] hover:text-neutral-100",
            )
          : cn(
              "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none",
              selected && "bg-accent text-accent-foreground",
            ),
      )}
    >
      <Icon
        size={14}
        className={cn(
          "size-3.5 shrink-0",
          isFile
            ? getFileIconColor(item.path)
            : isDark
              ? "text-neutral-400 group-hover:text-neutral-300 group-aria-selected:text-neutral-300"
              : "text-muted-foreground/55 group-hover:text-accent-foreground/70 group-focus-visible:text-accent-foreground/70 group-aria-selected:text-accent-foreground/70",
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className={cn(
          isDark
            ? "text-neutral-400 group-hover:text-neutral-300 group-aria-selected:text-neutral-300"
            : "text-muted-foreground group-hover:text-accent-foreground/70 group-focus-visible:text-accent-foreground/70 group-aria-selected:text-accent-foreground/70",
        )}>{dir}</span>
        <span className={cn("font-medium", isDark ? "text-neutral-100" : "")}>{name}</span>
      </span>
      {item.kind === "agent" && item.description ? (
        <span className={cn(
          "min-w-0 flex-[1.2] truncate",
          isDark
            ? "text-neutral-400 group-hover:text-neutral-300 group-aria-selected:text-neutral-300"
            : "text-muted-foreground group-hover:text-accent-foreground/70 group-focus-visible:text-accent-foreground/70 group-aria-selected:text-accent-foreground/70",
        )}>
          {item.description}
        </span>
      ) : null}
    </button>
  );
});

/** Dropdown popup displaying file suggestions for @ tagging. */
export function FileTagPopup({
  items,
  isOpen,
  onSelect,
  listRef,
  selectedIndex,
  anchorRect,
  tone = "default",
  className,
  presentation = "compact",
}: FileTagPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const el = scrollRef.current?.querySelector(
      `[data-index="${selectedIndex}"]`,
    );
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, isOpen, items]);

  if (!isOpen || items.length === 0) return null;

  const maxHeight = Math.min(
    VISIBLE_ITEMS * ITEM_HEIGHT,
    items.length * ITEM_HEIGHT + 48,
  );
  let renderedIndex = 0;
  let currentGroup: MentionSuggestion["group"] | null = null;

  // The group header uses bg-inherit so it always matches the popup surface.
  // When tone="dark" the wrapper's explicit bg sets the inherited value; no
  // separate groupHeaderClassName is needed.

  const list = (
    <div
      ref={scrollRef}
      className="p-1"
      style={{ maxHeight, overflowY: "auto" }}
    >
      {items.map((item) => {
        const index = renderedIndex++;
        const showGroup = item.group !== currentGroup;
        currentGroup = item.group;
        return (
          <div key={item.id} role="presentation">
            {showGroup ? (
              <div
                data-group-header
                className={cn(
                  "sticky top-0 z-10 bg-inherit px-2 py-1 text-xs font-medium",
                  tone === "dark" ? "text-neutral-400" : "text-muted-foreground/70",
                )}
              >
                {item.group}
              </div>
            ) : null}
            <div role="presentation" data-index={index}>
              <SuggestionRow
                item={item}
                selected={index === selectedIndex}
                onSelect={onSelect}
                tone={tone}
              />
            </div>
          </div>
        );
      })}
    </div>
  );

  if (anchorRect) {
    return (
      <ComposerOverlaySurface
        data-file-popup
        ref={listRef}
        role="listbox"
        aria-label="Mention suggestions"
        anchorRect={anchorRect}
        estimatedHeight={maxHeight}
        minWidth={presentation === "composer" ? 0 : 260}
        maxWidth={presentation === "composer" ? undefined : 360}
        attached={presentation === "composer"}
        tone={tone}
        className={className}
      >
        {list}
      </ComposerOverlaySurface>
    );
  }

  return (
    <div
      data-file-popup
      ref={listRef}
      role="listbox"
      aria-label="Mention suggestions"
      className={cn(
        "composer-autocomplete-surface absolute bottom-full left-0 mb-1 w-full overflow-hidden rounded-xl border border-border/70 animate-composer-popup-enter",
        tone === "dark"
          ? "border-white/10 bg-[#1e1e1e] text-neutral-100"
          : "bg-popover text-popover-foreground",
        className,
      )}
    >
      {list}
    </div>
  );
}
