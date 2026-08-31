import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Client, ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import { AcpSessionRuntime } from "../../../protocols/acp/acp-session-runtime.js";
import { CursorAcpClientBridge } from "../cursor-acp-client-bridge.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
} from "../cursor-acp-event-mapper.js";
import { resolveCursorAssistantMessageContent } from "../../stream-json/cursor-stream-event-mapper.js";

function fakeChild(): NodeChildProcess.ChildProcess {
  return Object.assign(new NodeEvents.EventEmitter(), {
    kill: vi.fn(() => true),
    pid: 1234,
  }) as unknown as NodeChildProcess.ChildProcess;
}

describe("mapCursorAcpSessionNotification", () => {
  const threadId = "t1";

  it("maps agent text chunks to TextDelta and accumulates assistant text", () => {
    const state = createCursorAcpTurnState();
    const ev1 = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hi" },
        },
      },
      threadId,
      state,
    );
    expect(ev1).toEqual([
      { type: AgentEventType.TextDelta, threadId, delta: "Hi" },
    ]);
    const ev2 = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " there" },
        },
      },
      threadId,
      state,
    );
    expect(ev2[0]).toMatchObject({ delta: " there" });
    expect(state.accumulator.assistantText).toBe("Hi there");
  });

  it("accumulates assistantFinalText only for message chunks after a tool resolves", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Before " },
        },
      },
      threadId,
      state,
    );
    expect(state.accumulator.assistantFinalText).toBe("");
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Shell",
          rawInput: { shellToolCall: { args: { command: "ls" } } },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          rawInput: {
            shellToolCall: {
              args: { command: "ls" },
              result: { success: "ok" },
            },
          },
        },
      },
      threadId,
      state,
    );
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "After" },
        },
      },
      threadId,
      state,
    );
    expect(state.accumulator.assistantText).toBe("Before After");
    expect(state.accumulator.assistantFinalText).toBe("After");
    expect(resolveCursorAssistantMessageContent(state.accumulator)).toBe("After");
  });

  it("suppresses agent_thought_chunk so thinking data never leaks to the UI", () => {
    const state = createCursorAcpTurnState();
    const ev = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking out loud..." },
        },
      },
      threadId,
      state,
    );
    expect(ev).toEqual([]);
    expect(state.accumulator.assistantText).toBe("");
  });

  it("synthesizes ToolUse plus ToolResult when ACP defers lifecycle tool_call with empty rawInput", () => {
    const state = createCursorAcpTurnState();
    const start = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-read",
          title: "Read File",
          kind: "read",
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    expect(start).toEqual([]);
    expect(state.accumulator.toolStartTimes.has("c-read")).toBe(false);

    const done = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-read",
          kind: "read",
          title: "Read File",
          status: "completed",
          rawOutput: { path: "src/module.ts", content: "file body" },
        },
      },
      threadId,
      state,
    );
    expect(done.filter((e) => e.type === AgentEventType.ToolUse)).toHaveLength(1);
    expect(done.filter((e) => e.type === AgentEventType.ToolResult)).toHaveLength(1);
    expect(done[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: "c-read",
      toolName: "Read",
      toolInput: { file_path: "src/module.ts" },
    });
    expect(done[1]).toMatchObject({
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId: "c-read",
      isError: false,
    });
  });

  it("maps tool_call_update to ToolResult", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Shell",
          rawInput: { shellToolCall: { args: { command: "ls" } } },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    const done = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          rawInput: {
            shellToolCall: {
              args: { command: "ls" },
              result: { success: "ok" },
            },
          },
        },
      },
      threadId,
      state,
    );
    expect(done.some((e) => e.type === AgentEventType.ToolResult && e.toolCallId === "c1")).toBe(
      true,
    );
  });

  it("retains in-progress output until a status-only terminal update", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-progress",
          title: "Terminal",
          kind: "execute",
          rawInput: { command: "echo processing" },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );

    const progress = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-progress",
          status: "in_progress",
          rawOutput: { stdout: "partial output" },
        },
      },
      threadId,
      state,
    );
    expect(progress).toEqual([]);
    expect(state.accumulator.pendingToolCalls.has("c-progress")).toBe(true);

    const completed = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-progress",
          status: "completed",
        },
      },
      threadId,
      state,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: AgentEventType.ToolResult,
      toolCallId: "c-progress",
      output: "partial output",
      isError: false,
    });
  });

  it("treats only statusless updates with result data as terminal", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-statusless",
          title: "Terminal",
          kind: "execute",
          rawInput: { command: "echo done" },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );

    const empty = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-statusless",
        },
      },
      threadId,
      state,
    );
    expect(empty).toEqual([]);
    expect(state.accumulator.pendingToolCalls.has("c-statusless")).toBe(true);

    const completed = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-statusless",
          rawOutput: { stdout: "statusless output" },
        },
      },
      threadId,
      state,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: AgentEventType.ToolResult,
      toolCallId: "c-statusless",
      output: "statusless output",
      isError: false,
    });
  });

  it("maps plan session update to TodoWrite events", () => {
    const state = createCursorAcpTurnState();
    const events = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the file", status: "completed", priority: "high" },
            { content: "Edit the function", status: "in-progress", priority: "medium" },
            { content: "Run tests", status: "pending", priority: "low" },
          ],
        },
      } as any,
      threadId,
      state,
    );
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      threadId,
      toolName: "TodoWrite",
    });
    const todos = (events[0] as any).toolInput.todos;
    expect(todos).toHaveLength(3);
    expect(todos[0]).toMatchObject({ content: "Read the file", status: "completed" });
    expect(todos[1]).toMatchObject({ content: "Edit the function", status: "in_progress" });
    expect(todos[2]).toMatchObject({ content: "Run tests", status: "pending" });
    expect(events[1]).toMatchObject({
      type: AgentEventType.ToolResult,
      threadId,
      isError: false,
    });
  });

  it("maps explore-style delegation to Agent ToolUse and forwards parentToolCallId", () => {
    const state = createCursorAcpTurnState();
    const events = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-exp",
          title: "Explore workspace",
          rawInput: {
            exploreWorkspaceToolCall: { args: { goal: "sketch module layout" } },
          },
          status: "in_progress",
          parent_tool_call_id: "parent-root",
          // Narrow ACP payloads may carry parent linkage before `@agentclientprotocol/sdk` exposes it on `tool_call`.
        } as unknown as Parameters<typeof mapCursorAcpSessionNotification>[0]["update"],
      },
      threadId,
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      toolCallId: "c-exp",
      toolName: "Agent",
      threadId,
      parentToolCallId: "parent-root",
    });
    expect((events[0] as { toolInput: Record<string, unknown> }).toolInput.goal).toBe(
      "sketch module layout",
    );
  });

  it("maps deferred Grep with totalMatches into toolInput pattern summary", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-grep",
          title: "grep",
          kind: "search",
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    const done = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-grep",
          kind: "search",
          status: "completed",
          rawOutput: { totalMatches: 4, truncated: false },
        },
      },
      threadId,
      state,
    );
    const use = done.find((e) => e.type === AgentEventType.ToolUse);
    expect(use).toMatchObject({
      toolName: "Grep",
      toolInput: { pattern: "4 matches" },
    });
  });

  it("maps execute kind with command on tool_call to Bash ToolUse", () => {
    const state = createCursorAcpTurnState();
    const started = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c-sh",
          title: "`echo ok`",
          kind: "execute",
          rawInput: { command: "echo ok" },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      toolName: "Bash",
      toolInput: { command: "echo ok" },
    });
  });

  it("returns empty for plan with no entries", () => {
    const state = createCursorAcpTurnState();
    const events = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: { sessionUpdate: "plan", entries: [] },
      } as any,
      threadId,
      state,
    );
    expect(events).toEqual([]);
  });
});

