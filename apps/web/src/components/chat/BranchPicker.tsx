import { useState, useEffect, useRef, useMemo } from "react";
import { GitBranch, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitBranch as GitBranchType } from "@/transport/types";

interface BranchPickerProps {
  branches: GitBranchType[];
  selectedBranch: string;
  onSelect: (branchName: string) => void;
  loading: boolean;
  locked: boolean;
}

export function BranchPicker({ branches, selectedBranch, onSelect, loading, locked }: BranchPickerProps) {
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
    const matching = branches.filter((b) => b.name.toLowerCase().includes(q));
    const local = matching.filter((b) => b.type !== "remote");
    const remote = matching.filter((b) => b.type === "remote");
    return [...local, ...remote];
  }, [branches, search]);

  if (locked) {
    return (
      <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground">
        <GitBranch size={12} />
        {selectedBranch}
      </span>
    );
  }

  const handleSelect = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  const badgeFor = (b: GitBranchType) => {
    if (b.isCurrent) return "current";
    if (b.type === "remote") return "origin";
    if (b.type === "worktree") return "worktree";
    return null;
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <GitBranch size={12} />
        <span>From {selectedBranch}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-[260px] rounded-md border border-border bg-popover p-1 shadow-lg">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search branches..."
            className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-popover-foreground focus:border-primary focus:outline-none"
          />

          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No branches match</p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto">
              {filtered.map((b) => {
                const badge = badgeFor(b);
                return (
                  <button
                    key={`${b.type}-${b.name}`}
                    onClick={() => handleSelect(b.name)}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
                      b.name === selectedBranch
                        ? "bg-accent text-foreground"
                        : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{b.name}</span>
                    {badge && (
                      <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
