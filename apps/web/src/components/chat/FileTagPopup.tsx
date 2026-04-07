// apps/web/src/components/chat/FileTagPopup.tsx
import { useRef, useEffect, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { getFileIcon, getFileIconColor } from "@/lib/file-icons";

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
          const Icon = getFileIcon(filePath);
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
              <Icon size={14} className={cn("shrink-0", getFileIconColor(filePath))} />
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
