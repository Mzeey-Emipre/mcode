import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadMessages,
  getTestThreadStreaming,
  getTestThreadToolCalls,
  getTestThreadLoadEpoch,
  getTestThreadAgentStartTime,
  readActiveThreadField,
} from "@/stores/thread-store-test-utils";
/**
 * Behavioural tests for ThreadHydrator — the test surface defined in #522.
 * Asserts on store state after hydrate(), not internal sub-module calls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, extractPendingPlanQuestions } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import {
  clearRecordCache,
  cacheRecord as cacheConversationRecord,
  getCachedRecord,
  hasPrefetchedHistoryPage,
  projectConversationCacheState,
} from "../record-cache";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import {
  createThreadHydrator,
  HYDRATION_TTL_MS,
  HISTORY_PREFETCH_SIZE,
  MESSAGE_FETCH_SIZE,
  RECORD_CACHE_SIZE,
  RECORD_MESSAGE_CACHE_SIZE,
  type ThreadHydrator,
} from "..";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { coerceTaskStatus } from "@/stores/taskStore";
import { getTransport } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import type { GoalLookupResult, GoalState, TurnSnapshot } from "@mcode/contracts";
import { CONVERSATION_OLDER_PAGE_MAX_BYTES } from "@mcode/contracts";
import { clearScrollMemory, rememberScrollTop } from "@/components/chat/scrollPositionMemory";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

const msgA = createMockMessage({ id: "a1", thread_id: THREAD_A, content: "hello A", sequence: 1 });
const msgB = createMockMessage({ id: "b1", thread_id: THREAD_B, content: "hello B", sequence: 1 });

function makeGoal(threadId = THREAD_A): GoalState {
  return {
    threadId,
    objective: `goal for ${threadId}`,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    providerId: "codex",
    source: "codex",
    controls: { canInspect: true, canClear: true },
  };
}

function makeCachedRecord(messages = [msgA]): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
    messages,
    oldestLoadedSequence: messages[0]?.sequence ?? 0,
  };
}

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

/** Build a hydrator wired to the live threadStore for integration-style tests. */
function createStoreHydrator(): ThreadHydrator {
  return createThreadHydrator({
    getTransport: () => getTransport(),
    getState: () => useThreadStore.getState(),
    setState: (partial) => useThreadStore.setState(partial as never),
    getWorkspaceThread: (threadId) =>
      useWorkspaceStore.getState().threads.find((t) => t.id === threadId),
    flushPendingTextDeltas: () => {},
    loadNarrativeForMessage: (messageId) =>
      useThreadStore.getState().loadNarrativeForMessage(messageId),
    setPlanQuestions: (threadId, questions) =>
      useThreadStore.getState().setPlanQuestions(threadId, questions),
    extractPendingPlanQuestions,
    getTasksForThread: (threadId) => useTaskStore.getState().tasksByThread[threadId] ?? [],
    setTasksForThread: (threadId, tasks) => useTaskStore.getState().setTasks(threadId, tasks),
    addPlanForThread: (threadId, plan) => usePlanStore.getState().addPlan(threadId, plan),
    shallowEqualBy,
    coerceTaskStatus,
    getWorkspaceThreadSettings: () => ({
      permissionMode: PERMISSION_MODES.FULL,
      interactionMode: INTERACTION_MODES.BUILD,
    }),
  });
}