describe("Cursor ACP client-factory session-update seam", () => {
  it("projects matching load replay without contaminating the continuation accumulator", async () => {
    const child = fakeChild();
    const state = createCursorAcpTurnState();
    const events: unknown[] = [];
    const bridge = new CursorAcpClientBridge({
      settings: { get: () => ({ provider: { cursor: { traceSessionUpdates: false } } }) } as any,
      publishEvent: (_entry, event) => { events.push(event); },
      emitPermissionRequest: () => {},
      emitPermissionResolved: () => {},
      emitExitPlanMode: () => {},
    });
    let entry: any;
    let client!: Client;
    let finishLoad!: () => void;
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => {
        await client.sessionUpdate({
          sessionId: "cursor-resume",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "historical" },
          },
        } as SessionNotification);
        await new Promise<void>((resolve) => { finishLoad = resolve; });
      }),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree: vi.fn(async () => undefined) },
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => {
          await bridge.deliverSessionUpdate(entry, update as SessionNotification);
        },
      },
      clientFactory: (callbacks) => {
        client = {
          requestPermission: callbacks.onPermissionRequest,
          // This is the production Cursor seam: the factory forwards the
          // runtime-composed callback instead of bypassing its replay gate.
          sessionUpdate: callbacks.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({ child, connection }),
      sessionLoadTimeoutMs: 1_000,
    });
    entry = {
      acpRuntime: runtime,
      acpSessionId: "cursor-resume",
      activeTurnState: state,
      replayTurnState: null,
      threadId: "cursor-thread",
      todoSnapshot: undefined,
    };

    await runtime.initialize();
    const opening = runtime.openSession({ resumeFrom: "cursor-resume", cwd: ".", mcpServers: [] });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(finishLoad).toEqual(expect.any(Function)));
    await client.sessionUpdate({
      sessionId: "other",
      update: { sessionUpdate: "session_info_update" },
    } as SessionNotification);
    expect(events).toEqual([
      { type: AgentEventType.TextDelta, threadId: "cursor-thread", delta: "historical" },
    ]);
    expect(resolveCursorAssistantMessageContent(state.accumulator)).toBe("");

    finishLoad();
    await expect(opening).resolves.toEqual({ sessionId: "cursor-resume", reloaded: true });
    await client.sessionUpdate({
      sessionId: "cursor-resume",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "live" },
      },
    } as SessionNotification);
    expect(events).toEqual([
      { type: AgentEventType.TextDelta, threadId: "cursor-thread", delta: "historical" },
      { type: AgentEventType.TextDelta, threadId: "cursor-thread", delta: "live" },
    ]);
    expect(resolveCursorAssistantMessageContent(state.accumulator)).toBe("live");
  });

  it("drops updates after the active Cursor turn closes", async () => {
    const state = createCursorAcpTurnState();
    const events: unknown[] = [];
    const bridge = new CursorAcpClientBridge({
      settings: { get: () => ({ provider: { cursor: { traceSessionUpdates: false } } }) } as any,
      publishEvent: (_entry, event) => { events.push(event); },
      emitPermissionRequest: () => {},
      emitPermissionResolved: () => {},
      emitExitPlanMode: () => {},
    });
    const entry = {
      acpSessionId: "cursor-session",
      acpRuntime: { state: { sessionId: "cursor-session" } },
      activeTurnState: state,
      replayTurnState: null,
      threadId: "cursor-thread",
      todoSnapshot: undefined,
    } as any;

    await bridge.deliverSessionUpdate(entry, {
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "accepted" },
      },
    } as SessionNotification);
    entry.activeTurnState = null;
    await bridge.deliverSessionUpdate(entry, {
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale" },
      },
    } as SessionNotification);

    expect(events).toEqual([
      { type: AgentEventType.TextDelta, threadId: "cursor-thread", delta: "accepted" },
    ]);
  });

  it("keeps late callbacks bound to their ACP generation", async () => {
    const generations: Array<{ client: Client; events: unknown[] }> = [];
    const makeRuntime = async (threadId: string) => {
      let client!: Client;
      const events: unknown[] = [];
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
        newSession: vi.fn(async () => ({ sessionId: `session-${threadId}` })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        processes: { attach: vi.fn(), terminateTree: vi.fn(async () => undefined) },
        callbacks: {
          onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
          onSessionUpdate: async (update) => {
            events.push(...mapCursorAcpSessionNotification(update, threadId, createCursorAcpTurnState()));
          },
        },
        clientFactory: (callbacks) => {
          client = {
            requestPermission: callbacks.onPermissionRequest,
            sessionUpdate: callbacks.onSessionUpdate,
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
            extMethod: async () => ({}),
            extNotification: async () => {},
          };
          return client;
        },
        transportFactory: async () => ({ child: fakeChild(), connection }),
      });
      await runtime.initialize();
      await runtime.openSession({ cwd: ".", mcpServers: [] });
      generations.push({ client, events });
    };

    await makeRuntime("cursor-a");
    await makeRuntime("cursor-b");
    await generations[1].client.sessionUpdate({
      sessionId: "session-cursor-b",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } },
    } as SessionNotification);
    await generations[0].client.sessionUpdate({
      sessionId: "session-cursor-a",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late A" } },
    } as SessionNotification);

    expect(generations[0].events).toEqual([{ type: AgentEventType.TextDelta, threadId: "cursor-a", delta: "late A" }]);
    expect(generations[1].events).toEqual([{ type: AgentEventType.TextDelta, threadId: "cursor-b", delta: "B" }]);
  });
});
