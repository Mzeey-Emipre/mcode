import type {
  PullRequestActor,
  PullRequestBoundedDataMarker,
  PullRequestCapability,
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestConversationItem,
  PullRequestDetail,
} from "@mcode/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  Loader2,
  MessageCircle,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { CI_ICON_STROKE } from "@/lib/ci-status";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import {
  getPullRequestMutationIdentityKey,
  usePullRequestMutationStore,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestIssueCommentComposer } from "./PullRequestIssueCommentComposer";
import { pullRequestMutationExpected } from "./PullRequestMutationError";
import { RemoteMarkdown } from "./RemoteMarkdown";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

const RESOURCE_VIRTUALIZATION_THRESHOLD = 100;
const RESOURCE_OVERSCAN = 4;
const CONVERSATION_MARKDOWN_CLASS = [
  "max-w-[72ch]",
  "[&_[data-github-alert]]:rounded-none",
  "[&_[data-github-alert]]:border-0",
  "[&_details[data-github-disclosure]]:rounded-none",
  "[&_details[data-github-disclosure]]:border-0",
  "[&_details[data-github-disclosure]]:border-t",
  "[&_details[data-github-disclosure]]:bg-transparent",
  "[&_details[data-github-disclosure]>summary]:px-0",
].join(" ");

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
  /** Current permission for posting pull request issue comments. */
  commentCapability?: PullRequestCapability | null;
  /** Optional mutation transport used by inline replies. */
  mutationTransport?: PullRequestMutationTransport;
  /** Optional read transport refreshed after an inline reply. */
  readTransport?: PullRequestTransport;
  /** Refreshes the selected pull request after uncertain mutations. */
  onRefresh?: () => Promise<boolean> | boolean;
  /** Opens a Review task focused on one issue comment. */
  onPromptFix?: (
    comment: Extract<PullRequestConversationItem, { kind: "issue_comment" }>,
  ) => void;
  defaultChecksOpen?: boolean;
  defaultCommentsOpen?: boolean;
}

type ResolvedPullRequestSummaryProps = Omit<
  PullRequestSummaryProps,
  | "detailBoundedData"
  | "checksHasMore"
  | "commentsHasMore"
  | "checksBoundedData"
  | "commentsBoundedData"
  | "checksLoading"
  | "commentsLoading"
  | "checksLoaded"
  | "commentsLoaded"
  | "defaultChecksOpen"
  | "defaultCommentsOpen"
> & {
  detailBoundedData: PullRequestBoundedDataMarker | null;
  checksHasMore: boolean;
  commentsHasMore: boolean;
  checksBoundedData: PullRequestBoundedDataMarker | null;
  commentsBoundedData: PullRequestBoundedDataMarker | null;
  checksLoading: boolean;
  commentsLoading: boolean;
  checksLoaded: boolean;
  commentsLoaded: boolean;
  defaultChecksOpen: boolean;
  defaultCommentsOpen: boolean;
};

function resolveDescriptionProps(props: PullRequestSummaryProps) {
  return { detailBoundedData: props.detailBoundedData ?? null };
}

function resolveChecksProps(props: PullRequestSummaryProps) {
  return {
    checksHasMore: props.checksHasMore ?? false,
    checksBoundedData: props.checksBoundedData ?? null,
    checksLoading: props.checksLoading ?? false,
    checksLoaded: props.checksLoaded ?? false,
    defaultChecksOpen: props.defaultChecksOpen ?? true,
  };
}

function resolveCommentsProps(props: PullRequestSummaryProps) {
  return {
    commentsHasMore: props.commentsHasMore ?? false,
    commentsBoundedData: props.commentsBoundedData ?? null,
    commentsLoading: props.commentsLoading ?? false,
    commentsLoaded: props.commentsLoaded ?? false,
    defaultCommentsOpen: props.defaultCommentsOpen ?? true,
  };
}

