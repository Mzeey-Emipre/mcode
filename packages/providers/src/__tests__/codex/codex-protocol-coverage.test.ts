/**
 * Replays captured Codex app-server notifications through {@link CodexEventMapper}
 * and asserts we map (or intentionally silence) every method seen in live traces.
 *
 * Fixture: `fixtures/codex-protocol-golden.ndjson` (optional).
 * Generate with:
 *   node scripts/codex-protocol-capture.mjs <cwd> packages/providers/src/__tests__/codex/fixtures/codex-protocol-golden.ndjson
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { AgentEventType, type AgentEvent, type ProviderRuntimeEvent } from "@mcode/contracts";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";
import type { CodexNotification } from "../../private/codex/codex-types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dir, "fixtures", "codex-protocol-golden.ndjson");
const GOLDEN_REPLAY_TIMEOUT_MS = 60_000;

/** Methods the mapper must handle without logging "unrecognized". */
const KNOWN_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
  "error",
  "warning",
  // Silenced lifecycle plus structured plan snapshots.
  "thread/started",
  "thread/status/changed",
  "mcpServer/startupStatus/updated",
  "account/rateLimits/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
  "turn/plan/updated",
  "skills/changed",
  "model/rerouted",
  "deprecationNotice",
  "configWarning",
  "item/fileChange/outputDelta",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress",
  "remoteControl/status/changed",
]);

