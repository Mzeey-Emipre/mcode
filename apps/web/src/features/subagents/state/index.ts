import {
  useDiffStore,
  type SubagentDetailSelection,
} from "@/stores/diffStore";

export type { SubagentDetailSelection, SubagentRosterTab } from "@/stores/diffStore";

/** Reads the selected child for one parent thread. */
export function useSubagentDetailSelection(threadId: string): SubagentDetailSelection | undefined {
  return useDiffStore((state) => state.subagentDetailByThread[threadId]);
}

/** Reads the action that selects one child for a parent thread. */
export function useSelectSubagentDetail() {
  return useDiffStore((state) => state.selectSubagentDetail);
}

/** Reads the action that clears one parent thread's child selection. */
export function useClearSubagentDetail() {
  return useDiffStore((state) => state.clearSubagentDetail);
}

/** Selects one canonical child without exposing the broader diff store. */
export function selectSubagentDetail(threadId: string, selection: SubagentDetailSelection): void {
  useDiffStore.getState().selectSubagentDetail(threadId, selection);
}

/** Clears one parent thread's child selection without exposing the broader diff store. */
export function clearSubagentDetail(threadId: string): void {
  useDiffStore.getState().clearSubagentDetail(threadId);
}
