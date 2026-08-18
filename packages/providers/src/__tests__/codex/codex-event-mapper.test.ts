import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentEventSchema } from "@mcode/contracts";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";

describe("CodexEventMapper", () => {
  let mapper: CodexEventMapper;

  beforeEach(() => {
    vi.clearAllMocks();
    mapper = new CodexEventMapper("test-thread");
  });

  // ---------------------------------------------------------------------------
  // Lifecycle / silently-consumed notifications
  // ---------------------------------------------------------------------------

  it("returns empty array for turn/started", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {},
    });
    expect(events).toEqual([]);
  });

  it("maps native goal updates into goal state events", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "thread/goal/updated",
      params: {
        threadId: "codex-thread",
        turnId: "turn-1",
        goal: {
          threadId: "codex-thread",
          objective: "ship the release",
          status: "active",
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 5,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "goalUpdated",
        threadId: "test-thread",
        goal: expect.objectContaining({
          threadId: "test-thread",
          objective: "ship the release",
          status: "active",
          providerId: "codex",
          source: "codex",
          turnId: "turn-1",
          controls: { canInspect: true, canClear: true },
        }),
      },
    ]);
  });

  it("maps native goal completion into state, receipt, and clear events", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "thread/goal/updated",
      params: {
        threadId: "codex-thread",
        turnId: "turn-1",
        goal: {
          threadId: "codex-thread",
          objective: "ship the release",
          status: "complete",
          tokenBudget: null,
          tokensUsed: 25,
          timeUsedSeconds: 19,
          createdAt: 1,
          updatedAt: 20,
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "goalUpdated",
        threadId: "test-thread",
        goal: expect.objectContaining({ status: "complete" }),
      }),
      {
        type: "message",
        threadId: "test-thread",
        content: "Goal achieved in 19s.",
        tokens: null,
      },
      {
        type: "goalCleared",
        threadId: "test-thread",
        providerId: "codex",
        reason: "completed",
        turnId: "turn-1",
      },
    ]);
  });

  it("maps native goal clear notifications", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "thread/goal/cleared",
      params: {
        threadId: "codex-thread",
        turnId: "turn-1",
      },
    });

    expect(events).toEqual([
      {
        type: "goalCleared",
        threadId: "test-thread",
        providerId: "codex",
        reason: "cleared",
        turnId: "turn-1",
      },
    ]);
  });

  it("maps MCP server startup status notifications", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "codex-thread",
        name: "figma-dev-mode",
        status: "failed",
        error: "connection refused",
        failureReason: "optional server unavailable",
      },
    });

    expect(events).toEqual([
      {
        type: "mcpServerStartupStatus",
        threadId: "test-thread",
        providerId: "codex",
        serverThreadId: "codex-thread",
        name: "figma-dev-mode",
        status: "failed",
        error: "connection refused",
        failureReason: "optional server unavailable",
      },
    ]);
  });

  it("normalizes the legacy MCP startup error status to schema-valid failed", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "codex-thread",
        name: "mcode_internal_thread_control",
        status: "error",
        error: "connection refused",
      },
    } as never);

    expect(events).toEqual([
      {
        type: "mcpServerStartupStatus",
        threadId: "test-thread",
        providerId: "codex",
        serverThreadId: "codex-thread",
        name: "mcode_internal_thread_control",
        status: "failed",
        error: "connection refused",
      },
    ]);
    expect(AgentEventSchema().parse(events[0])).toEqual(events[0]);
  });

  it("maps golden MCP startup status without native thread id and null error into schema-safe event", () => {
    mapper = new CodexEventMapper("test-thread", "codex-thread");

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "figma-dev-mode",
        status: "ready",
        error: null,
      },
    });

    expect(events).toEqual([
      {
        type: "mcpServerStartupStatus",
        threadId: "test-thread",
        providerId: "codex",
        serverThreadId: "codex-thread",
        name: "figma-dev-mode",
        status: "ready",
      },
    ]);
    expect(AgentEventSchema().parse(events[0])).toEqual(events[0]);
  });

  it("emits Agent toolUse for item/started collabAgentToolCall", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "t",
        turnId: "u",
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          prompt: "Review security",
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "collab-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawnAgent", prompt: "Review security" },
    });
  });

  it("carries receiver-thread and native child-turn evidence without name matching", () => {
    mapper = new CodexEventMapper("test-thread", "parent-native");
    const parent = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "parent-native",
        item: {
          type: "collabAgentToolCall",
          id: "collab-structural",
          tool: "spawnAgent",
          prompt: "same prompt",
          receiverThreadIds: ["child-native-a", "child-native-b"],
        },
      },
    });
    expect(parent[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "collab-structural",
      toolInput: {
        codexCollabKind: "spawnAgent",
      },
    });

    const childStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-native-b", turn: { id: "child-turn-9" } },
    });
    expect(childStarted).toEqual([expect.objectContaining({
      type: "turnStarted",
      threadId: "test-thread",
      codexChild: {
        nativeThreadId: "child-native-b",
        nativeTurnId: "child-turn-9",
        parentCollaborationItemId: "collab-structural",
        prompt: "same prompt",
        nativeEventId: expect.any(String),
      },
    })]);

    const parallelChild = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-native-a", turn: { id: "child-turn-10" } },
    });
    expect(parallelChild[0]).toMatchObject({
      codexChild: {
        nativeThreadId: "child-native-a",
        nativeTurnId: "child-turn-10",
        parentCollaborationItemId: "collab-structural",
      },
    });
    expect(parallelChild[0]).toMatchObject({
      codexChild: {
        prompt: "same prompt",
        nativeEventId: expect.any(String),
      },
    });
  });

  it("bounds child identity retention across a parent turn reset", () => {
    mapper = new CodexEventMapper("test-thread", "parent-native");
    for (let index = 0; index < 33; index += 1) {
      mapper.mapNotification({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "parent-native",
          item: {
            type: "collabAgentToolCall",
            id: `collab-bound-${index}`,
            tool: "spawnAgent",
            receiverThreadIds: [`child-bound-${index}`],
          },
        },
      });
    }

    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "parent-native", turn: { status: "completed" } },
    });

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-bound-0", turn: { id: "child-turn-0" } },
    })).toEqual([]);
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-bound-32", turn: { id: "child-turn-32" } },
    })).toEqual([expect.objectContaining({
      type: "turnStarted",
      codexChild: expect.objectContaining({
        nativeThreadId: "child-bound-32",
        nativeTurnId: "child-turn-32",
      }),
    })]);
  });

  it("buffers receiver items before the exact child turn and replays them once", () => {
    mapper = new CodexEventMapper("test-thread", "parent-native");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "parent-native",
        item: {
          type: "collabAgentToolCall",
          id: "collab-early",
          tool: "spawnAgent",
          receiverThreadIds: ["child-early", "child-bound"],
        },
      },
    });

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-early",
        item: {
          type: "commandExecution",
          id: "native-item-early",
          command: "git status",
        },
      },
    })).toEqual([]);

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-early",
        item: {
          type: "commandExecution",
          id: "native-item-early",
          command: "git status",
          aggregatedOutput: "early output",
          exitCode: 0,
        },
      },
    })).toEqual([]);

    for (let index = 0; index < 100; index += 1) {
      expect(mapper.mapNotification({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "child-bound",
          item: {
            type: "commandExecution",
            id: `native-item-bound-${index}`,
            command: "echo bound",
            aggregatedOutput: "bound",
            exitCode: 0,
          },
        },
      })).toEqual([]);
    }

    const replayed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-early", turn: { id: "native-turn-early" } },
    });
    expect(replayed[0]).toMatchObject({
      type: "turnStarted",
      codexChild: { nativeTurnId: "native-turn-early" },
    });
    expect(replayed.slice(1)).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "native-item-early",
        codexChild: expect.objectContaining({
          nativeTurnId: "native-turn-early",
          nativeItemId: "native-item-early",
          itemEventKey: "started",
        }),
      }),
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "native-item-early",
        codexChild: expect.objectContaining({
          nativeTurnId: "native-turn-early",
          nativeItemId: "native-item-early",
          itemEventKey: "completed",
        }),
      }),
    ]);
    const replayIds = replayed.map((event) => (
      "codexChild" in event ? event.codexChild?.nativeEventId : undefined
    ));
    expect(replayIds).toHaveLength(3);
    expect(replayIds.every((id): id is string => Boolean(id))).toBe(true);
    expect(new Set(replayIds).size).toBe(3);

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-early",
        item: {
          type: "commandExecution",
          id: "native-item-early",
          command: "git status",
          aggregatedOutput: "early output",
          exitCode: 0,
        },
      },
    })).toEqual([]);

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-early", turn: { id: "native-turn-early" } },
    })).toEqual([]);

    const boundedReplay = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-bound", turn: { id: "native-turn-bound" } },
    });
    expect(boundedReplay[0]).toMatchObject({ type: "turnStarted" });
    expect(boundedReplay.length).toBeLessThanOrEqual(129);
    expect(boundedReplay.length).toBeGreaterThan(1);
  });

  it("uses native item identity when equal-prefix child outputs differ", () => {
    mapper = new CodexEventMapper("test-thread", "parent-native");
    const prefix = "x".repeat(256);
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "parent-native",
        item: {
          type: "collabAgentToolCall",
          id: "collab-prefix",
          tool: "spawnAgent",
          receiverThreadIds: ["child-prefix"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-prefix", turn: { id: "turn-prefix" } },
    });
    const first = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-prefix",
        item: {
          type: "commandExecution",
          id: "native-item-prefix-a",
          command: "echo a",
          aggregatedOutput: `${prefix}a`,
          exitCode: 0,
        },
      },
    });
    const second = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-prefix",
        item: {
          type: "commandExecution",
          id: "native-item-prefix-b",
          command: "echo b",
          aggregatedOutput: `${prefix}b`,
          exitCode: 0,
        },
      },
    });
    const firstId = first.find((event) => event.type === "toolResult");
    const secondId = second.find((event) => event.type === "toolResult");
    const firstNativeEventId = firstId && "codexChild" in firstId
      ? firstId.codexChild?.nativeEventId
      : undefined;
    const secondNativeEventId = secondId && "codexChild" in secondId
      ? secondId.codexChild?.nativeEventId
      : undefined;
    expect(firstId && "codexChild" in firstId ? firstId.codexChild?.nativeItemId : undefined)
      .toBe("native-item-prefix-a");
    expect(firstId && "codexChild" in firstId ? firstId.codexChild?.itemEventKey : undefined)
      .toBe("completed");
    expect(secondId && "codexChild" in secondId ? secondId.codexChild?.nativeItemId : undefined)
      .toBe("native-item-prefix-b");
    expect(secondId && "codexChild" in secondId ? secondId.codexChild?.itemEventKey : undefined)
      .toBe("completed");
    expect(typeof firstNativeEventId).toBe("string");
    expect(typeof secondNativeEventId).toBe("string");
    expect(firstNativeEventId).not.toBe(secondNativeEventId);
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-prefix",
        item: {
          type: "commandExecution",
          id: "native-item-prefix-a",
          command: "echo a",
          aggregatedOutput: `${prefix}a`,
          exitCode: 0,
        },
      },
    })).toEqual([]);
  });

  it("emits running toolUse for item/started commandExecution", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "x" } },
    });
    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "x",
        toolName: "command_execution",
        toolInput: {},
      },
    ]);
  });

  it("emits live command start, enriched command use, then command result", () => {
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-live" } },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-live",
          command: "echo hi",
          aggregatedOutput: "hi\n",
          exitCode: 0,
        },
      },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        toolName: "command_execution",
        toolInput: {},
      },
    ]);
    expect(completed).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        toolName: "command_execution",
        toolInput: { command: "echo hi" },
      },
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        output: "hi\n",
        isError: false,
        exitCode: 0,
      },
    ]);
  });

  it("bounds streamed command output and writes the full artifact", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);

    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: { itemId: "cmd-big", delta: fullOutput },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-big",
          command: "large-output",
          exitCode: 0,
        },
      },
    });
    const result = events.find((event) => event.type === "toolResult");

    expect(result).toMatchObject({
      type: "toolResult",
      toolCallId: "cmd-big",
      outputTruncated: true,
      outputTotalBytes: Buffer.byteLength(fullOutput, "utf8"),
    });
    expect(result?.type === "toolResult" ? Buffer.byteLength(result.output, "utf8") : 0).toBe(256 * 1024);
    expect(result?.type === "toolResult" ? result.output.startsWith("A".repeat(1024)) : false).toBe(true);
    expect(result?.type === "toolResult" ? result.output.endsWith("Z".repeat(1024)) : false).toBe(true);
    expect(result?.type === "toolResult" ? existsSync(result.outputArtifactPath ?? "") : false).toBe(true);
    expect(result?.type === "toolResult" ? readFileSync(result.outputArtifactPath!, "utf8") : "").toBe(fullOutput);
  });

  it("emits only toolResult at completion when command start already had full details", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-known", command: "echo hi" } },
    });

    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-known",
          command: "echo hi",
          aggregatedOutput: "hi\n",
          exitCode: 1,
        },
      },
    });

    expect(completed).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-known",
        output: "hi\n",
        isError: true,
        exitCode: 1,
      },
    ]);
  });

  it("enriches sparse mcpToolCall start from completion details", () => {
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "mcpToolCall", id: "mcp-live" } },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          id: "mcp-live",
          server: "filesystem",
          tool: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
          result: "contents",
        },
      },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "mcp-live",
        toolName: "mcp:/unknown",
        toolInput: {},
      },
    ]);
    expect(completed[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "mcp-live",
      toolName: "mcp:filesystem/read_file",
      toolInput: { path: "README.md" },
    });
    expect(completed[1]).toEqual({
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "mcp-live",
      output: "contents",
      isError: false,
    });
  });

  it("keeps completed-only commandExecution fallback when no item/started arrived", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-fallback",
          command: "pwd",
          aggregatedOutput: "/repo\n",
          exitCode: 0,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-fallback",
        toolName: "command_execution",
        toolInput: { command: "pwd" },
      },
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-fallback",
        output: "/repo\n",
        isError: false,
        exitCode: 0,
      },
    ]);
  });

  it("streams text after completed-only commandExecution as narration until turn completion", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-fallback",
          command: "pwd",
          aggregatedOutput: "/repo\n",
          exitCode: 0,
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "Done" },
    });

    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Done",
        isFinalResponse: false,
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // item/agentMessage/delta – streaming text tokens
  // ---------------------------------------------------------------------------

  it("emits non-final textDelta for pre-tool item/agentMessage/delta", () => {
    // Codex assistant text is classified later by assistantMessageBoundary.
    const e1 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "u", itemId: "i", delta: "Hello" },
    });
    const e2 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "u", itemId: "i", delta: "!" },
    });

    expect(e1).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "Hello", isFinalResponse: false }]);
    expect(e2).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "!", isFinalResponse: false }]);
  });

  it("emits non-final textDelta for item/agentMessage/delta after tool completes", () => {
    // Even post-tool text can be followed by another tool, so only lookahead promotes it.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd1" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "cmd1", command: "echo hi", output: "hi", exitCode: 0 } },
    });
    const evt = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "Done" },
    });
    expect(evt).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "Done", isFinalResponse: false }]);
  });

  it("keeps pre-tool agentMessage delta as thought even while tools run", () => {
    // Some Codex turns interleave: preamble -> tool start -> more text -> tool complete -> final.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd1" } },
    });
    const mid = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "thinking..." },
    });
    expect(mid).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "thinking...", isFinalResponse: false }]);
  });

  it("emits Message with full accumulated text on turn/completed after deltas", () => {
    mapper.mapNotification({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Hello" } as never });
    mapper.mapNotification({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: " world" } as never });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    const msg = events.find((e) => e.type === "message");
    expect(events[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(msg).toMatchObject({ type: "message", content: "Hello world" });
  });

  it("keeps streamed text when item deltas omit ids but completion includes one", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "Legacy streamed answer" },
    });
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-with-id" } },
    })).toEqual([]);

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(events[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(events.find((event) => event.type === "message")).toMatchObject({
      type: "message",
      content: "Legacy streamed answer",
    });
  });

  it("classifies inter-tool assistant messages as narration and promotes only the last assistant item", () => {
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-1", delta: "First narration." },
    })).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "First narration.", isFinalResponse: false },
    ]);
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-1" } },
    })).toEqual([]);

    const firstTool = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-1" } },
    });
    expect(firstTool[0]).toEqual({
      type: "assistantMessageBoundary",
      threadId: "test-thread",
      isFinalResponse: false,
    });
    expect(firstTool[1]).toMatchObject({ type: "toolUse", toolCallId: "cmd-1" });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "cmd-1", command: "pwd", output: "/repo", exitCode: 0 } },
    });

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-2", delta: "Middle narration." },
    })).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Middle narration.", isFinalResponse: false },
    ]);
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-2" } },
    });

    const secondTool = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-2" } },
    });
    expect(secondTool[0]).toEqual({
      type: "assistantMessageBoundary",
      threadId: "test-thread",
      isFinalResponse: false,
    });
    expect(secondTool[1]).toMatchObject({ type: "toolUse", toolCallId: "cmd-2" });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "cmd-2", command: "ls", output: "ok", exitCode: 0 } },
    });

    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-final", delta: "Final answer only." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-final" } },
    });

    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    expect(completed[0]).toEqual({
      type: "assistantMessageBoundary",
      threadId: "test-thread",
      isFinalResponse: true,
    });
    expect(completed.find((event) => event.type === "message")).toEqual({
      type: "message",
      threadId: "test-thread",
      content: "Final answer only.",
      tokens: null,
    });
  });

  it("promotes a tool-free assistant item to final response on turn completion", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-only", delta: "Tool-free final." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-only" } },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(events[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(events.find((event) => event.type === "message")).toMatchObject({
      type: "message",
      content: "Tool-free final.",
    });
  });

  it("flushes held assistant text as non-final on failed turn", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-fail", delta: "Partial narration." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-fail" } },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "failed", error: { message: "boom" } } },
    });

    expect(events).toEqual([
      { type: "assistantMessageBoundary", threadId: "test-thread", isFinalResponse: false },
      { type: "error", threadId: "test-thread", error: "boom" },
    ]);
  });

  it("returns empty array for item/agentMessage/delta with empty delta", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "" },
    });
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // item/completed – message items (assistant text)
  // ---------------------------------------------------------------------------

  it("emits textDelta for item/completed message with output_text content", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello", isFinalResponse: false },
    ]);
  });

  it("emits textDelta for item/completed message with plain 'text' content type (codex format)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from codex" }],
        },
      },
    });
    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello from codex", isFinalResponse: false },
    ]);
  });

  it("emits delta for new text in subsequent item/completed messages", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: " world", isFinalResponse: false },
    ]);
  });

  it("returns empty array for item/completed message with no new text (same content)", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed message with no content parts", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [] },
      },
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed with no item", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {},
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed userMessage (echo of user input)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "userMessage",
          id: "msg-1",
          content: [{ type: "text", text: "hello" }],
        },
      },
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed with unrecognized item type", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "unknown_item_type" } },
    });
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // item/completed – function_call items (tool use)
  // ---------------------------------------------------------------------------

  it("emits toolUse + toolResult for function_call item", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-1",
          name: "bash",
          arguments: JSON.stringify({ command: "ls" }),
          output: "file.txt",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "call-1",
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "call-1",
      output: "file.txt",
      isError: false,
    });
  });

  it("emits update_plan toolUse with parsed plan arguments", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-update-plan",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
              { status: "in_progress", step: "Test todo item two with CODE-A2 and CODE-B2" },
              { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
            ],
          }),
          output: "",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "call-update-plan",
      toolName: "update_plan",
      toolInput: {
        plan: [
          { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
          { status: "in_progress", step: "Test todo item two with CODE-A2 and CODE-B2" },
          { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
        ],
      },
    });
  });

  it("emits update_plan toolUse from turn plan updates", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/plan/updated",
      params: {
        threadId: "codex-thread",
        turnId: "turn-live",
        explanation: "Tracking scope work",
        plan: [
          { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
          { status: "inProgress", step: "Test todo item two with CODE-A2 and CODE-B2" },
          { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
        ],
      },
    });

    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "codex-plan-turn-live-1",
        toolName: "update_plan",
        toolInput: {
          explanation: "Tracking scope work",
          plan: [
            { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
            { status: "inProgress", step: "Test todo item two with CODE-A2 and CODE-B2" },
            { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
          ],
        },
      },
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "codex-plan-turn-live-1",
        output: "Plan updated",
        isError: false,
      },
    ]);
  });

  it("handles function_call with invalid JSON arguments gracefully", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-2",
          name: "bash",
          arguments: "not valid json",
          output: "",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolInput: { arguments: "not valid json" },
    });
  });

  it("handles function_call with no output", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-3",
          name: "bash",
          arguments: "{}",
        },
      },
    });

    expect(events[1]).toMatchObject({ type: "toolResult", output: "" });
  });

  it("keeps spawnAgent row running when spawn item completes", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          prompt: "Do work",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          toolKind: "spawn_agent",
          prompt: "Do work",
          result: "Done",
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("maps native sub-agent activity and attributes child file changes", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "call-explorer",
          agentThreadId: "child-thread",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });
    const childStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread",
        item: {
          type: "fileChange",
          id: "child-edit",
          changes: [{ path: "src/example.ts", kind: "update" }],
        },
      },
    });
    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: {
          type: "fileChange",
          id: "child-edit",
          changes: [{ path: "src/example.ts", kind: "update" }],
        },
      },
    });

    expect(started).toEqual([{
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "call-explorer",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentName: "explorer",
        agentPath: "/root/explorer",
        description: "explorer",
        receiverThreadIds: ["child-thread"],
      },
    }]);
    expect(childStarted).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "child-edit",
        parentToolCallId: "call-explorer",
      }),
    ]);
    expect(childCompleted).toEqual([
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "child-edit",
      }),
    ]);
  });

  it("uses native child thread settings for sub-agent model and reasoning metadata", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");

    const settings = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "thread/settings/updated",
      params: {
        threadId: "child-metadata",
        threadSettings: { model: "gpt-5.5", effort: "high" },
      },
    });

    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "call-metadata",
          agentThreadId: "child-metadata",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });

    expect(settings).toEqual([]);
    expect(started).toEqual([{
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "call-metadata",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentName: "explorer",
        agentPath: "/root/explorer",
        description: "explorer",
        model: "gpt-5.5",
        reasoningEffort: "high",
        receiverThreadIds: ["child-metadata"],
      },
    }]);
  });

  it("updates a completed native sub-agent when child settings arrive late", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "call-late-settings",
          agentThreadId: "child-late-settings",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-late-settings", delta: "Child output is authoritative." },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-late-settings", turn: { status: "completed" } },
    });
    const settings = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "thread/settings/updated",
      params: {
        threadId: "child-late-settings",
        threadSettings: { model: "gpt-5.5", effort: "high" },
      },
    });

    expect(childCompleted).toEqual([{
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "call-late-settings",
      output: "Child output is authoritative.",
      isError: false,
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentName: "explorer",
        agentPath: "/root/explorer",
        description: "explorer",
        receiverThreadIds: ["child-late-settings"],
      },
    }]);
    expect(settings).toEqual([{
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "call-late-settings",
      output: "Child output is authoritative.",
      isError: false,
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentName: "explorer",
        agentPath: "/root/explorer",
        description: "explorer",
        model: "gpt-5.5",
        reasoningEffort: "high",
        receiverThreadIds: ["child-late-settings"],
      },
    }]);
  });

  it("emits a distinct parented lifecycle record for every native sub-agent interaction", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const activity = {
      type: "subAgentActivity",
      id: "call-explorer",
      agentThreadId: "child-thread",
      agentPath: "/root/explorer",
      kind: "started",
    };

    const first = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { threadId: "main-thread", item: activity },
    });
    const duplicate = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { threadId: "main-thread", item: activity },
    });
    const firstInteraction = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: { ...activity, kind: "interacted" },
      },
    });
    const secondInteraction = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: { ...activity, kind: "interacted" },
      },
    });
    const interactionCompletion = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: { ...activity, kind: "interacted" },
      },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "main-thread", item: activity },
    });

    expect(first).toHaveLength(1);
    expect(duplicate).toEqual([]);
    expect(firstInteraction).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolName: "__McodeSubagentLifecycle",
        parentToolCallId: "call-explorer",
        toolInput: expect.objectContaining({
          lifecycle: "updated",
          agentName: "explorer",
        }),
      }),
      expect.objectContaining({
        type: "toolResult",
        isError: false,
      }),
    ]);
    expect(firstInteraction[0]).not.toHaveProperty("toolInput.sourceAgentName");
    expect(firstInteraction[0]).not.toHaveProperty("toolInput.sourceAgentToolCallId");
    expect(secondInteraction).toHaveLength(2);
    expect(secondInteraction[0]).toMatchObject({
      type: "toolUse",
      toolName: "__McodeSubagentLifecycle",
      parentToolCallId: "call-explorer",
    });
    expect(secondInteraction[0]).not.toMatchObject({
      toolCallId: (firstInteraction[0] as { toolCallId?: string } | undefined)?.toolCallId,
    });
    expect(interactionCompletion).toEqual([]);
    expect(completed).toEqual([]);
  });

  it("uses the notification thread as the authoritative source for nested activity", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "call-explorer",
          agentThreadId: "explorer-thread",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });

    const nestedStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "explorer-thread",
        item: {
          type: "subAgentActivity",
          id: "call-implementer",
          agentThreadId: "implementer-thread",
          agentPath: "/root/implementer",
          kind: "started",
        },
      },
    });
    const interaction = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "explorer-thread",
        item: {
          type: "subAgentActivity",
          id: "call-implementer",
          agentThreadId: "implementer-thread",
          agentPath: "/root/implementer",
          kind: "interacted",
        },
      },
    });

    expect(nestedStarted).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "call-implementer",
        parentToolCallId: "call-explorer",
      }),
    ]);
    expect(interaction[0]).toEqual(expect.objectContaining({
      type: "toolUse",
      toolName: "__McodeSubagentLifecycle",
      parentToolCallId: "call-implementer",
      toolInput: expect.objectContaining({
        lifecycle: "updated",
        agentName: "implementer",
        sourceAgentName: "explorer",
        sourceAgentToolCallId: "call-explorer",
      }),
    }));
  });

  it("maps completed-only native sub-agent activity before child file changes", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const activity = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "call-explorer",
          agentThreadId: "child-thread",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });
    const childStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread",
        item: {
          type: "fileChange",
          id: "child-edit",
          changes: [{ path: "src/example.ts", kind: "update" }],
        },
      },
    });
    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: {
          type: "fileChange",
          id: "child-edit",
          changes: [{ path: "src/example.ts", kind: "update" }],
        },
      },
    });

    expect(activity).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "call-explorer",
        toolName: "Agent",
      }),
    ]);
    expect(childStarted).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "child-edit",
        parentToolCallId: "call-explorer",
      }),
    ]);
    expect(childCompleted).toEqual([
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "child-edit",
      }),
    ]);
  });

  it("does not duplicate a legacy collab row when same-ID native activity follows", () => {
    const collab = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "shared-agent",
          tool: "spawnAgent",
        },
      },
    });
    const activity = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "subAgentActivity",
          id: "shared-agent",
          agentThreadId: "child-thread",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });

    expect(collab).toEqual([
      expect.objectContaining({ type: "toolUse", toolCallId: "shared-agent", toolName: "Agent" }),
    ]);
    expect(activity).toEqual([]);
  });

  it("does not duplicate native activity when same-ID collab completion follows", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const activity = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "subAgentActivity",
          id: "shared-agent",
          agentThreadId: "child-thread",
          agentPath: "/root/explorer",
          kind: "started",
        },
      },
    });
    const collab = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "shared-agent",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
        },
      },
    });

    expect(activity).toEqual([
      expect.objectContaining({ type: "toolUse", toolCallId: "shared-agent", toolName: "Agent" }),
    ]);
    expect(collab).toEqual([]);
  });

  it("keeps native activity deduplicated after same-ID collab completion", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const activity = {
      type: "subAgentActivity",
      id: "shared-agent",
      agentThreadId: "child-thread",
      agentPath: "/root/explorer",
      kind: "started",
    };
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "main-thread", item: activity },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "shared-agent",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
        },
      },
    });

    const duplicate = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "main-thread", item: activity },
    });

    expect(duplicate).toEqual([]);
  });

  it("suppresses wait rows and completes spawnAgent from wait child state", () => {
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-1",
          tool: "spawnAgent",
          prompt: "Do work",
        },
      },
    });
    const spawnCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-1",
          tool: "spawnAgent",
          receiverThreadIds: ["child-1"],
          result: "dispatch complete",
        },
      },
    });
    const waitStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
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
        item: {
          type: "collabAgentToolCall",
          id: "wait-1",
          tool: "wait",
          receiverThreadIds: ["child-1"],
          agentsStates: {
            "child-1": { status: "completed", message: "child final" },
          },
        },
      },
    });

    expect(started).toHaveLength(1);
    expect(spawnCompleted).toEqual([]);
    expect(waitStarted).toEqual([]);
    expect(waitCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "spawn-1",
        output: "child final",
        isError: false,
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Do work",
          prompt: "Do work",
          receiverThreadIds: ["child-1"],
        },
      },
    ]);
  });

  it("keeps follow-up prompts and assistant output isolated across reused child turns", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-worker",
          tool: "spawnAgent",
          prompt: "Read the repository purpose.",
          receiverThreadIds: ["child-worker"],
        },
      },
    });
    const firstStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-worker", turn: { id: "child-turn-1" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-worker", itemId: "message-1", delta: "First answer." },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-worker", turn: { id: "child-turn-1", status: "completed" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "follow-up-worker",
          tool: "sendInput",
          prompt: "Read the README heading.",
          receiverThreadIds: ["child-worker"],
        },
      },
    });
    const secondStarted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "child-worker", turn: { id: "child-turn-2" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-worker", itemId: "message-2", delta: "Second answer." },
    });
    const secondCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-worker", turn: { id: "child-turn-2", status: "completed" } },
    });

    expect(firstStarted).toEqual([expect.objectContaining({
      type: "turnStarted",
      codexChild: expect.objectContaining({ prompt: "Read the repository purpose." }),
    })]);
    expect(secondStarted).toEqual([expect.objectContaining({
      type: "turnStarted",
      codexChild: expect.objectContaining({ prompt: "Read the README heading." }),
    })]);
    expect(secondCompleted).toContainEqual(expect.objectContaining({
      type: "message",
      content: "Second answer.",
    }));
  });

  it("passes Codex sub-agent task, model, kind, and effort metadata through the result", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-meta",
          tool: "spawnAgent",
          prompt: "Inspect mapper metadata.",
          model: "",
          reasoningEffort: "medium",
        },
      },
    });
    const spawnCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-meta",
          tool: "spawnAgent",
          prompt: "Inspect mapper metadata.",
          model: "gpt-5.5",
          reasoningEffort: "high",
          receiverThreadIds: ["child-meta"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-meta", delta: "Metadata verified." },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-meta", turn: { status: "completed" } },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "spawn-meta",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Inspect mapper metadata.",
          prompt: "Inspect mapper metadata.",
          reasoningEffort: "medium",
        },
      },
    ]);
    expect(spawnCompleted).toEqual([{
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "spawn-meta",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        description: "Inspect mapper metadata.",
        prompt: "Inspect mapper metadata.",
        model: "gpt-5.5",
        reasoningEffort: "high",
        receiverThreadIds: ["child-meta"],
      },
    }]);
    expect(childCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "spawn-meta",
        output: "Metadata verified.",
        isError: false,
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Inspect mapper metadata.",
          prompt: "Inspect mapper metadata.",
          model: "gpt-5.5",
          reasoningEffort: "high",
          receiverThreadIds: ["child-meta"],
        },
      },
    ]);
  });

  it("updates a completed spawnAgent with metadata when parent completion arrives late", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-late-meta",
          tool: "spawnAgent",
          prompt: "Inspect reverse-order metadata.",
          model: "",
          reasoningEffort: "medium",
          receiverThreadIds: ["child-late-meta"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-late-meta", delta: "Child output is authoritative." },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-late-meta", turn: { status: "completed" } },
    });
    const parentCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-late-meta",
          tool: "spawnAgent",
          prompt: "Inspect reverse-order metadata.",
          model: "gpt-5.5",
          reasoningEffort: "high",
          receiverThreadIds: ["child-late-meta"],
          result: "parent dispatch result",
        },
      },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "spawn-late-meta",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Inspect reverse-order metadata.",
          prompt: "Inspect reverse-order metadata.",
          reasoningEffort: "medium",
          receiverThreadIds: ["child-late-meta"],
        },
      },
    ]);
    expect(childCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "spawn-late-meta",
        output: "Child output is authoritative.",
        isError: false,
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Inspect reverse-order metadata.",
          prompt: "Inspect reverse-order metadata.",
          reasoningEffort: "medium",
          receiverThreadIds: ["child-late-meta"],
        },
      },
    ]);
    expect(parentCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "spawn-late-meta",
        output: "Child output is authoritative.",
        isError: false,
        toolInput: {
          codexCollabKind: "spawnAgent",
          description: "Inspect reverse-order metadata.",
          prompt: "Inspect reverse-order metadata.",
          model: "gpt-5.5",
          reasoningEffort: "high",
          receiverThreadIds: ["child-late-meta"],
        },
      },
    ]);
  });

  it("keeps exact sender and receiver identity on directional child messages", () => {
    mapper = new CodexEventMapper("test-thread", "native-parent");

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "native-parent",
        turnId: "native-parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "message-child-1",
          tool: "sendInput",
          senderThreadId: "native-parent",
          receiverThreadIds: ["native-child"],
          prompt: "Continue the audit.",
        },
      },
    });

    expect(events).toEqual([expect.objectContaining({
      type: "toolUse",
      toolCallId: "message-child-1",
      toolInput: {
        codexCollabKind: "sendInput",
        description: "Continue the audit.",
        prompt: "Continue the audit.",
        senderThreadId: "native-parent",
        receiverThreadIds: ["native-child"],
      },
    })]);
  });

  it("does not infer parent continuation from child evidence and a later main turn", () => {
    mapper = new CodexEventMapper("test-thread", "native-parent");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "native-parent",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-continue",
          tool: "spawnAgent",
          receiverThreadIds: ["native-child"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "native-child", turnId: "child-turn-1" },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "native-parent",
        turn: { id: "parent-turn-1", status: "completed" },
      },
    });
    const childAction = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "native-child",
        item: {
          type: "collabAgentToolCall",
          id: "send-parent-1",
          tool: "sendInput",
          senderThreadId: "native-child",
          receiverThreadIds: ["native-parent"],
          prompt: "Parent, continue.",
        },
      },
    });
    expect(childAction[0]).toEqual(expect.objectContaining({
      type: "toolUse",
      toolCallId: "send-parent-1",
      codexChild: expect.objectContaining({
        nativeThreadId: "native-child",
        nativeTurnId: "child-turn-1",
      }),
    }));

    const continuation = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "native-parent", turnId: "parent-turn-2" },
    });
    expect(continuation).toEqual([]);
  });

  it("does not classify an unrelated child collaboration item as parent continuation", () => {
    mapper = new CodexEventMapper("test-thread", "native-parent");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "native-parent",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-unrelated",
          tool: "spawnAgent",
          receiverThreadIds: ["native-child"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "native-child", turnId: "child-turn-1" },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "native-parent",
        turn: { id: "parent-turn-1", status: "completed" },
      },
    });

    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "native-child",
        item: {
          type: "collabAgentToolCall",
          id: "send-other-thread",
          tool: "sendInput",
          senderThreadId: "native-child",
          receiverThreadIds: ["native-other"],
          prompt: "Continue elsewhere.",
        },
      },
    });

    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "native-parent", turnId: "parent-turn-2" },
    })).toEqual([]);
  });

  it("completes spawnAgent from child turn completion before wait", () => {
    mapper = new CodexEventMapper("test-thread", "main-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: { type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
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
      params: { threadId: "child-1", delta: "child streamed final" },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-1", turn: { status: "completed" } },
    });
    const laterWait = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-thread",
        item: {
          type: "collabAgentToolCall",
          id: "wait-1",
          tool: "wait",
          agentsStates: {
            "child-1": { status: "completed", message: "later wait final" },
          },
        },
      },
    });

    expect(childCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "spawn-1",
        output: "child streamed final",
        isError: false,
        toolInput: { codexCollabKind: "spawnAgent", receiverThreadIds: ["child-1"] },
      },
    ]);
    expect(laterWait).toEqual([]);
  });

  it("completes parallel spawnAgents independently from wait states", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "collabAgentToolCall", id: "spawn-a", tool: "spawnAgent" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-a"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "collabAgentToolCall", id: "spawn-b", tool: "spawnAgent" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-b",
          tool: "spawnAgent",
          receiverThreadIds: ["child-b"],
        },
      },
    });

    const firstWait = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "wait-a",
          tool: "wait",
          agentsStates: {
            "child-b": { status: "completed", message: "B done" },
          },
        },
      },
    });
    const secondWait = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "wait-b",
          tool: "wait",
          agentsStates: {
            "child-a": { status: "completed", message: "A done" },
          },
        },
      },
    });

    expect(firstWait).toEqual([
      expect.objectContaining({ type: "toolResult", toolCallId: "spawn-b", output: "B done" }),
    ]);
    expect(secondWait).toEqual([
      expect.objectContaining({ type: "toolResult", toolCallId: "spawn-a", output: "A done" }),
    ]);
  });

  it("does not synthesize spawnAgent results on parent turn completion", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "spawn-open",
          tool: "spawnAgent",
          receiverThreadIds: [],
        },
      },
    });
    const finalText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { itemId: "msg-final", delta: "Final after rejected spawn." },
    });
    const finalItem = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-final" } },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(finalText).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Final after rejected spawn.",
        isFinalResponse: false,
      },
    ]);
    expect(finalItem).toEqual([]);
    expect(events.find((event) => event.type === "toolResult" && event.toolCallId === "spawn-open")).toBeUndefined();
    expect(events[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(events.find((event) => event.type === "message")).toMatchObject({
      type: "message",
      content: "Final after rejected spawn.",
    });
    expect(events.some((event) => event.type === "turnComplete")).toBe(true);
  });

  it("nests commandExecution on Codex receiver thread via receiverThreadIds", () => {
    mapper = new CodexEventMapper("test-thread", "parent-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "parent-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent", prompt: "x" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-1"],
          result: "ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-1",
        item: {
          type: "commandExecution",
          id: "cmd-child",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-child",
      parentToolCallId: "collab-a",
    });
  });

  it("replays an early child file mutation after its receiver thread is registered", () => {
    mapper = new CodexEventMapper("test-thread", "parent-thread");
    const earlyStart = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread-early",
        item: {
          type: "fileChange",
          id: "file-child",
          changes: [{ path: "src/child.ts", kind: "edit" }],
        },
      },
    });
    const earlyCompletion = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-early",
        item: {
          type: "fileChange",
          id: "file-child",
          changes: [{ path: "src/child.ts", kind: "edit" }],
        },
      },
    });

    const registered = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-early",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-early"],
          result: "spawned",
        },
      },
    });

    expect(earlyStart).toEqual([]);
    expect(earlyCompletion).toEqual([]);
    expect(registered).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "collab-early",
      }),
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "file-child",
        toolName: "file_change",
        parentToolCallId: "collab-early",
      }),
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "file-child",
      }),
    ]);
  });

  it("drops an unrelated unknown-thread notification instead of replaying it", () => {
    mapper = new CodexEventMapper("test-thread", "parent-thread");
    const unknown = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "unrelated-thread",
        item: {
          type: "commandExecution",
          id: "unrelated-command",
          command: "git status",
        },
      },
    });

    const registered = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-unrelated",
          tool: "spawnAgent",
          receiverThreadIds: ["unrelated-thread"],
          result: "spawned",
        },
      },
    });

    expect(unknown).toEqual([]);
    expect(registered).toEqual([
      expect.objectContaining({ type: "toolUse", toolCallId: "collab-unrelated" }),
    ]);
  });

  it("nests commandExecution under inner collab on a nested receiver thread (two-level sub-agents)", () => {
    mapper = new CodexEventMapper("test-thread", "parent-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "parent-thread",
        item: { type: "collabAgentToolCall", id: "collab-outer", tool: "spawnAgent", prompt: "outer" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-outer",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-1"],
          result: "outer ok",
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread-1",
        item: { type: "collabAgentToolCall", id: "collab-inner", tool: "spawnAgent", prompt: "inner" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-inner",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-2"],
          result: "inner ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-2",
        item: {
          type: "commandExecution",
          id: "cmd-deep",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-deep",
      parentToolCallId: "collab-inner",
    });
  });

  it("nests commandExecution under open collab via parentToolCallId", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: { type: "collabAgentToolCall", id: "collab-p", tool: "spawnAgent", prompt: "x" },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-1",
      parentToolCallId: "collab-p",
    });
  });

  it("nests main Codex thread tools under the open parent collab", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-p", tool: "spawnAgent", prompt: "x" },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-1",
      parentToolCallId: "collab-p",
    });
  });

  it("maps legacy spawnAgent completion to a running Agent toolUse", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          toolKind: "spawn_agent",
          prompt: "Review security",
          result: "Done",
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "collab-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawn_agent", prompt: "Review security" },
    });
  });

  it("after legacy collab completion, nests later commandExecution under collab via parentToolCallId", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-legacy",
          tool: "spawnAgent",
          prompt: "Work",
          result: "ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-after-legacy",
          command: "git status",
          aggregatedOutput: "clean",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-after-legacy",
      parentToolCallId: "collab-legacy",
    });
  });

  // ---------------------------------------------------------------------------
  // turn/completed
  // ---------------------------------------------------------------------------

  it("emits message + turnComplete for turn/completed when text was accumulated", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "test-thread",
        turn: { status: "completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 20 } },
      },
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "assistantMessageBoundary",
      threadId: "test-thread",
      isFinalResponse: true,
    });
    expect(events[1]).toEqual({
      type: "message",
      threadId: "test-thread",
      content: "Hello world",
      tokens: null,
    });
    expect(events[2]).toEqual({
      type: "turnComplete",
      threadId: "test-thread",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 10,
      tokensOut: 20,
      cacheReadTokens: 5,
      providerId: "codex",
      contextWindow: undefined,
      totalProcessedTokens: 35,
    });
  });

  it("omits message event in turn/completed when no text was accumulated", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } },
    });

    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(events.some((e) => e.type === "turnComplete")).toBe(true);
  });

  it("resets text accumulator after turn/completed", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "First" }] },
      },
    });
    mapper.mapNotification({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });

    // Second turn: text accumulator should be empty
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("emits error event for turn/completed with status failed", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "test-thread",
        turn: {
          status: "failed",
          error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      threadId: "test-thread",
      error: "You've hit your usage limit",
    });
  });

  it("falls back to generic error message when turn/completed failed has no error.message", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
  });

  // ---------------------------------------------------------------------------
  // error notification
  // ---------------------------------------------------------------------------

  it("emits error event for error notification", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "error",
      params: { error: { message: "rate limit exceeded" } },
    });

    expect(events).toEqual([
      { type: "error", threadId: "test-thread", error: "rate limit exceeded" },
    ]);
  });

  it("emits fallback message for error notification with no message field", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "error",
      params: {},
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", threadId: "test-thread" });
  });

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  it("reset() clears the text accumulator", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    mapper.reset();

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    // After reset the accumulator is empty, so "Hello" is emitted as a full delta
    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello", isFinalResponse: false },
    ]);
  });

  it("maps item/plan/delta to non-final text deltas (live planning / thinking stream)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/plan/delta",
      params: { threadId: "t1", turnId: "u1", itemId: "p1", delta: "Checking repo layout…" },
    } as never);
    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Checking repo layout…",
        isFinalResponse: false,
      },
    ]);
  });

  it("maps reasoning stream notifications to non-final text deltas", () => {
    const eSummary = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/summaryTextDelta",
      params: { delta: "Plan: " },
    } as never);
    const eText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { text: "step 1" },
    } as never);
    expect(eSummary).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Plan: ", isFinalResponse: false },
    ]);
    expect(eText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "step 1", isFinalResponse: false },
    ]);
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/summaryPartAdded",
      params: {},
    } as never)).toEqual([]);
  });

  it("emits non-final textDelta for item/completed reasoning item (summary + content)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "reasoning", id: "r1", summary: ["Plan step 1", "Plan step 2"], reasoningContent: ["Raw detail"] },
      },
    });
    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Plan step 1\nPlan step 2\nRaw detail",
        isFinalResponse: false,
      },
    ]);
  });

  it("dedupes item/completed reasoning against streamed reasoning deltas", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "Hello" },
    } as never);
    const rest = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "reasoning", summary: ["Hello world"], content: [] },
      },
    } as never);
    expect(rest).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: " world", isFinalResponse: false },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Thread-scoped routing
  // ---------------------------------------------------------------------------

  it("treats notifications with no thread id as main-thread notifications", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");

    const delta = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "main text" },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(delta).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "main text", isFinalResponse: false }]);
    expect(completed[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(completed.some((event) => event.type === "turnComplete")).toBe(true);
  });

  it("drops unknown-thread notifications before they mutate main turn state", async () => {
    const { logger } = await import("@mcode/shared");
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");

    const unknown = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "stray-thread",
        item: { type: "commandExecution", id: "cmd-stray", command: "pwd", aggregatedOutput: "x", exitCode: 0 },
      },
    });
    const main = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(unknown).toEqual([]);
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ type: "turnComplete" });
    expect(logger.warn).toHaveBeenCalledWith(
      "CodexEventMapper: dropping unknown-thread notification",
      expect.objectContaining({ method: "item/completed", notificationThreadId: "stray-thread" }),
    );
  });

  it("consumes child-thread text and reasoning without adding it to the main final reply", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });

    const childText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-thread", delta: "child private text" },
    });
    const childReasoning = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { threadId: "child-thread", delta: "child private reasoning" },
    });
    const mainText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "main-codex-thread", delta: "main final" },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(childText).toEqual([]);
    expect(childReasoning).toEqual([]);
    expect(mainText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "main final", isFinalResponse: false },
    ]);
    expect(completed[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(completed.find((event) => event.type === "message")).toMatchObject({
      type: "message",
      content: "main final",
    });
  });

  it("does not let child turn/completed reset or latch the main turn", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { status: "completed" } },
    });
    const mainText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "main-codex-thread", delta: "still streaming" },
    });
    const mainCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(childCompleted).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "collab-a",
        output: "",
        isError: false,
        toolInput: { codexCollabKind: "spawnAgent", receiverThreadIds: ["child-thread"] },
      },
    ]);
    expect(mainText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "still streaming", isFinalResponse: false },
    ]);
    expect(mainCompleted[0]).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: true });
    expect(mainCompleted.filter((event) => event.type === "turnComplete")).toHaveLength(1);
  });

  it("still maps child-thread tools under the registered sub-agent row", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: { threadId: "child-thread", itemId: "cmd-child", delta: "ok" },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: { type: "commandExecution", id: "cmd-child", command: "git status", exitCode: 0 },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "cmd-child",
        parentToolCallId: "collab-a",
      }),
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "cmd-child",
        output: "ok",
      }),
    ]);
  });

  it("bounds large sub-agent final output and writes the full artifact", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);

    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-thread", delta: fullOutput },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { status: "completed" } },
    });
    const result = events.find((event) => event.type === "toolResult");

    expect(result).toMatchObject({
      type: "toolResult",
      toolCallId: "collab-a",
      outputTruncated: true,
      outputTotalBytes: Buffer.byteLength(fullOutput, "utf8"),
    });
    expect(result?.type === "toolResult" ? Buffer.byteLength(result.output, "utf8") : 0).toBe(256 * 1024);
    expect(result?.type === "toolResult" ? existsSync(result.outputArtifactPath ?? "") : false).toBe(true);
    expect(result?.type === "toolResult" ? readFileSync(result.outputArtifactPath!, "utf8") : "").toBe(fullOutput);
  });

  // ---------------------------------------------------------------------------
  // Unrecognized notification method
  // ---------------------------------------------------------------------------

  it("returns empty array and warns for unrecognized notification method", async () => {
    const { logger } = await import("@mcode/shared");
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
    } as never);

    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "CodexEventMapper: unrecognized notification",
      expect.objectContaining({ method: "unknown/method" }),
    );
  });

  it("logs warning notifications without treating them as unrecognized", async () => {
    const { logger } = await import("@mcode/shared");
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "warning",
      params: { message: "configuration degraded", code: "config" },
    });

    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Codex warning notification",
      expect.objectContaining({
        method: "warning",
        params: { message: "configuration degraded", code: "config" },
      }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "CodexEventMapper: unrecognized notification",
      expect.anything(),
    );
  });
});