/** Synthetic minimal trace for CI when golden file is absent. */
const SYNTHETIC_NOTIFICATIONS: CodexNotification[] = [
  { jsonrpc: "2.0", method: "turn/started", params: {} },
  {
    jsonrpc: "2.0",
    method: "item/started",
    params: { item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent" } },
  },
  {
    jsonrpc: "2.0",
    method: "item/started",
    params: { item: { type: "commandExecution", id: "cmd-1" } },
  },
  {
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
  },
  {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { item: { type: "collabAgentToolCall", id: "collab-1", result: "done" } },
  },
  { jsonrpc: "2.0", method: "item/plan/delta", params: { delta: "Planning…" } },
  { jsonrpc: "2.0", method: "item/reasoning/textDelta", params: { delta: "Think" } },
  { jsonrpc: "2.0", method: "warning", params: { message: "config warning" } },
  { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Final" } },
  {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { turn: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } },
  },
];

type NdjsonRow = {
  type?: string;
  method?: string;
  raw?: CodexNotification;
};

function loadNotifications(): { label: string; notifications: CodexNotification[] } {
  if (existsSync(FIXTURE_PATH)) {
    const lines = readFileSync(FIXTURE_PATH, "utf8").split("\n").filter(Boolean);
    const notifications: CodexNotification[] = [];
    for (const line of lines) {
      const row = JSON.parse(line) as NdjsonRow;
      if (row.type === "notification" && row.raw?.method) {
        notifications.push(row.raw);
      }
    }
    return { label: "golden", notifications };
  }
  return { label: "synthetic", notifications: SYNTHETIC_NOTIFICATIONS };
}

function replay(notifications: CodexNotification[]) {
  const mainThreadId = notifications
    .filter((n) => n.method === "turn/started")
    .map((n) => n.params as { threadId?: unknown })
    .find((params) => typeof params.threadId === "string" && params.threadId.length > 0)
    ?.threadId as string | undefined;
  const mapper = new CodexEventMapper("coverage-thread", mainThreadId);
  const methodsSeen = new Set<string>();
  const runtimeEvents: ProviderRuntimeEvent[] = [];
  for (const n of notifications) {
    methodsSeen.add(n.method);
    runtimeEvents.push(...mapper.mapNotification(n));
  }
  return { methodsSeen, events: runtimeEvents.map((runtimeEvent) => runtimeEvent.event), runtimeEvents };
}

function loadGoldenScenario(id: string): CodexNotification[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  const lines = readFileSync(FIXTURE_PATH, "utf8").split("\n").filter(Boolean);
  const notifications: CodexNotification[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as NdjsonRow & { scenario?: string };
    if (row.type === "notification" && row.scenario === id && row.raw?.method) {
      notifications.push(row.raw);
    }
  }
  return notifications;
}

describe("Codex protocol coverage", () => {
  const { label, notifications } = loadNotifications();

  it(`replays ${label} notifications without unknown methods`, () => {
    const { methodsSeen } = replay(notifications);
    const unknown = [...methodsSeen].filter((m) => !KNOWN_METHODS.has(m));
    expect(unknown, `Add to KNOWN_METHODS or SILENCED_METHODS: ${unknown.join(", ")}`).toEqual([]);
  }, GOLDEN_REPLAY_TIMEOUT_MS);

  it("maps collab Agent rows and nests child-thread commandExecution under collab", () => {
    const { events } = replay(notifications);
    const agentUses = events.filter(
      (e) => e.type === AgentEventType.ToolUse && e.toolName === "Agent",
    );
    const commandUses = events.filter(
      (e): e is Extract<AgentEvent, { type: "toolUse" }> =>
        e.type === AgentEventType.ToolUse && e.toolName === "command_execution",
    );
    const nestedCommands = commandUses.filter((e) => e.parentToolCallId != null);

    if (label === "synthetic") {
      expect(agentUses).toHaveLength(1);
      expect(nestedCommands).toHaveLength(1);
      expect(nestedCommands[0]?.parentToolCallId).toBe("collab-1");
      return;
    }

    // Golden D_subagents: parallel collabs on the parent thread, shell tools on child threads.
    expect(agentUses.length).toBeGreaterThan(0);
    expect(commandUses.length).toBeGreaterThan(0);
    const sawChildThreadCommand = notifications.some((n) => {
      if (n.method !== "item/completed") return false;
      const params = n.params as { threadId?: string; item?: { type?: string } };
      const tid = params.threadId;
      return (
        params.item?.type === "commandExecution"
        && typeof tid === "string"
        && tid.length > 0
      );
    });
    if (sawChildThreadCommand) {
      expect(nestedCommands.length).toBeGreaterThan(0);
    } else if (agentUses.length === 1) {
      expect(nestedCommands.length).toBeGreaterThan(0);
    }
  }, GOLDEN_REPLAY_TIMEOUT_MS);

  it("emits non-final textDelta for plan/reasoning when present", () => {
    const { events } = replay(notifications);
    const thoughtDeltas = events.filter(
      (e) => e.type === AgentEventType.TextDelta && e.isFinalResponse !== true,
    );
    const hasPlanOrReasoning = notifications.some(
      (n) =>
        n.method === "item/plan/delta"
        || n.method === "item/reasoning/textDelta"
        || n.method === "item/reasoning/summaryTextDelta",
    );
    if (hasPlanOrReasoning) {
      expect(thoughtDeltas.length).toBeGreaterThan(0);
    }
  }, GOLDEN_REPLAY_TIMEOUT_MS);

  it("classifies Codex assistant text with assistantMessageBoundary, not final text deltas", () => {
    const { events } = replay(notifications);
    const assistantDeltas = events.filter(
      (e) => e.type === AgentEventType.TextDelta && e.isFinalResponse === true,
    );
    const boundaries = events.filter(
      (e): e is Extract<AgentEvent, { type: "assistantMessageBoundary" }> =>
        e.type === AgentEventType.AssistantMessageBoundary,
    );
    const messages = events.filter((e) => e.type === AgentEventType.Message);
    const hasAssistantText = notifications.some(
      (n) => n.method === "item/agentMessage/delta"
        || (
          n.method === "item/completed"
          && ["agentMessage", "message"].includes(
            ((n.params as { item?: { type?: string } }).item?.type) ?? "",
          )
        ),
    );

    expect(assistantDeltas).toHaveLength(0);
    if (hasAssistantText) {
      expect(boundaries.length).toBeGreaterThan(0);
      expect(messages.length).toBeGreaterThan(0);
      expect(boundaries.some((e) => e.isFinalResponse)).toBe(true);
    }
  }, GOLDEN_REPLAY_TIMEOUT_MS);

  it("golden fixture documents sub-agent scenario when captured", () => {
    if (label !== "golden") return;
    const lines = readFileSync(FIXTURE_PATH, "utf8").split("\n").filter(Boolean);
    const scenarioEnd = lines
      .map((l) => JSON.parse(l) as { type?: string; id?: string; methods?: string[] })
      .find((r) => r.type === "scenario_end" && r.id === "D_subagents");
    if (!scenarioEnd) return;
    const methods = scenarioEnd.methods ?? [];
    const sawCollab =
      methods.includes("item/started")
      && lines.some((l) => {
        try {
          const r = JSON.parse(l) as NdjsonRow;
          return (
            r.type === "notification"
            && (r.raw?.params as { item?: { type?: string } } | undefined)?.item?.type
              === "collabAgentToolCall"
          );
        } catch {
          return false;
        }
      });
    if (!sawCollab) {
      console.warn(
        "D_subagents scenario did not emit collabAgentToolCall; sub-agent nesting remains unit-test only",
      );
    }
  });

  it("golden D_subagents emits one TurnComplete after main turn completion", () => {
    if (label !== "golden") return;
    const subagentNotifications = loadGoldenScenario("D_subagents");
    if (subagentNotifications.length === 0) return;
    const mainThreadId = (subagentNotifications.find((n) => n.method === "turn/started")?.params as { threadId?: string } | undefined)?.threadId;
    const hasMainCompletion = subagentNotifications.some((n) => {
      const params = n.params as { threadId?: string };
      return n.method === "turn/completed" && params.threadId === mainThreadId;
    });
    if (!hasMainCompletion) return;

    const { events } = replay(subagentNotifications);
    const turnCompletes = events.filter((event) => event.type === AgentEventType.TurnComplete);
    expect(turnCompletes).toHaveLength(1);
  });

  it("golden D_subagents suppresses wait rows and completes spawn rows from child state", () => {
    if (label !== "golden") return;
    const subagentNotifications = loadGoldenScenario("D_subagents");
    if (subagentNotifications.length === 0) return;

    const { events, runtimeEvents } = replay(subagentNotifications);
    const spawnUses = runtimeEvents.filter(
      (runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse
        && runtimeEvent.event.toolName === "Agent"
        && runtimeEvent.extension?.collaboration?.kind === "spawnAgent",
    );
    const waitUses = runtimeEvents.filter(
      (runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse
        && runtimeEvent.event.toolName === "Agent"
        && runtimeEvent.extension?.collaboration?.kind === "wait",
    );
    const spawnResults = events.filter(
      (event) =>
        event.type === AgentEventType.ToolResult
        && spawnUses.some((use) => use.event.toolCallId === event.toolCallId),
    );

    expect(spawnUses.length).toBeGreaterThan(0);
    expect(waitUses).toHaveLength(0);
    expect(spawnResults.length).toBeGreaterThan(0);
  }, GOLDEN_REPLAY_TIMEOUT_MS);
});
