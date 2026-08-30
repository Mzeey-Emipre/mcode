import type {
  PullRequestBoundedDataMarker,
  PullRequestReviewerTarget,
  PullRequestTimelineItem,
} from "@mcode/contracts";
import { type Virtualizer, useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  GitCommitHorizontal,
  MessageCircle,
} from "lucide-react";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { RemoteMarkdown } from "./RemoteMarkdown";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

const VIRTUALIZATION_THRESHOLD = 30;
const TIMELINE_OVERSCAN = 4;
const ESTIMATED_ROW_HEIGHT = 70;
const ANCHOR_DRIFT_TOLERANCE = 2;
const REQUIRED_STABLE_ANCHOR_FRAMES = 3;
const MAX_ANCHOR_STABILIZATION_FRAMES = 8;

function measureTimelineRow(
  _element: HTMLLIElement,
  entry: ResizeObserverEntry | undefined,
): number {
  const borderBox = entry?.borderBoxSize[0];
  if (borderBox) return Math.round(borderBox.blockSize);
  if (entry) return Math.round(entry.contentRect.height);
  return ESTIMATED_ROW_HEIGHT;
}

/** Viewport-relative position used to preserve the visible row after prepending events. */
export interface PullRequestTimelinePrependAnchor {
  /** Stable remote identity of the first visible Timeline event. */
  providerNodeId: string;
  /** Event offset from the top edge of the Timeline viewport. */
  offsetTop: number;
}

/** Props for the read-only pull request Timeline. */
export interface PullRequestTimelineProps {
  /** Loaded remote events, which may arrive out of order. */
  items: readonly PullRequestTimelineItem[];
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
  boundedData?: PullRequestBoundedDataMarker | null;
  stale?: boolean;
  initialLoading?: boolean;
  initialFailed?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  /** Requests an older page with an anchor that the owner can restore after prepend. */
  onLoadOlder?: (
    anchor: PullRequestTimelinePrependAnchor | null,
  ) => Promise<void> | void;
  /** Requests remote events newer than the current Timeline window. */
  onLoadNewer?: () => void;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function reviewerTargetLabel(target: PullRequestReviewerTarget): string {
  if (target.kind === "user") return target.actor.login;
  return `${target.organization}/${target.slug}`;
}

type DynamicTimelineEventKind =
  | "review"
  | "readiness"
  | "review_requested"
  | "review_request_removed";

type StaticTimelineEvent = Exclude<
  PullRequestTimelineItem,
  { kind: DynamicTimelineEventKind }
>;

const STATIC_EVENT_TITLES: Record<StaticTimelineEvent["kind"], string> = {
  opened: "Opened the pull request",
  commit: "Pushed a commit",
  issue_comment: "Commented",
  review_thread: "Started a review thread",
  checks: "Current check snapshot",
  merged: "Merged the pull request",
  closed: "Closed the pull request",
  reopened: "Reopened the pull request",
};

function isStaticTimelineEvent(
  item: PullRequestTimelineItem,
): item is StaticTimelineEvent {
  return item.kind in STATIC_EVENT_TITLES;
}

function unsupportedTimelineEvent(item: never): never {
  throw new Error(`Unsupported pull request timeline event: ${String(item)}`);
}

function eventTitle(item: PullRequestTimelineItem): string {
  if (isStaticTimelineEvent(item)) return STATIC_EVENT_TITLES[item.kind];
  switch (item.kind) {
    case "review":
      return `${titleCase(item.state)} review`;
    case "readiness":
      return item.readiness === "ready" ? "Marked ready for review" : "Converted to draft";
    case "review_requested":
      return `Requested review from ${reviewerTargetLabel(item.reviewer)}`;
    case "review_request_removed":
      return `Removed review request for ${reviewerTargetLabel(item.reviewer)}`;
    default:
      return unsupportedTimelineEvent(item);
  }
}

function EventGlyph({ kind }: { kind: PullRequestTimelineItem["kind"] }) {
  const className = "size-3.5";
  if (kind === "commit")
    return <GitCommitHorizontal aria-hidden className={className} />;
  if (kind === "issue_comment" || kind === "review_thread") {
    return <MessageCircle aria-hidden className={className} />;
  }
  if (kind === "checks" || kind === "merged") {
    return <CheckCircle2 aria-hidden className={className} />;
  }
  return <CircleDot aria-hidden className={className} />;
}

type TimelineEventOfKind<Kind extends PullRequestTimelineItem["kind"]> =
  Extract<PullRequestTimelineItem, { kind: Kind }>;

type TimelineEventBodyRenderer = (item: PullRequestTimelineItem) => ReactNode;

function CommitEventBody({ item }: { item: TimelineEventOfKind<"commit"> }) {
  return (
    <div className="mt-1.5 flex min-w-0 items-baseline gap-2 text-xs">
      <code className="shrink-0 font-mono text-primary/90">
        {item.oid.slice(0, 8)}
      </code>
      <span className="truncate text-foreground/80">{item.messageHeadline}</span>
    </div>
  );
}

function ReviewEventBody({ item }: { item: TimelineEventOfKind<"review"> }) {
  if (!item.body) return null;
  return <RemoteMarkdown content={item.body} className="mt-2" />;
}

function IssueCommentEventBody({
  item,
}: {
  item: TimelineEventOfKind<"issue_comment">;
}) {
  return <RemoteMarkdown content={item.body} className="mt-2" />;
}

function ReviewThreadEventBody({
  item,
}: {
  item: TimelineEventOfKind<"review_thread">;
}) {
  const location = `${item.path}${item.line === null ? "" : `:${item.line}`}`;

  return (
    <div className="mt-2 bg-page/45 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="truncate font-mono text-foreground/85">{location}</span>
        <Badge variant="ghost" size="sm" className="text-muted-foreground">
          {item.isResolved ? "Resolved" : "Unresolved"}
        </Badge>
        {item.isOutdated && (
          <Badge variant="ghost" size="sm" className="text-muted-foreground">
            Outdated
          </Badge>
        )}
      </div>
      <div className="mt-2 space-y-2.5">
        {item.comments.map((comment) => (
          <div key={comment.providerNodeId} className="pl-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground/75">
                {comment.author?.login ?? "Unknown actor"}
              </span>
              <time dateTime={comment.createdAt} className="font-mono tabular-nums">
                {formatRelative(comment.createdAt)}
              </time>
            </div>
            <RemoteMarkdown content={comment.body} className="mt-1" />
          </div>
        ))}
      </div>
      {item.totalCount > item.comments.length && (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          Showing {item.comments.length} of {item.totalCount} thread comments.
        </p>
      )}
    </div>
  );
}

function ReadinessEventBody({
  item,
}: {
  item: TimelineEventOfKind<"readiness">;
}) {
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      Readiness is now {item.readiness === "ready" ? "ready for review" : "draft"}.
    </p>
  );
}

