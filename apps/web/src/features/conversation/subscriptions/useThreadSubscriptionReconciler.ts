import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { CanonicalAgentReconnectRecovery, SetThreadSubscriptionsInput, SetThreadSubscriptionsResult } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { recordSubscriptionSkipped } from "@/lib/thread-switch-telemetry";
import { useThreadStore } from "@/stores/threadStore";
import { getTransport } from "@/transport";
import { getConversationResidency } from "../residency/conversation-residency";
import { readThreadRecord } from "../state";

const THREAD_SUBSCRIPTION_RETRY_BASE_MS = 100;
const THREAD_SUBSCRIPTION_RETRY_MAX_MS = 1_600;
const THREAD_SUBSCRIPTION_MAX_RETRIES = 4;

type ThreadSubscriptionAction = "subscribe" | "unsubscribe";
type AtomicSubscriptionRequest = {
  epoch: number;
  signature: string;
  id: number;
};
type ConnectionStatus = ReturnType<typeof import("@/stores/connectionStore").useConnectionStore.getState>["status"];

type SubscriptionRefs = {
  readonly confirmedThreadIds: MutableRefObject<Set<string>>;
  readonly desiredThreadIds: MutableRefObject<Set<string>>;
  readonly pendingThreadChanges: MutableRefObject<Map<string, symbol>>;
  readonly previousStatus: MutableRefObject<ConnectionStatus | null>;
  readonly epoch: MutableRefObject<number>;
  readonly retryTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly retryAttempt: MutableRefObject<number>;
  readonly retryExhausted: MutableRefObject<boolean>;
  readonly targetSignature: MutableRefObject<string>;
  readonly atomicRequestId: MutableRefObject<number>;
  readonly atomicRequest: MutableRefObject<AtomicSubscriptionRequest | null>;
  readonly pendingAtomicThreadIds: MutableRefObject<Map<number, string[]>>;
  readonly mounted: MutableRefObject<boolean>;
};

type AtomicSubscriptionInput = {
  readonly input: SetThreadSubscriptionsInput;
  readonly revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]>;
  readonly cursorAuthority: Map<string, { epoch?: string; sequence?: number }>;
};

type AtomicRequestContext = {
  readonly epoch: number;
  readonly targetSignature: string;
  readonly requestId: number;
  readonly sentThreadIds: Set<string>;
  readonly revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]>;
  readonly cursorAuthority: Map<string, { epoch?: string; sequence?: number }>;
};

type SubscriptionReconcileContext = {
  readonly activeThreadId: string | null;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly refs: SubscriptionRefs;
  readonly requestReconcile: Dispatch<SetStateAction<number>>;
};

function sameThreadIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && Array.from(left).every((threadId) => right.has(threadId));
}

function resetRetryState(refs: SubscriptionRefs, targetSignature: string): void {
  if (refs.targetSignature.current === targetSignature) return;
  refs.targetSignature.current = targetSignature;
  refs.retryAttempt.current = 0;
  refs.retryExhausted.current = false;
  if (refs.retryTimer.current !== null) {
    clearTimeout(refs.retryTimer.current);
    refs.retryTimer.current = null;
  }
}

function resetSubscriptionsForConnectionChange(refs: SubscriptionRefs, status: ConnectionStatus): void {
  const previousStatus = refs.previousStatus.current;
  const changed = (status === "connected") !== (previousStatus === "connected");
  if (changed) {
    refs.epoch.current += 1;
    refs.confirmedThreadIds.current.clear();
    refs.pendingThreadChanges.current.clear();
  }
  refs.previousStatus.current = status;
}

function scheduleRetry(refs: SubscriptionRefs, requestReconcile: Dispatch<SetStateAction<number>>): void {
  if (refs.retryAttempt.current >= THREAD_SUBSCRIPTION_MAX_RETRIES) {
    refs.retryExhausted.current = true;
    return;
  }
  const delay = Math.min(
    THREAD_SUBSCRIPTION_RETRY_BASE_MS * (2 ** refs.retryAttempt.current),
    THREAD_SUBSCRIPTION_RETRY_MAX_MS,
  );
  refs.retryAttempt.current += 1;
  refs.retryTimer.current = setTimeout(() => {
    refs.retryTimer.current = null;
    if (refs.mounted.current) requestReconcile((version) => version + 1);
  }, delay);
}

