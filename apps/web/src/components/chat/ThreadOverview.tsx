import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
} from "react";
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
import { rightPanelActionTerminalId, useDiffStore } from "@/stores/diffStore";
import type {
  BrowserAutomationLiveTarget,
  BrowserAutomationPendingAgentOpen,
} from "@/features/preview";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  ProjectSetupAttemptCard,
  ProjectActionMenu,
  ProjectSetupMenuItem,
  useProjectActions,
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
const SIDE_OVERVIEW_COLLISION_AVOIDANCE = {
  side: "none",
  align: "none",
  fallbackAxisSide: "none",
} as const;

function getOverviewCollisionAvoidance(hasRoom: boolean) {
  return hasRoom ? SIDE_OVERVIEW_COLLISION_AVOIDANCE : undefined;
}

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
type LoadedChangeSummary = {
  threadId: string;
  snapshotKey: string;
  revision: number;
  summary: ThreadOverviewChangeSummary;
};
type LoadedRepository = {
  threadId: string;
  status: LoadStatus;
  repository: ThreadOverviewRepository;
};

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

/** Renders children only when an Overview row should be visible. */
function ThreadOverviewWhen({ when, children }: { when: boolean; children: React.ReactNode }) {
  return when ? <>{children}</> : null;
}

/** Returns the setup action only when this checkout supports manual setup. */
function getThreadOverviewSetupMenuItem(
  canRunManualSetup: boolean,
  hasSetup: boolean,
  props: React.ComponentProps<typeof ProjectSetupMenuItem>,
): React.ReactNode {
  if (!canRunManualSetup || !hasSetup) return null;
  return <ProjectSetupMenuItem {...props} />;
}

/** Resolves the displayed change summary after cache identity validation. */
function getLoadedThreadOverviewChangeSummary({
  loaded,
  threadId,
  snapshotKey,
  revision,
  fallback,
}: {
  loaded: LoadedChangeSummary | null;
  threadId: string;
  snapshotKey: string;
  revision: number;
  fallback: ThreadOverviewChangeSummary;
}): ThreadOverviewChangeSummary {
  if (loaded?.threadId !== threadId) return fallback;
  if (loaded.snapshotKey !== snapshotKey || loaded.revision !== revision) return fallback;
  return loaded.summary;
}

/** Resolves the displayed repository state for the active thread. */
function getLoadedThreadOverviewRepository(
  loaded: LoadedRepository | null,
  threadId: string,
): { repository: ThreadOverviewRepository; status: LoadStatus } {
  if (loaded?.threadId !== threadId) return { repository: EMPTY_REPOSITORY, status: "idle" };
  return { repository: loaded.repository, status: loaded.status };
}

/** Derives the pull request identity used by the Overview. */
function getEffectiveThreadOverviewPr(
  pr: ThreadOverviewPr,
  reviewLink: ReturnType<typeof usePullRequestReviewLink>,
): ThreadOverviewPr {
  if (pr) return pr;
  if (!reviewLink) return null;
  return {
    number: reviewLink.identity.number,
    url: reviewLink.pullRequestUrl,
    state: reviewLink.pullRequestState,
  };
}

/** Returns the accessible label for the Overview trigger's current CI state. */
function getThreadOverviewTriggerStatus(ciDot: ThreadOverviewCiDot): string {
  if (ciDot === "red") return "Thread overview, CI checks failing";
  if (ciDot === "green") return "Thread overview, CI checks passing";
  return "Thread overview";
}

/** Returns the trigger dot class for one Overview CI state. */
function getThreadOverviewCiDotClass(ciDot: ThreadOverviewCiDot): string | false {
  if (ciDot === "red") return "bg-[var(--diff-remove-strong)]";
  if (ciDot === "green") return "bg-[var(--diff-add-strong)]";
  return false;
}

type ThreadOverviewTriggerProps = {
  ciDot: ThreadOverviewCiDot;
  open: boolean;
} & Omit<ComponentProps<typeof Button>, "children">;

