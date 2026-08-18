import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import { resetThreadStoreForTests } from "./thread-store-test-utils";
import { useThreadStore } from "./threadStore";

const loadConversationPage = vi.hoisted(() => vi.fn());

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => ({
    loadConversationPage,
  }),
}));

const NOW = "2026-08-14T12:00:00.000Z";

function threadRecorded(threadId: string): CanonicalAgentEventEnvelope {
  return {
    eventId: `thread-${threadId}`,
    routing: { threadId, executionId: `execution-${threadId}` },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload: {
      type: "thread.recorded",
      thread: {
        id: threadId,
        workspaceId: "workspace-1",
        rootThreadId: threadId,
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 1,
        rosterRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  };
}

describe("canonical agent event residency guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConversationPage.mockResolvedValue({ messages: [], hasMore: false, narrativeByMessage: {} });
    resetThreadStoreForTests({ currentThreadId: null, records: new Map() });
  });

  it("rejects a late child push after its display lease is released", () => {
    const threadId = "child-released";
    const residency = getConversationResidency();

    residency.mountDisplayConversation(threadId);
    residency.unmountDisplayConversation(threadId);
    useThreadStore.getState().handleCanonicalAgentEvents(threadId, [threadRecorded(threadId)]);

    expect(useThreadStore.getState().records.has(threadId)).toBe(false);
  });

  it("accepts canonical events for selected and leased transcripts", () => {
    const selectedThreadId = "selected-thread";
    useThreadStore.setState({ currentThreadId: selectedThreadId });
    useThreadStore.getState().handleCanonicalAgentEvents(
      selectedThreadId,
      [threadRecorded(selectedThreadId)],
    );

    const leasedThreadId = "leased-thread";
    const residency = getConversationResidency();
    residency.mountDisplayConversation(leasedThreadId);
    useThreadStore.getState().handleCanonicalAgentEvents(
      leasedThreadId,
      [threadRecorded(leasedThreadId)],
    );

    expect(useThreadStore.getState().records.has(selectedThreadId)).toBe(true);
    expect(useThreadStore.getState().records.has(leasedThreadId)).toBe(true);
    residency.unmountDisplayConversation(leasedThreadId);
  });

  it("refreshes a leased canonical child through the resident projection path", async () => {
    const parentThreadId = "parent-thread";
    const childThreadId = "leased-child";
    useThreadStore.setState({ currentThreadId: parentThreadId });
    const residency = getConversationResidency();
    await residency.mountDisplayConversation(childThreadId);
    loadConversationPage.mockClear();

    useThreadStore.getState().handleCanonicalAgentEvents(
      childThreadId,
      [threadRecorded(childThreadId)],
    );

    await vi.waitFor(() => expect(loadConversationPage).toHaveBeenCalledWith(childThreadId, expect.any(Number)));
    residency.unmountDisplayConversation(childThreadId);
  });
});
