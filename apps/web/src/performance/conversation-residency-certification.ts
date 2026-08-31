import type { Message } from "@/transport";
import {
  CONVERSATION_MEMORY_BUDGETS,
  cachePrefetchedHistoryPage,
  cacheRecord,
  clearRecordCache,
  getConversationCacheUsage,
  projectConversationCacheState,
  setActiveConversation,
} from "@/features/conversation/hydration/record-cache";
import {
  measureConversationMessages,
} from "@/features/conversation/hydration/conversation-memory-policy";
import {
  CONVERSATION_REVISION_GUARD,
  readConversationRevision,
  serializeConversationRevisionSnapshot,
} from "@/features/conversation/hydration/conversation-revision";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";

/** Minimum serialized allocation that makes the former revision guard material. */
export const MATERIAL_REVISION_SERIALIZATION_BYTES = 1024 * 1024;

/** Select the revision guard from the measured full-state allocation. */
export function selectConversationRevisionGuard(
  serializedBytesPerRead: number,
): "numeric" | "serialized" {
  return serializedBytesPerRead >= MATERIAL_REVISION_SERIALIZATION_BYTES
    ? "numeric"
    : "serialized";
}

/** Process-memory values observed during one representative history scenario. */
export interface ConversationProcessMemory {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
}

/** Resident-byte and process-memory evidence for one representative history. */
export interface ConversationHistoryCertification {
  messageCount: number;
  retainedMessageBytes: number;
  residentBytes: {
    active: number;
    inactive: number;
    prefetched: number;
    narrative: number;
  };
  processMemoryBefore: ConversationProcessMemory;
  processMemoryAfter: ConversationProcessMemory;
}

/** Duration distribution for one repeated operation. */
export interface ConversationDurationDistribution {
  samples: number;
  minMs: number;
  medianMs: number;
  maxMs: number;
}

/** Profile of the former serialized guard and the numeric replacement. */
export interface ConversationRevisionCertification {
  historyMessages: number;
  serializedBytesPerRead: number;
  serialization: ConversationDurationDistribution;
  numericRead: ConversationDurationDistribution;
  material: boolean;
  selectedGuard: "numeric" | "serialized";
  appliedGuard: "numeric";
}

/** Node-runner facts reported for the runtime that produced this certification. */
export interface ConversationCertificationRuntime {
  platform: string;
  architecture: string;
  nodeVersion: string;
  electronVersion: string | null;
}

/** Release-equivalent long-history certification report. */
export interface ConversationResidencyCertificationReport {
  schemaVersion: 1;
  createdAt: string;
  status: "pass" | "fail";
  failures: string[];
  runtime: ConversationCertificationRuntime;
  budgets: typeof CONVERSATION_MEMORY_BUDGETS;
  histories: ConversationHistoryCertification[];
  revision: ConversationRevisionCertification;
}

/** Create the representative retained message shape used by the certification. */
export function createRepresentativeConversation(
  threadId: string,
  messageCount: number,
  contentBytes = 16_000,
): Message[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    id: `${threadId}-message-${index + 1}`,
    thread_id: threadId,
    role: index % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(contentBytes),
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-08-11T00:00:00.000Z",
    sequence: index + 1,
    attachments: null,
  }));
}

/** Profile representative histories and the former full-state revision guard. */
export function runConversationResidencyCertification(
  runtime: ConversationCertificationRuntime,
  samples = 10,
): ConversationResidencyCertificationReport {
  if (!Number.isInteger(samples) || samples < 3 || samples > 50) {
    throw new Error("Conversation certification samples must be an integer from 3 through 50.");
  }
  const histories = [100, 1_000].map((messageCount) => profileHistory(messageCount));
  const revisionRecord = createRepresentativeRecord("revision-profile", 1_000);
  revisionRecord.conversationRevision = 7;
  const revision = profileRevision(revisionRecord, samples);
  const failures = collectFailures(histories, revision, runtime.electronVersion);
  clearRecordCache();
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    runtime,
    budgets: CONVERSATION_MEMORY_BUDGETS,
    histories,
    revision,
  };
}

