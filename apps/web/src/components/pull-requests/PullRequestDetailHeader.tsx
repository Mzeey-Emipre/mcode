import type {
  PullRequestCheckState,
  PullRequestDetail,
  PullRequestMergeability,
  PullRequestReviewer,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import {
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  GitBranch,
  MessageSquare,
  Users,
} from "lucide-react";
import { memo } from "react";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

/** Props for the pull request identity block rendered inside Summary. */
export interface PullRequestDetailHeaderProps {
  detail?: PullRequestDetail | null;
  summaryFallback?: PullRequestSummaryRecord | null;
  isNarrow?: boolean;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mergeabilityTone(mergeability: PullRequestMergeability): string {
  if (mergeability === "mergeable") return "text-[var(--diff-add-strong)]";
  if (mergeability === "conflicting") return "text-destructive";
  return "text-muted-foreground";
}

function checkTone(state: PullRequestCheckState): string {
  if (state === "passing") return "text-[var(--diff-add-strong)]";
  if (state === "failing" || state === "cancelled") return "text-destructive";
  if (state === "pending") return "text-primary";
  return "text-muted-foreground";
}

function checkLabel(state: PullRequestCheckState): string {
  return state === "passing"
    ? "Checks successful"
    : `${titleCase(state)} checks`;
}

function reviewerLabel(reviewer: PullRequestReviewer): string {
  if (reviewer.target.kind === "user") return reviewer.target.actor.login;
  return `${reviewer.target.organization}/${reviewer.target.slug}`;
}

function reviewerAvatarUrl(reviewer: PullRequestReviewer): string | null {
  if (reviewer.target.kind !== "user" || !reviewer.target.actor.avatarUrl) {
    return null;
  }
  return safePullRequestHttpUrl(reviewer.target.actor.avatarUrl);
}

function PullRequestDetailHeaderComponent({
  detail,
  summaryFallback = null,
  isNarrow = false,
}: PullRequestDetailHeaderProps) {
  const model = detail ?? summaryFallback;
  if (!model) return null;

  const actor = model.author?.login ?? "Unknown author";
  const avatarUrl = model.author?.avatarUrl
    ? safePullRequestHttpUrl(model.author.avatarUrl)
    : null;
  const readiness = model.readiness === "ready" ? "Ready for review" : "Draft";
  const reviewers = detail?.reviewers ?? [];
  const conversationCount =
    model.commentCount + (detail?.reviewThreadCount ?? 0);

  return (
    <header aria-label="Pull request summary identity">
      <div
        className={cn(
          "mx-auto w-full max-w-5xl",
          isNarrow ? "px-4 pb-6 pt-6" : "px-6 pb-8 pt-8",
        )}
      >
        <h2 className="break-words text-xl font-semibold leading-tight text-foreground [text-wrap:pretty]">
          {model.title}
        </h2>

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground/80">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={actor}
                className="size-4 rounded-full object-cover"
              />
            ) : (
              <CircleUserRound
                size={15}
                aria-hidden
                className="text-muted-foreground"
              />
            )}
            <span>{actor}</span>
          </span>
          <span aria-hidden>·</span>
          <time dateTime={model.updatedAt} className="tabular-nums">
            {formatRelative(model.updatedAt)}
          </time>
          <span aria-hidden>·</span>
          <span>{readiness}</span>
          {detail ? (
            <>
              <span aria-hidden>·</span>
              <span className={mergeabilityTone(detail.mergeability)}>
                {titleCase(detail.mergeability)}
              </span>
            </>
          ) : null}
        </div>

        <dl className="mt-8 space-y-3 text-xs">
          <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
            <GitBranch
              size={14}
              aria-hidden
              className="text-muted-foreground/80"
            />
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="flex min-w-0 items-center gap-2 font-mono">
              <span
                aria-label={`Head branch ${model.head.name}`}
                className="min-w-0 truncate text-foreground/90"
              >
                {model.head.name}
              </span>
              <ChevronRight
                size={13}
                aria-hidden
                className="shrink-0 text-muted-foreground/55"
              />
              <span
                aria-label={`Base branch ${model.base.name}`}
                className="min-w-0 truncate text-foreground/90"
              >
                {model.base.name}
              </span>
              {model.additions > 0 ? (
                <span
                  aria-label={`${model.additions} additions`}
                  className="ml-1 shrink-0 text-[var(--diff-add-strong)]"
                >
                  +{model.additions}
                </span>
              ) : null}
              {model.deletions > 0 ? (
                <span
                  aria-label={`${model.deletions} deletions`}
                  className="shrink-0 text-[var(--diff-remove-strong)]"
                >
                  −{model.deletions}
                </span>
              ) : null}
            </dd>
          </div>

          <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
            <Users size={14} aria-hidden className="text-muted-foreground/80" />
            <dt className="text-muted-foreground">Reviewers</dt>
            <dd className="flex min-w-0 items-center gap-2 text-foreground/90">
              {!detail ? (
                "Loading"
              ) : reviewers.length > 0 ? (
                <>
                  <span aria-hidden className="flex shrink-0 -space-x-1.5">
                    {reviewers.slice(0, 4).map((reviewer) => {
                      const label = reviewerLabel(reviewer);
                      const reviewerAvatar = reviewerAvatarUrl(reviewer);
                      return reviewerAvatar ? (
                        <img
                          key={label}
                          src={reviewerAvatar}
                          alt=""
                          className="size-5 rounded-full border border-page object-cover"
                        />
                      ) : (
                        <span
                          key={label}
                          className="inline-flex size-5 items-center justify-center rounded-full border border-page bg-muted text-xs font-medium uppercase text-muted-foreground"
                        >
                          {label.charAt(0)}
                        </span>
                      );
                    })}
                  </span>
                  <span className="min-w-0 truncate">
                    {reviewers.map(reviewerLabel).join(" · ")}
                  </span>
                </>
              ) : (
                "No reviewers"
              )}
            </dd>
          </div>

          <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
            <MessageSquare
              size={14}
              aria-hidden
              className="text-muted-foreground/80"
            />
            <dt className="text-muted-foreground">Comments</dt>
            <dd className="text-foreground/90">
              {conversationCount}{" "}
              {conversationCount === 1 ? "comment" : "comments"}
            </dd>
          </div>

          <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
            <CheckCircle2
              size={14}
              aria-hidden
              className={checkTone(model.checks.state)}
            />
            <dt className="text-muted-foreground">Checks</dt>
            <dd className="text-foreground/90">
              {checkLabel(model.checks.state)}
            </dd>
          </div>
        </dl>
      </div>
    </header>
  );
}

/** Pull request identity and orientation shown once inside the Summary view. */
export const PullRequestDetailHeader = memo(PullRequestDetailHeaderComponent);

PullRequestDetailHeader.displayName = "PullRequestDetailHeader";
