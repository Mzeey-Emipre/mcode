import { createAgentModelState, type AgentItem, type AgentTurn, type Message } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { projectCanonicalMessageList } from "../canonical-message-projection";

const THREAD_ID = "canonical-child";
const TURN_ID = "canonical-turn";
const STARTED_AT = "2026-08-18T12:00:00.000Z";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "child-prompt",
    thread_id: THREAD_ID,
    role: "user",
    content: "Inspect README.md",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: STARTED_AT,
    sequence: 0,
    attachments: null,
    ...overrides,
  };
}

function turn(status: AgentTurn["status"], endedAt: string | null = null): AgentTurn {
  return {
    id: TURN_ID,
    threadId: THREAD_ID,
    status,
    trigger: { kind: "child", sourceThreadId: "parent", sourceTurnId: "parent-turn" },
    permissionMode: "full",
    providerIdentities: [],
    startedAt: STARTED_AT,
    endedAt,
    createdAt: STARTED_AT,
    updatedAt: endedAt ?? STARTED_AT,
  };
}

function item(
  id: string,
  kind: AgentItem["kind"],
  payload: Record<string, unknown>,
  createdAt: string,
  updatedAt = createdAt,
): AgentItem {
  return {
    id,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    kind,
    providerIdentities: [],
    payload,
    createdAt,
    updatedAt,
  };
}

describe("projectCanonicalMessageList", () => {
  it("projects active child reasoning and a completed tool into shared timeline inputs", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Running");
    state.items.reasoning = item(
      "reasoning",
      "reasoning",
      { projection: "codexChildReasoning", content: "Reading the file" },
      "2026-08-18T12:00:01.000Z",
    );
    state.items.call = item(
      "call",
      "tool-call",
      {
        projection: "codexChildToolCall",
        nativeItemId: "native-read",
        toolName: "Read",
        toolInput: { path: "README.md" },
      },
      "2026-08-18T12:00:02.000Z",
    );
    state.items.result = item(
      "result",
      "tool-result",
      {
        projection: "codexChildToolResult",
        nativeItemId: "native-read",
        output: "contents",
        isError: false,
      },
      "2026-08-18T12:00:03.000Z",
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message()],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection).toMatchObject({
      isAgentRunning: true,
      agentStartTime: Date.parse(STARTED_AT),
      thoughtSegments: [{ text: "Reading the file", isExplicitNonFinal: true }],
      toolCalls: [{
        id: "native-read",
        toolName: "Read",
        toolInput: { path: "README.md" },
        output: "contents",
        isError: false,
        isComplete: true,
      }],
    });
    expect(projection?.messages.map((entry) => entry.id)).toEqual(["child-prompt"]);
  });

  it("adds one terminal answer and retains the completed turn timeline", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Completed", "2026-08-18T12:00:05.000Z");
    const answer = message({
      id: "child-answer",
      role: "assistant",
      content: "ok",
      sequence: 1,
      timestamp: "2026-08-18T12:00:04.000Z",
    });
    state.items.answer = item(
      "answer",
      "message",
      { projection: "message", message: answer },
      answer.timestamp,
    );
    state.items.reasoning = item(
      "reasoning",
      "reasoning",
      { projection: "codexChildReasoning", content: "Done" },
      "2026-08-18T12:00:02.000Z",
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message(), answer],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection?.isAgentRunning).toBe(false);
    expect(projection?.messages.map((entry) => entry.id)).toEqual(["child-prompt", "child-answer"]);
    expect(projection?.thoughtSegments).toEqual([expect.objectContaining({ text: "Done" })]);
    expect(projection?.currentTurnMessageId).toBe("child-answer");
    expect(projection?.assistantResponseKeys).toEqual({
      "child-answer": `canonical-turn-response:${TURN_ID}`,
    });
  });
});