function ChecksEventBody({ item }: { item: TimelineEventOfKind<"checks"> }) {
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {titleCase(item.checks.state)}, {item.totalCount} checks at head{" "}
      <code className="font-mono text-foreground/75">
        {item.headOid.slice(0, 8)}
      </code>
    </p>
  );
}

function MergedEventBody({ item }: { item: TimelineEventOfKind<"merged"> }) {
  if (!item.commitOid && !item.refName) return null;

  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {item.refName ? `Into ${item.refName}` : "Merge commit"}
      {item.commitOid ? (
        <code className="ml-2 font-mono text-foreground/75">
          {item.commitOid.slice(0, 8)}
        </code>
      ) : null}
    </p>
  );
}

function timelineEventBodyRenderer<
  Kind extends PullRequestTimelineItem["kind"],
>(
  Body: (props: { item: TimelineEventOfKind<Kind> }) => ReactNode,
): TimelineEventBodyRenderer {
  return (item) => <Body item={item as TimelineEventOfKind<Kind>} />;
}

const TIMELINE_EVENT_BODY_RENDERERS: Partial<
  Record<PullRequestTimelineItem["kind"], TimelineEventBodyRenderer>
> = {
  commit: timelineEventBodyRenderer(CommitEventBody),
  review: timelineEventBodyRenderer(ReviewEventBody),
  issue_comment: timelineEventBodyRenderer(IssueCommentEventBody),
  review_thread: timelineEventBodyRenderer(ReviewThreadEventBody),
  readiness: timelineEventBodyRenderer(ReadinessEventBody),
  checks: timelineEventBodyRenderer(ChecksEventBody),
  merged: timelineEventBodyRenderer(MergedEventBody),
};

function TimelineEventBody({
  item,
}: {
  item: PullRequestTimelineItem;
}): ReactNode {
  const renderBody = TIMELINE_EVENT_BODY_RENDERERS[item.kind];
  if (!renderBody) return null;
  return renderBody(item);
}