function resolvePullRequestSummaryProps(
  props: PullRequestSummaryProps,
): ResolvedPullRequestSummaryProps {
  return {
    ...props,
    ...resolveDescriptionProps(props),
    ...resolveChecksProps(props),
    ...resolveCommentsProps(props),
  };
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function checkVisual(state: PullRequestCheckState): {
  icon: LucideIcon;
  className: string;
} {
  if (state === "passing") {
    return {
      icon: CircleCheck,
      className: "text-[var(--diff-add-strong)]",
    };
  }
  if (state === "failing" || state === "cancelled") {
    return { icon: CircleX, className: "text-[var(--diff-remove-strong)]" };
  }
  if (state === "pending") {
    return { icon: Loader2, className: "animate-spin text-primary" };
  }
  if (state === "neutral" || state === "skipped") {
    return { icon: CircleMinus, className: "text-muted-foreground" };
  }
  return { icon: CircleHelp, className: "text-muted-foreground" };
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
  const visual = checkVisual(check.state);
  const CheckIcon = visual.icon;

  return (
    <>
      <CheckIcon
        size={15}
        strokeWidth={CI_ICON_STROKE}
        data-check-state={check.state}
        aria-hidden
        className={cn("shrink-0", visual.className)}
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
      rowClassName="flex min-w-0 items-center gap-2.5 py-2 text-xs"
      renderItem={(check) => <CheckRow check={check} />}
    />
  );
});

CheckList.displayName = "CheckList";

function ConversationAuthor({
  author,
}: {
  author: PullRequestActor | null;
}) {
  const label = author?.login ?? "Unknown actor";
  const avatarUrl = author?.avatarUrl
    ? safePullRequestHttpUrl(author.avatarUrl)
    : null;

  return (
    <span className="flex min-w-0 items-center gap-2 font-medium text-foreground/90">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-5 shrink-0 rounded-full object-cover"
        />
      ) : (
        <UserRound
          size={16}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

type IssueComment = Extract<
  PullRequestConversationItem,
  { kind: "issue_comment" }
>;

interface ConversationRowProps {
  item: PullRequestConversationItem;
  canReply: boolean;
  replying: boolean;
  prompting: boolean;
  onReply: (item: IssueComment) => void;
  onTogglePrompt: (item: IssueComment) => void;
  onPromptFix?: (item: IssueComment) => void;
  replyComposer: ReactNode;
}

function IssueCommentActions({
  item,
  canReply,
  prompting,
  onReply,
  onTogglePrompt,
  onPromptFix,
}: {
  item: IssueComment;
  canReply: boolean;
  prompting: boolean;
  onReply: (item: IssueComment) => void;
  onTogglePrompt: (item: IssueComment) => void;
  onPromptFix?: (item: IssueComment) => void;
}) {
  if (!canReply && !onPromptFix) return null;

  return (
    <div className="mt-3 flex items-center gap-2">
      {onPromptFix && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          aria-expanded={prompting}
          onClick={() => onTogglePrompt(item)}
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={cn(
              "transition-transform",
              prompting ? "rotate-0" : "-rotate-90",
            )}
          />
          Prompt to fix with AI
        </Button>
      )}
      {canReply && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-xs text-muted-foreground"
          onClick={() => onReply(item)}
        >
          Reply
        </Button>
      )}
    </div>
  );
}

function PromptFixConfirmation({
  item,
  prompting,
  onPromptFix,
}: {
  item: IssueComment;
  prompting: boolean;
  onPromptFix?: (item: IssueComment) => void;
}) {
  if (!prompting || !onPromptFix) return null;

  return (
    <div className="mt-2 flex items-center gap-3 border-t border-border/40 pt-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        Start a Review task with this comment as context.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="text-xs"
        onClick={() => onPromptFix(item)}
      >
        Create task
      </Button>
    </div>
  );
}

