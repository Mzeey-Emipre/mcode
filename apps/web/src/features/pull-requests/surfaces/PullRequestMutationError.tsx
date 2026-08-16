import type {
  PullRequestCapability,
  PullRequestDetail,
  PullRequestMutationError as MutationError,
  PullRequestMutationExpected,
} from "@mcode/contracts";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/** Build the immutable remote snapshot shown in a mutation confirmation. */
export function pullRequestMutationExpected(
  detail: PullRequestDetail,
): PullRequestMutationExpected | null {
  if (!detail.base.oid || !detail.head.oid) return null;
  return {
    providerNodeId: detail.providerNodeId,
    state: detail.state,
    readiness: detail.readiness,
    baseOid: detail.base.oid,
    headOid: detail.head.oid,
  };
}

/** Explain why one independently gated provider capability is unavailable. */
export function pullRequestCapabilityReason(
  capability: PullRequestCapability | null | undefined,
): string | null {
  if (capability?.allowed) return null;
  if (!capability) return "GitHub capability status is still loading.";
  if (capability.reason === "unauthenticated") return "GitHub authentication is required.";
  if (capability.reason === "missing_scope") return "The GitHub token is missing a required scope.";
  if (capability.reason === "forbidden") return "GitHub does not allow this action.";
  if (capability.reason === "remote_unavailable") return "GitHub is unavailable.";
  return "This GitHub action is unavailable.";
}

function errorMessage(error: MutationError): string {
  switch (error.conflictReason) {
    case "state_changed":
      return "Pull request state changed. Refresh it, then confirm the effect again.";
    case "head_changed":
      return "The pull request head changed. Refresh before acting on the new commit.";
    case "readiness_changed":
      return "Draft readiness changed. Refresh it, then confirm the effect again.";
    case "permission_changed":
      return "GitHub permission changed. Refresh capability status before retrying.";
    case "merge_blocked":
      return "GitHub currently blocks this merge. Refresh checks and mergeability.";
    case "idempotency_key_reused":
      return "This confirmation key was already used for another effect. Reopen and confirm again.";
    case "draft_outdated":
      return "One or more review drafts target an older change stack. Refresh before submitting.";
    case "outcome_unknown":
      return "The remote outcome could not be confirmed. Check GitHub state before doing anything else.";
    default:
      return error.message;
  }
}

function allowsSameKeyRetry(error: MutationError): boolean {
  return error.code === "rate_limited" || error.code === "remote_unavailable";
}

/** Props for a focused, typed pull request mutation failure notice. */
export interface PullRequestMutationErrorProps {
  error: MutationError;
  onRetry?: () => void;
  onRefresh?: () => void;
  busy?: boolean;
}

/** Typed inline failure with the only safe next action for its conflict class. */
export function PullRequestMutationError({
  error,
  onRetry,
  onRefresh,
  busy = false,
}: PullRequestMutationErrorProps) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    errorRef.current?.focus();
  }, [error]);

  const retry = allowsSameKeyRetry(error) && onRetry;
  const refresh = !retry && onRefresh;
  return (
    <div
      ref={errorRef}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 bg-destructive/8 px-3 py-2.5 text-xs outline-none"
    >
      <AlertCircle
        size={14}
        aria-hidden
        className="mt-0.5 shrink-0 text-destructive"
      />
      <p className="min-w-0 flex-1 leading-5 text-foreground/85">
        {errorMessage(error)}
      </p>
      {retry ? (
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={retry}>
          Retry confirmed effect
        </Button>
      ) : refresh ? (
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={refresh}>
          {error.conflictReason === "outcome_unknown" ? "Check remote state" : "Refresh"}
        </Button>
      ) : null}
    </div>
  );
}