function boundedMessage(marker: PullRequestBoundedDataMarker): string {
  if (marker.reason === "catch_up_limit") {
    return "Refresh limit reached. Newer remote activity remains.";
  }
  if (marker.reason === "record_limit") {
    return "Record limit reached. Additional remote activity is not shown.";
  }
  return "Data limit reached. Additional remote activity is not shown.";
}

interface TimelineRowProps {
  item: PullRequestTimelineItem;
  index: number;
  total: number;
  className?: string;
  style?: React.CSSProperties;
  measureRef?: (element: HTMLLIElement | null) => void;
}

const TimelineRow = memo(
  function TimelineRow({
    item,
    index,
    total,
    className,
    style,
    measureRef,
  }: TimelineRowProps) {
    const eventUrl = item.url ? safePullRequestHttpUrl(item.url) : null;

    return (
      <li
        ref={measureRef}
        data-index={index}
        data-provider-node-id={item.providerNodeId}
        aria-posinset={index + 1}
        aria-setsize={total}
        className={cn("group relative px-4 sm:px-6", className)}
        style={style}
      >
        {index > 0 ? (
          <span
            aria-hidden
            data-timeline-connector="before"
            className="absolute left-7 top-0 h-6 w-px bg-border/55 sm:left-9"
          />
        ) : null}
        {index < total - 1 ? (
          <span
            aria-hidden
            data-timeline-connector="after"
            className="absolute bottom-0 left-7 top-6 w-px bg-border/55 sm:left-9"
          />
        ) : null}
        <div className="flex min-w-0 items-start gap-3 py-3.5">
          <span
            aria-hidden
            data-timeline-marker={item.kind}
            className={cn(
              "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-page text-muted-foreground transition-colors duration-150 group-hover:border-foreground/25 group-hover:text-foreground motion-reduce:transition-none",
              item.kind === "commit" &&
                "border-primary/40 bg-primary/8 text-primary group-hover:border-primary/65 group-hover:text-primary",
            )}
          >
            <EventGlyph kind={item.kind} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-foreground/90">
                  {item.actor?.login ?? "System"}
                </span>
                <span className="text-foreground/75">{eventTitle(item)}</span>
                <time
                  dateTime={item.occurredAt}
                  className="font-mono tabular-nums text-muted-foreground"
                >
                  {formatRelative(item.occurredAt)}
                </time>
              </div>
              {eventUrl && (
                <a
                  href={eventUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open event"
                  title="Open event"
                  className="-mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] duration-150 hover:bg-muted/50 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
                  onClick={(event) => {
                    if (!item.url || !safePullRequestHttpUrl(item.url))
                      event.preventDefault();
                  }}
                >
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              )}
            </div>
            <TimelineEventBody item={item} />
          </div>
        </div>
      </li>
    );
  },
  (previous, next) =>
    previous.item === next.item &&
    previous.index === next.index &&
    previous.total === next.total &&
    previous.className === next.className &&
    previous.style?.transform === next.style?.transform,
);

TimelineRow.displayName = "TimelineRow";

function TimelineStaleNotice({ stale }: { stale: boolean }) {
  if (!stale) return null;

  return (
    <p
      role="status"
      className="flex items-center gap-2 bg-primary/8 px-4 py-2 text-xs text-muted-foreground"
    >
      <AlertCircle size={13} aria-hidden className="shrink-0 text-primary/80" />
      Stale data. Showing the last successful Timeline.
    </p>
  );
}

function TimelineOlderActivityControl({
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onLoad,
}: {
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: PullRequestTimelineProps["onLoadOlder"];
  onLoad: () => Promise<void>;
}) {
  if (!hasMoreOlder || !onLoadOlder) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mx-4 my-2 text-xs text-muted-foreground"
      disabled={loadingOlder}
      onClick={onLoad}
    >
      {loadingOlder ? "Loading older activity" : "Load older activity"}
    </Button>
  );
}

function TimelineEmptyState({
  initialLoading,
  initialFailed,
}: {
  initialLoading: boolean;
  initialFailed: boolean;
}) {
  if (initialLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-muted-foreground">
        <Spinner size="xs" aria-hidden />
        <span role="status">Loading Timeline activity</span>
      </div>
    );
  }
  if (initialFailed) {
    return (
      <div className="px-4 py-12 text-center">
        <AlertCircle aria-hidden className="mx-auto size-4 text-destructive/70" />
        <p className="mt-2 text-xs text-muted-foreground">
          Timeline activity is unavailable.
        </p>
      </div>
    );
  }
  return (
    <div className="px-4 py-12 text-center">
      <span aria-hidden className="font-mono text-lg text-muted-foreground/45">
        ∅
      </span>
      <p className="mt-1 text-xs text-muted-foreground">No remote activity</p>
    </div>
  );
}

