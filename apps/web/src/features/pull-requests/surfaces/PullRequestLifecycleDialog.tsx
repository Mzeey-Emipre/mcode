import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestReadiness,
} from "@mcode/contracts";
import {
  AlertCircle,
  GitBranch,
  GitMerge,
  GitPullRequest,
  ShieldOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  selectPullRequestMutationLane,
  selectPullRequestOutcomeUnknownLane,
} from "@/features/pull-requests/state/pull-request-mutation-selectors";
import { getPullRequestDetailKey } from "@/features/pull-requests/state/pullRequestDetailStore";
import {
  usePullRequestMutationStore,
  type PullRequestMutationEffect,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  PullRequestMutationError,
  pullRequestCapabilityReason,
  pullRequestMutationExpected,
} from "./PullRequestMutationError";

type LifecycleEffect = Extract<
  PullRequestMutationEffect,
  "readiness" | "close" | "merge"
>;

const textEncoder = new TextEncoder();

/** Props for one effect-specific pull request lifecycle confirmation. */
export interface PullRequestLifecycleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: PullRequestDetail;
  effect: LifecycleEffect;
  targetReadiness?: PullRequestReadiness;
  initialMergeMethod?: PullRequestMergeMethod;
  capability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh: () => Promise<boolean> | boolean;
}

function effectTitle(
  effect: LifecycleEffect,
  targetReadiness: PullRequestReadiness | undefined,
): string {
  if (effect === "merge") return "Merge pull request";
  if (effect === "close") return "Close pull request";
  return targetReadiness === "ready"
    ? "Mark ready for review"
    : "Convert to draft";
}

function effectDescription(
  effect: LifecycleEffect,
  targetReadiness: PullRequestReadiness | undefined,
): string {
  if (effect === "merge")
    return "Merge the confirmed head into the base branch on GitHub.";
  if (effect === "close")
    return "Close this pull request on GitHub without deleting its local Review task.";
  return targetReadiness === "ready"
    ? "Publish this draft as ready for review on GitHub."
    : "Move this pull request back to draft state on GitHub.";
}

function confirmLabel(
  effect: LifecycleEffect,
  targetReadiness: PullRequestReadiness | undefined,
  bypassRequirements: boolean,
): string {
  if (effect === "merge") {
    return bypassRequirements ? "Bypass and merge" : "Merge pull request";
  }
  if (effect === "close") return "Close pull request";
  return targetReadiness === "ready" ? "Mark ready" : "Convert to draft";
}