function ThreadOverviewTooltipButton({
  content,
  disabled = false,
  children,
}: {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={disabled ? <span className="inline-flex">{children}</span> : children}
      />
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

/** Renders the Overview trigger with its compact CI state. */
function ThreadOverviewTrigger({ ciDot, open, className, ...triggerProps }: ThreadOverviewTriggerProps) {
  const status = getThreadOverviewTriggerStatus(ciDot);

  return (
    <Button
      {...triggerProps}
      variant="ghost"
      size="icon-xs"
      type="button"
      aria-label={status}
      aria-expanded={open}
      data-testid="header-workspace-menu"
      className={cn(
        "relative cursor-pointer text-foreground/70 transition-[background-color,color,transform] duration-150 active:scale-95 motion-reduce:transform-none hover:bg-muted/40 hover:text-foreground",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      <Settings2 size={14} aria-hidden />
      <ThreadOverviewWhen when={ciDot !== null}>
        <span
          data-testid={`thread-overview-ci-${ciDot}`}
          aria-hidden
          className={cn(
            "absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
            getThreadOverviewCiDotClass(ciDot),
          )}
        />
      </ThreadOverviewWhen>
    </Button>
  );
}

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

/** Indexes lifecycle records that match the active Browser scope. */
function getBrowserLifecycleByTarget(
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>,
  workspaceId: string,
  threadId: string,
): ReadonlyMap<string, BrowserSessionLifecycleTab> {
  const lifecycleByTarget = new Map<string, BrowserSessionLifecycleTab>();
  for (const lifecycle of lifecycleTabs.values()) {
    if (!isThreadLifecycleTab(lifecycle, workspaceId, threadId)) continue;
    lifecycleByTarget.set(browserAutomationTargetKey(workspaceId, threadId, lifecycle.tabId), lifecycle);
  }
  return lifecycleByTarget;
}

/** Returns whether a lifecycle record belongs to the active Browser scope. */
function isThreadLifecycleTab(
  lifecycle: BrowserSessionLifecycleTab,
  workspaceId: string,
  threadId: string,
): boolean {
  return lifecycle.workspaceId === workspaceId
    && lifecycle.threadId === threadId
    && lifecycle.target.threadId === threadId
    && lifecycle.target.tabId === lifecycle.tabId;
}

/** Returns whether a Browser target is live for one tab in the active scope. */
function isLiveThreadBrowserTarget(
  target: BrowserAutomationLiveTarget | undefined,
  workspaceId: string,
  threadId: string,
  tabId: string,
): boolean {
  return target?.workspaceId === workspaceId
    && target.threadId === threadId
    && target.tabId === tabId;
}

/** Resolves the Browser controller after lifecycle release semantics apply. */
function getBrowserTabController(
  lifecycle: BrowserSessionLifecycleTab | undefined,
  controller: BrowserAutomationControllerState | undefined,
  pendingOpen: BrowserAutomationPendingAgentOpen | null | undefined,
): BrowserAutomationControllerState["controller"] | undefined {
  if (lifecycle?.ownership === "released") return undefined;
  if (controller) return controller.controller;
  if (lifecycle?.target.controller) return lifecycle.target.controller.controller;
  return pendingOpen ? "agent" : undefined;
}

/** Joins a scoped Browser tab with its lifecycle and controller state. */
function getThreadOverviewBrowserTab({
  tab,
  workspaceId,
  threadId,
  lifecycleByTarget,
  liveTargets,
  controllers,
  pendingAgentOpens,
}: {
  tab: BrowserTabInfo;
  workspaceId: string;
  threadId: string;
  lifecycleByTarget: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
}): ThreadOverviewBrowserTab | null {
  if (tab.threadId !== threadId) return null;
  const targetKey = browserAutomationTargetKey(workspaceId, threadId, tab.id);
  const pendingOpen = findPendingBrowserAutomationOpen(pendingAgentOpens, workspaceId, threadId, tab.id);
  const pendingUrl = pendingOpen?.url?.trim() || null;
  if (isEmptyPreviewTabUrl(tab.url) && !pendingUrl) return null;
  if (!pendingOpen && !isLiveThreadBrowserTarget(liveTargets.get(targetKey), workspaceId, threadId, tab.id)) {
    return null;
  }
  const lifecycle = lifecycleByTarget.get(targetKey);
  const controller = getBrowserTabController(lifecycle, controllers.get(targetKey), pendingOpen);
  return {
    tab: browserPendingTab(tab, pendingUrl),
    ...(lifecycle ? { lifecycle } : {}),
    controller,
  };
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

  const lifecycleByTarget = getBrowserLifecycleByTarget(lifecycleTabs, workspaceId, threadId);
  const rows: ThreadOverviewBrowserTab[] = [];
  for (const tab of tabSet.tabs) {
    const row = getThreadOverviewBrowserTab({
      tab,
      workspaceId,
      threadId,
      lifecycleByTarget,
      liveTargets,
      controllers,
      pendingAgentOpens,
    });
    if (row) rows.push(row);
  }
  return rows;
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

/** Formats the local-checkout row label for assistive technology. */
function localCheckoutAriaLabel(modeLabel: string, dirPath: string | null): string {
  return dirPath ? `${modeLabel}, ${dirPath}` : modeLabel;
}

/** Returns the label and icon for the active thread checkout mode. */
function getThreadOverviewLocalMode(thread: Thread) {
  if (thread.mode === "worktree") return { label: "Worktree", Icon: WorktreeModeIcon };
  return { label: "Direct", Icon: Laptop };
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
          <ThreadOverviewTooltipButton content={repository.webUrl ?? label}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={onOpen}
              data-testid="thread-overview-repository-link"
              aria-label={`Open ${label} on remote`}
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
          </ThreadOverviewTooltipButton>
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

/** Formats the recap coverage range when the recap trails recent activity. */
function getThreadRecapCoverageLabel({
  hasCoverageGap,
  coveredThrough,
  latestActivityAt,
}: Pick<ThreadOverviewRecapRowProps, "hasCoverageGap" | "coveredThrough" | "latestActivityAt">): {
  coveredThrough: string;
  latestActivityAt: string;
} | null {
  if (!hasCoverageGap || !coveredThrough || !latestActivityAt) return null;
  return {
    coveredThrough: formatThreadRecapTime(coveredThrough),
    latestActivityAt: formatThreadRecapTime(latestActivityAt),
  };
}

/** Shows recap coverage and refresh controls. */
function ThreadOverviewRecapControls({
  coverageLabel,
  isGenerating,
  onRefresh,
}: Pick<ThreadOverviewRecapRowProps, "isGenerating" | "onRefresh"> & {
  coverageLabel: ReturnType<typeof getThreadRecapCoverageLabel>;
}) {
  const refreshLabel = isGenerating ? "Refreshing recap" : "Refresh recap";

  return (
    <div className="-mr-1 flex shrink-0 items-center gap-0.5">
      {coverageLabel ? <ThreadOverviewRecapCoverage coverageLabel={coverageLabel} /> : null}
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
  );
}

/** Explains which thread activity the current recap covers. */
function ThreadOverviewRecapCoverage({
  coverageLabel,
}: {
  coverageLabel: NonNullable<ReturnType<typeof getThreadRecapCoverageLabel>>;
}) {
  return (
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
  );
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
  const coverageLabel = getThreadRecapCoverageLabel({
    hasCoverageGap,
    coveredThrough,
    latestActivityAt,
  });

  return (
    <div
      data-testid="thread-overview-recap"
      className="w-full px-2.5 py-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Recap</span>
        <ThreadOverviewRecapControls
          coverageLabel={coverageLabel}
          isGenerating={isGenerating}
          onRefresh={onRefresh}
        />
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

/** Loads branch and working-tree data while the branch picker is open. */
function useThreadOverviewBranchState(thread: Thread, open: boolean): LoadedBranchState {
  const [loaded, setLoaded] = useState<LoadedBranchState>({
    status: "loading",
    branches: [],
    uncommittedFiles: null,
  });

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
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
        if (!cancelled) setLoaded((previous) => ({ ...previous, status: "error" }));
      }
    };

    void loadBranches();

    return () => {
      cancelled = true;
    };
  }, [open, thread.id, thread.workspace_id]);

  return loaded;
}

/** Filters branch rows by the picker search text. */
function getVisibleBranchRows(branches: readonly GitBranchRecord[], search: string): readonly GitBranchRecord[] {
  const query = search.trim().toLowerCase();
  if (!query) return branches;
  return branches.filter((branch) => branch.name.toLowerCase().includes(query));
}

/** Returns the current branch's uncommitted-file label. */
function getCurrentBranchUncommittedLabel(uncommittedFiles: number | null): string | null {
  if (uncommittedFiles === null || uncommittedFiles === 0) return null;
  return uncommittedFilesLabel(uncommittedFiles);
}

/** Returns whether this checkout can create and switch to a new branch. */
function canCreateCheckoutBranch(
  thread: Thread,
  loaded: LoadedBranchState,
  hasCommitsAhead: boolean | null,
): boolean {
  if (thread.checkout_state !== "named" || loaded.status !== "ready") return false;
  if (hasCommitsAhead === true) return true;
  return loaded.uncommittedFiles !== null && loaded.uncommittedFiles > 0;
}

function ThreadOverviewBranchMenu({
  thread,
  open,
  onOpenChange,
  onCreateBranch,
  hasCommitsAhead,
}: ThreadOverviewBranchMenuProps) {
  const [search, setSearch] = useState("");
  const loaded = useThreadOverviewBranchState(thread, open);

  const displayBranch = thread.checkout_state === "branchless" ? "HEAD" : thread.branch;
  const branches = useMemo(
    () => branchRows(loaded.branches, displayBranch),
    [loaded.branches, displayBranch],
  );
  const visibleBranches = useMemo(() => getVisibleBranchRows(branches, search), [branches, search]);

  const currentBranchUncommittedLabel = getCurrentBranchUncommittedLabel(loaded.uncommittedFiles);
  const shouldConstrainBranchList = visibleBranches.length > 6;
  const canCreateNewBranch = canCreateCheckoutBranch(thread, loaded, hasCommitsAhead);

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
        <ThreadOverviewBranchRows
          thread={thread}
          loaded={loaded}
          branches={visibleBranches}
          currentBranchUncommittedLabel={currentBranchUncommittedLabel}
          onOpenChange={onOpenChange}
        />
      </ScrollArea>

      <Separator className="my-2" />
      <ThreadOverviewBranchCreateAction
        canCreateCheckoutBranch={canCreateNewBranch}
        onOpenChange={onOpenChange}
        onCreateBranch={onCreateBranch}
      />
    </div>
  );
}

/** Renders loaded branches and their branch-picker states. */
function ThreadOverviewBranchRows({
  thread,
  loaded,
  branches,
  currentBranchUncommittedLabel,
  onOpenChange,
}: {
  thread: Thread;
  loaded: LoadedBranchState;
  branches: readonly GitBranchRecord[];
  currentBranchUncommittedLabel: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const showBranches = loaded.status !== "loading" || loaded.branches.length > 0;
  const isEmpty = loaded.status !== "loading" && branches.length === 0;

  return (
    <div className="space-y-0.5 pr-2">
      {loaded.status === "loading" && loaded.branches.length === 0 ? <ThreadOverviewBranchLoadingRow /> : null}
      {showBranches ? branches.map((branch) => (
        <ThreadOverviewBranchRow
          key={branch.name}
          branch={branch}
          isCurrent={thread.checkout_state === "named" && (branch.name === thread.branch || branch.isCurrent)}
          currentBranchUncommittedLabel={currentBranchUncommittedLabel}
          onOpenChange={onOpenChange}
        />
      )) : null}
      {isEmpty ? <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">No branches match</div> : null}
      {loaded.status === "error" ? <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">Branches unavailable</div> : null}
    </div>
  );
}

/** Renders the branch-picker loading placeholder. */
function ThreadOverviewBranchLoadingRow() {
  return <div className="animate-thread-overview-loading h-8 overflow-hidden rounded-md bg-muted/35" aria-hidden />;
}

/** Renders one branch row in the branch picker. */
function ThreadOverviewBranchRow({
  branch,
  isCurrent,
  currentBranchUncommittedLabel,
  onOpenChange,
}: {
  branch: GitBranchRecord;
  isCurrent: boolean;
  currentBranchUncommittedLabel: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={() => {
        if (isCurrent) onOpenChange(false);
      }}
      aria-current={isCurrent ? "true" : undefined}
      data-testid={isCurrent ? "thread-overview-current-branch" : undefined}
      className={cn("h-auto w-full justify-between gap-3 px-2 py-1.5 text-left", isCurrent && "bg-muted text-foreground")}
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
}

/** Renders the branch-creation affordance for eligible checkouts. */
function ThreadOverviewBranchCreateAction({
  canCreateCheckoutBranch,
  onOpenChange,
  onCreateBranch,
}: {
  canCreateCheckoutBranch: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateBranch: () => void;
}) {
  const title = canCreateCheckoutBranch
    ? "Create and checkout a new branch"
    : "Detected changes required";

  return (
    <ThreadOverviewTooltipButton content={title} disabled={!canCreateCheckoutBranch}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled={!canCreateCheckoutBranch}
        data-testid="thread-overview-create-checkout-branch"
        className="h-8 w-full justify-start gap-2 px-2 text-xs disabled:opacity-60"
        onClick={() => {
          if (!canCreateCheckoutBranch) return;
          onOpenChange(false);
          onCreateBranch();
        }}
      >
        <Plus size={14} className="text-muted-foreground" />
        Create and checkout new branch...
      </Button>
    </ThreadOverviewTooltipButton>
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

/** Returns the Overview status for an open pull request's CI checks. */
function getOpenPrRowStatus(checks: ChecksStatus | null): { label: string | null; tone: PrRowTone } {
  if (checks?.aggregate === "failing") return { label: getCiSummaryHeadline(checks), tone: "danger" };
  if (checks?.aggregate === "passing") return { label: getCiSummaryHeadline(checks), tone: "positive" };
  if (checks?.aggregate === "pending") return { label: getCiSummaryHeadline(checks), tone: "neutral" };
  return { label: null, tone: "positive" };
}

/** Returns the Overview status for a non-open pull request. */
function getClosedPrRowStatus(pr: NonNullable<ThreadOverviewPr>): { label: string; tone: PrRowTone } {
  if (pr.state.toLowerCase() === "merged") return { label: "Merged", tone: "positive" };
  if (pr.state.toLowerCase() === "closed") return { label: "Closed", tone: "danger" };
  return { label: pr.state, tone: "neutral" };
}

/** Returns the Overview status before the thread has a pull request. */
function getUnopenedPrRowStatus(hasCommitsAhead: boolean | null): { label: string; tone: PrRowTone } {
  if (hasCommitsAhead === true) return { label: "Ready", tone: "neutral" };
  if (hasCommitsAhead === false) return { label: "No commits ahead", tone: "muted" };
  return { label: "Checking", tone: "muted" };
}

function getPrRowStatus(
  pr: ThreadOverviewPr,
  hasCommitsAhead: boolean | null,
  checks: ChecksStatus | null,
): { label: string | null; tone: PrRowTone } {
  if (!pr) return getUnopenedPrRowStatus(hasCommitsAhead);
  if (pr.state.toLowerCase() === "open") return getOpenPrRowStatus(checks);
  return getClosedPrRowStatus(pr);
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
        <ThreadOverviewTooltipButton content="Ask the agent to commit and push the changes">
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
          >
            <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
            <span className="font-medium">Commit or push</span>
          </Button>
        </ThreadOverviewTooltipButton>
      </div>
    );
  }

  return (
    <div data-testid="thread-overview-pr">
      <ThreadOverviewTooltipButton
        content={hasCommitsAhead ? "Create pull request" : "Waiting for commits ahead of base branch"}
        disabled={!hasCommitsAhead}
      >
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
        >
          <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
          <span className="font-medium">Create PR</span>
        </Button>
      </ThreadOverviewTooltipButton>
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
        <ThreadOverviewTooltipButton content={getCiSummaryHeadline(checks)}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="thread-overview-pr-status"
            aria-label={`CI checks, ${getCiSummaryHeadline(checks)}`}
            aria-expanded={checksOpen}
            aria-haspopup="dialog"
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
        </ThreadOverviewTooltipButton>
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

function CreateThreadBranchDialog(props: CreateThreadBranchDialogProps) {
  if (!props.open) return null;
  return <CreateThreadBranchDialogSession {...props} />;
}

function CreateThreadBranchDialogSession({
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
    const frame = requestAnimationFrame(() => {
      branchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

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

interface ThreadOverviewBranchCreation {
  threadId: string;
  open: boolean;
  branch: string | null;
  baseBranch: string | null;
}

function useThreadOverviewBranchCreation(threadId: string) {
  const [creation, setCreation] = useState<ThreadOverviewBranchCreation>({
    threadId,
    open: false,
    branch: null,
    baseBranch: null,
  });
  const current = creation.threadId === threadId
    ? creation
    : { threadId, open: false, branch: null, baseBranch: null };
  const setOpen = useCallback((open: boolean) => {
    setCreation((previous) => ({
      ...(previous.threadId === threadId
        ? previous
        : { threadId, branch: null, baseBranch: null }),
      open,
    }));
  }, [threadId]);
  const complete = useCallback((branch: string, baseBranch: string | null) => {
    setCreation({ threadId, open: false, branch, baseBranch });
  }, [threadId]);

  return { ...current, setOpen, complete };
}

function useThreadOverviewOpenState(
  threadId: string,
  panelVisible: boolean,
  hasRoom: boolean,
  openRequested: boolean,
) {
  const [choice, setChoice] = useState<{ threadId: string; value: boolean | null }>({
    threadId,
    value: null,
  });
  const currentChoice = choice.threadId === threadId ? choice.value : null;
  const open = openRequested || (currentChoice ?? (hasRoom || panelVisible));

  useEffect(() => {
    if (!openRequested) return;
    // oxlint-disable-next-line react/set-state-in-effect -- A store-driven open request becomes this thread's local interaction snapshot after consumption.
    setChoice({ threadId, value: true });
    useOverviewStore.getState().consumeOpenRequest(threadId);
  }, [openRequested, threadId]);

  const setOpen = useCallback((next: boolean) => {
    setChoice({ threadId, value: next });
  }, [threadId]);
  const handleOpenChange = useCallback((next: boolean, eventDetails?: { reason?: string }) => {
    if (!next && (eventDetails?.reason === "outside-press" || eventDetails?.reason === "focus-out")) {
      return;
    }
    setChoice({ threadId, value: next });
  }, [threadId]);

  return { open, setOpen, handleOpenChange };
}

function hasCurrentThreadOverviewChangeSummary(
  loaded: LoadedChangeSummary | null,
  threadId: string,
  snapshotKey: string,
  revision: number,
): boolean {
  return loaded?.threadId === threadId
    && loaded.snapshotKey === snapshotKey
    && loaded.revision === revision;
}

function getThreadOverviewRepositoryDisplay(
  loaded: LoadedRepository | null,
  threadId: string,
  open: boolean,
): { repository: ThreadOverviewRepository; status: LoadStatus } {
  const result = getLoadedThreadOverviewRepository(loaded, threadId);
  return {
    repository: result.repository,
    status: open && result.status === "idle" ? "loading" : result.status,
  };
}

function canRunManualProjectSetup(thread: Thread): boolean {
  return thread.mode === "direct" || (
    thread.mode === "worktree" && thread.worktree_managed === false
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
  const projectActions = useProjectActions(thread.workspace_id, thread.id);
  const startProjectAction = useCallback(async (actionId: string) => {
    const run = await projectActions.start(actionId);
    useDiffStore.getState().ensureRightPanelActionTerminalTab(
      thread.workspace_id,
      thread.id,
      run.actionId,
    );
    return run;
  }, [projectActions, thread.id, thread.workspace_id]);
  const approveProjectAction = useCallback(async (actionId: string, approval: import("@mcode/contracts").WorkspaceEnvironmentCommandApproval) => {
    const run = await projectActions.approve(actionId, approval);
    useDiffStore.getState().ensureRightPanelActionTerminalTab(thread.workspace_id, thread.id, run.actionId);
    return run;
  }, [projectActions, thread.id, thread.workspace_id]);
  const focusProjectAction = useCallback((actionId: string) => {
    const panels = useDiffStore.getState();
    panels.ensureRightPanelActionTerminalTab(thread.workspace_id, thread.id, actionId);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    panels.setRightPanelTabInstance(
      thread.workspace_id,
      thread.id,
      rightPanelActionTerminalId(actionId),
    );
  }, [thread.id, thread.workspace_id]);
  const canRunManualSetup = canRunManualProjectSetup(thread);
  const [localOpen, setLocalOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchCreation = useThreadOverviewBranchCreation(thread.id);
  const [loadedChangeSummary, setLoadedChangeSummary] = useState<LoadedChangeSummary | null>(null);
  const [loadedRepository, setLoadedRepository] = useState<LoadedRepository | null>(null);
  const [changeSummaryStatus, setChangeSummaryStatus] = useState<LoadStatus>("idle");

  // Overview may open when the chat has room or the normal right panel is
  // visible, until the user takes manual control for this thread.
  const panelVisible = useDiffStore((s) => s.getRightPanelVisible(thread.workspace_id, thread.id));
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
  const { open, setOpen: setOverviewOpen, handleOpenChange } = useThreadOverviewOpenState(
    thread.id,
    panelVisible,
    hasRoom,
    openRequested,
  );

  const setReserveThread = useOverviewStore((s) => s.setReserveThread);
  const clearReserveThread = useOverviewStore((s) => s.clearReserveThread);
  useLayoutEffect(() => {
    setReserveThread(open && hasRoom ? thread.id : null);
    return () => clearReserveThread(thread.id);
  }, [clearReserveThread, hasRoom, open, setReserveThread, thread.id]);

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
  const effectivePr = useMemo(() => getEffectiveThreadOverviewPr(pr, reviewLink), [pr, reviewLink]);
  const branchlessCreatePr = canStartBranchlessCreatePr(thread);
  const canShowPrActions = prable;
  const createPrBranch = branchCreation.branch ?? thread.branch;
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
  const changeSummary = getLoadedThreadOverviewChangeSummary({
    loaded: loadedChangeSummary,
    threadId: thread.id,
    snapshotKey: cachedSnapshotKey,
    revision: diffRevision,
    fallback: fallbackChangeSummary,
  });
  const showChangeSummary = hasVisibleThreadOverviewChangeSummary(changeSummary);
  const hasCurrentChangeSummary = hasCurrentThreadOverviewChangeSummary(
    loadedChangeSummary,
    thread.id,
    cachedSnapshotKey,
    diffRevision,
  );
  const isChangeSummaryLoading = open && !hasCurrentChangeSummary && changeSummaryStatus !== "error";
  const { repository, status: repositoryStatus } = getThreadOverviewRepositoryDisplay(
    loadedRepository,
    thread.id,
    open,
  );
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
    setOverviewOpen(false);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "environment");
  }, [setOverviewOpen, thread.id, thread.workspace_id]);

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
  const { label: modeLabel, Icon: LocalModeIcon } = getThreadOverviewLocalMode(thread);
  const checkoutLabel = resolveThreadCheckoutLabel(thread);

  const triggerButton = <ThreadOverviewTrigger ciDot={ciDot} open={open} />;

  const overviewBody = renderOverviewBody();

  function renderOverviewBody() {
    return (
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
          <ProjectActionMenu
            actions={projectActions.actions}
            runsByActionId={projectActions.runsByActionId}
            loadError={projectActions.loadError}
            onStart={startProjectAction}
            onApprove={approveProjectAction}
            onFocus={focusProjectAction}
            onEdit={openProjectSettings}
            setupMenuItem={getThreadOverviewSetupMenuItem(
              canRunManualSetup,
              projectActions.hasSetup,
              {
                attempt: projectSetup.attempt,
                starting: projectSetup.starting,
                onStart: projectSetup.start,
              },
            )}
          />
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
      <ThreadOverviewWhen when={Boolean(projectSetup.startError)}>
        <p role="alert" className="mx-1.5 mt-1.5 text-xs text-destructive">{projectSetup.startError}</p>
      </ThreadOverviewWhen>
      <ThreadOverviewWhen when={Boolean(projectSetup.attempt)}>
        <ProjectSetupAttemptCard attempt={projectSetup.attempt!} onApprove={projectSetup.approve} />
      </ThreadOverviewWhen>
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
              <ThreadOverviewWhen when={isChangeSummaryLoading}>
                <span
                  data-testid="thread-overview-change-loading"
                  aria-label="Loading changes"
                  className="animate-thread-overview-loading h-3 w-14 shrink-0 overflow-hidden rounded-sm bg-muted/45"
                />
              </ThreadOverviewWhen>
              <ThreadOverviewWhen when={!isChangeSummaryLoading && showChangeSummary}>
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
              </ThreadOverviewWhen>
            </Button>

            <ThreadOverviewRepositoryRow
              repository={repository}
              status={repositoryStatus}
              onOpen={openRepository}
            />

            <ThreadOverviewWhen when={latestPlan !== null}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="thread-overview-plan"
                onClick={openLatestPlan}
                aria-label={`Plan, ${latestPlan?.title}`}
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
                  {latestPlan?.title}
                </span>
              </Button>
            </ThreadOverviewWhen>

            <Popover open={localOpen} onOpenChange={setLocalOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid="thread-overview-local"
                    aria-label={localCheckoutAriaLabel(modeLabel, dirPath)}
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

            <ThreadOverviewWhen when={branchlessCreatePr}>
              <ThreadOverviewTooltipButton content="Create a branch in this worktree">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  data-testid="thread-overview-create-branch"
                  className={cn(
                    OVERVIEW_ROW_CLASS,
                    "cursor-pointer justify-start text-xs text-primary hover:bg-primary/10 hover:text-primary",
                  )}
                  onClick={() => branchCreation.setOpen(true)}
                >
                  <GitBranch size={14} className="shrink-0 text-primary/80" />
                  <span className="font-medium">Create branch</span>
                </Button>
              </ThreadOverviewTooltipButton>
            </ThreadOverviewWhen>
            <ThreadOverviewWhen when={!branchlessCreatePr}>
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
                    onCreateBranch={() => branchCreation.setOpen(true)}
                    hasCommitsAhead={hasCommitsAhead}
                  />
                </PopoverContent>
              </Popover>
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={branchlessCreatePr}>
              <ThreadOverviewTooltipButton
                content="Create a branch before committing or pushing"
                disabled
              >
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled
                  data-testid="workspace-menu-commit"
                  className="h-8 w-full justify-start gap-2 px-2 text-left text-xs text-foreground/75 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
                  <span className="font-medium">Commit or push</span>
                </Button>
              </ThreadOverviewTooltipButton>
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={usageSummary !== null}>
              <>
                <Separator className="my-1.5" />
                <ThreadOverviewUsageBars
                  categories={usageCategories}
                  summary={usageSummary ?? ""}
                  sessionCostSummary={sessionCostSummary}
                  usageStatus={usageInfo?.usageStatus}
                />
              </>
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={subagentTotal > 0}>
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
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={canShowPrActions}>
              <>
                <ThreadOverviewWhen when={usageSummary !== null}>
                  <Separator data-testid="thread-overview-pr-separator" className="my-1.5" />
                </ThreadOverviewWhen>
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
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={browserTabs.length > 0}>
              <ThreadOverviewBrowserSection rows={browserTabs} onOpen={openBrowserTab} />
            </ThreadOverviewWhen>

            <ThreadOverviewWhen when={sources.length > 0}>
              <>
                <Separator className="my-1.5" />
                <ThreadOverviewSources sources={sources} onOpen={openSource} />
              </>
            </ThreadOverviewWhen>

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
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={triggerButton} />} />
          <TooltipContent>{getThreadOverviewTriggerStatus(ciDot)}</TooltipContent>
        </Tooltip>
        {/*
          The side layout already reserves this right gutter. Keep Base UI from
          flipping or shifting into chat when height is short; its available-height
          variable still constrains the scrollable body below the trigger.
        */}
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={18}
          alignOffset={-40}
          collisionPadding={8}
          collisionAvoidance={getOverviewCollisionAvoidance(hasRoom)}
          className="w-80 overflow-hidden p-0"
        >
          <ScrollArea
            className="max-h-[var(--available-height)]"
            viewportClassName="max-h-[var(--available-height)]"
          >
            {overviewBody}
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <CreateThreadBranchDialog
        open={branchCreation.open}
        onOpenChange={branchCreation.setOpen}
        thread={thread}
        title="Work here"
        description="Create a branch to commit changes, push, and create a PR from this worktree."
        submitLabel="Create"
        onCreated={(branch) => {
          branchCreation.complete(branch, createBranchBaseBranch);
        }}
      />

      {(prable || branchCreation.branch) && (
        <CreatePrDialog
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          threadId={thread.id}
          workspaceId={thread.workspace_id}
          branch={createPrBranch}
          preferredBaseBranch={branchCreation.baseBranch ?? thread.base_branch}
        />
      )}
    </>
  );
}
