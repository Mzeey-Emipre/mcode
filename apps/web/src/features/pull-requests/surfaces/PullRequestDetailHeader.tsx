import type {
  PullRequestCheckState,
  PullRequestDetail,
  PullRequestMergeability,
  PullRequestReviewer,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import {
  ChevronRight,
  CircleUserRound,
  GitBranch,
  MessageCircle,
  Users,
} from "lucide-react";
import { memo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

function checkRingTone(state: PullRequestCheckState): string {
  if (state === "passing") {
    return "border-[var(--diff-add-strong)]";
  }
  if (state === "failing" || state === "cancelled") {
    return "border-[var(--diff-remove-strong)]";
  }
  if (state === "pending") {
    return "animate-spin border-muted-foreground/30 border-t-primary motion-reduce:animate-none";
  }
  return "border-muted-foreground/55";
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

function reviewerStateLabel(state: PullRequestReviewer["state"]): string {
  switch (state) {
    case "requested":
      return "Review requested";
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "commented":
      return "Commented";
    case "dismissed":
      return "Dismissed";
    case "pending":
      return "Review pending";
  }
}

function reviewerStateTone(state: PullRequestReviewer["state"]): string {
  if (state === "approved") return "bg-[var(--diff-add-strong)]";
  if (state === "changes_requested") return "bg-destructive";
  if (state === "requested" || state === "pending") return "bg-primary";
  if (state === "commented") return "bg-muted-foreground";
  return "bg-muted-foreground/45";
}

function PullRequestHeaderMeta({ model, detail }: { model: PullRequestDetail | PullRequestSummaryRecord; detail: PullRequestDetail | null | undefined }) {
  const actor = model.author?.login ?? "Unknown author";
  const avatarUrl = model.author?.avatarUrl ? safePullRequestHttpUrl(model.author.avatarUrl) : null;
  const readiness = model.readiness === "ready" ? "Ready for review" : "Draft";
  return (
    <>
      <h2 className="break-words text-xl font-semibold leading-tight text-foreground [text-wrap:pretty]">{model.title}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 text-foreground/80">{avatarUrl ? <img src={avatarUrl} alt={actor} className="size-4 rounded-full object-cover" /> : <CircleUserRound size={15} aria-hidden className="text-muted-foreground" />}<span>{actor}</span></span>
        <span aria-hidden>·</span><time dateTime={model.updatedAt} className="tabular-nums">{formatRelative(model.updatedAt)}</time><span aria-hidden>·</span><span>{readiness}</span>
        {detail ? <><span aria-hidden>·</span><span className={mergeabilityTone(detail.mergeability)}>{titleCase(detail.mergeability)}</span></> : null}
      </div>
    </>
  );
}

function PullRequestBranchRow({ model }: { model: PullRequestDetail | PullRequestSummaryRecord }) {
  return (
    <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
      <GitBranch size={14} aria-hidden className="text-muted-foreground/80" /><dt className="text-muted-foreground">Branch</dt>
      <dd className="flex min-w-0 items-center gap-2 font-mono"><span aria-label={`Head branch ${model.head.name}`} className="min-w-0 truncate text-foreground/90">{model.head.name}</span><ChevronRight size={13} aria-hidden className="shrink-0 text-muted-foreground/55" /><span aria-label={`Base branch ${model.base.name}`} className="min-w-0 truncate text-foreground/90">{model.base.name}</span>{model.additions > 0 ? <span aria-label={`${model.additions} additions`} className="ml-1 shrink-0 text-[var(--diff-add-strong)]">+{model.additions}</span> : null}{model.deletions > 0 ? <span aria-label={`${model.deletions} deletions`} className="shrink-0 text-[var(--diff-remove-strong)]">−{model.deletions}</span> : null}</dd>
    </div>
  );
}

function PullRequestReviewers({ detail }: { detail: PullRequestDetail | null | undefined }) {
  const reviewers = detail?.reviewers ?? [];
  return (
    <div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]">
      <Users size={14} aria-hidden className="text-muted-foreground/80" /><dt className="text-muted-foreground">Reviewers</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-foreground/90">{!detail ? "Loading" : reviewers.length > 0 ? reviewers.map((reviewer) => { const label = reviewerLabel(reviewer); const stateLabel = reviewerStateLabel(reviewer.state); const reviewerAvatar = reviewerAvatarUrl(reviewer); return <Tooltip key={label}><TooltipTrigger render={<span role="img" tabIndex={0} aria-label={`${label}, ${stateLabel}`} className="relative inline-flex size-5 shrink-0 rounded-full outline-none ring-offset-page focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />}>{reviewerAvatar ? <img src={reviewerAvatar} alt="" className="size-5 rounded-full object-cover" /> : <span aria-hidden className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground">{label.charAt(0)}</span>}<span aria-hidden data-review-state={reviewer.state} className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-page", reviewerStateTone(reviewer.state))} /></TooltipTrigger><TooltipContent sideOffset={6}><span>{label}</span><span className="opacity-65">· {stateLabel}</span></TooltipContent></Tooltip>; }) : "No reviewers"}</dd>
    </div>
  );
}

function PullRequestDetailHeaderContent({ model, detail, isNarrow }: { model: PullRequestDetail | PullRequestSummaryRecord; detail: PullRequestDetail | null | undefined; isNarrow: boolean }) {
  const conversationCount = model.commentCount + (detail?.reviewThreadCount ?? 0);
  return (
    <header aria-label="Pull request summary identity"><div className={cn("mx-auto w-full max-w-5xl", isNarrow ? "px-4 pb-4 pt-6" : "px-6 pb-5 pt-8")}><PullRequestHeaderMeta model={model} detail={detail} /><dl className="mt-8 space-y-3 text-xs"><PullRequestBranchRow model={model} /><PullRequestReviewers detail={detail} /><div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]"><MessageCircle size={14} aria-hidden className="text-muted-foreground/80" /><dt className="text-muted-foreground">Comments</dt><dd className="text-foreground/90">{conversationCount} {conversationCount === 1 ? "comment" : "comments"}</dd></div><div className="grid min-w-0 grid-cols-[1.25rem_5.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)]"><span aria-hidden data-check-state={model.checks.state} className={cn("ml-0.5 size-3 rounded-full border-2", checkRingTone(model.checks.state))} /><dt className="text-muted-foreground">Checks</dt><dd className="text-foreground/90">{checkLabel(model.checks.state)}</dd></div></dl></div></header>
  );
}

function PullRequestDetailHeaderComponent({
  detail,
  summaryFallback = null,
  isNarrow = false,
}: PullRequestDetailHeaderProps) {
  const model = detail ?? summaryFallback;
  if (!model) return null;
  return <PullRequestDetailHeaderContent model={model} detail={detail} isNarrow={isNarrow} />;
}

/** Pull request identity and orientation shown once inside the Summary view. */
export const PullRequestDetailHeader = memo(PullRequestDetailHeaderComponent);

PullRequestDetailHeader.displayName = "PullRequestDetailHeader";
