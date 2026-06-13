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
  HYDRATION_TTL_MS,
  MESSAGE_FETCH_SIZE,
  type ThreadHydrator,
} from "@/lib/thread-hydrator";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { coerceTaskStatus } from "@/stores/taskStore";
import { getTransport } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

const msgA = createMockMessage({ id: "a1", thread_id: THREAD_A, content: "hello A", sequence: 1 });
const msgB = createMockMessage({ id: "b1", thread_id: THREAD_B, content: "hello B", sequence: 1 });

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
