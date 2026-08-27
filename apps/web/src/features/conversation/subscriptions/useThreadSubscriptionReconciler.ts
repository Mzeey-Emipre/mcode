import { useEffect, useRef, useState } from "react";
import type { SetThreadSubscriptionsInput } from "@mcode/contracts";
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

/**
 * Reconciles conversation subscriptions with atomic and legacy transports.
 * The owning view defines subscription priority; this hook owns request lifetime.
 */
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
    const orderedDesiredThreadIds = [...desiredThreadIds];
    const desired = new Set(orderedDesiredThreadIds);
    desiredThreadIdsRef.current = desired;

    const targetSignature = `${connectionStatus}:${orderedDesiredThreadIds.join("\u0000")}`;
    if (subscriptionTargetSignatureRef.current !== targetSignature) {
      subscriptionTargetSignatureRef.current = targetSignature;
      subscriptionRetryAttemptRef.current = 0;
      subscriptionRetryExhaustedRef.current = false;
      if (subscriptionRetryTimerRef.current !== null) {
        clearTimeout(subscriptionRetryTimerRef.current);
        subscriptionRetryTimerRef.current = null;
      }
    }

    const reconnected = connectionStatus === "connected"
      && previousSubscriptionStatusRef.current !== "connected";
    const disconnected = connectionStatus !== "connected"
      && previousSubscriptionStatusRef.current === "connected";
    if (reconnected || disconnected) {
      subscriptionEpochRef.current += 1;
      confirmedThreadIdsRef.current.clear();
      pendingThreadChangesRef.current.clear();
    }
    previousSubscriptionStatusRef.current = connectionStatus;

    if (connectionStatus !== "connected" || subscriptionRetryExhaustedRef.current) return;

    const epoch = subscriptionEpochRef.current;
    const setThreadSubscriptions = getTransport().setThreadSubscriptions;
    if (setThreadSubscriptions) {
      const sentThreadIds = new Set(orderedDesiredThreadIds);
      const confirmed = confirmedThreadIdsRef.current;
      const needsCanonicalRecovery = orderedDesiredThreadIds.some((threadId) =>
        readThreadRecord(threadId).canonicalAgent.recoveryRequired,
      );
      const alreadyApplied = confirmed.size === desired.size
        && Array.from(confirmed).every((threadId) => desired.has(threadId))
        && !needsCanonicalRecovery;
      const pending = atomicSubscriptionRequestRef.current;
      if (alreadyApplied) {
        const telemetryThreadId = activeThreadId ?? orderedDesiredThreadIds[0];
        if (telemetryThreadId) recordSubscriptionSkipped(telemetryThreadId);
        return;
      }
      if (pending?.epoch === epoch) return;
      const requestId = atomicSubscriptionRequestIdRef.current + 1;
      atomicSubscriptionRequestIdRef.current = requestId;
      atomicSubscriptionRequestRef.current = {
        epoch,
        signature: targetSignature,
        id: requestId,
      };
      pendingAtomicThreadIdsRef.current.set(requestId, orderedDesiredThreadIds);
      const cursors: NonNullable<SetThreadSubscriptionsInput["cursors"]> = {};
      const revisions: NonNullable<SetThreadSubscriptionsInput["revisions"]> = {};
      const cursorAuthority = new Map<string, { epoch?: string; sequence?: number }>();
      for (const threadId of orderedDesiredThreadIds) {
        const record = readThreadRecord(threadId);
        revisions[threadId] = record.canonicalAgent.revision;
        const sequence = record.lastAgentEventSequence;
        if (typeof sequence === "number" && sequence > 0) {
          cursorAuthority.set(threadId, {
            epoch: record.lastAgentEventEpoch,
            sequence,
          });
          cursors[threadId] = record.lastAgentEventEpoch
            ? { epoch: record.lastAgentEventEpoch, sequence }
            : sequence;
        }
      }
      const input = Object.keys(cursors).length > 0
        ? { threadIds: orderedDesiredThreadIds, cursors, revisions }
        : { threadIds: orderedDesiredThreadIds, revisions };
      const isCurrentAtomicResponse = () => {
        const currentRequest = atomicSubscriptionRequestRef.current;
        const latestDesired = desiredThreadIdsRef.current;
        return subscriptionMountedRef.current
          && subscriptionEpochRef.current === epoch
          && currentRequest?.epoch === epoch
          && currentRequest?.id === requestId
          && currentRequest?.signature === targetSignature
          && subscriptionTargetSignatureRef.current === targetSignature
          && latestDesired.size === sentThreadIds.size
          && Array.from(latestDesired).every((threadId) => sentThreadIds.has(threadId));
      };
      void setThreadSubscriptions(input).then((result) => {
        if (!isCurrentAtomicResponse()) return;
        const canonicalRecoveries = result?.canonicalRecoveries ?? [];
        if (canonicalRecoveries.length > 0) {
          useThreadStore.getState().applyCanonicalReconnectRecoveries(canonicalRecoveries);
        }
        const residency = getConversationResidency();
        for (const recovery of canonicalRecoveries) {
          const requested = revisions[recovery.threadId];
          const through = recovery.mode === "snapshot"
            ? recovery.snapshot.revision
            : recovery.through;
          const changed = recovery.mode === "snapshot"
            || !requested
            || through.conversationRevision > requested.conversationRevision
            || through.rosterRevision > requested.rosterRevision;
          if (!changed) continue;
          residency.invalidateConversation(recovery.threadId);
          if (recovery.threadId === activeThreadId) {
            void residency.refresh(
              activeThreadId,
              useWorkspaceStore.getState().threads,
            ).catch(() => {});
          }
        }
        if (result?.hydrationRequiredThreadIds?.length) {
          for (const threadId of result.hydrationRequiredThreadIds) {
            const expected = cursorAuthority.get(threadId);
            if (!isCurrentAtomicResponse()) return;
            useThreadStore.setState((state) => {
              const record = state.records.get(threadId);
              if (!record) return state;
              const stillOwnsCursor = expected?.epoch
                ? record.lastAgentEventEpoch === expected.epoch
                  && record.lastAgentEventSequence === expected.sequence
                : record.lastAgentEventEpoch === undefined
                  && record.lastAgentEventSequence === expected?.sequence;
              if (!stillOwnsCursor) return state;
              const records = new Map(state.records);
              records.set(threadId, {
                ...record,
                lastAgentEventEpoch: undefined,
                lastAgentEventSequence: undefined,
              });
              return { records };
            });
            if (!isCurrentAtomicResponse()) return;
            residency.invalidateConversation(threadId);
            if (threadId === activeThreadId && runningThreadIds.has(threadId)) {
              if (!isCurrentAtomicResponse()) return;
              void residency.refresh(threadId, useWorkspaceStore.getState().threads).catch(() => {});
            }
          }
        }
        if (!isCurrentAtomicResponse()) return;
        confirmedThreadIdsRef.current = sentThreadIds;
        subscriptionRetryAttemptRef.current = 0;
        subscriptionRetryExhaustedRef.current = false;
      }).catch(() => {
        if (!subscriptionMountedRef.current || subscriptionEpochRef.current !== epoch) return;
        const currentRequest = atomicSubscriptionRequestRef.current;
        if (currentRequest?.epoch !== epoch || currentRequest.id !== requestId) return;
        if (subscriptionTargetSignatureRef.current !== targetSignature) return;
        if (subscriptionRetryAttemptRef.current >= THREAD_SUBSCRIPTION_MAX_RETRIES) {
          subscriptionRetryExhaustedRef.current = true;
          return;
        }
        const delay = Math.min(
          THREAD_SUBSCRIPTION_RETRY_BASE_MS * (2 ** subscriptionRetryAttemptRef.current),
          THREAD_SUBSCRIPTION_RETRY_MAX_MS,
        );
        subscriptionRetryAttemptRef.current += 1;
        subscriptionRetryTimerRef.current = setTimeout(() => {
          subscriptionRetryTimerRef.current = null;
          if (subscriptionMountedRef.current) {
            setSubscriptionReconcileVersion((version) => version + 1);
          }
        }, delay);
      }).finally(() => {
        pendingAtomicThreadIdsRef.current.delete(requestId);
        if (atomicSubscriptionRequestRef.current?.epoch === epoch
          && atomicSubscriptionRequestRef.current.id === requestId) {
          atomicSubscriptionRequestRef.current = null;
          if (subscriptionMountedRef.current
            && subscriptionEpochRef.current === epoch
            && subscriptionTargetSignatureRef.current !== targetSignature) {
            setSubscriptionReconcileVersion((version) => version + 1);
          }
        }
      });
      return;
    }

    const operations: Promise<boolean>[] = [];
    const startChange = (threadId: string, action: ThreadSubscriptionAction) => {
      const change = Symbol();
      pendingThreadChangesRef.current.set(threadId, change);
      const request = action === "subscribe"
        ? getTransport().subscribeThread(threadId)
        : getTransport().unsubscribeThread(threadId);

      operations.push(request.then(() => {
        if (subscriptionEpochRef.current !== epoch) return true;
        if (action === "subscribe") confirmedThreadIdsRef.current.add(threadId);
        else confirmedThreadIdsRef.current.delete(threadId);
        return true;
      }, () => false).finally(() => {
        if (pendingThreadChangesRef.current.get(threadId) === change) {
          pendingThreadChangesRef.current.delete(threadId);
        }
      }));
    };

    for (const threadId of desired) {
      if (!confirmedThreadIdsRef.current.has(threadId)
        && !pendingThreadChangesRef.current.has(threadId)) {
        startChange(threadId, "subscribe");
      }
    }
    for (const threadId of confirmedThreadIdsRef.current) {
      if (!desired.has(threadId) && !pendingThreadChangesRef.current.has(threadId)) {
        startChange(threadId, "unsubscribe");
      }
    }

    if (operations.length === 0) return;

    void Promise.all(operations).then((results) => {
      if (!subscriptionMountedRef.current || subscriptionEpochRef.current !== epoch) return;
      if (subscriptionTargetSignatureRef.current !== targetSignature) {
        setSubscriptionReconcileVersion((version) => version + 1);
        return;
      }

      if (results.every(Boolean)) {
        subscriptionRetryAttemptRef.current = 0;
        subscriptionRetryExhaustedRef.current = false;
        const confirmed = confirmedThreadIdsRef.current;
        const latestDesired = desiredThreadIdsRef.current;
        const needsReconcile = confirmed.size !== latestDesired.size
          || Array.from(confirmed).some((threadId) => !latestDesired.has(threadId));
        if (needsReconcile) {
          setSubscriptionReconcileVersion((version) => version + 1);
        }
        return;
      }

      if (subscriptionRetryAttemptRef.current >= THREAD_SUBSCRIPTION_MAX_RETRIES) {
        subscriptionRetryExhaustedRef.current = true;
        return;
      }

      const delay = Math.min(
        THREAD_SUBSCRIPTION_RETRY_BASE_MS * (2 ** subscriptionRetryAttemptRef.current),
        THREAD_SUBSCRIPTION_RETRY_MAX_MS,
      );
      subscriptionRetryAttemptRef.current += 1;
      subscriptionRetryTimerRef.current = setTimeout(() => {
        subscriptionRetryTimerRef.current = null;
        if (subscriptionMountedRef.current) {
          setSubscriptionReconcileVersion((version) => version + 1);
        }
      }, delay);
    });
  }, [
    activeThreadId,
    canonicalRecoverySignature,
    connectionStatus,
    desiredThreadIds,
    runningThreadIds,
    subscriptionReconcileVersion,
  ]);

  useEffect(() => {
    subscriptionMountedRef.current = true;
    return () => {
      subscriptionMountedRef.current = false;
      const pendingAtomicThreadIds = Array.from(pendingAtomicThreadIdsRef.current.values()).flat();
      subscriptionEpochRef.current += 1;
      if (subscriptionRetryTimerRef.current !== null) {
        clearTimeout(subscriptionRetryTimerRef.current);
        subscriptionRetryTimerRef.current = null;
      }
      const threadIds = new Set([
        ...confirmedThreadIdsRef.current,
        ...desiredThreadIdsRef.current,
        ...pendingAtomicThreadIds,
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
      confirmedThreadIdsRef.current.clear();
      desiredThreadIdsRef.current.clear();
      pendingThreadChangesRef.current.clear();
      pendingAtomicThreadIdsRef.current.clear();
    };
  }, []);
}
