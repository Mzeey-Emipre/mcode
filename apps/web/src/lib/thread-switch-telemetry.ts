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

/** Bounded counters for running-thread switch pressure signals. */
export interface ThreadSwitchTelemetryCounters {
  runningResidentHits: number;
  runningFetchRequired: number;
  backgroundEventsDropped: number;
  subscriptionsSkipped: number;
}

const records = new Map<number, ThreadSwitchRecord>();
const latestByThread = new Map<string, number>();
const eventMarks: string[] = [];
const counters: ThreadSwitchTelemetryCounters = {
  runningResidentHits: 0,
  runningFetchRequired: 0,
  backgroundEventsDropped: 0,
  subscriptionsSkipped: 0,
};
let nextSwitchId = 0;
let latestSelectionId: number | null = null;
let nextEventId = 0;

const MAX_RETAINED_EVENT_MARKS = 64;
const MAX_EVENT_COUNT = 10_000;

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

function recordEvent(
  threadId: string,
  event: keyof ThreadSwitchTelemetryCounters,
  markName: string,
): void {
  if (!isEnabled()) return;
  counters[event] = Math.min(MAX_EVENT_COUNT, counters[event] + 1);
  const eventId = ++nextEventId;
  const switchId = latestByThread.get(threadId) ?? latestSelectionId ?? eventId;
  const name = `${MARK_PREFIX}:${markName}:${switchId}:${eventId}`;
  mark(name, { threadId, switchId, eventId, count: counters[event] });
  eventMarks.push(name);
  while (eventMarks.length > MAX_RETAINED_EVENT_MARKS) {
    const oldest = eventMarks.shift();
    if (oldest) performance.clearMarks(oldest);
  }
}

/** Record that a running thread activated from its resident transcript. */
export function recordRunningResidentHit(threadId: string): void {
  recordEvent(threadId, "runningResidentHits", "running-resident-hit");
}

/** Record that a running thread activation required a network fetch. */
export function recordRunningFetchRequired(threadId: string): void {
  recordEvent(threadId, "runningFetchRequired", "running-fetch-required");
}

/** Record a dropped background event without retaining production state. */
export function recordBackgroundEventDropped(threadId: string): void {
  recordEvent(threadId, "backgroundEventsDropped", "background-event-dropped");
}

/** Record a skipped subscription callback without retaining production state. */
export function recordSubscriptionSkipped(threadId: string): void {
  recordEvent(threadId, "subscriptionsSkipped", "subscription-skipped");
}

/** Read bounded dev counters for diagnostics and tests. */
export function getThreadSwitchTelemetryCounters(): ThreadSwitchTelemetryCounters {
  return { ...counters };
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

/** Reset thread-switch telemetry state and browser entries for unit tests. */
export function __resetThreadSwitchTelemetryForTests(): void {
  if (isEnabled()) {
    for (const record of records.values()) clearRecord(record);
  }
  records.clear();
  latestByThread.clear();
  for (const name of eventMarks) {
    if (isEnabled()) performance.clearMarks(name);
  }
  eventMarks.length = 0;
  counters.runningResidentHits = 0;
  counters.runningFetchRequired = 0;
  counters.backgroundEventsDropped = 0;
  counters.subscriptionsSkipped = 0;
  nextSwitchId = 0;
  latestSelectionId = null;
  nextEventId = 0;
}