/** Confirm one readiness, close, or merge effect against the visible snapshot. */
export function PullRequestLifecycleDialog({
  open,
  onOpenChange,
  detail,
  effect,
  targetReadiness,
  initialMergeMethod,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
}: PullRequestLifecycleDialogProps) {
  const identityKey = getPullRequestDetailKey(detail.identity);
  const laneSelector = useMemo(
    () => selectPullRequestMutationLane(detail.identity, effect),
    [effect, identityKey],
  );
  const lane = usePullRequestMutationStore(laneSelector);
  const unknownSelector = useMemo(
    () => selectPullRequestOutcomeUnknownLane(detail.identity),
    [identityKey],
  );
  const outcomeUnknownLane = usePullRequestMutationStore(unknownSelector);
  const displayedError = outcomeUnknownLane?.error ?? lane.error;
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>(
    initialMergeMethod ?? detail.defaultMergeMethod,
  );
  const [bypassRequirements, setBypassRequirements] = useState(false);
  const [commitHeadline, setCommitHeadline] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const expected = pullRequestMutationExpected(detail);
  const submitting = lane.status === "submitting";
  const mutationBlocked =
    submitting || lane.status === "error" || Boolean(outcomeUnknownLane);
  const capabilityReason = pullRequestCapabilityReason(capability);
  const repository = `${detail.identity.owner}/${detail.identity.repository}`;
  const unavailableReason =
    capabilityReason ??
    (detail.state === "open"
      ? null
      : `This pull request is already ${detail.state}.`) ??
    (expected ? null : "Base or head commit identity is unavailable.") ??
    (effect === "merge" && detail.readiness === "draft"
      ? "Mark this pull request ready before merging it."
      : null) ??
    (effect === "merge" && detail.mergeability === "conflicting"
      ? "The change stack has merge conflicts."
      : null);

  useEffect(() => {
    if (!open) return;
    setMergeMethod(
      initialMergeMethod && detail.mergeMethods.includes(initialMergeMethod)
        ? initialMergeMethod
        : detail.defaultMergeMethod,
    );
    setBypassRequirements(false);
    setCommitHeadline("");
    setCommitBody("");
    setLocalError(null);
    usePullRequestMutationStore.getState().clearLane(detail.identity, effect);
  }, [
    detail.defaultMergeMethod,
    detail.mergeMethods,
    effect,
    identityKey,
    initialMergeMethod,
    open,
  ]);

  const close = (nextOpen: boolean): void => {
    if (submitting) return;
    onOpenChange(nextOpen);
  };

  const submit = async (): Promise<void> => {
    if (mutationBlocked || unavailableReason || !expected) return;
    if (effect === "readiness" && !targetReadiness) {
      setLocalError("Requested readiness is unavailable.");
      return;
    }
    setLocalError(null);
    const dependencies = { mutationTransport, readTransport };
    const store = usePullRequestMutationStore.getState();
    const result =
      effect === "readiness"
        ? await store.setReadiness(
            {
              identity: detail.identity,
              expected,
              readiness: targetReadiness!,
            },
            dependencies,
          )
        : effect === "close"
          ? await store.close(
              { identity: detail.identity, expected },
              dependencies,
            )
          : await store.merge(
              {
                identity: detail.identity,
                expected,
                method: mergeMethod,
                ...(bypassRequirements ? { bypassRequirements: true } : {}),
                ...(commitHeadline.trim()
                  ? { commitHeadline: commitHeadline.trim() }
                  : {}),
                ...(commitBody ? { commitBody } : {}),
              },
              dependencies,
            );
    if (result.ok) onOpenChange(false);
  };

  const retry = async (): Promise<void> => {
    const result = await usePullRequestMutationStore
      .getState()
      .retry(detail.identity, effect, { mutationTransport, readTransport });
    if (result?.ok) onOpenChange(false);
  };

  const refresh = async (): Promise<void> => {
    const store = usePullRequestMutationStore.getState();
    if (outcomeUnknownLane) {
      const acknowledged = await store.acknowledgeOutcomeUnknownAfterRefresh(
        detail.identity,
        onRefresh,
      );
      if (acknowledged) onOpenChange(false);
      return;
    }
    if (await onRefresh()) store.clearLane(detail.identity, effect);
  };

  const title = effectTitle(effect, targetReadiness);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={!submitting}
        className="max-h-[90vh] w-[min(94vw,560px)] gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        aria-busy={submitting || undefined}
      >
        <header className="flex items-start gap-3 bg-page px-5 py-4 pr-12">
          {effect === "merge" ? (
            <GitMerge
              size={18}
              aria-hidden
              className="mt-0.5 shrink-0 text-primary/85"
            />
          ) : (
            <GitPullRequest
              size={18}
              aria-hidden
              className="mt-0.5 shrink-0 text-primary/85"
            />
          )}
          <div className="min-w-0">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              {effectDescription(effect, targetReadiness)}
            </DialogDescription>
          </div>
        </header>

        <ScrollArea className="min-h-0 max-h-[65vh]">
          <div className="space-y-4 px-5 py-4">
            <div className="bg-page/65 px-4 py-3">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Remote effect
              </p>
              <p className="mt-2 text-sm font-medium text-foreground/90">
                {repository} #{detail.identity.number}
              </p>
              <div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                <GitBranch size={13} aria-hidden />
                <span className="truncate">{detail.base.name}</span>
                <span aria-hidden className="opacity-45">
                  ←
                </span>
                <span className="truncate text-foreground/85">
                  {detail.head.name}
                </span>
                {detail.head.oid ? (
                  <span className="ml-auto shrink-0 tabular-nums">
                    {detail.head.oid.slice(0, 8)}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Effect: <span className="text-foreground/85">{title}</span>
              </p>
            </div>

            {effect === "readiness" ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Current</dt>
                <dd className="capitalize text-foreground/85">
                  {detail.readiness}
                </dd>
                <dt className="text-muted-foreground">After confirmation</dt>
                <dd className="capitalize text-foreground/85">
                  {targetReadiness}
                </dd>
              </dl>
            ) : null}

            {effect === "merge" ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Checks</dt>
                  <dd className="capitalize text-foreground/85">
                    {detail.checks.state}
                  </dd>
                  <dt className="text-muted-foreground">Mergeability</dt>
                  <dd className="capitalize text-foreground/85">
                    {detail.mergeability}
                  </dd>
                </dl>
                <div className="space-y-1.5">
                  <label
                    htmlFor="pull-request-merge-method"
                    className="text-xs text-muted-foreground"
                  >
                    Merge method
                  </label>
                  <Select
                    value={mergeMethod}
                    onValueChange={(value) =>
                      setMergeMethod(value as PullRequestMergeMethod)
                    }
                    disabled={mutationBlocked}
                  >
                    <SelectTrigger
                      id="pull-request-merge-method"
                      className="w-full"
                    >
                      <SelectValue>
                        {mergeMethod === "merge"
                          ? "Merge commit"
                          : mergeMethod === "squash"
                            ? "Squash and merge"
                            : "Rebase and merge"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {detail.mergeMethods.map((method) => (
                        <SelectItem key={method} value={method}>
                          {method === "merge"
                            ? "Merge commit"
                            : method === "squash"
                              ? "Squash and merge"
                              : "Rebase and merge"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {unavailableReason ? (
                  <p
                    role="status"
                    className="flex items-start gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground"
                  >
                    <AlertCircle
                      size={13}
                      aria-hidden
                      className="mt-0.5 shrink-0 text-primary/80"
                    />
                    {unavailableReason}
                  </p>
                ) : null}
                {detail.viewerCanBypassMergeRequirements ? (
                  <div className="flex items-start gap-3 border-t border-border/45 pt-4">
                    <Checkbox
                      id="pull-request-bypass-requirements"
                      checked={bypassRequirements}
                      disabled={mutationBlocked}
                      aria-labelledby="pull-request-bypass-requirements-label"
                      aria-describedby="pull-request-bypass-requirements-description"
                      onCheckedChange={setBypassRequirements}
                    />
                    <span className="min-w-0">
                      <label
                        id="pull-request-bypass-requirements-label"
                        htmlFor="pull-request-bypass-requirements"
                        className="block cursor-pointer text-xs font-medium text-foreground/90"
                      >
                        Merge without waiting for requirements
                      </label>
                      <span
                        id="pull-request-bypass-requirements-description"
                        className="mt-0.5 block text-xs leading-5 text-muted-foreground"
                      >
                        Use administrator permission to bypass branch protection
                        rules.
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 border-t border-border/45 pt-4 text-muted-foreground">
                    <ShieldOff
                      size={15}
                      aria-hidden
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground/80">
                        Admin bypass unavailable
                      </span>
                      <span className="mt-0.5 block text-xs leading-5">
                        GitHub does not allow this account to bypass merge
                        requirements.
                      </span>
                    </span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label
                    htmlFor="pull-request-merge-headline"
                    className="text-xs text-muted-foreground"
                  >
                    Commit headline, optional
                  </label>
                  <Input
                    id="pull-request-merge-headline"
                    value={commitHeadline}
                    maxLength={512}
                    disabled={mutationBlocked}
                    onChange={(event) => setCommitHeadline(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="pull-request-merge-body"
                    className="text-xs text-muted-foreground"
                  >
                    Commit body, optional
                  </label>
                  <Textarea
                    id="pull-request-merge-body"
                    value={commitBody}
                    rows={3}
                    disabled={mutationBlocked}
                    className="resize-y rounded-none"
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        textEncoder.encode(value).byteLength >
                        PULL_REQUEST_MUTATION_BODY_MAX_BYTES
                      ) {
                        setLocalError(
                          "Commit body exceeds the 64 KiB UTF-8 limit.",
                        );
                        return;
                      }
                      setCommitBody(value);
                      setLocalError(null);
                    }}
                  />
                </div>
              </>
            ) : null}

            {effect !== "merge" && unavailableReason ? (
              <p
                role="status"
                className="flex items-start gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground"
              >
                <AlertCircle
                  size={13}
                  aria-hidden
                  className="mt-0.5 shrink-0 text-primary/80"
                />
                {unavailableReason}
              </p>
            ) : null}
            {localError ? (
              <p role="alert" className="text-xs text-destructive">
                {localError}
              </p>
            ) : null}
            {displayedError ? (
              <PullRequestMutationError
                error={displayedError}
                busy={submitting}
                onRetry={() => void retry()}
                onRefresh={() => void refresh()}
              />
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter className="m-0 flex-row justify-end rounded-none bg-page/65 px-5 py-3.5">
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => close(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={effect === "close" ? "destructive" : "default"}
            disabled={
              mutationBlocked ||
              Boolean(unavailableReason) ||
              Boolean(localError)
            }
            onClick={() => void submit()}
          >
            {submitting ? (
              <>
                <Spinner size="xs" aria-hidden />
                Applying effect
              </>
            ) : (
              confirmLabel(effect, targetReadiness, bypassRequirements)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
