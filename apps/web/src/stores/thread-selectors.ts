import { useShallow } from "zustand/shallow";
import { useThreadStore } from "./threadStore";
import {
  createEmptyThreadRecord,
  getThreadRecord,
  type ThreadRecord,
} from "./thread-record";

const EMPTY_HOOK_THREAD_RECORD = createEmptyThreadRecord();

function getHookThreadRecord(
  records: Map<string, ThreadRecord>,
  threadId: string,
): ThreadRecord {
  if (!records.has(threadId)) return EMPTY_HOOK_THREAD_RECORD;
  return getThreadRecord(records, threadId);
}

/**
 * Subscribe to one thread's record with shallow equality on the selected slice.
 */
export function useThreadRecord<T>(
  threadId: string | null | undefined,
  selector: (record: ThreadRecord) => T,
): T {
  return useThreadStore(
    useShallow((state) => {
      if (!threadId) return selector(EMPTY_HOOK_THREAD_RECORD);
      return selector(getHookThreadRecord(state.records, threadId));
    }),
  );
}

/**
 * Subscribe to the active thread's record with shallow equality on the selected slice.
 */
export function useActiveThreadRecord<T>(
  selector: (record: ThreadRecord) => T,
): T {
  return useThreadStore(
    useShallow((state) => {
      const id = state.currentThreadId;
      const record = id
        ? getHookThreadRecord(state.records, id)
        : EMPTY_HOOK_THREAD_RECORD;
      return selector(record);
    }),
  );
}

/** Imperative read of one thread record without subscribing. */
export function readThreadRecord(threadId: string): ThreadRecord {
  return getThreadRecord(useThreadStore.getState().records, threadId);
}

/** Imperative read of the active thread record without subscribing. */
export function readActiveThreadRecord(): ThreadRecord | undefined {
  const { currentThreadId, records } = useThreadStore.getState();
  if (!currentThreadId) return undefined;
  return records.get(currentThreadId);
}
