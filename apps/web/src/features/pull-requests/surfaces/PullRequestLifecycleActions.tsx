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

interface LifecycleActionReasons {
  readiness: string | null;
  close: string | null;
  merge: string | null;
}

interface LifecycleDialogTargets {
  targetReadiness?: PullRequestReadiness;
  initialMergeMethod?: PullRequestMergeMethod;
}

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

function lifecycleActionReasons(
  detail: PullRequestDetail,
  capabilities: PullRequestCapabilities | null,
): LifecycleActionReasons {
  return {
    readiness: unavailableReason(detail, capabilities?.readiness, "readiness"),
    close: unavailableReason(detail, capabilities?.close, "close"),
    merge: unavailableReason(detail, capabilities?.merge, "merge"),
  };
}

function nextReadinessFor(detail: PullRequestDetail): PullRequestReadiness {
  return detail.readiness === "draft" ? "ready" : "draft";
}

function readinessActionLabel(readiness: PullRequestReadiness): string {
  return readiness === "ready" ? "Mark ready for review" : "Convert to draft";
}

function activeCapabilityFor(
  effect: LifecycleEffect,
  capabilities: PullRequestCapabilities | null,
): PullRequestCapability | null | undefined {
  if (effect === "readiness") return capabilities?.readiness;
  if (effect === "close") return capabilities?.close;
  return capabilities?.merge;
}

function lifecycleDialogTargets(
  effect: LifecycleEffect,
  targetReadiness: PullRequestReadiness | undefined,
  targetMergeMethod: PullRequestMergeMethod,
): LifecycleDialogTargets {
  if (effect === "readiness") return { targetReadiness };
  if (effect === "merge") return { initialMergeMethod: targetMergeMethod };
  return {};
}

function requestRefresh(
  onRefresh: () => Promise<boolean> | boolean,
  onRefreshClick: (() => void) | undefined,
): void {
  if (onRefreshClick) {
    onRefreshClick();
    return;
  }
  void onRefresh();
}

interface LifecycleRemoteActionsProps {
  detail: PullRequestDetail;
  mergeReason: string | null;
  nextReadiness: PullRequestReadiness;
  readinessReason: string | null;
  onOpenReadiness: () => void;
  onOpenMerge: (method: PullRequestMergeMethod) => void;
}

