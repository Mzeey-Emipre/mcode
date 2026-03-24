import { useState, useEffect, useRef, useMemo } from "react";
import { GitBranch, ChevronDown, Loader2, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitBranch as GitBranchType, PrDetail } from "@/transport/types";

interface BranchPickerProps {
  branches: GitBranchType[];
  selectedBranch: string;
  onSelect: (branchName: string) => void;
  loading: boolean;
  locked: boolean;
  pullRequests?: PrDetail[];
  prsLoading?: boolean;
  fetchingBranch?: string | null;
  onFetchAndSelect?: (branch: string) => void;
}

/**
 * Searchable dropdown for selecting a git branch.
 * Used in direct mode for the working branch and in worktree mode
 * for choosing the base branch to create the worktree from ("From main").
 * When `locked` is true, renders a read-only badge instead of a dropdown.
 */
export function BranchPicker({ branches, selectedBranch, onSelect, loading, locked, pullRequests, prsLoading, fetchingBranch, onFetchAndSelect }: BranchPickerProps) {
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
        <div className="absolute bottom-full right-0 z-50 mb-1 w-[260px] rounded-md border border-border bg-popover p-1 shadow-lg">
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
              {/* Local / worktree branches */}
              {filtered.filter((b) => b.type !== "remote").length > 0 && (
                <div className="px-3 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Local
                </div>
              )}
              {filtered.filter((b) => b.type !== "remote").map((b) => {
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

              {/* Remote branches */}
              {filtered.filter((b) => b.type === "remote").length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Remote
                </div>
              )}
              {filtered.filter((b) => b.type === "remote").map((b) => {
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

              {/* Pull Requests section */}
              {pullRequests && pullRequests.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    Pull Requests
                  </div>
                  {pullRequests
                    .filter((pr) => {
                      const q = search.toLowerCase();
                      if (!q) return true;
                      return (
                        pr.title.toLowerCase().includes(q) ||
                        pr.branch.toLowerCase().includes(q) ||
                        String(pr.number).includes(q) ||
                        pr.author.toLowerCase().includes(q)
                      );
                    })
                    .map((pr) => {
                      const isFetching = fetchingBranch === pr.branch;
                      return (
                        <button
                          key={`pr-${pr.number}`}
                          onClick={() => {
                            if (isFetching) return;
                            setOpen(false);
                            if (onFetchAndSelect) {
                              onFetchAndSelect(pr.branch);
                            } else {
                              handleSelect(pr.branch);
                            }
                          }}
                          disabled={isFetching}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
                            pr.branch === selectedBranch
                              ? "bg-accent text-foreground"
                              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                          )}
                        >
                          <div className="flex flex-col items-start gap-0.5 truncate">
                            <span className="flex items-center gap-1">
                              <GitPullRequest size={10} />
                              #{pr.number} {pr.title}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {pr.branch} &middot; {pr.author}
                            </span>
                          </div>
                          {isFetching && <Loader2 size={12} className="animate-spin shrink-0 text-muted-foreground" />}
                        </button>
                      );
                    })}
                </>
              )}
              {prsLoading && (
                <div className="flex items-center justify-center py-2">
                  <Loader2 size={12} className="animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