function hasCanonicalRecovery(threadIds: readonly string[]): boolean {
  return threadIds.some((threadId) => readThreadRecord(threadId).canonicalAgent.recoveryRequired);
}

function atomicSubscriptionInput(threadIds: string[]): AtomicSubscriptionInput {
  const cursors: NonNullable<SetThreadSubscriptionsInput["cursors"]> = {};
  const revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]> = {};
  const cursorAuthority = new Map<string, { epoch?: string; sequence?: number }>();
  for (const threadId of threadIds) {
    const record = readThreadRecord(threadId);
    revisions[threadId] = record.canonicalAgent.revision;
    const sequence = record.lastAgentEventSequence;
    if (typeof sequence !== "number" || sequence <= 0) continue;
    cursorAuthority.set(threadId, { epoch: record.lastAgentEventEpoch, sequence });
    cursors[threadId] = record.lastAgentEventEpoch
      ? { epoch: record.lastAgentEventEpoch, sequence }
      : sequence;
  }
  const input = Object.keys(cursors).length > 0
    ? { threadIds, cursors, revisions }
    : { threadIds, revisions };
  return { input, revisions, cursorAuthority };
}

function createAtomicRequest(
  refs: SubscriptionRefs,
  epoch: number,
  targetSignature: string,
  threadIds: string[],
  subscription: AtomicSubscriptionInput,
): AtomicRequestContext {
  const requestId = refs.atomicRequestId.current + 1;
  refs.atomicRequestId.current = requestId;
  refs.atomicRequest.current = { epoch, signature: targetSignature, id: requestId };
  refs.pendingAtomicThreadIds.current.set(requestId, threadIds);
  return {
    epoch,
    targetSignature,
    requestId,
    sentThreadIds: new Set(threadIds),
    revisions: subscription.revisions,
    cursorAuthority: subscription.cursorAuthority,
  };
}

function atomicResponseIsCurrent(refs: SubscriptionRefs, request: AtomicRequestContext): boolean {
  const currentRequest = refs.atomicRequest.current;
  return [
    refs.mounted.current,
    refs.epoch.current === request.epoch,
    currentRequest?.epoch === request.epoch,
    currentRequest?.id === request.requestId,
    currentRequest?.signature === request.targetSignature,
    refs.targetSignature.current === request.targetSignature,
    sameThreadIds(refs.desiredThreadIds.current, request.sentThreadIds),
  ].every(Boolean);
}

function canonicalRecoveryChanged(
  recovery: CanonicalAgentReconnectRecovery,
  revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]>,
): boolean {
  if (recovery.mode === "snapshot") return true;
  const requested = revisions[recovery.threadId];
  if (!requested) return true;
  return [
    recovery.through.conversationRevision > requested.conversationRevision,
    recovery.through.rosterRevision > requested.rosterRevision,
  ].some(Boolean);
}

function refreshConversation(threadId: string): void {
  void getConversationResidency().refresh(threadId, useWorkspaceStore.getState().threads).catch(() => {});
}

function applyCanonicalRecovery(
  recovery: CanonicalAgentReconnectRecovery,
  revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]>,
  activeThreadId: string | null,
): void {
  if (!canonicalRecoveryChanged(recovery, revisions)) return;
  const residency = getConversationResidency();
  residency.invalidateConversation(recovery.threadId);
  if (recovery.threadId === activeThreadId) refreshConversation(activeThreadId);
}

function recordOwnsCursor(
  record: ReturnType<typeof readThreadRecord>,
  expected: { epoch?: string; sequence?: number } | undefined,
): boolean {
  if (expected?.epoch) {
    return record.lastAgentEventEpoch === expected.epoch
      && record.lastAgentEventSequence === expected.sequence;
  }
  return record.lastAgentEventEpoch === undefined
    && record.lastAgentEventSequence === expected?.sequence;
}

