import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Diff,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Globe,
  Laptop,
  Menu,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Favicon } from "@/components/ui/favicon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { PrSplitButton } from "./PrSplitButton";
import { CreatePrDialog } from "./CreatePrDialog";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { useDiffStore } from "@/stores/diffStore";
import { executeCommand } from "@/lib/command-registry";
import { cn } from "@/lib/utils";
import {
  getTransport,
  type GitBranch as GitBranchRecord,
  type McodeTransport,
  type Thread,
} from "@/transport";
import type { ChecksStatus, TurnSnapshot } from "@mcode/contracts";

/** CI dot shown on the Overview trigger for terminal check states. */
export type ThreadOverviewCiDot = "red" | "green" | null;

/** Props for {@link ThreadOverview}. */
interface ThreadOverviewProps {
  thread: Thread;
}

type SnapshotDiffStat = { filePath: string; additions: number; deletions: number };
type ReviewDiffStat = { additions: number; deletions: number };
type ThreadOverviewChangeSummaryTransport = Pick<
  McodeTransport,
  | "listSnapshots"
  | "getSnapshotDiffStats"
  | "getWorkingTreeFiles"
  | "getBranchComparison"
  | "getBranchFiles"
  | "getReviewDiffStats"
>;
type ThreadOverviewRepositoryTransport = Pick<McodeTransport, "getRemoteUrl">;

type LoadedBranchState =
  | { status: "idle"; branches: GitBranchRecord[]; uncommittedFiles: number | null }
  | { status: "loading"; branches: GitBranchRecord[]; uncommittedFiles: number | null }
  | { status: "ready"; branches: GitBranchRecord[]; uncommittedFiles: number | null }
  | { status: "error"; branches: GitBranchRecord[]; uncommittedFiles: number | null };
type LoadStatus = "idle" | "loading" | "ready" | "error";
type LocalCopyTarget = "path" | "branch";

/** Repository metadata rendered by the Overview Repository row. */
export interface ThreadOverviewRepository {
  /** Label shown in the row, usually "org/repo". */
  label: string;
  /** Safe HTTPS web URL opened from the row, or null for local-only repos. */
  webUrl: string | null;
  /** HTTPS favicon URL for the remote host, or null when unavailable. */
  faviconUrl: string | null;
}

/** Aggregate change totals shown in the Overview popover. */
export interface ThreadOverviewChangeSummary {
  /** Unique changed file count across the snapshots. */
  files: number;
  /** Total added lines across snapshot diff stats. */
  additions: number;
  /** Total removed lines across snapshot diff stats. */
  deletions: number;
}

const EMPTY_CHANGE_SUMMARY: ThreadOverviewChangeSummary = {
  files: 0,
  additions: 0,
  deletions: 0,
};

const EMPTY_REVIEW_DIFF_STAT: ReviewDiffStat = {
  additions: 0,
  deletions: 0,
};

const EMPTY_REPOSITORY: ThreadOverviewRepository = {
  label: "Repository",
  webUrl: null,
  faviconUrl: null,
};

/**
 * Derives the active thread's compact CI signal for the Overview trigger.
 */
export function getThreadOverviewCiDot(
  pr: { state: string } | null,
  checks: ChecksStatus | null,
): ThreadOverviewCiDot {
  if (!pr || pr.state.toLowerCase() !== "open" || !checks) return null;
  if (checks.aggregate === "failing") return "red";
  if (checks.aggregate === "passing") return "green";
  return null;
}