function resetStores() {
  clearScrollMemory();
  clearRecordCache();
  vi.clearAllMocks();

  (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockImplementation(
    async (threadId: string) => ({
      messages: threadId === THREAD_B ? [msgB] : [msgA],
      hasMore: false,
    }),
  );
  (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
    async (threadId: string) => ({
      messages: threadId === THREAD_B ? [msgB] : [msgA],
      hasMore: false,
      narrativeByMessage: {},
    }),
  );
  (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
    async (request) => {
      const page = await mockTransport.loadConversationPage(
        request.threadId,
        request.limit,
        request.cursor.beforeSequence,
      );
      return {
        identity: {
          threadId: request.threadId,
          cursor: request.cursor,
          direction: request.direction,
          generation: request.generation,
          conversationRevision: request.conversationRevision,
        },
        ...page,
        nextCursor: page.hasMore && page.messages.length > 0
          ? { version: 1, beforeSequence: page.messages[0].sequence }
          : null,
      };
    },
  );
  (mockTransport.loadNewerConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
    async (request) => ({
      identity: {
        threadId: request.threadId,
        cursor: request.cursor,
        direction: request.direction,
        generation: request.generation,
        conversationRevision: request.conversationRevision,
      },
      messages: [],
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    }),
  );
  (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockTransport.listPendingPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (mockTransport.getThreadPlans as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockTransport.loadTurn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockTransport.getThreadGoal as ReturnType<typeof vi.fn>).mockResolvedValue({
    goal: null,
    authoritative: false,
    source: "codex-cache",
    reason: "not-materialized",
  });

  useWorkspaceStore.setState({
    threads: [
      createMockThread({ id: THREAD_A, has_file_changes: false }),
      createMockThread({ id: THREAD_B, has_file_changes: false }),
    ],
  });

  useTaskStore.setState({ tasksByThread: {} });
  usePlanStore.setState({ plansByThread: {} });

  resetThreadStoreForTests({
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    recentlyAnsweredPlanMessageIds: new Set<string>(),
  });
}

describe("ThreadHydrator", () => {
  let hydrator: ThreadHydrator;

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    resetStores();
    hydrator = createStoreHydrator();
  });

  it("cache hit restores synchronously with loading false and skips conversation.page", async () => {
    cacheRecord(THREAD_A, makeCachedRecord());

    const beforeEpoch = getTestThreadLoadEpoch(THREAD_A);
    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(readActiveThreadField((r) => r.loading)).toBe(false);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(getTestThreadLoadEpoch(THREAD_A)).toBe(beforeEpoch + 1);
  });

  it("refetches an empty cache after a released resident hydration remounts", async () => {
    const childMessage = createMockMessage({
      id: "child-detail-message",
      thread_id: THREAD_A,
      content: "child detail content",
    });
    let resolveFirst!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        messages: [childMessage],
        hasMore: false,
        narrativeByMessage: {},
      });
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      records: new Map([
        [THREAD_A, createEmptyThreadRecord()],
        [THREAD_B, createEmptyThreadRecord()],
      ]),
    });

    let current = true;
    const isCurrent = () => current;
    const firstHydration = hydrator.hydrateResident(THREAD_A, {
      generation: 1,
      isCurrent,
    });
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    });

    current = false;
    hydrator.releaseResident(THREAD_A, 1, isCurrent);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([]);
    expect(getCachedRecord(THREAD_A)?.lastHydratedAt).toBeUndefined();

    current = true;
    const remountedHydration = hydrator.hydrateResident(THREAD_A, {
      generation: 2,
      isCurrent,
    });
    resolveFirst({ messages: [], hasMore: false, narrativeByMessage: {} });
    await Promise.all([firstHydration, remountedHydration]);

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);
    expect(getTestThreadMessages(THREAD_A)).toEqual([childMessage]);
  });

  it("preserves resident auxiliary state on an idle cache hit", async () => {
    const goal = makeGoal();
    cacheRecord(THREAD_A, makeCachedRecord());
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), goal }],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(readActiveThreadField((record) => record.goal)).toEqual(goal);
    expect(getTestActiveMessages()).toEqual([msgA]);
  });

  it("retains distinct resident and cached messages with the same sequence", async () => {
    const staleCachedMessage = createMockMessage({
      id: "stale-cache-message",
      thread_id: THREAD_A,
      content: "stale cache message",
      sequence: 2,
    });
    const residentMessage = createMockMessage({
      id: "resident-message",
      thread_id: THREAD_A,
      content: "newer resident message",
      sequence: 2,
    });
    cacheRecord(THREAD_A, {
      ...makeCachedRecord([staleCachedMessage]),
      persistedToolCallCounts: { "stale-cache-message": 1 },
      serverMessageIds: { "stale-cache-message": "server-stale" },
    });
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([[THREAD_A, {
        ...makeCachedRecord([residentMessage]),
        persistedToolCallCounts: { "resident-message": 2 },
        serverMessageIds: { "resident-message": "server-resident" },
      }]]),
    });
    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages().map((message) => message.id)).toEqual([
      "resident-message",
      "stale-cache-message",
    ]);
    expect(readActiveThreadField((record) => record.persistedToolCallCounts)).toEqual({
      "stale-cache-message": 1,
      "resident-message": 2,
    });
    expect(readActiveThreadField((record) => record.serverMessageIds)).toEqual({
      "stale-cache-message": "server-stale",
      "resident-message": "server-resident",
    });
  });

  it("deduplicates a resident message id when its cached sequence is stale", async () => {
    const cachedMessage = createMockMessage({
      id: "same-message",
      thread_id: THREAD_A,
      content: "stale cached content",
      sequence: 1,
    });
    const residentMessage = createMockMessage({
      id: "same-message",
      thread_id: THREAD_A,
      content: "resident content",
      sequence: 2,
    });
    cacheRecord(THREAD_A, makeCachedRecord([cachedMessage]));
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, makeCachedRecord([residentMessage])]]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual([residentMessage]);
  });

  it("retains distinct resident and authoritative messages with the same sequence", async () => {
    const residentAssistant = createMockMessage({
      id: "assistant-34",
      thread_id: THREAD_A,
      role: "assistant",
      content: "resident answer",
      sequence: 34,
    });
    const authoritativeUser = createMockMessage({
      id: "user-34",
      thread_id: THREAD_A,
      role: "user",
      content: "authoritative follow-up",
      sequence: 34,
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [authoritativeUser],
      hasMore: false,
      narrativeByMessage: {},
    });
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, makeCachedRecord([residentAssistant])]]),
    });

    await hydrator.hydrate(THREAD_A, "active", { force: true });

    expect(getTestActiveMessages().map((message) => message.id)).toEqual([
      "assistant-34",
      "user-34",
    ]);
  });

  it("replaces optimistic selected-text comments with canonical user-source metadata", async () => {
    const canonicalComments = [{
      id: "550e8400-e29b-41d4-a716-446655440003",
      displayNumber: 1,
      source: {
        threadId: THREAD_A,
        messageId: "completed-user-message",
        sourceRole: "user" as const,
        start: 1,
        end: 3,
        quote: "😀",
      },
      note: "Canonical note.",
      mentions: [],
    }];
    const optimisticMessage = createMockMessage({
      id: "user-selected-comment",
      thread_id: THREAD_A,
      role: "user",
      content: "Explain this.",
      sequence: 8,
      selectedTextComments: [{ ...canonicalComments[0]!, note: "Optimistic note." }],
    });
    const canonicalMessage = createMockMessage({
      ...optimisticMessage,
      selectedTextComments: canonicalComments,
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [canonicalMessage],
      hasMore: false,
      narrativeByMessage: {},
    });
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, makeCachedRecord([optimisticMessage])]]),
    });

    await hydrator.hydrate(THREAD_A, "active", { force: true });

    expect(getTestActiveMessages()[0]?.selectedTextComments).toEqual(canonicalComments);
    expect(getTestActiveMessages()[0]?.selectedTextComments?.[0]?.source).toEqual({
      threadId: THREAD_A,
      messageId: "completed-user-message",
      sourceRole: "user",
      start: 1,
      end: 3,
      quote: "😀",
    });
  });

  it("cache miss fetches a conversation page, commits store, and populates cache", async () => {
    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(readActiveThreadField((r) => r.loading)).toBe(false);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([msgA]);
  });

  it("does not let delayed snapshot hydration replace a running turn file summary", async () => {
    const liveSummary = {
      revision: 2,
      fileCount: 1,
      additions: 3,
      deletions: 1,
      effects: [],
    };
    useWorkspaceStore.setState({
      threads: [
        createMockThread({ id: THREAD_A, has_file_changes: true }),
        createMockThread({ id: THREAD_B, has_file_changes: false }),
      ],
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map([
        [THREAD_A, {
          ...createEmptyThreadRecord(),
          messages: [msgA],
          fileEffectTurnId: "live-turn",
          fileEffectSummary: liveSummary,
        }],
      ]),
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        message_id: "persisted-turn",
        files_changed: ["old.ts"],
        file_effects: {
          revision: 9,
          fileCount: 9,
          additions: 9,
          deletions: 9,
          effects: [],
        },
      } as unknown as TurnSnapshot,
    ]);

    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(readActiveThreadField((record) => record.persistedFilesChanged)).toEqual({
        "persisted-turn": ["old.ts"],
      });
    });

    expect(readActiveThreadField((record) => record.fileEffectTurnId)).toBe("live-turn");
    expect(readActiveThreadField((record) => record.fileEffectSummary)).toEqual(liveSummary);
  });

  it("discards resident running snapshots after a newer activation epoch wins", async () => {
    let resolveSnapshots!: (value: Array<{
      message_id: string;
      files_changed: string[];
      thread_id: string;
      created_at: string;
    }>) => void;
    useWorkspaceStore.setState({
      threads: [
        createMockThread({ id: THREAD_A, has_file_changes: true }),
        createMockThread({ id: THREAD_B, has_file_changes: false }),
      ],
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map([
        [THREAD_A, { ...makeCachedRecord(), loadEpoch: 2 }],
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshots = resolve;
      }),
    );

    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_A);
    });

    useThreadStore.setState((state) => ({
      records: patchThreadRecord(state.records, THREAD_A, (record) => ({
        loadEpoch: record.loadEpoch + 1,
      })),
    }));
    resolveSnapshots([{
      message_id: "stale-turn",
      files_changed: ["src/stale.ts"],
      thread_id: THREAD_A,
      created_at: "2026-01-01T00:00:00Z",
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(readActiveThreadField((record) => record.persistedFilesChanged)).toEqual({});
    expect(getCachedRecord(THREAD_A)?.persistedFilesChanged).toEqual({});
  });

  it("keeps prefetched earlier history out of live state until pagination", async () => {
    const history = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `a-${index + 1}`,
      thread_id: THREAD_A,
      content: `message ${index + 1}`,
      sequence: index + 1,
    }));
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_threadId: string, limit: number, before?: number) => {
        const eligible = before == null
          ? history
          : history.filter((entry) => entry.sequence < before);
        const messages = eligible.slice(-limit);
        return {
          messages,
          hasMore: eligible.length > messages.length,
          narrativeByMessage: {},
        };
      },
    );

    await hydrator.hydrate(THREAD_A, "active");

    const visibleTail = history.slice(-MESSAGE_FETCH_SIZE);
    const historyCursor = visibleTail[0].sequence;
    expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(1, THREAD_A, MESSAGE_FETCH_SIZE);
    expect(getTestActiveMessages()).toEqual(visibleTail);

    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(
        2,
        THREAD_A,
        HISTORY_PREFETCH_SIZE,
        historyCursor,
      );
    });
    expect(getTestActiveMessages()).toEqual(visibleTail);

    await useThreadStore.getState().loadOlderMessages(THREAD_A);

    expect(getTestActiveMessages()).toEqual(history);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);
  });

  it("merges an older page after a live-only conversation revision", async () => {
    const tail = createMockMessage({
      id: "tail-10",
      thread_id: THREAD_A,
      sequence: 10,
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      records: new Map([[THREAD_A, {
        ...createEmptyThreadRecord(),
        messages: [tail],
        oldestLoadedSequence: 10,
        hasMoreMessages: true,
        loadEpoch: 4,
      }]]),
    });
    let resolvePage!: (page: {
      identity: {
        threadId: string;
        cursor: { version: 1; beforeSequence: number };
        direction: "older";
        generation: number;
        conversationRevision: number;
      };
      messages: ReturnType<typeof createMockMessage>[];
      hasMore: boolean;
      nextCursor: null;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );

    const pending = useThreadStore.getState().loadOlderMessages(THREAD_A);
    const request = (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(request).toEqual({
      threadId: THREAD_A,
      cursor: { version: 1, beforeSequence: 10 },
      direction: "older",
      generation: 4,
      conversationRevision: expect.any(Number),
      limit: 50,
      maxBytes: CONVERSATION_OLDER_PAGE_MAX_BYTES,
    });

    useThreadStore.setState((state) => ({
      records: patchThreadRecord(state.records, THREAD_A, { streaming: "live update" }),
    }));
    resolvePage({
      identity: {
        threadId: request.threadId,
        cursor: request.cursor,
        direction: request.direction,
        generation: request.generation,
        conversationRevision: request.conversationRevision,
      },
      messages: [createMockMessage({ id: "older-9", thread_id: THREAD_A, sequence: 9 })],
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    });
    await pending;

    expect(getTestActiveMessages()).toEqual([
      expect.objectContaining({ id: "older-9", sequence: 9 }),
      tail,
    ]);
    expect(readActiveThreadField((record) => record.isLoadingMore)).toBe(false);
  });

  it("moves a bounded resident window backward and forward without gaps or duplicates", async () => {
    const history = Array.from({ length: 400 }, (_, index) => createMockMessage({
      id: `history-${index + 1}`,
      thread_id: THREAD_A,
      sequence: index + 1,
    }));
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      records: new Map([[THREAD_A, {
        ...createEmptyThreadRecord(),
        messages: history.slice(200),
        oldestLoadedSequence: 201,
        newestLoadedSequence: 400,
        hasMoreMessages: true,
        hasNewerMessages: false,
        loadEpoch: 3,
      }]]),
    });
    (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (request) => {
        const eligible = history.filter((message) => message.sequence < request.cursor.beforeSequence);
        const messages = eligible.slice(-request.limit);
        return {
          identity: {
            threadId: request.threadId,
            cursor: request.cursor,
            direction: request.direction,
            generation: request.generation,
            conversationRevision: request.conversationRevision,
          },
          messages,
          hasMore: eligible.length > messages.length,
          nextCursor: eligible.length > messages.length
            ? { version: 1, beforeSequence: messages[0].sequence }
            : null,
          narrativeByMessage: {},
        };
      },
    );
    (mockTransport.loadNewerConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (request) => {
        const eligible = history.filter((message) => message.sequence > request.cursor.afterSequence);
        const messages = eligible.slice(0, request.limit);
        return {
          identity: {
            threadId: request.threadId,
            cursor: request.cursor,
            direction: request.direction,
            generation: request.generation,
            conversationRevision: request.conversationRevision,
          },
          messages,
          hasMore: eligible.length > messages.length,
          nextCursor: eligible.length > messages.length
            ? { version: 1, afterSequence: messages.at(-1)!.sequence }
            : null,
          narrativeByMessage: {},
        };
      },
    );

    for (let index = 0; index < 4; index++) {
      await useThreadStore.getState().loadOlderMessages(THREAD_A);
    }

    expect(getTestActiveMessages().map((message) => message.sequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    expect(readActiveThreadField((record) => record.hasNewerMessages)).toBe(true);

    for (let index = 0; index < 4; index++) {
      await useThreadStore.getState().loadNewerMessages(THREAD_A);
    }

    expect(getTestActiveMessages().map((message) => message.sequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 201),
    );
    expect(new Set(getTestActiveMessages().map((message) => message.id)).size).toBe(200);
    expect(readActiveThreadField((record) => record.hasMoreMessages)).toBe(true);
    expect(readActiveThreadField((record) => record.hasNewerMessages)).toBe(false);
  });

  it("compacts cached history for restore and keeps its older rows warm", async () => {
    const history = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `cached-a-${index + 1}`,
      thread_id: THREAD_A,
      sequence: index + 1,
    }));
    cacheRecord(THREAD_A, {
      ...makeCachedRecord(history.slice(88)),
      hasMoreMessages: true,
    });
    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual(history.slice(-MESSAGE_FETCH_SIZE));
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();

    await useThreadStore.getState().loadOlderMessages(THREAD_A);

    expect(getTestActiveMessages()).toEqual(history.slice(88));
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("keeps a newer resident row through compact cache restore, pagination, and refresh", async () => {
    const persistedTail = Array.from({ length: 4 }, (_, index) => createMockMessage({
      id: `persisted-high-${index + 97}`,
      thread_id: THREAD_A,
      sequence: index + 97,
    }));
    const resident = createMockMessage({
      id: "resident-newer-than-cache",
      thread_id: THREAD_A,
      content: "live resident row",
      sequence: 101,
    });
    const refreshedPersisted = createMockMessage({
      id: "persisted-high-100",
      thread_id: THREAD_A,
      content: "persisted refresh",
      sequence: 100,
    });
    cacheRecord(THREAD_A, {
      ...makeCachedRecord(persistedTail),
      hasMoreMessages: true,
    });
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, {
        ...makeCachedRecord([resident]),
        hasMoreMessages: true,
      }]]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual([persistedTail[3], resident]);
    await useThreadStore.getState().loadOlderMessages(THREAD_A);
    expect(getTestActiveMessages()).toEqual([...persistedTail, resident]);

    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [refreshedPersisted],
      hasMore: false,
      narrativeByMessage: {},
    });
    await hydrator.hydrate(THREAD_A, "active", { force: true });

    expect(getTestActiveMessages()).toEqual([
      persistedTail[0],
      persistedTail[1],
      persistedTail[2],
      refreshedPersisted,
      resident,
    ]);
  });

  it("chooses the highest settled file summary while preserving a live owner", async () => {
    const low = { revision: 2, fileCount: 2, additions: 2, deletions: 2, effects: [] };
    const high = { revision: 8, fileCount: 8, additions: 8, deletions: 8, effects: [] };
    const live = { revision: 1, fileCount: 1, additions: 1, deletions: 1, effects: [] };

    cacheConversationRecord(THREAD_A, {
      ...projectConversationCacheState(makeCachedRecord()),
      settledFileEffectSummary: low,
    });
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, { ...makeCachedRecord(), fileEffectSummary: high }]]),
    });
    await hydrator.hydrate(THREAD_A, "active");
    expect(readActiveThreadField((record) => record.fileEffectSummary)).toEqual(high);

    resetStores();
    hydrator = createStoreHydrator();
    cacheConversationRecord(THREAD_A, {
      ...projectConversationCacheState(makeCachedRecord()),
      settledFileEffectSummary: high,
    });
    expect(getCachedRecord(THREAD_A)?.settledFileEffectSummary).toEqual(high);
    resetThreadStoreForTests({
      records: new Map([[THREAD_A, { ...makeCachedRecord(), fileEffectSummary: low }]]),
    });
    await hydrator.hydrate(THREAD_A, "active");
    expect(getCachedRecord(THREAD_A)?.settledFileEffectSummary).toEqual(high);
    expect(readActiveThreadField((record) => record.fileEffectSummary)).toEqual(high);

    resetStores();
    hydrator = createStoreHydrator();
    cacheConversationRecord(THREAD_A, {
      ...projectConversationCacheState(makeCachedRecord()),
      settledFileEffectSummary: high,
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map([[THREAD_A, {
        ...makeCachedRecord(),
        fileEffectSummary: live,
        fileEffectTurnId: "live-turn",
      }]]),
    });
    await hydrator.hydrate(THREAD_A, "active");
    expect(readActiveThreadField((record) => record.fileEffectSummary)).toEqual(live);
  });

  it("restores the loaded window when returning to a cached history position", async () => {
    const history = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `cached-history-${index + 1}`,
      thread_id: THREAD_A,
      sequence: index + 1,
    }));
    cacheRecord(THREAD_A, {
      ...makeCachedRecord(history),
      hasMoreMessages: true,
    });
    rememberScrollTop(THREAD_A, 1_500, false);

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual(history);
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("preserves an existing open goal when lookup returns non-authoritative null", async () => {
    const goal = makeGoal();
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), goal }],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(readActiveThreadField((r) => r.goal)).toEqual(goal);
    expect(getCachedRecord(THREAD_A)).not.toHaveProperty("goal");
  });

  it("clears the resident goal when lookup returns authoritative null", async () => {
    const goal = makeGoal();
    cacheRecord(THREAD_A, { ...makeCachedRecord(), goal });
    (mockTransport.getThreadGoal as ReturnType<typeof vi.fn>).mockResolvedValue({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    });

    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(readActiveThreadField((r) => r.goal)).toBeNull();
    });

    expect(getCachedRecord(THREAD_A)).not.toHaveProperty("goal");
  });

  it("applies lookup goals only to the requested thread", async () => {
    const goalA = makeGoal(THREAD_A);
    const goalB = makeGoal(THREAD_B);
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [THREAD_B, { ...createEmptyThreadRecord(), goal: goalB }],
      ]),
    });
    (mockTransport.getThreadGoal as ReturnType<typeof vi.fn>).mockResolvedValue({
      goal: goalA,
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(useThreadStore.getState().records.get(THREAD_A)?.goal).toEqual(goalA);
    expect(useThreadStore.getState().records.get(THREAD_B)?.goal).toEqual(goalB);
  });

  it("skips auxiliary fanout on cache hit within the TTL window", async () => {
    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalled();
    });
    vi.clearAllMocks();

    useThreadStore.setState((s) => ({
      currentThreadId: THREAD_B,
      records: patchThreadRecord(s.records, THREAD_B, { messages: [] }),
    }));
    await hydrator.hydrate(THREAD_A, "active");
    await new Promise((r) => setTimeout(r, 20));

    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();
    expect(mockTransport.getThreadTasks).not.toHaveBeenCalled();
  });

  it("retains auxiliary freshness when an inactive thread is restored from cache", async () => {
    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledWith(THREAD_A);
    });
    expect(getCachedRecord(THREAD_A)?.lastHydratedAt).toBeGreaterThan(0);

    vi.clearAllMocks();
    await hydrator.hydrate(THREAD_B, "active");
    vi.clearAllMocks();

    await hydrator.hydrate(THREAD_A, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();
    expect(mockTransport.getThreadTasks).not.toHaveBeenCalled();
  });

  it("re-fans out auxiliary data once the TTL window elapses", async () => {
    await hydrator.hydrate(THREAD_A, "active");
    useThreadStore.setState((s) => ({
      currentThreadId: THREAD_B,
      records: patchThreadRecord(s.records, THREAD_A, {
        lastHydratedAt: Date.now() - HYDRATION_TTL_MS - 100,
      }),
    }));
    vi.clearAllMocks();

    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledWith(THREAD_A);
    });
  });

  it("preserves volatile state for a running thread on cache miss", async () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([
        [
          THREAD_A,
          {
            ...createEmptyThreadRecord(),
            streaming: "partial...",
            toolCalls: [
              { id: "tc1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestThreadStreaming(THREAD_A)).toBe("partial...");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
  });

  it("refreshes a resident thread when its cache was invalidated", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), messages: [msgA] }],
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
  });

  it("retires an inactive tail transcript into the bounded cache", async () => {
    const history = Array.from({ length: 120 }, (_, index) => createMockMessage({
      id: `retired-a-${index + 1}`,
      thread_id: THREAD_A,
      sequence: index + 1,
    }));
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), messages: history, hasMoreMessages: true }],
      ]),
    });
    rememberScrollTop(THREAD_A, 9_600, true);
    cacheRecord(THREAD_B, makeCachedRecord([msgB]));

    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useThreadStore.getState().records.has(THREAD_A)).toBe(false);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual(history.slice(-MESSAGE_FETCH_SIZE));
    expect(hasPrefetchedHistoryPage(THREAD_A, 119)).toBe(true);
  });

  it("retires a completed empty transcript into the bounded cache", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      records: new Map([[THREAD_A, createEmptyThreadRecord()]]),
    });
    cacheRecord(THREAD_B, makeCachedRecord([msgB]));

    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useThreadStore.getState().records.has(THREAD_A)).toBe(false);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([]);
    expect(getCachedRecord(THREAD_A)).not.toHaveProperty("loading");
  });

  it("bounds completed records that are repeatedly deselected", () => {
    const threadIds = Array.from(
      { length: RECORD_CACHE_SIZE + 1 },
      (_, index) => `completed-thread-${index + 1}`,
    );

    for (const threadId of threadIds) {
      const messages = Array.from(
        { length: RECORD_MESSAGE_CACHE_SIZE + 1 },
        (_, index) => createMockMessage({
          id: `${threadId}-message-${index + 1}`,
          thread_id: threadId,
          sequence: index + 1,
        }),
      );
      useThreadStore.setState({
        currentThreadId: threadId,
        records: new Map([[threadId, { ...createEmptyThreadRecord(), messages }]]),
      });

      hydrator.deactivate();
    }

    expect(useThreadStore.getState().currentThreadId).toBeNull();
    expect(useThreadStore.getState().records.size).toBe(0);
    expect(getCachedRecord(threadIds[0]!)).toBeUndefined();
    const retainedMessages = getCachedRecord(threadIds.at(-1)!)?.messages.length;
    expect(retainedMessages).toBeGreaterThan(0);
    expect(retainedMessages).toBeLessThanOrEqual(RECORD_MESSAGE_CACHE_SIZE);
  });

  it("restores messages added to a resident thread after its empty snapshot was cached", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map([[THREAD_A, createEmptyThreadRecord()]]),
    });
    cacheRecord(THREAD_B, makeCachedRecord([msgB]));

    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getCachedRecord(THREAD_A)?.messages).toEqual([]);
    useThreadStore.setState((state) => {
      const runningThreadIds = new Set(state.runningThreadIds);
      runningThreadIds.delete(THREAD_A);
      return {
        runningThreadIds,
        records: patchThreadRecord(state.records, THREAD_A, { messages: [msgA] }),
      };
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("reopens a running resident layer without replacing its live state", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([[
        THREAD_A,
        {
          ...createEmptyThreadRecord(),
          messages: [msgA],
          streaming: "current activity",
          toolCalls: [
            { id: "tc1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
          ],
        },
      ]]),
    });
    await hydrator.hydrate(THREAD_A, "active");

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
  });

  it("uses auxiliary TTL by default and when force is false for resident hydration", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...makeCachedRecord(), lastHydratedAt: Date.now() }],
        [THREAD_B, makeCachedRecord([msgB])],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await hydrator.hydrate(THREAD_A, "active", { force: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await hydrator.hydrate(THREAD_A, "active", { force: true });
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledWith(THREAD_A);
    });
  });

  it("force refreshes a running resident layer without wiping live state", async () => {
    let resolveFetch!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    const freshMessage = createMockMessage({
      id: "fresh-message",
      thread_id: THREAD_A,
      content: "fresh authoritative message",
      sequence: 2,
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([[
        THREAD_A,
        {
          ...createEmptyThreadRecord(),
          messages: [msgA],
          streaming: "current activity",
          toolCalls: [
            { id: "tc1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
          ],
        },
      ]]),
    });

    const hydrate = hydrator.hydrate(THREAD_A, "active", { force: true });
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
    });
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);

    resolveFetch({ messages: [msgA, freshMessage], hasMore: false, narrativeByMessage: {} });
    await hydrate;

    expect(getTestActiveMessages()).toEqual([msgA, freshMessage]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
  });

  it("force refreshes authoritatively after an in-flight background prefetch", async () => {
    const resident = createMockMessage({
      id: "resident-message",
      thread_id: THREAD_A,
      content: "resident message",
      sequence: 1,
    });
    const speculative = createMockMessage({
      id: "speculative-message",
      thread_id: THREAD_A,
      content: "speculative background message",
      sequence: 2,
    });
    const authoritative = createMockMessage({
      id: "authoritative-message",
      thread_id: THREAD_A,
      content: "authoritative refresh message",
      sequence: 3,
    });
    let resolveBackground!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    let resolveAuthoritative!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveBackground = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveAuthoritative = resolve;
      }));
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([[
        THREAD_A,
        {
          ...createEmptyThreadRecord(),
          messages: [resident],
          streaming: "current activity",
          toolCalls: [
            { id: "tc1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
          ],
        },
      ]]),
    });

    const background = hydrator.hydrate(THREAD_A, "background");
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    });

    const force = hydrator.hydrate(THREAD_A, "active", { force: true });
    await Promise.resolve();
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    expect(getTestActiveMessages()).toEqual([resident]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);

    resolveBackground({ messages: [resident, speculative], hasMore: false, narrativeByMessage: {} });
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);
    });
    expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(
      1,
      THREAD_A,
      MESSAGE_FETCH_SIZE,
    );
    expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(
      2,
      THREAD_A,
      MESSAGE_FETCH_SIZE,
    );
    expect(getTestActiveMessages()).toEqual([resident]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);

    resolveAuthoritative({ messages: [resident, authoritative], hasMore: false, narrativeByMessage: {} });
    await Promise.all([background, force]);

    expect(getTestActiveMessages()).toEqual([resident, authoritative]);
    expect(getTestActiveMessages()).not.toContainEqual(speculative);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
  });

  it("does not let late resident permission hydration replace a live request", async () => {
    let resolvePending!: (value: Array<{
      requestId: string;
      threadId: string;
      toolName: string;
      input: Record<string, never>;
    }>) => void;
    (mockTransport.listPendingPermissions as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePending = resolve;
      }),
    );
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), messages: [msgA] }],
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledWith(THREAD_A);
    });

    useThreadStore.getState().addPermissionRequest({
      requestId: "live-request",
      threadId: THREAD_A,
      toolName: "Bash",
      input: {},
    });
    resolvePending([{
      requestId: "stale-request",
      threadId: THREAD_A,
      toolName: "Read",
      input: {},
    }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useThreadStore.getState().records.get(THREAD_A)?.permissions)
      .toEqual([expect.objectContaining({ requestId: "live-request", settled: false })]);
  });

  it("preserves volatile state for a running thread on cache hit", async () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set([THREAD_A]),
      records: new Map<string, ThreadRecord>([
        [
          THREAD_A,
          {
            ...createEmptyThreadRecord(),
            streaming: "partial...",
            agentStartTime: 1234,
            toolCalls: [
              { id: "tc1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });
    // A stale snapshot — e.g. from a sidebar hover prefetch that captured
    // messages but no in-flight narration — must not clobber the live timeline.
    cacheRecord(THREAD_A, makeCachedRecord());

    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestThreadStreaming(THREAD_A)).toBe("partial...");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
    expect(getTestThreadAgentStartTime(THREAD_A)).toBe(1234);
  });

  it("does not commit stale RPC results after a cross-thread race", async () => {
    let resolveA!: (v: { messages: typeof msgA[]; hasMore: boolean; narrativeByMessage: Record<string, never> }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => {
        if (threadId === THREAD_A) {
          return new Promise((r) => {
            resolveA = r;
          });
        }
        return Promise.resolve({ messages: [msgB], hasMore: false, narrativeByMessage: {} });
      },
    );

    const loadA = hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getTestActiveMessages()).toEqual([msgB]);

    resolveA({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await loadA;

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getTestActiveMessages()).toEqual([msgB]);
  });

  it("reselects an in-flight thread immediately during A to B to A navigation", async () => {
    const resolvers = new Map<string, (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void>();
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => new Promise((resolve) => {
        resolvers.set(threadId, resolve);
      }),
    );

    const loadA = hydrator.hydrate(THREAD_A, "active");
    const loadB = hydrator.hydrate(THREAD_B, "active");
    const reselectA = hydrator.hydrate(THREAD_A, "active");

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(readActiveThreadField((record) => record.loading)).toBe(true);

    resolvers.get(THREAD_A)?.({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    resolvers.get(THREAD_B)?.({ messages: [msgB], hasMore: false, narrativeByMessage: {} });
    await Promise.all([loadA, loadB, reselectA]);

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
  });

  it("keeps the final in-flight selection during A to B to A to B navigation", async () => {
    const resolvers = new Map<string, (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void>();
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => new Promise((resolve) => {
        resolvers.set(threadId, resolve);
      }),
    );

    const loads = [
      hydrator.hydrate(THREAD_A, "active"),
      hydrator.hydrate(THREAD_B, "active"),
      hydrator.hydrate(THREAD_A, "active"),
      hydrator.hydrate(THREAD_B, "active"),
    ];

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);

    resolvers.get(THREAD_A)?.({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    resolvers.get(THREAD_B)?.({ messages: [msgB], hasMore: false, narrativeByMessage: {} });
    await Promise.all(loads);

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getTestActiveMessages()).toEqual([msgB]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
  });

  it("commits the conversation tail without waiting for snapshots or goal lookup", async () => {
    let resolveSnapshots!: (value: TurnSnapshot[]) => void;
    let resolveGoal!: (value: GoalLookupResult) => void;
    useWorkspaceStore.setState({
      threads: [
        createMockThread({ id: THREAD_A, has_file_changes: true }),
        createMockThread({ id: THREAD_B, has_file_changes: false }),
      ],
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshots = resolve;
      }),
    );
    (mockTransport.getThreadGoal as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveGoal = resolve;
      }),
    );

    const hydration = hydrator.hydrate(THREAD_A, "active");

    await vi.waitFor(() => {
      expect(getTestActiveMessages()).toEqual([msgA]);
      expect(readActiveThreadField((record) => record.loading)).toBe(false);
    });

    const goal = makeGoal();
    resolveSnapshots([{
      message_id: msgA.id,
      files_changed: ["src/a.ts"],
      thread_id: THREAD_A,
      created_at: "2026-01-01T00:00:00Z",
    } as TurnSnapshot]);
    resolveGoal({
      goal,
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    });
    await hydration;
    await vi.waitFor(() => {
      expect(readActiveThreadField((record) => record.goal)).toEqual(goal);
      expect(readActiveThreadField((record) => record.persistedFilesChanged)).toEqual({
        [msgA.id]: ["src/a.ts"],
      });
    });
  });

  it("discards deferred snapshot and goal results after their load epoch is replaced", async () => {
    let resolveSnapshots!: (value: TurnSnapshot[]) => void;
    let resolveGoal!: (value: GoalLookupResult) => void;
    useWorkspaceStore.setState({
      threads: [
        createMockThread({ id: THREAD_A, has_file_changes: true }),
        createMockThread({ id: THREAD_B, has_file_changes: false }),
      ],
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshots = resolve;
      }),
    );
    (mockTransport.getThreadGoal as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => threadId === THREAD_A
        ? new Promise((resolve) => {
            resolveGoal = resolve;
          })
        : Promise.resolve({
            goal: null,
            authoritative: false,
            source: "codex-cache",
            reason: "not-materialized",
          }),
    );

    await hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");

    resolveSnapshots([{
      message_id: msgA.id,
      files_changed: ["src/stale.ts"],
      thread_id: THREAD_A,
      created_at: "2026-01-01T00:00:00Z",
    } as TurnSnapshot]);
    resolveGoal({
      goal: makeGoal(),
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getCachedRecord(THREAD_A)).not.toHaveProperty("goal");
    expect(getCachedRecord(THREAD_A)?.persistedFilesChanged).toEqual({});
  });

  it("does not retire a loading record before rapid reselection joins its hydrate", async () => {
    let resolveA!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => threadId === THREAD_A
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({ messages: [msgB], hasMore: false, narrativeByMessage: {} }),
    );

    const loadA = hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getCachedRecord(THREAD_A)).toBeUndefined();
    const reselectA = hydrator.hydrate(THREAD_A, "active");
    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(readActiveThreadField((record) => record.loading)).toBe(true);

    resolveA({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([loadA, reselectA]);

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
  });

  it("never restores an empty snapshot after an inactive hydrate completes", async () => {
    let resolveA!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => threadId === THREAD_A
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({ messages: [msgB], hasMore: false, narrativeByMessage: {} }),
    );

    const loadA = hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reselectA = hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");

    resolveA({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([loadA, reselectA]);

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getCachedRecord(THREAD_A)).toBeUndefined();

    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [msgA],
      hasMore: false,
      narrativeByMessage: {},
    });
    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(3);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
  });

  it("discards a running thread's empty shell after a stale rapid reselection", async () => {
    let resolveA!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    resetThreadStoreForTests({
      runningThreadIds: new Set([THREAD_A]),
      records: new Map([[THREAD_A, createEmptyThreadRecord()]]),
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => threadId === THREAD_A
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({ messages: [msgB], hasMore: false, narrativeByMessage: {} }),
    );

    const loadA = hydrator.hydrate(THREAD_A, "active");
    await hydrator.hydrate(THREAD_B, "active");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reselectA = hydrator.hydrate(THREAD_A, "active");
    expect(readActiveThreadField((record) => record.loading)).toBe(true);
    await hydrator.hydrate(THREAD_B, "active");

    resolveA({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([loadA, reselectA]);

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(useThreadStore.getState().records.has(THREAD_A)).toBe(false);
    expect(getCachedRecord(THREAD_A)).toBeUndefined();

    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [msgA],
      hasMore: false,
      narrativeByMessage: {},
    });
    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(3);
    expect(getTestActiveMessages()).toEqual([msgA]);
  });

  it("keeps repeated cache-hit switches bounded without refetching loaded history", async () => {
    const tailA = Array.from({ length: 12 }, (_, index) => createMockMessage({
      id: `tail-a-${index + 89}`,
      thread_id: THREAD_A,
      sequence: index + 89,
    }));
    const tailB = Array.from({ length: 12 }, (_, index) => createMockMessage({
      id: `tail-b-${index + 89}`,
      thread_id: THREAD_B,
      sequence: index + 89,
    }));
    cacheRecord(THREAD_A, { ...makeCachedRecord(tailA), hasMoreMessages: true });
    cacheRecord(THREAD_B, { ...makeCachedRecord(tailB), hasMoreMessages: true });
    for (let index = 0; index < 20; index++) {
      await hydrator.hydrate(index % 2 === 0 ? THREAD_A : THREAD_B, "active");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual(tailB.slice(-MESSAGE_FETCH_SIZE));
    expect(hasPrefetchedHistoryPage(THREAD_B, 99)).toBe(true);

    await useThreadStore.getState().loadOlderMessages(THREAD_B);

    expect(getTestActiveMessages()).toEqual(tailB);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual(tailA.slice(-MESSAGE_FETCH_SIZE));
    expect(hasPrefetchedHistoryPage(THREAD_A, 99)).toBe(true);
  });

  it("background mode populates cache without touching the live store", async () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      records: new Map<string, ThreadRecord>([
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "background");

    expect(getCachedRecord(THREAD_A)?.messages).toEqual([msgA]);
    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_B);
    expect(getTestActiveMessages()).toEqual([msgB]);
  });

  it("uses the bounded tail loader only for active first-paint fetches", async () => {
    const tailLoader = vi.fn().mockResolvedValue({ messages: [msgA], hasMore: false });
    mockTransport.loadConversationTail = tailLoader;

    try {
      resetThreadStoreForTests({
        currentThreadId: THREAD_B,
        records: new Map<string, ThreadRecord>([
          [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
        ]),
      });

      await hydrator.hydrate(THREAD_A, "background");

      expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(
        THREAD_A,
        MESSAGE_FETCH_SIZE,
      );
      expect(tailLoader).not.toHaveBeenCalled();

      clearRecordCache();
      resetThreadStoreForTests({ currentThreadId: null, records: new Map() });
      hydrator = createStoreHydrator();

      await hydrator.hydrate(THREAD_A, "active");

      expect(tailLoader).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
      expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(
        2,
        THREAD_A,
        MESSAGE_FETCH_SIZE,
      );
    } finally {
      mockTransport.loadConversationTail = undefined;
    }
  });

  it("commits attachment metadata from the first-paint tail to the active record and cache", async () => {
    const attachment = {
      id: "attachment-1",
      name: "preview.png",
      mimeType: "image/png",
      sizeBytes: 128,
    };
    const tailMessage = createMockMessage({
      id: "tail-attachment-message",
      thread_id: THREAD_A,
      content: "Image attached",
      sequence: 1,
      attachments: [attachment],
    });
    delete tailMessage.tool_calls;
    delete tailMessage.files_changed;
    const tailLoader = vi.fn().mockResolvedValue({ messages: [tailMessage], hasMore: false });
    mockTransport.loadConversationTail = tailLoader;

    try {
      await hydrator.hydrate(THREAD_A, "active");

      expect(getTestActiveMessages()).toEqual([expect.objectContaining({
        id: "tail-attachment-message",
        attachments: [attachment],
      })]);
      expect(getCachedRecord(THREAD_A)?.messages).toEqual([expect.objectContaining({
        id: "tail-attachment-message",
        attachments: [attachment],
      })]);
    } finally {
      mockTransport.loadConversationTail = undefined;
    }
  });

  it("does not let an invalidated tail follow-up overwrite newer cached messages", async () => {
    const staleTail = createMockMessage({
      id: "stale-tail-message",
      thread_id: THREAD_A,
      content: "stale tail",
      sequence: 1,
    });
    const freshCachedMessage = createMockMessage({
      id: "fresh-cached-message",
      thread_id: THREAD_A,
      content: "fresh cached message",
      sequence: 2,
    });
    let resolveFollowup!: (value: {
      messages: typeof staleTail[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    const tailLoader = vi.fn().mockResolvedValue({
      messages: [staleTail],
      hasMore: false,
    });
    mockTransport.loadConversationTail = tailLoader;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveFollowup = resolve;
      }),
    );

    try {
      const hydration = hydrator.hydrate(THREAD_A, "active");
      await vi.waitFor(() => expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(
        THREAD_A,
        MESSAGE_FETCH_SIZE,
      ));

      hydrator.invalidateConversation(THREAD_A);
      cacheRecord(THREAD_A, makeCachedRecord([freshCachedMessage]));
      resolveFollowup({ messages: [staleTail], hasMore: false, narrativeByMessage: {} });
      await hydration;

      expect(getCachedRecord(THREAD_A)?.messages).toEqual([freshCachedMessage]);
    } finally {
      mockTransport.loadConversationTail = undefined;
    }
  });

  it("does not let a background prefetch replace an inactive WebSocket update", async () => {
    const staleMessage = createMockMessage({
      id: "stale-prefetch-message",
      thread_id: THREAD_A,
      content: "stale prefetch response",
      sequence: 1,
    });
    let resolvePage!: (value: {
      messages: typeof staleMessage[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      records: new Map<string, ThreadRecord>([
        [THREAD_A, createEmptyThreadRecord()],
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });

    const backgroundHydrate = hydrator.hydrate(THREAD_A, "background");
    await vi.waitFor(() => expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(
      THREAD_A,
      MESSAGE_FETCH_SIZE,
    ));

    useThreadStore.getState().handleAgentEvent({
      type: "message",
      threadId: THREAD_A,
      content: "fresh WebSocket response",
      messageId: "resident-websocket-message",
      tokens: null,
    } satisfies AgentEvent);
    clearRecordCache();
    resolvePage({ messages: [staleMessage], hasMore: false, narrativeByMessage: {} });
    await backgroundHydrate;

    expect(getCachedRecord(THREAD_A)?.messages).toEqual([
      expect.objectContaining({ id: "resident-websocket-message", content: "fresh WebSocket response" }),
      staleMessage,
    ]);

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual([
      expect.objectContaining({ id: "resident-websocket-message", content: "fresh WebSocket response" }),
      staleMessage,
    ]);
  });

  it("does not let an active hydration replace a live message", async () => {
    const staleMessage = createMockMessage({
      id: "stale-active-response",
      thread_id: THREAD_A,
      content: "stale active response",
      sequence: 1,
    });
    let resolvePage!: (value: {
      messages: typeof staleMessage[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const activeHydrate = hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1));

    useThreadStore.getState().handleAgentEvent({
      type: "message",
      threadId: THREAD_A,
      content: "live response",
      messageId: "live-active-message",
      tokens: null,
    } satisfies AgentEvent);
    resolvePage({ messages: [staleMessage], hasMore: false, narrativeByMessage: {} });
    await activeHydrate;

    expect(getTestActiveMessages()).toEqual([
      expect.objectContaining({ id: "live-active-message", content: "live response" }),
    ]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
  });

  it("invalidates pending hydration when a workspace switch clears selection", async () => {
    const staleMessage = createMockMessage({
      id: "stale-after-workspace-switch",
      thread_id: THREAD_A,
      content: "stale after workspace switch",
      sequence: 1,
    });
    let resolvePage!: (value: {
      messages: typeof staleMessage[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a", activeThreadId: THREAD_A });

    const activeHydrate = hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1));

    useWorkspaceStore.getState().setActiveWorkspace("workspace-b", undefined, false);
    resolvePage({ messages: [staleMessage], hasMore: false, narrativeByMessage: {} });
    await activeHydrate;

    expect(useWorkspaceStore.getState().activeThreadId).toBeNull();
    expect(useThreadStore.getState().currentThreadId).toBeNull();
    expect(useThreadStore.getState().records.get(THREAD_A)?.messages).not.toEqual([staleMessage]);
  });

  it("restores a live message from the synchronized cache without a fetch", async () => {
    const resident = createMockMessage({
      id: "resident-before-eviction",
      thread_id: THREAD_A,
      content: "resident before eviction",
      sequence: 1,
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      records: new Map<string, ThreadRecord>([[
        THREAD_A,
        { ...makeCachedRecord([resident]), loadEpoch: 1 },
      ]]),
    });
    cacheRecord(THREAD_A, makeCachedRecord([resident]));
    useThreadStore.getState().handleAgentEvent({
      type: "message",
      threadId: THREAD_A,
      content: "live cached message",
      messageId: "live-cached-message",
      tokens: null,
    } satisfies AgentEvent);
    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "live-cached-message", content: "live cached message" }),
    ]));
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("commits messages and narrative from one conversation page fetch", async () => {
    const assistant = createMockMessage({
      id: "asst-1",
      thread_id: THREAD_A,
      role: "assistant",
      sequence: 2,
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [msgA, assistant],
      hasMore: false,
      narrativeByMessage: {
        "asst-1": { tools: [], thoughts: [], hooks: [] },
      },
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
    expect(mockTransport.loadTurn).not.toHaveBeenCalled();
    expect(mockTransport.listNarrative).not.toHaveBeenCalled();
    expect(readActiveThreadField((r) => r.narrativeByMessage["asst-1"])).toEqual({
      tools: [],
      thoughts: [],
      hooks: [],
    });
  });

  it("coalesces duplicate active cache-miss hydrates for one thread", async () => {
    let resolvePage!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    const first = hydrator.hydrate(THREAD_A, "active");
    const second = hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    resolvePage({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([first, second]);

    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([msgA]);
  });

  it("reuses an in-flight background prefetch when the same thread becomes active", async () => {
    let resolvePage!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    const background = hydrator.hydrate(THREAD_A, "background");
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    });

    const active = hydrator.hydrate(THREAD_A, "active");
    await Promise.resolve();

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(readActiveThreadField((record) => record.loading)).toBe(true);
    expect(getTestThreadLoadEpoch(THREAD_A)).toBe(0);

    resolvePage({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([background, active]);

    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([msgA]);
  });

  it("keeps a resident layer visible while reusing an in-flight background prefetch", async () => {
    const resident = createMockMessage({
      id: "resident-a",
      thread_id: THREAD_A,
      content: "resident message",
      sequence: 1,
    });
    const refreshed = createMockMessage({
      id: "refreshed-a",
      thread_id: THREAD_A,
      content: "refreshed message",
      sequence: 2,
    });
    let resolvePage!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    resetThreadStoreForTests({
      currentThreadId: THREAD_B,
      records: new Map<string, ThreadRecord>([
        [THREAD_A, { ...createEmptyThreadRecord(), messages: [resident] }],
        [THREAD_B, { ...createEmptyThreadRecord(), messages: [msgB] }],
      ]),
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const background = hydrator.hydrate(THREAD_A, "background");
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    });

    const active = hydrator.hydrate(THREAD_A, "active");
    await Promise.resolve();

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(getTestActiveMessages()).toEqual([resident]);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    resolvePage({ messages: [refreshed], hasMore: false, narrativeByMessage: {} });
    await Promise.all([background, active]);

    expect(getTestActiveMessages()).toEqual([refreshed]);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([refreshed]);
  });

  it("bumps load epoch on each hydrate so stale pagination is discarded", async () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          THREAD_A,
          {
            ...createEmptyThreadRecord(),
            loadEpoch: 3,
            hasMoreMessages: true,
            oldestLoadedSequence: 10,
            isLoadingMore: true,
          },
        ],
      ]),
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestThreadLoadEpoch(THREAD_A)).toBe(4);
  });

  it("defers background hydration while active hydration is in flight", async () => {
    let resolveActive!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => threadId === THREAD_A
        ? new Promise((resolve) => {
            resolveActive = resolve;
          })
        : Promise.resolve({ messages: [msgB], hasMore: false, narrativeByMessage: {} }),
    );

    const active = hydrator.hydrate(THREAD_A, "active");
    await vi.waitFor(() => {
      expect(hydrator.isActiveHydrationInFlight()).toBe(true);
    });
    const background = hydrator.hydrate(THREAD_B, "background");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    resolveActive({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await Promise.all([active, background]);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_B, MESSAGE_FETCH_SIZE);
    expect(hydrator.isActiveHydrationInFlight()).toBe(false);
  });
});
