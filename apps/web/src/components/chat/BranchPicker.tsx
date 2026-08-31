import { useState, useMemo } from "react";
import { GitBranch, ChevronDown, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { GitBranch as GitBranchType, PrDetail } from "@/transport/types";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

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
  /** Optional trigger styling for compact context rails. */
  triggerClassName?: string;
  /** Primary glyph size for the trigger. */
  iconSize?: number;
}

/**
 * Searchable dropdown for selecting a git branch.
 * Uses tabs (Local / Remote / PRs) to organize branches.
 * When `locked` is true, renders a read-only badge instead of a dropdown.
 */
export function BranchPicker(props: BranchPickerProps) {
  if (props.locked) return <LockedBranchPicker {...props} />;
  return <BranchPickerDropdown {...props} />;
}

function LockedBranchPicker({ selectedBranch, triggerClassName, iconSize = 12 }: BranchPickerProps) {
  return (
    <span className={cn("flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground", triggerClassName)}>
      <GitBranch size={iconSize} className={triggerClassName ? "size-3.5" : undefined} />
      {selectedBranch}
    </span>
  );
}

function useFilteredBranches(branches: GitBranchType[], pullRequests: PrDetail[] | undefined, search: string) {
  const query = search.toLowerCase();
  const localBranches = useMemo(
    () => branches.filter((branch) => branch.type !== "remote" && branch.name.toLowerCase().includes(query)),
    [branches, query],
  );
  const remoteBranches = useMemo(
    () => branches.filter((branch) => branch.type === "remote" && branch.name.toLowerCase().includes(query)),
    [branches, query],
  );
  const filteredPrs = useMemo(
    () => (pullRequests ?? []).filter((pr) => matchesPullRequest(pr, query)),
    [pullRequests, query],
  );
  return { localBranches, remoteBranches, filteredPrs };
}

function matchesPullRequest(pr: PrDetail, query: string): boolean {
  if (!query) return true;
  return [pr.title, pr.branch, String(pr.number), pr.author].some((value) => value.toLowerCase().includes(query));
}

function branchBadge(branch: GitBranchType): string | null {
  if (branch.isCurrent) return "current";
  return branch.type === "worktree" ? "worktree" : null;
}

interface BranchItemProps {
  branch: GitBranchType;
  selectedBranch: string;
  onSelect: (branchName: string) => void;
}

