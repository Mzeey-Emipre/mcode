// apps/web/src/components/chat/FileTagPopup.tsx
import { useRef, useEffect, useCallback, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { getFileIcon, getFileIconColor } from "@/lib/file-icons";

const ITEM_HEIGHT = 28; // px per row (py-1.5 + 14px icon)
const VISIBLE_ITEMS = 8;
const VIRTUAL_THRESHOLD = 20;

interface FileTagPopupOptions {
  files: string[];
  query: string;
  isOpen: boolean;
  onSelect: (filePath: string) => void;
  onDismiss: () => void;
}

interface FileTagPopupProps {
  files: string[];
  isOpen: boolean;
  onSelect: (filePath: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  selectedIndex: number;
}

/** Split a file path into directory + filename for styled rendering. */
function splitPath(path: string): { dir: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", name: path };
  return { dir: path.slice(0, lastSlash + 1), name: path.slice(lastSlash + 1) };
}

/** Hook for keyboard navigation within the file tag popup. */
export function useFileTagPopup({
  files,
  query,
  isOpen,
  onSelect,
  onDismiss,
}: FileTagPopupOptions) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selection when files or query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [files, query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!isOpen || files.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, files.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = files[selectedIndex];
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
    [isOpen, files, selectedIndex, onSelect, onDismiss],
  );

  return { handleKeyDown, listRef, selectedIndex };
}

/** Single file row in the popup list. */
function FileRow({
  filePath,
  selected,
  onSelect,
}: {
  filePath: string;
  selected: boolean;
  onSelect: (filePath: string) => void;
}) {
  const { dir, name } = splitPath(filePath);
  const Icon = getFileIcon(filePath);
  return (
    <button
      role="option"
      aria-selected={selected}
      data-file-item
      onClick={() => onSelect(filePath)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
        "hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <Icon size={14} className={cn("shrink-0", getFileIconColor(filePath))} />
      <span className="truncate">
        <span className="text-muted-foreground">{dir}</span>
        <span className="font-medium">{name}</span>
      </span>
    </button>
  );
}

/** Dropdown popup displaying file suggestions for @ tagging. */
export function FileTagPopup({
  files,
  isOpen,
  onSelect,
  listRef,
  selectedIndex,
}: FileTagPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const useVirtual = files.length > VIRTUAL_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: useVirtual ? files.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 4,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    if (useVirtual) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    } else {
      const el = scrollRef.current?.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex, isOpen, useVirtual, virtualizer]);

  if (!isOpen || files.length === 0) return null;

  const maxHeight = Math.min(
    VISIBLE_ITEMS * ITEM_HEIGHT,
    files.length * ITEM_HEIGHT,
  );

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="File suggestions"
      className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <div
        ref={scrollRef}
        className="p-1"
        style={{ maxHeight, overflowY: "auto" }}
      >
        {useVirtual ? (
          <div
            role="presentation"
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                role="presentation"
                data-index={vi.index}
                style={{
                  position: "absolute",
                  top: vi.start,
                  width: "100%",
                  height: vi.size,
                }}
              >
                <FileRow
                  filePath={files[vi.index]}
                  selected={vi.index === selectedIndex}
                  onSelect={onSelect}
                />
              </div>
            ))}
          </div>
        ) : (
          files.map((filePath, i) => (
            <div key={filePath} role="presentation" data-index={i}>
              <FileRow
                filePath={filePath}
                selected={i === selectedIndex}
                onSelect={onSelect}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
