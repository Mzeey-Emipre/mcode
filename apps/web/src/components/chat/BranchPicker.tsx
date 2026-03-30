import { useState, useEffect, useRef, useMemo } from "react";
import { GitBranch, ChevronDown, Loader2, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { GitBranch as GitBranchType, PrDetail } from "@/transport/types";
import { useWorkspaceStore } from "@/stores/workspaceStore";

type TabId = "local" | "remote" | "prs";

interface BranchPickerProps {
  branches: GitBranchType[];
  selectedBranch: string;
  onSelect: (branchName: string) => void;
  loading: boolean;
  locked: boolean;
  pullRequests?: PrDetail[];
  prsLoading?: boolean;
  fetchingBranch?: string | null;
  onFetchAndSelect?: (branch: string, prNumber: number) => void;
}

/**
 * Searchable dropdown for selecting a git branch.
 * Uses tabs (Local / Remote / PRs) to organize branches.
 * When `locked` is true, renders a read-only badge instead of a dropdown.
 */
export function BranchPicker({
  branches,
  selectedBranch,
  onSelect,
  loading,
  locked,
  pullRequests,
  prsLoading,
  fetchingBranch,
  onFetchAndSelect,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("local");
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
      setActiveTab("local");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const q = search.toLowerCase();

  const localBranches = useMemo(
    () => branches.filter((b) => b.type !== "remote" && b.name.toLowerCase().includes(q)),
    [branches, q],
  );

  const remoteBranches = useMemo(
    () => branches.filter((b) => b.type === "remote" && b.name.toLowerCase().includes(q)),
    [branches, q],
  );

  const filteredPrs = useMemo(
    () =>
      (pullRequests ?? []).filter((pr) => {
        if (!q) return true;
        return (
          pr.title.toLowerCase().includes(q) ||
          pr.branch.toLowerCase().includes(q) ||
          String(pr.number).includes(q) ||
          pr.author.toLowerCase().includes(q)
        );
      }),
    [pullRequests, q],
  );

  const hasPrs = (pullRequests ?? []).length > 0 || prsLoading;

  if (locked) {
    return (
      <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <GitBranch size={12} />
        {selectedBranch}
      </span>
    );
  }

  const handleSelect = (name: string) => {
    useWorkspaceStore.getState().setBranchManuallySelected(true);
    onSelect(name);
    setOpen(false);
  };

  const badgeFor = (b: GitBranchType) => {
    if (b.isCurrent) return "current";
    if (b.type === "worktree") return "worktree";
    return null;
  };

  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: "local", label: "Local", count: localBranches.length },
    { id: "remote", label: "Remote", count: remoteBranches.length },
    ...(hasPrs ? [{ id: "prs" as TabId, label: "PRs", count: filteredPrs.length }] : []),
  ];

  const renderBranchItem = (b: GitBranchType) => {
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
          <Badge variant="secondary" size="sm" className="ml-2 shrink-0">{badge}</Badge>
        )}
      </button>
    );
  };

  const renderPrItem = (pr: PrDetail) => {
    const isFetching = fetchingBranch === pr.branch;
    return (
      <button
        key={`pr-${pr.number}`}
        onClick={() => {
          if (isFetching) return;
          setOpen(false);
          if (onFetchAndSelect) {
            useWorkspaceStore.getState().setBranchManuallySelected(true);
            onFetchAndSelect(pr.branch, pr.number);
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
          <span className="text-xs text-muted-foreground">
            {pr.branch} &middot; {pr.author}
          </span>
        </div>
        {isFetching && <Loader2 size={12} className="animate-spin shrink-0 text-muted-foreground" />}
      </button>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <Button variant="ghost" size="xs" onClick={() => setOpen(!open)} className="text-muted-foreground">
        <GitBranch size={12} />
        <span>From {selectedBranch}</span>
        <ChevronDown size={10} />
      </Button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-[280px] rounded-md border border-border bg-popover shadow-lg">
          {/* Search */}
          <div className="p-1.5 pb-0">
            <Input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." size="sm" className="text-popover-foreground" />
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border px-1.5 pt-1.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1 rounded-t px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === tab.id
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                <Badge size="sm" className={cn("rounded-full", activeTab === tab.id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                  {tab.count}
                </Badge>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="max-h-[250px] overflow-y-auto p-1">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-muted-foreground" />
              </div>
            ) : activeTab === "local" ? (
              localBranches.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No local branches match</p>
              ) : (
                localBranches.map(renderBranchItem)
              )
            ) : activeTab === "remote" ? (
              remoteBranches.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No remote branches match</p>
              ) : (
                remoteBranches.map(renderBranchItem)
              )
            ) : activeTab === "prs" ? (
              prsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={16} className="animate-spin text-muted-foreground" />
                </div>
              ) : filteredPrs.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No pull requests match</p>
              ) : (
                filteredPrs.map(renderPrItem)
              )
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