function IssueCommentRow({
  item,
  canReply,
  replying,
  prompting,
  onReply,
  onTogglePrompt,
  onPromptFix,
  replyComposer,
}: Omit<ConversationRowProps, "item"> & { item: IssueComment }) {
  const author = item.author?.login ?? "Unknown actor";

  return (
    <article
      aria-label={`Comment from ${author}`}
      className="min-w-0 overflow-hidden rounded-lg bg-card/45 px-4 py-4"
    >
      <header className="flex min-h-8 items-center gap-2 pb-3 text-xs text-muted-foreground">
        <ConversationAuthor author={item.author} />
        <time dateTime={item.createdAt} className="font-mono tabular-nums">
          {formatRelative(item.createdAt)}
        </time>
      </header>
      <div>
        <RemoteMarkdown content={item.body} className={CONVERSATION_MARKDOWN_CLASS} />
      </div>
      {!replying && (
        <IssueCommentActions
          item={item}
          canReply={canReply}
          prompting={prompting}
          onReply={onReply}
          onTogglePrompt={onTogglePrompt}
          onPromptFix={onPromptFix}
        />
      )}
      <PromptFixConfirmation
        item={item}
        prompting={prompting}
        onPromptFix={onPromptFix}
      />
      {replying ? replyComposer : null}
    </article>
  );
}

function ReviewThreadRow({
  item,
}: {
  item: Extract<PullRequestConversationItem, { kind: "review_thread" }>;
}) {
  const location = `${item.path}${item.line === null ? "" : `:${item.line}`}`;
  return (
    <article
      aria-label={`Review thread on ${location}`}
      className="min-w-0 overflow-hidden rounded-lg bg-card/45 px-4 py-4"
    >
      <header className="flex min-h-8 min-w-0 flex-wrap items-center gap-2 pb-3 text-xs">
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
      </header>
      <div className="divide-y divide-border/40">
        {item.comments.map((comment) => {
          return (
            <section key={comment.providerNodeId} className="py-4 first:pt-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ConversationAuthor author={comment.author} />
                <time
                  dateTime={comment.createdAt}
                  className="font-mono tabular-nums"
                >
                  {formatRelative(comment.createdAt)}
                </time>
              </div>
              <RemoteMarkdown
                content={comment.body}
                className={cn("mt-3", CONVERSATION_MARKDOWN_CLASS)}
              />
            </section>
          );
        })}
      </div>
      {item.totalCount > item.comments.length && (
        <p className="border-t border-border/40 pt-3 font-mono text-xs text-muted-foreground">
          Showing {item.comments.length} of {item.totalCount} thread comments.
        </p>
      )}
    </article>
  );
}

const ConversationRow = memo(function ConversationRow(props: ConversationRowProps) {
  if (props.item.kind === "issue_comment") {
    return <IssueCommentRow {...props} item={props.item} />;
  }
  return <ReviewThreadRow item={props.item} />;
});

ConversationRow.displayName = "ConversationRow";

const ConversationList = memo(function ConversationList({
  comments,
  activeReplyId,
  activePromptId,
  canReply,
  onReply,
  onTogglePrompt,
  onPromptFix,
  replyComposer,
}: {
  comments: readonly PullRequestConversationItem[];
  activeReplyId: string | null;
  activePromptId: string | null;
  canReply: boolean;
  onReply: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  onTogglePrompt: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  onPromptFix?: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  replyComposer: ReactNode;
}) {
  return (
    <ResourceList
      items={comments}
      label="Loaded comments"
      estimateSize={208}
      getItemKey={(item) => item.providerNodeId}
      rowClassName="pb-4 last:pb-0"
      renderItem={(item) => (
        <ConversationRow
          item={item}
          canReply={
            canReply &&
            item.kind === "issue_comment" &&
            Boolean(item.author?.login)
          }
          replying={item.providerNodeId === activeReplyId}
          prompting={item.providerNodeId === activePromptId}
          onReply={onReply}
          onTogglePrompt={onTogglePrompt}
          onPromptFix={item.kind === "issue_comment" ? onPromptFix : undefined}
          replyComposer={replyComposer}
        />
      )}
    />
  );
});

ConversationList.displayName = "ConversationList";

