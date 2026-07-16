import type {
  PullRequestCapabilities,
  PullRequestDetail,
  PullRequestSummary,
} from "@mcode/contracts";
import { ArrowLeft, ExternalLink, GitPullRequest, X } from "lucide-react";
import { type ReactNode, type Ref } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestLifecycleActions } from "./PullRequestLifecycleActions";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

/** Props for the persistent navigation and action bar above pull request detail views. */
export interface PullRequestDetailToolbarProps {
  model?: PullRequestDetail | PullRequestSummary | null;
  detail?: PullRequestDetail | null;
  tabs: ReactNode;
  /** View-specific action shown before persistent pull request actions. */
  viewAction?: ReactNode;
  isNarrow?: boolean;
  reserveSidebarReveal?: boolean;
  onBack?: () => void;
  backButtonRef?: Ref<HTMLButtonElement>;
  onClose?: () => void;
  capabilities?: PullRequestCapabilities | null;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh?: () => Promise<boolean> | boolean;
  onRefreshClick?: () => void;
  refreshing?: boolean;
  /** Opens a composer that forks the pull request into a task. */
  onFork?: () => void;
  /** Opens the same fork composer while keeping the pull request visible. */
  onForkInBackground?: () => void;
  /** Whether the pull request can be forked into a local task. */
  forkAllowed?: boolean;
  /** Explains why pull request forking is unavailable. */
  forkUnavailableReason?: string | null;
}

/** Renders top-level pull request tabs and actions in one compact toolbar. */
export function PullRequestDetailToolbar({
  model = null,
  detail = null,
  tabs,
  viewAction,
  isNarrow = false,
  reserveSidebarReveal = false,
  onBack,
  backButtonRef,
  onClose,
  capabilities,
  mutationTransport,
  readTransport,
  onRefresh,
  onRefreshClick,
  refreshing = false,
  onFork,
  onForkInBackground,
  forkAllowed = false,
  forkUnavailableReason = null,
}: PullRequestDetailToolbarProps) {
  const browserUrl = model ? safePullRequestHttpUrl(model.url) : null;

  return (
    <header
      aria-label="Pull request detail"
      className="shrink-0 border-b border-border/35 bg-page/95 px-3"
    >
      <div className="grid h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {isNarrow && reserveSidebarReveal && (
            <span
              aria-hidden
              data-testid="pull-request-sidebar-reveal-spacer"
              className="w-8 shrink-0"
            />
          )}
          {isNarrow ? (
            onBack ? (
              <Button
                ref={backButtonRef}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Back to pull requests"
                onClick={onBack}
              >
                <ArrowLeft size={14} aria-hidden />
              </Button>
            ) : null
          ) : (
            <>
              <GitPullRequest
                size={14}
                aria-hidden
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate font-mono text-xs text-foreground/75">
                {model
                  ? `${model.identity.owner}/${model.identity.repository}`
                  : "Pull request"}
              </span>
              {model ? (
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  #{model.identity.number}
                </span>
              ) : null}
            </>
          )}
        </div>

        {tabs}

        <div className="flex min-w-0 items-center justify-end gap-1">
          {viewAction}
          {detail && capabilities !== undefined && onRefresh ? (
            <PullRequestLifecycleActions
              detail={detail}
              capabilities={capabilities}
              mutationTransport={mutationTransport}
              readTransport={readTransport}
              onRefresh={onRefresh}
              onRefreshClick={onRefreshClick}
              refreshing={refreshing}
              onFork={onFork}
              onForkInBackground={onForkInBackground}
              forkAllowed={forkAllowed}
              forkUnavailableReason={forkUnavailableReason}
            />
          ) : null}
          {browserUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={browserUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open in browser"
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "icon-xs" }),
                      "text-muted-foreground",
                    )}
                  >
                    <ExternalLink size={13} aria-hidden />
                  </a>
                }
              />
              <TooltipContent>Open in browser</TooltipContent>
            </Tooltip>
          ) : null}
          {!isNarrow && onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close pull request detail"
              className="text-muted-foreground"
              onClick={onClose}
            >
              <X size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
