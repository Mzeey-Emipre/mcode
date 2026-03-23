// apps/web/src/components/chat/FileTagPopup.tsx
import { useRef, useEffect, useCallback } from "react";
import { File } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const selectedIndexRef = useRef(0);

  // Reset selection when files or query change
  useEffect(() => {
    selectedIndexRef.current = 0;
    if (listRef.current) {
      const items = listRef.current.querySelectorAll("[data-file-item]");
      items.forEach((item, i) => {
        const el = item as HTMLElement;
        el.dataset.selected = i === 0 ? "true" : "false";
        el.setAttribute("aria-selected", i === 0 ? "true" : "false");
      });
    }
  }, [files, query]);

  const updateSelection = useCallback((newIndex: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-file-item]");
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(newIndex, items.length - 1));
    selectedIndexRef.current = clamped;

    items.forEach((item, i) => {
      const el = item as HTMLElement;
      el.dataset.selected = i === clamped ? "true" : "false";
      el.setAttribute("aria-selected", i === clamped ? "true" : "false");
    });

    // Scroll into view
    items[clamped]?.scrollIntoView({ block: "nearest" });
  }, []);

  // Keyboard handler - called from Composer's onKeyDown
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!isOpen || files.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        updateSelection(selectedIndexRef.current + 1);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        updateSelection(selectedIndexRef.current - 1);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = files[selectedIndexRef.current];
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
    [isOpen, files, onSelect, onDismiss, updateSelection],
  );

  return { handleKeyDown, listRef };
}

/** Dropdown popup displaying file suggestions for @ tagging. */
export function FileTagPopup({ files, isOpen, onSelect, listRef }: FileTagPopupProps) {
  if (!isOpen || files.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="File suggestions"
      className="absolute bottom-full left-0 z-50 mb-1 w-full max-h-[240px] overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
    >
      <div className="p-1">
        {files.map((filePath, index) => {
          const { dir, name } = splitPath(filePath);
          return (
            <button
              key={filePath}
              role="option"
              aria-selected={index === 0 ? "true" : "false"}
              data-file-item
              data-selected={index === 0 ? "true" : "false"}
              onClick={() => onSelect(filePath)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                "hover:bg-accent hover:text-accent-foreground",
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
              )}
            >
              <File size={14} className="shrink-0 text-muted-foreground" />
              <span className="truncate">
                <span className="text-muted-foreground">{dir}</span>
                <span className="font-medium">{name}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
