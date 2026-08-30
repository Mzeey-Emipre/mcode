import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestMutationError as PullRequestMutationErrorValue,
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

function mergeMethodLabel(method: PullRequestMergeMethod): string {
  if (method === "merge") return "Merge commit";
  if (method === "squash") return "Squash and merge";
  return "Rebase and merge";
}

function lifecycleUnavailableReason(
  detail: PullRequestDetail,
  capability: PullRequestCapability | null | undefined,
  expected: NonNullable<ReturnType<typeof pullRequestMutationExpected>> | null,
  effect: LifecycleEffect,
): string | null {
  const capabilityReason = pullRequestCapabilityReason(capability);
  if (capabilityReason) return capabilityReason;
  if (detail.state !== "open") return `This pull request is already ${detail.state}.`;
  if (!expected) return "Base or head commit identity is unavailable.";
  if (effect === "merge" && detail.readiness === "draft") {
    return "Mark this pull request ready before merging it.";
  }
  if (effect === "merge" && detail.mergeability === "conflicting") {
    return "The change stack has merge conflicts.";
  }
  return null;
}

interface LifecycleMutationInput {
  effect: LifecycleEffect;
  detail: PullRequestDetail;
  expected: NonNullable<ReturnType<typeof pullRequestMutationExpected>>;
  targetReadiness: PullRequestReadiness;
  mergeMethod: PullRequestMergeMethod;
  bypassRequirements: boolean;
  commitHeadline: string;
  commitBody: string;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
}

async function submitLifecycleEffect({
  effect,
  detail,
  expected,
  targetReadiness,
  mergeMethod,
  bypassRequirements,
  commitHeadline,
  commitBody,
  mutationTransport,
  readTransport,
}: LifecycleMutationInput) {
  const dependencies = { mutationTransport, readTransport };
  const store = usePullRequestMutationStore.getState();
  if (effect === "readiness") {
    return store.setReadiness(
      { identity: detail.identity, expected, readiness: targetReadiness },
      dependencies,
    );
  }
  if (effect === "close") {
    return store.close({ identity: detail.identity, expected }, dependencies);
  }
  const headline = commitHeadline.trim();
  return store.merge(
    {
      identity: detail.identity,
      expected,
      method: mergeMethod,
      ...(bypassRequirements ? { bypassRequirements: true } : {}),
      ...(headline ? { commitHeadline: headline } : {}),
      ...(commitBody ? { commitBody } : {}),
    },
    dependencies,
  );
}

function LifecycleDialogHeader({
  effect,
  targetReadiness,
}: {
  effect: LifecycleEffect;
  targetReadiness: PullRequestReadiness | undefined;
}) {
  const title = effectTitle(effect, targetReadiness);
  return (
    <header className="flex items-start gap-3 bg-page px-5 py-4 pr-12">
      {effect === "merge" ? (
        <GitMerge size={18} aria-hidden className="mt-0.5 shrink-0 text-primary/85" />
      ) : (
        <GitPullRequest size={18} aria-hidden className="mt-0.5 shrink-0 text-primary/85" />
      )}
      <div className="min-w-0">
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-5">
          {effectDescription(effect, targetReadiness)}
        </DialogDescription>
      </div>
    </header>
  );
}

