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

const ConversationRow = memo(function ConversationRow({
  item,
  canReply,
  replying,
  prompting,
  onReply,
  onTogglePrompt,
  onPromptFix,
  replyComposer,
}: {
  item: PullRequestConversationItem;
  canReply: boolean;
  replying: boolean;
  prompting: boolean;
  onReply: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  onTogglePrompt: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  onPromptFix?: (item: Extract<PullRequestConversationItem, { kind: "issue_comment" }>) => void;
  replyComposer: ReactNode;
}) {
  if (item.kind === "issue_comment") {
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
          <RemoteMarkdown
            content={item.body}
            className={CONVERSATION_MARKDOWN_CLASS}
          />
        </div>
        {(canReply || onPromptFix) && !replying ? (
          <div className="mt-3 flex items-center gap-2">
            {onPromptFix ? (
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
            ) : null}
            {canReply ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-xs text-muted-foreground"
                onClick={() => onReply(item)}
              >
                Reply
              </Button>
            ) : null}
          </div>
        ) : null}
        {prompting && onPromptFix ? (
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
        ) : null}
        {replying ? replyComposer : null}
      </article>
    );
  }

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
  commentCapability,
  mutationTransport,
  readTransport,
  onRefresh,
  onPromptFix,
  defaultChecksOpen = true,
  defaultCommentsOpen = true,
}: PullRequestSummaryProps) {
  const [activeReply, setActiveReply] = useState<{
    identityKey: string;
    providerNodeId: string;
    actor: string;
  } | null>(null);
  const [activePrompt, setActivePrompt] = useState<{
    identityKey: string;
    providerNodeId: string;
  } | null>(null);
  const conversationCount = detail.commentCount + detail.reviewThreadCount;
  const identityKey = getPullRequestMutationIdentityKey(detail.identity);
  const expected = pullRequestMutationExpected(detail);
  const activeReplyId =
    activeReply?.identityKey === identityKey
      ? activeReply.providerNodeId
      : null;
  const activePromptId =
    activePrompt?.identityKey === identityKey
      ? activePrompt.providerNodeId
      : null;
  const canReply = commentCapability?.allowed === true && expected !== null;
  const startReply = useCallback(
    (
      item: Extract<
        PullRequestConversationItem,
        { kind: "issue_comment" }
      >,
    ): void => {
      const actor = item.author?.login;
      if (!actor) return;
      const mutationStore = usePullRequestMutationStore.getState();
      if (!mutationStore.commentDrafts[identityKey]?.trim()) {
        mutationStore.setCommentDraft(detail.identity, `@${actor} `);
      }
      setActivePrompt(null);
      setActiveReply({
        identityKey,
        providerNodeId: item.providerNodeId,
        actor,
      });
    },
    [detail.identity, identityKey],
  );
  const togglePrompt = useCallback(
    (
      item: Extract<
        PullRequestConversationItem,
        { kind: "issue_comment" }
      >,
    ): void => {
      setActiveReply(null);
      setActivePrompt((current) =>
        current?.identityKey === identityKey &&
        current.providerNodeId === item.providerNodeId
          ? null
          : { identityKey, providerNodeId: item.providerNodeId },
      );
    },
    [identityKey],
  );
  const replyComposer = activeReplyId ? (
    <PullRequestIssueCommentComposer
      identity={detail.identity}
      expected={expected}
      capability={commentCapability}
      mutationTransport={mutationTransport}
      readTransport={readTransport}
      onRefresh={onRefresh}
      variant="reply"
      replyTo={activeReply?.actor}
      onCancel={() => setActiveReply(null)}
      onPosted={() => setActiveReply(null)}
    />
  ) : null;
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
      <section aria-label="Description">
        {detail.body ? (
          <RemoteMarkdown
            content={detail.body}
            className="max-w-[72ch] [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0"
          />
        ) : (
          <p className="text-xs text-muted-foreground">No description</p>
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
        className="border-t border-border/45"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="group h-11 w-full justify-start rounded-none px-0 text-xs hover:bg-muted/15 aria-expanded:bg-transparent dark:hover:bg-muted/10 dark:aria-expanded:bg-transparent"
            aria-label={`Checks, ${checks.length} loaded of ${detail.checkCount}`}
          >
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
        <CollapsibleContent className="pb-1">
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
        className="border-t border-border/45"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="group h-11 w-full justify-start rounded-none px-0 text-xs hover:bg-muted/15 aria-expanded:bg-transparent dark:hover:bg-muted/10 dark:aria-expanded:bg-transparent"
            aria-label={`Comments, ${comments.length} loaded of ${conversationCount}`}
          >
            <MessageCircle
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
        <CollapsibleContent className="pb-1">
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
            <ConversationList
              comments={comments}
              activeReplyId={activeReplyId}
              activePromptId={activePromptId}
              canReply={canReply}
              onReply={startReply}
              onTogglePrompt={togglePrompt}
              onPromptFix={onPromptFix}
              replyComposer={replyComposer}
            />
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
