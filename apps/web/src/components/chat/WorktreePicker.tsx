import { useState, useEffect, useRef, useMemo } from "react";
import { GitFork, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorktreeInfo } from "@/transport/types";

interface WorktreePickerProps {
  worktrees: WorktreeInfo[];
  selectedPath: string;
  onSelect: (worktree: WorktreeInfo) => void;
  loading: boolean;
}

export function WorktreePicker({
  worktrees,
  selectedPath,
  onSelect,
  loading,
}: WorktreePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (open) {
      setSearch("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return worktrees.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q),
    );
  }, [worktrees, search]);

  const selectedName =
    worktrees.find((w) => w.path === selectedPath)?.name ?? "Select worktree";

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <GitFork size={12} />
        <span>{selectedName}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-[300px] rounded-md border border-border bg-popover p-1 shadow-lg">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search worktrees..."
            className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-popover-foreground focus:border-primary focus:outline-none"
          />

          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : worktrees.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No worktrees found in this workspace
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No worktrees match
            </p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto">
              {filtered.map((w) => (
                <button
                  key={w.path}
                  onClick={() => {
                    onSelect(w);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start rounded px-3 py-1.5 text-xs",
                    w.path === selectedPath
                      ? "bg-accent text-foreground"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className="font-medium">{w.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {w.branch} · {truncatePath(w.path)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function truncatePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return path;
  return ".../" + parts.slice(-3).join("/");
}