function BranchItem({ branch, selectedBranch, onSelect }: BranchItemProps) {
  const badge = branchBadge(branch);
  return (
    <button
      key={`${branch.type}-${branch.name}`}
      onClick={() => onSelect(branch.name)}
      className={cn(
        "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
        branch.name === selectedBranch
          ? "bg-accent text-foreground"
          : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <span className="truncate">{branch.name}</span>
      {badge ? <Badge variant="secondary" size="sm" className="ml-2 shrink-0">{badge}</Badge> : null}
    </button>
  );
}

interface PullRequestItemProps {
  pullRequest: PrDetail;
  selectedBranch: string;
  fetchingBranch?: string | null;
  onSelect: (branch: string, prNumber: number) => void;
}

function PullRequestItem({ pullRequest, selectedBranch, fetchingBranch, onSelect }: PullRequestItemProps) {
  const isFetching = fetchingBranch === pullRequest.branch;
  return (
    <button
      key={`pr-${pullRequest.number}`}
      onClick={() => onSelect(pullRequest.branch, pullRequest.number)}
      disabled={isFetching}
      className={cn(
        "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
        pullRequest.branch === selectedBranch
          ? "bg-accent text-foreground"
          : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <div className="flex flex-col items-start gap-0.5 truncate">
        <span className="flex items-center gap-1">
          <GitPullRequest size={10} />
          #{pullRequest.number} {pullRequest.title}
        </span>
        <span className="text-xs text-muted-foreground">
          {pullRequest.branch} &middot; {pullRequest.author}
        </span>
      </div>
      {isFetching ? <Spinner size={12} className="text-muted-foreground" /> : null}
    </button>
  );
}

function LoadingBranchList() {
  return <div className="flex items-center justify-center py-4"><Spinner size={16} className="text-muted-foreground" /></div>;
}

function BranchList({ branches, emptyMessage, selectedBranch, onSelect }: {
  branches: GitBranchType[];
  emptyMessage: string;
  selectedBranch: string;
  onSelect: (branchName: string) => void;
}) {
  if (branches.length === 0) return <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyMessage}</p>;
  return <>{branches.map((branch) => <BranchItem key={`${branch.type}-${branch.name}`} branch={branch} selectedBranch={selectedBranch} onSelect={onSelect} />)}</>;
}

function PullRequestList({
  pullRequests,
  prsLoading,
  selectedBranch,
  fetchingBranch,
  onSelect,
}: {
  pullRequests: PrDetail[];
  prsLoading?: boolean;
  selectedBranch: string;
  fetchingBranch?: string | null;
  onSelect: (branch: string, prNumber: number) => void;
}) {
  if (prsLoading) return <LoadingBranchList />;
  if (pullRequests.length === 0) return <p className="px-2 py-3 text-center text-xs text-muted-foreground">No pull requests match</p>;
  return <>{pullRequests.map((pullRequest) => <PullRequestItem key={`pr-${pullRequest.number}`} pullRequest={pullRequest} selectedBranch={selectedBranch} fetchingBranch={fetchingBranch} onSelect={onSelect} />)}</>;
}

function BranchTabContent({
  activeTab,
  localBranches,
  remoteBranches,
  filteredPrs,
  prsLoading,
  selectedBranch,
  fetchingBranch,
  onSelectBranch,
  onSelectPullRequest,
}: {
  activeTab: TabId;
  localBranches: GitBranchType[];
  remoteBranches: GitBranchType[];
  filteredPrs: PrDetail[];
  prsLoading?: boolean;
  selectedBranch: string;
  fetchingBranch?: string | null;
  onSelectBranch: (branchName: string) => void;
  onSelectPullRequest: (branch: string, prNumber: number) => void;
}) {
  if (activeTab === "local") return <BranchList branches={localBranches} emptyMessage="No local branches match" selectedBranch={selectedBranch} onSelect={onSelectBranch} />;
  if (activeTab === "remote") return <BranchList branches={remoteBranches} emptyMessage="No remote branches match" selectedBranch={selectedBranch} onSelect={onSelectBranch} />;
  return <PullRequestList pullRequests={filteredPrs} prsLoading={prsLoading} selectedBranch={selectedBranch} fetchingBranch={fetchingBranch} onSelect={onSelectPullRequest} />;
}

function BranchPickerDropdown({
  branches,
  selectedBranch,
  onSelect,
  loading,
  pullRequests,
  prsLoading,
  fetchingBranch,
  onFetchAndSelect,
  triggerClassName,
  iconSize = 12,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("local");
  const { localBranches, remoteBranches, filteredPrs } = useFilteredBranches(branches, pullRequests, search);
  const hasPrs = Boolean(prsLoading) || pullRequests?.[0] !== undefined;

  const handleSelect = (name: string) => {
    useWorkspaceStore.getState().setBranchManuallySelected(true);
    onSelect(name);
    setOpen(false);
  };

  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: "local", label: "Local", count: localBranches.length },
    { id: "remote", label: "Remote", count: remoteBranches.length },
    ...(hasPrs ? [{ id: "prs" as TabId, label: "PRs", count: filteredPrs.length }] : []),
  ];

  const handleSelectPullRequest = (branch: string, prNumber: number) => {
    if (fetchingBranch === branch) return;
    setOpen(false);
    if (!onFetchAndSelect) {
      handleSelect(branch);
      return;
    }
    useWorkspaceStore.getState().setBranchManuallySelected(true);
    onFetchAndSelect(branch, prNumber);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSearch("");
          setActiveTab("local");
        }
      }}
    >
      <PopoverTrigger render={
        <Button variant="ghost" size="xs" className={cn("text-muted-foreground", triggerClassName)}>
          <GitBranch size={iconSize} className={triggerClassName ? "size-3.5" : undefined} />
          <span>From {selectedBranch}</span>
          <ChevronDown size={Math.max(10, iconSize - 2)} className={triggerClassName ? "size-3" : undefined} />
        </Button>
      } />

      <PopoverContent align="end" side="top" sideOffset={4} className="w-[280px] p-0">
        {/* Search */}
        <div className="p-1.5 pb-0">
          <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." size="sm" className="text-popover-foreground" />
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
          {loading ? <LoadingBranchList /> : <BranchTabContent activeTab={activeTab} localBranches={localBranches} remoteBranches={remoteBranches} filteredPrs={filteredPrs} prsLoading={prsLoading} selectedBranch={selectedBranch} fetchingBranch={fetchingBranch} onSelectBranch={handleSelect} onSelectPullRequest={handleSelectPullRequest} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}
