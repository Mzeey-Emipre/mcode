/** Dev-only performance marks for the thread switch critical path. */

const MARK_PREFIX = "mcode:thread-switch";
const MAX_RETAINED_SWITCHES = 32;

type ThreadSwitchPath = "cache-restore" | "network-fetch";

interface ThreadSwitchRecord {
  id: number;
  threadId: string;
  selectionMark: string;
  commitMark?: string;
  holdStartMark?: string;
  holdEndMark?: string;
  firstMessageVisibleMark?: string;
  positionedMark?: string;
}

const records = new Map<number, ThreadSwitchRecord>();
const latestByThread = new Map<string, number>();
let nextSwitchId = 0;
let latestSelectionId: number | null = null;

function isEnabled(): boolean {
  return import.meta.env.DEV && typeof performance !== "undefined";
}

function clearRecord(record: ThreadSwitchRecord): void {
  performance.clearMarks(record.selectionMark);
  if (record.commitMark) performance.clearMarks(record.commitMark);
  if (record.holdStartMark) performance.clearMarks(record.holdStartMark);
  if (record.holdEndMark) performance.clearMarks(record.holdEndMark);
  if (record.firstMessageVisibleMark) performance.clearMarks(record.firstMessageVisibleMark);
  if (record.positionedMark) performance.clearMarks(record.positionedMark);
  performance.clearMeasures(`${MARK_PREFIX}:selection-to-commit:${record.id}`);
  performance.clearMeasures(`${MARK_PREFIX}:selection-to-first-message-visible:${record.id}`);
  performance.clearMeasures(`${MARK_PREFIX}:selection-to-positioned:${record.id}`);
  records.delete(record.id);
  if (latestByThread.get(record.threadId) === record.id) {
    latestByThread.delete(record.threadId);
  }
}

function retain(record: ThreadSwitchRecord): void {
  records.set(record.id, record);
  while (records.size > MAX_RETAINED_SWITCHES) {
    const oldest = records.values().next().value as ThreadSwitchRecord | undefined;
    if (!oldest) return;
    clearRecord(oldest);
  }
}

function mark(name: string, detail: Record<string, string | number>): void {
  performance.mark(name, { detail });
}

/** Record a user's thread selection and return its switch identity. */
export function recordThreadSelection(threadId: string): number | null {
  if (!isEnabled()) return null;
  const id = ++nextSwitchId;
  const selectionMark = `${MARK_PREFIX}:selection:${id}`;
  mark(selectionMark, { threadId, switchId: id });
  const record: ThreadSwitchRecord = { id, threadId, selectionMark };
  latestSelectionId = id;
  latestByThread.set(threadId, id);
  retain(record);
  return id;
}

/** Record the cache or network commit for the latest selection of a thread. */
export function recordThreadCommit(threadId: string, path: ThreadSwitchPath): void {
  if (!isEnabled()) return;
  const id = latestByThread.get(threadId);
  if (id == null || id !== latestSelectionId) return;
  const record = records.get(id);
  if (!record || record.commitMark) return;
  const commitMark = `${MARK_PREFIX}:commit:${path}:${id}`;
  mark(commitMark, { threadId, switchId: id, path });
  record.commitMark = commitMark;
  performance.measure(`${MARK_PREFIX}:selection-to-commit:${id}`, {
    start: record.selectionMark,
    end: commitMark,
    detail: { threadId, switchId: id, path },
  });
}

/** Record that the selected thread is temporarily displaying its outgoing transcript. */
export function recordThreadHoldStart(threadId: string): void {
  if (!isEnabled()) return;
  const id = latestByThread.get(threadId);
  if (id == null || id !== latestSelectionId) return;
  const record = records.get(id);
  if (!record || record.holdStartMark) return;
  const holdStartMark = `${MARK_PREFIX}:hold-start:${id}`;
  mark(holdStartMark, { threadId, switchId: id });
  record.holdStartMark = holdStartMark;
}

/** Record that the selected thread no longer needs its outgoing transcript hold. */
export function recordThreadHoldEnd(threadId: string): void {
  if (!isEnabled()) return;
  const id = latestByThread.get(threadId);
  if (id == null || id !== latestSelectionId) return;
  const record = records.get(id);
  if (!record || !record.holdStartMark || record.holdEndMark) return;
  const holdEndMark = `${MARK_PREFIX}:hold-end:${id}`;
  mark(holdEndMark, { threadId, switchId: id });
  record.holdEndMark = holdEndMark;
}

/** Record the first time the selected thread has paintable transcript content. */
export function recordFirstMessageVisible(threadId: string): void {
  if (!isEnabled()) return;
  const id = latestByThread.get(threadId);
  if (id == null || id !== latestSelectionId) return;
  const record = records.get(id);
  if (!record || record.firstMessageVisibleMark) return;
  const firstMessageVisibleMark = `${MARK_PREFIX}:first-message-visible:${id}`;
  mark(firstMessageVisibleMark, { threadId, switchId: id });
  record.firstMessageVisibleMark = firstMessageVisibleMark;
  performance.measure(`${MARK_PREFIX}:selection-to-first-message-visible:${id}`, {
    start: record.selectionMark,
    end: firstMessageVisibleMark,
    detail: { threadId, switchId: id },
  });
}

/** Record the first positioned paint for the latest selection of a thread. */
export function recordThreadPositioned(threadId: string): void {
  if (!isEnabled()) return;
  const id = latestByThread.get(threadId);
  if (id == null || id !== latestSelectionId) return;
  const record = records.get(id);
  if (!record || record.positionedMark) return;
  const positionedMark = `${MARK_PREFIX}:positioned:${id}`;
  mark(positionedMark, { threadId, switchId: id });
  record.positionedMark = positionedMark;
  performance.measure(`${MARK_PREFIX}:selection-to-positioned:${id}`, {
    start: record.selectionMark,
    end: positionedMark,
    detail: { threadId, switchId: id },
  });
}

/** Clear telemetry state and browser entries. Intended for unit tests only. */
export function __resetThreadSwitchTelemetryForTests(): void {
  if (isEnabled()) {
    for (const record of records.values()) clearRecord(record);
  }
  records.clear();
  latestByThread.clear();
  nextSwitchId = 0;
  latestSelectionId = null;
}