function SummaryDescription({
  body,
  boundedData,
}: {
  body: string;
  boundedData: PullRequestBoundedDataMarker | null;
}) {
  return (
    <section aria-label="Description">
      {body ? (
        <RemoteMarkdown
          content={body}
          className="max-w-[72ch] [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0"
        />
      ) : (
        <p className="text-xs text-muted-foreground">No description</p>
      )}
      {boundedData && (
        <p
          role="status"
          data-bounded-reason={boundedData.reason}
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
  );
}

function ResourceListState({
  loading,
  loaded,
  itemCount,
  loadingLabel,
  emptyLabel,
  children,
}: {
  loading: boolean;
  loaded: boolean;
  itemCount: number;
  loadingLabel: string;
  emptyLabel: string;
  children: ReactNode;
}) {
  if (loading && itemCount === 0) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
      >
        <Spinner size="xs" aria-hidden />
        {loadingLabel}
      </p>
    );
  }
  if (loaded && itemCount === 0) {
    return <p className="py-3 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return children;
}

function ResourceLoadContinuation({
  boundedData,
  subject,
  hasMore,
  loading,
  onLoadMore,
  loadingLabel,
  loadMoreLabel,
}: {
  boundedData: PullRequestBoundedDataMarker | null;
  subject: "check records" | "comments";
  hasMore: boolean;
  loading: boolean;
  onLoadMore: (() => void) | undefined;
  loadingLabel: string;
  loadMoreLabel: string;
}) {
  if (boundedData) return <BoundedDataNotice marker={boundedData} subject={subject} />;
  if (!hasMore || !onLoadMore) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mt-2 w-full text-xs text-muted-foreground"
      onClick={onLoadMore}
      disabled={loading}
    >
      {loading ? loadingLabel : loadMoreLabel}
    </Button>
  );
}