function LifecycleRemoteActions({
  detail,
  mergeReason,
  nextReadiness,
  readinessReason,
  onOpenReadiness,
  onOpenMerge,
}: LifecycleRemoteActionsProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem
        disabled={Boolean(readinessReason)}
        className="text-xs"
        onClick={onOpenReadiness}
      >
        <CircleDot size={13} aria-hidden />
        {readinessActionLabel(nextReadiness)}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={Boolean(mergeReason)} className="text-xs">
          <GitMerge size={13} aria-hidden />
          Merge
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-52">
          <DropdownMenuGroup>
            {detail.mergeMethods.map((method) => (
              <DropdownMenuItem
                key={method}
                className="text-xs"
                onClick={() => onOpenMerge(method)}
              >
                <GitMerge size={13} aria-hidden />
                {mergeMethodLabel(method)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {mergeReason ? <MenuReason reason={mergeReason} /> : null}
    </DropdownMenuGroup>
  );
}

function MenuReason({ reason }: { reason: string }) {
  return (
    <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
      {reason}
    </DropdownMenuLabel>
  );
}

function RefreshMenuItem({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <DropdownMenuItem disabled={refreshing} className="text-xs" onClick={onRefresh}>
      {refreshing ? <Spinner size={13} aria-hidden /> : <RefreshCw size={13} aria-hidden />}
      Refresh
    </DropdownMenuItem>
  );
}

function ForkMenuItem({
  label,
  allowed,
  onClick,
}: {
  label: string;
  allowed: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem disabled={!allowed} className="text-xs" onClick={onClick}>
      <GitFork size={13} aria-hidden />
      {label}
    </DropdownMenuItem>
  );
}

interface LifecycleUtilityActionsProps {
  forkAllowed: boolean;
  forkUnavailableReason: string | null;
  refreshing: boolean;
  onFork?: () => void;
  onForkInBackground?: () => void;
  onRefresh: () => void;
}

function LifecycleUtilityActions({
  forkAllowed,
  forkUnavailableReason,
  refreshing,
  onFork,
  onForkInBackground,
  onRefresh,
}: LifecycleUtilityActionsProps) {
  return (
    <DropdownMenuGroup>
      <RefreshMenuItem refreshing={refreshing} onRefresh={onRefresh} />
      {onFork ? <ForkMenuItem label="Fork" allowed={forkAllowed} onClick={onFork} /> : null}
      {onForkInBackground ? (
        <ForkMenuItem
          label="Fork in background"
          allowed={forkAllowed}
          onClick={onForkInBackground}
        />
      ) : null}
      {!forkAllowed && forkUnavailableReason ? <MenuReason reason={forkUnavailableReason} /> : null}
    </DropdownMenuGroup>
  );
}

function LifecycleCloseActions({
  closeReason,
  readinessReason,
  onClose,
}: {
  closeReason: string | null;
  readinessReason: string | null;
  onClose: () => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem
        disabled={Boolean(closeReason)}
        className="text-xs text-destructive"
        onClick={onClose}
      >
        <XCircle size={13} aria-hidden />
        Close pull request
      </DropdownMenuItem>
      {readinessReason || closeReason ? <MenuReason reason={readinessReason ?? closeReason ?? ""} /> : null}
    </DropdownMenuGroup>
  );
}

interface LifecycleActionDialogProps {
  activeEffect: LifecycleEffect | null;
  capabilities: PullRequestCapabilities | null;
  detail: PullRequestDetail;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  targetMergeMethod: PullRequestMergeMethod;
  targetReadiness: PullRequestReadiness | undefined;
  onRefresh: () => Promise<boolean> | boolean;
  onClose: () => void;
}

function LifecycleActionDialog({
  activeEffect,
  capabilities,
  detail,
  mutationTransport,
  readTransport,
  targetMergeMethod,
  targetReadiness,
  onRefresh,
  onClose,
}: LifecycleActionDialogProps) {
  if (!activeEffect) return null;
  const targets = lifecycleDialogTargets(activeEffect, targetReadiness, targetMergeMethod);
  return (
    <PullRequestLifecycleDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      detail={detail}
      effect={activeEffect}
      capability={activeCapabilityFor(activeEffect, capabilities)}
      mutationTransport={mutationTransport}
      readTransport={readTransport}
      onRefresh={onRefresh}
      {...targets}
    />
  );
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
  const reasons = lifecycleActionReasons(detail, capabilities);
  const nextReadiness = nextReadinessFor(detail);

  const openReadiness = (): void => {
    setTargetReadiness(nextReadiness);
    setActiveEffect("readiness");
  };

  const openMerge = (method: PullRequestMergeMethod): void => {
    setTargetMergeMethod(method);
    setActiveEffect("merge");
  };

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
          <LifecycleRemoteActions
            detail={detail}
            mergeReason={reasons.merge}
            nextReadiness={nextReadiness}
            readinessReason={reasons.readiness}
            onOpenReadiness={openReadiness}
            onOpenMerge={openMerge}
          />

          <DropdownMenuSeparator />
          <LifecycleUtilityActions
            forkAllowed={forkAllowed}
            forkUnavailableReason={forkUnavailableReason}
            refreshing={refreshing}
            onFork={onFork}
            onForkInBackground={onForkInBackground}
            onRefresh={() => requestRefresh(onRefresh, onRefreshClick)}
          />

          <DropdownMenuSeparator />
          <LifecycleCloseActions
            closeReason={reasons.close}
            readinessReason={reasons.readiness}
            onClose={() => setActiveEffect("close")}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <LifecycleActionDialog
        activeEffect={activeEffect}
        capabilities={capabilities}
        detail={detail}
        mutationTransport={mutationTransport}
        readTransport={readTransport}
        targetMergeMethod={targetMergeMethod}
        targetReadiness={targetReadiness}
        onRefresh={onRefresh}
        onClose={() => setActiveEffect(null)}
      />
    </>
  );
}
