import type {
  PullRequestCapabilities,
  PullRequestDetail,
  PullRequestSummary,
} from "@mcode/contracts";
import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  X,
} from "lucide-react";
import { type ReactNode, type Ref } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
}

/** Renders top-level pull request tabs and actions in one compact toolbar. */
export function PullRequestDetailToolbar({
  model = null,
  detail = null,
  tabs,
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
}: PullRequestDetailToolbarProps) {
  const browserUrl = model ? safePullRequestHttpUrl(model.url) : null;

  return (
    <header
      aria-label="Pull request detail"
      className="shrink-0 border-b border-border/45 bg-page px-3"
    >
      <div className="grid h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {isNarrow && reserveSidebarReveal && (
            <span
              aria-hidden
              data-testid="pull-request-sidebar-reveal-spacer"
              className="w-8 shrink-0"
            />
          )}
          {isNarrow && onBack ? (
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
          ) : (
            <GitPullRequest
              size={14}
              aria-hidden
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate text-xs font-medium text-foreground/85">
            {model?.title ?? "Pull request"}
          </span>
        </div>

        {tabs}

        <div className="flex min-w-0 items-center justify-end gap-1">
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
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh pull request detail"
              className="text-muted-foreground"
              onClick={() => {
                if (onRefreshClick) {
                  onRefreshClick();
                  return;
                }
                void onRefresh();
              }}
            >
              {refreshing ? (
                <Spinner size={13} aria-hidden />
              ) : (
                <RefreshCw size={13} aria-hidden />
              )}
            </Button>
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
