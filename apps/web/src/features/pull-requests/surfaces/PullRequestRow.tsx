import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { memo, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  selectPullRequestByKey,
  selectPullRequestIsSelected,
} from "@/features/pull-requests/state/pull-request-selectors";
import { usePullRequestDetailStore } from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";

/** Props for one normalized pull request inbox row. */
export interface PullRequestRowProps {
  identityKey: string;
  onSelect?: (identityKey: string) => void;
  describedBy?: string;
  positionInSet?: number;
  setSize?: number;
}

const checkPresentation = {
  passing: { label: "Checks passing", tone: "bg-[var(--diff-add-strong)]/70" },
  failing: {
    label: "Checks failing",
    tone: "bg-[var(--diff-remove-strong)]/75",
  },
  pending: { label: "Checks pending", tone: "bg-primary/75" },
  neutral: { label: "Checks neutral", tone: "bg-muted-foreground/55" },
  unknown: { label: "Checks unavailable", tone: "bg-muted-foreground/35" },
} as const;

const statePresentation = {
  open: {
    icon: GitPullRequest,
    tone: "text-[var(--diff-add-strong)]",
  },
  draft: {
    icon: GitPullRequestDraft,
    tone: "text-muted-foreground/75",
  },
  closed: {
    icon: GitPullRequestClosed,
    tone: "text-destructive/85",
  },
  merged: {
    icon: GitMerge,
    tone: "text-violet-400 dark:text-violet-300",
  },
} as const;

function relativeTime(value: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - Date.parse(value)) / 1_000),
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d`;
}

/** Return a DOM-safe row id for an untrusted provider identity key. */
export function getPullRequestRowDomId(identityKey: string): string {
  return `pull-request-row-${encodeURIComponent(identityKey)}`;
}

function safeRemoteImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function PullRequestRowComponent({
  identityKey,
  onSelect,
  describedBy,
  positionInSet,
  setSize,
}: PullRequestRowProps) {
  const item = usePullRequestStore(selectPullRequestByKey(identityKey));
  const selected = usePullRequestStore(
    selectPullRequestIsSelected(identityKey),
  );
  const select = usePullRequestStore((state) => state.setSelectedKey);
  const detailOpen = usePullRequestDetailStore(
    (state) => state.activeKey === identityKey,
  );

  const accessibleName = useMemo(() => {
    if (!item) return "Pull request unavailable";
    const actor = item.author?.login ?? "unknown author";
    return `${item.title}, pull request #${item.identity.number}, ${item.identity.owner}/${item.identity.repository}, ${actor}, ${item.state}, ${item.readiness}, updated ${relativeTime(item.updatedAt)}`;
  }, [item]);

  if (!item) return null;
  const checks = checkPresentation[item.checks.state];
  const stateKey =
    item.state === "open" && item.readiness === "draft"
      ? "draft"
      : item.state;
  const state = statePresentation[stateKey];
  const StateIcon = state.icon;
  const avatarUrl = safeRemoteImageUrl(item.author?.avatarUrl);

  return (
    <Button
      id={getPullRequestRowDomId(identityKey)}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={accessibleName}
      aria-describedby={describedBy}
      aria-posinset={positionInSet}
      aria-setsize={setSize}
      variant="ghost"
      data-testid="pull-request-row"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        select(identityKey);
        onSelect?.(identityKey);
        if (event.detail === 0) {
          const listbox = event.currentTarget.closest('[role="listbox"]');
          if (listbox instanceof HTMLElement) listbox.focus();
        }
      }}
      className={cn(
        "group h-auto w-full justify-start rounded-none px-5 py-4 text-left shadow-none transition-colors duration-150",
        detailOpen
          ? "bg-muted/40 text-foreground hover:bg-muted/55"
          : selected
            ? "bg-foreground/[0.025] text-foreground hover:bg-foreground/[0.05]"
            : "text-foreground/90 hover:bg-foreground/[0.035]",
      )}
    >
      <span className="flex min-w-0 flex-1 items-start gap-3">
        <span
          data-pull-request-state={stateKey}
          className={cn(
            "relative mt-1 flex size-5 shrink-0 items-center justify-center",
            state.tone,
          )}
        >
          <StateIcon size={15} aria-hidden />
          <span
            aria-label={checks.label}
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full",
              checks.tone,
            )}
          />
        </span>
        <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium leading-5 tracking-[-0.01em]">
              {item.title}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
              #{item.identity.number}
            </span>
          </span>
          <time
            dateTime={item.updatedAt}
            className="justify-self-end text-right font-mono text-xs tabular-nums text-muted-foreground/80"
          >
            {relativeTime(item.updatedAt)}
          </time>
          <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-4 shrink-0 rounded-full opacity-85"
              />
            )}
            <span className="truncate">
              {item.identity.owner}/{item.identity.repository}
            </span>
            <span aria-hidden className="text-muted-foreground/35">
              ·
            </span>
            <span className="truncate">{item.head.name}</span>
          </span>
          <span className="flex items-center justify-end gap-2 font-mono text-xs font-medium tabular-nums text-muted-foreground/80">
            {item.additions > 0 && <span>+{item.additions}</span>}
            {item.deletions > 0 && <span>−{item.deletions}</span>}
          </span>
        </span>
      </span>
    </Button>
  );
}

/** Fine-grained pull request row subscribed only to its normalized entity and selection. */
export const PullRequestRow = memo(PullRequestRowComponent);