function TimelineList({
  items,
  virtualized,
  virtualizer,
  initialLoading,
  initialFailed,
}: {
  items: readonly PullRequestTimelineItem[];
  virtualized: boolean;
  virtualizer: Virtualizer<HTMLDivElement, HTMLLIElement>;
  initialLoading: boolean;
  initialFailed: boolean;
}) {
  if (items.length === 0) {
    return (
      <TimelineEmptyState
        initialLoading={initialLoading}
        initialFailed={initialFailed}
      />
    );
  }
  if (!virtualized) {
    return (
      <ol
        aria-label="Pull request timeline"
        className="mx-auto w-full max-w-5xl list-none p-0"
      >
        {items.map((item, index) => (
          <TimelineRow
            key={item.providerNodeId}
            item={item}
            index={index}
            total={items.length}
          />
        ))}
      </ol>
    );
  }
  return (
    <ol
      aria-label="Pull request timeline"
      className="relative mx-auto w-full max-w-5xl list-none p-0"
      style={{
        height: virtualizer.getTotalSize(),
        contain: "layout paint style",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <TimelineRow
            key={virtualItem.key}
            item={item}
            index={virtualItem.index}
            total={items.length}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
            measureRef={(element) => {
              if (element) virtualizer.measureElement(element);
            }}
          />
        );
      })}
    </ol>
  );
}

function TimelineNewerActivityNotice({
  hasMoreNewer,
  loadingNewer,
  onLoadNewer,
}: {
  hasMoreNewer: boolean;
  loadingNewer: boolean;
  onLoadNewer: (() => void) | undefined;
}) {
  if (!hasMoreNewer) return null;

  return (
    <div className="mx-4 mb-2 bg-page/55 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">Newer activity remains.</p>
      {onLoadNewer && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-xs text-muted-foreground"
          disabled={loadingNewer}
          onClick={onLoadNewer}
        >
          {loadingNewer ? "Loading newer activity" : "Load newer activity"}
        </Button>
      )}
    </div>
  );
}

function TimelineBoundedDataNotice({
  boundedData,
}: {
  boundedData: PullRequestBoundedDataMarker | null;
}) {
  if (!boundedData) return null;

  return (
    <p
      role="status"
      data-bounded-reason={boundedData.reason}
      className="mx-4 mb-2 flex items-start gap-2 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <AlertCircle
        size={13}
        aria-hidden
        className="mt-0.5 shrink-0 text-primary/80"
      />
      {boundedMessage(boundedData)}
    </p>
  );
}

function useTimelineVirtualization(
  items: readonly PullRequestTimelineItem[],
): {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  sortedItems: readonly PullRequestTimelineItem[];
  virtualized: boolean;
  virtualizer: Virtualizer<HTMLDivElement, HTMLLIElement>;
} {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sortedItems = useMemo(
    () =>
      [...items].sort((left, right) => {
        const byTime =
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
        return byTime === 0
          ? left.providerNodeId.localeCompare(right.providerNodeId)
          : byTime;
      }),
    [items],
  );
  const virtualized = sortedItems.length > VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: virtualized ? sortedItems.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    measureElement: measureTimelineRow,
    getItemKey: (index) => sortedItems[index]?.providerNodeId ?? index,
    overscan: TIMELINE_OVERSCAN,
    useFlushSync: false,
  });

  return { viewportRef, sortedItems, virtualized, virtualizer };
}

