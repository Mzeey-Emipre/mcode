import type {
  PullRequestCapabilities,
  PullRequestCapability,
  PullRequestDetail,
  PullRequestReadiness,
} from "@mcode/contracts";
import { CircleDot, EllipsisVertical, GitMerge, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestLifecycleDialog } from "./PullRequestLifecycleDialog";
import { pullRequestCapabilityReason } from "./PullRequestMutationError";

type LifecycleEffect = "readiness" | "close" | "merge";

/** Props for lifecycle actions in the persistent pull request header. */
export interface PullRequestLifecycleActionsProps {
  detail: PullRequestDetail;
  capabilities: PullRequestCapabilities | null;
  isNarrow: boolean;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh: () => Promise<boolean> | boolean;
}

function unavailableReason(
  detail: PullRequestDetail,
  capability: PullRequestCapability | null | undefined,
  effect: LifecycleEffect,
): string | null {
  const capabilityReason = pullRequestCapabilityReason(capability);
  if (capabilityReason) return capabilityReason;
  if (detail.state !== "open") return `This pull request is already ${detail.state}.`;
  if (effect === "merge" && detail.readiness === "draft") {
    return "Draft pull requests cannot be merged.";
  }
  if (effect === "merge" && detail.mergeability === "conflicting") {
    return "The change stack has merge conflicts.";
  }
  return null;
}

/** Compact, capability-gated entry points for readiness, close, and merge. */
export function PullRequestLifecycleActions({
  detail,
  capabilities,
  isNarrow,
  mutationTransport,
  readTransport,
  onRefresh,
}: PullRequestLifecycleActionsProps) {
  const [activeEffect, setActiveEffect] = useState<LifecycleEffect | null>(null);
  const [targetReadiness, setTargetReadiness] = useState<PullRequestReadiness>();
  const readinessReason = unavailableReason(detail, capabilities?.readiness, "readiness");
  const closeReason = unavailableReason(detail, capabilities?.close, "close");
  const mergeReason = unavailableReason(detail, capabilities?.merge, "merge");
  const nextReadiness: PullRequestReadiness =
    detail.readiness === "draft" ? "ready" : "draft";

  const openReadiness = (): void => {
    setTargetReadiness(nextReadiness);
    setActiveEffect("readiness");
  };

  const activeCapability =
    activeEffect === "readiness"
      ? capabilities?.readiness
      : activeEffect === "close"
        ? capabilities?.close
        : capabilities?.merge;

  return (
    <>
      {!isNarrow && !mergeReason ? (
        <Button
          type="button"
          size="xs"
          onClick={() => setActiveEffect("merge")}
        >
          <GitMerge size={12} aria-hidden />
          Merge
        </Button>
      ) : null}
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
              <EllipsisVertical size={14} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Remote actions
            </DropdownMenuLabel>
            <DropdownMenuItem
              disabled={Boolean(readinessReason)}
              className="text-xs"
              onClick={openReadiness}
            >
              <CircleDot size={13} aria-hidden />
              {nextReadiness === "ready" ? "Mark ready for review" : "Convert to draft"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={Boolean(mergeReason)}
              className="text-xs"
              onClick={() => setActiveEffect("merge")}
            >
              <GitMerge size={13} aria-hidden />
              Merge pull request
            </DropdownMenuItem>
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
            {readinessReason || closeReason || mergeReason ? (
              <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
                {readinessReason ?? closeReason ?? mergeReason}
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
          targetReadiness={activeEffect === "readiness" ? targetReadiness : undefined}
          capability={activeCapability}
          mutationTransport={mutationTransport}
          readTransport={readTransport}
          onRefresh={onRefresh}
        />
      ) : null}
    </>
  );
}
