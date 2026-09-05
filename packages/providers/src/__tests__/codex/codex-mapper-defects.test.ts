import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";
import { AgentEventType } from "@mcode/contracts";
import type { CompletedItem } from "../../private/codex/codex-types.js";

/**
 * Regression suite for three defects the user reported against the Codex
 * provider in production:
 *
 *  1. "thinking text is still scrolling up after it's done" — late
 *     notifications after turn/completed leak into the timeline.
 *  2. "two calls under the sub-agent not getting added to the right one"
 *     — parallel collabs mis-attribute children via LIFO peek.
 *  3. "when it's done with the two calls under it, it still gets added
 *      into the subagents" — legacy collab path never pops, coordinator
 *      work after the collab incorrectly nests beneath it.
 */
describe("CodexEventMapper defect regressions", () => {
  let mapper: CodexEventMapper;
  const tid = "test-thread";

  beforeEach(() => {
    vi.clearAllMocks();
    mapper = new CodexEventMapper(tid);
  });

  // -------------------------------------------------------------------------
  // Defect 1: trailing events after turn/completed
  // -------------------------------------------------------------------------

  it("suppresses textDelta arriving after turn/completed", () => {
    // A clean turn that ends.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {},
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    expect(completed.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnComplete)).toBe(true);

    // Late reasoning delta from the CLI must NOT emit anything.
    const late = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "stray late thought", itemId: "rs1" },
    });
    expect(late).toEqual([]);

    // Late agentMessage delta is suppressed too.
    const lateMsg = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "more late text" },
    });
    expect(lateMsg).toEqual([]);
  });

  it("prepareForTurn clears the turnEnded latch before turn/started", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    const suppressed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "blocked", itemId: "rs0" },
    });
    expect(suppressed).toEqual([]);

    mapper.prepareForTurn();
    const fresh = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "visible", itemId: "rs1" },
    });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.event.type).toBe(AgentEventType.TextDelta);
  });

  it("resumes emitting events after the next turn/started", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    // Verify suppression latched
    const suppressed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "ignored", itemId: "rs0" },
    });
    expect(suppressed).toEqual([]);

    // New turn begins
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {},
    });
    const fresh = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "fresh thought", itemId: "rs2" },
    });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.event.type).toBe(AgentEventType.TextDelta);
  });

  // -------------------------------------------------------------------------
  // Defect 2: parallel collabs — children must NOT mis-attribute via LIFO peek
  // -------------------------------------------------------------------------

  it("does not attribute a child commandExecution to the most-recently-pushed collab when 2+ collabs are open", () => {
    // Two parallel collabs dispatched in the same turn.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "collabAgentToolCall", id: "collab-A", tool: "spawnAgent" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "collabAgentToolCall", id: "collab-B", tool: "spawnAgent" } },
    });
    // A child arrives. We cannot determine its parent from the LIFO; it must
    // surface at top level rather than incorrectly nesting under collab-B.
    const childEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "cmd1", command: "echo hi", aggregatedOutput: "hi", exitCode: 0 },
      },
    });
    const toolUse = childEvents.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(toolUse).toBeDefined();
    if (toolUse?.event.type === AgentEventType.ToolUse) {
      expect(toolUse.event.parentToolCallId).toBeUndefined();
    }
  });

  it("DOES attribute child to the single open collab when exactly one is on the stack", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "collabAgentToolCall", id: "collab-only", tool: "spawnAgent" } },
    });
    const childEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "cmd2", command: "ls", aggregatedOutput: "x", exitCode: 0 },
      },
    });
    const toolUse = childEvents.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(toolUse?.event.type === AgentEventType.ToolUse && toolUse.event.parentToolCallId).toBe("collab-only");
  });

  it("does not use Mcode thread id as Codex main thread fallback", () => {
    mapper = new CodexEventMapper("mcode-thread", "codex-main");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "codex-main",
        item: { type: "collabAgentToolCall", id: "collab-main", tool: "spawnAgent" },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "mcode-thread",
        item: {
          type: "commandExecution",
          id: "cmd-wrong-thread",
          command: "git status",
          aggregatedOutput: "clean",
          exitCode: 0,
        },
      },
    });

    expect(events).toMatchObject([{ event: { type: "system", subtype: "provider.notice.unknown-event" } }]);
  });

  it("does not flush spawnAgent with empty receiverThreadIds as Sub-agent finished", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-empty",
          tool: "spawnAgent",
          receiverThreadIds: [],
          agentsStates: {},
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-final", delta: "Final response." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-final" } },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolResult && runtimeEvent.event.toolCallId === "spawn-empty")).toBeUndefined();
    expect(events[0]!.event).toMatchObject({ type: AgentEventType.AssistantMessageBoundary, isFinalResponse: true });
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Message)?.event).toMatchObject({
      type: AgentEventType.Message,
      content: "Final response.",
    });
  });

  it("does not nest parent-thread tools under provisional spawn starts without receivers", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-empty",
          tool: "spawnAgent",
          receiverThreadIds: [],
          agentsStates: {},
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-after-empty-spawn",
          command: "git status",
          aggregatedOutput: "clean",
          exitCode: 0,
        },
      },
    });

    const toolUse = events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(toolUse?.event).toMatchObject({
      type: AgentEventType.ToolUse,
      toolCallId: "cmd-after-empty-spawn",
    });
    expect(toolUse?.event.type === AgentEventType.ToolUse ? toolUse.event.parentToolCallId : undefined).toBeUndefined();
  });

  it("keeps final assistant boundary pending across wait bookkeeping", () => {
    mapper = new CodexEventMapper(tid, "codex-main");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "codex-main",
        item: { type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "codex-main",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-1",
          tool: "spawnAgent",
          receiverThreadIds: ["child-1"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "codex-main", itemId: "msg-final", delta: "Done." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "codex-main",
        item: { type: "agentMessage", id: "msg-final" },
      },
    });

    const waitStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "codex-main",
        item: {
          type: "collabAgentToolCall",
          id: "wait-1",
          tool: "wait",
          receiverThreadIds: ["child-1"],
        },
      },
    });
    const waitCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "codex-main",
        item: {
          type: "collabAgentToolCall",
          id: "wait-1",
          tool: "wait",
          agentsStates: {
            "child-1": { status: "completed", message: "child done" },
          },
        },
      },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "codex-main", turn: { status: "completed" } },
    });

    expect(waitStarted).toEqual([]);
    expect(waitCompleted.map((runtimeEvent) => runtimeEvent.event)).toEqual([
      expect.objectContaining({
        type: AgentEventType.ToolResult,
        toolCallId: "spawn-1",
        output: "child done",
      }),
    ]);
    expect(waitCompleted[0]!.extension).toMatchObject({
      providerId: "codex",
      kind: "codex-collaboration",
      collaboration: { kind: "spawnAgent", receiverThreadIds: ["child-1"] },
    });
    expect(waitCompleted[0]).not.toHaveProperty("codexChild");
    expect(waitCompleted[0]).not.toHaveProperty("codexContinuation");
    expect(completed[0]!.event).toMatchObject({ type: AgentEventType.AssistantMessageBoundary, isFinalResponse: true });
    expect(completed.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Message)?.event).toMatchObject({
      type: AgentEventType.Message,
      content: "Done.",
    });
  });

  // -------------------------------------------------------------------------
  // Defect 3: legacy collab path must release the stack when coordinator
  // resumes, so later tools do not incorrectly attach beneath the collab.
  // -------------------------------------------------------------------------

  it("pops a legacy collab from the stack on the next coordinator item/started", () => {
    // Legacy collab: item/completed with no prior item/started.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "legacy-collab",
          tool: "spawnAgent",
          result: "done",
        } satisfies CompletedItem,
      },
    });

    // Two children fire AFTER the legacy collab completes (their
    // item/completed events). Both should nest under the legacy collab.
    const child1 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "c1", command: "echo a", aggregatedOutput: "a", exitCode: 0 },
      },
    });
    const child1Use = child1.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(child1Use?.event.type === AgentEventType.ToolUse && child1Use.event.parentToolCallId).toBe("legacy-collab");

    const child2 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "c2", command: "echo b", aggregatedOutput: "b", exitCode: 0 },
      },
    });
    const child2Use = child2.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(child2Use?.event.type === AgentEventType.ToolUse && child2Use.event.parentToolCallId).toBe("legacy-collab");

    // Coordinator resumes: next tool fires its own item/started. This signals
    // the legacy collab is finished — it must be popped so this tool does NOT
    // attach beneath it.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "c3" } },
    });
    const coordinator = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "c3", command: "echo coord", aggregatedOutput: "coord", exitCode: 0 },
      },
    });
    const coordUse = coordinator.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse);
    expect(coordUse).toBeDefined();
    if (coordUse?.event.type === AgentEventType.ToolUse) {
      expect(coordUse.event.parentToolCallId).toBeUndefined();
    }
  });
});
