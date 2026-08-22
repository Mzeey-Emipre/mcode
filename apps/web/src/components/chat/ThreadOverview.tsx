import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Diff,
  ExternalLink,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  Info,
  Laptop,
  ListChecks,
  MousePointer2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Settings2,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { SiteFavicon } from "@/components/ui/favicon";
import { Input } from "@/components/ui/input";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PrSplitButton } from "./PrSplitButton";
import { ChecksPopover } from "./ChecksPopover";
import { CreatePrDialog } from "./CreatePrDialog";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { usePullRequestReviewLink } from "@/features/pull-requests";
import { useThreadRecap } from "@/hooks/useThreadRecap";
import {
  isEmptyPreviewTabUrl,
  browserAutomationTargetKey,
  findPendingBrowserAutomationOpen,
  isModifierClick,
  isPreviewableUrl,
  openUrlInPreview,
  useBrowserAutomationStore,
  usePreviewTabSet,
  usePreviewTabsStore,
} from "@/features/preview";
import {
  getBreakdown,
  getCiOverviewSummaryLabel,
  getCiSummaryHeadline,
} from "@/lib/ci-status";
import { useDiffStore } from "@/stores/diffStore";
import type {
  BrowserAutomationLiveTarget,
  BrowserAutomationPendingAgentOpen,
} from "@/features/preview";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  ProjectSetupAttemptCard,
  ProjectSetupMenu,
  ProjectAutomaticSetupCard,
  useProjectAutomaticSetup,
  useProjectSetupAttempt,
} from "@/features/projects/environment";
import { useOverviewStore } from "@/stores/overviewStore";
import { usePlanStore } from "@/stores/planStore";
import { executeCommand, registerCommand } from "@/lib/command-registry";
import { shouldAutoOpenOverview } from "@/lib/composer-layout";
import { extractThreadSources, type ThreadSource } from "@/lib/message-sources";
import { sanitizeCustomBranchInput, trimTrailingBranchChars } from "@/lib/branch-name";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import {
  openSubagentsRoster,
  projectSubagents,
  SubagentIdentityGlyph,
} from "@/features/subagents";
import { cn } from "@/lib/utils";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { formatUsageResetText } from "@/lib/usage-reset-format";
import {
  getTransport,
  type GitBranch as GitBranchRecord,
  type McodeTransport,
  type Thread,
} from "@/transport";
import type {
  BrowserAutomationControllerState,
  BrowserTabInfo,
  BrowserTabSet,
  ChecksStatus,
  Message,
  PlanRecord,
  ProviderUsageInfo,
  QuotaCategory,
  TurnSnapshot,
} from "@mcode/contracts";
import type { BrowserSessionLifecycleTab } from "@/features/preview";

/** Stable empty messages reference so the closed Overview never re-renders on new messages. */
const EMPTY_MESSAGES: Message[] = [];
/** Stable empty plans reference so closed Overview selectors never allocate. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

/** CI dot shown on the Overview trigger for terminal check states. */
export type ThreadOverviewCiDot = "red" | "green" | null;

