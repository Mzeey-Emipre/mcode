import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { SiteFavicon } from "@/components/ui/favicon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PrSplitButton } from "./PrSplitButton";
import { CreatePrDialog } from "./CreatePrDialog";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { executeCommand } from "@/lib/command-registry";
import { getContentRowWidth, shouldAutoOpenOverview } from "@/lib/composer-layout";
import { extractThreadSources, type ThreadSource } from "@/lib/message-sources";
import { isModifierClick, isPreviewableUrl, openUrlInPreview } from "@/lib/open-url-in-preview";
import { cn } from "@/lib/utils";
import {
  getTransport,
  type GitBranch as GitBranchRecord,
  type McodeTransport,
  type Thread,
} from "@/transport";
import type { ChecksStatus, Message, TurnSnapshot } from "@mcode/contracts";

/** Stable empty messages reference so the closed Overview never re-renders on new messages. */
const EMPTY_MESSAGES: Message[] = [];

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
  const canOpen = status === "ready" && !!repository.webUrl;
  const label = repository.label;

  if (!canOpen) return null;

  return (
    <div className="grid animate-thread-overview-row-reveal">
      <div className="min-h-0 overflow-hidden">
        <div
          data-testid="thread-overview-repository"
          className="flex w-full flex-col gap-1.5 px-2 py-1.5"
        >
          <span className="font-mono text-xs font-medium uppercase leading-tight tracking-[0.18em] text-muted-foreground">
            REPOSITORY
          </span>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onOpen}
            data-testid="thread-overview-repository-link"
            aria-label={`Open ${label} on remote`}
            title={repository.webUrl ?? label}
            className="-mx-1.5 h-7 min-w-0 justify-start gap-1.5 rounded-md px-1.5 text-left text-primary hover:bg-muted/50 hover:text-primary focus-visible:ring-inset"
          >
            <SiteFavicon
              src={repository.faviconUrl}
              frameTestId="thread-overview-repository-favicon-frame"
              imageTestId="thread-overview-repository-favicon"
              fallback={<GitBranch size={14} className="shrink-0 text-muted-foreground" />}
            />
            <span className="truncate text-xs font-medium">{label}</span>
            <ExternalLink size={12} aria-hidden className="shrink-0 text-muted-foreground" />
          </Button>
        </div>
      </div>
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

interface ThreadOverviewSourcesProps {
  sources: ThreadSource[];
  onOpen: (event: React.MouseEvent, url: string) => void;
}

/**
 * Renders the deduped external links the assistant produced this thread as a
 * compact favicon grid. Each chip shows its full URL on hover and reuses the
 * standard link-open behavior (Ctrl/Cmd+click opens in the in-app preview,
 * plain click opens the system browser).
 */