function clearHydrationCursor(threadId: string, expected: { epoch?: string; sequence?: number } | undefined): void {
  useThreadStore.setState((state) => {
    const record = state.records.get(threadId);
    if (!record || !recordOwnsCursor(record, expected)) return state;
    const records = new Map(state.records);
    records.set(threadId, {
      ...record,
      lastAgentEventEpoch: undefined,
      lastAgentEventSequence: undefined,
    });
    return { records };
  });
}

function applyHydrationRequired(
  threadIds: readonly string[],
  request: AtomicRequestContext,
  context: SubscriptionReconcileContext,
): boolean {
  const residency = getConversationResidency();
  for (const threadId of threadIds) {
    if (!atomicResponseIsCurrent(context.refs, request)) return false;
    clearHydrationCursor(threadId, request.cursorAuthority.get(threadId));
    if (!atomicResponseIsCurrent(context.refs, request)) return false;
    residency.invalidateConversation(threadId);
    if (threadId === context.activeThreadId && context.runningThreadIds.has(threadId)) {
      if (!atomicResponseIsCurrent(context.refs, request)) return false;
      refreshConversation(threadId);
    }
  }
  return true;
}

function applyAtomicResponse(
  result: SetThreadSubscriptionsResult,
  request: AtomicRequestContext,
  context: SubscriptionReconcileContext,
): void {
  if (!atomicResponseIsCurrent(context.refs, request)) return;
  const canonicalRecoveries = result.canonicalRecoveries ?? [];
  if (canonicalRecoveries.length > 0) {
    useThreadStore.getState().applyCanonicalReconnectRecoveries(canonicalRecoveries);
  }
  for (const recovery of canonicalRecoveries) {
    applyCanonicalRecovery(recovery, request.revisions, context.activeThreadId);
  }
  if (!applyHydrationRequired(result.hydrationRequiredThreadIds, request, context)) return;
  if (!atomicResponseIsCurrent(context.refs, request)) return;
  context.refs.confirmedThreadIds.current = request.sentThreadIds;
  context.refs.retryAttempt.current = 0;
  context.refs.retryExhausted.current = false;
}

function handleAtomicFailure(request: AtomicRequestContext, context: SubscriptionReconcileContext): void {
  const currentRequest = context.refs.atomicRequest.current;
  const current = [
    context.refs.mounted.current,
    context.refs.epoch.current === request.epoch,
    currentRequest?.epoch === request.epoch,
    currentRequest?.id === request.requestId,
    context.refs.targetSignature.current === request.targetSignature,
  ].every(Boolean);
  if (current) scheduleRetry(context.refs, context.requestReconcile);
}

function settleAtomicRequest(request: AtomicRequestContext, context: SubscriptionReconcileContext): void {
  const refs = context.refs;
  refs.pendingAtomicThreadIds.current.delete(request.requestId);
  const currentRequest = refs.atomicRequest.current;
  const completedCurrentRequest = currentRequest?.epoch === request.epoch
    && currentRequest.id === request.requestId;
  if (!completedCurrentRequest) return;
  refs.atomicRequest.current = null;
  const targetChanged = refs.targetSignature.current !== request.targetSignature;
  if (refs.mounted.current && refs.epoch.current === request.epoch && targetChanged) {
    context.requestReconcile((version) => version + 1);
  }
}

function reconcileAtomicSubscription(
  threadIds: string[],
  targetSignature: string,
  context: SubscriptionReconcileContext,
  setThreadSubscriptions: NonNullable<ReturnType<typeof getTransport>["setThreadSubscriptions"]>,
): void {
  const refs = context.refs;
  const alreadyApplied = sameThreadIds(refs.confirmedThreadIds.current, refs.desiredThreadIds.current)
    && !hasCanonicalRecovery(threadIds);
  if (alreadyApplied) {
    const telemetryThreadId = context.activeThreadId ?? threadIds[0];
    if (telemetryThreadId) recordSubscriptionSkipped(telemetryThreadId);
    return;
  }
  const epoch = refs.epoch.current;
  if (refs.atomicRequest.current?.epoch === epoch) return;
  const subscription = atomicSubscriptionInput(threadIds);
  const request = createAtomicRequest(refs, epoch, targetSignature, threadIds, subscription);
  void setThreadSubscriptions(subscription.input)
    .then((result) => applyAtomicResponse(result, request, context))
    .catch(() => handleAtomicFailure(request, context))
    .finally(() => settleAtomicRequest(request, context));
}

