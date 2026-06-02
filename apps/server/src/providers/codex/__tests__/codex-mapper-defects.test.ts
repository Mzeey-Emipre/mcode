import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexEventMapper } from "../codex-event-mapper.js";
import { AgentEventType } from "@mcode/contracts";
import type { CompletedItem } from "../codex-types.js";

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
    expect(completed.some((e) => e.type === AgentEventType.TurnComplete)).toBe(true);

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
    expect(fresh[0]!.type).toBe(AgentEventType.TextDelta);
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
    expect(fresh[0]!.type).toBe(AgentEventType.TextDelta);
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
    const toolUse = childEvents.find((e) => e.type === AgentEventType.ToolUse);
    expect(toolUse).toBeDefined();
    if (toolUse?.type === AgentEventType.ToolUse) {
      expect(toolUse.parentToolCallId).toBeUndefined();
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
    const toolUse = childEvents.find((e) => e.type === AgentEventType.ToolUse);
    expect(toolUse?.type === AgentEventType.ToolUse && toolUse.parentToolCallId).toBe("collab-only");
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
    const child1Use = child1.find((e) => e.type === AgentEventType.ToolUse);
    expect(child1Use?.type === AgentEventType.ToolUse && child1Use.parentToolCallId).toBe("legacy-collab");

    const child2 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "commandExecution", id: "c2", command: "echo b", aggregatedOutput: "b", exitCode: 0 },
      },
    });
    const child2Use = child2.find((e) => e.type === AgentEventType.ToolUse);
    expect(child2Use?.type === AgentEventType.ToolUse && child2Use.parentToolCallId).toBe("legacy-collab");

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
    const coordUse = coordinator.find((e) => e.type === AgentEventType.ToolUse);
    expect(coordUse).toBeDefined();
    if (coordUse?.type === AgentEventType.ToolUse) {
      expect(coordUse.parentToolCallId).toBeUndefined();
    }
  });
});