function profileHistory(messageCount: number): ConversationHistoryCertification {
  clearRecordCache();
  const processMemoryBefore = readProcessMemory();
  const threadId = `history-${messageCount}`;
  const record = createRepresentativeRecord(threadId, messageCount);
  const retainedMessageBytes = measureConversationMessages(record.messages);

  setActiveConversation(threadId);
  cacheRecord(threadId, projectConversationCacheState(record));
  const activeUsage = getConversationCacheUsage();

  setActiveConversation(null);
  const inactiveUsage = getConversationCacheUsage();
  const prefetchThreadId = `${threadId}-prefetch`;
  cachePrefetchedHistoryPage(prefetchThreadId, messageCount + 1, {
    messages: createRepresentativeConversation(prefetchThreadId, messageCount),
    hasMore: false,
    narrativeByMessage: {},
  });
  const completeUsage = getConversationCacheUsage();

  return {
    messageCount,
    retainedMessageBytes,
    residentBytes: {
      active: activeUsage.activeBytes,
      inactive: inactiveUsage.inactiveBytes,
      prefetched: completeUsage.prefetchedBytes,
      narrative: completeUsage.narrativeBytes,
    },
    processMemoryBefore,
    processMemoryAfter: readProcessMemory(),
  };
}

function createRepresentativeRecord(threadId: string, messageCount: number): ThreadRecord {
  const messages = createRepresentativeConversation(threadId, messageCount);
  const narrativeByMessage = Object.fromEntries(
    messages
      .filter((message) => message.role === "assistant")
      .map((message) => [message.id, {
        tools: [],
        thoughts: [{
          id: `${message.id}-thought`,
          sort_order: 0,
          message_id: message.id,
          started_at: "2026-08-11T00:00:00.000Z",
          text: "n".repeat(256),
          ended_at: "2026-08-11T00:00:01.000Z",
        }],
        hooks: [],
      }]),
  );
  return {
    ...createEmptyThreadRecord(),
    messages,
    oldestLoadedSequence: 1,
    newestLoadedSequence: messageCount,
    narrativeByMessage,
  };
}

function profileRevision(
  record: ThreadRecord,
  samples: number,
): ConversationRevisionCertification {
  serializeConversationRevisionSnapshot(record);
  readConversationRevision(record);
  const serializationDurations: number[] = [];
  const numericDurations: number[] = [];
  let serializedBytesPerRead = 0;
  let checksum = 0;

  for (let sample = 0; sample < samples; sample++) {
    const serializationStart = performance.now();
    const serialized = serializeConversationRevisionSnapshot(record);
    serializationDurations.push(performance.now() - serializationStart);
    serializedBytesPerRead = new TextEncoder().encode(serialized).byteLength;

    const numericStart = performance.now();
    for (let read = 0; read < 10_000; read++) {
      checksum += readConversationRevision(record);
    }
    numericDurations.push((performance.now() - numericStart) / 10_000);
  }
  if (checksum === Number.MIN_SAFE_INTEGER) {
    throw new Error("Unreachable revision checksum.");
  }
  const selectedGuard = selectConversationRevisionGuard(serializedBytesPerRead);
  return {
    historyMessages: record.messages.length,
    serializedBytesPerRead,
    serialization: summarizeDurations(serializationDurations),
    numericRead: summarizeDurations(numericDurations),
    material: selectedGuard === "numeric",
    selectedGuard,
    appliedGuard: CONVERSATION_REVISION_GUARD,
  };
}

function summarizeDurations(values: number[]): ConversationDurationDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}

function readProcessMemory(): ConversationProcessMemory {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
  };
}

function collectFailures(
  histories: ConversationHistoryCertification[],
  revision: ConversationRevisionCertification,
  electronVersion: string | null,
): string[] {
  const failures: string[] = [];
  if (!electronVersion) failures.push("The certification did not run in Electron's Node runtime.");
  for (const history of histories) {
    if (history.residentBytes.active > CONVERSATION_MEMORY_BUDGETS.activeBytes) {
      failures.push(`${history.messageCount}-message active residency exceeded its byte budget.`);
    }
    if (history.residentBytes.inactive > CONVERSATION_MEMORY_BUDGETS.inactiveBytes) {
      failures.push(`${history.messageCount}-message inactive residency exceeded its byte budget.`);
    }
    if (history.residentBytes.prefetched > CONVERSATION_MEMORY_BUDGETS.prefetchedBytes) {
      failures.push(`${history.messageCount}-message prefetch residency exceeded its byte budget.`);
    }
    if (history.residentBytes.narrative > CONVERSATION_MEMORY_BUDGETS.narrativeBytes) {
      failures.push(`${history.messageCount}-message narrative residency exceeded its byte budget.`);
    }
  }
  if (revision.appliedGuard !== revision.selectedGuard) {
    failures.push(
      `The profile selected the ${revision.selectedGuard} guard, but production uses ${revision.appliedGuard}.`,
    );
  }
  return failures;
}
