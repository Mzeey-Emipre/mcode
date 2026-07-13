import type {
  PullRequestCapabilities,
  PullRequestCapability,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestReadiness,
} from "@mcode/contracts";
import {
  CircleDot,
  GitFork,
  GitMerge,
  MoreHorizontal,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestLifecycleDialog } from "./PullRequestLifecycleDialog";
import { pullRequestCapabilityReason } from "./PullRequestMutationError";

type LifecycleEffect = "readiness" | "close" | "merge";

function mergeMethodLabel(method: PullRequestMergeMethod): string {
  if (method === "squash") return "Squash and merge";
  if (method === "rebase") return "Rebase and merge";
  return "Create a merge commit";
}

/** Props for remote and local actions in the persistent pull request header. */
export interface PullRequestLifecycleActionsProps {
  detail: PullRequestDetail;
  capabilities: PullRequestCapabilities | null;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh: () => Promise<boolean> | boolean;
  onRefreshClick?: () => void;
  refreshing?: boolean;
  onFork?: () => void;
  onForkInBackground?: () => void;
  forkAllowed?: boolean;
  forkUnavailableReason?: string | null;
}

function unavailableReason(
  detail: PullRequestDetail,
  capability: PullRequestCapability | null | undefined,
  effect: LifecycleEffect,
): string | null {
  const capabilityReason = pullRequestCapabilityReason(capability);
  if (capabilityReason) return capabilityReason;
  if (detail.state !== "open")
    return `This pull request is already ${detail.state}.`;
  if (effect === "merge" && detail.readiness === "draft") {
    return "Mark this pull request ready before merging it.";
  }
  if (effect === "merge" && detail.mergeability === "conflicting") {
    return "Resolve merge conflicts before choosing a merge method.";
  }
  return null;
}

/** Renders one overflow menu for pull request lifecycle, refresh, and fork actions. */
export function PullRequestLifecycleActions({
  detail,
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
}: PullRequestLifecycleActionsProps) {
  const [activeEffect, setActiveEffect] = useState<LifecycleEffect | null>(
    null,
  );
  const [targetReadiness, setTargetReadiness] =
    useState<PullRequestReadiness>();
  const [targetMergeMethod, setTargetMergeMethod] =
    useState<PullRequestMergeMethod>(detail.defaultMergeMethod);
  const readinessReason = unavailableReason(
    detail,
    capabilities?.readiness,
    "readiness",
  );
  const closeReason = unavailableReason(detail, capabilities?.close, "close");
  const mergeReason = unavailableReason(detail, capabilities?.merge, "merge");
  const nextReadiness: PullRequestReadiness =
    detail.readiness === "draft" ? "ready" : "draft";

  const openReadiness = (): void => {
    setTargetReadiness(nextReadiness);
    setActiveEffect("readiness");
  };

  const openMerge = (method: PullRequestMergeMethod): void => {
    setTargetMergeMethod(method);
    setActiveEffect("merge");
  };

  const refresh = (): void => {
    if (onRefreshClick) {
      onRefreshClick();
      return;
    }
    void onRefresh();
  };

  const activeCapability =
    activeEffect === "readiness"
      ? capabilities?.readiness
      : activeEffect === "close"
        ? capabilities?.close
        : capabilities?.merge;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Pull request actions"
            >
              <MoreHorizontal size={14} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={Boolean(readinessReason)}
              className="text-xs"
              onClick={openReadiness}
            >
              <CircleDot size={13} aria-hidden />
              {nextReadiness === "ready"
                ? "Mark ready for review"
                : "Convert to draft"}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                disabled={Boolean(mergeReason)}
                className="text-xs"
              >
                <GitMerge size={13} aria-hidden />
                Merge
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-52">
                <DropdownMenuGroup>
                  {detail.mergeMethods.map((method) => (
                    <DropdownMenuItem
                      key={method}
                      className="text-xs"
                      onClick={() => openMerge(method)}
                    >
                      <GitMerge size={13} aria-hidden />
                      {mergeMethodLabel(method)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {mergeReason ? (
              <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
                {mergeReason}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={refreshing}
              className="text-xs"
              onClick={refresh}
            >
              {refreshing ? (
                <Spinner size={13} aria-hidden />
              ) : (
                <RefreshCw size={13} aria-hidden />
              )}
              Refresh
            </DropdownMenuItem>
            {onFork ? (
              <DropdownMenuItem
                disabled={!forkAllowed}
                className="text-xs"
                onClick={onFork}
              >
                <GitFork size={13} aria-hidden />
                Fork
              </DropdownMenuItem>
            ) : null}
            {onForkInBackground ? (
              <DropdownMenuItem
                disabled={!forkAllowed}
                className="text-xs"
                onClick={onForkInBackground}
              >
                <GitFork size={13} aria-hidden />
                Fork in background
              </DropdownMenuItem>
            ) : null}
            {!forkAllowed && forkUnavailableReason ? (
              <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
                {forkUnavailableReason}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={Boolean(closeReason)}
              className="text-xs text-destructive"
              onClick={() => setActiveEffect("close")}
            >
              <XCircle size={13} aria-hidden />
              Close pull request
            </DropdownMenuItem>
            {readinessReason || closeReason ? (
              <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
                {readinessReason ?? closeReason}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {activeEffect ? (
        <PullRequestLifecycleDialog
          open
          onOpenChange={(open) => {
            if (!open) setActiveEffect(null);
          }}
          detail={detail}
          effect={activeEffect}
          targetReadiness={
            activeEffect === "readiness" ? targetReadiness : undefined
          }
          initialMergeMethod={
            activeEffect === "merge" ? targetMergeMethod : undefined
          }
          capability={activeCapability}
          mutationTransport={mutationTransport}
          readTransport={readTransport}
          onRefresh={onRefresh}
        />
      ) : null}
    </>
  );
}
