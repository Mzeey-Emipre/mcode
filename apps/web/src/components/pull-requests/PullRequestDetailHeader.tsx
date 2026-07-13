import type {
  PullRequestDetail,
  PullRequestCapabilities,
  PullRequestMergeability,
  PullRequestRef,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import { ArrowLeft, ExternalLink, GitBranch, X } from "lucide-react";
import { memo, type Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestLifecycleActions } from "./PullRequestLifecycleActions";

/** Props for the persistent pull request detail header. */
export interface PullRequestDetailHeaderProps {
  /** Provider-neutral detail record displayed across every detail tab. */
  detail?: PullRequestDetail | null;
  /** Selected inbox record retained while full detail is loading or unavailable. */
  summaryFallback?: PullRequestSummaryRecord | null;
  /** Uses the compact header treatment for narrow detail surfaces. */
  isNarrow?: boolean;
  /** Reserves the compact header slot occupied by the collapsed-sidebar control. */
  reserveSidebarReveal?: boolean;
  /** Shows the optional back action when a callback is available. */
  showBack?: boolean;
  /** Returns a narrow detail surface to the pull request inbox. */
  onBack?: () => void;
  /** Optional focus target for the narrow back action. */
  backButtonRef?: Ref<HTMLButtonElement>;
  /** Closes the pull request detail surface. */
  onClose?: () => void;
  /** Independently gated remote actions shown only after capabilities resolve. */
  capabilities?: PullRequestCapabilities | null;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  /** Refreshes the selected remote state before a stale confirmation is rebuilt. */
  onRefresh?: () => Promise<boolean> | boolean;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function refLabel(ref: PullRequestRef): string {
  return ref.owner ? `${ref.owner}:${ref.name}` : ref.name;
}

function mergeabilityTone(mergeability: PullRequestMergeability): string {
  if (mergeability === "mergeable") return "text-[var(--diff-add-strong)]";
  if (mergeability === "conflicting") return "text-destructive";
  return "text-muted-foreground";
}

function PullRequestDetailHeaderComponent({
  detail,
  summaryFallback = null,
  isNarrow = false,
  reserveSidebarReveal = false,
  showBack = false,
  onBack,
  backButtonRef,
  onClose,
  capabilities,
  mutationTransport,
  readTransport,
  onRefresh,
}: PullRequestDetailHeaderProps) {
  const model = detail ?? summaryFallback;
  if (!model) return null;

  const repository = `${model.identity.owner}/${model.identity.repository}`;
  const actor = model.author ? `@${model.author.login}` : "Unknown author";
  const browserUrl = safePullRequestHttpUrl(model.url);

  return (
    <header
      aria-label="Pull request detail"
      className={cn("shrink-0 bg-page px-4 py-3", isNarrow && "px-3 py-2")}
    >
      <div
        className={cn("flex min-w-0 items-center gap-2", isNarrow && "min-h-8")}
      >
        {isNarrow && reserveSidebarReveal && (
          <span
            aria-hidden
            data-testid="pull-request-sidebar-reveal-spacer"
            className="w-8 shrink-0"
          />
        )}
        {showBack && onBack && (
          <Button
            ref={backButtonRef}
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-2 gap-1.5 px-2 font-medium text-foreground/85 hover:text-foreground"
            aria-label="Back to pull requests"
            onClick={onBack}
          >
            <ArrowLeft size={14} aria-hidden />
            <span>Pull requests</span>
          </Button>
        )}
        {!isNarrow && (
          <>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {repository}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
              #{model.identity.number}
            </span>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail && capabilities !== undefined && onRefresh ? (
            <PullRequestLifecycleActions
              detail={detail}
              capabilities={capabilities}
              isNarrow={isNarrow}
              mutationTransport={mutationTransport}
              readTransport={readTransport}
              onRefresh={onRefresh}
            />
          ) : null}
          {browserUrl && (
            <a
              href={browserUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in browser"
              className={cn(
                buttonVariants({
                  variant: "ghost",
                  size: isNarrow ? "icon-xs" : "xs",
                }),
                "text-xs text-muted-foreground",
                !isNarrow && "px-2",
              )}
            >
              {!isNarrow && <span>Open in browser</span>}
              <ExternalLink size={12} aria-hidden />
            </a>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Close pull request detail"
              onClick={onClose}
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {isNarrow && (
        <div
          data-testid="pull-request-detail-context"
          className="mt-1 flex min-w-0 items-center gap-2"
        >
          <span className="truncate font-mono text-xs text-muted-foreground">
            {repository}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
            #{model.identity.number}
          </span>
        </div>
      )}

      <h2
        className={cn(
          "max-w-4xl break-words font-semibold leading-tight text-foreground [text-wrap:pretty]",
          isNarrow ? "mt-2 text-lg" : "mt-1.5 text-lg",
        )}
      >
        {model.title}
      </h2>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{actor}</span>
        <time dateTime={model.updatedAt} className="font-mono tabular-nums">
          {formatRelative(model.updatedAt)}
        </time>
        <Badge variant="ghost" size="sm" className="capitalize">
          {titleCase(model.state)}
        </Badge>
        <Badge variant="ghost" size="sm" className="capitalize">
          {titleCase(model.readiness)}
        </Badge>
        {detail && (
          <Badge
            variant="ghost"
            size="sm"
            className={cn("capitalize", mergeabilityTone(detail.mergeability))}
          >
            {titleCase(detail.mergeability)}
          </Badge>
        )}
      </div>

      <div
        className={cn(
          "mt-3 flex bg-background/35 px-3 py-2 font-mono text-xs",
          isNarrow
            ? "flex-col items-stretch gap-2"
            : "flex-wrap items-center gap-x-5 gap-y-2",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <GitBranch size={13} aria-hidden className="shrink-0" />
          <span
            aria-label={`Base branch ${model.base.name}`}
            className="min-w-0 flex-1 truncate"
          >
            {refLabel(model.base)}
          </span>
          <ArrowLeft size={12} aria-hidden className="shrink-0 opacity-45" />
          <span
            aria-label={`Head branch ${model.head.name}`}
            className="min-w-0 flex-1 truncate text-foreground/85"
          >
            {refLabel(model.head)}
          </span>
        </span>
        <span
          className={cn(
            "flex items-center gap-3 tabular-nums",
            isNarrow ? "justify-end" : "ml-auto",
          )}
        >
          <span
            aria-label={`${model.additions} additions`}
            className="text-[var(--diff-add-strong)]"
          >
            +{model.additions}
          </span>
          <span
            aria-label={`${model.deletions} deletions`}
            className="text-[var(--diff-remove-strong)]"
          >
            −{model.deletions}
          </span>
          {detail && (
            <span
              aria-label={`${detail.changedFiles} changed files`}
              className="text-muted-foreground"
            >
              {detail.changedFiles} files
            </span>
          )}
        </span>
      </div>
    </header>
  );
}

/** Persistent identity and merge context shared by pull request detail tabs. */
export const PullRequestDetailHeader = memo(PullRequestDetailHeaderComponent);

PullRequestDetailHeader.displayName = "PullRequestDetailHeader";
