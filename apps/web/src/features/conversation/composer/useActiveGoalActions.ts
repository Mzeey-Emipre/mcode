import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";

interface GoalActionScope {
  threadId: string;
  refreshRequestId: number;
  clearRequestId: number;
}

interface GoalActionState {
  threadId: string;
  detailsOpen: boolean;
  refreshError: boolean;
  isRefreshingGoal: boolean;
  isClearingGoal: boolean;
  lookupSource: string | null;
  lookupReason: string | null;
}

function createGoalActionState(threadId: string): GoalActionState {
  return {
    threadId,
    detailsOpen: false,
    refreshError: false,
    isRefreshingGoal: false,
    isClearingGoal: false,
    lookupSource: null,
    lookupReason: null,
  };
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
  const [actionState, setActionState] = useState(() => createGoalActionState(threadId));
  const actionScopeRef = useRef<GoalActionScope>({ threadId, refreshRequestId: 0, clearRequestId: 0 });
  const refreshThreadGoal = useThreadStore((state) => state.refreshThreadGoal);
  const clearThreadGoal = useThreadStore((state) => state.clearThreadGoal);

  if (actionScopeRef.current.threadId !== threadId) {
    actionScopeRef.current = {
      threadId,
      refreshRequestId: actionScopeRef.current.refreshRequestId + 1,
      clearRequestId: actionScopeRef.current.clearRequestId + 1,
    };
  }

  const state = actionState.threadId === threadId
    ? actionState
    : createGoalActionState(threadId);
  const updateState = useCallback((patch: Partial<Omit<GoalActionState, "threadId">>) => {
    setActionState((current) => ({
      ...createGoalActionState(threadId),
      ...(current.threadId === threadId ? current : {}),
      ...patch,
    }));
  }, [threadId]);

  const setDetailsOpen = useCallback((open: boolean) => {
    updateState({ detailsOpen: open });
    if (!open) return;
    const refreshRequestId = beginRefresh(actionScopeRef, threadId);
    updateState({ isRefreshingGoal: true, refreshError: false });
    void refreshThreadGoal(threadId)
      .then((lookup) => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        updateState({ lookupSource: lookup.source, lookupReason: lookup.reason ?? null });
      })
      .catch(() => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        updateState({ refreshError: true });
      })
      .finally(() => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "refreshRequestId", refreshRequestId)) return;
        updateState({ isRefreshingGoal: false });
      });
  }, [refreshThreadGoal, threadId, updateState]);

  const clearGoal = useCallback(() => {
    if (state.isClearingGoal) return;
    const scope = beginClear(actionScopeRef, threadId);
    updateState({ isRefreshingGoal: false, refreshError: false, isClearingGoal: true });
    void clearThreadGoal(threadId)
      .then((lookup) => {
        if (!isCurrentAction(actionScopeRef.current, threadId, "clearRequestId", scope.clearRequestId)) return;
        updateState({ lookupSource: lookup.source, lookupReason: lookup.reason ?? null });
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
        updateState({ isClearingGoal: false });
      });
  }, [clearThreadGoal, state.isClearingGoal, threadId, updateState]);

  return {
    detailsOpen: state.detailsOpen,
    isRefreshingGoal: state.isRefreshingGoal,
    isClearingGoal: state.isClearingGoal,
    lookupSource: state.lookupSource,
    lookupReason: state.lookupReason,
    refreshError: state.refreshError,
    setDetailsOpen,
    clearGoal,
  };
}