function ThreadOverviewSources({ sources, onOpen }: ThreadOverviewSourcesProps) {
  if (sources.length === 0) return null;

  return (
    <div data-testid="thread-overview-sources" className="flex w-full flex-col gap-1.5 px-2 py-1.5">
      <span className="font-mono text-xs font-medium uppercase leading-tight tracking-[0.18em] text-muted-foreground">
        SOURCES
      </span>
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => (
          <Tooltip key={source.url}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={source.url}
                  data-testid="thread-overview-source"
                  onClick={(event) => onOpen(event, source.url)}
                  className="size-6 rounded-md hover:bg-muted/50"
                >
                  <SiteFavicon
                    src={source.faviconUrl}
                    fallback={<Globe size={13} className="text-muted-foreground" />}
                  />
                </Button>
              }
            />
            <TooltipContent side="top" className="max-w-xs break-all text-xs">
              {source.url}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

type ThreadOverviewPr = { number: number; url: string; state: string } | null;
type PrRowTone = "positive" | "danger" | "neutral" | "muted";

function getPrRowStatus(
  pr: ThreadOverviewPr,
  hasCommitsAhead: boolean | null,
  checks: ChecksStatus | null,
): { label: string; tone: PrRowTone } {
  if (pr) {
    const state = pr.state.toLowerCase();
    if (state === "open") {
      if (checks?.aggregate === "failing") return { label: "Checks failing", tone: "danger" };
      if (checks?.aggregate === "passing") return { label: "Checks passing", tone: "positive" };
      if (checks?.aggregate === "pending") return { label: "Checks running", tone: "neutral" };
      return { label: "Open", tone: "positive" };
    }
    if (state === "merged") return { label: "Merged", tone: "positive" };
    if (state === "closed") return { label: "Closed", tone: "danger" };
    return { label: pr.state, tone: "neutral" };
  }

  if (hasCommitsAhead === true) return { label: "Ready", tone: "neutral" };
  if (hasCommitsAhead === false) return { label: "No commits ahead", tone: "muted" };
  return { label: "Checking", tone: "muted" };
}

interface ThreadOverviewPrRowProps {
  pr: ThreadOverviewPr;
  hasCommitsAhead: boolean | null;
  checks: ChecksStatus | null;
  openPrDetail: { title?: string; author?: string } | null;
  threadId: string;
  onCommitOrPush: () => void;
  onCreatePr: () => void;
  onOpenPr: (url: string, event?: React.MouseEvent) => void;
}

function ThreadOverviewPrRow({
  pr,
  hasCommitsAhead,
  checks,
  openPrDetail,
  threadId,
  onCommitOrPush,
  onCreatePr,
  onOpenPr,
}: ThreadOverviewPrRowProps) {
  const status = getPrRowStatus(pr, hasCommitsAhead, checks);
  const badgeVariant =
    status.tone === "danger"
      ? "destructive"
      : status.tone === "positive"
        ? "secondary"
        : status.tone === "muted"
          ? "outline"
          : "ghost";

  return (
    <div
      data-testid="thread-overview-pr"
      className="flex w-full items-center justify-between gap-2 px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium">Pull request</span>
            <Badge
              variant={badgeVariant}
              size="sm"
              data-testid="thread-overview-pr-status"
              className="max-w-32 truncate"
            >
              {status.label}
            </Badge>
          </div>
          <span
            data-testid="thread-overview-pr-detail"
            className="block truncate text-xs text-muted-foreground"
          >
            {pr ? `#${pr.number}` : "No PR yet"}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                onClick={onCommitOrPush}
                data-testid="workspace-menu-commit"
                aria-label="Commit or push"
                className="cursor-pointer text-foreground/70 hover:text-foreground"
              >
                <Upload size={13} className="text-muted-foreground" />
              </Button>
            }
          />
          <TooltipContent side="bottom" className="text-xs">
            Commit or push
          </TooltipContent>
        </Tooltip>

        <PrSplitButton
          pr={pr}
          hasCommitsAhead={hasCommitsAhead}
          onCreatePr={onCreatePr}
          onOpenPr={onOpenPr}
          checks={checks}
          threadId={threadId}
          prTitle={openPrDetail?.title}
          prAuthor={openPrDetail?.author}
          createButtonTestId="workspace-menu-create-pr"
          primaryButtonTestId="workspace-menu-open-pr"
        />
      </div>
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

  // Space-aware open: the Overview sits open when there is room and steps aside
  // when the right panel or a narrow viewport leaves none, until the user takes
  // manual control of it for this thread.
  const panelVisible = useDiffStore((s) => s.getRightPanelVisible(thread.workspace_id, thread.id));
  const panelWidth = useDiffStore((s) => s.getRightPanel(thread.workspace_id, thread.id).width);
  const measuredContentRowWidth = useLayoutStore((s) => s.contentRowWidth);
  const [open, setOpen] = useState(false);
  const autoManagedRef = useRef(true);
  const lastAutoValueRef = useRef<boolean | null>(null);

  useEffect(() => {
    autoManagedRef.current = true;
  }, [thread.id]);

  // Whether there is room for the Overview to open by default. Driven by the
  // reactive content-row width so it tracks resizes and panel changes without
  // racing the layout guard's measurement.
  const hasRoom = useMemo(
    () =>
      shouldAutoOpenOverview({
        contentRowWidth: measuredContentRowWidth || getContentRowWidth(),
        rightPanelVisible: panelVisible,
        rightPanelWidth: panelWidth,
      }),
    [measuredContentRowWidth, panelVisible, panelWidth],
  );

  // The Overview opens by default when there is room and steps aside when a
  // narrow viewport or the right panel leaves none, until the user takes manual
  // control of it for this thread. The echo guard ignores base-ui's onOpenChange
  // when our own programmatic open/close round-trips.
  useEffect(() => {
    if (!autoManagedRef.current) return;
    lastAutoValueRef.current = hasRoom;
    setOpen(hasRoom);
  }, [hasRoom]);

  const handleOpenChange = useCallback((next: boolean, eventDetails?: { reason?: string }) => {
    // Clicking elsewhere (or focus leaving) must not close the Overview; only the
    // trigger button and Escape do. base-ui is controlled, so ignoring the change
    // keeps it open.
    if (!next && (eventDetails?.reason === "outside-press" || eventDetails?.reason === "focus-out")) {
      return;
    }
    if (next !== lastAutoValueRef.current) autoManagedRef.current = false;
    setOpen(next);
  }, []);

  // Reserve room on the right only when open AND there's space (wide view); on a
  // small view the popover floats over the chat instead of squeezing it.
  const setReserveSpace = useOverviewStore((s) => s.setReserveSpace);
  useEffect(() => {
    setReserveSpace(open && hasRoom);
    return () => setReserveSpace(false);
  }, [open, hasRoom, setReserveSpace]);

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

  // Subscribe to messages only while the Overview is open so a closed popover
  // never re-renders as the thread streams; sources are computed lazily here.
  const sourceMessages = useThreadStore((s) =>
    open ? (s.records.get(thread.id)?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const sources = useMemo(
    () => (open ? extractThreadSources(sourceMessages) : []),
    [open, sourceMessages],
  );

  const openSource = useCallback(
    (event: React.MouseEvent, url: string) => {
      if (isModifierClick(event) && window.desktopBridge?.preview && isPreviewableUrl(url)) {
        openUrlInPreview({ url, threadId: thread.id });
        return;
      }
      if (window.desktopBridge?.openExternalUrl) {
        void window.desktopBridge.openExternalUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    [thread.id],
  );

  const ciDot = useMemo(() => getThreadOverviewCiDot(pr, checks), [pr, checks]);
  const modeLabel = thread.mode === "worktree" ? "Worktree" : "Direct";

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      type="button"
      title="Thread overview"
      aria-label="Thread overview"
      data-testid="header-workspace-menu"
      className={cn(
        "relative cursor-pointer text-foreground/70 hover:bg-muted/40 hover:text-foreground",
        open && "bg-muted text-foreground",
      )}
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
  );

  const overviewBody = (
    <div data-testid="thread-overview-body" className="animate-overview-enter p-1.5">
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

            {prable && (
              <ThreadOverviewPrRow
                pr={pr}
                hasCommitsAhead={hasCommitsAhead}
                checks={checks}
                openPrDetail={openPrDetail}
                threadId={thread.id}
                onCommitOrPush={handleCommitOrPush}
                onCreatePr={() => setCreatePrOpen(true)}
                onOpenPr={handleOpenPr}
              />
            )}

            {sources.length > 0 && (
              <>
                <Separator className="my-1.5" />
                <ThreadOverviewSources sources={sources} onOpen={openSource} />
              </>
            )}
    </div>
  );

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger render={triggerButton} />
        {/*
          Pin the popover to the far right edge with a comfortable gap below the
          trigger. NOTE: base-ui's alignOffset is inverted from what you'd expect
          for align="end" — a POSITIVE value moves the popover LEFT, a NEGATIVE
          value moves it RIGHT. The large negative offset overshoots to the right
          so collision detection clamps it to `collisionPadding` from the edge.
          collisionPadding matches the header's right padding (pr-4 = 16px) so the
          popover's right edge lines up with the rightmost header icon.
        */}
        <PopoverContent
          align="end"
          sideOffset={18}
          alignOffset={-40}
          collisionPadding={8}
          className="w-80 p-0"
        >
          {overviewBody}
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
