import { useState, type ReactNode } from "react";

/** Props for FolderEntry. */
interface FolderEntryProps {
  /** Compressed display name (e.g., "src/stores/__tests__"). */
  name: string;
  /** Total file count in this folder's subtree. */
  fileCount: number;
  /** Indentation depth (0 = root). */
  depth: number;
  /** Whether the folder starts expanded. */
  defaultExpanded?: boolean;
  /** Rendered child rows (file entries or nested folders). */
  children: ReactNode;
}

/**
 * Single folder row in the diff file tree. Caret + compressed name + quiet
 * file count. No icon — the typographic mark and indentation carry hierarchy.
 */
export function FolderEntry({
  name,
  fileCount,
  depth,
  defaultExpanded = true,
  children,
}: FolderEntryProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="group flex w-full items-baseline gap-2 py-[5px] pr-3 text-left transition-colors hover:bg-muted/[0.06]"
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        <span
          aria-hidden="true"
          className={`shrink-0 font-mono text-[11px] leading-none transition-transform duration-150 text-muted-foreground/50 ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ›
        </span>

        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-muted-foreground/75 group-hover:text-foreground/80 transition-colors">
          {name}
        </span>

        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground/40">
          {fileCount}
        </span>
      </button>

      {expanded && <div>{children}</div>}
    </div>
  );
}