function changedFilesLabel(count: number): string {
  if (count === 0) return "No files";
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function uncommittedFilesLabel(count: number): string {
  return `Uncommitted: ${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * Returns a repository URL only when it is safe for an external open action.
 */
export function getSafeRepositoryWebUrl(webUrl: string | null): string | null {
  if (!webUrl) return null;
  try {
    const parsed = new URL(webUrl);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Derives the favicon URL for a safe repository web URL.
 */
export function getRepositoryFaviconUrl(webUrl: string | null): string | null {
  const safeUrl = getSafeRepositoryWebUrl(webUrl);
  if (!safeUrl) return null;
  return `${new URL(safeUrl).origin}/favicon.ico`;
}

function snapshotKey(snapshots: readonly Pick<TurnSnapshot, "id">[] | undefined): string {
  return snapshots?.map((snapshot) => snapshot.id).join("|") ?? "";
}

function latestSnapshotWithChanges(
  snapshots: readonly Pick<TurnSnapshot, "id" | "files_changed">[],
): Pick<TurnSnapshot, "id" | "files_changed"> | null {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot.files_changed.length > 0) return snapshot;
  }
  return null;
}

function summarizeGitChangeStats(
  files: readonly string[],
  stat: ReviewDiffStat,
): ThreadOverviewChangeSummary {
  return {
    files: new Set(files).size,
    additions: stat.additions,
    deletions: stat.deletions,
  };
}

/**
 * Sums turn snapshot diff stats for the compact thread-level change summary.
 */
export function summarizeThreadChangeStats(
  snapshots: readonly Pick<TurnSnapshot, "files_changed">[],
  perSnapshotStats: readonly (readonly SnapshotDiffStat[])[],
): ThreadOverviewChangeSummary {
  const files = new Set<string>();
  for (const snapshot of snapshots) {
    for (const file of snapshot.files_changed) files.add(file);
  }

  let additions = 0;
  let deletions = 0;
  for (const stats of perSnapshotStats) {
    for (const stat of stats) {
      files.add(stat.filePath);
      additions += stat.additions;
      deletions += stat.deletions;
    }
  }

  return { files: files.size, additions, deletions };
}

/**
 * Returns true when the compact summary should render a visible +/- total.
 */
export function hasVisibleThreadOverviewChangeSummary(
  summary: ThreadOverviewChangeSummary,
): boolean {
  return summary.additions > 0 || summary.deletions > 0;
}

/**
 * Resolves the Overview Changes row summary from the same priority as the
 * Review default: latest turn, then unstaged worktree, then branch comparison.
 */
export async function resolveThreadOverviewChangeSummary({
  thread,
  snapshots,
  transport,
}: {
  thread: Pick<Thread, "id" | "workspace_id">;
  snapshots?: readonly TurnSnapshot[];
  transport: ThreadOverviewChangeSummaryTransport;
}): Promise<{ snapshots: TurnSnapshot[]; summary: ThreadOverviewChangeSummary }> {
  const resolvedSnapshots = snapshots
    ? [...snapshots]
    : await transport.listSnapshots(thread.id).catch(() => []);
  const latest = latestSnapshotWithChanges(resolvedSnapshots);

  if (latest) {
    const stats = await transport.getSnapshotDiffStats(latest.id).catch(() => []);
    return {
      snapshots: resolvedSnapshots,
      summary: summarizeThreadChangeStats([latest], [stats]),
    };
  }

  const unstagedFiles = await transport
    .getWorkingTreeFiles(thread.workspace_id, false, thread.id)
    .catch(() => []);
  if (unstagedFiles.length > 0) {
    const stat = await transport
      .getReviewDiffStats({
        workspaceId: thread.workspace_id,
        view: "unstaged",
        threadId: thread.id,
      })
      .catch(() => EMPTY_REVIEW_DIFF_STAT);
    return {
      snapshots: resolvedSnapshots,
      summary: summarizeGitChangeStats(unstagedFiles, stat),
    };
  }

  const comparison = await transport
    .getBranchComparison(thread.workspace_id, thread.id)
    .catch(() => null);
  if (
    !comparison ||
    comparison.isUnborn ||
    comparison.isComparisonAvailable === false ||
    !comparison.base ||
    !comparison.target
  ) {
    return { snapshots: resolvedSnapshots, summary: EMPTY_CHANGE_SUMMARY };
  }

  const [files, stat] = await Promise.all([
    transport
      .getBranchFiles(thread.workspace_id, comparison.base, comparison.target, thread.id)
      .catch(() => []),
    transport
      .getReviewDiffStats({
        workspaceId: thread.workspace_id,
        view: "branch",
        base: comparison.base,
        target: comparison.target,
        threadId: thread.id,
      })
      .catch(() => EMPTY_REVIEW_DIFF_STAT),
  ]);

  return {
    snapshots: resolvedSnapshots,
    summary: summarizeGitChangeStats(files, stat),
  };
}

/**
 * Resolves the active thread checkout's repository label, safe URL, and favicon.
 */
export async function resolveThreadOverviewRepository({
  thread,
  transport,
}: {
  thread: Pick<Thread, "id" | "workspace_id">;
  transport: ThreadOverviewRepositoryTransport;
}): Promise<ThreadOverviewRepository> {
  const remote = await transport.getRemoteUrl(thread.workspace_id, thread.id);
  const webUrl = getSafeRepositoryWebUrl(remote.webUrl);
  return {
    label: remote.label,
    webUrl,
    faviconUrl: getRepositoryFaviconUrl(webUrl),
  };
}

function branchRows(branches: readonly GitBranchRecord[], currentBranch: string): GitBranchRecord[] {
  const localBranches = new Map<string, GitBranchRecord>();
  for (const branch of branches) {
    if (branch.type === "remote") continue;
    if (!localBranches.has(branch.name)) localBranches.set(branch.name, branch);
  }

  if (!localBranches.has(currentBranch)) {
    localBranches.set(currentBranch, {
      name: currentBranch,
      shortSha: "",
      type: "local",
      isCurrent: true,
    });
  }

  return [...localBranches.values()].sort((a, b) => {
    if (a.name === currentBranch) return -1;
    if (b.name === currentBranch) return 1;
    return a.name.localeCompare(b.name);
  });
}

interface RepositoryFaviconProps {
  faviconUrl: string | null;
  hasRemote: boolean;
}

function RepositoryFavicon({ faviconUrl, hasRemote }: RepositoryFaviconProps) {
  return (
    <Favicon
      src={faviconUrl}
      frameTestId="thread-overview-repository-favicon-frame"
      imageTestId="thread-overview-repository-favicon"
      fallback={hasRemote ? null : <GitBranch size={14} className="shrink-0 text-muted-foreground" />}
    />
  );
}

interface ThreadOverviewRepositoryRowProps {
  repository: ThreadOverviewRepository;
  status: LoadStatus;
  onOpen: () => void;
}

function ThreadOverviewRepositoryRow({
  repository,
  status,
  onOpen,
}: ThreadOverviewRepositoryRowProps) {
  const isLoading = status === "loading";
  const canOpen = status === "ready" && !!repository.webUrl;
  const label = isLoading ? "Repository" : repository.label;
  const valueIcon =
    isLoading ? null : (
      <RepositoryFavicon
        faviconUrl={repository.faviconUrl}
        hasRemote={canOpen}
      />
    );
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <Globe size={14} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground">
          Repository
        </span>
      </span>
      {isLoading ? (
        <span
          data-testid="thread-overview-repository-loading"
          aria-label="Loading repository"
          className="animate-thread-overview-loading h-3 w-16 shrink-0 overflow-hidden rounded-sm bg-muted/45"
        />
      ) : canOpen ? (
        <span className="flex min-w-0 max-w-[11rem] items-center justify-end gap-1.5">
          {valueIcon}
          <span className="truncate text-xs font-medium text-primary">{label}</span>
          <ExternalLink size={13} aria-hidden className="shrink-0 text-muted-foreground" />
        </span>
      ) : (
        <span className="flex min-w-0 max-w-[11rem] items-center justify-end gap-1.5">
          {valueIcon}
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        </span>
      )}
    </>
  );

  if (canOpen) {
    return (
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={onOpen}
        data-testid="thread-overview-repository"
        aria-label={`Repository, ${label}, open remote`}
        title={repository.webUrl ?? label}
        className="h-8 w-full cursor-pointer justify-between gap-3 px-2 text-left"
      >
        {content}
      </Button>
    );
  }

  return (
    <div
      data-testid="thread-overview-repository"
      aria-label={`Repository, ${label}`}
      title={label}
      className="flex h-8 w-full items-center justify-between gap-3 rounded-[min(var(--radius-md),12px)] px-2 text-left"
    >
      {content}
    </div>
  );
}

interface ThreadOverviewLocalMenuProps {
  worktreePath: string | null;
  branch: string;
}

function ThreadOverviewLocalMenu({ worktreePath, branch }: ThreadOverviewLocalMenuProps) {
  const [copied, setCopied] = useState<LocalCopyTarget | null>(null);

  const copyValue = useCallback(async (target: LocalCopyTarget, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1500);
  }, []);

  return (
    <div data-testid="thread-overview-local-popover" className="animate-popover-enter p-2">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">Worktree path</span>
            <span
              data-testid="thread-overview-local-path"
              className="block max-w-56 truncate font-mono text-xs text-muted-foreground"
            >
              {worktreePath ?? "Unavailable"}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy worktree path"
            disabled={!worktreePath}
            onClick={() => {
              if (worktreePath) void copyValue("path", worktreePath);
            }}
            className="shrink-0"
          >
            {copied === "path" ? <Check size={13} /> : <Copy size={13} />}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">Branch</span>
            <span
              data-testid="thread-overview-local-branch"
              className="block max-w-56 truncate font-mono text-xs text-muted-foreground"
            >
              {branch}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy branch"
            onClick={() => void copyValue("branch", branch)}
            className="shrink-0"
          >
            {copied === "branch" ? <Check size={13} /> : <Copy size={13} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ThreadOverviewBranchMenuProps {
  thread: Thread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ThreadOverviewBranchMenu({
  thread,
  open,
  onOpenChange,
}: ThreadOverviewBranchMenuProps) {
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState<LoadedBranchState>({
    status: "idle",
    branches: [],
    uncommittedFiles: null,
  });

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoaded((previous) => ({ ...previous, status: "loading" }));

    const loadBranches = async () => {
      try {
        const [branches, unstaged, staged] = await Promise.all([
          getTransport().listBranches(thread.workspace_id),
          getTransport().getWorkingTreeFiles(thread.workspace_id, false, thread.id).catch(() => []),
          getTransport().getWorkingTreeFiles(thread.workspace_id, true, thread.id).catch(() => []),
        ]);

        if (cancelled) return;
        setLoaded({
          status: "ready",
          branches,
          uncommittedFiles: new Set([...unstaged, ...staged]).size,
        });
      } catch {
        if (!cancelled) {
          setLoaded((previous) => ({ ...previous, status: "error" }));
        }
      }
    };

    void loadBranches();

    return () => {
      cancelled = true;
    };
  }, [open, thread.id, thread.workspace_id]);

  const branches = useMemo(
    () => branchRows(loaded.branches, thread.branch),
    [loaded.branches, thread.branch],
  );
  const visibleBranches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return branches;
    return branches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [branches, search]);

  const currentBranchUncommittedLabel =
    loaded.uncommittedFiles !== null && loaded.uncommittedFiles > 0
      ? uncommittedFilesLabel(loaded.uncommittedFiles)
      : null;
  const shouldConstrainBranchList = visibleBranches.length > 6;

  return (
    <div
      data-testid="thread-overview-branch-popover"
      className="animate-popover-enter p-2"
    >
      <div className="relative">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          size="xs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search branches"
          aria-label="Search branches"
          className="h-7 pl-7"
        />
      </div>

      <div className="px-1 pb-1 pt-3 text-xs text-muted-foreground">Branches</div>
      <ScrollArea
        data-testid="thread-overview-branch-list"
        className={cn(shouldConstrainBranchList && "h-60")}
      >
        <div className="space-y-0.5 pr-2">
          {loaded.status === "loading" && loaded.branches.length === 0
            ? (
                <div
                  className="animate-thread-overview-loading h-8 overflow-hidden rounded-md bg-muted/35"
                  aria-hidden
                />
              )
            : null}

          {loaded.status !== "loading" || loaded.branches.length > 0
            ? visibleBranches.map((branch) => {
                const isCurrent = branch.name === thread.branch || branch.isCurrent;
                return (
                  <Button
                    key={branch.name}
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      if (isCurrent) onOpenChange(false);
                    }}
                    aria-current={isCurrent ? "true" : undefined}
                    data-testid={isCurrent ? "thread-overview-current-branch" : undefined}
                    className={cn(
                      "h-auto w-full justify-between gap-3 px-2 py-1.5 text-left",
                      isCurrent && "bg-muted text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranch size={13} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{branch.name}</span>
                        {isCurrent && currentBranchUncommittedLabel ? (
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {currentBranchUncommittedLabel}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {isCurrent ? <Check size={14} className="shrink-0 text-muted-foreground" /> : null}
                  </Button>
                );
              })
            : null}

          {loaded.status !== "loading" && visibleBranches.length === 0 ? (
            <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">
              No branches match
            </div>
          ) : null}

          {loaded.status === "error" ? (
            <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">
              Branches unavailable
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <Separator className="my-2" />
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled
        className="h-8 w-full justify-start gap-2 px-2 text-xs disabled:opacity-60"
      >
        <Plus size={14} className="text-muted-foreground" />
        Create and checkout new branch...
      </Button>
    </div>
  );
}

/**
 * Thread-scoped Overview popover for the chat header.
 *
 * It replaces the old workspace dropdown with status rows tied to the active
 * thread: changed files, PR actions, and the thread's worktree mode.
 */
export function ThreadOverview({ thread }: ThreadOverviewProps) {
  const [open, setOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [loadedChangeSummary, setLoadedChangeSummary] = useState<{
    threadId: string;
    snapshotKey: string;
    revision: number;
    summary: ThreadOverviewChangeSummary;
  } | null>(null);
  const [loadedRepository, setLoadedRepository] = useState<{
    threadId: string;
    status: LoadStatus;
    repository: ThreadOverviewRepository;
  } | null>(null);
  const [changeSummaryStatus, setChangeSummaryStatus] = useState<LoadStatus>("idle");

  const {
    prable,
    pr,
    hasCommitsAhead,
    checks,
    openPrDetail,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommitOrPush,
    handleOpenPr,
  } = useThreadGitActions(thread);

  const cachedSnapshots = useDiffStore((s) => s.snapshotsByThread[thread.id]);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const diffRevision = useDiffStore((s) => s.diffRevisionByScope[thread.id] ?? 0);
  const cachedSnapshotKey = useMemo(() => snapshotKey(cachedSnapshots), [cachedSnapshots]);
  const fallbackChangeSummary = useMemo(
    () => {
      const latest = latestSnapshotWithChanges(cachedSnapshots ?? []);
      return latest ? summarizeThreadChangeStats([latest], []) : EMPTY_CHANGE_SUMMARY;
    },
    [cachedSnapshots],
  );
  const changeSummary =
    loadedChangeSummary?.threadId === thread.id &&
    loadedChangeSummary.snapshotKey === cachedSnapshotKey &&
    loadedChangeSummary.revision === diffRevision
      ? loadedChangeSummary.summary
      : fallbackChangeSummary;
  const showChangeSummary = hasVisibleThreadOverviewChangeSummary(changeSummary);
  const isChangeSummaryLoading = open && changeSummaryStatus === "loading";
  const loadedRepositoryForThread =
    loadedRepository?.threadId === thread.id ? loadedRepository : null;
  const repository = loadedRepositoryForThread?.repository ?? EMPTY_REPOSITORY;
  const repositoryStatus = loadedRepositoryForThread?.status ?? "idle";

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setChangeSummaryStatus("loading");

    const loadChangeSummary = async () => {
      try {
        const result = await resolveThreadOverviewChangeSummary({
          thread: { id: thread.id, workspace_id: thread.workspace_id },
          snapshots: cachedSnapshots,
          transport: getTransport(),
        });
        if (cancelled) return;
        if (!cachedSnapshots) setSnapshots(thread.id, result.snapshots);

        setLoadedChangeSummary({
          threadId: thread.id,
          snapshotKey: snapshotKey(result.snapshots),
          revision: diffRevision,
          summary: result.summary,
        });
        setChangeSummaryStatus("ready");
      } catch {
        if (!cancelled) setChangeSummaryStatus("error");
      }
    };

    void loadChangeSummary();

    return () => {
      cancelled = true;
    };
  }, [cachedSnapshotKey, cachedSnapshots, diffRevision, open, setSnapshots, thread.id, thread.workspace_id]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoadedRepository({
      threadId: thread.id,
      status: "loading",
      repository: EMPTY_REPOSITORY,
    });

    const loadRepository = async () => {
      try {
        const repository = await resolveThreadOverviewRepository({
          thread: { id: thread.id, workspace_id: thread.workspace_id },
          transport: getTransport(),
        });
        if (cancelled) return;
        setLoadedRepository({ threadId: thread.id, status: "ready", repository });
      } catch {
        if (!cancelled) {
          setLoadedRepository({
            threadId: thread.id,
            status: "error",
            repository: { label: "Unavailable", webUrl: null, faviconUrl: null },
          });
        }
      }
    };

    void loadRepository();

    return () => {
      cancelled = true;
    };
  }, [open, thread.id, thread.workspace_id]);

  const openChanges = useCallback(() => {
    executeCommand("changes.toggle");
  }, []);

  const openRepository = useCallback(() => {
    if (!repository.webUrl) return;
    if (window.desktopBridge?.openExternalUrl) {
      void window.desktopBridge.openExternalUrl(repository.webUrl);
      return;
    }
    window.open(repository.webUrl, "_blank", "noopener,noreferrer");
  }, [repository.webUrl]);

  const ciDot = useMemo(() => getThreadOverviewCiDot(pr, checks), [pr, checks]);
  const modeLabel = thread.mode === "worktree" ? "Worktree" : "Direct";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              title="Thread overview"
              aria-label="Thread overview"
              data-testid="header-workspace-menu"
              className="relative cursor-pointer text-foreground/70 hover:bg-muted/40 hover:text-foreground"
            >
              <Menu size={14} />
              {ciDot && (
                <span
                  data-testid={`thread-overview-ci-${ciDot}`}
                  aria-hidden
                  className={cn(
                    "absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
                    ciDot === "red" && "bg-[var(--diff-remove-strong)]",
                    ciDot === "green" && "bg-[var(--diff-add-strong)]",
                  )}
                />
              )}
            </Button>
          }
        />
        <PopoverContent align="end" sideOffset={12} className="w-80 p-0">
          <div className="animate-popover-enter p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openChanges}
              data-testid="workspace-menu-changes"
              aria-label={`Changes, ${changedFilesLabel(changeSummary.files)}`}
              className="h-8 w-full cursor-pointer justify-between gap-3 px-2 text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Diff size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-medium">Changes</span>
              </span>
              {isChangeSummaryLoading ? (
                <span
                  data-testid="thread-overview-change-loading"
                  aria-label="Loading changes"
                  className="animate-thread-overview-loading h-3 w-14 shrink-0 overflow-hidden rounded-sm bg-muted/45"
                />
              ) : showChangeSummary ? (
                <span
                  data-testid="thread-overview-change-summary"
                  aria-label={`${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
                  className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
                >
                  <span className="text-[var(--diff-add-strong)]">
                    +{changeSummary.additions}
                  </span>
                  <span className="text-[var(--diff-remove-strong)]">
                    -{changeSummary.deletions}
                  </span>
                </span>
              ) : null}
            </Button>

            <ThreadOverviewRepositoryRow
              repository={repository}
              status={repositoryStatus}
              onOpen={openRepository}
            />

            <Popover open={localOpen} onOpenChange={setLocalOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid="thread-overview-local"
                    aria-label={`${modeLabel}${dirPath ? `, ${dirPath}` : ""}`}
                    className={cn(
                      "h-8 w-full justify-between gap-3 px-2 text-left",
                      localOpen && "bg-muted text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Laptop size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-medium">Local</span>
                    </span>
                    <ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" />
                  </Button>
                }
              />
              <PopoverContent
                align="start"
                side="left"
                sideOffset={12}
                className="w-80 p-0"
              >
                <ThreadOverviewLocalMenu worktreePath={dirPath} branch={thread.branch} />
              </PopoverContent>
            </Popover>

            <Popover open={branchOpen} onOpenChange={setBranchOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid="workspace-menu-branch"
                    className={cn(
                      "h-8 w-full justify-between gap-3 px-2 text-left",
                      branchOpen && "bg-muted text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranch size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-medium">{thread.branch}</span>
                    </span>
                    <ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" />
                  </Button>
                }
              />
              <PopoverContent
                align="start"
                side="left"
                sideOffset={12}
                className="w-72 p-0"
              >
                <ThreadOverviewBranchMenu
                  thread={thread}
                  open={branchOpen}
                  onOpenChange={setBranchOpen}
                />
              </PopoverContent>
            </Popover>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleCommitOrPush}
              data-testid="workspace-menu-commit"
              className="h-8 w-full cursor-pointer justify-start gap-2 px-2 text-xs"
            >
              <Upload size={14} className="text-muted-foreground" />
              Commit or push
            </Button>

            {prable && !pr && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreatePrOpen(true)}
                disabled={!hasCommitsAhead}
                data-testid="workspace-menu-create-pr"
                title={hasCommitsAhead === false ? "No commits ahead of base branch" : undefined}
                className="h-8 w-full cursor-pointer justify-start gap-2 px-2 text-xs disabled:cursor-not-allowed"
              >
                <GitPullRequest size={14} className="text-muted-foreground" />
                Create PR
              </Button>
            )}

            {prable && pr && (
              <div data-testid="thread-overview-pr" className="px-2 py-1.5">
                <PrSplitButton
                  pr={pr}
                  hasCommitsAhead={hasCommitsAhead}
                  onCreatePr={() => setCreatePrOpen(true)}
                  onOpenPr={handleOpenPr}
                  checks={checks}
                  threadId={thread.id}
                  prTitle={openPrDetail?.title}
                  prAuthor={openPrDetail?.author}
                />
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {prable && (
        <CreatePrDialog
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          threadId={thread.id}
          workspaceId={thread.workspace_id}
          branch={thread.branch}
        />
      )}
    </>
  );
}