function LifecycleSnapshot({
  detail,
  title,
}: {
  detail: PullRequestDetail;
  title: string;
}) {
  const repository = `${detail.identity.owner}/${detail.identity.repository}`;
  return (
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
        <span aria-hidden className="opacity-45">←</span>
        <span className="truncate text-foreground/85">{detail.head.name}</span>
        {detail.head.oid ? <span className="ml-auto shrink-0 tabular-nums">{detail.head.oid.slice(0, 8)}</span> : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Effect: <span className="text-foreground/85">{title}</span>
      </p>
    </div>
  );
}

function ReadinessDetails({
  current,
  target,
}: {
  current: PullRequestReadiness;
  target: PullRequestReadiness | undefined;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">Current</dt>
      <dd className="capitalize text-foreground/85">{current}</dd>
      <dt className="text-muted-foreground">After confirmation</dt>
      <dd className="capitalize text-foreground/85">{target}</dd>
    </dl>
  );
}

function LifecycleReason({ reason }: { reason: string }) {
  return (
    <p role="status" className="flex items-start gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground">
      <AlertCircle size={13} aria-hidden className="mt-0.5 shrink-0 text-primary/80" />
      {reason}
    </p>
  );
}

function MergeMethodField({
  detail,
  mergeMethod,
  mutationBlocked,
  onMergeMethodChange,
}: {
  detail: PullRequestDetail;
  mergeMethod: PullRequestMergeMethod;
  mutationBlocked: boolean;
  onMergeMethodChange: (method: PullRequestMergeMethod) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="pull-request-merge-method" className="text-xs text-muted-foreground">
        Merge method
      </label>
      <Select
        value={mergeMethod}
        onValueChange={(value) => {
          if (value) onMergeMethodChange(value);
        }}
        disabled={mutationBlocked}
      >
        <SelectTrigger id="pull-request-merge-method" className="w-full">
          <SelectValue>{mergeMethodLabel(mergeMethod)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {detail.mergeMethods.map((method) => (
            <SelectItem key={method} value={method}>{mergeMethodLabel(method)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MergeBypassOption({
  allowed,
  checked,
  mutationBlocked,
  onCheckedChange,
}: {
  allowed: boolean;
  checked: boolean;
  mutationBlocked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  if (!allowed) {
    return (
      <div className="flex items-start gap-3 border-t border-border/45 pt-4 text-muted-foreground">
        <ShieldOff size={15} aria-hidden className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground/80">Admin bypass unavailable</span>
          <span className="mt-0.5 block text-xs leading-5">
            GitHub does not allow this account to bypass merge requirements.
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 border-t border-border/45 pt-4">
      <Checkbox
        id="pull-request-bypass-requirements"
        checked={checked}
        disabled={mutationBlocked}
        aria-labelledby="pull-request-bypass-requirements-label"
        aria-describedby="pull-request-bypass-requirements-description"
        onCheckedChange={onCheckedChange}
      />
      <span className="min-w-0">
        <label id="pull-request-bypass-requirements-label" htmlFor="pull-request-bypass-requirements" className="block cursor-pointer text-xs font-medium text-foreground/90">
          Merge without waiting for requirements
        </label>
        <span id="pull-request-bypass-requirements-description" className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          Use administrator permission to bypass branch protection rules.
        </span>
      </span>
    </div>
  );
}

interface MergeCommitFieldsProps {
  commitBody: string;
  commitHeadline: string;
  mutationBlocked: boolean;
  onCommitBodyChange: (value: string) => void;
  onCommitHeadlineChange: (value: string) => void;
}

function MergeCommitFields({
  commitBody,
  commitHeadline,
  mutationBlocked,
  onCommitBodyChange,
  onCommitHeadlineChange,
}: MergeCommitFieldsProps) {
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="pull-request-merge-headline" className="text-xs text-muted-foreground">
          Commit headline, optional
        </label>
        <Input
          id="pull-request-merge-headline"
          value={commitHeadline}
          maxLength={512}
          disabled={mutationBlocked}
          onChange={(event) => onCommitHeadlineChange(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pull-request-merge-body" className="text-xs text-muted-foreground">
          Commit body, optional
        </label>
        <Textarea
          id="pull-request-merge-body"
          value={commitBody}
          rows={3}
          disabled={mutationBlocked}
          className="resize-y rounded-none"
          onChange={(event) => onCommitBodyChange(event.target.value)}
        />
      </div>
    </>
  );
}

interface MergeDetailsProps extends MergeCommitFieldsProps {
  bypassRequirements: boolean;
  detail: PullRequestDetail;
  mergeMethod: PullRequestMergeMethod;
  mutationBlocked: boolean;
  unavailableReason: string | null;
  onBypassRequirementsChange: (checked: boolean) => void;
  onMergeMethodChange: (method: PullRequestMergeMethod) => void;
}

function MergeDetails({
  bypassRequirements,
  detail,
  mergeMethod,
  mutationBlocked,
  unavailableReason,
  onBypassRequirementsChange,
  onMergeMethodChange,
  ...commitFields
}: MergeDetailsProps) {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Checks</dt>
        <dd className="capitalize text-foreground/85">{detail.checks.state}</dd>
        <dt className="text-muted-foreground">Mergeability</dt>
        <dd className="capitalize text-foreground/85">{detail.mergeability}</dd>
      </dl>
      <MergeMethodField
        detail={detail}
        mergeMethod={mergeMethod}
        mutationBlocked={mutationBlocked}
        onMergeMethodChange={onMergeMethodChange}
      />
      {unavailableReason ? <LifecycleReason reason={unavailableReason} /> : null}
      <MergeBypassOption
        allowed={Boolean(detail.viewerCanBypassMergeRequirements)}
        checked={bypassRequirements}
        mutationBlocked={mutationBlocked}
        onCheckedChange={onBypassRequirementsChange}
      />
      <MergeCommitFields mutationBlocked={mutationBlocked} {...commitFields} />
    </>
  );
}

function LifecycleFeedback({
  displayedError,
  effect,
  localError,
  submitting,
  unavailableReason,
  onRefresh,
  onRetry,
}: {
  displayedError: PullRequestMutationErrorValue | null;
  effect: LifecycleEffect;
  localError: string | null;
  submitting: boolean;
  unavailableReason: string | null;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      {effect !== "merge" && unavailableReason ? <LifecycleReason reason={unavailableReason} /> : null}
      {localError ? <p role="alert" className="text-xs text-destructive">{localError}</p> : null}
      {displayedError ? (
        <PullRequestMutationError
          error={displayedError}
          busy={submitting}
          onRetry={onRetry}
          onRefresh={onRefresh}
        />
      ) : null}
    </>
  );
}

function LifecycleDialogFooter({
  effect,
  mutationBlocked,
  targetReadiness,
  bypassRequirements,
  localError,
  unavailableReason,
  submitting,
  onCancel,
  onSubmit,
}: {
  effect: LifecycleEffect;
  mutationBlocked: boolean;
  targetReadiness: PullRequestReadiness | undefined;
  bypassRequirements: boolean;
  localError: string | null;
  unavailableReason: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <DialogFooter className="m-0 flex-row justify-end rounded-none bg-page/65 px-5 py-3.5">
      <Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>
        Cancel
      </Button>
      <Button
        type="button"
        variant={effect === "close" ? "destructive" : "default"}
        disabled={mutationBlocked || Boolean(unavailableReason) || Boolean(localError)}
        onClick={onSubmit}
      >
        {submitting ? <><Spinner size="xs" aria-hidden />Applying effect</> : confirmLabel(effect, targetReadiness, bypassRequirements)}
      </Button>
    </DialogFooter>
  );
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
  const unavailableReason = lifecycleUnavailableReason(
    detail,
    capability,
    expected,
    effect,
  );

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
    const result = await submitLifecycleEffect({
      effect,
      detail,
      expected,
      targetReadiness: targetReadiness!,
      mergeMethod,
      bypassRequirements,
      commitHeadline,
      commitBody,
      mutationTransport,
      readTransport,
    });
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
  const updateCommitBody = (value: string): void => {
    if (textEncoder.encode(value).byteLength > PULL_REQUEST_MUTATION_BODY_MAX_BYTES) {
      setLocalError("Commit body exceeds the 64 KiB UTF-8 limit.");
      return;
    }
    setCommitBody(value);
    setLocalError(null);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={!submitting}
        className="max-h-[90vh] w-[min(94vw,560px)] gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        aria-busy={submitting || undefined}
      >
        <LifecycleDialogHeader effect={effect} targetReadiness={targetReadiness} />

        <ScrollArea className="min-h-0 max-h-[65vh]">
          <div className="space-y-4 px-5 py-4">
            <LifecycleSnapshot detail={detail} title={title} />

            {effect === "readiness" ? (
              <ReadinessDetails current={detail.readiness} target={targetReadiness} />
            ) : null}

            {effect === "merge" ? (
              <MergeDetails
                detail={detail}
                mergeMethod={mergeMethod}
                bypassRequirements={bypassRequirements}
                mutationBlocked={mutationBlocked}
                unavailableReason={unavailableReason}
                commitHeadline={commitHeadline}
                commitBody={commitBody}
                onMergeMethodChange={setMergeMethod}
                onBypassRequirementsChange={setBypassRequirements}
                onCommitHeadlineChange={setCommitHeadline}
                onCommitBodyChange={updateCommitBody}
              />
            ) : null}

            <LifecycleFeedback
              displayedError={displayedError}
              effect={effect}
              localError={localError}
              submitting={submitting}
              unavailableReason={unavailableReason}
              onRetry={() => void retry()}
              onRefresh={() => void refresh()}
            />
          </div>
        </ScrollArea>

        <LifecycleDialogFooter
          effect={effect}
          mutationBlocked={mutationBlocked}
          targetReadiness={targetReadiness}
          bypassRequirements={bypassRequirements}
          localError={localError}
          unavailableReason={unavailableReason}
          submitting={submitting}
          onCancel={() => close(false)}
          onSubmit={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}