function useTimelinePrependLoader({
  viewportRef,
  sortedItems,
  virtualizer,
  onLoadOlder,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  sortedItems: readonly PullRequestTimelineItem[];
  virtualizer: Virtualizer<HTMLDivElement, HTMLLIElement>;
  onLoadOlder: PullRequestTimelineProps["onLoadOlder"];
}): () => Promise<void> {
  const sortedItemsRef = useRef(sortedItems);
  const virtualizerRef = useRef(virtualizer);
  sortedItemsRef.current = sortedItems;
  virtualizerRef.current = virtualizer;

  const capturePrependAnchor = (): PullRequestTimelinePrependAnchor | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const viewportBounds = viewport.getBoundingClientRect();
    const rows = viewport.querySelectorAll<HTMLLIElement>(
      "li[data-provider-node-id]",
    );
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (
        bounds.bottom >= viewportBounds.top &&
        bounds.top <= viewportBounds.bottom
      ) {
        const providerNodeId = row.dataset.providerNodeId;
        if (!providerNodeId) return null;
        return { providerNodeId, offsetTop: bounds.top - viewportBounds.top };
      }
    }
    return null;
  };

  const restorePrependAnchor = (
    anchor: PullRequestTimelinePrependAnchor,
  ): void => {
    const currentItems = sortedItemsRef.current;
    const anchorIndex = currentItems.findIndex(
      (item) => item.providerNodeId === anchor.providerNodeId,
    );
    if (currentItems.length > VIRTUALIZATION_THRESHOLD && anchorIndex >= 0) {
      virtualizerRef.current.scrollToIndex(anchorIndex, { align: "start" });
    }

    let checkedFrames = 0;
    let stableFrames = 0;

    const scheduleRead = (): void => {
      requestAnimationFrame(() => {
        checkedFrames += 1;
        const viewport = viewportRef.current;
        if (!viewport) {
          stableFrames = 0;
          if (checkedFrames < MAX_ANCHOR_STABILIZATION_FRAMES) scheduleRead();
          return;
        }
        const rows = viewport.querySelectorAll<HTMLLIElement>(
          "li[data-provider-node-id]",
        );
        const anchoredRow = Array.from(rows).find(
          (row) => row.dataset.providerNodeId === anchor.providerNodeId,
        );
        if (!anchoredRow) {
          stableFrames = 0;
          if (checkedFrames < MAX_ANCHOR_STABILIZATION_FRAMES) scheduleRead();
          return;
        }

        const viewportTop = viewport.getBoundingClientRect().top;
        const anchoredRowTop = anchoredRow.getBoundingClientRect().top;
        const offsetDelta = anchoredRowTop - viewportTop - anchor.offsetTop;
        if (Math.abs(offsetDelta) > ANCHOR_DRIFT_TOLERANCE) {
          stableFrames = 0;
          requestAnimationFrame(() => {
            if (viewportRef.current === viewport)
              viewport.scrollTop += offsetDelta;
            if (checkedFrames < MAX_ANCHOR_STABILIZATION_FRAMES) scheduleRead();
          });
          return;
        } else {
          stableFrames += 1;
        }

        if (
          checkedFrames < MAX_ANCHOR_STABILIZATION_FRAMES &&
          stableFrames < REQUIRED_STABLE_ANCHOR_FRAMES
        ) {
          scheduleRead();
        }
      });
    };

    scheduleRead();
  };

  return async (): Promise<void> => {
    if (!onLoadOlder) return;
    const anchor = capturePrependAnchor();
    await onLoadOlder(anchor);
    if (anchor) restorePrependAnchor(anchor);
  };
}

function PullRequestTimelineComponent({
  items,
  hasMoreOlder = false,
  hasMoreNewer = false,
  boundedData = null,
  stale = false,
  initialLoading = false,
  initialFailed = false,
  loadingOlder = false,
  loadingNewer = false,
  onLoadOlder,
  onLoadNewer,
}: PullRequestTimelineProps) {
  const { viewportRef, sortedItems, virtualized, virtualizer } =
    useTimelineVirtualization(items);
  const handleLoadOlder = useTimelinePrependLoader({
    viewportRef,
    sortedItems,
    virtualizer,
    onLoadOlder,
  });

  return (
    <section
      aria-label="Pull request Timeline"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <TimelineStaleNotice stale={stale} />
      <TimelineOlderActivityControl
        hasMoreOlder={hasMoreOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        onLoad={handleLoadOlder}
      />

      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={viewportRef}
        viewportProps={{ "aria-label": "Pull request Timeline viewport" }}
      >
        <TimelineList
          items={sortedItems}
          virtualized={virtualized}
          virtualizer={virtualizer}
          initialLoading={initialLoading}
          initialFailed={initialFailed}
        />
      </ScrollArea>

      <TimelineNewerActivityNotice
        hasMoreNewer={hasMoreNewer}
        loadingNewer={loadingNewer}
        onLoadNewer={onLoadNewer}
      />
      <TimelineBoundedDataNotice boundedData={boundedData} />
    </section>
  );
}

/** Read-only, chronologically ordered pull request activity with bounded virtualization. */
export const PullRequestTimeline = memo(PullRequestTimelineComponent);

PullRequestTimeline.displayName = "PullRequestTimeline";
