import type { AgentItem, CanonicalAgentEventEnvelope, Message } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import { projectCanonicalMessageList } from "@/features/conversation/messages/canonical-message-projection";
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

function envelope(
  threadId: string,
  eventId: string,
  acceptedSequence: number,
  durableRevision: number,
  payload: CanonicalAgentEventEnvelope["payload"],
): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId,
      turnId: payload.type === "thread.recorded" ? undefined : "child-turn",
      ...(payload.type === "item.recorded" ? { itemId: payload.item.id } : {}),
      executionId: "child-execution",
    },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    durableRevision,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

function childAnswerItem(threadId: string, id: string, content: string): AgentItem {
  const answer: Message = {
    id: "child-answer",
    thread_id: threadId,
    role: "assistant",
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: NOW,
    sequence: 1,
    attachments: null,
  };
  return {
    id,
    threadId,
    turnId: "child-turn",
    kind: "message",
    providerIdentities: [],
    payload: { projection: "message", message: answer },
    createdAt: NOW,
    updatedAt: NOW,
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

  it("keeps one rendered child answer while canonical updates grow before completion", () => {
    const threadId = "child-thread";
    useThreadStore.setState({ currentThreadId: threadId });
    useThreadStore.getState().handleCanonicalAgentEvents(threadId, [
      threadRecorded(threadId),
      envelope(threadId, "turn-created", 2, 1, {
        type: "turn.created",
        turn: {
          id: "child-turn",
          threadId,
          status: "Pending",
          trigger: { kind: "child", sourceThreadId: "parent-thread", sourceTurnId: "parent-turn" },
          permissionMode: "full",
          providerIdentities: [],
          startedAt: null,
          endedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
      envelope(threadId, "turn-started", 3, 1, { type: "turn.started", startedAt: NOW }),
    ]);

    useThreadStore.getState().handleCanonicalAgentEvents(threadId, [
      envelope(threadId, "child-answer-first", 4, 2, {
        type: "item.recorded",
        item: childAnswerItem(threadId, "child-answer-first", "First chunk"),
      }),
    ]);
    let projection = projectCanonicalMessageList({
      threadId,
      state: useThreadStore.getState().records.get(threadId)!.canonicalAgent.state,
      messages: [],
      toolCalls: [],
      thoughtSegments: [],
    });
    expect(useThreadStore.getState().records.get(threadId)!.canonicalAgent.recoveryRequired).toBe(false);
    expect(Object.keys(useThreadStore.getState().records.get(threadId)!.canonicalAgent.state.items)).toEqual(["child-answer-first"]);
    expect(projection?.messages.map((message) => message.content)).toEqual(["First chunk"]);

    useThreadStore.getState().handleCanonicalAgentEvents(threadId, [
      envelope(threadId, "child-answer-second", 5, 3, {
        type: "item.recorded",
        item: childAnswerItem(threadId, "child-answer-second", "First chunk, second chunk"),
      }),
    ]);
    projection = projectCanonicalMessageList({
      threadId,
      state: useThreadStore.getState().records.get(threadId)!.canonicalAgent.state,
      messages: [],
      toolCalls: [],
      thoughtSegments: [],
    });
    expect(projection?.messages.map((message) => message.content)).toEqual(["First chunk, second chunk"]);

    useThreadStore.getState().handleCanonicalAgentEvents(threadId, [
      envelope(threadId, "turn-completed", 6, 4, { type: "turn.completed", endedAt: NOW }),
    ]);
    projection = projectCanonicalMessageList({
      threadId,
      state: useThreadStore.getState().records.get(threadId)!.canonicalAgent.state,
      messages: [],
      toolCalls: [],
      thoughtSegments: [],
    });
    expect(projection?.messages.map((message) => message.content)).toEqual(["First chunk, second chunk"]);
  });
});