function PullRequestResourceSection({
  label,
  icon,
  loadedCount,
  totalCount,
  defaultOpen,
  onOpenChange,
  children,
}: {
  label: "Checks" | "Comments";
  icon: ReactNode;
  loadedCount: number;
  totalCount: number;
  defaultOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      className="border-t border-border/45"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group h-11 w-full justify-start rounded-none px-0 text-xs hover:bg-muted/15 aria-expanded:bg-transparent dark:hover:bg-muted/10 dark:aria-expanded:bg-transparent"
          aria-label={`${label}, ${loadedCount} loaded of ${totalCount}`}
        >
          {icon}
          <span>{label}</span>
          <Badge
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
          >
            {totalCount}
          </Badge>
          <ChevronDown
            size={13}
            aria-hidden
            className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function ChecksResourceContent({
  checks,
  loading,
  loaded,
  boundedData,
  hasMore,
  onLoadMore,
}: {
  checks: readonly PullRequestCheck[];
  loading: boolean;
  loaded: boolean;
  boundedData: PullRequestBoundedDataMarker | null;
  hasMore: boolean;
  onLoadMore: (() => void) | undefined;
}) {
  return (
    <>
      <ResourceListState
        loading={loading}
        loaded={loaded}
        itemCount={checks.length}
        loadingLabel="Loading checks"
        emptyLabel="No checks reported."
      >
        <CheckList checks={checks} />
      </ResourceListState>
      <ResourceLoadContinuation
        boundedData={boundedData}
        subject="check records"
        hasMore={hasMore}
        loading={loading}
        onLoadMore={onLoadMore}
        loadingLabel="Loading checks"
        loadMoreLabel="Load more checks"
      />
    </>
  );
}

function CommentsResourceContent({
  comments,
  loading,
  loaded,
  boundedData,
  hasMore,
  onLoadMore,
  activeReplyId,
  activePromptId,
  canReply,
  onReply,
  onTogglePrompt,
  onPromptFix,
  replyComposer,
}: {
  comments: readonly PullRequestConversationItem[];
  loading: boolean;
  loaded: boolean;
  boundedData: PullRequestBoundedDataMarker | null;
  hasMore: boolean;
  onLoadMore: (() => void) | undefined;
  activeReplyId: string | null;
  activePromptId: string | null;
  canReply: boolean;
  onReply: (item: IssueComment) => void;
  onTogglePrompt: (item: IssueComment) => void;
  onPromptFix?: (item: IssueComment) => void;
  replyComposer: ReactNode;
}) {
  return (
    <>
      <ResourceListState
        loading={loading}
        loaded={loaded}
        itemCount={comments.length}
        loadingLabel="Loading comments"
        emptyLabel="No comments yet."
      >
        <ConversationList
          comments={comments}
          activeReplyId={activeReplyId}
          activePromptId={activePromptId}
          canReply={canReply}
          onReply={onReply}
          onTogglePrompt={onTogglePrompt}
          onPromptFix={onPromptFix}
          replyComposer={replyComposer}
        />
      </ResourceListState>
      <ResourceLoadContinuation
        boundedData={boundedData}
        subject="comments"
        hasMore={hasMore}
        loading={loading}
        onLoadMore={onLoadMore}
        loadingLabel="Loading comments"
        loadMoreLabel="Load more comments"
      />
    </>
  );
}

interface ActiveReply {
  identityKey: string;
  providerNodeId: string;
  actor: string;
}

interface ActivePrompt {
  identityKey: string;
  providerNodeId: string;
}

function useActiveReply(
  identityKey: string,
  identity: PullRequestDetail["identity"],
): {
  activeReply: ActiveReply | null;
  activeReplyId: string | null;
  startReply: (item: IssueComment) => void;
  clearActiveReply: () => void;
} {
  const [storedActiveReply, setActiveReply] = useState<ActiveReply | null>(
    null,
  );
  const activeReply =
    storedActiveReply?.identityKey === identityKey ? storedActiveReply : null;
  const activeReplyId = activeReply?.providerNodeId ?? null;
  const startReply = useCallback(
    (item: IssueComment): void => {
      const actor = item.author?.login;
      if (!actor) return;
      const mutationStore = usePullRequestMutationStore.getState();
      if (!mutationStore.commentDrafts[identityKey]?.trim()) {
        mutationStore.setCommentDraft(identity, `@${actor} `);
      }
      setActiveReply({
        identityKey,
        providerNodeId: item.providerNodeId,
        actor,
      });
    },
    [identity, identityKey],
  );
  const clearActiveReply = useCallback((): void => setActiveReply(null), []);

  return { activeReply, activeReplyId, startReply, clearActiveReply };
}

function useActivePrompt(identityKey: string): {
  activePromptId: string | null;
  toggleActivePrompt: (item: IssueComment) => void;
  clearActivePrompt: () => void;
} {
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
  const activePromptId =
    activePrompt?.identityKey === identityKey
      ? activePrompt.providerNodeId
      : null;
  const toggleActivePrompt = useCallback(
    (item: IssueComment): void => {
      setActivePrompt((current) =>
        current?.identityKey === identityKey &&
        current.providerNodeId === item.providerNodeId
          ? null
          : { identityKey, providerNodeId: item.providerNodeId },
      );
    },
    [identityKey],
  );
  const clearActivePrompt = useCallback((): void => setActivePrompt(null), []);

  return { activePromptId, toggleActivePrompt, clearActivePrompt };
}

function useReplyComposer({
  activeReply,
  identity,
  expected,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
  onCancel,
}: {
  activeReply: ActiveReply | null;
  identity: PullRequestDetail["identity"];
  expected: ReturnType<typeof pullRequestMutationExpected>;
  capability: PullRequestCapability | null | undefined;
  mutationTransport: PullRequestMutationTransport | undefined;
  readTransport: PullRequestTransport | undefined;
  onRefresh: (() => Promise<boolean> | boolean) | undefined;
  onCancel: () => void;
}): ReactNode {
  return useMemo(() => {
    if (!activeReply) return null;
    return (
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={capability}
        mutationTransport={mutationTransport}
        readTransport={readTransport}
        onRefresh={onRefresh}
        variant="reply"
        replyTo={activeReply.actor}
        onCancel={onCancel}
        onPosted={onCancel}
      />
    );
  }, [
    activeReply,
    capability,
    expected,
    identity,
    mutationTransport,
    onCancel,
    onRefresh,
    readTransport,
  ]);
}

function PullRequestSummaryComponent(props: PullRequestSummaryProps) {
  return <PullRequestSummaryContent {...resolvePullRequestSummaryProps(props)} />;
}

function PullRequestSummaryContent({
  detail,
  checks,
  comments,
  detailBoundedData,
  checksHasMore,
  commentsHasMore,
  checksBoundedData,
  commentsBoundedData,
  checksLoading,
  commentsLoading,
  checksLoaded,
  commentsLoaded,
  onLoadMoreChecks,
  onLoadMoreComments,
  onChecksFirstOpen,
  onCommentsFirstOpen,
  commentCapability,
  mutationTransport,
  readTransport,
  onRefresh,
  onPromptFix,
  defaultChecksOpen,
  defaultCommentsOpen,
}: ResolvedPullRequestSummaryProps) {
  const conversationCount = detail.commentCount + detail.reviewThreadCount;
  const identityKey = getPullRequestMutationIdentityKey(detail.identity);
  const expected = pullRequestMutationExpected(detail);
  const { activeReply, activeReplyId, startReply: startActiveReply, clearActiveReply } =
    useActiveReply(identityKey, detail.identity);
  const { activePromptId, toggleActivePrompt, clearActivePrompt } =
    useActivePrompt(identityKey);
  const canReply = commentCapability?.allowed === true && expected !== null;
  const startReply = useCallback((item: IssueComment): void => {
    clearActivePrompt();
    startActiveReply(item);
  }, [clearActivePrompt, startActiveReply]);
  const togglePrompt = useCallback(
    (item: IssueComment): void => {
      clearActiveReply();
      toggleActivePrompt(item);
    },
    [clearActiveReply, toggleActivePrompt],
  );
  const replyComposer = useReplyComposer({
    activeReply,
    identity: detail.identity,
    expected,
    capability: commentCapability,
    mutationTransport,
    readTransport,
    onRefresh,
    onCancel: clearActiveReply,
  });
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
      className="mx-auto min-w-0 w-full max-w-5xl space-y-10 px-4 pb-12 sm:px-6"
    >
      <SummaryDescription body={detail.body} boundedData={detailBoundedData} />
      <PullRequestResourceSection
        label="Checks"
        icon={null}
        loadedCount={checks.length}
        totalCount={detail.checkCount}
        defaultOpen={defaultChecksOpen}
        onOpenChange={handleChecksOpenChange}
      >
        <ChecksResourceContent
          checks={checks}
          loading={checksLoading}
          loaded={checksLoaded}
          boundedData={checksBoundedData}
          hasMore={checksHasMore}
          onLoadMore={onLoadMoreChecks}
        />
      </PullRequestResourceSection>
      <PullRequestResourceSection
        label="Comments"
        icon={<MessageCircle size={13} aria-hidden className="text-muted-foreground" />}
        loadedCount={comments.length}
        totalCount={conversationCount}
        defaultOpen={defaultCommentsOpen}
        onOpenChange={handleCommentsOpenChange}
      >
        <CommentsResourceContent
          comments={comments}
          loading={commentsLoading}
          loaded={commentsLoaded}
          boundedData={commentsBoundedData}
          hasMore={commentsHasMore}
          onLoadMore={onLoadMoreComments}
          activeReplyId={activeReplyId}
          activePromptId={activePromptId}
          canReply={canReply}
          onReply={startReply}
          onTogglePrompt={togglePrompt}
          onPromptFix={onPromptFix}
          replyComposer={replyComposer}
        />
      </PullRequestResourceSection>
    </section>
  );
}

/** Read-only orientation view for pull request detail, checks, and conversation. */
export const PullRequestSummary = memo(PullRequestSummaryComponent);

PullRequestSummary.displayName = "PullRequestSummary";