function startLegacyChange(
  threadId: string,
  action: ThreadSubscriptionAction,
  epoch: number,
  refs: SubscriptionRefs,
): Promise<boolean> {
  const change = Symbol();
  refs.pendingThreadChanges.current.set(threadId, change);
  const request = action === "subscribe"
    ? getTransport().subscribeThread(threadId)
    : getTransport().unsubscribeThread(threadId);
  return request.then(() => {
    if (refs.epoch.current !== epoch) return true;
    if (action === "subscribe") refs.confirmedThreadIds.current.add(threadId);
    else refs.confirmedThreadIds.current.delete(threadId);
    return true;
  }, () => false).finally(() => {
    if (refs.pendingThreadChanges.current.get(threadId) === change) {
      refs.pendingThreadChanges.current.delete(threadId);
    }
  });
}

function legacySubscriptionOperations(desired: ReadonlySet<string>, epoch: number, refs: SubscriptionRefs): Promise<boolean>[] {
  const operations: Promise<boolean>[] = [];
  for (const threadId of desired) {
    const shouldSubscribe = !refs.confirmedThreadIds.current.has(threadId)
      && !refs.pendingThreadChanges.current.has(threadId);
    if (shouldSubscribe) operations.push(startLegacyChange(threadId, "subscribe", epoch, refs));
  }
  for (const threadId of refs.confirmedThreadIds.current) {
    const shouldUnsubscribe = !desired.has(threadId)
      && !refs.pendingThreadChanges.current.has(threadId);
    if (shouldUnsubscribe) operations.push(startLegacyChange(threadId, "unsubscribe", epoch, refs));
  }
  return operations;
}

function settleLegacySubscription(
  results: readonly boolean[],
  epoch: number,
  targetSignature: string,
  context: SubscriptionReconcileContext,
): void {
  const refs = context.refs;
  if (!refs.mounted.current || refs.epoch.current !== epoch) return;
  if (refs.targetSignature.current !== targetSignature) {
    context.requestReconcile((version) => version + 1);
    return;
  }
  if (!results.every(Boolean)) {
    scheduleRetry(refs, context.requestReconcile);
    return;
  }
  refs.retryAttempt.current = 0;
  refs.retryExhausted.current = false;
  if (!sameThreadIds(refs.confirmedThreadIds.current, refs.desiredThreadIds.current)) {
    context.requestReconcile((version) => version + 1);
  }
}

function reconcileLegacySubscription(
  desired: ReadonlySet<string>,
  targetSignature: string,
  context: SubscriptionReconcileContext,
): void {
  const epoch = context.refs.epoch.current;
  const operations = legacySubscriptionOperations(desired, epoch, context.refs);
  if (operations.length === 0) return;
  void Promise.all(operations).then((results) => {
    settleLegacySubscription(results, epoch, targetSignature, context);
  });
}

/** Inputs for the conversation subscription transport reconciler. */
export interface UseThreadSubscriptionReconcilerInput {
  /** Active conversation remains the highest-priority subscription. */
  activeThreadId: string | null;
  /** Ordered, capped subscription target ids chosen by the owning view. */
  desiredThreadIds: readonly string[];
  /** Current websocket connection state. */
  connectionStatus: ConnectionStatus;
  /** Threads with live turns that require subscription after the active thread. */
  runningThreadIds: ReadonlySet<string>;
  /** Changes when a canonical child needs reconnect recovery. */
  canonicalRecoverySignature: string;
}