/** Props for {@link ThreadOverview}. */
interface ThreadOverviewProps {
  thread: Thread;
  /** Width of the chat pane that contains this thread's timeline and composer. */
  threadPaneWidth: number;
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
type CiSegmentName = "failing" | "running" | "passing" | "cancelled";

const CI_SEGMENT_COLORS: Record<CiSegmentName, string> = {
  failing: "var(--diff-remove-strong)",
  running: "var(--primary)",
  passing: "var(--diff-add-strong)",
  cancelled: "var(--muted-foreground)",
};

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

const OVERVIEW_ROW_CLASS =
  "group h-8 w-full gap-3 px-2 text-left transition-[background-color,color,transform] duration-150 ease-out active:translate-y-px motion-reduce:transform-none";

const EMPTY_BROWSER_PENDING_OPENS: ReadonlyMap<string, BrowserAutomationPendingAgentOpen> = new Map();

/** One Browser tab row joined from a live target and tab chrome. */
export interface ThreadOverviewBrowserTab {
  readonly tab: BrowserTabInfo;
  readonly lifecycle?: BrowserSessionLifecycleTab;
  readonly controller: BrowserAutomationControllerState["controller"] | undefined;
}

function browserPendingTab(tab: BrowserTabInfo, pendingUrl: string | null): BrowserTabInfo {
  if (!pendingUrl || !isEmptyPreviewTabUrl(tab.url)) return tab;
  let title: string | null = null;
  try {
    title = new URL(pendingUrl).hostname || null;
  } catch {
    // The Browser host remains responsible for rejecting invalid navigation URLs.
  }
  return { ...tab, title, url: pendingUrl };
}

/**
 * Selects navigated Browser rows for one exact workspace/thread scope. Live
 * targets provide row membership; lifecycle state only supplies fallback
 * controller metadata.
 */
export function getThreadOverviewBrowserTabs({
  workspaceId,
  threadId,
  tabSet,
  lifecycleTabs,
  liveTargets,
  controllers,
  pendingAgentOpens = EMPTY_BROWSER_PENDING_OPENS,
}: {
  workspaceId: string;
  threadId: string;
  tabSet: BrowserTabSet | null;
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens?: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
}): ThreadOverviewBrowserTab[] {
  if (!tabSet || tabSet.threadId !== threadId) return [];

  const lifecycleByTarget = new Map<string, BrowserSessionLifecycleTab>();
  for (const lifecycle of lifecycleTabs.values()) {
    if (
      lifecycle.workspaceId !== workspaceId ||
      lifecycle.threadId !== threadId ||
      lifecycle.target.threadId !== threadId ||
      lifecycle.target.tabId !== lifecycle.tabId
    ) continue;
    lifecycleByTarget.set(browserAutomationTargetKey(workspaceId, threadId, lifecycle.tabId), lifecycle);
  }

  return tabSet.tabs.flatMap((tab) => {
    if (tab.threadId !== threadId) return [];
    const targetKey = browserAutomationTargetKey(workspaceId, threadId, tab.id);
    const pendingOpen = findPendingBrowserAutomationOpen(
      pendingAgentOpens,
      workspaceId,
      threadId,
      tab.id,
    );
    const pendingUrl = pendingOpen?.url?.trim() || null;
    if (isEmptyPreviewTabUrl(tab.url) && !pendingUrl) return [];
    const liveTarget = liveTargets.get(targetKey);
    if (
      !pendingOpen &&
      (!liveTarget ||
        liveTarget.workspaceId !== workspaceId ||
        liveTarget.threadId !== threadId ||
        liveTarget.tabId !== tab.id)
    ) {
      return [];
    }
    const lifecycle = lifecycleByTarget.get(targetKey);
    const controller = lifecycle?.ownership === "released"
      ? undefined
      : controllers.get(targetKey)?.controller ??
        lifecycle?.target.controller?.controller ??
        (pendingOpen ? "agent" : undefined);
    return [{
      tab: browserPendingTab(tab, pendingUrl),
      ...(lifecycle ? { lifecycle } : {}),
      controller,
    }];
  });
}

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

function usageCategoryShortLabel(label: string): string {
  const normalized = label.trim();
  if (/^5[- ]hour/i.test(normalized)) return "5-hour";
  if (/^weekly/i.test(normalized)) return "weekly";
  if (/^api/i.test(normalized)) return "API";
  if (/auto|composer/i.test(normalized)) return "Auto";
  return normalized;
}

function usageCategoryPercent(category: QuotaCategory): number {
  if (typeof category.used === "number" && typeof category.total === "number" && category.total > 0) {
    return (category.used / category.total) * 100;
  }
  return (1 - category.remainingPercent) * 100;
}

function usageCategoryPriority(category: QuotaCategory): number {
  const label = category.label.trim();
  if (/^5[- ]hour/i.test(label)) return 0;
  if (/^weekly/i.test(label)) return 1;
  return 2;
}

function usageCategoryFillClass(category: QuotaCategory): string {
  const percent = usageCategoryPercent(category);
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-primary";
  return "bg-[var(--diff-add-strong)]";
}

function usageCategoryMetricClass(category: QuotaCategory): string {
  const percent = usageCategoryPercent(category);
  if (percent >= 90) return "text-destructive";
  if (percent >= 70) return "text-primary";
  return "text-foreground/80";
}

/**
 * Returns the Overview session-cost label only for provider-proven API-key billing.
 */
export function formatThreadOverviewSessionCost(
  usageInfo: ProviderUsageInfo | undefined,
): string | null {
  if (usageInfo?.billingMode !== "api_key") return null;
  const sessionCostUsd = usageInfo.sessionCostUsd;
  if (typeof sessionCostUsd !== "number" || !Number.isFinite(sessionCostUsd)) return null;
  return `$${sessionCostUsd.toFixed(2)} session`;
}

/**
 * Returns capped quota categories in priority order for the Overview Usage panel.
 */
export function getThreadOverviewUsageCategories(
  usageInfo: ProviderUsageInfo | undefined,
  providerId = usageInfo?.providerId,
): QuotaCategory[] {
  if (providerId === "cursor") return [];
  return (
    usageInfo?.quotaCategories
      .filter((category) => !category.isUnlimited)
      .sort((a, b) => (
        usageCategoryPriority(a) - usageCategoryPriority(b)
        || usageCategoryPercent(b) - usageCategoryPercent(a)
      )) ?? []
  );
}

/**
 * Formats provider quota limits for compact Overview labels.
 */
export function formatThreadOverviewUsage(
  usageInfo: ProviderUsageInfo | undefined,
  providerId = usageInfo?.providerId,
): string | null {
  if (providerId === "cursor") return null;
  const categories = getThreadOverviewUsageCategories(usageInfo, providerId);
  const costSummary = formatThreadOverviewSessionCost(usageInfo);

  const quotaSummary = categories.length > 0
    ? categories
      .slice(0, 2)
      .map((category) => {
        const percent = Math.round(usageCategoryPercent(category));
        return `${usageCategoryShortLabel(category.label)} ${percent}%`;
      })
      .join(", ")
    : null;

  const statusSummary = (() => {
    if (quotaSummary || costSummary) return null;
    if (usageInfo?.usageStatus === "ready-empty") return "No capped quota";
    if (usageInfo?.usageStatus === "unsupported") return "Usage not supported";
    if (usageInfo?.usageStatus === "unavailable") return "Usage unavailable";
    return null;
  })();

  return [quotaSummary, costSummary, statusSummary].filter(Boolean).join(", ") || null;
}

interface ThreadOverviewUsageBarsProps {
  categories: QuotaCategory[];
  summary: string;
  sessionCostSummary: string | null;
  usageStatus?: ProviderUsageInfo["usageStatus"];
}

const THREAD_OVERVIEW_USAGE_DETAILS_ID = "thread-overview-usage-details-panel";

/** Expandable quota usage row for the Thread Overview popover. */
function ThreadOverviewUsageBars({
  categories,
  summary,
  sessionCostSummary,
  usageStatus,
}: ThreadOverviewUsageBarsProps) {
  const [open, setOpen] = useState(true);

  if (categories.length === 0) {
    return (
      <div
        data-testid="thread-overview-usage"
        aria-label={`Usage, ${summary}`}
        className="flex h-8 w-full items-center justify-between gap-3 px-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Gauge aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">Usage</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {summary}
        </span>
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="thread-overview-usage-section"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="thread-overview-usage"
          aria-label={`Usage, ${summary}`}
          aria-controls={THREAD_OVERVIEW_USAGE_DETAILS_ID}
          className="h-8 w-full cursor-pointer justify-between gap-3 px-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Gauge aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-medium">Usage</span>
          </span>
          <span className="flex min-w-0 shrink items-center gap-2">
            {!open ? (
              <span className="min-w-0 truncate font-mono text-xs tabular-nums text-muted-foreground">
                {summary}
              </span>
            ) : null}
            <ChevronDown
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-muted-foreground transition-transform duration-250 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </span>
        </Button>
      </CollapsibleTrigger>

      <AnimatedCollapsible open={open}>
        <div
          id={THREAD_OVERVIEW_USAGE_DETAILS_ID}
          data-testid="thread-overview-usage-details"
          aria-hidden={!open}
          className="flex gap-2 px-2 pb-2 pt-1 text-muted-foreground"
        >
          <span aria-hidden className="size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-3">
            {categories.map((category) => {
              const percent = Math.min(Math.max(usageCategoryPercent(category), 0), 100);
              const rounded = Math.round(percent);
              const shortLabel = usageCategoryShortLabel(category.label);
              const displayLabel = category.label.trim();
              const resetText = formatUsageResetText(category.resetDate);
              const progressDescription = resetText
                ? `${shortLabel} usage ${rounded} percent. ${resetText}`
                : `${shortLabel} usage ${rounded} percent`;
              return (
                <div key={category.label} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-xs text-foreground/80">{displayLabel}</span>
                    <span
                      data-testid="thread-overview-usage-value"
                      className={cn(
                        "shrink-0 font-mono text-xs font-medium tabular-nums",
                        usageCategoryMetricClass(category),
                      )}
                    >
                      {rounded}%
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={progressDescription}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={rounded}
                    className="h-1 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
                        open && "animate-thread-overview-usage-fill",
                        usageCategoryFillClass(category),
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  {resetText ? (
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      {resetText}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {usageStatus === "stale" ? (
              <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground/60">
                STALE
              </div>
            ) : null}
            {sessionCostSummary ? (
              <div className="flex items-baseline justify-between gap-3 pt-1">
                <span className="min-w-0 truncate text-xs text-foreground/80">Session cost</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {sessionCostSummary}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </AnimatedCollapsible>
    </Collapsible>
  );
}

/**
 * Returns whether a branchless worktree can enter the Create PR naming step.
 */
export function canStartBranchlessCreatePr(
  thread: Pick<Thread, "mode" | "checkout_state">,
): boolean {
  return thread.mode === "worktree" && thread.checkout_state === "branchless";
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

interface ThreadOverviewRecapRowProps {
  recapText: string | null;
  hasCoverageGap: boolean;
  coveredThrough: string | null;
  latestActivityAt: string | null;
  isGenerating: boolean;
  error: string | null;
  onRefresh: () => void;
}

function formatThreadRecapTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function ThreadOverviewRecapRow({
  recapText,
  hasCoverageGap,
  coveredThrough,
  latestActivityAt,
  isGenerating,
  error,
  onRefresh,
}: ThreadOverviewRecapRowProps) {
  const label = recapText ?? (error ? "Recap unavailable" : "No recap yet");
  const refreshLabel = isGenerating ? "Refreshing recap" : "Refresh recap";
  const coverageLabel = hasCoverageGap && coveredThrough && latestActivityAt
    ? {
      coveredThrough: formatThreadRecapTime(coveredThrough),
      latestActivityAt: formatThreadRecapTime(latestActivityAt),
    }
    : null;

  return (
    <div
      data-testid="thread-overview-recap"
      className="w-full px-2.5 py-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Recap</span>
        <div className="-mr-1 flex shrink-0 items-center gap-0.5">
          {coverageLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    data-testid="thread-overview-recap-coverage"
                    aria-label={`Covered through ${coverageLabel.coveredThrough}. Latest activity ${coverageLabel.latestActivityAt}`}
                    className="shrink-0 text-muted-foreground/55 hover:text-muted-foreground focus-visible:text-muted-foreground"
                  >
                    <Info size={12} aria-hidden />
                  </Button>
                }
              />
              <TooltipContent side="bottom" align="end" className="flex-col items-start gap-0.5">
                <span>Covered through {coverageLabel.coveredThrough}</span>
                <span>Latest activity {coverageLabel.latestActivityAt}</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  data-testid="thread-overview-recap-refresh"
                  aria-label={refreshLabel}
                  disabled={isGenerating}
                  onClick={onRefresh}
                  className={cn("group shrink-0", isGenerating && "text-muted-foreground/45")}
                >
                  <RefreshCw
                    size={13}
                    aria-hidden
                    className="transition-transform duration-200 ease-out group-active:rotate-45 motion-reduce:transition-none"
                  />
                </Button>
              }
            />
            <TooltipContent>{refreshLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {isGenerating ? (
        <div
          data-testid="thread-overview-recap-skeleton"
          role="status"
          aria-label={refreshLabel}
          className="mt-2 flex w-full flex-col gap-1.5"
        >
          <span className="sr-only">{refreshLabel}</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden
              className="h-2.5 rounded-full bg-muted/80 animate-[plan-fade_1.8s_ease-in-out_infinite]"
              style={{
                width: `${[88, 76, 48][i]}%`,
                animationDelay: `${i * 0.16}s`,
              }}
            />
          ))}
        </div>
      ) : (
        <p
          data-testid="thread-overview-recap-text"
          className={cn(
            "mt-2 max-w-[26rem] whitespace-normal break-words text-xs leading-[1.45]",
            recapText ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {label}
        </p>
      )}
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
  onCreateBranch: () => void;
  hasCommitsAhead: boolean | null;
}

function ThreadOverviewBranchMenu({
  thread,
  open,
  onOpenChange,
  onCreateBranch,
  hasCommitsAhead,
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

  const displayBranch = thread.checkout_state === "branchless" ? "HEAD" : thread.branch;
  const branches = useMemo(
    () => branchRows(loaded.branches, displayBranch),
    [loaded.branches, displayBranch],
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
  const canCreateCheckoutBranch =
    thread.checkout_state === "named" &&
    loaded.status === "ready" &&
    (hasCommitsAhead === true ||
      (loaded.uncommittedFiles !== null && loaded.uncommittedFiles > 0));

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
                const isCurrent = thread.checkout_state === "named" && (branch.name === thread.branch || branch.isCurrent);
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
        disabled={!canCreateCheckoutBranch}
        data-testid="thread-overview-create-checkout-branch"
        className="h-8 w-full justify-start gap-2 px-2 text-xs disabled:opacity-60"
        title={
          canCreateCheckoutBranch
            ? "Create and checkout a new branch"
            : "Detected changes required"
        }
        onClick={() => {
          if (!canCreateCheckoutBranch) return;
          onOpenChange(false);
          onCreateBranch();
        }}
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

interface ThreadOverviewBrowserSectionProps {
  rows: readonly ThreadOverviewBrowserTab[];
  onOpen: (tabId: string) => void;
}

/** Renders navigated live Browser tabs that can be opened in this thread. */
function ThreadOverviewBrowserSection({ rows, onOpen }: ThreadOverviewBrowserSectionProps) {
  if (rows.length === 0) return null;

  return (
    <section aria-label="Browser" data-testid="thread-overview-browser">
      <Separator className="my-1.5" />
      <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">Browser</div>
      <div className="flex w-full flex-col gap-0.5">
        {rows.map(({ tab, controller }) => {
          const title = tab.title?.trim() || "Untitled page";
          const address = tab.url?.trim() || "No address";
          const isAgentControlled = controller === "agent";

          return (
            <Tooltip key={tab.id}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`thread-overview-browser-tab-${tab.id}`}
                    aria-label={`Browser, ${title}, ${address}${isAgentControlled ? ", agent controls" : ""}`}
                    onClick={() => onOpen(tab.id)}
                    className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isAgentControlled ? (
                        <MousePointer2
                          className="size-3.5 shrink-0 fill-primary text-primary"
                          aria-label="Agent controls this Browser tab"
                          data-testid="thread-overview-browser-agent-cursor"
                        />
                      ) : (
                        <SiteFavicon
                          src={tab.faviconUrl}
                          fallback={<Globe size={14} className="text-muted-foreground" />}
                        />
                      )}
                      <span className="min-w-0 truncate text-xs font-medium">{title}</span>
                    </span>
                    <span
                      data-testid={`thread-overview-browser-address-${tab.id}`}
                      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-right font-mono text-xs tabular-nums text-muted-foreground [mask-image:linear-gradient(to_right,transparent_0,black_1.25rem)]"
                    >
                      {address}
                    </span>
                  </Button>
                }
              />
              <TooltipContent side="top" className="max-w-xs break-all text-xs">
                {address}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
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
      <span className="text-xs font-medium text-muted-foreground">
        Sources
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
): { label: string | null; tone: PrRowTone } {
  if (pr) {
    const state = pr.state.toLowerCase();
    if (state === "open") {
      if (checks?.aggregate === "failing") return { label: getCiSummaryHeadline(checks), tone: "danger" };
      if (checks?.aggregate === "passing") return { label: getCiSummaryHeadline(checks), tone: "positive" };
      if (checks?.aggregate === "pending") return { label: getCiSummaryHeadline(checks), tone: "neutral" };
      return { label: null, tone: "positive" };
    }
    if (state === "merged") return { label: "Merged", tone: "positive" };
    if (state === "closed") return { label: "Closed", tone: "danger" };
    return { label: pr.state, tone: "neutral" };
  }

  if (hasCommitsAhead === true) return { label: "Ready", tone: "neutral" };
  if (hasCommitsAhead === false) return { label: "No commits ahead", tone: "muted" };
  return { label: "Checking", tone: "muted" };
}

/**
 * Derives the PR row subtitle from PR state and branch readiness.
 */
export function getPrRowDetail(
  pr: ThreadOverviewPr,
  openPrDetail: { title?: string } | null,
): string | null {
  if (pr) return openPrDetail?.title?.trim() || null;
  return null;
}

/** Builds the segmented ring that summarizes CI run outcomes in the Overview. */
export function getCiStatusRingStyle(checks: ChecksStatus): CSSProperties {
  const breakdown = getBreakdown(checks);
  const total = breakdown.total || 1;
  const segments = ([
    { name: "failing", count: breakdown.failing },
    { name: "running", count: breakdown.running },
    { name: "passing", count: breakdown.passing },
    { name: "cancelled", count: breakdown.other },
  ] satisfies Array<{ name: CiSegmentName; count: number }>).filter((segment) => segment.count > 0);

  const ringMask = "radial-gradient(circle, transparent 42%, black 46%)";

  if (segments.length === 0) {
    return {
      background: "var(--muted)",
      maskImage: ringMask,
      WebkitMaskImage: ringMask,
    };
  }

  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    cursor += (segment.count / total) * 100;
    const end = Math.min(100, cursor);
    return `${CI_SEGMENT_COLORS[segment.name]} ${start}% ${end}%`;
  });

  return {
    background: `conic-gradient(${stops.join(", ")})`,
    maskImage: ringMask,
    WebkitMaskImage: ringMask,
  };
}

function ThreadOverviewCiStatusCircle({ checks }: { checks: ChecksStatus }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <span
        aria-hidden
        data-testid="thread-overview-ci-status-circle"
        className="size-3.5 rounded-full"
        style={getCiStatusRingStyle(checks)}
      />
    </span>
  );
}

interface ThreadOverviewPrRowProps {
  pr: ThreadOverviewPr;
  hasCommitsAhead: boolean | null;
  checks: ChecksStatus | null;
  openPrDetail: { title?: string; author?: string } | null;
  threadId: string;
  onCommitOrPush: () => void;
  onCreatePr: () => void;
  onOpenPr: (url: string, event?: MouseEvent) => void;
}

function ThreadOverviewPrActionRow({
  hasCommitsAhead,
  onCommitOrPush,
  onCreatePr,
}: Pick<ThreadOverviewPrRowProps, "hasCommitsAhead" | "onCommitOrPush" | "onCreatePr">) {
  if (hasCommitsAhead === false) {
    return (
      <div data-testid="thread-overview-pr">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="workspace-menu-commit"
          className={cn(
            OVERVIEW_ROW_CLASS,
            "cursor-pointer justify-start text-xs text-foreground/75 hover:bg-muted/40 hover:text-foreground",
          )}
          onClick={onCommitOrPush}
          title="Ask the agent to commit and push the changes"
        >
          <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
          <span className="font-medium">Commit or push</span>
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="thread-overview-pr">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        data-testid="workspace-menu-create-pr"
        className={cn(
          OVERVIEW_ROW_CLASS,
          "cursor-pointer justify-start text-xs text-foreground/75 hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        )}
        onClick={onCreatePr}
        disabled={!hasCommitsAhead}
        title={hasCommitsAhead ? "Create pull request" : "Waiting for commits ahead of base branch"}
      >
        <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium">Create PR</span>
      </Button>
    </div>
  );
}

function ThreadOverviewPrActiveRow({
  pr,
  hasCommitsAhead,
  checks,
  openPrDetail,
  threadId,
  onCreatePr,
  onOpenPr,
}: Required<Pick<ThreadOverviewPrRowProps, "pr" | "hasCommitsAhead" | "checks" | "openPrDetail" | "threadId" | "onCreatePr" | "onOpenPr">> & {
  pr: NonNullable<ThreadOverviewPrRowProps["pr"]>;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const status = getPrRowStatus(pr, hasCommitsAhead, checks);
  const detailText = getPrRowDetail(pr, openPrDetail);
  const hasChecksData =
    pr.state.toLowerCase() === "open" &&
    checks != null &&
    checks.aggregate !== "no_checks";
  const canOpenChecks = hasChecksData && threadId.length > 0;

  useEffect(() => {
    if (!canOpenChecks) return;
    const dispose = registerCommand({
      id: "checks.open",
      title: "Open CI checks for active thread",
      category: "Git",
      handler: () => setChecksOpen(true),
    });
    return dispose;
  }, [canOpenChecks]);

  const rowLabel = detailText ?? `PR #${pr.number}`;
  const checksSummary =
    checks && canOpenChecks ? (
      <ChecksPopover
        checks={checks!}
        open={checksOpen}
        onOpenChange={setChecksOpen}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="thread-overview-pr-status"
          aria-label={`CI checks, ${getCiSummaryHeadline(checks)}`}
          aria-expanded={checksOpen}
          aria-haspopup="dialog"
          title={getCiSummaryHeadline(checks)}
          onClick={(event) => {
            event.stopPropagation();
            setChecksOpen((open) => !open);
          }}
          className="flex h-7 w-full cursor-pointer justify-between gap-3 border-transparent bg-transparent px-2 text-left text-muted-foreground hover:bg-muted/40 hover:text-foreground dark:hover:bg-muted/40"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ThreadOverviewCiStatusCircle checks={checks} />
            <span className="truncate font-mono text-xs tabular-nums">
              {getCiOverviewSummaryLabel(checks)}
            </span>
          </span>
          <ChevronDown
            size={12}
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-150",
              checksOpen && "rotate-180",
            )}
          />
        </Button>
      </ChecksPopover>
    ) : (
      status.label ? (
        <span
          data-testid="thread-overview-pr-status"
          className="inline-flex h-7 w-full items-center gap-2 px-2 font-mono text-xs text-muted-foreground"
        >
          <span aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{status.label}</span>
        </span>
      ) : null
    );

  return (
    <div data-testid="thread-overview-pr" className="space-y-1">
      <PrSplitButton
        pr={pr}
        label={rowLabel}
        machineLabel={!detailText}
        onCreatePr={onCreatePr}
        onOpenPr={onOpenPr}
        primaryButtonTestId="workspace-menu-open-pr"
        newPrButtonTestId="workspace-menu-new-pr"
      />
      {checksSummary}
    </div>
  );
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
  if (!pr) {
    return (
      <ThreadOverviewPrActionRow
        hasCommitsAhead={hasCommitsAhead}
        onCommitOrPush={onCommitOrPush}
        onCreatePr={onCreatePr}
      />
    );
  }

  return (
    <ThreadOverviewPrActiveRow
      pr={pr}
      hasCommitsAhead={hasCommitsAhead}
      checks={checks}
      openPrDetail={openPrDetail}
      threadId={threadId}
      onCreatePr={onCreatePr}
      onOpenPr={onOpenPr}
    />
  );
}

interface CreateThreadBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: Thread;
  title: string;
  description: string;
  submitLabel: string;
  onCreated: (branch: string) => void;
}

function branchCreationErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "Unknown error");
}

function updateThreadToNamedBranch(threadId: string, branch: string): void {
  useWorkspaceStore.setState((state) => ({
    threads: state.threads.map((candidate) =>
      candidate.id === threadId
        ? {
            ...candidate,
            branch,
            checkout_state: "named" as const,
            pr_number: null,
            pr_status: null,
          }
        : candidate,
    ),
    prUrlsByThreadId: Object.fromEntries(
      Object.entries(state.prUrlsByThreadId).filter(([candidateId]) => candidateId !== threadId),
    ),
    checksById: Object.fromEntries(
      Object.entries(state.checksById).filter(([candidateId]) => candidateId !== threadId),
    ) as typeof state.checksById,
    worktreesLoadedForWorkspace: null,
  }));
}

function CreateThreadBranchDialog({
  open,
  onOpenChange,
  thread,
  title,
  description,
  submitLabel,
  onCreated,
}: CreateThreadBranchDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const finalBranchName = trimTrailingBranchChars(branchName.trim());
  const errorId = "create-thread-branch-error";

  useEffect(() => {
    if (!open) return;
    setBranchName("");
    setSubmitting(false);
    setError(null);
    const frame = requestAnimationFrame(() => {
      branchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const handleSubmit = useCallback(async () => {
    const name = finalBranchName;
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await getTransport().createBranch(thread.workspace_id, name, thread.id);
      const nextBranch = result.branch || name;
      updateThreadToNamedBranch(thread.id, nextBranch);
      onOpenChange(false);
      onCreated(nextBranch);
    } catch (err) {
      setError(branchCreationErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [finalBranchName, onCreated, onOpenChange, submitting, thread.id, thread.workspace_id]);

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent
        className="w-[min(92vw,440px)] gap-0 overflow-hidden p-0"
        showCloseButton={!submitting}
      >
        <div className="flex items-center gap-3 border-b border-border/50 py-4 pl-5 pr-12">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
            <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium leading-none">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-1 max-w-[36ch] text-pretty text-xs leading-5 text-muted-foreground">
              {description}
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="space-y-1.5">
            <label htmlFor="create-thread-branch" className="text-xs text-muted-foreground">
              Branch name
            </label>
            <Input
              ref={branchInputRef}
              id="create-thread-branch"
              value={branchName}
              onChange={(event) => {
                setBranchName(sanitizeCustomBranchInput(event.target.value));
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              disabled={submitting}
              placeholder="feat/my-change"
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? errorId : undefined}
              className="font-mono"
            />
          </div>

          {error ? (
            <div
              id={errorId}
              role="alert"
              className="mt-3 break-words rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="m-0 flex-row justify-end gap-2 rounded-none border-t border-border/30 bg-transparent px-5 py-3.5">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || !finalBranchName}
            className="min-w-[7rem] gap-1.5"
          >
            {submitting ? <Spinner size={14} className="text-current" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Thread-scoped Overview popover for the chat header.
 *
 * It replaces the old workspace dropdown with status rows tied to the active
 * thread: changed files, PR actions, and the thread's worktree mode.
 */
export function ThreadOverview({ thread, threadPaneWidth }: ThreadOverviewProps) {
  const projectSetup = useProjectSetupAttempt(thread.id);
  const automaticSetup = useProjectAutomaticSetup(
    thread.id,
    thread.mode === "worktree" && thread.worktree_managed === true,
  );
  const canRunManualSetup = thread.mode === "direct" || (
    thread.mode === "worktree" && thread.worktree_managed === false
  );
  const [localOpen, setLocalOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createdBranchForPr, setCreatedBranchForPr] = useState<string | null>(null);
  const [createdBranchBaseForPr, setCreatedBranchBaseForPr] = useState<string | null>(null);
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
  const [open, setOpen] = useState(false);
  const autoManagedRef = useRef(true);
  const lastAutoValueRef = useRef<boolean | null>(null);
  const openRequested = useOverviewStore(
    (state) => state.requestedThreadId === thread.id,
  );
  const browserTabSet = usePreviewTabSet(thread.id, thread.workspace_id);
  const browserLifecycleTabs = useBrowserAutomationStore((state) => state.lifecycleTabs);
  const browserLiveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const browserControllers = useBrowserAutomationStore((state) => state.controllers);
  const browserPendingAgentOpens = useBrowserAutomationStore((state) => state.pendingAgentOpens);
  const browserHostStatus = useBrowserAutomationStore((state) => state.status);
  const browserHostRegistered = useBrowserAutomationStore((state) => state.registered);
  const browserTabs = useMemo(
    () =>
      browserHostRegistered && browserHostStatus === "registered"
        ? getThreadOverviewBrowserTabs({
            workspaceId: thread.workspace_id,
            threadId: thread.id,
            tabSet: browserTabSet,
            lifecycleTabs: browserLifecycleTabs,
            liveTargets: browserLiveTargets,
            controllers: browserControllers,
            pendingAgentOpens: browserPendingAgentOpens,
          })
        : [],
    [
      browserControllers,
      browserHostRegistered,
      browserHostStatus,
      browserLifecycleTabs,
      browserLiveTargets,
      browserPendingAgentOpens,
      browserTabSet,
      thread.id,
      thread.workspace_id,
    ],
  );

  useEffect(() => {
    autoManagedRef.current = true;
  }, [thread.id]);

  useEffect(() => {
    if (!openRequested) return;
    autoManagedRef.current = false;
    lastAutoValueRef.current = true;
    setOpen(true);
    useOverviewStore.getState().consumeOpenRequest(thread.id);
  }, [openRequested, thread.id]);

  useEffect(() => {
    setCreatedBranchForPr(null);
    setCreatedBranchBaseForPr(null);
    setCreateBranchOpen(false);
  }, [thread.id]);

  // Whether there is room for the Overview to open by default. The chat pane
  // width, not the surrounding split row, is the signal that matches what the
  // user sees when the right panel opens.
  const hasRoom = useMemo(
    () =>
      shouldAutoOpenOverview({
        threadPaneWidth,
      }),
    [threadPaneWidth],
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

  useEffect(() => {
    if (!panelVisible || hasRoom || !open) return;

    lastAutoValueRef.current = false;
    autoManagedRef.current = true;
    setOpen(false);
  }, [hasRoom, open, panelVisible]);

  const setReserveSpace = useOverviewStore((s) => s.setReserveSpace);
  useEffect(() => {
    setReserveSpace(open && hasRoom && !panelVisible);
    return () => setReserveSpace(false);
  }, [hasRoom, open, panelVisible, setReserveSpace]);

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
  const reviewLink = usePullRequestReviewLink(thread.id, open);
  const effectivePr = useMemo(
    () =>
      pr ??
      (reviewLink
        ? {
            number: reviewLink.identity.number,
            url: reviewLink.pullRequestUrl,
            state: reviewLink.pullRequestState,
          }
        : null),
    [pr, reviewLink],
  );
  const branchlessCreatePr = canStartBranchlessCreatePr(thread);
  const canShowPrActions = prable;
  const createPrBranch = createdBranchForPr ?? thread.branch;
  const createBranchBaseBranch = thread.base_branch ?? thread.branch;

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
  const usageInfo = useThreadRecord(
    thread.id,
    (record) => record.usageByProvider[thread.provider],
  );
  const usageCategories = useMemo(
    () => getThreadOverviewUsageCategories(usageInfo, thread.provider).slice(0, 2),
    [thread.provider, usageInfo],
  );
  const usageSummary = useMemo(
    () => formatThreadOverviewUsage(usageInfo, thread.provider),
    [thread.provider, usageInfo],
  );
  const sessionCostSummary = useMemo(
    () => formatThreadOverviewSessionCost(usageInfo),
    [usageInfo],
  );
  const fetchProviderUsage = useThreadStore((state) => state.fetchProviderUsage);

  useEffect(() => {
    if (!open) return;
    void fetchProviderUsage(thread.id, thread.provider);
  }, [fetchProviderUsage, open, thread.id, thread.provider]);

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

  const openProjectSettings = useCallback(() => {
    setOpen(false);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "environment");
  }, [thread.id, thread.workspace_id]);

  const plans = usePlanStore((s) => s.plansByThread[thread.id] ?? EMPTY_PLANS);
  const latestPlan = useMemo(() => {
    if (plans.length === 0) return null;
    return [...plans].reverse().find((plan) => plan.status !== "superseded") ?? null;
  }, [plans]);

  const openLatestPlan = useCallback(() => {
    if (!latestPlan) return;
    usePlanStore.getState().setActiveVersion(thread.id, latestPlan.version);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "tasks");
  }, [latestPlan, thread.id, thread.workspace_id]);

  const openBrowserTab = useCallback(
    (tabId: string) => {
      showRightPanelAdaptive(thread.workspace_id, thread.id);
      useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "preview");
      void usePreviewTabsStore.getState().activatePage(thread.workspace_id, thread.id, tabId);
    },
    [thread.id, thread.workspace_id],
  );

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
  const threadRecap = useThreadRecap({
    threadId: thread.id,
    messages: sourceMessages,
    overviewOpen: open,
  });
  const sources = useMemo(
    () => (open ? extractThreadSources(sourceMessages) : []),
    [open, sourceMessages],
  );
  const overviewToolCalls = useThreadStore((state) => (
    open ? state.records.get(thread.id)?.toolCalls : undefined
  ));
  const overviewNarrative = useThreadStore((state) => (
    open ? state.records.get(thread.id)?.narrativeByMessage : undefined
  ));
  const subagentRoster = useMemo(
    () => projectSubagents(
      overviewToolCalls,
      overviewNarrative
        ? Object.values(overviewNarrative).map((entry) => entry?.tools)
        : undefined,
    ),
    [overviewNarrative, overviewToolCalls],
  );
  const subagentTotal = subagentRoster.active.length + subagentRoster.finished.length;
  const subagentGlyphRows = [...subagentRoster.active, ...subagentRoster.finished].slice(0, 4);
  const subagentStateCopy = [
    subagentRoster.active.length > 0 ? `${subagentRoster.active.length} active` : null,
    `${subagentRoster.finished.length} done`,
  ].filter(Boolean).join(", ");

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

  const ciDot = useMemo(
    () => getThreadOverviewCiDot(effectivePr, checks),
    [checks, effectivePr],
  );
  const triggerStatus =
    ciDot === "red"
      ? "Thread overview, CI checks failing"
      : ciDot === "green"
        ? "Thread overview, CI checks passing"
        : "Thread overview";
  const modeLabel = thread.mode === "worktree" ? "Worktree" : "Direct";
  const LocalModeIcon = thread.mode === "worktree" ? WorktreeModeIcon : Laptop;
  const checkoutLabel = resolveThreadCheckoutLabel(thread);

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      type="button"
      title={triggerStatus}
      aria-label={triggerStatus}
      data-testid="header-workspace-menu"
      className={cn(
        "relative cursor-pointer text-foreground/70 transition-[background-color,color,transform] duration-150 active:scale-95 motion-reduce:transform-none hover:bg-muted/40 hover:text-foreground",
        open && "bg-muted text-foreground",
      )}
    >
      <Settings2 size={14} aria-hidden />
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
    <div data-testid="thread-overview-body" className="animate-overview-enter">
      <div
        data-testid="thread-overview-masthead"
        className="flex h-9 items-center bg-muted/20 px-3"
      >
        <span className="text-xs font-semibold text-foreground/90">Overview</span>
        <div
          data-testid="thread-overview-masthead-controls"
          className="ml-auto flex items-center gap-0.5"
        >
          {canRunManualSetup ? (
            <ProjectSetupMenu
              attempt={projectSetup.attempt}
              starting={projectSetup.starting}
              onStart={projectSetup.start}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label="Open Project settings"
                  onClick={openProjectSettings}
                  className="cursor-pointer text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <Settings size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="bottom" className="text-xs">
              Open Project settings
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Separator />
      {projectSetup.startError ? (
        <p role="alert" className="mx-1.5 mt-1.5 text-xs text-destructive">{projectSetup.startError}</p>
      ) : null}
      {projectSetup.attempt ? <ProjectSetupAttemptCard attempt={projectSetup.attempt} /> : null}
      <ProjectAutomaticSetupCard
        snapshot={automaticSetup.snapshot}
        busy={automaticSetup.busy}
        error={automaticSetup.error}
        onContinue={automaticSetup.continueWithoutSetup}
        onCancel={automaticSetup.cancelQueuedTurn}
      />
      <div className="p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openChanges}
              data-testid="workspace-menu-changes"
              aria-label={`Changes, ${changedFilesLabel(changeSummary.files)}`}
              className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Diff
                  size={14}
                  className="shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground/80"
                />
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

            {latestPlan && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="thread-overview-plan"
                onClick={openLatestPlan}
                aria-label={`Plan, ${latestPlan.title}`}
                className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ListChecks
                    size={14}
                    className="shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground/80"
                  />
                  <span className="truncate text-xs font-medium">Plans</span>
                </span>
                <span className="min-w-0 max-w-[11rem] truncate text-xs text-muted-foreground">
                  {latestPlan.title}
                </span>
              </Button>
            )}

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
                      OVERVIEW_ROW_CLASS,
                      "justify-between",
                      localOpen && "bg-muted text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <LocalModeIcon
                        size={14}
                        aria-hidden
                        data-testid="thread-overview-local-mode-icon"
                        className="shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground/80"
                      />
                      <span className="truncate text-xs font-medium">{modeLabel}</span>
                    </span>
                    <ChevronDown
                      size={13}
                      aria-hidden
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform duration-150",
                        localOpen && "rotate-180",
                      )}
                    />
                  </Button>
                }
              />
              <PopoverContent
                align="start"
                side="left"
                sideOffset={12}
                className="w-80 p-0"
              >
                <ThreadOverviewLocalMenu worktreePath={dirPath} branch={checkoutLabel} />
              </PopoverContent>
            </Popover>

            {branchlessCreatePr ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="thread-overview-create-branch"
                className={cn(
                  OVERVIEW_ROW_CLASS,
                  "cursor-pointer justify-start text-xs text-primary hover:bg-primary/10 hover:text-primary",
                )}
                onClick={() => setCreateBranchOpen(true)}
                title="Create a branch in this worktree"
              >
                <GitBranch size={14} className="shrink-0 text-primary/80" />
                <span className="font-medium">Create branch</span>
              </Button>
            ) : (
              <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      data-testid="workspace-menu-branch"
                      className={cn(
                        OVERVIEW_ROW_CLASS,
                        "justify-between",
                        branchOpen && "bg-muted text-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitBranch
                          size={14}
                          className="shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground/80"
                        />
                        <span className="truncate text-xs font-medium">{checkoutLabel}</span>
                      </span>
                      <ChevronDown
                        size={13}
                        aria-hidden
                        className={cn(
                          "shrink-0 text-muted-foreground transition-transform duration-150",
                          branchOpen && "rotate-180",
                        )}
                      />
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
                    onCreateBranch={() => setCreateBranchOpen(true)}
                    hasCommitsAhead={hasCommitsAhead}
                  />
                </PopoverContent>
              </Popover>
            )}

            {branchlessCreatePr ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled
                data-testid="workspace-menu-commit"
                className="h-8 w-full justify-start gap-2 px-2 text-left text-xs text-foreground/75 disabled:cursor-not-allowed disabled:opacity-50"
                title="Create a branch before committing or pushing"
              >
                <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
                <span className="font-medium">Commit or push</span>
              </Button>
            ) : null}

            {usageSummary && (
              <>
                <Separator className="my-1.5" />
                <ThreadOverviewUsageBars
                  categories={usageCategories}
                  summary={usageSummary}
                  sessionCostSummary={sessionCostSummary}
                  usageStatus={usageInfo?.usageStatus}
                />
              </>
            )}

            {subagentTotal > 0 && (
              <>
                <Separator className="my-1.5" />
                <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                  Subagents
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  data-testid="thread-overview-subagents"
                  onClick={() => openSubagentsRoster()}
                  aria-label={`Subagents, ${subagentRoster.active.length} active, ${subagentRoster.finished.length} done`}
                  className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start gap-2")}
                >
                  <span className="flex -space-x-1" aria-hidden>
                    {subagentGlyphRows.map((row) => (
                      <SubagentIdentityGlyph
                        key={row.id}
                        identity={row.identity}
                        hasExplicitIdentity={row.hasExplicitIdentity}
                        paletteSeed={row.id}
                        size={11}
                        className="size-4 ring-2 ring-background"
                      />
                    ))}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {subagentStateCopy}
                  </span>
                </Button>
              </>
            )}

            {canShowPrActions && (
              <>
                {usageSummary ? (
                  <Separator data-testid="thread-overview-pr-separator" className="my-1.5" />
                ) : null}
                <ThreadOverviewPrRow
                  pr={effectivePr}
                  hasCommitsAhead={hasCommitsAhead}
                  checks={checks}
                  openPrDetail={openPrDetail}
                  threadId={thread.id}
                  onCommitOrPush={handleCommitOrPush}
                  onCreatePr={() => setCreatePrOpen(true)}
                  onOpenPr={handleOpenPr}
                />
              </>
            )}

            {browserTabs.length > 0 && (
              <ThreadOverviewBrowserSection rows={browserTabs} onOpen={openBrowserTab} />
            )}

            {sources.length > 0 && (
              <>
                <Separator className="my-1.5" />
                <ThreadOverviewSources sources={sources} onOpen={openSource} />
              </>
            )}

            <Separator className="my-1.5" />
            <ThreadOverviewRecapRow
              recapText={threadRecap.recapText}
              hasCoverageGap={threadRecap.hasCoverageGap}
              coveredThrough={threadRecap.coveredThrough}
              latestActivityAt={threadRecap.latestActivityAt}
              isGenerating={threadRecap.isGenerating}
              error={threadRecap.error}
              onRefresh={() => void threadRecap.refresh()}
            />
      </div>
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
          className="w-80 overflow-hidden p-0"
        >
          {overviewBody}
        </PopoverContent>
      </Popover>

      <CreateThreadBranchDialog
        open={createBranchOpen}
        onOpenChange={setCreateBranchOpen}
        thread={thread}
        title="Work here"
        description="Create a branch to commit changes, push, and create a PR from this worktree."
        submitLabel="Create"
        onCreated={(branch) => {
          setCreatedBranchForPr(branch);
          setCreatedBranchBaseForPr(createBranchBaseBranch);
        }}
      />

      {(prable || createdBranchForPr) && (
        <CreatePrDialog
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          threadId={thread.id}
          workspaceId={thread.workspace_id}
          branch={createPrBranch}
          preferredBaseBranch={createdBranchBaseForPr ?? thread.base_branch}
        />
      )}
    </>
  );
}
