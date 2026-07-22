import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { projectLiveSubagents } from "../subagent-projection";

function call(overrides: Partial<ToolCall> & Pick<ToolCall, "id" | "toolName">): ToolCall {
  return {
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

describe("projectLiveSubagents", () => {
  it("projects top-level running Agents with provider identity, task, descendant activity, and elapsed time", () => {
    const roster = projectLiveSubagents([
      call({
        id: "agent-a",
        toolName: "Agent",
        toolInput: { agentName: "Security reviewer", description: "Review auth changes" },
        startedAt: 1_000,
        lastActivityAt: 1_000,
      }),
      call({
        id: "child-a",
        toolName: "Read",
        toolInput: { file_path: "apps/server/src/auth.ts" },
        parentToolCallId: "agent-a",
        startedAt: 2_000,
        lastActivityAt: 8_000,
      }),
    ], 11_000);

    expect(roster).toEqual({
      active: [
        {
          id: "agent-a",
          identity: "Security reviewer",
          task: "Review auth changes",
          activity: "Read file: auth.ts",
          activityAt: 8_000,
          elapsedSeconds: 10,
        },
      ],
      finishedCount: 0,
    });
  });

  it("sorts by latest descendant activity and preserves source order for ties", () => {
    const roster = projectLiveSubagents([
      call({ id: "agent-first", toolName: "Agent", toolInput: { description: "First" }, lastActivityAt: 10 }),
      call({ id: "agent-second", toolName: "Agent", toolInput: { description: "Second" }, lastActivityAt: 10 }),
      call({ id: "child-second", toolName: "Grep", toolInput: { pattern: "Subagent" }, parentToolCallId: "agent-second", lastActivityAt: 20 }),
      call({ id: "nested-agent", toolName: "Agent", toolInput: { description: "Nested" }, parentToolCallId: "agent-first", lastActivityAt: 30 }),
    ], 30_000);

    expect(roster.active.map((row) => row.id)).toEqual(["agent-first", "agent-second"]);
    expect(roster.active[0]?.activity).toBe("Delegated task: Nested");
    expect(roster.active[1]?.activity).toBe('Searched files: "Subagent"');
  });

  it("counts completed top-level Agents without treating child Agents as roster rows", () => {
    const roster = projectLiveSubagents([
      call({ id: "finished", toolName: "Agent", isComplete: true }),
      call({ id: "active", toolName: "Agent", toolInput: { description: "Keep running" } }),
      call({ id: "nested-finished", toolName: "Agent", parentToolCallId: "active", isComplete: true }),
    ]);

    expect(roster.finishedCount).toBe(1);
    expect(roster.active.map((row) => row.id)).toEqual(["active"]);
  });

  it("uses provider names before task descriptions and never uses provider models as identities", () => {
    const roster = projectLiveSubagents([
      call({
        id: "named-agent",
        toolName: "Agent",
        toolInput: {
          agentName: "Repository reviewer",
          description: "Review identity precedence",
          model: "gpt-5.6",
        },
      }),
      call({
        id: "cursor-agent",
        toolName: "Agent",
        toolInput: {
          description: "Cursor delegated task",
          prompt: "Inspect the Cursor task result",
          model: "cursor-large",
          agentId: "cursor-internal-id",
          subagentType: "general",
        },
      }),
      call({
        id: "codex-agent",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          prompt: "Review Codex collaboration events",
          model: "gpt-5.6-codex",
        },
      }),
      call({ id: "unnamed-agent", toolName: "Agent", toolInput: { model: "not-a-name" } }),
    ]);

    expect(roster.active.map((row) => row.identity)).toEqual([
      "Repository reviewer",
      "Cursor delegated task",
      "Review Codex collaboration events",
      "Subagent",
    ]);
  });

  it("bounds provider-supplied identity, task, and activity text", () => {
    const roster = projectLiveSubagents([
      call({
        id: "agent",
        toolName: "Agent",
        toolInput: {
          agentName: "i".repeat(160),
          description: "t".repeat(400),
        },
        lastActivityAt: 1,
      }),
      call({
        id: "activity",
        toolName: "Bash",
        toolInput: { command: "a".repeat(400) },
        parentToolCallId: "agent",
        lastActivityAt: 2,
      }),
    ]);

    const row = roster.active[0];
    expect(row?.identity).toHaveLength(96);
    expect(row?.identity?.endsWith("…")).toBe(true);
    expect(row?.task).toHaveLength(280);
    expect(row?.task?.endsWith("…")).toBe(true);
    expect(row?.activity).toHaveLength(160);
    expect(row?.activity?.endsWith("…")).toBe(true);
  });

  it("bounds malformed descendant traversal", () => {
    const calls: ToolCall[] = [call({ id: "agent", toolName: "Agent", lastActivityAt: 1 })];
    for (let index = 0; index < 140; index += 1) {
      calls.push(call({
        id: `child-${index}`,
        toolName: "Read",
        parentToolCallId: index === 0 ? "agent" : `child-${index - 1}`,
        lastActivityAt: index + 2,
      }));
    }

    expect(projectLiveSubagents(calls).active[0]?.activityAt).toBe(129);
  });
});