/** Reconciles conversation subscriptions with atomic and legacy transports. */
export function useThreadSubscriptionReconciler({
  activeThreadId,
  desiredThreadIds,
  connectionStatus,
  runningThreadIds,
  canonicalRecoverySignature,
}: UseThreadSubscriptionReconcilerInput): void {
  const confirmedThreadIdsRef = useRef<Set<string>>(new Set());
  const desiredThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingThreadChangesRef = useRef<Map<string, symbol>>(new Map());
  const previousSubscriptionStatusRef = useRef<ConnectionStatus | null>(null);
  const subscriptionEpochRef = useRef(0);
  const subscriptionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionRetryAttemptRef = useRef(0);
  const subscriptionRetryExhaustedRef = useRef(false);
  const subscriptionTargetSignatureRef = useRef("");
  const atomicSubscriptionRequestIdRef = useRef(0);
  const atomicSubscriptionRequestRef = useRef<AtomicSubscriptionRequest | null>(null);
  const pendingAtomicThreadIdsRef = useRef<Map<number, string[]>>(new Map());
  const subscriptionMountedRef = useRef(true);
  const [subscriptionReconcileVersion, setSubscriptionReconcileVersion] = useState(0);

  useEffect(() => {
    const refs: SubscriptionRefs = {
      confirmedThreadIds: confirmedThreadIdsRef,
      desiredThreadIds: desiredThreadIdsRef,
      pendingThreadChanges: pendingThreadChangesRef,
      previousStatus: previousSubscriptionStatusRef,
      epoch: subscriptionEpochRef,
      retryTimer: subscriptionRetryTimerRef,
      retryAttempt: subscriptionRetryAttemptRef,
      retryExhausted: subscriptionRetryExhaustedRef,
      targetSignature: subscriptionTargetSignatureRef,
      atomicRequestId: atomicSubscriptionRequestIdRef,
      atomicRequest: atomicSubscriptionRequestRef,
      pendingAtomicThreadIds: pendingAtomicThreadIdsRef,
      mounted: subscriptionMountedRef,
    };
    const orderedThreadIds = [...desiredThreadIds];
    const desired = new Set(orderedThreadIds);
    refs.desiredThreadIds.current = desired;
    const targetSignature = `${connectionStatus}:${orderedThreadIds.join("\u0000")}`;
    resetRetryState(refs, targetSignature);
    resetSubscriptionsForConnectionChange(refs, connectionStatus);
    if (connectionStatus !== "connected" || refs.retryExhausted.current) return;
    const context: SubscriptionReconcileContext = {
      activeThreadId,
      runningThreadIds,
      refs,
      requestReconcile: setSubscriptionReconcileVersion,
    };
    const setThreadSubscriptions = getTransport().setThreadSubscriptions;
    if (setThreadSubscriptions) {
      reconcileAtomicSubscription(orderedThreadIds, targetSignature, context, setThreadSubscriptions);
      return;
    }
    reconcileLegacySubscription(desired, targetSignature, context);
  }, [
    activeThreadId,
    canonicalRecoverySignature,
    connectionStatus,
    desiredThreadIds,
    runningThreadIds,
    subscriptionReconcileVersion,
  ]);

  useEffect(() => {
    const confirmedThreadIds = confirmedThreadIdsRef.current;
    const desiredThreadIds = desiredThreadIdsRef.current;
    const pendingThreadChanges = pendingThreadChangesRef.current;
    const pendingAtomicThreadIds = pendingAtomicThreadIdsRef.current;
    subscriptionMountedRef.current = true;
    return () => {
      subscriptionMountedRef.current = false;
      const pendingAtomicIds = Array.from(pendingAtomicThreadIds.values()).flat();
      subscriptionEpochRef.current += 1;
      if (subscriptionRetryTimerRef.current !== null) {
        clearTimeout(subscriptionRetryTimerRef.current);
        subscriptionRetryTimerRef.current = null;
      }
      const threadIds = new Set([
        ...confirmedThreadIds,
        ...desiredThreadIds,
        ...pendingAtomicIds,
      ]);
      if (threadIds.size > 0) {
        const setThreadSubscriptions = getTransport().setThreadSubscriptions;
        if (setThreadSubscriptions) {
          void setThreadSubscriptions({ threadIds: [] }).catch(() => {});
        } else {
          for (const threadId of threadIds) {
            void getTransport().unsubscribeThread(threadId).catch(() => {});
          }
        }
      }
      confirmedThreadIds.clear();
      desiredThreadIds.clear();
      pendingThreadChanges.clear();
      pendingAtomicThreadIds.clear();
    };
  }, []);
}
