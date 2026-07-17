import {
  resetThreadStoreForTests,
  getTestActiveMessages,
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
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import {
  clearRecordCache,
  cacheRecord,
  getCachedRecord,
} from "@/lib/thread-hydrator/record-cache";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import {
  createThreadHydrator,
  BACKGROUND_PREFETCH_LIMIT,
  HYDRATION_TTL_MS,
  MESSAGE_FETCH_SIZE,
  type ThreadHydrator,
} from "@/lib/thread-hydrator";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { coerceTaskStatus } from "@/stores/taskStore";
import { getTransport } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import type { GoalLookupResult, GoalState, TurnSnapshot } from "@mcode/contracts";

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

  beforeEach(() => {
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

  it("cache miss fetches a conversation page, commits store, and populates cache", async () => {
    await hydrator.hydrate(THREAD_A, "active");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, MESSAGE_FETCH_SIZE);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(readActiveThreadField((r) => r.loading)).toBe(false);
    expect(getCachedRecord(THREAD_A)?.messages).toEqual([msgA]);
  });

  it("commits the latest tail before prefetching earlier history", async () => {
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

    expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(1, THREAD_A, 12);
    expect(getTestActiveMessages()).toEqual(history.slice(88));

    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenNthCalledWith(2, THREAD_A, 88, 89);
      expect(getTestActiveMessages()).toEqual(history);
    });
  });

  it("resumes earlier-history hydration when a cached tail is reopened", async () => {
    const history = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `cached-a-${index + 1}`,
      thread_id: THREAD_A,
      sequence: index + 1,
    }));
    cacheRecord(THREAD_A, {
      ...makeCachedRecord(history.slice(88)),
      hasMoreMessages: true,
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: history.slice(0, 88),
      hasMore: false,
      narrativeByMessage: {},
    });

    await hydrator.hydrate(THREAD_A, "active");

    expect(getTestActiveMessages()).toEqual(history.slice(88));
    await vi.waitFor(() => {
      expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, 88, 89);
      expect(getTestActiveMessages()).toEqual(history);
    });
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
    expect(getCachedRecord(THREAD_A)?.goal).toEqual(goal);
  });

  it("clears live and cached goals when lookup returns authoritative null", async () => {
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

    expect(getCachedRecord(THREAD_A)?.goal).toBeNull();
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

  it("activates a running resident layer before its history refresh resolves", async () => {
    let resolvePage!: (value: {
      messages: typeof msgA[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
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
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const hydration = hydrator.hydrate(THREAD_A, "active");

    expect(useThreadStore.getState().currentThreadId).toBe(THREAD_A);
    expect(readActiveThreadField((record) => record.loading)).toBe(false);
    expect(getTestActiveMessages()).toEqual([msgA]);
    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, BACKGROUND_PREFETCH_LIMIT);

    resolvePage({ messages: [msgA], hasMore: false, narrativeByMessage: {} });
    await hydration;

    expect(getTestThreadStreaming(THREAD_A)).toBe("current activity");
    expect(getTestThreadToolCalls(THREAD_A)).toHaveLength(1);
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
    expect(useThreadStore.getState().records.get(THREAD_A)?.goal).toBeNull();
    expect(useThreadStore.getState().records.get(THREAD_A)?.persistedFilesChanged).toEqual({});
  });

  it("coalesces repeated cached older-history requests by thread and cursor", async () => {
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

    for (let index = 0; index < 20; index++) {
      await hydrator.hydrate(index % 2 === 0 ? THREAD_A : THREAD_B, "active");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_A, 88, 89);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(THREAD_B, 88, 89);

    const earlierA = createMockMessage({
      id: "earlier-a-88",
      thread_id: THREAD_A,
      sequence: 88,
    });
    const earlierB = createMockMessage({
      id: "earlier-b-88",
      thread_id: THREAD_B,
      sequence: 88,
    });
    resolvers.get(THREAD_A)?.({ messages: [earlierA], hasMore: false, narrativeByMessage: {} });
    resolvers.get(THREAD_B)?.({ messages: [earlierB], hasMore: false, narrativeByMessage: {} });

    await vi.waitFor(() => {
      expect(getTestActiveMessages()).toEqual([earlierB, ...tailB]);
    });
    expect(getCachedRecord(THREAD_A)?.messages).toEqual(tailA);
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
});
