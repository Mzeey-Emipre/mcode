import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";

interface GoalActionScope {
  threadId: string;
  refreshRequestId: number;
  clearRequestId: number;
}

function normalizeGoalActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Try again.";
}

function isCurrentAction(
  scope: GoalActionScope,
  threadId: string,
  request: "refreshRequestId" | "clearRequestId",
  requestId: number,
): boolean {
  return scope.threadId === threadId && scope[request] === requestId;
}

function beginRefresh(scopeRef: MutableRefObject<GoalActionScope>, threadId: string): number {
  const refreshRequestId = scopeRef.current.refreshRequestId + 1;
  scopeRef.current = { ...scopeRef.current, threadId, refreshRequestId };
  return refreshRequestId;
}

function beginClear(
  scopeRef: MutableRefObject<GoalActionScope>,
  threadId: string,
): GoalActionScope {
  const refreshRequestId = scopeRef.current.refreshRequestId + 1;
  const clearRequestId = scopeRef.current.clearRequestId + 1;
  const scope = { ...scopeRef.current, threadId, refreshRequestId, clearRequestId };
  scopeRef.current = scope;
  return scope;
}

/** State and actions for the active-goal control lifecycle. */
export interface ActiveGoalActions {
  detailsOpen: boolean;
  isRefreshingGoal: boolean;
  isClearingGoal: boolean;
  lookupSource: string | null;
  lookupReason: string | null;
  refreshError: boolean;
  setDetailsOpen(open: boolean): void;
  clearGoal(): void;
}

/** Manages active-goal refresh and clear requests for one thread. */
export function useActiveGoalActions(threadId: string): ActiveGoalActions {
  const [detailsOpen, setDetailsOpenState] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [isRefreshingGoal, setIsRefreshingGoal] = useState(false);
  const [isClearingGoal, setIsClearingGoal] = useState(false);
  const [lookupSource, setLookupSource] = useState<string | null>(null);
  const [lookupReason, setLookupReason] = useState<string | null>(null);
  const actionScopeRef = useRef<GoalActionScope>({ threadId, refreshRequestId: 0, clearRequestId: 0 });
  const refreshThreadGoal = useThreadStore((state) => state.refreshThreadGoal);
  const clearThreadGoal = useThreadStore((state) => state.clearThreadGoal);

  useEffect(() => {
    actionScopeRef.current = {
      threadId,
      refreshRequestId: actionScopeRef.current.refreshRequestId + 1,
      clearRequestId: actionScopeRef.current.clearRequestId + 1,
    };
    setDetailsOpenState(false);
    setRefreshError(false);
    setIsRefreshingGoal(false);
    setIsClearingGoal(false);
    setLookupSource(null);
    setLookupReason(null);
  }, [threadId]);

  const setDetailsOpen = useCallback((open: boolean) => {
    setDetailsOpenState(open);
    if (!open) return;
    const refreshRequestId = beginRefresh(actionScopeRef, threadId);
    setIsRefreshingGoal(true);
    setRefreshError(false);
    void refreshThreadGoal(threadId)
      .then((lookup) => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        setLookupSource(lookup.source);
        setLookupReason(lookup.reason ?? null);
      })
      .catch(() => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        setRefreshError(true);
      })
      .finally(() => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        setIsRefreshingGoal(false);
      });
  }, [refreshThreadGoal, threadId]);

  const clearGoal = useCallback(() => {
    if (isClearingGoal) return;
    const scope = beginClear(actionScopeRef, threadId);
    setIsRefreshingGoal(false);
    setRefreshError(false);
    setIsClearingGoal(true);
    void clearThreadGoal(threadId)
      .then((lookup) => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "clearRequestId", scope.clearRequestId)) return;
        setLookupSource(lookup.source);
        setLookupReason(lookup.reason ?? null);
        if (lookup.source === "unsupported") {
          useToastStore.getState().show(
            "error",
            "Goal controls unavailable",
            "This provider does not support app-level goal controls.",
          );
          return;
        }
        if (lookup.goal && !lookup.authoritative) {
          useToastStore.getState().show(
            "info",
            "Goal was not cleared",
            "The provider did not report an active goal to clear.",
          );
        }
      })
      .catch((error) => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "clearRequestId", scope.clearRequestId)) return;
        useToastStore.getState().show(
          "error",
          "Could not clear goal",
          normalizeGoalActionError(error),
        );
      })
      .finally(() => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "clearRequestId", scope.clearRequestId)) return;
        setIsClearingGoal(false);
      });
  }, [clearThreadGoal, isClearingGoal, threadId]);

  return {
    detailsOpen,
    isRefreshingGoal,
    isClearingGoal,
    lookupSource,
    lookupReason,
    refreshError,
    setDetailsOpen,
    clearGoal,
  };
}
