import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadOldestLoadedSequence,
  getTestThreadHasMoreMessages,
  getTestThreadIsLoadingMore,
  patchTestThreadLoadEpoch,
  getTestThreadPersistedFilesChanged,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ConversationNewerPage,
  ConversationOlderPage,
  TurnSnapshot,
} from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import {
  cacheRecord as cacheConversationRecord,
  cachePrefetchedHistoryPage,
  clearRecordCache,
  getCachedRecord,
  projectConversationCacheState,
} from "@/features/conversation/hydration/record-cache";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { mockTransport, createMockMessage } from "./mocks/transport";
import type { Message } from "@/transport";
import { rememberScrollTop } from "@/components/chat/scrollPositionMemory";
import {
  ACTIVE_CONVERSATION_MESSAGE_BYTES,
  measureConversationMessages,
} from "@/features/conversation/hydration/conversation-memory-policy";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

/** Verifies cursor-based pagination: loadOlderMessages behavior and guards. */
describe("Chat Pagination", () => {
  const threadId = "thread-1";

  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, { ...createEmptyThreadRecord() }],
      ]),
    });
    vi.clearAllMocks();
  });

  it("loadMessages sets pagination state from initial load", async () => {
    const messages = [
      createMockMessage({ id: "m1", thread_id: threadId, sequence: 51 }),
      createMockMessage({ id: "m2", thread_id: threadId, sequence: 52 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages,
      hasMore: true,
    });

await activateTestConversation(threadId);

    expect(getTestActiveMessages()).toEqual(messages);
    expect(getTestThreadOldestLoadedSequence(threadId)).toBe(51);
    expect(getTestThreadHasMoreMessages(threadId)).toBe(true);
  });

  it("loadOlderMessages prepends older messages and updates cursor", async () => {
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
      createMockMessage({ id: "m4", thread_id: threadId, sequence: 52 }),
    ];
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: initialMessages,
          oldestLoadedSequence: 51,
          hasMoreMessages: true,
        }],
      ]),
    });

    const olderMessages = [
      createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 }),
      createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: olderMessages,
      hasMore: false,
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(getTestActiveMessages()).toHaveLength(4);
    expect(getTestActiveMessages()[0].id).toBe("m1");
    expect(getTestActiveMessages()[1].id).toBe("m2");
    expect(getTestActiveMessages()[2].id).toBe("m3");
    expect(getTestActiveMessages()[3].id).toBe("m4");
    expect(getTestThreadOldestLoadedSequence(threadId)).toBe(1);
    expect(getTestThreadHasMoreMessages(threadId)).toBe(false);
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(mockTransport.getMessages).toHaveBeenCalledWith(threadId, 50, 51);
  });

  it("loadOlderMessages is a no-op when hasMore is false", async () => {
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
          oldestLoadedSequence: 1,
          hasMoreMessages: false,
        }],
      ]),
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("loadOlderMessages deduplicates concurrent calls", async () => {
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
          oldestLoadedSequence: 2,
          hasMoreMessages: true,
          isLoadingMore: true,
        }],
      ]),
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("loadOlderMessages discards results for a stale thread", async () => {
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
          oldestLoadedSequence: 2,
          hasMoreMessages: true,
        }],
      ]),
    });

    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveGetMessages = resolve; }),
    );

    const loadPromise = useThreadStore.getState().loadOlderMessages(threadId);

    getConversationResidency().invalidateConversation(threadId);
    useThreadStore.setState({ currentThreadId: "thread-other" });
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);

    resolveGetMessages({
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    await loadPromise;

    expect(getTestActiveMessages()).toHaveLength(0);
    expect(readThreadField(threadId, (r) => r.messages)).toHaveLength(1);
    expect(readThreadField(threadId, (r) => r.messages)[0]?.id).toBe("m2");
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
  });

  it("loadOlderMessages discards results when epoch changes (A->B->A switch)", async () => {
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
          oldestLoadedSequence: 2,
          hasMoreMessages: true,
          loadEpoch: 1,
        }],
      ]),
    });

    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveGetMessages = resolve; }),
    );

    const loadPromise = useThreadStore.getState().loadOlderMessages(threadId);

    getConversationResidency().invalidateConversation(threadId);
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);

    resolveGetMessages({
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    await loadPromise;

    // Stale response should be discarded - messages unchanged
    expect(getTestActiveMessages()).toHaveLength(1);
    expect(getTestActiveMessages()[0].id).toBe("m2");
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
  });

  it("lets a new thread-owned request proceed while an invalidated response is still pending", async () => {
    const resident = createMockMessage({ id: "resident", thread_id: threadId, sequence: 10 });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([[threadId, {
        ...createEmptyThreadRecord(),
        messages: [resident],
        oldestLoadedSequence: resident.sequence,
        hasMoreMessages: true,
        loadEpoch: 3,
      }]]),
    });
    const pending: Array<{
      request: Parameters<typeof mockTransport.loadOlderConversationPage>[0];
      resolve: (page: Awaited<ReturnType<typeof mockTransport.loadOlderConversationPage>>) => void;
    }> = [];
    const holdRequest = (
      request: Parameters<typeof mockTransport.loadOlderConversationPage>[0],
    ) => new Promise<Awaited<ReturnType<typeof mockTransport.loadOlderConversationPage>>>(
      (resolve) => pending.push({ request, resolve }),
    );
    (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(holdRequest)
      .mockImplementationOnce(holdRequest);

    const staleLoad = useThreadStore.getState().loadOlderMessages(threadId);
    expect(pending).toHaveLength(1);

    getConversationResidency().invalidateConversation(threadId);

    expect(readThreadField(threadId, (record) => record.messages)).toEqual([resident]);
    expect(readThreadField(threadId, (record) => record.loadEpoch)).toBe(4);
    const currentLoad = useThreadStore.getState().loadOlderMessages(threadId);
    expect(pending).toHaveLength(2);

    const stale = pending[0]!;
    stale.resolve({
      identity: stale.request,
      messages: [createMockMessage({ id: "stale", thread_id: threadId, sequence: 8 })],
      hasMore: true,
      nextCursor: { version: 1, beforeSequence: 8 },
      narrativeByMessage: {},
    });
    await staleLoad;

    expect(getTestThreadIsLoadingMore(threadId)).toBe(true);
    expect(readThreadField(threadId, (record) => record.messages)).toEqual([resident]);

    const current = pending[1]!;
    const fresh = createMockMessage({ id: "fresh", thread_id: threadId, sequence: 9 });
    current.resolve({
      identity: current.request,
      messages: [fresh],
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    });
    await currentLoad;

    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(readThreadField(threadId, (record) => record.messages)).toEqual([fresh, resident]);
  });

  it("loadOlderMessages writes async snapshot file lists into the message cache", async () => {
    const mOldId = "m-old";
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
    ];
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: initialMessages,
          oldestLoadedSequence: 51,
          hasMoreMessages: true,
          persistedFilesChanged: { m3: ["kept.ts"] },
          latestTurnWithChanges: "m3",
        }],
      ]),
    });
    cacheRecord(threadId, {
      ...createEmptyThreadRecord(),
      messages: initialMessages,
      oldestLoadedSequence: 51,
      hasMoreMessages: true,
      persistedFilesChanged: { m3: ["kept.ts"] },
      latestTurnWithChanges: "m3",
    });

    const olderMessages = [
      createMockMessage({ id: mOldId, thread_id: threadId, sequence: 1 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: olderMessages,
      hasMore: false,
    });

    const snap: TurnSnapshot = {
      id: "snap-1",
      message_id: mOldId,
      thread_id: threadId,
      ref_before: "a",
      ref_after: "b",
      files_changed: ["legacy.ts"],
      worktree_path: null,
      created_at: new Date().toISOString(),
    };
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValueOnce([snap]);

    await useThreadStore.getState().loadOlderMessages(threadId);
    expect(getTestThreadPersistedFilesChanged(threadId)[mOldId]).toEqual(["legacy.ts"]);

    const cached = getCachedRecord(threadId);
    expect(cached?.persistedFilesChanged[mOldId]).toEqual(["legacy.ts"]);
    expect(cached?.persistedFilesChanged.m3).toEqual(["kept.ts"]);
  });

  it("does not merge delayed pagination snapshots into a replacement cache", async () => {
    const olderMessage = createMockMessage({
      id: "older-message",
      thread_id: threadId,
      sequence: 1,
    });
    const replacementMessage = createMockMessage({
      id: "replacement-message",
      thread_id: threadId,
      sequence: 9,
    });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "current-message", thread_id: threadId, sequence: 2 })],
          oldestLoadedSequence: 2,
          hasMoreMessages: true,
          loadEpoch: 1,
        }],
      ]),
    });
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [olderMessage],
      hasMore: false,
    });
    let resolveSnapshots!: (snapshots: TurnSnapshot[]) => void;
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveSnapshots = resolve; }),
    );

    await useThreadStore.getState().loadOlderMessages(threadId);
    patchTestThreadLoadEpoch(threadId, 2);
    cacheRecord(threadId, {
      ...createEmptyThreadRecord(),
      messages: [replacementMessage],
      oldestLoadedSequence: replacementMessage.sequence,
      persistedFilesChanged: { "replacement-message": ["replacement.ts"] },
    });

    resolveSnapshots([{
      id: "delayed-snapshot",
      message_id: olderMessage.id,
      thread_id: threadId,
      ref_before: "before",
      ref_after: "after",
      files_changed: ["stale.ts"],
      worktree_path: null,
      created_at: new Date().toISOString(),
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getCachedRecord(threadId)?.persistedFilesChanged).toEqual({
      "replacement-message": ["replacement.ts"],
    });
    expect(getTestThreadPersistedFilesChanged(threadId)[olderMessage.id]).toBeUndefined();
  });

  it("reports snapshot reconciliation failures after loading an older page", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([[threadId, {
        ...createEmptyThreadRecord(),
        messages: [createMockMessage({ id: "resident", thread_id: threadId, sequence: 2 })],
        oldestLoadedSequence: 2,
        hasMoreMessages: true,
      }]]),
    });
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [createMockMessage({ id: "older", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    const failure = new Error("snapshot service unavailable");
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);

    await useThreadStore.getState().loadOlderMessages(threadId);
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        `[threadStore] Failed to hydrate pagination snapshots for ${threadId}:`,
        failure,
      );
    });
    warning.mockRestore();
  });

  it("does not let delayed snapshot metadata invalidate a newer page request", async () => {
    const resident = createMockMessage({ id: "resident", thread_id: threadId, sequence: 10 });
    const firstPageMessage = createMockMessage({ id: "first-page", thread_id: threadId, sequence: 8 });
    const secondPageMessage = createMockMessage({ id: "second-page", thread_id: threadId, sequence: 6 });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([[threadId, {
        ...createEmptyThreadRecord(),
        messages: [resident],
        oldestLoadedSequence: resident.sequence,
        hasMoreMessages: true,
      }]]),
    });

    let resolveSnapshots!: (snapshots: TurnSnapshot[]) => void;
    let resolveSecondPage!: (page: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ messages: [firstPageMessage], hasMore: true })
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecondPage = resolve; }));
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((resolve) => { resolveSnapshots = resolve; }))
      .mockResolvedValueOnce([]);

    await useThreadStore.getState().loadOlderMessages(threadId);
    const secondLoad = useThreadStore.getState().loadOlderMessages(threadId);
    expect(getTestThreadIsLoadingMore(threadId)).toBe(true);

    resolveSnapshots([{
      id: "delayed-snapshot",
      message_id: firstPageMessage.id,
      thread_id: threadId,
      ref_before: "before",
      ref_after: "after",
      files_changed: ["stale.ts"],
      worktree_path: null,
      created_at: new Date().toISOString(),
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getTestThreadIsLoadingMore(threadId)).toBe(true);
    expect(getTestThreadPersistedFilesChanged(threadId)[firstPageMessage.id]).toBeUndefined();

    resolveSecondPage({ messages: [secondPageMessage], hasMore: false });
    await secondLoad;

    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(getTestActiveMessages().map((message) => message.id)).toEqual([
      secondPageMessage.id,
      firstPageMessage.id,
      resident.id,
    ]);
  });

  it("loadOlderMessages resets isLoadingMore on network error", async () => {
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
          oldestLoadedSequence: 2,
          hasMoreMessages: true,
        }],
      ]),
    });

    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );

    const result = await useThreadStore.getState().loadOlderMessages(threadId);

    expect(result).toBe("failed");
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(getTestActiveMessages()).toHaveLength(1);
  });

  it("merges an RPC page with resident rows by id and sequence without duplicates", async () => {
    const residentAtSharedSequence = createMockMessage({
      id: "resident-at-shared-sequence",
      thread_id: threadId,
      content: "live owner",
      sequence: 5,
    });
    const live = createMockMessage({
      id: "live",
      thread_id: threadId,
      content: "latest live row",
      sequence: 102,
    });
    const older = createMockMessage({ id: "older", thread_id: threadId, sequence: 2 });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        messages: [residentAtSharedSequence, live],
        oldestLoadedSequence: 5,
        hasMoreMessages: true,
      }]]),
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [
        createMockMessage({ id: "live", thread_id: threadId, content: "stale persisted row", sequence: 1 }),
        createMockMessage({ id: "page-at-shared-sequence", thread_id: threadId, sequence: 5 }),
        older,
      ],
      hasMore: false,
      narrativeByMessage: {},
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith(threadId, 50, 5);
    expect(getTestActiveMessages()).toEqual([
      older,
      residentAtSharedSequence,
      live,
    ]);
  });

  it("keeps deterministic resident precedence when a warmed page overlaps pagination", async () => {
    const resident = createMockMessage({
      id: "resident",
      thread_id: threadId,
      content: "live owner",
      sequence: 10,
    });
    const duplicateIdAtEarlierSequence = createMockMessage({
      id: "same-id-older-sequence",
      thread_id: threadId,
      sequence: 2,
    });
    const oldest = createMockMessage({ id: "oldest", thread_id: threadId, sequence: 1 });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        messages: [resident],
        oldestLoadedSequence: 10,
        hasMoreMessages: true,
      }]]),
    });
    cachePrefetchedHistoryPage(threadId, 10, {
      messages: [
        createMockMessage({ id: "stale-resident", thread_id: threadId, sequence: 10 }),
        createMockMessage({ id: "same-id-older-sequence", thread_id: threadId, sequence: 3 }),
        duplicateIdAtEarlierSequence,
        oldest,
      ],
      hasMore: false,
      narrativeByMessage: {},
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual([
      oldest,
      duplicateIdAtEarlierSequence,
      resident,
    ]);
  });

  it("evicts by active byte budget without removing the visible anchor", async () => {
    const makeLargeMessage = (sequence: number) => createMockMessage({
      id: `message-${sequence}`,
      thread_id: threadId,
      sequence,
      content: "x".repeat(100_000),
    });
    const resident = Array.from({ length: 100 }, (_, index) => makeLargeMessage(index + 101));
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        messages: resident,
        oldestLoadedSequence: 101,
        newestLoadedSequence: 200,
        hasMoreMessages: true,
      }]]),
    });
    rememberScrollTop(threadId, 1_200, false, { messageId: "message-120", top: 24 });
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: Array.from({ length: 50 }, (_, index) => makeLargeMessage(index + 51)),
      hasMore: true,
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    const messages = getTestActiveMessages();
    expect(measureConversationMessages(messages)).toBeLessThanOrEqual(
      ACTIVE_CONVERSATION_MESSAGE_BYTES,
    );
    expect(messages.some((message) => message.id === "message-120")).toBe(true);
    expect(readThreadField(threadId, (record) => record.hasMoreMessages)).toBe(true);
    expect(readThreadField(threadId, (record) => record.hasNewerMessages)).toBe(true);
  });

  it("merges a late older page without replacing a live message that arrived during the load", async () => {
    const resident = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `resident-${index + 101}`,
      thread_id: threadId,
      sequence: index + 101,
    }));
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        messages: resident,
        oldestLoadedSequence: 101,
        newestLoadedSequence: 200,
        hasMoreMessages: true,
      }]]),
    });
    let resolvePage!: (page: ConversationOlderPage) => void;
    (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );

    const pending = useThreadStore.getState().loadOlderMessages(threadId);
    const request = (mockTransport.loadOlderConversationPage as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    useThreadStore.getState().handleAgentEvent({
      type: "message",
      threadId,
      content: "live response",
      messageId: "live-201",
      tokens: null,
    });
    expect(readThreadField(threadId, (record) => record.conversationRevision))
      .toBeGreaterThan(request.conversationRevision);
    expect(readThreadField(threadId, (record) => record.isLoadingMore)).toBe(true);
    await useThreadStore.getState().loadOlderMessages(threadId);
    expect(mockTransport.loadOlderConversationPage).toHaveBeenCalledOnce();
    resolvePage({
      identity: request,
      messages: Array.from({ length: 50 }, (_, index) => createMockMessage({
        id: `older-${index + 51}`,
        thread_id: threadId,
        sequence: index + 51,
      })),
      hasMore: true,
      nextCursor: { version: 1, beforeSequence: 51 },
      narrativeByMessage: {},
    });

    await pending;

    expect(getTestActiveMessages()).toContainEqual(expect.objectContaining({
      id: "older-51",
      sequence: 51,
    }));
    expect(getTestActiveMessages()).toContainEqual(expect.objectContaining({
      id: "live-201",
      content: "live response",
    }));
    expect(getTestActiveMessages()).toHaveLength(151);
  });

  it("merges a late newer page while resident live content wins the shared message identity", async () => {
    const resident = Array.from({ length: 100 }, (_, index) => createMockMessage({
      id: `resident-${index + 1}`,
      thread_id: threadId,
      sequence: index + 1,
    }));
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        messages: resident,
        oldestLoadedSequence: 1,
        newestLoadedSequence: 100,
        hasNewerMessages: true,
      }]]),
    });
    let resolvePage!: (page: ConversationNewerPage) => void;
    (mockTransport.loadNewerConversationPage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );

    const pending = useThreadStore.getState().loadNewerMessages(threadId);
    const request = (mockTransport.loadNewerConversationPage as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    useThreadStore.getState().handleAgentEvent({
      type: "message",
      threadId,
      content: "live response",
      messageId: "live-101",
      tokens: null,
    });
    expect(readThreadField(threadId, (record) => record.conversationRevision))
      .toBeGreaterThan(request.conversationRevision);
    expect(readThreadField(threadId, (record) => record.isLoadingNewer)).toBe(true);
    await useThreadStore.getState().loadNewerMessages(threadId);
    expect(mockTransport.loadNewerConversationPage).toHaveBeenCalledOnce();
    resolvePage({
      identity: request,
      messages: [
        createMockMessage({
          id: "live-101",
          thread_id: threadId,
          content: "stale persisted response",
          sequence: 101,
        }),
        ...Array.from({ length: 49 }, (_, index) => createMockMessage({
          id: `newer-${index + 102}`,
          thread_id: threadId,
          sequence: index + 102,
        })),
      ],
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    });

    await pending;

    expect(getTestActiveMessages()).toContainEqual(expect.objectContaining({
      id: "live-101",
      content: "live response",
    }));
    expect(getTestActiveMessages()).toContainEqual(expect.objectContaining({
      id: "newer-150",
      sequence: 150,
    }));
    expect(getTestActiveMessages()).toHaveLength(150);
  });
});
