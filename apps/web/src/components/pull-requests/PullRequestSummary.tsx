import type {
  PullRequestBoundedDataMarker,
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestConversationItem,
  PullRequestDetail,
} from "@mcode/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ChevronDown,
  CircleDot,
  MessageSquare,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { RemoteMarkdown } from "./RemoteMarkdown";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

const RESOURCE_VIRTUALIZATION_THRESHOLD = 30;
const RESOURCE_OVERSCAN = 4;

/** Props for the read-only pull request Summary tab. */
export interface PullRequestSummaryProps {
  /** Core detail record shown above the paginated resource sections. */
  detail: PullRequestDetail;
  /** Loaded check records for the selected identity. */
  checks: readonly PullRequestCheck[];
  /** Loaded issue comments and review threads for the selected identity. */
  comments: readonly PullRequestConversationItem[];
  /** Marker indicating that the core description was clipped at a transport bound. */
  detailBoundedData?: PullRequestBoundedDataMarker | null;
  checksHasMore?: boolean;
  commentsHasMore?: boolean;
  checksBoundedData?: PullRequestBoundedDataMarker | null;
  commentsBoundedData?: PullRequestBoundedDataMarker | null;
  checksLoading?: boolean;
  commentsLoading?: boolean;
  checksLoaded?: boolean;
  commentsLoaded?: boolean;
  onLoadMoreChecks?: () => void;
  onLoadMoreComments?: () => void;
  /** Requests the first checks page when its section first opens. */
  onChecksFirstOpen?: () => void;
  /** Requests the first comments page when its section first opens. */
  onCommentsFirstOpen?: () => void;
  defaultChecksOpen?: boolean;
  defaultCommentsOpen?: boolean;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function checkTone(state: PullRequestCheckState): string {
  if (state === "passing") return "bg-[var(--diff-add-strong)]";
  if (state === "failing" || state === "cancelled") return "bg-destructive";
  if (state === "pending") return "bg-primary";
  return "bg-muted-foreground/45";
}

function boundedMessage(
  marker: PullRequestBoundedDataMarker,
  subject: "check records" | "comments",
): string {
  if (marker.reason === "record_limit") {
    return `Record limit reached. Additional ${subject} are not shown.`;
  }
  if (marker.reason === "byte_limit") {
    return `Data limit reached. Additional ${subject} are not shown.`;
  }
  return `Refresh limit reached. Additional ${subject} remain.`;
}

function useFirstOpenTrigger(
  identity: string,
  defaultOpen: boolean,
  onFirstOpen: (() => void) | undefined,
): (open: boolean) => void {
  const state = useRef({ identity, triggered: false, open: defaultOpen });

  useEffect(() => {
    if (state.current.identity !== identity) {
      state.current = {
        identity,
        triggered: false,
        open: state.current.open,
      };
    }
    if ((!defaultOpen && !state.current.open) || state.current.triggered)
      return;
    state.current.triggered = true;
    onFirstOpen?.();
  }, [defaultOpen, identity, onFirstOpen]);

  return (open) => {
    state.current.open = open;
    if (!open) return;
    if (state.current.identity !== identity) {
      state.current = { identity, triggered: false, open: true };
    }
    if (state.current.triggered) return;
    state.current.triggered = true;
    onFirstOpen?.();
  };
}

function BoundedDataNotice({
  marker,
  subject,
}: {
  marker: PullRequestBoundedDataMarker;
  subject: "check records" | "comments";
}) {
  return (
    <p
      role="status"
      data-bounded-reason={marker.reason}
      className="mt-2 flex items-start gap-2 bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
    >
      <AlertCircle
        size={13}
        aria-hidden
        className="mt-0.5 shrink-0 text-primary/80"
      />
      {boundedMessage(marker, subject)}
    </p>
  );
}

interface ResourceListProps<T> {
  items: readonly T[];
  label: string;
  estimateSize: number;
  getItemKey: (item: T) => string;
  rowClassName: string;
  listClassName?: string;
  renderItem: (item: T) => ReactNode;
}

function ResourceList<T>({
  items,
  label,
  estimateSize,
  getItemKey,
  rowClassName,
  listClassName,
  renderItem,
}: ResourceListProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualized = items.length > RESOURCE_VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: virtualized ? items.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => {
      const item = items[index];
      return item ? getItemKey(item) : index;
    },
    overscan: RESOURCE_OVERSCAN,
    useFlushSync: false,
  });

  if (!virtualized) {
    return (
      <ul aria-label={label} className={cn("m-0 list-none p-0", listClassName)}>
        {items.map((item, index) => (
          <li
            key={getItemKey(item)}
            data-provider-node-id={getItemKey(item)}
            aria-posinset={index + 1}
            aria-setsize={items.length}
            className={rowClassName}
          >
            {renderItem(item)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ScrollArea
      className="h-80 bg-background/20"
      viewportRef={viewportRef}
      viewportProps={{ "aria-label": `${label} viewport` }}
    >
      <ul
        aria-label={label}
        className="relative m-0 list-none p-0"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const style: CSSProperties = {
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            transform: `translateY(${virtualItem.start}px)`,
          };
          return (
            <li
              key={virtualItem.key}
              ref={(element) => {
                if (element) virtualizer.measureElement(element);
              }}
              data-index={virtualItem.index}
              data-provider-node-id={getItemKey(item)}
              aria-posinset={virtualItem.index + 1}
              aria-setsize={items.length}
              className={rowClassName}
              style={style}
            >
              {renderItem(item)}
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

const CheckRow = memo(function CheckRow({
  check,
}: {
  check: PullRequestCheck;
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", checkTone(check.state))}
      />
      <span className="min-w-0 flex-1 truncate text-foreground/90">
        {check.name}
      </span>
      {check.isRequired === true && (
        <Badge variant="ghost" size="sm" className="text-muted-foreground">
          Required
        </Badge>
      )}
      <span className="font-mono text-muted-foreground">
        {titleCase(check.state)}
      </span>
    </>
  );
});

CheckRow.displayName = "CheckRow";

const CheckList = memo(function CheckList({
  checks,
}: {
  checks: readonly PullRequestCheck[];
}) {
  return (
    <ResourceList
      items={checks}
      label="Loaded checks"
      estimateSize={40}
      getItemKey={(check) => check.providerNodeId}
      rowClassName="flex min-w-0 items-center gap-2 bg-background/30 px-2.5 py-2 text-xs"
      listClassName="space-y-1.5"
      renderItem={(check) => <CheckRow check={check} />}
    />
  );
});

CheckList.displayName = "CheckList";

const ConversationRow = memo(function ConversationRow({
  item,
}: {
  item: PullRequestConversationItem;
}) {
  if (item.kind === "issue_comment") {
    const commentUrl = item.url ? safePullRequestHttpUrl(item.url) : null;
    return (
      <>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-foreground/80">
            {item.author?.login ?? "Unknown actor"}
          </span>
          <time dateTime={item.createdAt} className="font-mono tabular-nums">
            {formatRelative(item.createdAt)}
          </time>
          {commentUrl && (
            <a
              href={commentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto font-mono underline-offset-4 hover:text-foreground hover:underline"
            >
              Open comment
            </a>
          )}
        </div>
        <RemoteMarkdown content={item.body} className="mt-2" />
      </>
    );
  }

  const location = `${item.path}${item.line === null ? "" : `:${item.line}`}`;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="truncate font-mono text-foreground/85">
          {location}
        </span>
        <Badge variant="ghost" size="sm" className="text-muted-foreground">
          {item.isResolved ? "Resolved" : "Unresolved"}
        </Badge>
        {item.isOutdated && (
          <Badge variant="ghost" size="sm" className="text-muted-foreground">
            Outdated
          </Badge>
        )}
      </div>
      <div className="mt-2 space-y-2 pl-3">
        {item.comments.map((comment) => {
          const commentUrl = comment.url
            ? safePullRequestHttpUrl(comment.url)
            : null;
          return (
            <div key={comment.providerNodeId}>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{comment.author?.login ?? "Unknown actor"}</span>
                <time
                  dateTime={comment.createdAt}
                  className="font-mono tabular-nums"
                >
                  {formatRelative(comment.createdAt)}
                </time>
                {commentUrl && (
                  <a
                    href={commentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto font-mono underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Open comment
                  </a>
                )}
              </div>
              <RemoteMarkdown content={comment.body} className="mt-1" />
            </div>
          );
        })}
      </div>
      {item.totalCount > item.comments.length && (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          Showing {item.comments.length} of {item.totalCount} thread comments.
        </p>
      )}
    </>
  );
});

ConversationRow.displayName = "ConversationRow";

const ConversationList = memo(function ConversationList({
  comments,
}: {
  comments: readonly PullRequestConversationItem[];
}) {
  return (
    <ResourceList
      items={comments}
      label="Loaded comments"
      estimateSize={176}
      getItemKey={(item) => item.providerNodeId}
      rowClassName="bg-background/30 px-3 py-2.5"
      listClassName="space-y-3"
      renderItem={(item) => <ConversationRow item={item} />}
    />
  );
});

ConversationList.displayName = "ConversationList";

function PullRequestSummaryComponent({
  detail,
  checks,
  comments,
  detailBoundedData = null,
  checksHasMore = false,
  commentsHasMore = false,
  checksBoundedData = null,
  commentsBoundedData = null,
  checksLoading = false,
  commentsLoading = false,
  checksLoaded = false,
  commentsLoaded = false,
  onLoadMoreChecks,
  onLoadMoreComments,
  onChecksFirstOpen,
  onCommentsFirstOpen,
  defaultChecksOpen = true,
  defaultCommentsOpen = true,
}: PullRequestSummaryProps) {
  const conversationCount = detail.commentCount + detail.reviewThreadCount;
  const handleChecksOpenChange = useFirstOpenTrigger(
    `${detail.providerNodeId}:${detail.head.oid ?? "unknown"}:checks`,
    defaultChecksOpen,
    onChecksFirstOpen,
  );
  const handleCommentsOpenChange = useFirstOpenTrigger(
    `${detail.providerNodeId}:${detail.head.oid ?? "unknown"}:comments`,
    defaultCommentsOpen,
    onCommentsFirstOpen,
  );

  return (
    <section
      aria-label="Pull request summary"
      className="mx-auto min-w-0 w-full max-w-5xl space-y-6 px-4 pb-10 pt-4 sm:px-6"
    >
      <section aria-labelledby="pull-request-description-title">
        <h3
          id="pull-request-description-title"
          className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          Description
        </h3>
        {detail.body ? (
          <RemoteMarkdown content={detail.body} className="mt-3 max-w-4xl" />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No description</p>
        )}
        {detailBoundedData && (
          <p
            role="status"
            data-bounded-reason={detailBoundedData.reason}
            className="mt-2 flex items-start gap-2 bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
          >
            <AlertCircle
              size={13}
              aria-hidden
              className="mt-0.5 shrink-0 text-primary/80"
            />
            Description truncated at the remote data limit.
          </p>
        )}
      </section>

      <Collapsible
        defaultOpen={defaultChecksOpen}
        onOpenChange={handleChecksOpenChange}
        className="overflow-hidden rounded-lg bg-background/45"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="group h-11 w-full justify-start rounded-none px-3 text-xs hover:bg-muted/20"
            aria-label={`Checks, ${checks.length} loaded of ${detail.checkCount}`}
          >
            <CircleDot
              size={13}
              aria-hidden
              className="text-muted-foreground"
            />
            <span>Checks</span>
            <Badge
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground"
            >
              {detail.checkCount}
            </Badge>
            <ChevronDown
              size={13}
              aria-hidden
              className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          {checksLoading && checks.length === 0 ? (
            <p
              role="status"
              className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
            >
              <Spinner size="xs" aria-hidden />
              Loading checks
            </p>
          ) : checksLoaded && checks.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No checks reported.
            </p>
          ) : (
            <CheckList checks={checks} />
          )}
          {checksBoundedData ? (
            <BoundedDataNotice
              marker={checksBoundedData}
              subject="check records"
            />
          ) : checksHasMore && onLoadMoreChecks ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full text-xs text-muted-foreground"
              onClick={onLoadMoreChecks}
              disabled={checksLoading}
            >
              {checksLoading ? "Loading checks" : "Load more checks"}
            </Button>
          ) : null}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible
        defaultOpen={defaultCommentsOpen}
        onOpenChange={handleCommentsOpenChange}
        className="overflow-hidden rounded-lg bg-background/45"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="group h-11 w-full justify-start rounded-none px-3 text-xs hover:bg-muted/20"
            aria-label={`Comments, ${comments.length} loaded of ${conversationCount}`}
          >
            <MessageSquare
              size={13}
              aria-hidden
              className="text-muted-foreground"
            />
            <span>Comments</span>
            <Badge
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground"
            >
              {conversationCount}
            </Badge>
            <ChevronDown
              size={13}
              aria-hidden
              className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          {commentsLoading && comments.length === 0 ? (
            <p
              role="status"
              className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
            >
              <Spinner size="xs" aria-hidden />
              Loading comments
            </p>
          ) : commentsLoaded && comments.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No comments yet.
            </p>
          ) : (
            <ConversationList comments={comments} />
          )}
          {commentsBoundedData ? (
            <BoundedDataNotice
              marker={commentsBoundedData}
              subject="comments"
            />
          ) : commentsHasMore && onLoadMoreComments ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full text-xs text-muted-foreground"
              onClick={onLoadMoreComments}
              disabled={commentsLoading}
            >
              {commentsLoading ? "Loading comments" : "Load more comments"}
            </Button>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** Read-only orientation view for pull request detail, checks, and conversation. */
export const PullRequestSummary = memo(PullRequestSummaryComponent);

PullRequestSummary.displayName = "PullRequestSummary";
